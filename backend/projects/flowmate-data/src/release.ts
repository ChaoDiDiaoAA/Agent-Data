import { createHash } from 'node:crypto';
import { lstat, link as hardLink, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { resolveOwnedPath, loadSourceConfig } from './config.ts';
import { canonicalJson, hashCanonical, realTree, verifyNormalizedOutput, withRunLock } from './engine-bridge.ts';
import { sha256File } from './file-store.ts';
import { loadSampleRecords, type SampleRecord } from './task-store.ts';
import type { FlowmatePaths, SourceConfig } from './contracts.ts';
import { readVoxel51Index } from './sources/voxel51.ts';
import { loadWithdrawalList, withdrawalListPath } from './backup.ts';

export const releaseSchema = 'flowmate-public/1' as const;

export interface ReleaseFile { path: string; sha256: string; bytes: number }
export interface ReleaseEntry {
  sample_id: string;
  dataset_id: string;
  source_record_id: string;
  record_sha256: string;
  dataset_revision: string;
  layout_group: string | null;
  group: Array<'development' | 'regression'>;
  original?: string;
  annotation?: string;
  record: string;
  label?: string;
  parsed?: string;
}
export interface ReleaseManifest {
  schema: typeof releaseSchema;
  version: string;
  selection_hash: string;
  selection_id?: string;
  source: { source_id: string; dataset_id: string; revision: string; declared_license: string; license_evidence: string; redistribution: SourceConfig['redistribution'] };
  engine_sha: string;
  parser_keys: string[];
  mapping_versions: string[];
  groups: Array<'development' | 'regression'>;
  entries: ReleaseEntry[];
  omitted_originals: Array<{ sample_id: string; reason: string }>;
}
export interface ReleaseBuildInput {
  paths: FlowmatePaths;
  version: string;
  records: readonly SampleRecord[];
  includeOriginals: boolean;
  selectionId?: string;
  selectionHash?: string;
  sourceConfig?: SourceConfig;
}
export interface ReleaseResult { path: string; manifest: ReleaseManifest; files: ReleaseFile[] }
interface PortableRef { root: 'release'; path: string }

function fail(code: string): never { throw new Error(code); }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function derivedSampleId(recordId: string, revision: string): string { return `voxel51-${digest(Buffer.from(`voxel51-hq-invoice-ocr\n${revision}\n${recordId}`)).slice(0, 20)}`; }
function safeId(value: string, code = 'RELEASE_INVALID_ID'): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail(code);
}
function safeRelative(value: string): string {
  if (!value || value.includes('\\') || value.includes(':') || posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail('RELEASE_PATH_INVALID');
  return value;
}
function releasePath(root: string, relative: string): string { return resolveOwnedPath(root, safeRelative(relative)); }
function referencePath(paths: FlowmatePaths, root: 'original' | 'data', relative: string): string {
  return resolveOwnedPath(root === 'original' ? paths.originalRoot : paths.dataRoot, relative);
}
async function optionalFile(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
async function writePayload(root: string, relative: string, bytes: Uint8Array): Promise<ReleaseFile> {
  const destination = releasePath(root, relative);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx' });
  return { path: relative, sha256: digest(bytes), bytes: bytes.byteLength };
}
async function copyPayload(root: string, relative: string, source: string): Promise<ReleaseFile> {
  const bytes = await readFile(source);
  return writePayload(root, relative, bytes);
}
async function copyTree(root: string, relativeRoot: string, sourceRoot: string): Promise<ReleaseFile[]> {
  const files: ReleaseFile[] = [];
  for (const name of (await realTree(sourceRoot)).filter(value => !value.endsWith('/')).sort()) {
    const relative = `${relativeRoot}/${name}`;
    files.push(await copyPayload(root, relative, resolveOwnedPath(sourceRoot, name)));
  }
  return files;
}
async function datasetMetadata(paths: FlowmatePaths, source: ReleaseManifest['source']): Promise<Buffer | undefined> {
  const revisionPath = resolveOwnedPath(paths.dataRoot, `datasets/${source.dataset_id}/revisions/${source.revision}/dataset.json`);
  return (await optionalFile(revisionPath)) ?? optionalFile(resolveOwnedPath(paths.dataRoot, `datasets/${source.dataset_id}/dataset.json`));
}
async function promoteNoReplace(staging: string, destination: string): Promise<void> {
  try { await mkdir(destination); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') fail('RELEASE_VERSION_CONFLICT');
    throw error;
  }
  async function moveDirectory(source: string, target: string): Promise<void> {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name);
      const to = join(target, entry.name);
      if (entry.isSymbolicLink()) fail('RELEASE_SYMLINK_REJECTED');
      if (entry.isDirectory()) {
        try { await mkdir(to); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') fail('RELEASE_VERSION_CONFLICT'); throw error; }
        await moveDirectory(from, to);
        await rm(from, { recursive: true, force: true });
      } else if (entry.isFile()) {
        try { await hardLink(from, to); } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') fail('RELEASE_VERSION_CONFLICT'); throw error; }
        await unlink(from);
      } else fail('RELEASE_FILE_INVALID');
    }
  }
  await moveDirectory(staging, destination);
}
function sameRecordContent(left: SampleRecord, right: SampleRecord): boolean {
  return canonicalJson({ ...left, created_at: '', updated_at: '' }) === canonicalJson({ ...right, created_at: '', updated_at: '' });
}
function manifestHash(records: readonly SampleRecord[]): string {
  return hashCanonical(records.map(record => ({ sample_id: record.sample_id, source_record_id: record.source_record_id, original_sha256: record.original_sha256, dataset_revision: record.dataset_revision })));
}
function sourceFor(input: ReleaseBuildInput): ReleaseManifest['source'] {
  const first = input.records[0];
  const config = input.sourceConfig;
  return {
    source_id: config?.source_id ?? 'unknown', dataset_id: first?.dataset_id ?? 'unknown', revision: first?.dataset_revision ?? 'unknown',
    declared_license: config?.declared_license ?? 'unknown', license_evidence: (config?.license_evidence ?? 'unknown').replace('{revision}', first?.dataset_revision ?? 'unknown'), redistribution: config?.redistribution ?? 'unknown',
  };
}
function assertPortable(value: unknown): void {
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      if (current.includes('\\') || current.startsWith('/') || /^file:/i.test(current) || /^[A-Za-z]:[\\/]/.test(current)) fail('RELEASE_ABSOLUTE_PATH');
      return;
    }
    if (Array.isArray(current)) { for (const item of current) visit(item); return; }
    if (current && typeof current === 'object') { for (const item of Object.values(current)) visit(item); }
  };
  visit(value);
}

