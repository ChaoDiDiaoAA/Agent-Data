import { afterEach, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowmatePaths } from '../src/contracts.ts';
import { sha256File } from '../src/file-store.ts';
import { publishStructuredSnapshot, recoverStructuredSnapshot, verifyStructuredSnapshot } from '../src/structured-snapshot.ts';
import { saveSampleRecord } from '../src/task-store.ts';
import { canonicalJson, createFlowmateMinerURuntime, parseInvoice } from '../src/engine-bridge.ts';

const roots: string[] = [];

async function fixturePaths(): Promise<FlowmatePaths> {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-snapshot-'));
  roots.push(root);
  return { projectRoot: root, paperEngineRoot: root, originalRoot: join(root, 'paper'), dataRoot: join(root, 'data'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') };
}

async function source(paths: FlowmatePaths) {
  const datasetId = 'voxel51-hq-invoice-ocr';
  const sampleId = 'sample-a';
  const label = { schema_version: 1, mapping_version: 'voxel51/1', provenance: { kind: 'dataset_annotation' }, fields: {} };
  const labelPath = join(paths.dataRoot, 'datasets', datasetId, 'samples', sampleId, 'label.json');
  await Bun.write(labelPath, JSON.stringify(label) + '\n');
  await saveSampleRecord(paths, {
    schema_version: 1, sample_id: sampleId, dataset_id: datasetId, dataset_revision: 'a'.repeat(40), source_record_id: 'source-a',
    origin_kind: 'public_redacted', document_kind: 'invoice', language: 'en', layout_group: null,
    original_ref: { root: 'original', path: 'original.jpg' }, original_sha256: 'a'.repeat(64), source_observations: [],
    label_ref: { root: 'data', path: `datasets/${datasetId}/samples/${sampleId}/label.json` }, label_sha256: await sha256File(labelPath), label_kind: 'dataset_annotation', mapping_version: 'voxel51/1',
    quality_status: 'not_checked', processing_status: 'downloaded', allowed_uses: ['development'], created_at: '', updated_at: '',
  });
  return { datasetId, sampleId, labelPath };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('publishes a byte-stable label-only snapshot from verified data-root records', async () => {
  const paths = await fixturePaths();
  const { datasetId, sampleId } = await source(paths);
  const first = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  expect(await verifyStructuredSnapshot(first.snapshot_path)).toMatchObject({ label_sha256: expect.any(String), files: expect.arrayContaining([expect.objectContaining({ path: 'label.json' }), expect.objectContaining({ path: 'record.json' })]) });
  const firstBytes = await readFile(join(first.snapshot_path, 'snapshot.json'));
  await publishStructuredSnapshot({ paths, datasetId, sampleId });
  expect(await readFile(join(first.snapshot_path, 'snapshot.json'))).toEqual(firstBytes);
  expect(first.snapshot_path).toBe(join(paths.originalRoot, 'datasets', datasetId, 'samples', sampleId, 'structured'));
});

test('detects mirror edits and recovers an interrupted swap from a valid previous snapshot without modifying the source record', async () => {
  const paths = await fixturePaths();
  const { datasetId, sampleId, labelPath } = await source(paths);
  const { snapshot_path } = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  const sourceRecordPath = join(paths.dataRoot, 'datasets', datasetId, 'samples', sampleId, 'record.json');
  const sourceRecord = await readFile(sourceRecordPath);
  await writeFile(join(snapshot_path, 'label.json'), '{"tampered":true}\n');
  await expect(verifyStructuredSnapshot(snapshot_path)).rejects.toThrow('SNAPSHOT_FILE_HASH_MISMATCH');
  expect(await readFile(sourceRecordPath)).toEqual(sourceRecord);
  expect(await Bun.file(labelPath).text()).not.toContain('tampered');

  const previous = `${snapshot_path}.previous`;
  await rename(snapshot_path, previous);
  await publishStructuredSnapshot({ paths, datasetId, sampleId });
  await expect(verifyStructuredSnapshot(snapshot_path)).resolves.toMatchObject({ schema_version: 1 });
  expect(await Bun.file(previous).exists()).toBe(false);
});

test('restores a verified previous snapshot when the current structured directory is corrupt', async () => {
  const paths = await fixturePaths();
  const { datasetId, sampleId } = await source(paths);
  const { snapshot_path } = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  const previous = `${snapshot_path}.previous`;
  await rename(snapshot_path, previous);
  await Bun.write(join(snapshot_path, 'snapshot.json'), '{"corrupt":true}\n');
  await recoverStructuredSnapshot(snapshot_path);
  await expect(verifyStructuredSnapshot(snapshot_path)).resolves.toMatchObject({ schema_version: 1 });
  expect(await Bun.file(previous).exists()).toBe(false);
});

test('refuses a label whose source hash or ref is not verified from dataRoot', async () => {
  const paths = await fixturePaths();
  const { datasetId, sampleId } = await source(paths);
  const recordPath = join(paths.dataRoot, 'datasets', datasetId, 'samples', sampleId, 'record.json');
  const record = JSON.parse(await Bun.file(recordPath).text());
  await writeFile(recordPath, JSON.stringify({ ...record, label_sha256: 'b'.repeat(64) }));
  await expect(publishStructuredSnapshot({ paths, datasetId, sampleId })).rejects.toThrow('SNAPSHOT_LABEL_HASH_MISMATCH');
});

async function parsedSource(paths: FlowmatePaths, label = true) {
  const identifiers = await source(paths);
  const recordPath = join(paths.dataRoot, 'datasets', identifiers.datasetId, 'samples', identifiers.sampleId, 'record.json');
  const original = JSON.parse(await readFile(recordPath, 'utf8'));
  paths.paperEngineRoot = join(import.meta.dir, '../../paper-knowledge-engine');
  const receipt = await parseInvoice({ ...createFlowmateMinerURuntime(paths), sampleId: identifiers.sampleId,
    sourcePath: join(import.meta.dir, 'fixtures/invoice.pdf'),
    outputDir: join(paths.dataRoot, 'datasets', identifiers.datasetId, 'samples', identifiers.sampleId, 'parsed'),
  }, { createSession: () => ({ async ensureReady() { return 'fake'; }, async run(job) { await cp(join(import.meta.dir, 'fixtures/mineru-output'), job.outputDir, { recursive: true }); return { exitCode: 0 }; }, async dispose() {} }) });
  const selected = { ...original, original_sha256: receipt.originalSha256, parser_key: receipt.parserKey, parse_attempt_id: receipt.attemptId, content_sha256: receipt.contentHash,
    derived_ref: { root: 'data', path: `datasets/${identifiers.datasetId}/samples/${identifiers.sampleId}/parsed/${receipt.attemptId}/normalized` } };
  if (!label) { selected.label_kind = 'none'; selected.document_kind = 'knowledge'; delete selected.label_ref; delete selected.label_sha256; delete selected.mapping_version; }
  await saveSampleRecord(paths, selected);
  return { ...identifiers, receipt, recordPath };
}

test('mirrors the selected attempt with all normalized files, referenced assets and hashes', async () => {
  const paths = await fixturePaths(); const { datasetId, sampleId, receipt } = await parsedSource(paths);
  const result = await publishStructuredSnapshot({ paths, datasetId, sampleId, parsed: receipt });
  expect(result.snapshot).toMatchObject({ parser_key: receipt.parserKey, parse_attempt_id: receipt.attemptId, content_sha256: receipt.contentHash });
  for (const file of receipt.files) {
    const name = `parsed/${receipt.attemptId}/normalized/${file.path}`;
    expect(result.snapshot.files).toContainEqual({ ...file, path: name });
    expect(await readFile(join(result.snapshot_path, name))).toEqual(await readFile(join(receipt.normalizedDir, file.path)));
  }
  await expect(verifyStructuredSnapshot(result.snapshot_path)).resolves.toMatchObject({ content_sha256: receipt.contentHash });
  await writeFile(join(result.snapshot_path, `parsed/${receipt.attemptId}/normalized/assets/images/invoice.png`), 'corrupt');
  await expect(verifyStructuredSnapshot(result.snapshot_path)).rejects.toThrow('SNAPSHOT_FILE_HASH_MISMATCH');
});

test('refuses a caller attempt or record-derived path that differs from the selected attempt', async () => {
  const paths = await fixturePaths(); const { datasetId, sampleId, receipt, recordPath } = await parsedSource(paths);
  await expect(publishStructuredSnapshot({ paths, datasetId, sampleId, parsed: { ...receipt, attemptId: 'attempt-other' } })).rejects.toThrow('SNAPSHOT_ATTEMPT_MISMATCH');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, JSON.stringify({ ...record, derived_ref: { root: 'data', path: 'work/unselected/normalized' } }));
  await expect(publishStructuredSnapshot({ paths, datasetId, sampleId })).rejects.toThrow('SNAPSHOT_ATTEMPT_MISMATCH');
});

test('knowledge without labels omits label.json and still verifies selected parsed content', async () => {
  const paths = await fixturePaths(); const { datasetId, sampleId, receipt, recordPath } = await parsedSource(paths, false);
  const result = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  expect(await Bun.file(join(result.snapshot_path, 'label.json')).exists()).toBe(false);
  expect(result.snapshot.label_sha256).toBeUndefined();
  await expect(verifyStructuredSnapshot(result.snapshot_path)).resolves.toMatchObject({ content_sha256: receipt.contentHash });
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, JSON.stringify({ ...record, content_sha256: 'f'.repeat(64) }));
  await expect(publishStructuredSnapshot({ paths, datasetId, sampleId })).rejects.toThrow('SNAPSHOT_CONTENT_HASH_MISMATCH');
});

test('rejects a parsed asset altered after the parse receipt was committed', async () => {
  const paths = await fixturePaths(); const { datasetId, sampleId, receipt } = await parsedSource(paths);
  await writeFile(join(receipt.normalizedDir, 'assets/images/invoice.png'), 'altered source asset');
  await expect(publishStructuredSnapshot({ paths, datasetId, sampleId })).rejects.toThrow('SNAPSHOT_FILE_HASH_MISMATCH');
});

for (const startedAt of ['this-is-not-a-date', '2026-02-30T00:00:00.000Z', '2020-01-01T00:00:00.000Z']) {
  test(`rejects receipt startedAt ${startedAt} instead of trusting its attemptId`, async () => {
    const paths = await fixturePaths(); const { datasetId, sampleId, receipt } = await parsedSource(paths);
    await writeFile(join(receipt.outputDir, 'receipt.json'), canonicalJson({ ...receipt, startedAt }));
    await expect(publishStructuredSnapshot({ paths, datasetId, sampleId })).rejects.toThrow('SNAPSHOT_ATTEMPT_MISMATCH');
  });
}

test('rejects invalid or different caller receipt startedAt even when the stored receipt is valid', async () => {
  const paths = await fixturePaths(); const { datasetId, sampleId, receipt } = await parsedSource(paths);
  await expect(publishStructuredSnapshot({ paths, datasetId, sampleId, parsed: { ...receipt, startedAt: 'this-is-not-a-date' } })).rejects.toThrow('SNAPSHOT_ATTEMPT_MISMATCH');
});

test('snapshot verification independently validates its frozen start time and recomputes attempt identity', async () => {
  const paths = await fixturePaths(); const { datasetId, sampleId, receipt } = await parsedSource(paths);
  const result = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  for (const startedAt of [undefined, 'this-is-not-a-date', '2026-02-30T00:00:00.000Z', '2020-01-01T00:00:00.000Z']) {
    const changed = { ...result.snapshot, parse_started_at: startedAt };
    if (startedAt === undefined) delete changed.parse_started_at;
    await writeFile(join(result.snapshot_path, 'snapshot.json'), canonicalJson(changed));
    await expect(verifyStructuredSnapshot(result.snapshot_path)).rejects.toThrow('SNAPSHOT_ATTEMPT_MISMATCH');
  }
  expect(result.snapshot.parse_started_at).toBe(receipt.startedAt);
});

test('rejects a coherently changed parser key in both source provenance and the standalone snapshot', async () => {
  const paths = await fixturePaths(); const { datasetId, sampleId, receipt, recordPath } = await parsedSource(paths);
  const result = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  const original = JSON.parse(await readFile(recordPath, 'utf8'));
  const parserKey = 'mineru@3.4.5';
  await writeFile(recordPath, canonicalJson({ ...original, parser_key: parserKey }));
  await writeFile(join(receipt.outputDir, 'receipt.json'), canonicalJson({ ...receipt, parserKey }));
  await expect(publishStructuredSnapshot({ paths, datasetId, sampleId })).rejects.toThrow('SNAPSHOT_ATTEMPT_MISMATCH');

  const mirrorRecord = join(result.snapshot_path, 'record.json');
  const bytes = Buffer.from(canonicalJson({ ...original, parser_key: parserKey }));
  await writeFile(mirrorRecord, bytes);
  const sha256 = await sha256File(mirrorRecord);
  await writeFile(join(result.snapshot_path, 'snapshot.json'), canonicalJson({ ...result.snapshot, parser_key: parserKey, record_sha256: sha256,
    files: result.snapshot.files.map(file => file.path === 'record.json' ? { ...file, sha256, bytes: bytes.length } : file) }));
  await expect(verifyStructuredSnapshot(result.snapshot_path)).rejects.toThrow('SNAPSHOT_ATTEMPT_MISMATCH');
});
