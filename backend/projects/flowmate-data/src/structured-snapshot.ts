import { compactJsonHash, prettyJson } from './readable-json.ts';
import { recoverPublications, publicationPaths, commitPublication } from './publication.ts';
import { sampleDirectory, datasetTasks } from './layout.ts';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveOwnedPath } from './config.ts';
import { canonicalJson, deriveParseAttemptId, realTree, verifyNormalizedOutput, withRunLock, type ParseReceipt } from './engine-bridge.ts';
import { sha256File } from './file-store.ts';
import type { FlowmatePaths } from './contracts.ts';
import type { SampleRecord } from './task-store.ts';

interface SnapshotFile { path: string; sha256: string; bytes: number }
export interface StructuredSnapshot {
  schema_version: 1;
  json_format?: 'pretty-2';
  record_sha256: string;
  label_sha256?: string;
  label_kind?: 'dataset_annotation' | 'human_reviewed';
  mapping_version?: string;
  parser_key?: string;
  parse_attempt_id?: string;
  parse_started_at?: string;
  content_sha256?: string;
  files: SnapshotFile[];
}

function fail(code: string): never { throw new Error(code); }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function safeId(value: string): void { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail('SNAPSHOT_INVALID_ID'); }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; } }
function record(value: unknown): SampleRecord { if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('SNAPSHOT_RECORD_INVALID'); return value as SampleRecord; }

function verifyAttemptIdentity(source: SampleRecord, startedAt: string | undefined): void {
  try {
    if (deriveParseAttemptId({ parserKey: source.parser_key!, originalSha256: source.original_sha256, startedAt: startedAt! }) !== source.parse_attempt_id) fail('SNAPSHOT_ATTEMPT_MISMATCH');
  } catch { fail('SNAPSHOT_ATTEMPT_MISMATCH'); }
}

