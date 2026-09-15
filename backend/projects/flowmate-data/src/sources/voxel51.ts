import { installImmutableFile, sha256File, writeCanonicalJson, writePrettyJson, type SupportedMimeType } from '../file-store.ts';
import { compactJsonFileHash, prettyJson } from '../readable-json.ts';
import { recoverPublications, publicationPaths, commitPublication } from '../publication.ts';
import { sampleDirectory, datasetTasks, datasetAlias } from '../layout.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { resolveOwnedPath } from '../config.ts';
import type { AcquireCounts, FlowmatePaths, SourceConfig } from '../contracts.ts';
import { canonicalJson, hashCanonical, withRunLock } from '../engine-bridge.ts';
import { createDownloader, isRetryableDownloadError, type DownloadReceipt } from '../downloader.ts';
import { loadSampleRecords, saveSampleRecord } from '../task-store.ts';
import { assertRevision, createSourceHttp, metadataScope, resolveHuggingFaceRevision, type SourceTransport } from './dataset-records.ts';

type JsonObject = Record<string, unknown>;
export interface Voxel51Record {
  source_record_id: string;
  image_path: string;
  annotation_locator: string;
  raw: JsonObject;
  annotation_status?: 'annotated' | 'unannotated' | 'invalid_annotation';
  /** Compatibility alias used by older callers. */
  annotated: boolean;
}
export interface SelectedVoxel51Record {
  sample_id: string;
  source_record_id: string;
  image_path: string;
  annotation_locator: string;
  annotation_status: 'annotated' | 'unannotated';
  annotation_sha256?: string;
}
export interface Voxel51Selection {
  revision: string;
  counts: AcquireCounts;
  records: SelectedVoxel51Record[];
  selection_hash: string;
}
export interface AcquireProgress {
  index: number;
  total: number;
  sampleId: string;
  annotationStatus: 'annotated' | 'unannotated';
  status: 'started' | 'completed' | 'failed';
  elapsedMs: number;
}
interface StoredSelection extends Voxel51Selection {
  schema_version: 1;
  source_id: string;
  dataset_id: string;
  selection_id: string;
  index_url: string;
  index_sha256: string;
}
interface DeferredAcquireFailure {
  sample_id: string;
  annotation_status: 'annotated' | 'unannotated';
  code: string;
}

function fail(code: string): never { throw new Error(code); }
function insufficientSelection(kind: 'ANNOTATED' | 'UNANNOTATED', requested: number, available: number, sourceTotal: number, alreadyAcquired: number): never {
  const code = `VOXEL51_INSUFFICIENT_${kind}_RECORDS`;
  const configKey = kind === 'ANNOTATED' ? 'sample.acquire.with_publisher_annotation' : 'sample.acquire.without_publisher_annotation';
  const error = new Error(`${code}: requested=${requested}, available=${available}, already_acquired=${alreadyAcquired}, source_total=${sourceTotal}; 请将 ${configKey} 调整为不超过 ${available}`);
  throw Object.assign(error, { code, requested, available, already_acquired: alreadyAcquired, source_total: sourceTotal });
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VOXEL51_INVALID_INDEX');
  return value as JsonObject;
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function imageMime(path: string): 'image/jpeg' | 'image/png' {
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  if (/\.png$/i.test(path)) return 'image/png';
  return fail('VOXEL51_IMAGE_EXTENSION_REJECTED');
}
function safeImagePath(value: unknown): string {
  if (typeof value !== 'string' || !/^data\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(value)) return fail('VOXEL51_IMAGE_PATH_REJECTED');
  imageMime(value);
  return value;
}
function safeId(value: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail('VOXEL51_INVALID_ID');
}

function nonNegativeInteger(value: unknown, code = 'VOXEL51_INVALID_LIMIT'): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(code);
  return Number(value);
}

export function normalizeVoxel51AcquireCounts(options: {
  limit?: number;
  counts?: Partial<AcquireCounts>;
  with_publisher_annotation?: number;
  without_publisher_annotation?: number;
  withPublisherAnnotation?: number;
  withoutPublisherAnnotation?: number;
}): AcquireCounts {
  if (options.counts !== undefined || options.with_publisher_annotation !== undefined || options.without_publisher_annotation !== undefined
    || options.withPublisherAnnotation !== undefined || options.withoutPublisherAnnotation !== undefined) {
    const withCount = options.counts?.with_publisher_annotation ?? options.with_publisher_annotation ?? options.withPublisherAnnotation ?? 0;
    const withoutCount = options.counts?.without_publisher_annotation ?? options.without_publisher_annotation ?? options.withoutPublisherAnnotation ?? 0;
    const counts = { with_publisher_annotation: nonNegativeInteger(withCount), without_publisher_annotation: nonNegativeInteger(withoutCount) };
    if (counts.with_publisher_annotation + counts.without_publisher_annotation <= 0) fail('VOXEL51_INVALID_LIMIT');
    return counts;
  }
  if (options.limit !== undefined) {
    const limit = nonNegativeInteger(options.limit);
    if (limit <= 0) fail('VOXEL51_INVALID_LIMIT');
    return { with_publisher_annotation: limit, without_publisher_annotation: 0 };
  }
  fail('VOXEL51_INVALID_LIMIT');
}

