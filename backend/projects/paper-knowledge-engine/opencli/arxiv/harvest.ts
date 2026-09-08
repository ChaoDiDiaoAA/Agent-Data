import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ArxivFailure, RetryEvent, RetryPolicy } from './retry.ts';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { arxivProgressPrefix, parseRetryAfterMs, serializeArxivProgress, withArxivRetry } from './retry.ts';
const defaultArxivApiBase = 'https://export.arxiv.org/api/query';
const knownArxivApiBases = new Set([
  'https://arxiv.org/api/query',
  defaultArxivApiBase,
]);

function resolveArxivApiBase(value: string): string {
  if (!knownArxivApiBases.has(value)) {
    throw new ArgumentError('arxiv api-base must be a known arXiv API base');
  }
  return value;
}
export interface HarvestOptions { from: string; to: string; dateMode: string; query: string; categories: string[]; pageSize?: number; maxResults: number; requestIntervalMs: number; maxAttempts?: number; maxBackoffMs?: number; requestTimeoutMs?: number; retryJitterMs?: number; capacityCooldownMs?: number; start?: number; track?: string; output?: string; apiBase?: string }
export interface Paper { arxivId: string; baseId: string; version: number; title: string; summary: string; authors: string[]; published: string; updated: string; categories: string[]; pdfUrl: string }
interface FetchResponse { ok: boolean; status: number; headers?: { get(name: string): string | null }; body?: ReadableStream<Uint8Array> | null; text?(): Promise<string> }
export interface HarvestDependencies { fetchImpl?: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponse>; sleep?: (ms: number) => Promise<unknown>; random?: () => number; clock?: () => number; onRetry?: (event: RetryEvent) => unknown; onDeferred?: (event: RetryEvent) => unknown; onFailure?: (event: RetryEvent) => unknown; onTruncated?: (event: { type: 'discovery-scan-truncated'; track?: string; dateMode: string; from: string; scannedEntries: number }) => unknown; apiBase?: string }
type RequestPolicy = HarvestDependencies & RetryPolicy & { requestTimeoutMs: number };
const columns = ['arxivId', 'baseId', 'version', 'title', 'summary', 'authors', 'published', 'updated', 'categories', 'pdfUrl'];
const atomStructureParser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, parseTagValue: false, trimValues: false });
const diagnosticHeaderNames = ['retry-after', 'server', 'via', 'x-cache', 'x-served-by'] as const;
const diagnosticEncoder = new TextEncoder();
const rateExceededPhrase = 'rate exceeded';

const decodeEntities = (value: unknown) => String(value)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");

function extract(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeEntities(match[1].trim()) : '';
}

function extractAll(xml: string, tag: string) {
  const values = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g');
  let match;
  while ((match = pattern.exec(xml)) !== null) values.push(decodeEntities(match[1].trim()));
  return values;
}

function directChildren(nodes: unknown, name: string): unknown[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node) => node && typeof node === 'object' && Object.hasOwn(node, name)
    ? [Reflect.get(node, name)]
    : []);
}

function directText(nodes: unknown): string {
  if (!Array.isArray(nodes)) return '';
  return nodes.flatMap((node) => node && typeof node === 'object' && Object.hasOwn(node, '#text')
    ? [String(Reflect.get(node, '#text'))]
    : []).join('');
}

function extractAuthors(entry: string) {
  const authors: string[] = [];
  const document = atomStructureParser.parse(`<feed><entry>${entry}</entry></feed>`);
  for (const entryNode of directChildren(directChildren(document, 'feed')[0], 'entry')) {
    for (const authorNode of directChildren(entryNode, 'author')) {
      for (const nameNode of directChildren(authorNode, 'name')) {
        const name = directText(nameNode).trim();
        if (name && !authors.includes(name)) authors.push(name);
      }
    }
  }
  return authors;
}