interface SnapshotInput { paths: FlowmatePaths; datasetId: string; sampleId: string; parsed?: ParseReceipt; record?: SampleRecord; lockHeld?: boolean }
export interface KnowledgeSnapshotInput {
  paths: FlowmatePaths; sourceId: string; sourceVersion: string; fileId: string; recordPath: string;
  normalizedDir: string; sourceUrl: string; licenseEvidence: string; applicablePeriod: string; lockHeld?: boolean;
}
function labelMetadata(source: SampleRecord) {
  if (source.label_kind === 'none') {
    if (source.label_ref || source.label_sha256 || source.mapping_version) fail('SNAPSHOT_RECORD_INVALID');
    return {};
  }
  if (source.label_ref?.root !== 'data' || source.label_ref.path !== `${sampleDirectory(source.dataset_id, source.sample_id)}/fields.json` || !/^[0-9a-f]{64}$/.test(source.label_sha256 ?? '') || !['dataset_annotation', 'human_reviewed'].includes(source.label_kind) || typeof source.mapping_version !== 'string') fail('SNAPSHOT_RECORD_INVALID');
  return { label_sha256: source.label_sha256!, label_kind: source.label_kind as 'dataset_annotation' | 'human_reviewed', mapping_version: source.mapping_version };
}
async function verifyDirectory(path: string): Promise<StructuredSnapshot> {
  const bytes = await readFile(join(path, 'snapshot.json'));
  const manifest = JSON.parse(bytes.toString('utf8')) as StructuredSnapshot;
  if (![canonicalJson(manifest), prettyJson(manifest)].includes(bytes.toString('utf8')) || manifest.schema_version !== 1 || (manifest.json_format !== undefined && manifest.json_format !== 'pretty-2') || !Array.isArray(manifest.files)) fail('SNAPSHOT_INVALID');
  const names = (await realTree(path)).filter(name => !name.endsWith('/')).sort();
  if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length || names.join(',') !== [...manifest.files.map(file => file.path), 'snapshot.json'].sort().join(',')) fail('SNAPSHOT_FILE_SET_MISMATCH');
  for (const file of manifest.files) {
    const body = await readFile(resolveOwnedPath(path, file.path));
    if (hash(body) !== file.sha256 || body.byteLength !== file.bytes) fail('SNAPSHOT_FILE_HASH_MISMATCH');
  }
  const source = record(JSON.parse(await readFile(join(path, 'record.json'), 'utf8')));
  const labels = labelMetadata(source);
  const sourceHash = async (name: string) => manifest.json_format === 'pretty-2' ? compactJsonHash(await readFile(join(path, name)), name === 'record.json' ? manifest.record_sha256 : manifest.label_sha256) : manifest.files.find(f => f.path === name)?.sha256;
  if (await sourceHash('record.json') !== manifest.record_sha256 || (labels.label_sha256 && await sourceHash('fields.json') !== manifest.label_sha256) || (!labels.label_sha256 && manifest.files.some(f => f.path === 'fields.json')) || canonicalJson(labels) !== canonicalJson({ ...(manifest.label_sha256 ? { label_sha256: manifest.label_sha256, label_kind: manifest.label_kind, mapping_version: manifest.mapping_version } : {}) })) fail('SNAPSHOT_SOURCE_HASH_MISMATCH');
  if (source.parser_key !== manifest.parser_key || source.parse_attempt_id !== manifest.parse_attempt_id || source.content_sha256 !== manifest.content_sha256) fail('SNAPSHOT_ATTEMPT_MISMATCH');
  if (source.derived_ref) {
    if (source.derived_ref.root !== 'data' || source.derived_ref.path !== sampleDirectory(source.dataset_id, source.sample_id)) fail('SNAPSHOT_ATTEMPT_MISMATCH');
    verifyAttemptIdentity(source, manifest.parse_started_at);
    const verified = await verifyNormalizedOutput(path);
    if (verified.contentHash !== manifest.content_sha256) fail('SNAPSHOT_CONTENT_HASH_MISMATCH');
  } else if (manifest.parse_started_at || manifest.parse_attempt_id) fail('SNAPSHOT_ATTEMPT_MISMATCH');
  const allowed = new Set(['record.json', 'receipt.json', ...(labels.label_sha256 ? ['fields.json'] : [])]);
  if (source.derived_ref) {
    for (const name of ['content.md', 'content.json', 'pages.json', 'parse.json']) allowed.add(name);
    const receipt: ParseReceipt = JSON.parse(await readFile(join(path, 'parse.json'), 'utf8'));
    if (receipt.sampleId !== source.sample_id || receipt.parserKey !== source.parser_key || receipt.attemptId !== source.parse_attempt_id || receipt.originalSha256 !== source.original_sha256 || receipt.contentHash !== source.content_sha256 || receipt.startedAt !== manifest.parse_started_at) fail('SNAPSHOT_ATTEMPT_MISMATCH');
    verifyAttemptIdentity(source, receipt.startedAt);
    const verified = await verifyNormalizedOutput(path);
    if (canonicalJson(receipt.files) !== canonicalJson(verified.files)) fail('SNAPSHOT_FILE_HASH_MISMATCH');
    for (const file of verified.files) if (file.path.startsWith('assets/')) allowed.add(file.path);
  } else if (source.parser_key !== undefined || source.content_sha256 !== undefined || source.parse_attempt_id !== undefined) fail('SNAPSHOT_ATTEMPT_MISMATCH');
  for (const ref of [source.original_ref, source.annotation_ref]) if (ref) {
    const file = ref.path.split('/').at(-1)!;
    if (ref.root !== 'original' || ref.path !== `${sampleDirectory(source.dataset_id, source.sample_id)}/${file}` || (ref === source.original_ref ? !/^original\.(jpg|jpeg|png|pdf)$/.test(file) : file !== 'annotation.json')) fail('SNAPSHOT_RECORD_INVALID');
    allowed.add(file);
  }
  if (manifest.files.some(file => !allowed.has(file.path))) fail('SNAPSHOT_FILE_SET_MISMATCH');
  for (const [ref, sha] of [[source.original_ref, source.original_sha256], [source.annotation_ref, source.annotation_sha256]] as const) {
    if (ref) {
      const file = manifest.files.find(file => file.path === ref.path.split('/').at(-1));
      if (file && (ref === source.annotation_ref ? compactJsonHash(await readFile(join(path, file.path)), sha) : file.sha256) !== sha) fail('SNAPSHOT_SOURCE_HASH_MISMATCH');
    }
  }
  return manifest;
}
export async function verifyStructuredSnapshot(path: string): Promise<StructuredSnapshot> { return verifyDirectory(path); }
export async function recoverStructuredSnapshot(destination: string): Promise<void> {
  const previous = `${destination}.previous`;
  if (!await exists(previous)) return;
  try { await verifyDirectory(previous); } catch { return; }
  if (!await exists(destination)) { await rename(previous, destination); return; }
  try { await verifyDirectory(destination); await rm(previous, { recursive: true, force: true }); }
  catch { await rm(destination, { recursive: true, force: true }); await rename(previous, destination); }
}
async function publishSampleStructuredSnapshot(input: SnapshotInput): Promise<{ snapshot_path: string; snapshot: StructuredSnapshot }> {
  const { paths, datasetId, sampleId } = input;
  safeId(datasetId); safeId(sampleId);
  await recoverPublications(paths);
  const relative = sampleDirectory(datasetId, sampleId);
  const dataDir = resolveOwnedPath(paths.dataRoot, relative);
  await recoverStructuredSnapshot(resolveOwnedPath(paths.originalRoot, relative));
  const source = input.record ?? record(JSON.parse(await readFile(join(dataDir, 'record.json'), 'utf8')));
  if (source.dataset_id !== datasetId || source.sample_id !== sampleId) fail('SNAPSHOT_RECORD_INVALID');
  const labels = labelMetadata(source);
  const payload = new Map<string, Uint8Array>();
  const recordBytes = Buffer.from(canonicalJson(source));
  payload.set('record.json', recordBytes);
  for (const name of ['receipt.json', 'fields.json']) {
    if (name === 'fields.json' && !labels.label_sha256) continue;
    const file = join(dataDir, name);
    if (!await exists(file)) { if (name === 'fields.json') fail('SNAPSHOT_LABEL_HASH_MISMATCH'); continue; }
    const body = await readFile(file);
    if (name === 'fields.json' && hash(body) !== labels.label_sha256) fail('SNAPSHOT_LABEL_HASH_MISMATCH');
    payload.set(name, body);
  }
  let startedAt: string | undefined;
  if (source.derived_ref) {
    if (source.derived_ref.root !== 'data' || source.derived_ref.path !== relative) fail('SNAPSHOT_ATTEMPT_MISMATCH');
    const receipt: ParseReceipt = input.parsed ?? JSON.parse(await readFile(join(dataDir, 'parse.json'), 'utf8'));
    if (receipt.sampleId !== sampleId || receipt.attemptId !== source.parse_attempt_id || receipt.parserKey !== source.parser_key || receipt.originalSha256 !== source.original_sha256 || receipt.contentHash !== source.content_sha256) fail('SNAPSHOT_ATTEMPT_MISMATCH');
    verifyAttemptIdentity(source, receipt.startedAt);
    startedAt = receipt.startedAt;
    const expectedWork = resolveOwnedPath(paths.dataRoot, `work/p/${sampleId}/${receipt.attemptId.slice(8,24)}`);
    if (receipt.normalizedDir !== dataDir && (receipt.outputDir !== expectedWork || receipt.normalizedDir !== join(expectedWork, 'normalized'))) fail('SNAPSHOT_ATTEMPT_MISMATCH');
    const stored: ParseReceipt = JSON.parse(await readFile(receipt.normalizedDir === dataDir ? join(dataDir, 'parse.json') : join(receipt.outputDir, 'receipt.json'), 'utf8'));
    if (canonicalJson(stored) !== canonicalJson(receipt)) fail('SNAPSHOT_ATTEMPT_MISMATCH');
    const directory = receipt.normalizedDir;
    const verified = await verifyNormalizedOutput(directory);
    if (verified.contentHash !== source.content_sha256) fail('SNAPSHOT_CONTENT_HASH_MISMATCH');
    const convert = (name: string) => name === 'full.md' ? 'content.md' : name === 'content-list.json' ? 'content.json' : name;
    const expected = receipt.files.filter(file => file.path !== 'page-marked.txt').map(file => ({ ...file, path: convert(file.path) }));
    const actual = verified.files.filter(file => file.path !== 'page-marked.txt').map(file => ({ ...file, path: convert(file.path) }));
    if (canonicalJson([...expected].sort((a,b)=>a.path.localeCompare(b.path))) !== canonicalJson([...actual].sort((a,b)=>a.path.localeCompare(b.path)))) fail('SNAPSHOT_FILE_HASH_MISMATCH');
    for (const file of verified.files.filter(file => file.path !== 'page-marked.txt')) payload.set(convert(file.path), await readFile(resolveOwnedPath(directory, file.path)));
    payload.set('parse.json', Buffer.from(canonicalJson({ ...receipt, outputDir: dataDir, normalizedDir: dataDir, files: actual.sort((a,b)=>a.path.localeCompare(b.path)) })));
  } else if (input.parsed || source.parse_attempt_id) fail('SNAPSHOT_ATTEMPT_MISMATCH');
  const transaction = await publicationPaths(paths, datasetId, sampleId);
  await rm(transaction.dataWork, { recursive: true, force: true });
  await rm(transaction.originalWork, { recursive: true, force: true });
  const mirrorPayload = new Map(payload);
  for (const [ref, sha] of [[source.original_ref, source.original_sha256], [source.annotation_ref, source.annotation_sha256]] as const) {
    if (!ref) continue;
    if (ref.root !== 'original') fail('SNAPSHOT_RECORD_INVALID');
    const body = await readFile(resolveOwnedPath(paths.originalRoot, ref.path));
    if ((ref === source.annotation_ref ? compactJsonHash(body, sha) : hash(body)) !== sha) fail('SNAPSHOT_SOURCE_HASH_MISMATCH');
    mirrorPayload.set(ref.path.split('/').at(-1)!, body);
  }
  for (const [name, body] of mirrorPayload) {
    if (name.endsWith('.json')) mirrorPayload.set(name, Buffer.from(prettyJson(JSON.parse(Buffer.from(body).toString('utf8')))));
  }
  if (mirrorPayload.has('parse.json')) {
    const parsed = JSON.parse(Buffer.from(mirrorPayload.get('parse.json')!).toString('utf8'));
    parsed.files = parsed.files.map((file: SnapshotFile) => {
      const body = mirrorPayload.get(file.path)!;
      return { ...file, sha256: hash(body), bytes: body.byteLength };
    });
    mirrorPayload.set('parse.json', Buffer.from(prettyJson(parsed)));
  }
  const manifestBase = { schema_version: 1 as const, record_sha256: hash(recordBytes), ...labels,
    ...(source.parse_attempt_id ? { parser_key: source.parser_key!, parse_attempt_id: source.parse_attempt_id, parse_started_at: startedAt!, content_sha256: source.content_sha256! } : {}) };
  async function stage(name: string, content: Map<string, Uint8Array>) {
    const directory = name === 'd' ? transaction.swaps[0]!.stage : transaction.swaps[1]!.stage; await mkdir(directory, { recursive: true });
    const files: SnapshotFile[] = [];
    for (const [path, body] of [...content].sort(([a],[b])=>a.localeCompare(b))) {
      const target = resolveOwnedPath(directory, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, body, { flag: 'wx' });
      files.push({ path, sha256: hash(body), bytes: body.byteLength });
    }
    const manifest: StructuredSnapshot = { ...manifestBase, ...(name === 'o' ? { json_format: 'pretty-2' as const } : {}), files };
    await writeFile(join(directory, 'snapshot.json'), name === 'o' ? prettyJson(manifest) : canonicalJson(manifest)); await verifyDirectory(directory);
    return { directory, manifest };
  }
  const machine = await stage('d', payload); const mirror = await stage('o', mirrorPayload);
  const destination = resolveOwnedPath(paths.originalRoot, relative);
  await commitPublication(paths, datasetId, sampleId, verifyDirectory);
  return { snapshot_path: destination, snapshot: mirror.manifest };
}

