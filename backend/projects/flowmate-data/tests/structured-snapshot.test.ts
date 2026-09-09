import { prettyJson } from '../src/readable-json.ts';
import { sampleDirectory, datasetTasks, datasetAlias } from '../src/layout.ts';
import { afterEach, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  await mkdir(join(root, 'config'), { recursive: true });
  await cp(join(import.meta.dir, 'fixtures/mineru.local.json'), join(root, 'config/mineru.local.json'));
  return { projectRoot: root, paperEngineRoot: root, originalRoot: join(root, 'paper'), dataRoot: join(root, 'data'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') };
}

async function source(paths: FlowmatePaths) {
  const datasetId = 'voxel51-hq-invoice-ocr';
  const sampleId = 'sample-a';
  const label = { schema_version: 1, mapping_version: 'voxel51/1', provenance: { kind: 'dataset_annotation' }, fields: {} };
  const labelPath = join(paths.dataRoot, sampleDirectory(datasetId, sampleId), 'fields.json');
  await Bun.write(labelPath, JSON.stringify(label) + '\n');
  const originalPath = join(paths.originalRoot, sampleDirectory(datasetId, sampleId), 'original.pdf');
  await Bun.write(originalPath, await readFile(join(import.meta.dir, 'fixtures/invoice.pdf')));
  await saveSampleRecord(paths, {
    schema_version: 1, sample_id: sampleId, dataset_id: datasetId, dataset_revision: 'a'.repeat(40), source_record_id: 'source-a',
    origin_kind: 'public_redacted', document_kind: 'invoice', language: 'en', layout_group: null,
    original_ref: { root: 'original', path: `${sampleDirectory(datasetId, sampleId)}/original.pdf` }, original_sha256: await sha256File(originalPath), source_observations: [],
    label_ref: { root: 'data', path: `${sampleDirectory(datasetId, sampleId)}/fields.json` }, label_sha256: await sha256File(labelPath), label_kind: 'dataset_annotation', mapping_version: 'voxel51/1',
    quality_status: 'not_checked', processing_status: 'downloaded', allowed_uses: ['development'], created_at: '', updated_at: '',
  });
  return { datasetId, sampleId, labelPath };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('publishes a byte-stable label-only snapshot from verified data-root records', async () => {
  const paths = await fixturePaths();
  const { datasetId, sampleId } = await source(paths);
  const first = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  expect(await verifyStructuredSnapshot(first.snapshot_path)).toMatchObject({ label_sha256: expect.any(String), files: expect.arrayContaining([expect.objectContaining({ path: 'fields.json' }), expect.objectContaining({ path: 'record.json' })]) });
  const firstBytes = await readFile(join(first.snapshot_path, 'snapshot.json'));
  await publishStructuredSnapshot({ paths, datasetId, sampleId });
  expect(await readFile(join(first.snapshot_path, 'snapshot.json'))).toEqual(firstBytes);
  expect(first.snapshot_path).toBe(join(paths.originalRoot, sampleDirectory(datasetId, sampleId)));
});

test('detects mirror edits and recovers an interrupted swap from a valid previous snapshot without modifying the source record', async () => {
  const paths = await fixturePaths();
  const { datasetId, sampleId, labelPath } = await source(paths);
  const { snapshot_path } = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  const sourceRecordPath = join(paths.dataRoot, sampleDirectory(datasetId, sampleId), 'record.json');
  const sourceRecord = await readFile(sourceRecordPath);
  await writeFile(join(snapshot_path, 'fields.json'), '{"tampered":true}\n');
  await expect(verifyStructuredSnapshot(snapshot_path)).rejects.toThrow('SNAPSHOT_FILE_HASH_MISMATCH');
  expect(await readFile(sourceRecordPath)).toEqual(sourceRecord);
  expect(await Bun.file(labelPath).text()).not.toContain('tampered');

  const previous = `${snapshot_path}.previous`;
  await writeFile(join(snapshot_path, 'fields.json'), prettyJson(JSON.parse(await readFile(labelPath, 'utf8'))));
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
  const recordPath = join(paths.dataRoot, sampleDirectory(datasetId, sampleId), 'record.json');
  const record = JSON.parse(await Bun.file(recordPath).text());
  await writeFile(recordPath, JSON.stringify({ ...record, label_sha256: 'b'.repeat(64) }));
  await expect(publishStructuredSnapshot({ paths, datasetId, sampleId })).rejects.toThrow('SNAPSHOT_LABEL_HASH_MISMATCH');
});

async function parsedSource(paths: FlowmatePaths, label = true) {
  const identifiers = await source(paths);
  const recordPath = join(paths.dataRoot, sampleDirectory(identifiers.datasetId, identifiers.sampleId), 'record.json');
  const original = JSON.parse(await readFile(recordPath, 'utf8'));
  paths.paperEngineRoot = join(import.meta.dir, '../../paper-knowledge-engine');
  const receipt = await parseInvoice({ ...createFlowmateMinerURuntime(paths), sampleId: identifiers.sampleId,
    sourcePath: join(import.meta.dir, 'fixtures/invoice.pdf'),
    outputDir: join(paths.dataRoot, 'work/p', identifiers.sampleId),
  }, { createSession: () => ({ async ensureReady() { return 'fake'; }, async run(job) { await cp(join(import.meta.dir, 'fixtures/mineru-output'), job.outputDir, { recursive: true }); return { exitCode: 0 }; }, async dispose() {} }) });
  const selected = { ...original, original_sha256: receipt.originalSha256, parser_key: receipt.parserKey, parse_attempt_id: receipt.attemptId, content_sha256: receipt.contentHash,
    derived_ref: { root: 'data', path: `${sampleDirectory(identifiers.datasetId, identifiers.sampleId)}` } };
  if (!label) { selected.label_kind = 'none'; selected.document_kind = 'knowledge'; delete selected.label_ref; delete selected.label_sha256; delete selected.mapping_version; }
  await saveSampleRecord(paths, selected);
  await Bun.write(join(paths.dataRoot, sampleDirectory(identifiers.datasetId, identifiers.sampleId), 'parse.json'), canonicalJson(receipt));
  return { ...identifiers, receipt, recordPath };
}

test('mirrors the selected attempt with all normalized files, referenced assets and hashes', async () => {
  const paths = await fixturePaths(); const { datasetId, sampleId, receipt } = await parsedSource(paths);
  const result = await publishStructuredSnapshot({ paths, datasetId, sampleId, parsed: receipt });
  expect(result.snapshot).toMatchObject({ parser_key: receipt.parserKey, parse_attempt_id: receipt.attemptId, content_sha256: receipt.contentHash });
  for (const file of receipt.files.filter(file => file.path !== 'page-marked.txt')) {
    const name = file.path === 'full.md' ? 'content.md' : file.path === 'content-list.json' ? 'content.json' : file.path;
    expect(result.snapshot.files).toContainEqual({ ...file, path: name });
    expect(await readFile(join(result.snapshot_path, name))).toEqual(await readFile(join(receipt.normalizedDir, file.path)));
    if (file.path.endsWith('.json')) {
      const text = await readFile(join(result.snapshot_path, name), 'utf8');
      expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + '\n');
    }
  }
  await expect(verifyStructuredSnapshot(result.snapshot_path)).resolves.toMatchObject({ content_sha256: receipt.contentHash });
  await writeFile(join(result.snapshot_path, 'assets/images/invoice.png'), 'corrupt');
  await expect(verifyStructuredSnapshot(result.snapshot_path)).rejects.toThrow('SNAPSHOT_FILE_HASH_MISMATCH');
});

test('refuses a caller attempt or record-derived path that differs from the selected attempt', async () => {
  const paths = await fixturePaths(); const { datasetId, sampleId, receipt, recordPath } = await parsedSource(paths);
  await expect(publishStructuredSnapshot({ paths, datasetId, sampleId, parsed: { ...receipt, attemptId: 'attempt-other' } })).rejects.toThrow('SNAPSHOT_ATTEMPT_MISMATCH');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, JSON.stringify({ ...record, derived_ref: { root: 'data', path: 'work/unselected/normalized' } }));
  await expect(publishStructuredSnapshot({ paths, datasetId, sampleId })).rejects.toThrow('SNAPSHOT_ATTEMPT_MISMATCH');
});

test('knowledge without labels omits fields.json and still verifies selected parsed content', async () => {
  const paths = await fixturePaths(); const { datasetId, sampleId, receipt, recordPath } = await parsedSource(paths, false);
  const result = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  expect(await Bun.file(join(result.snapshot_path, 'fields.json')).exists()).toBe(false);
  expect(result.snapshot.label_sha256).toBeUndefined();
  await expect(verifyStructuredSnapshot(result.snapshot_path)).resolves.toMatchObject({ content_sha256: receipt.contentHash });
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, JSON.stringify({ ...record, content_sha256: 'f'.repeat(64) }));
  await expect(publishStructuredSnapshot({ paths, datasetId, sampleId })).rejects.toThrow('SNAPSHOT_ATTEMPT_MISMATCH');
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


test('reads legacy compact snapshots and republishes pretty JSON without changing source identities', async () => {
  const paths = await fixturePaths();
  const { datasetId, sampleId } = await source(paths);
  const published = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  const machine = join(paths.dataRoot, sampleDirectory(datasetId, sampleId));
  const original = published.snapshot_path;
  const recordBefore = await readFile(join(machine, 'record.json'));
  const labelBefore = await readFile(join(machine, 'fields.json'));
  const { json_format: _format, ...legacy } = published.snapshot;
  for (const file of legacy.files) {
    if (file.path.endsWith('.json')) await writeFile(join(original, file.path), await readFile(join(machine, file.path)));
    file.sha256 = await sha256File(join(original, file.path));
    file.bytes = (await readFile(join(original, file.path))).length;
  }
  await writeFile(join(original, 'snapshot.json'), canonicalJson(legacy));
  await expect(verifyStructuredSnapshot(original)).resolves.toMatchObject({ record_sha256: legacy.record_sha256 });
  const refreshed = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  expect(refreshed.snapshot).toMatchObject({ json_format: 'pretty-2', record_sha256: legacy.record_sha256, label_sha256: legacy.label_sha256 });
  expect(await readFile(join(machine, 'record.json'))).toEqual(recordBefore);
  expect(await readFile(join(machine, 'fields.json'))).toEqual(labelBefore);
  const snapshotBefore = await readFile(join(original, 'snapshot.json'));
  await publishStructuredSnapshot({ paths, datasetId, sampleId });
  expect(await readFile(join(original, 'snapshot.json'))).toEqual(snapshotBefore);
});

test('pretty snapshot source identity rejects label tampering even with updated physical checksums', async () => {
  const paths = await fixturePaths();
  const { datasetId, sampleId } = await source(paths);
  const { snapshot_path, snapshot } = await publishStructuredSnapshot({ paths, datasetId, sampleId });
  const file = join(snapshot_path, 'fields.json');
  const label = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, prettyJson({ ...label, fields: { forged: true } }));
  const entry = snapshot.files.find(file => file.path === 'fields.json')!;
  entry.sha256 = await sha256File(file); entry.bytes = (await readFile(file)).length;
  await writeFile(join(snapshot_path, 'snapshot.json'), prettyJson(snapshot));
  await expect(verifyStructuredSnapshot(snapshot_path)).rejects.toThrow('SNAPSHOT_SOURCE_HASH_MISMATCH');
});