function extractAttribute(xml: string, tag: string, attribute: string) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}="([^"]*)"`));
  return match ? decodeEntities(match[1]) : '';
}

function extractAllAttributes(xml: string, tag: string, attribute: string) {
  const values = [];
  const pattern = new RegExp(`<${tag}\\b[^>]*\\b${attribute}="([^"]*)"`, 'g');
  let match;
  while ((match = pattern.exec(xml)) !== null) values.push(decodeEntities(match[1]));
  return values;
}

function findPdfLink(xml: string, fallback: string) {
  const pattern = /<link\b([^>]*)\/?>(?:<\/link>)?/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    if (!/\brel="related"/.test(match[1])) continue;
    const href = match[1].match(/\bhref="([^"]+)"/);
    if (href) return decodeEntities(href[1]);
  }
  return fallback;
}

export function parseArxivAtom(xml: string): Paper[] {
  if (XMLValidator.validate(xml) !== true || !/^\s*(?:<\?xml[^?]*\?>\s*)?<feed(?:\s[^>]*)?(?:\/>|>[\s\S]*<\/feed>)\s*$/.test(xml)) throw new CommandExecutionError('Invalid arXiv Atom response', 'Retry the request');
  const entries: Paper[] = [];
  const pattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const entry = match[1];
    const rawId = extract(entry, 'id');
    const arxivId = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, '').trim();
    if (!arxivId) continue;
    const versionMatch = arxivId.match(/^(.*?)(?:v(\d+))?$/)!;
    const baseId = versionMatch[1];
    const version = Number(versionMatch[2] ?? 1);
    entries.push({
      arxivId,
      baseId,
      version,
      title: extract(entry, 'title').replace(/\s+/g, ' '),
      summary: extract(entry, 'summary').replace(/\s+/g, ' '),
      authors: extractAuthors(entry),
      published: extract(entry, 'published'),
      updated: extract(entry, 'updated'),
      categories: extractAllAttributes(entry, 'category', 'term'),
      pdfUrl: findPdfLink(entry, `https://arxiv.org/pdf/${arxivId}`),
    });
  }
  return entries.sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || b.arxivId.localeCompare(a.arxivId));
}

export function buildArxivQuery({ from, to, dateMode = 'submitted', query, categories }: Pick<HarvestOptions, 'from' | 'to' | 'dateMode' | 'query' | 'categories'>) {
  const category = categories.map((value) => `cat:${value}`).join(' OR ');
  const common = `(${query}) AND (${category})`;
  if (dateMode === 'updated') return common;
  if (dateMode !== 'submitted') throw new ArgumentError(`arxiv date-mode must be submitted or updated`);
  const date = `submittedDate:[${from.replaceAll('-', '')}0000 TO ${to.replaceAll('-', '')}2359]`;
  return `${common} AND ${date}`;
}

async function fetchXml(url: string, policy: RequestPolicy) {
  const { fetchImpl = fetch, requestTimeoutMs } = policy;
  const controller = new AbortController();
  const timeoutError: ArxivFailure = new Error(`arXiv request timed out after ${requestTimeoutMs}ms`);
  timeoutError.code = 'ETIMEDOUT';
  const timeout = setTimeout(() => controller.abort(timeoutError), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'agent-data-fsd-code2doc-opencli/1.0', Accept: 'application/atom+xml' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const bodyDiagnostic = await readResponseBodyDiagnostic(response, controller.signal);
      const headers = diagnosticHeaderNames.flatMap((name) => {
        const value = sanitizeDiagnostic(response.headers?.get?.(name) ?? '', 128);
        return value ? [`${name}=${value}`] : [];
      });
      const diagnostic = [bodyDiagnostic.snippet ? `body=${bodyDiagnostic.snippet}` : '', ...headers].filter(Boolean).join('; ');
      const error: ArxivFailure = new CommandExecutionError(`arXiv API HTTP ${response.status}`, 'Check the query or retry later');
      error.httpStatus = response.status;
      error.retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'));
      error.diagnostic = diagnostic || undefined;
      if (response.status === 429 && bodyDiagnostic.rateExceeded) error.rateLimitKind = 'system-capacity';
      throw error;
    }
    if (!response.text) throw new Error('Missing arXiv response body');
    return await waitForResponse(response.text(), controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('arXiv request aborted'), { code: 'ABORT_ERR' });
}

