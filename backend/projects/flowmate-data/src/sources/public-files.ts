import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { resolveOwnedPath } from '../config.ts';
import type { DocumentKind, FlowmatePaths, SourceConfig } from '../contracts.ts';
import { canonicalJson, createFlowmateMinerURuntime, parseInvoice, verifyNormalizedOutput, withRunLock, type ParseDependencies } from '../engine-bridge.ts';
import { installImmutableFile, writeCanonicalJson } from '../file-store.ts';
import { publishStructuredSnapshot } from '../structured-snapshot.ts';
import { createSourceHttp, metadataScope, type SourceTransport } from './dataset-records.ts';

type ParseStatus = 'selected' | 'parsed' | 'raw_only';
type OriginalRef = { root: 'original'; path: string };
type DerivedRef = { root: 'data'; path: string };

export interface KnowledgeRecord {
  schema_version: 1;
  source_id: string;
  file_id: string;
  source_url: string;
  version: string;
  retrieved_at: string;
  content_sha256: string;
  document_kind: Extract<DocumentKind, 'invoice_template' | 'knowledge'>;
  label_kind: 'none';
  parse_status: ParseStatus;
  applicable_period: string;
  license_evidence: string;
  original_ref: OriginalRef;
  original_sha256: string;
  parser_key?: string;
  parse_attempt_id?: string;
  content_hash?: string;
  derived_ref?: DerivedRef;
}

