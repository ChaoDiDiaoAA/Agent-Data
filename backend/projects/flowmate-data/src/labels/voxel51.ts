import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveOwnedPath } from '../config.ts';
import { sha256File, writeCanonicalJson } from '../file-store.ts';
import { canonicalJson, hashCanonical, withRunLock } from '../engine-bridge.ts';
import type { FlowmatePaths } from '../contracts.ts';
import { loadSampleRecords, saveSampleRecord, type SampleRecord } from '../task-store.ts';

export const voxel51MappingVersion = 'voxel51/1' as const;
export type FieldStatus = 'provided' | 'missing' | 'ambiguous';
export interface LabelField { value: string | number | boolean | null; source_locator: string | null; status: FieldStatus }
export interface NormalizedLineItem { description: LabelField; quantity: LabelField; total_price: LabelField }
export interface NormalizedLabel {
  schema_version: 1;
  mapping_version: typeof voxel51MappingVersion;
  provenance: { kind: 'dataset_annotation'; source_format: 'voxel51/json_annotation' };
  fields: Record<'invoice_number' | 'invoice_date' | 'buyer_name' | 'buyer_address' | 'seller_name' | 'seller_address' | 'currency' | 'net_amount' | 'tax_amount' | 'tax_rate' | 'total_amount' | 'geometry', LabelField>;
  line_items: NormalizedLineItem[];
}

type JsonObject = Record<string, unknown>;

function fail(code: string): never { throw new Error(code); }
function object(value: unknown): JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) return {}; return value as JsonObject; }
function at(root: JsonObject, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}
function scalar(value: unknown): string | number | boolean | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}
function missing(): LabelField { return { value: null, source_locator: null, status: 'missing' }; }
function provided(root: JsonObject, pointer: string): LabelField {
  const value = scalar(at(root, pointer.slice(1).split('/')));
  return value === null || value === '' ? missing() : { value, source_locator: pointer, status: 'provided' };
}
function ambiguous(root: JsonObject, pointer: string): LabelField {
  const candidate = provided(root, pointer);
  return candidate.status === 'missing' ? candidate : { ...candidate, status: 'ambiguous' };
}
function embeddedAnnotation(annotation: unknown): JsonObject {
  const raw = object(annotation);
  if (typeof raw.json_annotation !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw.json_annotation);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('VOXEL51_INVALID_ANNOTATION');
    return parsed as JsonObject;
  } catch (error) {
    if (error instanceof Error && error.message === 'VOXEL51_INVALID_ANNOTATION') throw error;
    return fail('VOXEL51_INVALID_ANNOTATION');
  }
}

/** Maps only declared Voxel51 JSON annotation paths; it never parses OCR or guesses monetary semantics. */
export function mapVoxel51Label(annotation: unknown): NormalizedLabel {
  const root = embeddedAnnotation(annotation);
  const items = at(root, ['items']);
  const line_items = Array.isArray(items) ? items.map((item, index): NormalizedLineItem => {
    const row = object(item);
    return {
      description: provided(row, '/description'), quantity: provided(row, '/quantity'), total_price: provided(row, '/total_price'),
    } satisfies NormalizedLineItem;
  }).map((item, index) => ({
    description: item.description.status === 'missing' ? item.description : { ...item.description, source_locator: `/items/${index}${item.description.source_locator}` },
    quantity: item.quantity.status === 'missing' ? item.quantity : { ...item.quantity, source_locator: `/items/${index}${item.quantity.source_locator}` },
    total_price: item.total_price.status === 'missing' ? item.total_price : { ...item.total_price, source_locator: `/items/${index}${item.total_price.source_locator}` },
  })) : [];
  return {
    schema_version: 1, mapping_version: voxel51MappingVersion,
    provenance: { kind: 'dataset_annotation', source_format: 'voxel51/json_annotation' },
    fields: {
      invoice_number: provided(root, '/invoice/invoice_number'), invoice_date: provided(root, '/invoice/invoice_date'),
      buyer_name: provided(root, '/invoice/client_name'), buyer_address: provided(root, '/invoice/client_address'),
      seller_name: provided(root, '/invoice/seller_name'), seller_address: provided(root, '/invoice/seller_address'),
      currency: missing(), net_amount: missing(), tax_amount: ambiguous(root, '/subtotal/tax'), tax_rate: missing(),
      total_amount: provided(root, '/subtotal/total'), geometry: missing(),
    },
    line_items,
  };
}

function safeId(value: string): void { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail('VOXEL51_INVALID_ID'); }
function countFields(label: NormalizedLabel): Record<FieldStatus, number> {
  const result: Record<FieldStatus, number> = { provided: 0, missing: 0, ambiguous: 0 };
  const fields: LabelField[] = [...Object.values(label.fields), ...label.line_items.flatMap(item => [item.description, item.quantity, item.total_price])];
  for (const field of fields) result[field.status] += 1;
  return result;
}
function annotationPath(paths: FlowmatePaths, record: SampleRecord): string {
  if (!record.annotation_ref || record.annotation_ref.root !== 'original' || !record.annotation_sha256) return fail('VOXEL51_LABEL_ANNOTATION_MISSING');
  return resolveOwnedPath(paths.originalRoot, record.annotation_ref.path);
}

