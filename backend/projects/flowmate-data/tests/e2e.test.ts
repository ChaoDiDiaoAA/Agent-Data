import { afterEach, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowmatePaths, SourceConfig } from '../src/contracts.ts';
import { applyCatalog, buildCatalog } from '../src/catalog.ts';
import { createBackup, restoreBackup, saveWithdrawalList, verifyBackup, verifyRestoredBackup } from '../src/backup.ts';
import { buildRelease, verifyRelease } from '../src/release.ts';
import { sha256File } from '../src/file-store.ts';
import { createFlowmateMinerURuntime, parseInvoice } from '../src/engine-bridge.ts';
import { publishStructuredSnapshot, verifyStructuredSnapshot } from '../src/structured-snapshot.ts';
import { saveSampleRecord, type SampleRecord } from '../src/task-store.ts';

const roots: string[] = [];
async function paths(): Promise<FlowmatePaths> {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-e2e-')); roots.push(root);
  await mkdir(join(root, 'config'), { recursive: true });
  await cp(join(import.meta.dir, 'fixtures/mineru.local.json'), join(root, 'config/mineru.local.json'));
  return { projectRoot: root, paperEngineRoot: root, originalRoot: join(root, 'original'), dataRoot: join(root, 'data'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') };
}
const sourceConfig: SourceConfig = { schema_version: 1, source_id: 'e2e', dataset_id: 'e2e-dataset', reader: 'dataset-records', homepage: 'https://example.test/e2e', revision: { kind: 'content-hash', url: 'https://example.test/e2e' }, allowed_origins: ['https://example.test'], redirect_origins: [], declared_license: 'test', license_evidence: 'https://example.test/license', retention: 'allowed', local_use: 'allowed', redistribution: 'unknown', origin_kind: 'synthetic', language: 'zh-CN', document_kind: 'invoice' };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('runs the local projection chain without network or GPU', async () => {
  const p = await paths();
  await mkdir(join(p.originalRoot, 'e2e-dataset/s1'), { recursive: true });
  await mkdir(join(p.dataRoot, 'e2e-dataset/s1'), { recursive: true });
  const originalPath = join(p.originalRoot, 'e2e-dataset/s1/original.png');
  await cp(join(import.meta.dir, 'fixtures/invoice.png'), originalPath);
  const record: SampleRecord = { schema_version: 1, sample_id: 's1', dataset_id: 'e2e-dataset', dataset_revision: 'local', source_record_id: 'local-1', origin_kind: 'synthetic', document_kind: 'invoice', language: 'zh-CN', layout_group: 'simple', original_ref: { root: 'original', path: 'e2e-dataset/s1/original.png' }, original_sha256: await sha256File(originalPath), source_observations: ['local fixture'], label_kind: 'none', quality_status: 'usable', processing_status: 'downloaded', allowed_uses: ['development'], created_at: '', updated_at: '' };
  const saved = await saveSampleRecord(p, record);
  p.paperEngineRoot = join(import.meta.dir, '../../paper-knowledge-engine');
  const receipt = await parseInvoice({ ...createFlowmateMinerURuntime(p), sampleId: saved.sample_id, sourcePath: originalPath, outputDir: join(p.dataRoot, 'work/p/s1') }, {
    createSession: () => ({
      async ensureReady() { return 'fake'; },
      async run(job) { await cp(join(import.meta.dir, 'fixtures/mineru-output'), job.outputDir, { recursive: true }); return { exitCode: 0 }; },
      async dispose() {},
    }),
  });
  const parsed = await saveSampleRecord(p, { ...saved, original_sha256: receipt.originalSha256, parser_key: receipt.parserKey, parse_attempt_id: receipt.attemptId, content_sha256: receipt.contentHash, derived_ref: { root: 'data', path: 'e2e-dataset/s1' }, processing_status: 'processed' });
  const snapshot = await publishStructuredSnapshot({ paths: p, datasetId: 'e2e-dataset', sampleId: 's1', parsed: receipt });
  await expect(verifyStructuredSnapshot(snapshot.snapshot_path)).resolves.toMatchObject({ content_sha256: receipt.contentHash });
  await mkdir(p.vaultRoot, { recursive: true });
  await writeFile(join(p.vaultRoot, 'notes.md'), '# user note');
  await applyCatalog(await buildCatalog(p));
  const release = await buildRelease({ paths: p, version: 'e2e-v1', records: [parsed], includeOriginals: false, sourceConfig });
  expect((await verifyRelease(release.path)).manifest.entries).toHaveLength(1);
  await saveWithdrawalList(p.dataRoot, { schema: 'flowmate-withdrawals/1', entries: [{ dataset_id: 'e2e-dataset', sample_id: 's1', reason: 'e2e withdrawal', withdrawn_at: '2026-09-08T00:00:00.000Z' }] });
  await expect(buildRelease({ paths: p, version: 'e2e-withdrawn', records: [parsed], includeOriginals: false, sourceConfig })).rejects.toThrow('RELEASE_WITHDRAWN_RECORD');
  const backup = await createBackup(p, 'e2e');
  expect((await verifyBackup(backup.path)).manifest.backup_id).toBe('e2e');
  const restoreRoot = await mkdtemp(join(tmpdir(), 'flowmate-e2e-restore-')); roots.push(restoreRoot);
  const destinationRoots = { originalRoot: join(restoreRoot, 'original'), dataRoot: join(restoreRoot, 'data'), vaultRoot: join(restoreRoot, 'vault') };
  await restoreBackup({ backup: backup.path, destinationRoots, currentRoots: { originalRoot: p.originalRoot, dataRoot: p.dataRoot, vaultRoot: p.vaultRoot } });
  await verifyRestoredBackup({ backup: backup.path, destinationRoots, currentRoots: { originalRoot: p.originalRoot, dataRoot: p.dataRoot, vaultRoot: p.vaultRoot } });
  await expect(verifyStructuredSnapshot(join(destinationRoots.originalRoot, 'e2e-dataset/s1'))).resolves.toMatchObject({ content_sha256: receipt.contentHash });
  expect(await Bun.file(join(restoreRoot, 'vault/notes.md')).text()).toBe('# user note');
  const restoredPaths = { ...p, ...destinationRoots };
  await applyCatalog(await buildCatalog(restoredPaths));
  expect(await Bun.file(join(destinationRoots.vaultRoot, 'Evidence/invoices/e2e-dataset/s1/invoice.md')).text()).toContain('status: withdrawn');
});
