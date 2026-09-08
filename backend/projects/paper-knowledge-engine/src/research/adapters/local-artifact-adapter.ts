import { lstat, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { candidateFromContent, discoveryScope, fetchScope, requireLocalPurpose, type DiscoveryInput, type FetchInput, type SourceDiscoveryAdapter } from './types.ts';
import type { FetchedSource, ResearchCandidate } from '../../types/research-sources.ts';
import { ResearchAdapterError } from '../http-client.ts';
import { sha256 } from '../source-identity.ts';
import { canonicalJson } from '../../shared/manifest.ts';
import { archivePath, assertRealPath } from '../../shared/archive-v2.ts';

const textExtensions = new Set(['.md', '.markdown', '.html', '.htm', '.txt', '.text', '.json',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.kt', '.sh', '.bash', '.ps1', '.sql', '.css', '.scss', '.yaml', '.yml', '.toml']);
const benchmarkName = /(?:^|[._ -])(?:leaderboard|benchmark[-_ ]?dataset|single[-_ ]?result)(?:$|[._ -])/i;
const benchmarkKinds = new Set(['benchmark-dataset', 'leaderboard', 'single-result']);
const fail = (code: string): never => { throw new ResearchAdapterError(code); };
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) fail('RESEARCH_ABORTED'); };

/** Validate before resolve() can erase traversal; reject network/device paths and Windows aliases. */
function localPath(value: string): string {
  try {
    if (typeof value !== 'string' || !isAbsolute(value) || /^[\\/]{2}/.test(value)) throw new Error();
    const root = parse(value).root;
    archivePath(value.slice(root.length).split(sep).join('/'));
    return resolve(value);
  } catch { return fail('RESEARCH_LOCAL_PATH_REJECTED'); }
}

function rejectBenchmarkJson(content: string): void {
  let value: unknown;
  try { value = JSON.parse(content.replace(/^\ufeff/, '')); } catch { fail('RESEARCH_LOCAL_TYPE_REJECTED'); }
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    for (const [key, child] of Object.entries(item)) {
      if (['sourceKind', 'kind', 'purpose', 'type'].includes(key) && typeof child === 'string'
        && benchmarkKinds.has(child.toLowerCase())) fail('RESEARCH_BENCHMARK_REJECTED');
      if (child && typeof child === 'object') pending.push(child);
    }
  }
}

function rejectBenchmarkOnlyText(content: string): void {
  const semantic = content
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/[\s`*_#>|()[\]{},;]+/g, ' ')
    .trim()
    .toLowerCase();
  const benchmarkKind = '(?:leaderboard|benchmark\\s+dataset|single(?:\\s+evaluation)?\\s+result)';
  if (new RegExp(`\\b(?:source\\s*kind|kind|purpose|type)\\s*[:=]\\s*["']?${benchmarkKind}\\b`).test(semantic)) {
    fail('RESEARCH_BENCHMARK_REJECTED');
  }
  const methodDocument = /\b(?:evaluation|benchmark)\s+(?:method(?:ology)?|protocol|procedure|design|framework)\b|\b(?:task sampling|metric definition|adjudication|replay procedure)\b/.test(semantic);
  if (methodDocument) return;
  const classifiedAtStart = new RegExp(`^${benchmarkKind}\\b`).test(semantic);
  const classifiedAssignment = new RegExp(`\\b${benchmarkKind}\\b\\s*[:=]`).test(semantic);
  const leaderboardTable = /\brank\b/.test(semantic) && /\bscore\b/.test(semantic)
    && /\b(?:agent|model|system|team)\b/.test(semantic);
  if (classifiedAtStart || classifiedAssignment || leaderboardTable) fail('RESEARCH_BENCHMARK_REJECTED');
}

interface SnapshotEntry { path: string; encoding: 'utf8' | 'base64'; content: string; sha256: string }

/** Read only regular files through a bounded handle. No parser, interpreter or imported code runs. */
async function readBytes(path: string, remaining: number, signal: AbortSignal): Promise<Buffer> {
  checkAbort(signal);
  await assertRealPath(path);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile()) return fail('RESEARCH_LOCAL_PATH_REJECTED');
  if (before.size > BigInt(remaining)) return fail('RESEARCH_RESPONSE_TOO_LARGE');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) fail('RESEARCH_LOCAL_PATH_REJECTED');
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      checkAbort(signal);
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      checkAbort(signal);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > remaining) fail('RESEARCH_RESPONSE_TOO_LARGE');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    await assertRealPath(path);
    const after = await lstat(path, { bigint: true });
    const end = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || end.size !== before.size
      || end.mtimeNs !== before.mtimeNs || end.ctimeNs !== before.ctimeNs) fail('RESEARCH_SOURCE_CHANGED');
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