interface CommittedSelectionEntry { sample_id: string; source_record_id: string; image_path: string; annotation_locator: string; annotation_sha256: string }
const voxel51SourceId = 'voxel51-invoice-ocr';
const voxel51IndexUrl = (revision: string) => `https://huggingface.co/datasets/Voxel51/high-quality-invoice-images-for-ocr/resolve/${revision}/samples.json`;

function strictObject(value: unknown): JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('VOXEL51_SELECTION_INVALID'); return value as JsonObject; }
export function committedSelection(bytes: Uint8Array, datasetId: string, selectionId: string, records: readonly SampleRecord[]): SampleRecord[] {
  let selection: JsonObject;
  try { selection = strictObject(JSON.parse(Buffer.from(bytes).toString('utf8'))); } catch (error) { if (error instanceof Error && error.message === 'VOXEL51_SELECTION_INVALID') throw error; return fail('VOXEL51_SELECTION_INVALID'); }
  if (Buffer.from(bytes).toString('utf8') !== canonicalJson(selection)) fail('VOXEL51_SELECTION_INVALID');
  const { selection_hash, ...content } = selection;
  if (selection_hash !== hashCanonical(content) || selection.schema_version !== 1 || selection.source_id !== voxel51SourceId || selection.dataset_id !== datasetId || selection.selection_id !== selectionId || typeof selection.revision !== 'string' || !/^[a-f0-9]{40}$/.test(selection.revision) || selection.index_url !== voxel51IndexUrl(selection.revision) || typeof selection.index_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(selection.index_sha256) || !Array.isArray(selection.records) || selection.records.length === 0) fail('VOXEL51_SELECTION_INVALID');
  const known = new Map(records.map(record => [record.sample_id, record]));
  const seen = new Set<string>();
  return selection.records.map((entry): SampleRecord => {
    const value = strictObject(entry) as unknown as CommittedSelectionEntry;
    if (typeof value.sample_id !== 'string' || typeof value.source_record_id !== 'string' || typeof value.image_path !== 'string' || typeof value.annotation_locator !== 'string' || typeof value.annotation_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.annotation_sha256) || seen.has(value.sample_id)) fail('VOXEL51_SELECTION_INVALID');
    seen.add(value.sample_id);
    const record = known.get(value.sample_id);
    if (!record || record.dataset_revision !== selection.revision || record.source_record_id !== value.source_record_id || record.annotation_sha256 !== value.annotation_sha256) fail('VOXEL51_SELECTION_RECORD_MISMATCH');
    return record;
  });
}

export async function mapVoxel51Selection(input: { paths: FlowmatePaths; datasetId: string; selectionId: string; lockHeld?: boolean }): Promise<{ mapped: number; provided: number; missing: number; ambiguous: number; sample_ids: string[] }> {
  if (!input.lockHeld) return withRunLock(resolveOwnedPath(input.paths.dataRoot, 'work/run.lock'), () => mapVoxel51Selection({ ...input, lockHeld: true }), { jobId: `flowmate-labels-${input.selectionId}` });
  const { paths, datasetId, selectionId } = input;
  safeId(datasetId); safeId(selectionId);
  if (datasetId !== 'voxel51-hq-invoice-ocr') fail('VOXEL51_SOURCE_IDENTITY_MISMATCH');
  const records = await loadSampleRecords(paths, datasetId);
  const selected = resolveOwnedPath(paths.dataRoot, `datasets/${datasetId}/selections/${selectionId}.json`);
  let selectionBytes: Uint8Array;
  try {
    selectionBytes = await readFile(selected);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return fail('VOXEL51_SELECTION_MISSING');
    throw error;
  }
  const selectedRecords = committedSelection(selectionBytes, datasetId, selectionId, records);
  const totals: Record<FieldStatus, number> = { provided: 0, missing: 0, ambiguous: 0 };
  for (const record of selectedRecords) {
    const source = annotationPath(paths, record);
    if (await sha256File(source) !== record.annotation_sha256) fail('VOXEL51_ANNOTATION_HASH_MISMATCH');
    const label = mapVoxel51Label(JSON.parse(await readFile(source, 'utf8')));
    const relativeLabel = `datasets/${datasetId}/samples/${record.sample_id}/label.json`;
    const labelPath = resolveOwnedPath(paths.dataRoot, relativeLabel);
    await writeCanonicalJson(labelPath, label);
    const labelSha = await sha256File(labelPath);
    await saveSampleRecord(paths, { ...record, label_ref: { root: 'data', path: relativeLabel }, label_sha256: labelSha, label_kind: 'dataset_annotation', mapping_version: voxel51MappingVersion });
    const counts = countFields(label);
    for (const status of ['provided', 'missing', 'ambiguous'] as const) totals[status] += counts[status];
  }
  return { mapped: selectedRecords.length, ...totals, sample_ids: selectedRecords.map(record => record.sample_id) };
}