function knowledgeId(value: string): void { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail('KNOWLEDGE_SNAPSHOT_INVALID_ID'); }

async function verifyKnowledgeDirectory(path: string): Promise<void> {
  const bytes = await readFile(join(path, 'snapshot.json'));
  let manifest: StructuredSnapshot;
  try { manifest = JSON.parse(bytes.toString('utf8')) as StructuredSnapshot; } catch { fail('KNOWLEDGE_SNAPSHOT_INVALID'); }
  if (bytes.toString('utf8') !== canonicalJson(manifest) || manifest.schema_version !== 1 || !Array.isArray(manifest.files)) fail('KNOWLEDGE_SNAPSHOT_INVALID');
  const names = (await realTree(path)).filter(name => !name.endsWith('/')).sort();
  if (names.join(',') !== [...manifest.files.map(file => file.path), 'snapshot.json'].sort().join(',')) fail('KNOWLEDGE_SNAPSHOT_FILE_SET_MISMATCH');
  for (const file of manifest.files) {
    const body = await readFile(resolveOwnedPath(path, file.path));
    if (hash(body) !== file.sha256 || body.byteLength !== file.bytes) fail('KNOWLEDGE_SNAPSHOT_FILE_HASH_MISMATCH');
  }
}

function knowledgeRecord(input: KnowledgeSnapshotInput, bytes: Uint8Array): Record<string, unknown> {
  let record: Record<string, unknown>;
  try { record = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>; } catch { return fail('KNOWLEDGE_SNAPSHOT_RECORD_INVALID'); }
  if (Buffer.from(bytes).toString('utf8') !== canonicalJson(record) || record.parse_status === 'raw_only') fail('KNOWLEDGE_SNAPSHOT_RAW_ONLY');
  if (record.schema_version !== 1 || record.source_id !== input.sourceId || record.file_id !== input.fileId || record.version !== input.sourceVersion
    || record.source_url !== input.sourceUrl || record.license_evidence !== input.licenseEvidence || record.applicable_period !== input.applicablePeriod
    || record.label_kind !== 'none' || record.parse_status !== 'parsed' || !['knowledge', 'invoice_template'].includes(record.document_kind as string)
    || typeof record.content_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.content_sha256)
    || record.original_sha256 !== record.content_sha256 || typeof record.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.content_hash)) fail('KNOWLEDGE_SNAPSHOT_RECORD_INVALID');
  const original = record.original_ref;
  const derived = record.derived_ref;
  if (!original || typeof original !== 'object' || (original as { root?: unknown }).root !== 'original' || typeof (original as { path?: unknown }).path !== 'string'
    || !(original as { path: string }).path.startsWith(`knowledge/${input.sourceId}/originals/${input.sourceVersion}/${input.fileId}.`)
    || !derived || typeof derived !== 'object' || (derived as { root?: unknown }).root !== 'data' || typeof (derived as { path?: unknown }).path !== 'string') fail('KNOWLEDGE_SNAPSHOT_RECORD_INVALID');
  return record;
}