function waitForResponse<T>(operation: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      signal.removeEventListener('abort', handleAbort);
    };
    const handleAbort = () => {
      if (settled) return;
      finish();
      try { onAbort?.(); } catch {}
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    operation.then(
      (value) => { if (!settled) { finish(); resolve(value); } },
      (error) => { if (!settled) { finish(); reject(error); } },
    );
    if (signal.aborted) handleAbort();
  });
}

function sanitizeDiagnostic(value: string, maxBytes: number) {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  let retainedBytes = 0;
  let retainedCharacters = 0;
  for (const character of sanitized) {
    const characterBytes = diagnosticEncoder.encode(character).byteLength;
    if (retainedBytes + characterBytes > maxBytes) break;
    retainedBytes += characterBytes;
    retainedCharacters += character.length;
  }
  return sanitized.slice(0, retainedCharacters);
}

async function readResponseBodyDiagnostic(response: FetchResponse, signal: AbortSignal, maxBytes = 256) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const retained = new Uint8Array(maxBytes);
    let retainedLength = 0;
    let rateExceeded = false;
    let scanTail = '';
    const scanDecoder = new TextDecoder();
    const scan = (text: string) => {
      const candidate = `${scanTail}${text}`.toLowerCase();
      if (candidate.includes(rateExceededPhrase)) rateExceeded = true;
      scanTail = candidate.slice(-(rateExceededPhrase.length - 1));
    };
    for (;;) {
      const { done, value } = await waitForResponse(reader.read(), signal, () => {
        void reader.cancel(abortReason(signal)).catch(() => undefined);
      });
      if (done) break;
      if (!value) continue;
      if (retainedLength < maxBytes) {
        const chunk = value.subarray(0, maxBytes - retainedLength);
        retained.set(chunk, retainedLength);
        retainedLength += chunk.byteLength;
      }
      scan(scanDecoder.decode(value, { stream: true }));
    }
    scan(scanDecoder.decode());
    return {
      snippet: sanitizeDiagnostic(new TextDecoder().decode(retained.subarray(0, retainedLength)), maxBytes),
      rateExceeded,
    };
  }
  if (!response.text) return { snippet: '', rateExceeded: false };
  const fullText = await waitForResponse(response.text(), signal);
  const encoded = diagnosticEncoder.encode(fullText);
  return {
    snippet: sanitizeDiagnostic(new TextDecoder().decode(encoded.subarray(0, maxBytes)), maxBytes),
    rateExceeded: fullText.toLowerCase().includes(rateExceededPhrase),
  };
}

async function fetchWithRetry(url: string, policy: RequestPolicy) {
  return withArxivRetry(() => fetchXml(url, policy), policy);
}

function inWindow(value: string, from: string, to: string) {
  const instant = new Date(value).getTime();
  return instant >= new Date(`${from}T00:00:00Z`).getTime() && instant <= new Date(`${to}T23:59:59Z`).getTime();
}

