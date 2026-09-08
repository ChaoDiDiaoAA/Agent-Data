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

function selectedAttempt(source: SampleRecord): string | undefined {
  if (source.parser_key === undefined && source.parse_attempt_id === undefined && source.content_sha256 === undefined && source.derived_ref === undefined) return undefined;
  if (typeof source.parser_key !== 'string' || !source.parser_key.startsWith('mineru@') || !/^attempt-[0-9a-f]{64}$/.test(source.parse_attempt_id ?? '') || !/^[0-9a-f]{64}$/.test(source.content_sha256 ?? '')) fail('SNAPSHOT_ATTEMPT_MISMATCH');
  const normalized = `parsed/${source.parse_attempt_id}/normalized`;
  if (source.derived_ref?.root !== 'data' || source.derived_ref.path !== `datasets/${source.dataset_id}/samples/${source.sample_id}/${normalized}`) fail('SNAPSHOT_ATTEMPT_MISMATCH');
  return normalized;
}

function labelMetadata(source: SampleRecord) {
  if (source.label_kind === 'none') {
    if (source.label_ref || source.label_sha256 || source.mapping_version) fail('SNAPSHOT_RECORD_INVALID');
    return {};
  }
  if (!source.label_ref || source.label_ref.root !== 'data' || source.label_ref.path !== `datasets/${source.dataset_id}/samples/${source.sample_id}/label.json` || !/^[0-9a-f]{64}$/.test(source.label_sha256 ?? '') || !['dataset_annotation', 'human_reviewed'].includes(source.label_kind) || typeof source.mapping_version !== 'string') fail('SNAPSHOT_RECORD_INVALID');
  return { label_sha256: source.label_sha256!, label_kind: source.label_kind as 'dataset_annotation' | 'human_reviewed', mapping_version: source.mapping_version };
}

async function verifyDirectory(path: string): Promise<StructuredSnapshot> {
  const manifestBytes = await readFile(join(path, 'snapshot.json'));
  let manifest: StructuredSnapshot;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) as StructuredSnapshot; } catch { return fail('SNAPSHOT_INVALID'); }
  if (manifestBytes.toString('utf8') !== canonicalJson(manifest) || manifest.schema_version !== 1 || !Array.isArray(manifest.files) || !/^[0-9a-f]{64}$/.test(manifest.record_sha256)) fail('SNAPSHOT_INVALID');
  const names = (await realTree(path)).filter(name => !name.endsWith('/')).sort();
  if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length || names.join(',') !== [...manifest.files.map(file => file.path), 'snapshot.json'].sort().join(',')) fail('SNAPSHOT_FILE_SET_MISMATCH');
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('SNAPSHOT_INVALID');
    const body = await readFile(resolveOwnedPath(path, file.path));
    if (hash(body) !== file.sha256 || body.byteLength !== file.bytes) fail('SNAPSHOT_FILE_HASH_MISMATCH');
  }
  const recordFile = manifest.files.find(file => file.path === 'record.json')!;
  const labelFile = manifest.files.find(file => file.path === 'label.json');
  if (!recordFile || recordFile.sha256 !== manifest.record_sha256 || labelFile?.sha256 !== manifest.label_sha256) fail('SNAPSHOT_SOURCE_HASH_MISMATCH');
  const source = record(JSON.parse(await readFile(join(path, 'record.json'), 'utf8')));
  const labels = labelMetadata(source);
  if (labels.label_sha256 !== manifest.label_sha256 || labels.label_kind !== manifest.label_kind || labels.mapping_version !== manifest.mapping_version) fail('SNAPSHOT_SOURCE_HASH_MISMATCH');
  if (labelFile) JSON.parse(await readFile(join(path, 'label.json'), 'utf8'));
  const normalized = selectedAttempt(source);
  if (source.parser_key !== manifest.parser_key || source.parse_attempt_id !== manifest.parse_attempt_id || source.content_sha256 !== manifest.content_sha256) fail('SNAPSHOT_ATTEMPT_MISMATCH');
  const allowed = new Set(['record.json', ...(labelFile ? ['label.json'] : [])]);
  if (normalized) {
    verifyAttemptIdentity(source, manifest.parse_started_at);
    const verified = await verifyNormalizedOutput(resolveOwnedPath(path, normalized));
    if (verified.contentHash !== manifest.content_sha256) fail('SNAPSHOT_CONTENT_HASH_MISMATCH');
    for (const file of verified.files) allowed.add(`${normalized}/${file.path}`);
  } else if (manifest.parse_started_at !== undefined) fail('SNAPSHOT_ATTEMPT_MISMATCH');
  if (manifest.files.some(file => !allowed.has(file.path)) || allowed.size !== manifest.files.length) fail('SNAPSHOT_FILE_SET_MISMATCH');
  return manifest;
}