async function selectionRecords(paths: FlowmatePaths, selectionId: string, config: SourceConfig): Promise<{ records: SampleRecord[]; selectionHash: string; revision: string }> {
  safeId(selectionId, 'RELEASE_INVALID_SELECTION');
  const selectionPath = resolveOwnedPath(paths.dataRoot, `datasets/voxel51-hq-invoice-ocr/selections/${selectionId}.json`);
  const value = JSON.parse(await readFile(selectionPath, 'utf8')) as { schema_version?: number; source_id?: string; dataset_id?: string; selection_id?: string; index_url?: string; index_sha256?: string; selection_hash?: string; revision?: string; records?: Array<{ sample_id?: string; source_record_id?: string; image_path?: string; annotation_locator?: string; annotation_sha256?: string }> };
  const { selection_hash: selectionHash, ...content } = value;
  if (value.schema_version !== 1 || value.source_id !== config.source_id || value.dataset_id !== config.dataset_id || value.selection_id !== selectionId
    || typeof selectionHash !== 'string' || selectionHash !== hashCanonical(content) || typeof value.revision !== 'string' || !Array.isArray(value.records)
    || !config.record_locator || value.index_url !== config.record_locator.file_url_template.replace('{revision}', value.revision).replace('{path}', config.record_locator.index_path)) fail('RELEASE_SELECTION_INVALID');
  const indexPath = resolveOwnedPath(paths.dataRoot, `datasets/${config.dataset_id}/selections/${selectionId}.index.json`);
  const indexBytes = await readFile(indexPath);
  if (typeof value.index_sha256 !== 'string' || digest(indexBytes) !== value.index_sha256) fail('RELEASE_SELECTION_INVALID');
  const indexRecords = readVoxel51Index(indexBytes);
  const byLocator = new Map(indexRecords.map(record => [record.annotation_locator, record]));
  const all = await loadSampleRecords(paths, 'voxel51-hq-invoice-ocr');
  const byId = new Map(all.map(record => [record.sample_id, record]));
  const records = value.records.map(entry => {
    if (typeof entry.sample_id !== 'string' || !byId.has(entry.sample_id)) fail('RELEASE_SELECTION_RECORD_MISSING');
    const source = byLocator.get((entry as { annotation_locator?: string }).annotation_locator ?? '');
    if (!source || source.source_record_id !== (entry as { source_record_id?: string }).source_record_id || source.image_path !== (entry as { image_path?: string }).image_path
      || hashCanonical(source.raw) !== (entry as { annotation_sha256?: string }).annotation_sha256 || entry.sample_id !== derivedSampleId(source.source_record_id, value.revision!)) fail('RELEASE_SELECTION_RECORD_MISMATCH');
    const record = byId.get(entry.sample_id)!;
    if (record.dataset_id !== config.dataset_id || record.dataset_revision !== value.revision || record.source_record_id !== source.source_record_id) fail('RELEASE_SELECTION_RECORD_MISMATCH');
    return record;
  });
  if (new Set(records.map(record => record.sample_id)).size !== records.length) fail('RELEASE_SELECTION_DUPLICATE');
  return { records, selectionHash, revision: value.revision };
}