export function voxel51AcquireTotal(counts: AcquireCounts): number {
  return counts.with_publisher_annotation + counts.without_publisher_annotation;
}

export function assertVoxel51AcquireCounts(config: SourceConfig, counts: AcquireCounts): void {
  const normalized = normalizeVoxel51AcquireCounts({ counts });
  const total = voxel51AcquireTotal(normalized);
  if (config.record_count !== undefined && total > config.record_count) fail('VOXEL51_LIMIT_EXCEEDS_TOTAL_RECORDS');
  if (config.annotated_record_count !== undefined && normalized.with_publisher_annotation > config.annotated_record_count) fail('VOXEL51_LIMIT_EXCEEDS_ANNOTATED_RECORDS');
  if (config.record_count !== undefined && config.annotated_record_count !== undefined
    && normalized.without_publisher_annotation > config.record_count - config.annotated_record_count) fail('VOXEL51_LIMIT_EXCEEDS_UNANNOTATED_RECORDS');
}

export function assertVoxel51AcquireLimit(config: SourceConfig, limit: number): void {
  assertVoxel51AcquireCounts(config, { with_publisher_annotation: limit, without_publisher_annotation: 0 });
}

export function readVoxel51Index(bytes: Uint8Array): Voxel51Record[] {
  const value = object(JSON.parse(Buffer.from(bytes).toString('utf8')));
  if (!Array.isArray(value.samples)) return fail('VOXEL51_INVALID_INDEX');
  const ids = new Set<string>();
  return value.samples.map((sample, index) => {
    const raw = object(sample);
    const id = object(raw._id).$oid;
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) return fail('VOXEL51_INVALID_RECORD_ID');
    if (ids.has(id)) return fail('VOXEL51_DUPLICATE_RECORD');
    ids.add(id);
    let annotation_status: Voxel51Record['annotation_status'] = 'unannotated';
    if (typeof raw.json_annotation === 'string' && raw.json_annotation.trim()) {
      try {
        const annotation = JSON.parse(raw.json_annotation);
        annotation_status = annotation === null || (typeof annotation === 'object' && !Array.isArray(annotation) && Object.keys(annotation).length === 0)
          ? 'unannotated' : annotation !== null && typeof annotation === 'object' && !Array.isArray(annotation) ? 'annotated' : 'invalid_annotation';
      } catch { annotation_status = 'invalid_annotation'; }
    } else if (raw.json_annotation !== undefined && raw.json_annotation !== null && typeof raw.json_annotation !== 'string') {
      annotation_status = typeof raw.json_annotation === 'object' && !Array.isArray(raw.json_annotation)
        && Object.keys(raw.json_annotation as JsonObject).length === 0 ? 'unannotated' : 'invalid_annotation';
    }
    return { source_record_id: id, image_path: safeImagePath(raw.filepath), annotation_locator: `/samples/${index}`, raw, annotation_status, annotated: annotation_status === 'annotated' };
  });
}

export function selectVoxel51(records: readonly Voxel51Record[], options: {
  revision: string;
  limit?: number;
  counts?: Partial<AcquireCounts>;
  exclude_source_record_ids?: ReadonlySet<string>;
  with_publisher_annotation?: number;
  without_publisher_annotation?: number;
  withPublisherAnnotation?: number;
  withoutPublisherAnnotation?: number;
}): Voxel51Selection {
  assertRevision(options.revision);
  const counts = normalizeVoxel51AcquireCounts(options);
  const excluded = options.exclude_source_record_ids ?? new Set<string>();
  const annotatedSource = records.filter(record => record.annotation_status === 'annotated'
    || (record.annotation_status === undefined && record.annotated));
  const unannotatedSource = records.filter(record => record.annotation_status === 'unannotated'
    || (record.annotation_status === undefined && !record.annotated));
  const annotated = annotatedSource.filter(record => !excluded.has(record.source_record_id))
    .sort((a, b) => a.source_record_id < b.source_record_id ? -1 : a.source_record_id > b.source_record_id ? 1 : 0);
  const unannotated = unannotatedSource.filter(record => !excluded.has(record.source_record_id))
    .sort((a, b) => a.source_record_id < b.source_record_id ? -1 : a.source_record_id > b.source_record_id ? 1 : 0);
  if (annotated.length < counts.with_publisher_annotation) {
    return insufficientSelection('ANNOTATED', counts.with_publisher_annotation, annotated.length, annotatedSource.length, annotatedSource.length - annotated.length);
  }
  if (unannotated.length < counts.without_publisher_annotation) {
    return insufficientSelection('UNANNOTATED', counts.without_publisher_annotation, unannotated.length, unannotatedSource.length, unannotatedSource.length - unannotated.length);
  }
  const selected = [
    ...annotated.slice(0, counts.with_publisher_annotation).map(record => ({ record, annotation_status: 'annotated' as const })),
    ...unannotated.slice(0, counts.without_publisher_annotation).map(record => ({ record, annotation_status: 'unannotated' as const })),
  ];
  const content = {
    revision: options.revision,
    counts,
    records: selected.map(({ record, annotation_status }, index) => ({
      sample_id: String(index + 1).padStart(6, '0'), source_record_id: record.source_record_id,
      image_path: record.image_path, annotation_locator: record.annotation_locator, annotation_status,
      ...(annotation_status === 'annotated' ? { annotation_sha256: hashCanonical(record.raw) } : {}),
    })),
  };
  return { ...content, selection_hash: hashCanonical(content) };
}