export async function verifyStructuredSnapshot(path: string): Promise<StructuredSnapshot> { return verifyDirectory(path); }

/** Restores a verified prior snapshot before discarding a corrupt current directory. */
export async function recoverStructuredSnapshot(destination: string): Promise<void> {
  const previous = `${destination}.previous`;
  const hasDestination = await exists(destination);
  const hasPrevious = await exists(previous);
  if (!hasPrevious) return;
  let previousValid = false;
  try { await verifyDirectory(previous); previousValid = true; } catch { /* An invalid candidate remains until a verified replacement is published. */ }
  if (!previousValid) return;
  if (!hasDestination) { await rename(previous, destination); return; }
  try {
    await verifyDirectory(destination);
    await rm(previous, { recursive: true, force: true });
  } catch {
    await rm(destination, { recursive: true, force: true });
    await rename(previous, destination);
  }
}

interface SnapshotInput { paths: FlowmatePaths; datasetId: string; sampleId: string; parsed?: ParseReceipt; lockHeld?: boolean }
export interface KnowledgeSnapshotInput {
  paths: FlowmatePaths;
  sourceId: string;
  sourceVersion: string;
  fileId: string;
  recordPath: string;
  normalizedDir: string;
  sourceUrl: string;
  licenseEvidence: string;
  applicablePeriod: string;
  lockHeld?: boolean;
}