export async function harvestArxiv(options: HarvestOptions, dependencies: HarvestDependencies = {}) {
  const pageSize = Number(options.pageSize ?? 100);
  const maxResults = Number(options.maxResults);
  const requestIntervalMs = Number(options.requestIntervalMs);
  const maxAttempts = Number(options.maxAttempts ?? 4);
  const maxBackoffMs = Number(options.maxBackoffMs ?? requestIntervalMs * 8);
  const requestTimeoutMs = Number(options.requestTimeoutMs ?? 60000);
  const retryJitterMs = Number(options.retryJitterMs ?? 0);
  const capacityCooldownMs = Number(options.capacityCooldownMs ?? 900_000);
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 3000) throw new ArgumentError('arxiv request-interval-ms must be an integer of at least 3000');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ArgumentError('arxiv page-size must be an integer from 1 to 100');
  if (!Number.isInteger(maxResults) || maxResults < 1) throw new ArgumentError('arxiv max-results must be positive');
  if (!Number.isInteger(capacityCooldownMs) || capacityCooldownMs < 1) throw new ArgumentError('arxiv capacity-cooldown-ms must be positive');
  if (!['submitted', 'updated'].includes(options.dateMode)) throw new ArgumentError('arxiv date-mode must be submitted or updated');
  if (!options.query || !options.categories?.length) throw new ArgumentError('arxiv query and categories are required');
  const papers: Paper[] = [];
  let scannedEntries = 0;
  let start = Number(options.start ?? 0);
  const fromInstant = new Date(`${options.from}T00:00:00Z`).getTime();
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const runtimePolicy: RequestPolicy = {
    ...dependencies,
    requestIntervalMs,
    maxAttempts,
    maxBackoffMs,
    requestTimeoutMs,
    retryJitterMs,
    capacityCooldownMs,
    onRetry: (event) => dependencies.onRetry?.({
      type: 'discovery-retry',
      ...event,
      httpStatus: event.error?.httpStatus,
      retryAfterMs: event.error?.retryAfterMs,
    }),
    onDeferred: (event) => dependencies.onDeferred?.({
      type: 'discovery-deferred',
      ...event,
      httpStatus: event.error?.httpStatus ?? event.httpStatus,
      retryAfterMs: event.error?.retryAfterMs ?? event.retryAfterMs,
      diagnostic: event.error?.diagnostic ?? event.diagnostic,
      rateLimitKind: event.error?.rateLimitKind ?? event.rateLimitKind,
      retryNotBefore: event.error?.retryNotBefore ?? event.retryNotBefore,
    }),
    onFailure: (event) => dependencies.onFailure?.({
      type: 'discovery-transport-failed',
      ...event,
      transportCode: event.error?.transportCode ?? event.transportCode,
    }),
  };
  while (scannedEntries < maxResults) {
    const remainingScanBudget = maxResults - scannedEntries;
    const requestedPageSize = Math.min(pageSize, remainingScanBudget);
    const params = new URLSearchParams({
      search_query: buildArxivQuery(options),
      start: String(start),
      max_results: String(requestedPageSize),
      sortBy: options.dateMode === 'updated' ? 'lastUpdatedDate' : 'submittedDate',
      sortOrder: 'descending',
    });
    const apiBase = dependencies.apiBase === undefined
      ? process.env.FSD_ARXIV_API_BASE ?? defaultArxivApiBase
      : resolveArxivApiBase(dependencies.apiBase);
    const xml = await fetchWithRetry(`${apiBase}?${params}`, runtimePolicy);
    const page = parseArxivAtom(xml).slice(0, remainingScanBudget);
    scannedEntries += page.length;
    const accepted = options.dateMode === 'updated' ? page.filter((paper) => inWindow(paper.updated, options.from, options.to)) : page;
    papers.push(...accepted.slice(0, maxResults - papers.length));
    start += page.length;
    const reachedLowerBoundary = options.dateMode === 'updated'
      && page.some((paper) => new Date(paper.updated).getTime() < fromInstant);
    const receivedShortPage = page.length < requestedPageSize;
    if (reachedLowerBoundary || receivedShortPage) break;
    if (options.dateMode === 'updated' && scannedEntries >= maxResults) {
      dependencies.onTruncated?.({ type: 'discovery-scan-truncated', track: options.track, dateMode: options.dateMode, from: options.from, scannedEntries });
      break;
    }
    if (scannedEntries >= maxResults || papers.length >= maxResults) break;
    await sleep(requestIntervalMs);
  }
  const unique = [...new Map(papers.map((paper) => [paper.arxivId, paper])).values()];
  return unique;
}