function fileUrl(config: SourceConfig, revision: string, path: string): string {
  assertRevision(revision);
  if (!config.record_locator) return fail('VOXEL51_MISSING_LOCATOR');
  return config.record_locator.file_url_template.replace('{revision}', revision).replace('{path}', path);
}

async function readIndex(config: SourceConfig, revision: string, transport: SourceTransport) {
  const index_url = fileUrl(config, revision, config.record_locator!.index_path);
  const result = await transport.http.get(index_url, metadataScope(config, 16 * 1024 * 1024));
  return { bytes: result.bytes, index_url, index_sha256: digest(result.bytes), records: readVoxel51Index(result.bytes) };
}

export async function probeVoxel51(config: SourceConfig, options: { transport?: SourceTransport } = {}) {
  const transport = options.transport ?? createSourceHttp(config);
  const revision = await resolveHuggingFaceRevision(config, { http: transport.http });
  const index = await readIndex(config, revision, transport);
  const annotated_count = index.records.filter(record => record.annotation_status === 'annotated' || record.annotated).length;
  const unannotated_count = index.records.filter(record => record.annotation_status === 'unannotated').length;
  const invalid_annotation_count = index.records.filter(record => record.annotation_status === 'invalid_annotation').length;
  return { source_id: config.source_id, revision, index_url: index.index_url, index_sha256: index.index_sha256, record_count: index.records.length, annotated_count, unannotated_count, invalid_annotation_count, redirect_chain: transport.redirect_chain };
}

async function optionalBytes(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}

