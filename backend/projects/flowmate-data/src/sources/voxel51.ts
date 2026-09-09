import { writePrettyJson } from '../file-store.ts';
import { compactJsonFileHash, prettyJson } from '../readable-json.ts';
import { recoverPublications, publicationPaths, commitPublication } from '../publication.ts';
import { sampleDirectory, datasetTasks, datasetAlias } from '../layout.ts';
import { writeCanonicalJson } from '../file-store.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { resolveOwnedPath } from '../config.ts';
import type { FlowmatePaths, SourceConfig } from '../contracts.ts';
import { canonicalJson, hashCanonical, withRunLock } from '../engine-bridge.ts';
import { createDownloader, type DownloadReceipt } from '../downloader.ts';
import { installImmutableFile, sha256File, type SupportedMimeType } from '../file-store.ts';
import { loadSampleRecords, saveSampleRecord } from '../task-store.ts';
import { assertRevision, createSourceHttp, metadataScope, resolveHuggingFaceRevision, type SourceTransport } from './dataset-records.ts';

type JsonObject = Record<string, unknown>;
export interface Voxel51Record {
  source_record_id: string;
  image_path: string;
  annotation_locator: string;
  raw: JsonObject;
  annotated: boolean;
}
export interface SelectedVoxel51Record {
  sample_id: string;
  source_record_id: string;
  image_path: string;
  annotation_locator: string;
  annotation_sha256: string;
}
export interface Voxel51Selection {
  revision: string;
  records: SelectedVoxel51Record[];
  selection_hash: string;
}
interface StoredSelection extends Voxel51Selection {
  schema_version: 1;
  source_id: string;
  dataset_id: string;
  selection_id: string;
  index_url: string;
  index_sha256: string;
}

function fail(code: string): never { throw new Error(code); }
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

export function assertVoxel51AcquireLimit(config: SourceConfig, limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) fail('VOXEL51_INVALID_LIMIT');
  if (config.record_count !== undefined && limit > config.record_count) fail('VOXEL51_LIMIT_EXCEEDS_TOTAL_RECORDS');
  if (config.annotated_record_count !== undefined && limit > config.annotated_record_count) fail('VOXEL51_LIMIT_EXCEEDS_ANNOTATED_RECORDS');
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
    let annotated = false;
    if (typeof raw.json_annotation === 'string' && raw.json_annotation.trim()) {
      try {
        const annotation = JSON.parse(raw.json_annotation);
        annotated = annotation !== null && typeof annotation === 'object' && !Array.isArray(annotation) && Object.keys(annotation).length > 0;
      } catch { /* An invalid publisher annotation is not eligible for selection. */ }
    }
    return { source_record_id: id, image_path: safeImagePath(raw.filepath), annotation_locator: `/samples/${index}`, raw, annotated };
  });
}