async function writeOutput(path: string | undefined, payload: unknown) {
  if (!path || path === '-') return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${path.split(/[\\/]/).pop()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

cli({
  site: 'arxiv',
  name: 'harvest',
  access: 'read',
  description: 'Harvest arXiv metadata using submitted-date or last-updated-date public API channels',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'from', type: 'string', required: true, help: 'UTC start date, YYYY-MM-DD' },
    { name: 'to', type: 'string', required: true, help: 'UTC end date, YYYY-MM-DD' },
    { name: 'date-mode', type: 'string', choices: ['submitted', 'updated'], default: 'submitted', help: 'Use submittedDate filter or lastUpdatedDate sort with local filtering' },
    { name: 'track', type: 'string', required: true, help: 'Research track label' },
    { name: 'query', type: 'string', required: true, help: 'Boolean arXiv search query' },
    { name: 'categories', type: 'string', required: true, help: 'Comma-separated arXiv categories' },
    { name: 'api-base', type: 'string', help: 'Validated arXiv API base; defaults to export.arxiv.org' },
    { name: 'page-size', type: 'int', default: 100, help: 'Number of results per arXiv API page' },
    { name: 'max-results', type: 'int', required: true, help: 'Maximum entries scanned and candidates returned by this shard' },
    { name: 'request-interval-ms', type: 'int', required: true, help: 'Minimum delay between arXiv API requests, at least 3000' },
    { name: 'max-attempts', type: 'int', required: true, help: 'Maximum arXiv request attempts' },
    { name: 'max-backoff-ms', type: 'int', required: true, help: 'Maximum exponential retry delay in milliseconds' },
    { name: 'request-timeout-ms', type: 'int', required: true, help: 'Per-request timeout in milliseconds' },
    { name: 'retry-jitter-ms', type: 'int', required: true, help: 'Maximum random retry jitter in milliseconds' },
    { name: 'capacity-cooldown-ms', type: 'int', required: true, help: 'Cooldown after an arXiv system-capacity limit response' },
    { name: 'start', type: 'int', default: 0, help: '0-based result offset' },
    { name: 'output', type: 'string', default: '-', help: 'Optional JSON envelope path; - keeps output on stdout' },
  ],
  columns,
  func: async (args) => {
    const options: HarvestOptions = {
      from: String(args.from), to: String(args.to), dateMode: String(args['date-mode'] ?? 'submitted'),
      track: String(args.track), query: String(args.query),
      categories: String(args.categories).split(',').map((value) => value.trim()).filter(Boolean),
      pageSize: Number(args['page-size']), maxResults: Number(args['max-results']), requestIntervalMs: Number(args['request-interval-ms']),
      maxAttempts: Number(args['max-attempts']), maxBackoffMs: Number(args['max-backoff-ms']), requestTimeoutMs: Number(args['request-timeout-ms']), retryJitterMs: Number(args['retry-jitter-ms']), capacityCooldownMs: Number(args['capacity-cooldown-ms']),
      start: Number(args.start), output: String(args.output ?? '-'),
      ...(args['api-base'] === undefined ? {} : { apiBase: String(args['api-base']) }),
    };
    const papers = await harvestArxiv(options, {
      onRetry: (event) => process.stderr.write(serializeArxivProgress(event)),
      onDeferred: (event) => process.stderr.write(serializeArxivProgress(event)),
      onFailure: (event) => process.stderr.write(serializeArxivProgress(event)),
      onTruncated: (event) => process.stderr.write(`${arxivProgressPrefix}${JSON.stringify(event)}\n`),
    });
    await writeOutput(options.output, { schemaVersion: 1, dateMode: options.dateMode, track: options.track, query: options.query, start: options.start ?? 0, pageSize: options.pageSize, papers });
    return papers;
  },
});