async function immutableBytes(path: string, bytes: Uint8Array, mime: SupportedMimeType = 'application/json'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.part`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  try { await installImmutableFile(temporary, path, { sha256: digest(bytes), mime_type: mime }); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function preserveStableDatasetMetadata(path: string, bytes: Uint8Array, datasetId: string, sourceId: string): Promise<void> {
  const existing = await optionalBytes(path);
  if (!existing) { await immutableBytes(path, bytes); return; }
  if (digest(existing) === digest(bytes)) return;
  try {
    const value = JSON.parse(existing.toString('utf8')) as { schema_version?: unknown; dataset_id?: unknown; source_id?: unknown; revision?: unknown };
    if (value.schema_version === 1 && value.dataset_id === datasetId && value.source_id === sourceId && typeof value.revision === 'string') return;
  } catch { /* A malformed stable metadata file must still fail closed below. */ }
  await immutableBytes(path, bytes);
}

function selectionCounts(value: JsonObject): AcquireCounts {
  if (!Array.isArray(value.records)) return fail('VOXEL51_SELECTION_INVALID');
  const countsValue = value.counts;
  const counts: AcquireCounts = countsValue && typeof countsValue === 'object' && !Array.isArray(countsValue)
    ? { with_publisher_annotation: nonNegativeInteger((countsValue as JsonObject).with_publisher_annotation, 'VOXEL51_SELECTION_INVALID'), without_publisher_annotation: nonNegativeInteger((countsValue as JsonObject).without_publisher_annotation, 'VOXEL51_SELECTION_INVALID') }
    : { with_publisher_annotation: value.records.filter((entry: unknown) => {
        const row = entry && typeof entry === 'object' ? entry as JsonObject : {};
        return row.annotation_status !== 'unannotated';
      }).length, without_publisher_annotation: 0 };
  if (counts.with_publisher_annotation + counts.without_publisher_annotation !== value.records.length) return fail('VOXEL51_SELECTION_INVALID');
  return counts;
}

function selectionPath(paths: FlowmatePaths, config: SourceConfig, selectionId: string): string {
  safeId(selectionId);
  if (!config.dataset_id) return fail('VOXEL51_MISSING_DATASET_ID');
  return resolveOwnedPath(paths.dataRoot, `${datasetTasks(config.dataset_id)}/selections/${selectionId}.json`);
}

function selectionCountText(counts: AcquireCounts): string {
  return `带发布方标注 ${counts.with_publisher_annotation} 条、无发布方标注 ${counts.without_publisher_annotation} 条（共 ${counts.with_publisher_annotation + counts.without_publisher_annotation} 条）`;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof Reflect.get(error, 'code') === 'string') return Reflect.get(error, 'code') as string;
  return error instanceof Error && error.name ? error.name : 'UNKNOWN_ERROR';
}

function partialAcquireError(failures: readonly DeferredAcquireFailure[]): never {
  const preview = failures.slice(0, 3).map(failure => `${failure.sample_id}(${failure.code})`).join('、');
  const remaining = failures.length > 3 ? ` 等 ${failures.length} 条` : '';
  const error = new Error(`VOXEL51_ACQUIRE_PARTIAL: ${failures.length} 条瞬时网络下载失败；首个失败 ${preview}${remaining}；已完成记录已保留，请重新执行任务`);
  throw Object.assign(error, { code: 'VOXEL51_ACQUIRE_PARTIAL', failures });
}

function sameAcquireCounts(left: AcquireCounts, right: AcquireCounts): boolean {
  return left.with_publisher_annotation === right.with_publisher_annotation
    && left.without_publisher_annotation === right.without_publisher_annotation;
}

function selectionLimitConflict(selectionId: string, expectedCounts: AcquireCounts, actualCounts: AcquireCounts, selectionFile?: string): Error {
  const suggestedId = `${selectionId}-a${expectedCounts.with_publisher_annotation}-u${expectedCounts.without_publisher_annotation}`;
  const location = selectionFile ? `；固定清单路径：${selectionFile}` : '';
  const error = new Error(`SELECTION_LIMIT_CONFLICT: selection_id=${selectionId} 已固定为${selectionCountText(actualCounts)}，当前配置请求${selectionCountText(expectedCounts)}。固定选样清单不可覆盖，请更换 selection_id（修改配置中的 selection_id，例如 ${suggestedId}）后重试${location}`);
  return Object.assign(error, { code: 'SELECTION_LIMIT_CONFLICT', selectionId, existingCounts: actualCounts, expectedCounts, selectionPath: selectionFile });
}

export function assertVoxel51SelectionCounts(selectionId: string, expectedCounts: AcquireCounts, actualCounts: AcquireCounts, selectionFile?: string): void {
  if (actualCounts.with_publisher_annotation !== expectedCounts.with_publisher_annotation
    || actualCounts.without_publisher_annotation !== expectedCounts.without_publisher_annotation) throw selectionLimitConflict(selectionId, expectedCounts, actualCounts, selectionFile);
}

function parseStoredSelection(bytes: Uint8Array, config: SourceConfig, selectionId: string): StoredSelection {
  const value = object(JSON.parse(Buffer.from(bytes).toString('utf8')));
  const { selection_hash, ...content } = value;
  if (selection_hash !== hashCanonical(content) || value.schema_version !== 1 || value.source_id !== config.source_id || value.dataset_id !== config.dataset_id || value.selection_id !== selectionId || !Array.isArray(value.records)) return fail('VOXEL51_SELECTION_INVALID');
  const counts = selectionCounts(value);
  if (typeof value.revision !== 'string') return fail('VOXEL51_SELECTION_INVALID');
  assertRevision(value.revision);
  if (value.index_url !== fileUrl(config, value.revision, config.record_locator!.index_path)) return fail('VOXEL51_SELECTION_INVALID');
  return { ...(value as unknown as StoredSelection), counts };
}

export interface Voxel51SelectionInspection {
  selectionId: string;
  path: string;
  exists: boolean;
  counts?: AcquireCounts;
  recordCount?: number;
  revision?: string;
  selectionHash?: string;
}

/** Read the local fixed-selection intent without resolving the public source or downloading files. */
export async function inspectVoxel51Selection(options: { paths: FlowmatePaths; config: SourceConfig; selectionId: string }): Promise<Voxel51SelectionInspection> {
  const { paths, config, selectionId } = options;
  if (config.source_id !== 'voxel51-invoice-ocr' || config.dataset_id !== 'voxel51-hq-invoice-ocr') return fail('VOXEL51_SOURCE_IDENTITY_MISMATCH');
  const path = selectionPath(paths, config, selectionId);
  const saved = await optionalBytes(path);
  if (!saved) return { selectionId, path, exists: false };
  const selection = parseStoredSelection(saved, config, selectionId);
  return { selectionId, path, exists: true, counts: selection.counts, recordCount: selection.records.length, revision: selection.revision, selectionHash: selection.selection_hash };
}

/**
 * Load the sample ids from a persisted selection for progress reporting.
 * Missing selections are represented by an empty set; acquisition will create
 * the selection before the catalog stage runs in a complete task.
 */
export async function loadVoxel51SelectionSampleIds(options: { paths: FlowmatePaths; config: SourceConfig; selectionId: string }): Promise<ReadonlySet<string>> {
  const { paths, config, selectionId } = options;
  if (config.source_id !== 'voxel51-invoice-ocr' || config.dataset_id !== 'voxel51-hq-invoice-ocr') return fail('VOXEL51_SOURCE_IDENTITY_MISMATCH');
  const saved = await optionalBytes(selectionPath(paths, config, selectionId));
  if (!saved) return new Set<string>();
  const selection = parseStoredSelection(saved, config, selectionId);
  return new Set(selection.records.map(record => record.sample_id));
}

function checkSelection(bytes: Uint8Array, config: SourceConfig, selectionId: string, expectedCounts: AcquireCounts, selectionFile?: string): StoredSelection {
  const selection = parseStoredSelection(bytes, config, selectionId);
  assertVoxel51SelectionCounts(selectionId, expectedCounts, selection.counts, selectionFile);
  return selection;
}

/**
 * The `current` selection is also the cursor for automatic batch acquisition.
 * A new batch may only start after every record in the previous batch has a
 * committed record, original file, receipt, and publisher annotation (when
 * applicable).  Missing files mean an interrupted batch and are resumed; a
 * hash mismatch is corruption and must fail closed.
 */
async function currentSelectionIsComplete(paths: FlowmatePaths, config: SourceConfig, selection: StoredSelection): Promise<boolean> {
  const existingRecords = await loadSampleRecords(paths, config.dataset_id!);
  const bySampleId = new Map(existingRecords.map(record => [record.sample_id, record]));
  for (const entry of selection.records) {
    const existing = bySampleId.get(entry.sample_id);
    if (!existing) return false;
    if (existing.dataset_id !== config.dataset_id || existing.dataset_revision !== selection.revision
      || existing.source_record_id !== entry.source_record_id || existing.original_ref.root !== 'original') {
      return fail('VOXEL51_CURRENT_BATCH_CORRUPTED');
    }
    const existingStatus = existing.publisher_annotation_status ?? (existing.annotation_ref || existing.annotation_sha256 ? 'annotated' : 'unannotated');
    if (existingStatus !== entry.annotation_status) return fail('VOXEL51_CURRENT_BATCH_CORRUPTED');
    const originalPath = resolveOwnedPath(paths.originalRoot, existing.original_ref.path);
    const receiptPath = resolveOwnedPath(paths.dataRoot, `${sampleDirectory(config.dataset_id!, entry.sample_id)}/receipt.json`);
    if (!(await Bun.file(originalPath).exists()) || !(await Bun.file(receiptPath).exists())) return false;
    if (await sha256File(originalPath) !== existing.original_sha256) return fail('VOXEL51_CURRENT_BATCH_CORRUPTED');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Partial<DownloadReceipt>;
    if (receipt.sha256 !== existing.original_sha256 || receipt.stable_url !== fileUrl(config, selection.revision, entry.image_path)) return fail('VOXEL51_CURRENT_BATCH_CORRUPTED');
    if (entry.annotation_status === 'annotated') {
      if (existing.annotation_ref?.root !== 'original' || existing.annotation_ref.path !== `${sampleDirectory(config.dataset_id!, entry.sample_id)}/annotation.json` || !existing.annotation_sha256 || existing.annotation_sha256 !== entry.annotation_sha256) return fail('VOXEL51_CURRENT_BATCH_CORRUPTED');
      const annotationPath = resolveOwnedPath(paths.originalRoot, existing.annotation_ref.path);
      if (!(await Bun.file(annotationPath).exists())) return false;
      if (await compactJsonFileHash(annotationPath) !== existing.annotation_sha256) return fail('VOXEL51_CURRENT_BATCH_CORRUPTED');
    } else if (existing.annotation_ref || existing.annotation_sha256) {
      return fail('VOXEL51_CURRENT_BATCH_CORRUPTED');
    }
  }
  return true;
}

async function archiveCurrentSelection(paths: FlowmatePaths, config: SourceConfig, selection: StoredSelection, indexBytes: Uint8Array): Promise<void> {
  const base = resolveOwnedPath(paths.dataRoot, `${datasetTasks(config.dataset_id!)}/selections/history/${selection.selection_hash}`);
  await immutableBytes(`${base}.json`, Buffer.from(canonicalJson(selection)));
  await immutableBytes(`${base}.index.json`, indexBytes);
}

export async function acquireVoxel51Selection(options: {
  paths: FlowmatePaths; config: SourceConfig; selectionId: string; limit?: number; counts?: Partial<AcquireCounts>; transport?: SourceTransport; resume?: boolean;
  onProgress?: (progress: AcquireProgress) => void | Promise<void>;
}): Promise<{ added: number; reused: number; selection_hash: string; revision: string; counts: AcquireCounts; total: number }> {
  return withRunLock(resolveOwnedPath(options.paths.dataRoot, 'work/run.lock'), () => acquireVoxel51SelectionUnlocked(options), { jobId: `flowmate-acquire-${options.selectionId}` });
}

async function acquireVoxel51SelectionUnlocked(options: {
  paths: FlowmatePaths; config: SourceConfig; selectionId: string; limit?: number; counts?: Partial<AcquireCounts>; transport?: SourceTransport; resume?: boolean;
  onProgress?: (progress: AcquireProgress) => void | Promise<void>;
}): Promise<{ added: number; reused: number; selection_hash: string; revision: string; counts: AcquireCounts; total: number }> {
  const { paths, config, selectionId } = options;
  const counts = normalizeVoxel51AcquireCounts({ limit: options.limit, counts: options.counts });
  await recoverPublications(paths);
  safeId(selectionId);
  if (!config.dataset_id) return fail('VOXEL51_MISSING_DATASET_ID');
  if (config.dataset_id !== 'voxel51-hq-invoice-ocr' || config.source_id !== 'voxel51-invoice-ocr') return fail('VOXEL51_SOURCE_IDENTITY_MISMATCH');
  safeId(config.dataset_id);
  assertVoxel51AcquireCounts(config, counts);
  if (config.retention !== 'allowed' || config.local_use !== 'allowed') return fail('VOXEL51_LOCAL_USE_NOT_ALLOWED');
  const transport = options.transport ?? createSourceHttp(config);
  const base = datasetTasks(config.dataset_id);
  const data = (path: string) => resolveOwnedPath(paths.dataRoot, `${base}/${path}`);
  const originals = (path: string) => resolveOwnedPath(paths.originalRoot, path);
  const selectionPath = data(`selections/${selectionId}.json`);
  const indexPath = data(`selections/${selectionId}.index.json`);
  const saved = await optionalBytes(selectionPath);
  let selection: StoredSelection | undefined;
  let records: Voxel51Record[] = [];
  let appendCurrentBatch = false;
  let previousSelection: StoredSelection | undefined;
  let previousIndexBytes: Uint8Array | undefined;
  if (saved) {
    const existing = parseStoredSelection(saved, config, selectionId);
    if (selectionId === 'current') {
      let cached: Uint8Array | undefined = await optionalBytes(indexPath);
      if (!cached) {
        // A committed manifest is the recovery intent; never resolve main again to fill its cache.
        const result = await transport.http.get(existing.index_url, metadataScope(config, 16 * 1024 * 1024));
        if (digest(result.bytes) !== existing.index_sha256) return fail('VOXEL51_INDEX_HASH_MISMATCH');
        await immutableBytes(indexPath, result.bytes);
        cached = result.bytes;
      }
      if (digest(cached) !== existing.index_sha256) return fail('VOXEL51_INDEX_HASH_MISMATCH');
      records = readVoxel51Index(cached);
      if (!options.resume && await currentSelectionIsComplete(paths, config, existing)) {
        // A completed `current` batch is the cursor for the next automatic
        // batch.  Keep the prior manifest and index for audit/recovery before
        // replacing the current pointer below.
        appendCurrentBatch = true;
        previousSelection = existing;
        previousIndexBytes = cached;
      } else {
        // An incomplete current batch must be resumed with the exact same
        // counts.  Changing the split mid-batch would make recovery ambiguous.
        if (!sameAcquireCounts(existing.counts, counts)) throw selectionLimitConflict(selectionId, counts, existing.counts, selectionPath);
        selection = existing;
      }
    } else if (sameAcquireCounts(existing.counts, counts)) {
      selection = existing;
      let cached: Uint8Array | undefined = await optionalBytes(indexPath);
      if (!cached) {
        // A committed manifest is the recovery intent; never resolve main again to fill its cache.
        const result = await transport.http.get(selection.index_url, metadataScope(config, 16 * 1024 * 1024));
        if (digest(result.bytes) !== selection.index_sha256) return fail('VOXEL51_INDEX_HASH_MISMATCH');
        await immutableBytes(indexPath, result.bytes);
        cached = result.bytes;
      }
      if (digest(cached) !== selection.index_sha256) return fail('VOXEL51_INDEX_HASH_MISMATCH');
      records = readVoxel51Index(cached);
    }
  }
  if (!selection) {
    const revision = await resolveHuggingFaceRevision(config, { http: transport.http });
    const index = await readIndex(config, revision, transport);
    const existingRecords = selectionId === 'current' ? await loadSampleRecords(paths, config.dataset_id) : [];
    const excluded = selectionId === 'current' ? new Set(existingRecords.map(record => record.source_record_id)) : undefined;
    const selected = selectVoxel51(index.records, { counts, revision, ...(excluded ? { exclude_source_record_ids: excluded } : {}) });
    const registryPath = data('ids.json');
    const registryBytes = await optionalBytes(registryPath);
    const registry: { schema_version: 1; next: number; ids: Record<string, string> } = registryBytes ? JSON.parse(registryBytes.toString('utf8')) : { schema_version: 1, next: 1, ids: {} };
    if (registry.schema_version !== 1 || !Number.isSafeInteger(registry.next) || registry.next < 1 || !registry.ids || new Set(Object.values(registry.ids)).size !== Object.keys(registry.ids).length || Object.values(registry.ids).some(id => !/^[0-9]{6,}$/.test(id) || Number(id) >= registry.next)) fail('VOXEL51_ID_REGISTRY_INVALID');
    for (const entry of selected.records) {
      entry.sample_id = registry.ids[entry.source_record_id] ??= String(registry.next++).padStart(6, '0');
    }
    // Persist allocations before selection intent, including failed acquisitions.
    await writeCanonicalJson(registryPath, registry);
    const { selection_hash: _hash, ...selectionContent } = selected;
    const content = { schema_version: 1 as const, source_id: config.source_id, dataset_id: config.dataset_id, selection_id: selectionId, index_url: index.index_url, index_sha256: index.index_sha256, ...selectionContent };
    selection = { ...content, selection_hash: hashCanonical(content) };
    if (appendCurrentBatch && previousSelection && previousIndexBytes) await archiveCurrentSelection(paths, config, previousSelection, previousIndexBytes);
    // Recover the old cache-first ordering: without a manifest, this cache has no committed identity.
    // Remove it before committing intent so a crash cannot bind an old cache to a new revision.
    await unlink(indexPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    // The workbench config is the current task intent.  A changed acquire split refreshes
    // the same logical selection instead of requiring a new selection_id in the config.
    await writeCanonicalJson(selectionPath, selection);
    await immutableBytes(indexPath, index.bytes);
    records = index.records;
  }
  const registry = JSON.parse((await readFile(data('ids.json'))).toString('utf8')) as { ids: Record<string, string> };
  const byLocator = new Map(records.map(record => [record.annotation_locator, record]));
  const selectedRecords = selection.records.map(entry => {
    const record = byLocator.get(entry.annotation_locator);
    const expectedStatus = entry.annotation_status ?? (entry.annotation_sha256 ? 'annotated' : 'unannotated');
    const validAnnotation = expectedStatus === 'annotated' && (record?.annotation_status === 'annotated' || record?.annotated)
      && hashCanonical(record.raw) === entry.annotation_sha256;
    const validUnannotated = expectedStatus === 'unannotated' && record?.annotation_status === 'unannotated' && entry.annotation_sha256 === undefined;
    if (!record || (!validAnnotation && !validUnannotated) || record.source_record_id !== entry.source_record_id || record.image_path !== entry.image_path || (!/^[0-9]{6,}$/.test(entry.sample_id) || registry.ids[record.source_record_id] !== entry.sample_id)) return fail('VOXEL51_SELECTION_RECORD_MISMATCH');
    return { entry, record };
  });
  const dataset = {
    schema_version: 1, dataset_id: config.dataset_id, source_id: config.source_id, hosting_platform: 'Hugging Face',
    publisher: 'Voxel51', homepage: config.homepage, revision: selection.revision,
    ...(config.record_count === undefined ? {} : { record_count: config.record_count }),
    ...(config.annotated_record_count === undefined ? {} : { annotated_record_count: config.annotated_record_count }),
    ...(config.record_count !== undefined && config.annotated_record_count !== undefined ? { unannotated_record_count: config.record_count - config.annotated_record_count } : {}),
    declared_license: config.declared_license, license_evidence: config.license_evidence.replace('{revision}', selection.revision),
    retention: config.retention, local_use: config.local_use, redistribution: config.redistribution,
  };
  const datasetBytes = Buffer.from(canonicalJson(dataset));
  await immutableBytes(data(`revisions/${selection.revision}/dataset.json`), datasetBytes);
  await writeCanonicalJson(resolveOwnedPath(paths.dataRoot, `${datasetAlias(config.dataset_id)}/dataset.json`), dataset);
  await writePrettyJson(resolveOwnedPath(paths.originalRoot, `${datasetAlias(config.dataset_id)}/dataset.json`), dataset);
  const existingRecords = await loadSampleRecords(paths, config.dataset_id);
  const downloader = createDownloader({ http: transport.http });
  let added = 0;
  let reused = 0;
  const total = selectedRecords.length;
  type AcquireItem = { index: number; entry: SelectedVoxel51Record; record: Voxel51Record };
  const pending: AcquireItem[] = selectedRecords.map((item, index) => ({ ...item, index }));
  const failures: DeferredAcquireFailure[] = [];
  // The downloader has already exhausted its configured backoff for a
  // transient failure. Preserve completed records, continue the remaining
  // selection once, and report every item that still failed.
  for (const { index, entry, record } of pending) {
      const annotationStatus = entry.annotation_status ?? (entry.annotation_sha256 ? 'annotated' : 'unannotated');
      const startedAt = Date.now();
      await options.onProgress?.({ index: index + 1, total, sampleId: entry.sample_id, annotationStatus, status: 'started', elapsedMs: 0 });
      let transaction: Awaited<ReturnType<typeof publicationPaths>> | undefined;
      try {
      const sampleBase = sampleDirectory(config.dataset_id, entry.sample_id);
      const imageName = `original${extname(entry.image_path).toLowerCase()}`;
      const originalPath = originals(`${sampleBase}/${imageName}`);
      const annotationPath = originals(`${sampleBase}/annotation.json`);
      const receiptPath = resolveOwnedPath(paths.dataRoot, `${sampleBase}/receipt.json`);
      const stableUrl = fileUrl(config, selection.revision, entry.image_path);
      const existing = existingRecords.find(item => item.sample_id === entry.sample_id);
      const originalRef = `${sampleBase}/${imageName}`;
      const annotationRef = `${sampleBase}/annotation.json`;
      const isAnnotated = annotationStatus === 'annotated';
      if (existing && existing.dataset_revision === selection.revision) {
        const existingStatus = existing.publisher_annotation_status ?? (existing.annotation_ref || existing.annotation_sha256 ? 'annotated' : 'unannotated');
        if (existing.source_record_id !== entry.source_record_id || existing.original_ref.root !== 'original' || existing.original_ref.path !== originalRef || existingStatus !== annotationStatus) return fail('VOXEL51_RECORD_CONFLICT');
        if (isAnnotated && (existing.annotation_ref?.root !== 'original' || existing.annotation_ref.path !== annotationRef || existing.annotation_sha256 !== entry.annotation_sha256)) return fail('VOXEL51_RECORD_CONFLICT');
        if (!isAnnotated && (existing.annotation_ref || existing.annotation_sha256)) return fail('VOXEL51_RECORD_CONFLICT');
        if (await sha256File(originalPath) !== existing.original_sha256) return fail('VOXEL51_ORIGINAL_HASH_MISMATCH');
        if (isAnnotated && await compactJsonFileHash(annotationPath) !== entry.annotation_sha256) return fail('VOXEL51_ANNOTATION_HASH_MISMATCH');
        if (!isAnnotated && await optionalBytes(annotationPath)) return fail('VOXEL51_RECORD_CONFLICT');
        const receipt: DownloadReceipt = JSON.parse(await readFile(receiptPath, 'utf8'));
        const image = await readFile(originalPath);
        if (receipt.sha256 !== existing.original_sha256 || receipt.bytes !== image.length || receipt.stable_url !== fileUrl(config, existing.dataset_revision, entry.image_path) || receipt.mime_type !== imageMime(entry.image_path) || ![...config.allowed_origins, ...config.redirect_origins].includes(receipt.final_origin)) return fail('VOXEL51_RECEIPT_MISMATCH');
        reused += 1;
      } else {
        if (existing && existing.source_record_id !== entry.source_record_id) fail('VOXEL51_RECORD_CONFLICT');
        transaction = await publicationPaths(paths, config.dataset_id, entry.sample_id);
        await rm(transaction.dataWork, { recursive: true, force: true });
        await rm(transaction.originalWork, { recursive: true, force: true });
        const stagedData = transaction.swaps[0]!.stage;
        const stagedOriginal = transaction.swaps[1]!.stage;
        await mkdir(stagedData, { recursive: true });
        await mkdir(stagedOriginal, { recursive: true });
        const temporaryPath = resolveOwnedPath(paths.dataRoot, `work/downloads/${entry.sample_id}.${crypto.randomUUID()}.part`);
        let receipt: DownloadReceipt;
        try {
          receipt = await downloader.downloadToTemp({
            url: stableUrl, source: config, destination: `${stagedOriginal}/${imageName}`, temporaryPath,
            expectedMimeType: imageMime(entry.image_path), maxBytes: 32 * 1024 * 1024,
          });
        } finally {
          // The immutable installer can reuse an existing original after a prior interrupted acquisition.
          await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        if (isAnnotated) await immutableBytes(`${stagedOriginal}/annotation.json`, Buffer.from(prettyJson(JSON.parse(canonicalJson(record.raw)))));
        await immutableBytes(`${stagedData}/receipt.json`, Buffer.from(canonicalJson(receipt)));
        const candidate = {
          schema_version: 1, sample_id: entry.sample_id, dataset_id: config.dataset_id, dataset_revision: selection.revision,
          source_record_id: entry.source_record_id, origin_kind: config.origin_kind, document_kind: config.document_kind,
          language: config.language, layout_group: null, original_ref: { root: 'original', path: originalRef },
          original_sha256: receipt.sha256, publisher_annotation_status: annotationStatus,
          ...(isAnnotated ? { annotation_ref: { root: 'original', path: annotationRef }, annotation_sha256: entry.annotation_sha256 } : {}),
          source_observations: [`${selection.index_url}#${entry.annotation_locator}`], label_kind: 'none',
          quality_status: 'not_checked', processing_status: 'downloaded', allowed_uses: ['development', 'regression'],
          created_at: existing?.created_at ?? new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        const duplicate = existingRecords.find(value => value.sample_id !== entry.sample_id && value.original_sha256 === receipt.sha256);
        await writeCanonicalJson(`${stagedData}/record.json`, { ...candidate, ...(duplicate ? { duplicate_of: duplicate.sample_id } : {}) });
        await commitPublication(paths, config.dataset_id, entry.sample_id, async directory => {
          if (await Bun.file(`${directory}/record.json`).exists()) {
            const stored = JSON.parse(await readFile(`${directory}/record.json`, 'utf8'));
            if (stored.original_sha256 !== receipt.sha256 || stored.sample_id !== entry.sample_id || stored.publisher_annotation_status !== annotationStatus || (isAnnotated && stored.annotation_sha256 !== entry.annotation_sha256) || (!isAnnotated && (stored.annotation_ref || stored.annotation_sha256))) fail('VOXEL51_RECORD_CONFLICT');
            if (digest(await readFile(`${directory}/receipt.json`)) !== hashCanonical(receipt)) fail('VOXEL51_RECEIPT_MISMATCH');
          } else {
            if (await sha256File(`${directory}/${imageName}`) !== receipt.sha256) fail('VOXEL51_ORIGINAL_HASH_MISMATCH');
            if (isAnnotated && await compactJsonFileHash(`${directory}/annotation.json`) !== entry.annotation_sha256) fail('VOXEL51_ANNOTATION_HASH_MISMATCH');
          }
        });
        if (existing) reused += 1; else added += 1;
      }
      await options.onProgress?.({ index: index + 1, total, sampleId: entry.sample_id, annotationStatus, status: 'completed', elapsedMs: Date.now() - startedAt });
    } catch (error) {
      if (transaction) {
        await rm(transaction.dataWork, { recursive: true, force: true });
        await rm(transaction.originalWork, { recursive: true, force: true });
      }
      await options.onProgress?.({ index: index + 1, total, sampleId: entry.sample_id, annotationStatus, status: 'failed', elapsedMs: Date.now() - startedAt });
      if (isRetryableDownloadError(error)) {
        failures.push({ sample_id: entry.sample_id, annotation_status: annotationStatus, code: errorCode(error) });
        continue;
      }
      throw error;
    }
  }
  if (failures.length > 0) partialAcquireError(failures);
  return { added, reused, selection_hash: selection.selection_hash, revision: selection.revision, counts: selection.counts, total: selection.records.length };
}