function fail(code: string): never { throw new Error(code); }
function digest(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function safeId(value: string): void { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail('PUBLIC_FILES_INVALID_ID'); }
function versionFor(retrievedAt: string, sha256: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(retrievedAt);
  if (!match) fail('PUBLIC_FILES_INVALID_RETRIEVED_AT');
  return `${match[1]}${match[2]}${match[3]}T${match[4]}${match[5]}${match[6]}${match[7]}Z--${sha256}`;
}
function fileMime(url: string): 'text/html' | 'application/pdf' | 'application/msword' | 'application/ofd' {
  const extension = extname(new URL(url).pathname).toLowerCase();
  if (extension === '.html' || extension === '.htm') return 'text/html';
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.doc') return 'application/msword';
  if (extension === '.ofd') return 'application/ofd';
  return fail('PUBLIC_FILES_UNSUPPORTED_EXTENSION');
}
function responseMime(headers: Headers): string { return headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''; }
function isRawOnly(mime: ReturnType<typeof fileMime>): boolean { return mime === 'application/msword' || mime === 'application/ofd'; }
function elementByClass(html: string, className: string): string | undefined {
  const opening = new RegExp(`<div\\b[^>]*\\bclass=(['"])${`[^'"]*\\b${className}\\b[^'"]*`}\\1[^>]*>`, 'i').exec(html);
  if (!opening || opening.index === undefined) return undefined;
  const start = opening.index + opening[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  return undefined;
}
function text(html: string): string {
  return html.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function plainText(html: string): { title: string; body: string } {
  const details = elementByClass(html, 'contentLeft');
  const article = elementByClass(html, 'article');
  const heading = details && /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(details)?.[1];
  const title = heading && text(heading);
  const body = article && text(article);
  if (!title || !body) fail('PUBLIC_FILES_HTML_STRUCTURE_INVALID');
  return { title, body };
}
function base(sourceId: string): string { return `datasets/public-invoice-knowledge/${sourceId}`; }
function recordPath(paths: FlowmatePaths, sourceId: string, fileId: string, version: string): string { return resolveOwnedPath(paths.dataRoot, `${base(sourceId)}/records/${fileId}/${version}.json`); }
function parseRoot(paths: FlowmatePaths, sourceId: string, fileId: string, version: string): string { return resolveOwnedPath(paths.dataRoot, `${base(sourceId)}/parsed/${fileId}/${version}`); }

async function writeRaw(path: string, bytes: Uint8Array, mime: ReturnType<typeof fileMime>): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.part`;
  await mkdir(dirname(temporary), { recursive: true });
  await writeFile(temporary, bytes, { flag: 'wx' });
  try { await installImmutableFile(temporary, path, { sha256: digest(bytes), mime_type: mime }); }
  finally { await unlink(temporary).catch(error => { if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') throw error; }); }
}

async function writeHtmlNormalized(paths: FlowmatePaths, sourceId: string, fileId: string, version: string, bytes: Uint8Array): Promise<{ directory: string; contentHash: string }> {
  const directory = resolveOwnedPath(paths.dataRoot, `${base(sourceId)}/normalized/${fileId}/${version}`);
  const { title, body } = plainText(Buffer.from(bytes).toString('utf8'));
  const full = `# ${title}\n\n${body}\n`;
  const content = [{ type: 'text', text: body }];
  const pages = [{ page: 1, text: body }];
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'full.md'), full, { flag: 'wx' });
  await writeFile(join(directory, 'content-list.json'), canonicalJson(content), { flag: 'wx' });
  await writeFile(join(directory, 'pages.json'), canonicalJson(pages), { flag: 'wx' });
  await writeFile(join(directory, 'page-marked.txt'), body, { flag: 'wx' });
  return { directory, contentHash: (await verifyNormalizedOutput(directory)).contentHash };
}

async function listRecords(paths: FlowmatePaths, sourceId: string): Promise<Array<{ path: string; record: KnowledgeRecord }>> {
  const root = resolveOwnedPath(paths.dataRoot, `${base(sourceId)}/records`);
  let files: string[];
  try { files = await readdir(root, { recursive: true }); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  const records: Array<{ path: string; record: KnowledgeRecord }> = [];
  for (const name of files.filter(name => name.endsWith('.json'))) {
    const path = resolveOwnedPath(root, name.replaceAll('\\', '/'));
    records.push({ path, record: JSON.parse(await readFile(path, 'utf8')) as KnowledgeRecord });
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

export async function acquirePublicFiles(input: { paths: FlowmatePaths; config: SourceConfig; transport?: SourceTransport; now?: () => Date }): Promise<{ records: KnowledgeRecord[] }> {
  return withRunLock(resolveOwnedPath(input.paths.dataRoot, 'work/run.lock'), () => acquirePublicFilesUnlocked(input), { jobId: `flowmate-knowledge-acquire-${input.config.source_id}` });
}

async function acquirePublicFilesUnlocked(input: { paths: FlowmatePaths; config: SourceConfig; transport?: SourceTransport; now?: () => Date }): Promise<{ records: KnowledgeRecord[] }> {
  const { paths, config } = input;
  if (config.reader !== 'public-files' || !config.files?.length || config.dataset_id || config.retention !== 'allowed' || config.local_use !== 'allowed') fail('PUBLIC_FILES_CONFIG_INVALID');
  safeId(config.source_id);
  const transport = input.transport ?? createSourceHttp(config);
  const retrievedAt = (input.now ?? (() => new Date()))().toISOString();
  const records: KnowledgeRecord[] = [];
  for (const file of config.files) {
    safeId(file.id);
    const mime = fileMime(file.url);
    const result = await transport.http.get(file.url, metadataScope(config, 64 * 1024 * 1024));
    if (responseMime(result.headers) !== mime) fail('PUBLIC_FILES_MIME_MISMATCH');
    const contentSha = digest(result.bytes);
    const version = versionFor(retrievedAt, contentSha);
    const extension = extname(new URL(file.url).pathname).toLowerCase();
    const originalPath = `knowledge/${config.source_id}/originals/${version}/${file.id}${extension}`;
    await writeRaw(resolveOwnedPath(paths.originalRoot, originalPath), result.bytes, mime);
    const baseRecord: KnowledgeRecord = { schema_version: 1, source_id: config.source_id, file_id: file.id, source_url: file.url, version, retrieved_at: retrievedAt,
      content_sha256: contentSha, document_kind: file.document_kind === 'invoice_template' ? 'invoice_template' : 'knowledge', label_kind: 'none',
      parse_status: isRawOnly(mime) ? 'raw_only' : 'selected', applicable_period: config.applicable_period ?? 'unspecified', license_evidence: config.license_evidence,
      original_ref: { root: 'original', path: originalPath }, original_sha256: contentSha };
    const machineRecord = recordPath(paths, config.source_id, file.id, version);
    if (mime === 'text/html' && file.parse) {
      const normalized = await writeHtmlNormalized(paths, config.source_id, file.id, version, result.bytes);
      const parsed: KnowledgeRecord = { ...baseRecord, parse_status: 'parsed', content_hash: normalized.contentHash, derived_ref: { root: 'data', path: relative(paths.dataRoot, normalized.directory).replaceAll('\\', '/') } };
      await writeCanonicalJson(machineRecord, parsed);
      await publishStructuredSnapshot({ paths, sourceId: config.source_id, sourceVersion: version, fileId: file.id, recordPath: machineRecord, normalizedDir: normalized.directory,
        sourceUrl: file.url, licenseEvidence: config.license_evidence, applicablePeriod: config.applicable_period ?? 'unspecified', lockHeld: true });
      records.push(parsed);
    } else {
      await writeCanonicalJson(machineRecord, baseRecord);
      records.push(baseRecord);
    }
  }
  return { records };
}

export async function parsePublicKnowledge(input: { paths: FlowmatePaths; config: SourceConfig }, dependencies: ParseDependencies = {}): Promise<{ parsed: number; records: KnowledgeRecord[] }> {
  return withRunLock(resolveOwnedPath(input.paths.dataRoot, 'work/run.lock'), () => parsePublicKnowledgeUnlocked(input, { ...dependencies, lockHeld: true }), { jobId: `flowmate-knowledge-parse-${input.config.source_id}` });
}

async function parsePublicKnowledgeUnlocked(input: { paths: FlowmatePaths; config: SourceConfig }, dependencies: ParseDependencies = {}): Promise<{ parsed: number; records: KnowledgeRecord[] }> {
  const { paths, config } = input;
  if (config.reader !== 'public-files') fail('PUBLIC_FILES_CONFIG_INVALID');
  const records = await listRecords(paths, config.source_id);
  const parsed: KnowledgeRecord[] = [];
  for (const stored of records) {
    const record = stored.record;
    const configured = config.files?.find(file => file.id === record.file_id && file.url === record.source_url && file.document_kind === record.document_kind && file.parse);
    if (!configured || record.parse_status !== 'selected' || extname(record.original_ref.path).toLowerCase() !== '.pdf') continue;
    const sourcePath = resolveOwnedPath(paths.originalRoot, record.original_ref.path);
    if (digest(await readFile(sourcePath)) !== record.original_sha256) fail('PUBLIC_FILES_ORIGINAL_HASH_MISMATCH');
    const runtime = createFlowmateMinerURuntime(paths);
    const receipt = await parseInvoice({ ...runtime, sampleId: `knowledge-${record.file_id}`, sourcePath, outputDir: parseRoot(paths, record.source_id, record.file_id, record.version) }, { ...dependencies, lockHeld: true });
    const next: KnowledgeRecord = { ...record, parse_status: 'parsed', parser_key: receipt.parserKey, parse_attempt_id: receipt.attemptId, content_hash: receipt.contentHash,
      derived_ref: { root: 'data', path: relative(paths.dataRoot, receipt.normalizedDir).replaceAll('\\', '/') } };
    await writeCanonicalJson(stored.path, next);
    await publishStructuredSnapshot({ paths, sourceId: record.source_id, sourceVersion: record.version, fileId: record.file_id, recordPath: stored.path, normalizedDir: receipt.normalizedDir,
      sourceUrl: configured.url, licenseEvidence: config.license_evidence, applicablePeriod: config.applicable_period ?? 'unspecified', lockHeld: true });
    parsed.push(next);
  }
  return { parsed: parsed.length, records: parsed };
}