export function selectVoxel51(records: readonly Voxel51Record[], options: { limit: number; revision: string }): Voxel51Selection {
  assertRevision(options.revision);
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) return fail('VOXEL51_INVALID_LIMIT');
  const selected = records.filter(record => record.annotated).sort((a, b) => a.source_record_id < b.source_record_id ? -1 : a.source_record_id > b.source_record_id ? 1 : 0).slice(0, options.limit);
  if (selected.length !== options.limit) return fail('VOXEL51_INSUFFICIENT_ANNOTATED_RECORDS');
  const content = {
    revision: options.revision,
    records: selected.map(record => ({
      sample_id: String(selected.indexOf(record) + 1).padStart(6, '0'), source_record_id: record.source_record_id,
      image_path: record.image_path, annotation_locator: record.annotation_locator, annotation_sha256: hashCanonical(record.raw),
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
  return { source_id: config.source_id, revision, index_url: index.index_url, index_sha256: index.index_sha256, record_count: index.records.length, annotated_count: index.records.filter(record => record.annotated).length, redirect_chain: transport.redirect_chain };
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

function checkSelection(bytes: Uint8Array, config: SourceConfig, selectionId: string, limit: number): StoredSelection {
  const value = object(JSON.parse(Buffer.from(bytes).toString('utf8')));
  const { selection_hash, ...content } = value;
  if (selection_hash !== hashCanonical(content) || value.schema_version !== 1 || value.source_id !== config.source_id || value.dataset_id !== config.dataset_id || value.selection_id !== selectionId || !Array.isArray(value.records)) return fail('VOXEL51_SELECTION_INVALID');
  if (value.records.length !== limit) return fail('SELECTION_LIMIT_CONFLICT');
  if (typeof value.revision !== 'string') return fail('VOXEL51_SELECTION_INVALID');
  assertRevision(value.revision);
  if (value.index_url !== fileUrl(config, value.revision, config.record_locator!.index_path)) return fail('VOXEL51_SELECTION_INVALID');
  return value as unknown as StoredSelection;
}

export async function acquireVoxel51Selection(options: {
  paths: FlowmatePaths; config: SourceConfig; selectionId: string; limit: number; transport?: SourceTransport;
}): Promise<{ added: number; reused: number; selection_hash: string; revision: string }> {
  return withRunLock(resolveOwnedPath(options.paths.dataRoot, 'work/run.lock'), () => acquireVoxel51SelectionUnlocked(options), { jobId: `flowmate-acquire-${options.selectionId}` });
}

async function acquireVoxel51SelectionUnlocked(options: {
  paths: FlowmatePaths; config: SourceConfig; selectionId: string; limit: number; transport?: SourceTransport;
}): Promise<{ added: number; reused: number; selection_hash: string; revision: string }> {
  const { paths, config, selectionId, limit } = options;
  await recoverPublications(paths);
  safeId(selectionId);
  if (!config.dataset_id) return fail('VOXEL51_MISSING_DATASET_ID');
  if (config.dataset_id !== 'voxel51-hq-invoice-ocr' || config.source_id !== 'voxel51-invoice-ocr') return fail('VOXEL51_SOURCE_IDENTITY_MISMATCH');
  safeId(config.dataset_id);
  assertVoxel51AcquireLimit(config, limit);
  if (config.retention !== 'allowed' || config.local_use !== 'allowed') return fail('VOXEL51_LOCAL_USE_NOT_ALLOWED');
  const transport = options.transport ?? createSourceHttp(config);
  const base = datasetTasks(config.dataset_id);
  const data = (path: string) => resolveOwnedPath(paths.dataRoot, `${base}/${path}`);
  const originals = (path: string) => resolveOwnedPath(paths.originalRoot, path);
  const selectionPath = data(`selections/${selectionId}.json`);
  const indexPath = data(`selections/${selectionId}.index.json`);
  const saved = await optionalBytes(selectionPath);
  let selection: StoredSelection;
  let records: Voxel51Record[];
  if (saved) {
    selection = checkSelection(saved, config, selectionId, limit);
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
  } else {
    const revision = await resolveHuggingFaceRevision(config, { http: transport.http });
    const index = await readIndex(config, revision, transport);
    const selected = selectVoxel51(index.records, { limit, revision });
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
    // Recover the old cache-first ordering: without a manifest, this cache has no committed identity.
    // Remove it before committing intent so a crash cannot bind an old cache to a new revision.
    await unlink(indexPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await immutableBytes(selectionPath, Buffer.from(canonicalJson(selection)));
    await immutableBytes(indexPath, index.bytes);
    records = index.records;
  }
  const registry = JSON.parse((await readFile(data('ids.json'))).toString('utf8')) as { ids: Record<string, string> };
  const byLocator = new Map(records.map(record => [record.annotation_locator, record]));
  const selectedRecords = selection.records.map(entry => {
    const record = byLocator.get(entry.annotation_locator);
    if (!record || !record.annotated || record.source_record_id !== entry.source_record_id || record.image_path !== entry.image_path || hashCanonical(record.raw) !== entry.annotation_sha256 || (!/^[0-9]{6,}$/.test(entry.sample_id) || registry.ids[record.source_record_id] !== entry.sample_id)) return fail('VOXEL51_SELECTION_RECORD_MISMATCH');
    return { entry, record };
  });
  const dataset = {
    schema_version: 1, dataset_id: config.dataset_id, source_id: config.source_id, hosting_platform: 'Hugging Face',
    publisher: 'Voxel51', homepage: config.homepage, revision: selection.revision,
    ...(config.record_count === undefined ? {} : { record_count: config.record_count }),
    ...(config.annotated_record_count === undefined ? {} : { annotated_record_count: config.annotated_record_count }),
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
  for (const { entry, record } of selectedRecords) {
    const sampleBase = sampleDirectory(config.dataset_id, entry.sample_id);
    const imageName = `original${extname(entry.image_path).toLowerCase()}`;
    const originalPath = originals(`${sampleBase}/${imageName}`);
    const annotationPath = originals(`${sampleBase}/annotation.json`);
    const receiptPath = resolveOwnedPath(paths.dataRoot, `${sampleBase}/receipt.json`);
    const stableUrl = fileUrl(config, selection.revision, entry.image_path);
    const existing = existingRecords.find(item => item.sample_id === entry.sample_id);
    const originalRef = `${sampleBase}/${imageName}`;
    const annotationRef = `${sampleBase}/annotation.json`;
    if (existing && existing.dataset_revision === selection.revision) {
      if (existing.source_record_id !== entry.source_record_id || existing.original_ref.root !== 'original' || existing.original_ref.path !== originalRef || existing.annotation_ref?.root !== 'original' || existing.annotation_ref.path !== annotationRef || existing.annotation_sha256 !== entry.annotation_sha256) return fail('VOXEL51_RECORD_CONFLICT');
      if (await sha256File(originalPath) !== existing.original_sha256) return fail('VOXEL51_ORIGINAL_HASH_MISMATCH');
      if (await compactJsonFileHash(annotationPath) !== entry.annotation_sha256) return fail('VOXEL51_ANNOTATION_HASH_MISMATCH');
      const receipt: DownloadReceipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      const image = await readFile(originalPath);
      if (receipt.sha256 !== existing.original_sha256 || receipt.bytes !== image.length || receipt.stable_url !== fileUrl(config, existing.dataset_revision, entry.image_path) || receipt.mime_type !== imageMime(entry.image_path) || ![...config.allowed_origins, ...config.redirect_origins].includes(receipt.final_origin)) return fail('VOXEL51_RECEIPT_MISMATCH');
      reused += 1;
      continue;
    }
    if (existing && existing.source_record_id !== entry.source_record_id) fail('VOXEL51_RECORD_CONFLICT');
    const transaction = await publicationPaths(paths, config.dataset_id, entry.sample_id);
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
    await immutableBytes(`${stagedOriginal}/annotation.json`, Buffer.from(prettyJson(JSON.parse(canonicalJson(record.raw)))));
    await immutableBytes(`${stagedData}/receipt.json`, Buffer.from(canonicalJson(receipt)));
    const candidate = {
      schema_version: 1, sample_id: entry.sample_id, dataset_id: config.dataset_id, dataset_revision: selection.revision,
      source_record_id: entry.source_record_id, origin_kind: config.origin_kind, document_kind: config.document_kind,
      language: config.language, layout_group: null, original_ref: { root: 'original', path: originalRef },
      original_sha256: receipt.sha256, annotation_ref: { root: 'original', path: annotationRef }, annotation_sha256: entry.annotation_sha256,
      source_observations: [`${selection.index_url}#${entry.annotation_locator}`], label_kind: 'none',
      quality_status: 'not_checked', processing_status: 'downloaded', allowed_uses: ['development', 'regression'],
      created_at: existing?.created_at ?? new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const duplicate = existingRecords.find(value => value.sample_id !== entry.sample_id && value.original_sha256 === receipt.sha256);
    await writeCanonicalJson(`${stagedData}/record.json`, { ...candidate, ...(duplicate ? { duplicate_of: duplicate.sample_id } : {}) });
    await commitPublication(paths, config.dataset_id, entry.sample_id, async directory => {
      if (await Bun.file(`${directory}/record.json`).exists()) {
        const stored = JSON.parse(await readFile(`${directory}/record.json`, 'utf8'));
        if (stored.original_sha256 !== receipt.sha256 || stored.sample_id !== entry.sample_id || stored.annotation_sha256 !== entry.annotation_sha256) fail('VOXEL51_RECORD_CONFLICT');
        if (digest(await readFile(`${directory}/receipt.json`)) !== hashCanonical(receipt)) fail('VOXEL51_RECEIPT_MISMATCH');
      } else {
        if (await sha256File(`${directory}/${imageName}`) !== receipt.sha256) fail('VOXEL51_ORIGINAL_HASH_MISMATCH');
        if (await compactJsonFileHash(`${directory}/annotation.json`) !== entry.annotation_sha256) fail('VOXEL51_ANNOTATION_HASH_MISMATCH');
      }
    });
    if (existing) reused += 1; else added += 1;
  }
  return { added, reused, selection_hash: selection.selection_hash, revision: selection.revision };
}