async function snapshot(path: string, input: DiscoveryInput) {
  const limit = input.policy.maxResponseBytes;
  if (!Number.isSafeInteger(limit) || limit <= 0) fail('RESEARCH_INVALID_LIMIT');
  const entries: SnapshotEntry[] = [];
  let rawBytes = 0; let encodedBytes = 0;
  try {
    checkAbort(input.signal);
    await assertRealPath(path);
    const rootInfo = await lstat(path, { bigint: true });
    const type = rootInfo.isDirectory() ? 'directory' : 'file';
    const visit = async (absolute: string): Promise<void> => {
      checkAbort(input.signal);
      if (benchmarkName.test(basename(absolute))) fail('RESEARCH_BENCHMARK_REJECTED');
      await assertRealPath(absolute);
      const info = await lstat(absolute, { bigint: true });
      if (info.isDirectory()) {
        const children = (await readdir(absolute)).sort();
        for (const name of children) {
          archivePath(name);
          await visit(join(absolute, name));
        }
        const after = await lstat(absolute, { bigint: true });
        if (after.dev !== info.dev || after.ino !== info.ino || after.mtimeNs !== info.mtimeNs
          || after.ctimeNs !== info.ctimeNs) fail('RESEARCH_SOURCE_CHANGED');
        return;
      }
      if (!info.isFile()) fail('RESEARCH_LOCAL_PATH_REJECTED');
      const extension = extname(absolute).toLowerCase();
      if (extension !== '.pdf' && !textExtensions.has(extension)) fail('RESEARCH_LOCAL_TYPE_REJECTED');
      const bytes = await readBytes(absolute, limit - rawBytes, input.signal);
      rawBytes += bytes.length;
      let content: string; let encoding: SnapshotEntry['encoding'];
      if (extension === '.pdf') {
        if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('RESEARCH_LOCAL_TYPE_REJECTED');
        encoding = 'base64'; content = bytes.toString('base64');
      } else {
        encoding = 'utf8';
        // Preserve the BOM and line endings inside JSON strings so Archive normalization is lossless.
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { return fail('RESEARCH_LOCAL_TYPE_REJECTED'); }
        if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(content)) fail('RESEARCH_LOCAL_TYPE_REJECTED');
        if (extension === '.json') rejectBenchmarkJson(content);
        rejectBenchmarkOnlyText(content);
      }
      const entry: SnapshotEntry = { path: type === 'file' ? '' : archivePath(relative(path, absolute).split(sep).join('/')),
        encoding, content, sha256: sha256(bytes) };
      encodedBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (encodedBytes > limit) fail('RESEARCH_RESPONSE_TOO_LARGE');
      entries.push(entry);
    };
    await visit(path);
    await assertRealPath(path);
    checkAbort(input.signal);
    if (!entries.length) fail('RESEARCH_LOCAL_TYPE_REJECTED');
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const content = canonicalJson({ schemaVersion: 1, type, files: entries });
    if (Buffer.byteLength(content) > limit) fail('RESEARCH_RESPONSE_TOO_LARGE');
    return { content, entries };
  } catch (error) {
    checkAbort(input.signal);
    if (error instanceof ResearchAdapterError) throw error;
    return fail('RESEARCH_LOCAL_PATH_REJECTED');
  }
}

export class LocalArtifactAdapter implements SourceDiscoveryAdapter {
  readonly id = 'local-artifact';
  readonly kinds = ['local-artifact'] as const;
  private readonly now: () => string;
  constructor(options: { now?: () => string } = {}) { this.now = options.now ?? (() => new Date().toISOString()); }

  async discover(input: DiscoveryInput): Promise<readonly ResearchCandidate[]> {
    discoveryScope(input, 'local-artifact');
    const localPurpose = input.localPurpose;
    if (!input.localPaths?.length) return fail('RESEARCH_LOCAL_PATH_REJECTED');
    const paths = input.localPaths.map(localPath);
    const candidates: ResearchCandidate[] = [];
    for (const path of paths) {
      const { content } = await snapshot(path, input);
      const candidate = candidateFromContent(input, { kind: 'local-artifact', url: '', title: 'Local artifact',
        content, retrievedAt: this.now(), adapter: this.id,
        // The encoded note preserves whitespace through shared provenance normalization and reapproval.
        notes: [`local-path:${path}`, `local-path-uri:${encodeURIComponent(path)}`, `local-purpose:${localPurpose}`] });
      if (candidate.dateMatches.length) candidates.push(candidate);
    }
    checkAbort(input.signal);
    return candidates;
  }

  async fetch(input: FetchInput): Promise<FetchedSource> {
    const scope = fetchScope(input, this);
    discoveryScope(scope, 'local-artifact');
    const candidate = input.candidate;
    requireLocalPurpose(scope, candidate);
    const paths = candidate.version.provenance.notes?.filter(note => note.startsWith('local-path-uri:')) ?? [];
    if (paths.length !== 1) fail('RESEARCH_LOCAL_PATH_REJECTED');
    let path: string;
    try { path = localPath(decodeURIComponent(paths[0].slice('local-path-uri:'.length))); }
    catch { return fail('RESEARCH_LOCAL_PATH_REJECTED'); }
    // An approved hash is not a filesystem grant: require this exact root in the frozen scope.
    if (!scope.localPaths?.map(localPath).includes(path)) fail('RESEARCH_LOCAL_PATH_REJECTED');
    const { content, entries } = await snapshot(path, scope);
    if (sha256(content) !== candidate.version.contentSha256) fail('RESEARCH_SOURCE_CHANGED');
    return { source: candidate.source, version: candidate.version,
      files: [{ path: 'content.txt', contents: Buffer.from(content) }],
      locators: entries.map((entry, index) => ({ artifactPath: 'content.txt', section: entry.path || 'Local artifact', fragment: `/files/${index}` })) };
  }
}
