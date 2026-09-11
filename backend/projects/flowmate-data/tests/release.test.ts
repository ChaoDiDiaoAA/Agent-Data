import { afterEach, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../src/engine-bridge.ts';
import type { FlowmatePaths, SourceConfig } from '../src/contracts.ts';
import { buildRelease, verifyRelease } from '../src/release.ts';
import { saveSampleRecord, type SampleRecord } from '../src/task-store.ts';

const roots: string[] = [];

async function fixturePaths(): Promise<FlowmatePaths> {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-release-'));
  roots.push(root);
  return { projectRoot: root, paperEngineRoot: root, originalRoot: join(root, 'original'), dataRoot: join(root, 'data'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') };
}

const sourceConfig: SourceConfig = {
  schema_version: 1, source_id: 'voxel51-invoice-ocr', dataset_id: 'voxel51-hq-invoice-ocr', reader: 'dataset-records', homepage: 'https://example.test/dataset',
  revision: { kind: 'huggingface-api', url: 'https://example.test/revision' }, allowed_origins: ['https://example.test'], redirect_origins: [], declared_license: 'odbl', license_evidence: 'https://example.test/license', retention: 'allowed', local_use: 'allowed', redistribution: 'unknown', origin_kind: 'public_redacted', language: 'en', document_kind: 'invoice',
};

function sample(revision = 'rev-1'): SampleRecord {
  return { schema_version: 1, sample_id: 'sample-a', dataset_id: 'voxel51-hq-invoice-ocr', dataset_revision: revision, source_record_id: '507f1f77bcf86cd799439011', origin_kind: 'public_redacted', document_kind: 'invoice', language: 'en', layout_group: 'vat', original_ref: { root: 'original', path: 'voxel51/sample-a/original.jpg' }, original_sha256: '0'.repeat(64), annotation_ref: { root: 'original', path: 'voxel51/sample-a/annotation.json' }, annotation_sha256: '1'.repeat(64), source_observations: ['public source'], label_ref: { root: 'data', path: 'voxel51/sample-a/label.json' }, label_sha256: '2'.repeat(64), label_kind: 'dataset_annotation', mapping_version: 'voxel51/1', quality_status: 'usable', processing_status: 'processed', allowed_uses: ['development'], created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z' };
}

async function seed(paths: FlowmatePaths, record = sample()): Promise<SampleRecord> {
  const original = join(paths.originalRoot, record.original_ref.path);
  const annotation = join(paths.originalRoot, record.annotation_ref!.path);
  const label = join(paths.dataRoot, record.label_ref!.path);
  await mkdir(join(paths.dataRoot, 'datasets/voxel51-hq-invoice-ocr'), { recursive: true });
  await mkdir(join(paths.originalRoot, 'voxel51/sample-a'), { recursive: true });
  await mkdir(join(paths.dataRoot, 'voxel51/sample-a'), { recursive: true });
  await writeFile(original, Buffer.from('original')); // hashes are replaced below after bytes are written.
  await writeFile(annotation, canonicalJson({ source_record_id: record.source_record_id }));
  await writeFile(label, canonicalJson({ labels: ['invoice'] }));
  const { createHash } = await import('node:crypto');
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const originalBytes = await readFile(original); const annotationBytes = await readFile(annotation); const labelBytes = await readFile(label);
  const prepared = { ...record, original_sha256: hash(originalBytes), annotation_sha256: hash(annotationBytes), label_sha256: hash(labelBytes) };
  const saved = await saveSampleRecord(paths, prepared);
  await writeFile(join(paths.dataRoot, 'voxel51/dataset.json'), canonicalJson({ dataset_id: prepared.dataset_id, redistribution: sourceConfig.redistribution }));
  return saved;
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('builds a portable index release and verifies it after copying', async () => {
  const paths = await fixturePaths();
  const record = await seed(paths);
  const result = await buildRelease({ paths, version: 'public-invoice-p0-v1', records: [record], includeOriginals: false, sourceConfig });
  expect(result.manifest.schema).toBe('flowmate-public/1');
  expect(result.manifest.omitted_originals).toHaveLength(1);
  expect(JSON.stringify(result.manifest)).not.toMatch(/(?:^|["'])[A-Za-z]:[\\/]/);
  expect(result.files.some(file => file.path === 'manifest.json')).toBe(true);
  expect(result.files.some(file => file.path === 'checksums.json')).toBe(false);
  const portable = JSON.parse(await readFile(join(result.path, 'payload/samples/sample-a/record.json'), 'utf8')) as Record<string, unknown>;
  expect(portable.original_ref).toBeUndefined();
  expect(portable.annotation_ref).toBeUndefined();
  expect(portable.label_ref).toEqual({ root: 'release', path: 'payload/samples/sample-a/label.json' });
  const verified = await verifyRelease(result.path);
  expect(verified.manifest.selection_id).toBeUndefined();
  const copied = join(paths.backupRoot, 'copied-release');
  await mkdir(paths.backupRoot, { recursive: true });
  await cp(result.path, copied, { recursive: true });
  expect((await verifyRelease(copied)).manifest.version).toBe('public-invoice-p0-v1');
});

test('gates original redistribution and detects payload tampering', async () => {
  const paths = await fixturePaths();
  const record = await seed(paths);
  await expect(buildRelease({ paths, version: 'blocked', records: [record], includeOriginals: true, sourceConfig })).rejects.toThrow('RELEASE_REDISTRIBUTION_NOT_ALLOWED');
  const allowed = { ...sourceConfig, redistribution: 'allowed' as const };
  const result = await buildRelease({ paths, version: 'allowed', records: [record], includeOriginals: true, sourceConfig: allowed });
  const payload = join(result.path, 'payload/samples/sample-a/label.json');
  await writeFile(payload, '{}');
  await expect(verifyRelease(result.path)).rejects.toThrow('RELEASE_CHECKSUM_MISMATCH');
});

test('rebuilds the configured version when record content changes', async () => {
  const paths = await fixturePaths();
  const record = await seed(paths);
  await buildRelease({ paths, version: 'immutable', records: [record], includeOriginals: false, sourceConfig });
  const changed = await saveSampleRecord(paths, { ...record, dataset_revision: 'rev-2' });
  const rebuilt = await buildRelease({ paths, version: 'immutable', records: [changed], includeOriginals: false, sourceConfig });
  expect(rebuilt.manifest.version).toBe('immutable');
  expect(rebuilt.manifest.entries[0]?.dataset_revision).toBe('rev-2');
  expect((await verifyRelease(rebuilt.path)).manifest.entries[0]?.dataset_revision).toBe('rev-2');
});

test('rejects machine absolute paths in copied record metadata', async () => {
  const paths = await fixturePaths();
  const record = await seed(paths);
  const changed = await saveSampleRecord(paths, { ...record, source_observations: ['D:\\secret\\source.json'] });
  await expect(buildRelease({ paths, version: 'portable', records: [changed], includeOriginals: false, sourceConfig })).rejects.toThrow('RELEASE_ABSOLUTE_PATH');
  const unixPath = await saveSampleRecord(paths, { ...changed, source_observations: ['/private/source.json'] });
  await expect(buildRelease({ paths, version: 'portable-unix', records: [unixPath], includeOriginals: false, sourceConfig })).rejects.toThrow('RELEASE_ABSOLUTE_PATH');
  const fileUrl = await saveSampleRecord(paths, { ...unixPath, source_observations: ['file:/etc/passwd'] });
  await expect(buildRelease({ paths, version: 'portable-file', records: [fileUrl], includeOriginals: false, sourceConfig })).rejects.toThrow('RELEASE_ABSOLUTE_PATH');
});