async function sourceFiles(input: SnapshotInput) {
  const { paths, datasetId, sampleId } = input;
  const recordPath = resolveOwnedPath(paths.dataRoot, `datasets/${datasetId}/samples/${sampleId}/record.json`);
  const recordBytes = await readFile(recordPath);
  const source = record(JSON.parse(recordBytes.toString('utf8')));
  if (source.dataset_id !== datasetId || source.sample_id !== sampleId) fail('SNAPSHOT_RECORD_INVALID');
  const labels = labelMetadata(source);
  const payload = new Map<string, Uint8Array>([['record.json', recordBytes]]);
  if (labels.label_sha256) {
    const labelPath = resolveOwnedPath(paths.dataRoot, source.label_ref!.path);
    const labelBytes = await readFile(labelPath);
    if (hash(labelBytes) !== labels.label_sha256 || await sha256File(labelPath) !== labels.label_sha256) fail('SNAPSHOT_LABEL_HASH_MISMATCH');
    try { JSON.parse(labelBytes.toString('utf8')); } catch { fail('SNAPSHOT_LABEL_INVALID'); }
    payload.set('label.json', labelBytes);
  }
  const normalized = selectedAttempt(source);
  let startedAt: string | undefined;
  if (input.parsed && (!normalized || input.parsed.sampleId !== sampleId || input.parsed.attemptId !== source.parse_attempt_id || input.parsed.parserKey !== source.parser_key || input.parsed.contentHash !== source.content_sha256 || input.parsed.originalSha256 !== source.original_sha256)) fail('SNAPSHOT_ATTEMPT_MISMATCH');
  if (normalized) {
    const directory = resolveOwnedPath(paths.dataRoot, source.derived_ref!.path);
    if (input.parsed && input.parsed.normalizedDir !== directory) fail('SNAPSHOT_ATTEMPT_MISMATCH');
    const verified = await verifyNormalizedOutput(directory);
    if (verified.contentHash !== source.content_sha256) fail('SNAPSHOT_CONTENT_HASH_MISMATCH');
    const receipt: ParseReceipt = JSON.parse(await readFile(join(directory, '..', 'receipt.json'), 'utf8'));
    if (receipt.sampleId !== sampleId || receipt.attemptId !== source.parse_attempt_id || receipt.parserKey !== source.parser_key || receipt.originalSha256 !== source.original_sha256 || receipt.contentHash !== source.content_sha256 || receipt.normalizedDir !== directory) fail('SNAPSHOT_ATTEMPT_MISMATCH');
    verifyAttemptIdentity(source, receipt.startedAt);
    if (input.parsed) verifyAttemptIdentity(source, input.parsed.startedAt);
    startedAt = receipt.startedAt;
    if (canonicalJson(receipt.files) !== canonicalJson(verified.files)) fail('SNAPSHOT_FILE_HASH_MISMATCH');
    if (input.parsed && canonicalJson(input.parsed.files) !== canonicalJson(verified.files)) fail('SNAPSHOT_FILE_HASH_MISMATCH');
    for (const file of verified.files) {
      const body = await readFile(resolveOwnedPath(directory, file.path));
      if (hash(body) !== file.sha256) fail('SNAPSHOT_FILE_HASH_MISMATCH');
      payload.set(`${normalized}/${file.path}`, body);
    }
  }
  return { source, recordBytes, labels, payload, startedAt };
}

async function publishSampleStructuredSnapshot(input: SnapshotInput): Promise<{ snapshot_path: string; snapshot: StructuredSnapshot }> {
  const { paths, datasetId, sampleId } = input;
  safeId(datasetId); safeId(sampleId);
  const source = await sourceFiles(input);
  const relative = `datasets/${datasetId}/samples/${sampleId}/structured`;
  const destination = resolveOwnedPath(paths.originalRoot, relative);
  const previous = resolveOwnedPath(paths.originalRoot, `${relative}.previous`);
  const staging = resolveOwnedPath(paths.dataRoot, `work/snapshots/${sampleId}`);
  await recoverStructuredSnapshot(destination);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const files: SnapshotFile[] = [];
  for (const [path, body] of [...source.payload.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const destination = resolveOwnedPath(staging, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, body, { flag: 'wx' });
    files.push({ path, sha256: hash(body), bytes: body.byteLength });
  }
  const snapshot: StructuredSnapshot = { schema_version: 1, record_sha256: hash(source.recordBytes), ...source.labels,
    ...(source.source.parse_attempt_id ? { parser_key: source.source.parser_key!, parse_attempt_id: source.source.parse_attempt_id, parse_started_at: source.startedAt!, content_sha256: source.source.content_sha256! } : {}), files };
  await writeFile(join(staging, 'snapshot.json'), canonicalJson(snapshot), { flag: 'wx' });
  await verifyDirectory(staging);
  await mkdir(dirname(destination), { recursive: true });
  if (await exists(destination)) {
    // A verified prior was restored by recovery above.  Remove only an invalid stale
    // candidate before retaining the current verified directory as the new fallback.
    await rm(previous, { recursive: true, force: true });
    await rename(destination, previous);
  }
  try {
    await rename(staging, destination);
    await verifyDirectory(destination);
  } catch (error) {
    if (await exists(previous)) {
      try {
        await verifyDirectory(previous);
        if (await exists(destination)) await rm(destination, { recursive: true, force: true });
        await rename(previous, destination);
      } catch { /* Leave the verified fallback in place for the next recovery attempt. */ }
    }
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
  return { snapshot_path: destination, snapshot };
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
