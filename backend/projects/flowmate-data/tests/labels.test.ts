import { sampleDirectory, datasetTasks, datasetAlias } from '../src/layout.ts';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from './fixtures/voxel51-samples.json';
import type { FlowmatePaths } from '../src/contracts.ts';
import { mapVoxel51Label, mapVoxel51Selection } from '../src/labels/voxel51.ts';
import { sha256File } from '../src/file-store.ts';
import { runCli } from '../src/cli.ts';
import { saveSampleRecord } from '../src/task-store.ts';
import { canonicalJson, hashCanonical } from '../src/engine-bridge.ts';

const roots: string[] = [];
const workbenchPath = join(import.meta.dir, 'fixtures/workbench.json');

async function paths(): Promise<FlowmatePaths> {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-labels-'));
  roots.push(root);
  return { projectRoot: root, paperEngineRoot: root, originalRoot: join(root, 'paper'), dataRoot: join(root, 'data'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function writeSelection(paths: FlowmatePaths, datasetId: string, selectionId: string, records: Array<{ sample_id: string; source_record_id: string; dataset_revision: string; annotation_sha256?: string }>, overrides: Record<string, unknown> = {}) {
  const revision = records[0]!.dataset_revision;
  const content: Record<string, unknown> = {
    schema_version: 1, source_id: 'voxel51-invoice-ocr', dataset_id: datasetId, selection_id: selectionId,
    revision, index_url: `https://huggingface.co/datasets/Voxel51/high-quality-invoice-images-for-ocr/resolve/${revision}/samples.json`, index_sha256: 'c'.repeat(64),
    records: records.map((record, index) => ({ sample_id: record.sample_id, source_record_id: record.source_record_id, image_path: `data/${index}.jpg`, annotation_locator: `/samples/${index}`, annotation_sha256: record.annotation_sha256 })),
    ...overrides,
  };
  const { selection_hash: suppliedHash, ...unsigned } = content;
  await Bun.write(join(paths.dataRoot, datasetTasks(datasetId), 'selections', `${selectionId}.json`), canonicalJson({ ...unsigned, selection_hash: typeof suppliedHash === 'string' ? suppliedHash : hashCanonical(unsigned) }));
}

test('maps only known Voxel51 annotation fields and preserves decimal strings and source pointers', () => {
  const label = mapVoxel51Label(JSON.parse(fixture.samples[0]!.json_annotation));
  expect(label.mapping_version).toBe('voxel51/1');
  expect(label.provenance.kind).toBe('dataset_annotation');
  expect(label.fields.invoice_number).toEqual({ value: 'TEST-A', source_locator: '/invoice/invoice_number', status: 'provided' });
  expect(label.fields.invoice_date).toEqual({ value: '01/01/2020', source_locator: '/invoice/invoice_date', status: 'provided' });
  expect(label.fields.buyer_name).toEqual({ value: 'CLIENT A', source_locator: '/invoice/client_name', status: 'provided' });
  expect(label.fields.seller_name).toEqual({ value: 'SELLER A', source_locator: '/invoice/seller_name', status: 'provided' });
  expect(label.fields.total_amount).toEqual({ value: '1.10', source_locator: '/subtotal/total', status: 'provided' });
  expect(label.fields.currency).toEqual({ value: null, source_locator: null, status: 'missing' });
  expect(label.fields.tax_amount).toEqual({ value: '0.10', source_locator: '/subtotal/tax', status: 'ambiguous' });
  expect(label.fields.geometry).toEqual({ value: null, source_locator: null, status: 'missing' });
  expect(label.line_items).toEqual([{ description: { value: 'ITEM A', source_locator: '/items/0/description', status: 'provided' }, quantity: { value: '1.00', source_locator: '/items/0/quantity', status: 'provided' }, total_price: { value: '1.10', source_locator: '/items/0/total_price', status: 'provided' } }]);
});

test('marks blank and unavailable fields missing without inventing a currency, tax meaning, or coordinates', () => {
  const label = mapVoxel51Label({ invoice: { invoice_number: '', seller_name: 'SELLER' }, subtotal: { tax: '' }, items: [] });
  expect(label.fields.invoice_number).toEqual({ value: null, source_locator: null, status: 'missing' });
  expect(label.fields.tax_amount).toEqual({ value: null, source_locator: null, status: 'missing' });
  expect(label.fields.currency.value).not.toBe('USD');
  expect(label.line_items).toEqual([]);
});

test('writes a versioned derived label and updates only the data-root machine record', async () => {
  const configuredPaths = await paths();
  const datasetId = 'voxel51-hq-invoice-ocr';
  const sampleId = 'sample-a';
  const annotationPath = join(configuredPaths.originalRoot, sampleDirectory(datasetId, sampleId), 'annotation.json');
  await Bun.write(annotationPath, JSON.stringify(fixture.samples[0]));
  const saved = await saveSampleRecord(configuredPaths, {
    schema_version: 1, sample_id: sampleId, dataset_id: datasetId, dataset_revision: 'a'.repeat(40), source_record_id: fixture.samples[0]!._id.$oid,
    origin_kind: 'public_redacted', document_kind: 'invoice', language: 'en', layout_group: null,
    original_ref: { root: 'original', path: `${sampleDirectory(datasetId, sampleId)}/original.jpg` }, original_sha256: 'a'.repeat(64),
    annotation_ref: { root: 'original', path: `${sampleDirectory(datasetId, sampleId)}/annotation.json` }, annotation_sha256: await sha256File(annotationPath),
    source_observations: [], label_kind: 'none', quality_status: 'not_checked', processing_status: 'downloaded', allowed_uses: ['development'], created_at: '', updated_at: '',
  });
  await writeSelection(configuredPaths, datasetId, 'initial-20', [saved]);

  const result = await mapVoxel51Selection({ paths: configuredPaths, datasetId, selectionId: 'initial-20' });
  expect(result).toMatchObject({ mapped: 1, provided: expect.any(Number), missing: expect.any(Number), ambiguous: 1 });
  const labelPath = join(configuredPaths.dataRoot, sampleDirectory(datasetId, sampleId), 'fields.json');
  const label = JSON.parse(await readFile(labelPath, 'utf8'));
  expect(label.mapping_version).toBe('voxel51/1');
  const record = JSON.parse(await readFile(join(configuredPaths.dataRoot, sampleDirectory(datasetId, sampleId), 'record.json'), 'utf8'));
  expect(record).toMatchObject({ label_ref: { root: 'data', path: `${sampleDirectory(datasetId, sampleId)}/fields.json` }, label_sha256: await sha256File(labelPath), label_kind: 'dataset_annotation', mapping_version: 'voxel51/1' });
  expect(JSON.parse(await readFile(annotationPath, 'utf8'))).toEqual(fixture.samples[0]);
  await writeFile(labelPath, JSON.stringify({ altered: true }));
  expect(await Bun.file(annotationPath).text()).toContain('TEST-A');
});

test('fails closed when the committed selection is missing, tampered, or does not match the dataset revision', async () => {
  const configuredPaths = await paths();
  const datasetId = 'voxel51-hq-invoice-ocr';
  const sampleId = 'sample-selection';
  const annotationPath = join(configuredPaths.originalRoot, sampleDirectory(datasetId, sampleId), 'annotation.json');
  await Bun.write(annotationPath, JSON.stringify(fixture.samples[0]));
  const saved = await saveSampleRecord(configuredPaths, {
    schema_version: 1, sample_id: sampleId, dataset_id: datasetId, dataset_revision: 'a'.repeat(40), source_record_id: fixture.samples[0]!._id.$oid,
    origin_kind: 'public_redacted', document_kind: 'invoice', language: 'en', layout_group: null,
    original_ref: { root: 'original', path: 'original.jpg' }, original_sha256: 'a'.repeat(64),
    annotation_ref: { root: 'original', path: `${sampleDirectory(datasetId, sampleId)}/annotation.json` }, annotation_sha256: await sha256File(annotationPath),
    source_observations: [], label_kind: 'none', quality_status: 'not_checked', processing_status: 'downloaded', allowed_uses: ['development'], created_at: '', updated_at: '',
  });
  await expect(mapVoxel51Selection({ paths: configuredPaths, datasetId, selectionId: 'initial-20' })).rejects.toThrow('VOXEL51_SELECTION_MISSING');
  await writeSelection(configuredPaths, datasetId, 'initial-20', [saved], { selection_hash: 'b'.repeat(64) });
  await expect(mapVoxel51Selection({ paths: configuredPaths, datasetId, selectionId: 'initial-20' })).rejects.toThrow('VOXEL51_SELECTION_INVALID');
  await writeSelection(configuredPaths, datasetId, 'initial-20', [saved], { revision: 'b'.repeat(40), index_url: 'https://huggingface.co/datasets/Voxel51/high-quality-invoice-images-for-ocr/resolve/' + 'b'.repeat(40) + '/samples.json' });
  await expect(mapVoxel51Selection({ paths: configuredPaths, datasetId, selectionId: 'initial-20' })).rejects.toThrow('VOXEL51_SELECTION_RECORD_MISMATCH');
  await writeSelection(configuredPaths, datasetId, 'initial-20', [saved], { dataset_id: 'other-dataset' });
  await expect(mapVoxel51Selection({ paths: configuredPaths, datasetId, selectionId: 'initial-20' })).rejects.toThrow('VOXEL51_SELECTION_INVALID');
  await writeSelection(configuredPaths, datasetId, 'initial-20', [saved], { source_id: 'other-source' });
  await expect(mapVoxel51Selection({ paths: configuredPaths, datasetId, selectionId: 'initial-20' })).rejects.toThrow('VOXEL51_SELECTION_INVALID');
  await writeSelection(configuredPaths, datasetId, 'initial-20', [saved]);
  const selectionPath = join(configuredPaths.dataRoot, datasetTasks(datasetId), 'selections', 'initial-20.json');
  const selection = JSON.parse(await Bun.file(selectionPath).text()) as { records: unknown[]; selection_hash: string } & Record<string, unknown>;
  const { selection_hash: _selectionHash, ...duplicate } = selection;
  const duplicateRecords = [...selection.records, selection.records[0]!];
  await Bun.write(selectionPath, canonicalJson({ ...duplicate, records: duplicateRecords, selection_hash: hashCanonical({ ...duplicate, records: duplicateRecords }) }));
  await expect(mapVoxel51Selection({ paths: configuredPaths, datasetId, selectionId: 'initial-20' })).rejects.toThrow('VOXEL51_SELECTION_INVALID');
});

test('maps exactly the unique sample IDs in the committed selection', async () => {
  const configuredPaths = await paths();
  const datasetId = 'voxel51-hq-invoice-ocr';
  const saved = await Promise.all(['selected', 'unselected'].map(async (sampleId, index) => {
    const annotationPath = join(configuredPaths.originalRoot, sampleDirectory(datasetId, sampleId), 'annotation.json');
    await Bun.write(annotationPath, JSON.stringify(fixture.samples[index]!));
    return saveSampleRecord(configuredPaths, {
      schema_version: 1, sample_id: sampleId, dataset_id: datasetId, dataset_revision: 'a'.repeat(40), source_record_id: fixture.samples[index]!._id.$oid,
      origin_kind: 'public_redacted', document_kind: 'invoice', language: 'en', layout_group: null,
      original_ref: { root: 'original', path: `original-${index}.jpg` }, original_sha256: `${index}`.repeat(64),
      annotation_ref: { root: 'original', path: `${sampleDirectory(datasetId, sampleId)}/annotation.json` }, annotation_sha256: await sha256File(annotationPath),
      source_observations: [], label_kind: 'none', quality_status: 'not_checked', processing_status: 'downloaded', allowed_uses: ['development'], created_at: '', updated_at: '',
    });
  }));
  await writeSelection(configuredPaths, datasetId, 'initial-20', [saved[0]!]);
  expect(await mapVoxel51Selection({ paths: configuredPaths, datasetId, selectionId: 'initial-20' })).toMatchObject({ mapped: 1, sample_ids: ['selected'] });
  expect(await Bun.file(join(configuredPaths.dataRoot, datasetAlias(datasetId), 'selected', 'fields.json')).exists()).toBe(true);
  expect(await Bun.file(join(configuredPaths.dataRoot, datasetAlias(datasetId), 'unselected', 'fields.json')).exists()).toBe(false);
});

test('CLI maps the selected Voxel51 labels and publishes only structured snapshots', async () => {
  const configuredPaths = await paths();
  const datasetId = 'voxel51-hq-invoice-ocr';
  const sampleId = 'sample-cli';
  const annotationPath = join(configuredPaths.originalRoot, sampleDirectory(datasetId, sampleId), 'annotation.json');
  await Bun.write(annotationPath, JSON.stringify(fixture.samples[1]));
  const originalPath = join(configuredPaths.originalRoot, sampleDirectory(datasetId, sampleId), 'original.jpg');
  await Bun.write(originalPath, Buffer.from([0xff, 0xd8, 0xff, 1]));
  const saved = await saveSampleRecord(configuredPaths, {
    schema_version: 1, sample_id: sampleId, dataset_id: datasetId, dataset_revision: 'a'.repeat(40), source_record_id: fixture.samples[1]!._id.$oid,
    origin_kind: 'public_redacted', document_kind: 'invoice', language: 'en', layout_group: null,
    original_ref: { root: 'original', path: `${sampleDirectory(datasetId, sampleId)}/original.jpg` }, original_sha256: await sha256File(originalPath),
    annotation_ref: { root: 'original', path: `${sampleDirectory(datasetId, sampleId)}/annotation.json` }, annotation_sha256: await sha256File(annotationPath),
    source_observations: [], label_kind: 'none', quality_status: 'not_checked', processing_status: 'downloaded', allowed_uses: ['development'], created_at: '', updated_at: '',
  });
  await writeSelection(configuredPaths, datasetId, 'initial-20', [saved]);
  const pathsFile = join(configuredPaths.projectRoot, 'paths.json');
  await writeFile(pathsFile, JSON.stringify(configuredPaths));
  const output: unknown[] = [];
  expect(await runCli(['labels', 'map', datasetId, '--selection', 'initial-20', '--publish-snapshot', '--paths', pathsFile, '--config', workbenchPath], { print: value => output.push(value) })).toBe(0);
  expect(output[0]).toMatchObject({ mapped: 1, snapshots: 1, provided: expect.any(Number), missing: expect.any(Number), ambiguous: 1 });
  expect(await Bun.file(join(configuredPaths.originalRoot, sampleDirectory(datasetId, sampleId), 'snapshot.json')).exists()).toBe(true);
});