export async function buildRelease(input: ReleaseBuildInput): Promise<ReleaseResult> {
  safeId(input.version);
  return withRunLock(resolveOwnedPath(input.paths.dataRoot, 'work/run.lock'), () => buildReleaseUnlocked(input), { jobId: `flowmate-release-${input.version}` });
}

async function buildReleaseUnlocked(input: ReleaseBuildInput): Promise<ReleaseResult> {
  safeId(input.version);
  if (input.records.length === 0) fail('RELEASE_EMPTY_SELECTION');
  const records = [...input.records].sort((left, right) => `${left.dataset_id}/${left.sample_id}`.localeCompare(`${right.dataset_id}/${right.sample_id}`));
  const withdrawals = await loadWithdrawalList(withdrawalListPath(input.paths.dataRoot));
  const source = sourceFor({ ...input, records });
  if (input.includeOriginals && source.redistribution !== 'allowed') fail('RELEASE_REDISTRIBUTION_NOT_ALLOWED');
  const destination = resolveOwnedPath(input.paths.dataRoot, `releases/${input.version}`);
  const staging = resolveOwnedPath(input.paths.dataRoot, `work/releases/${input.version}.${crypto.randomUUID()}`);
  await mkdir(staging, { recursive: true });
  const payloadFiles: ReleaseFile[] = [];
  const entries: ReleaseEntry[] = [];
  const omittedOriginals: ReleaseManifest['omitted_originals'] = [];
  const parserKeys = new Set<string>();
  const mappingVersions = new Set<string>();
  try {
    for (const record of records) {
      if (isWithdrawn(record, withdrawals)) fail('RELEASE_WITHDRAWN_RECORD');
      if (!record.allowed_uses.every(value => value === 'development' || value === 'regression')) fail('RELEASE_GROUP_INVALID');
      safeId(record.sample_id, 'RELEASE_SAMPLE_ID_INVALID');
      const base = `payload/samples/${record.sample_id}`;
      const recordSource = resolveOwnedPath(input.paths.dataRoot, `datasets/${record.dataset_id}/samples/${record.sample_id}/record.json`);
      const recordBytes = await readFile(recordSource);
      let recordValue: unknown;
      try { recordValue = JSON.parse(recordBytes.toString('utf8')); } catch { fail('RELEASE_RECORD_INVALID'); }
      if (recordBytes.toString('utf8') !== canonicalJson(recordValue) || digest(recordBytes) !== digest(Buffer.from(canonicalJson(record)))) fail('RELEASE_RECORD_HASH_MISMATCH');
      assertPortable(recordValue);
      const entryBase: Omit<ReleaseEntry, 'record_sha256'> = { sample_id: record.sample_id, dataset_id: record.dataset_id, source_record_id: record.source_record_id, dataset_revision: record.dataset_revision, layout_group: record.layout_group, group: [...record.allowed_uses].sort(), record: `${base}/record.json` };
      if (record.label_ref) {
        const labelSource = referencePath(input.paths, record.label_ref.root, record.label_ref.path);
        if (!record.label_sha256 || await sha256File(labelSource) !== record.label_sha256) fail('RELEASE_LABEL_HASH_MISMATCH');
        entryBase.label = `${base}/label.json`;
        payloadFiles.push(await copyPayload(staging, entryBase.label, labelSource));
        if (record.mapping_version) mappingVersions.add(record.mapping_version);
      }
      if (record.derived_ref) {
        const parsedSource = referencePath(input.paths, record.derived_ref.root, record.derived_ref.path);
        const verified = await verifyNormalizedOutput(parsedSource);
        if (record.content_sha256 !== verified.contentHash) fail('RELEASE_PARSED_HASH_MISMATCH');
        entryBase.parsed = `${base}/parsed`;
        payloadFiles.push(...await copyTree(staging, entryBase.parsed, parsedSource));
        if (record.parser_key) parserKeys.add(record.parser_key);
      }
      if (input.includeOriginals) {
        const originalSource = referencePath(input.paths, record.original_ref.root, record.original_ref.path);
        if (await sha256File(originalSource) !== record.original_sha256) fail('RELEASE_ORIGINAL_HASH_MISMATCH');
        entryBase.original = `${base}/original${record.original_ref.path.slice(record.original_ref.path.lastIndexOf('.'))}`;
        payloadFiles.push(await copyPayload(staging, entryBase.original, originalSource));
        if (record.annotation_ref) {
          const annotationSource = referencePath(input.paths, record.annotation_ref.root, record.annotation_ref.path);
          if (!record.annotation_sha256 || await sha256File(annotationSource) !== record.annotation_sha256) fail('RELEASE_ANNOTATION_HASH_MISMATCH');
          entryBase.annotation = `${base}/annotation.json`;
          payloadFiles.push(await copyPayload(staging, entryBase.annotation, annotationSource));
        }
      } else {
        omittedOriginals.push({ sample_id: record.sample_id, reason: 'redistribution_not_requested_or_not_allowed' });
      }
      const { original_ref: _originalRef, annotation_ref: _annotationRef, label_ref: _labelRef, derived_ref: _derivedRef, ...portableBase } = record;
      const portableRecord = {
        ...portableBase,
        ...(entryBase.original ? { original_ref: { root: 'release', path: entryBase.original } satisfies PortableRef } : {}),
        ...(entryBase.annotation ? { annotation_ref: { root: 'release', path: entryBase.annotation } satisfies PortableRef } : {}),
        ...(entryBase.label ? { label_ref: { root: 'release', path: entryBase.label } satisfies PortableRef } : {}),
        ...(entryBase.parsed ? { derived_ref: { root: 'release', path: entryBase.parsed } satisfies PortableRef } : {}),
      };
      assertPortable(portableRecord);
      const portableBytes = Buffer.from(canonicalJson(portableRecord));
      const entry: ReleaseEntry = { ...entryBase, record_sha256: digest(portableBytes) };
      payloadFiles.push(await writePayload(staging, entry.record, portableBytes));
      entries.push(entry);
    }
    const datasetMetadataBytes = await datasetMetadata(input.paths, source);
    if (datasetMetadataBytes) {
      let value: unknown;
      try { value = JSON.parse(datasetMetadataBytes.toString('utf8')); } catch { fail('RELEASE_SOURCE_METADATA_INVALID'); }
      if (datasetMetadataBytes.toString('utf8') !== canonicalJson(value)) fail('RELEASE_SOURCE_METADATA_INVALID');
      assertPortable(value);
      payloadFiles.push(await writePayload(staging, 'payload/source/dataset.json', Buffer.from(canonicalJson(value))));
    }
    const manifest: ReleaseManifest = {
      schema: releaseSchema, version: input.version, selection_hash: input.selectionHash ?? manifestHash(records), ...(input.selectionId ? { selection_id: input.selectionId } : {}), source,
      engine_sha: process.env.FLOWMATE_ENGINE_SHA ?? 'unknown', parser_keys: [...parserKeys].sort(), mapping_versions: [...mappingVersions].sort(), groups: [...new Set(records.flatMap(record => record.allowed_uses))].sort() as Array<'development' | 'regression'>,
      entries, omitted_originals: omittedOriginals,
    };
    assertPortable(manifest);
    const manifestBytes = Buffer.from(canonicalJson(manifest));
    await writeFile(join(staging, 'manifest.json'), manifestBytes, { flag: 'wx' });
    const checksums = { schema: releaseSchema, files: [...payloadFiles, { path: 'manifest.json', sha256: digest(manifestBytes), bytes: manifestBytes.byteLength }].sort((left, right) => left.path.localeCompare(right.path)) };
    await writeFile(join(staging, 'checksums.json'), canonicalJson(checksums), { flag: 'wx' });
    await verifyRelease(staging);
    await mkdir(dirname(destination), { recursive: true });
    if (await exists(destination)) {
      try {
        const existing = await verifyRelease(destination);
        const expectedFiles = [...payloadFiles, { path: 'manifest.json', sha256: digest(manifestBytes), bytes: manifestBytes.byteLength }].sort((left, right) => left.path.localeCompare(right.path));
        if (canonicalJson(existing.manifest) === canonicalJson(manifest) && canonicalJson(existing.files) === canonicalJson(expectedFiles)) return { path: destination, manifest: existing.manifest, files: existing.files };
      } catch { /* An invalid or different existing version is still immutable. */ }
      fail('RELEASE_VERSION_CONFLICT');
    }
    await promoteNoReplace(staging, destination);
    return { path: destination, manifest, files: [...payloadFiles, { path: 'manifest.json', sha256: digest(manifestBytes), bytes: manifestBytes.byteLength }] };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isWithdrawn(record: Pick<SampleRecord, 'dataset_id' | 'sample_id' | 'source_record_id'>, list: Awaited<ReturnType<typeof loadWithdrawalList>>): boolean {
  return list.entries.some(entry => entry.dataset_id === record.dataset_id && entry.sample_id === record.sample_id
    && (entry.source_record_id === undefined || entry.source_record_id === record.source_record_id));
}

export async function verifyRelease(path: string): Promise<{ manifest: ReleaseManifest; files: ReleaseFile[] }> {
  const manifestBytes = await readFile(join(path, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as ReleaseManifest;
  if (manifestBytes.toString('utf8') !== canonicalJson(manifest) || manifest.schema !== releaseSchema || typeof manifest.version !== 'string') fail('RELEASE_MANIFEST_INVALID');
  assertPortable(manifest);
  const checksumBytes = await readFile(join(path, 'checksums.json'));
  const checksums = JSON.parse(checksumBytes.toString('utf8')) as { schema?: string; files?: ReleaseFile[] };
  if (checksumBytes.toString('utf8') !== canonicalJson(checksums) || checksums.schema !== releaseSchema || !Array.isArray(checksums.files) || checksums.files.some(file => file.path === 'checksums.json')) fail('RELEASE_CHECKSUMS_INVALID');
  const actual = new Set((await realTree(path)).filter(name => !name.endsWith('/')));
  const expected = new Set(['manifest.json', 'checksums.json', ...checksums.files.map(file => file.path)]);
  if (actual.size !== expected.size || [...actual].some(file => !expected.has(file))) fail('RELEASE_FILE_SET_MISMATCH');
  for (const file of checksums.files) {
    safeRelative(file.path);
    const body = await readFile(releasePath(path, file.path));
    if (digest(body) !== file.sha256 || body.byteLength !== file.bytes) fail('RELEASE_CHECKSUM_MISMATCH');
  }
  const manifestChecksum = checksums.files.find(file => file.path === 'manifest.json');
  if (!manifestChecksum || manifestChecksum.sha256 !== digest(manifestBytes)) fail('RELEASE_MANIFEST_CHECKSUM_MISMATCH');
  for (const entry of manifest.entries) {
    if (!/^[0-9a-f]{64}$/.test(entry.record_sha256)) fail('RELEASE_ENTRY_INVALID');
    const recordBytes = await readFile(releasePath(path, entry.record));
    if (digest(recordBytes) !== entry.record_sha256) fail('RELEASE_RECORD_HASH_MISMATCH');
    let recordValue: Record<string, unknown>;
    try { recordValue = JSON.parse(recordBytes.toString('utf8')) as Record<string, unknown>; }
    catch { fail('RELEASE_RECORD_INVALID'); }
    if (!recordValue || Array.isArray(recordValue) || canonicalJson(recordValue) !== recordBytes.toString('utf8')) fail('RELEASE_RECORD_INVALID');
    assertPortable(recordValue);
    if (recordValue.sample_id !== entry.sample_id || recordValue.dataset_id !== entry.dataset_id || recordValue.source_record_id !== entry.source_record_id || recordValue.dataset_revision !== entry.dataset_revision) fail('RELEASE_RECORD_INVALID');
    const refs: Array<[string, string | undefined]> = [['original_ref', entry.original], ['annotation_ref', entry.annotation], ['label_ref', entry.label], ['derived_ref', entry.parsed]];
    for (const [key, expectedPath] of refs) {
      const value = recordValue[key] as { root?: unknown; path?: unknown } | undefined;
      if (expectedPath === undefined) { if (value !== undefined) fail('RELEASE_RECORD_REFERENCE_INVALID'); }
      else if (!value || value.root !== 'release' || value.path !== expectedPath) fail('RELEASE_RECORD_REFERENCE_INVALID');
    }
    for (const ref of [entry.record, entry.label, entry.parsed, entry.original, entry.annotation]) if (ref) {
      if (entry.parsed === ref) {
        if (![...expected].some(file => file === ref || file.startsWith(`${ref}/`))) fail('RELEASE_REFERENCE_MISSING');
      } else if (!expected.has(ref)) fail('RELEASE_REFERENCE_MISSING');
    }
  }
  return { manifest, files: checksums.files };
}

export async function loadReleaseRecords(paths: FlowmatePaths, selectionId?: string): Promise<{ records: SampleRecord[]; selectionHash?: string }> {
  if (!selectionId) return { records: await loadSampleRecords(paths, 'voxel51-hq-invoice-ocr') };
  const selected = await selectionRecords(paths, selectionId, await loadReleaseSourceConfig());
  return { records: selected.records, selectionHash: selected.selectionHash };
}

export async function loadReleaseSourceConfig(): Promise<SourceConfig> {
  return loadSourceConfig(join(import.meta.dir, '../config/sources/voxel51-invoice-ocr.json'));
}
