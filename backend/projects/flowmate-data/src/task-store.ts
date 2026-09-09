import { sampleDirectory, datasetTasks } from './layout.ts';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveOwnedPath } from './config.ts';
import { canonicalJson } from './engine-bridge.ts';
import { writeCanonicalJson } from './file-store.ts';
import type { DocumentKind, FlowmatePaths, OriginKind } from './contracts.ts';

export type LabelKind = 'none' | 'dataset_annotation' | 'human_reviewed';
export type ProcessingStatus = 'selected' | 'downloaded' | 'processed' | 'cataloged' | 'completed' | 'failed';
export type TaskStatus = 'selected' | 'downloaded' | 'processed' | 'cataloged' | 'partial' | 'completed' | 'failed';

export interface FileRef {
  root: 'original' | 'data';
  path: string;
}

export interface SampleRecord {
  schema_version: 1;
  sample_id: string;
  dataset_id: string;
  dataset_revision: string;
  source_record_id: string;
  origin_kind: OriginKind;
  document_kind: DocumentKind;
  language: string;
  layout_group: string | null;
  original_ref: FileRef;
  original_sha256: string;
  annotation_ref?: FileRef;
  annotation_sha256?: string;
  source_observations: string[];
  label_ref?: FileRef;
  label_sha256?: string;
  label_kind: LabelKind;
  mapping_version?: string;
  derived_ref?: FileRef;
  parser_key?: string;
  parse_attempt_id?: string;
  content_sha256?: string;
  duplicate_of?: string;
  quality_status: 'not_checked' | 'usable' | 'invalid';
  processing_status: ProcessingStatus;
  last_success_status?: Exclude<ProcessingStatus, 'failed'>;
  allowed_uses: Array<'development' | 'regression'>;
  created_at: string;
  updated_at: string;
}

const progress: readonly Exclude<ProcessingStatus, 'failed'>[] = ['selected', 'downloaded', 'processed', 'cataloged', 'completed'];

function fail(code: string): never {
  throw new Error(code);
}

function recordsDirectory(paths: FlowmatePaths, datasetId: string): string {
  return resolveOwnedPath(paths.dataRoot, `${sampleDirectory(datasetId, "placeholder").split("/")[0]}`);
}

function recordPath(paths: FlowmatePaths, record: Pick<SampleRecord, 'dataset_id' | 'sample_id'>): string {
  return resolveOwnedPath(paths.dataRoot, `${sampleDirectory(record.dataset_id, record.sample_id)}/record.json`);
}

function recordFromJson(value: unknown): SampleRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SAMPLE_RECORD');
  return value as SampleRecord;
}

function comparable(record: SampleRecord): Omit<SampleRecord, 'created_at' | 'updated_at'> {
  const { created_at: _createdAt, updated_at: _updatedAt, ...content } = record;
  return content;
}

export async function loadSampleRecords(paths: FlowmatePaths, datasetId: string): Promise<SampleRecord[]> {
  const directory = recordsDirectory(paths, datasetId);
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const path = resolveOwnedPath(paths.dataRoot, `${sampleDirectory(datasetId, entry.name)}/record.json`);
    try { return recordFromJson(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }));
  return records.filter((record): record is SampleRecord => record !== undefined).sort((left, right) => left.sample_id.localeCompare(right.sample_id));
}

export async function saveSampleRecord(paths: FlowmatePaths, input: SampleRecord): Promise<SampleRecord> {
  const path = recordPath(paths, input);
  const existingRecords = await loadSampleRecords(paths, input.dataset_id);
  const existing = existingRecords.find(record => record.sample_id === input.sample_id);
  const duplicate = existingRecords.find(record => record.sample_id !== input.sample_id && record.original_sha256 === input.original_sha256);
  const { duplicate_of: _duplicateOf, created_at: _createdAt, updated_at: _updatedAt, ...content } = input;
  const base: Omit<SampleRecord, 'created_at' | 'updated_at'> = {
    ...content,
    ...(duplicate ? { duplicate_of: duplicate.sample_id } : {}),
  };
  if (existing && canonicalJson(comparable(existing)) === canonicalJson(base)) {
    return { ...base, created_at: existing.created_at, updated_at: existing.updated_at };
  }
  const now = new Date().toISOString();
  const candidate: SampleRecord = { ...base, created_at: existing?.created_at ?? now, updated_at: now };
  await mkdir(join(path, '..'), { recursive: true });
  await writeCanonicalJson(path, candidate);
  return candidate;
}

export function transitionSample(record: SampleRecord, next: ProcessingStatus): SampleRecord {
  if (next === 'failed') {
    return { ...record, processing_status: 'failed', last_success_status: record.processing_status === 'failed' ? record.last_success_status : record.processing_status };
  }
  const current = record.processing_status === 'failed' ? record.last_success_status ?? 'selected' : record.processing_status;
  if (next !== current && progress.indexOf(next) !== progress.indexOf(current) + 1) fail('INVALID_SAMPLE_TRANSITION');
  const { last_success_status: _lastSuccessStatus, ...resumed } = record;
  return { ...resumed, processing_status: next };
}

export function summarizeTask(samples: readonly SampleRecord[]): TaskStatus {
  if (samples.length === 0) return 'selected';
  const statuses = samples.map(sample => sample.processing_status);
  if (statuses.every(status => status === 'failed')) return 'failed';
  if (statuses.some(status => status === 'failed')) return 'partial';
  if (statuses.every(status => status === 'completed')) return 'completed';
  return progress.find(status => statuses.some(current => current === status)) ?? 'selected';
}