async function recoverKnowledgeStructuredSnapshot(destination: string): Promise<void> {
  const previous = `${destination}.previous`;
  const hasDestination = await exists(destination);
  const hasPrevious = await exists(previous);
  if (!hasPrevious) return;
  try { await verifyKnowledgeDirectory(previous); } catch { return; }
  if (!hasDestination) { await rename(previous, destination); return; }
  try { await verifyKnowledgeDirectory(destination); await rm(previous, { recursive: true, force: true }); }
  catch { await rm(destination, { recursive: true, force: true }); await rename(previous, destination); }
}

async function publishKnowledgeStructuredSnapshot(input: KnowledgeSnapshotInput): Promise<{ snapshot_path: string; snapshot: StructuredSnapshot }> {
  const { paths, sourceId, sourceVersion, fileId } = input;
  knowledgeId(sourceId); knowledgeId(fileId);
  if (!/^[0-9]{8}T[0-9]{9}Z--[0-9a-f]{64}$/.test(sourceVersion)) fail('KNOWLEDGE_SNAPSHOT_INVALID_VERSION');
  const recordBytes = await readFile(input.recordPath);
  const record = knowledgeRecord(input, recordBytes);
  const expectedRecord = resolveOwnedPath(paths.dataRoot, `datasets/public-invoice-knowledge/${sourceId}/records/${fileId}/${sourceVersion}.json`);
  if (input.recordPath !== expectedRecord) fail('KNOWLEDGE_SNAPSHOT_RECORD_INVALID');
  const originalPath = resolveOwnedPath(paths.originalRoot, (record.original_ref as { path: string }).path);
  if (await sha256File(originalPath) !== record.original_sha256) fail('KNOWLEDGE_SNAPSHOT_ORIGINAL_HASH_MISMATCH');
  const normalizedPath = resolveOwnedPath(paths.dataRoot, (record.derived_ref as { path: string }).path);
  if (input.normalizedDir !== normalizedPath) fail('KNOWLEDGE_SNAPSHOT_RECORD_INVALID');
  const verified = await verifyNormalizedOutput(normalizedPath);
  if (verified.contentHash !== record.content_hash) fail('KNOWLEDGE_SNAPSHOT_CONTENT_HASH_MISMATCH');
  const recordSha = hash(recordBytes);
  const relative = `knowledge/${sourceId}/structured/${sourceVersion}/${fileId}`;
  const destination = resolveOwnedPath(paths.originalRoot, relative);
  const previous = resolveOwnedPath(paths.originalRoot, `${relative}.previous`);
  const staging = resolveOwnedPath(paths.dataRoot, `work/knowledge-snapshots/${sourceId}/${sourceVersion}/${fileId}`);
  await recoverKnowledgeStructuredSnapshot(destination);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const payload = new Map<string, Uint8Array>([['record.json', recordBytes]]);
  for (const file of verified.files) {
    payload.set(file.path, await readFile(resolveOwnedPath(normalizedPath, file.path)));
  }
  const files: SnapshotFile[] = [];
  for (const [name, body] of [...payload.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const target = resolveOwnedPath(staging, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, { flag: 'wx' });
    files.push({ path: name, sha256: hash(body), bytes: body.byteLength });
  }
  const snapshot: StructuredSnapshot = { schema_version: 1, record_sha256: recordSha, files };
  await writeFile(join(staging, 'snapshot.json'), canonicalJson(snapshot), { flag: 'wx' });
  await verifyKnowledgeDirectory(staging);
  await mkdir(dirname(destination), { recursive: true });
  if (await exists(destination)) { await rm(previous, { recursive: true, force: true }); await rename(destination, previous); }
  try {
    await rename(staging, destination);
    await verifyKnowledgeDirectory(destination);
  } catch (error) {
    if (await exists(previous)) {
      try { await verifyKnowledgeDirectory(previous); if (await exists(destination)) await rm(destination, { recursive: true, force: true }); await rename(previous, destination); }
      catch { /* Keep a valid previous candidate for the next recovery. */ }
    }
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
  return { snapshot_path: destination, snapshot };
}

export function publishStructuredSnapshot(input: SnapshotInput): Promise<{ snapshot_path: string; snapshot: StructuredSnapshot }>;
export function publishStructuredSnapshot(input: KnowledgeSnapshotInput): Promise<{ snapshot_path: string; snapshot: StructuredSnapshot }>;
export function publishStructuredSnapshot(input: SnapshotInput | KnowledgeSnapshotInput): Promise<{ snapshot_path: string; snapshot: StructuredSnapshot }> {
  const operation = () => 'sourceId' in input ? publishKnowledgeStructuredSnapshot(input) : publishSampleStructuredSnapshot(input);
  return input.lockHeld
    ? operation()
    : withRunLock(resolveOwnedPath(input.paths.dataRoot, 'work/run.lock'), operation, { jobId: 'flowmate-snapshot' });
}
