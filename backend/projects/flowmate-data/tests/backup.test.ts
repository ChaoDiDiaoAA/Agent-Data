import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync, zipSync, Zip, ZipPassThrough } from 'fflate';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { canonicalJson } from '../src/engine-bridge.ts';
import { publicationPaths } from '../src/publication.ts';
import type { FlowmatePaths } from '../src/contracts.ts';
import { createBackup, restoreBackup, saveWithdrawalList, verifyBackup, verifyRestoredBackup } from '../src/backup.ts';

const roots: string[] = [];
async function fixturePaths(): Promise<FlowmatePaths> {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-backup-')); roots.push(root);
  return { projectRoot: root, paperEngineRoot: root, originalRoot: join(root, 'original'), dataRoot: join(root, 'data'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('creates, verifies, and restores a frozen backup without generated cards', async () => {
  const paths = await fixturePaths();
  await mkdir(join(paths.originalRoot, 'datasets/public-invoices/samples/a'), { recursive: true });
  await mkdir(join(paths.dataRoot, 'voxel51/000001'), { recursive: true });
  await mkdir(join(paths.dataRoot, 'tasks/voxel51'), { recursive: true });
  await mkdir(join(paths.dataRoot, 'work/tmp'), { recursive: true });
  await mkdir(join(paths.dataRoot, 'releases/v1'), { recursive: true });
  await mkdir(join(paths.vaultRoot, 'notes'), { recursive: true });
  await mkdir(join(paths.vaultRoot, '03_InvoiceSamples'), { recursive: true });
  await writeFile(join(paths.originalRoot, 'datasets/public-invoices/samples/a/original.jpg'), 'original');
  await writeFile(join(paths.dataRoot, 'voxel51/000001/record.json'), '{}');
  await writeFile(join(paths.dataRoot, 'voxel51/dataset.json'), '{}');
  await writeFile(join(paths.dataRoot, 'tasks/voxel51/ids.json'), '{"next_id":2}');
  await writeFile(join(paths.dataRoot, 'voxel51/000001/snapshot.json'), '{"id":"latest"}');
  await writeFile(join(paths.dataRoot, 'voxel51/000001/parse.json'), '{"attemptId":"parse-provenance"}');
  await writeFile(join(paths.dataRoot, 'work/tmp/temporary.json'), '{}');
  await writeFile(join(paths.dataRoot, 'releases/v1/manifest.json'), '{}');
  await writeFile(join(paths.vaultRoot, 'notes/user.md'), '# keep');
  await writeFile(join(paths.vaultRoot, '03_InvoiceSamples/generated.md'), '---\ngenerated_by: flowmate-data\nschema_version: 1\n---\n');
  const result = await createBackup(paths, 'p0-smoke');
  expect(result.manifest.schema).toBe('flowmate-public-backup/1');
  expect(basename(result.path)).toMatch(/^\d{8}-\d{6}$/);
  expect((await readdir(result.path)).sort()).toEqual(['data.zip', 'manifest.json']);
  expect(await readdir(paths.backupRoot)).toEqual([basename(result.path)]);
  expect(result.files.some(file => file.path.includes('/work/'))).toBe(false);
  expect((await createBackup(paths, 'p0-smoke')).path).toBe(result.path);
  expect(result.manifest.files.some(file => file.path.includes('user.md'))).toBe(true);
  expect(result.manifest.files.some(file => file.path.includes('generated.md'))).toBe(false);
  expect((await verifyBackup(result.path)).manifest.backup_id).toBe('p0-smoke');

  const restoreRoot = await mkdtemp(join(tmpdir(), 'flowmate-restore-')); roots.push(restoreRoot);
  const destinations = { originalRoot: join(restoreRoot, 'original'), dataRoot: join(restoreRoot, 'data'), vaultRoot: join(restoreRoot, 'vault') };
  await restoreBackup({ backup: result.path, destinationRoots: destinations, currentRoots: { originalRoot: paths.originalRoot, dataRoot: paths.dataRoot, vaultRoot: paths.vaultRoot } });
  expect(await readFile(join(destinations.originalRoot, 'datasets/public-invoices/samples/a/original.jpg'), 'utf8')).toBe('original');
  expect(await readFile(join(destinations.vaultRoot, 'notes/user.md'), 'utf8')).toBe('# keep');
  expect(await readFile(join(destinations.dataRoot, 'voxel51/000001/record.json'), 'utf8')).toBe('{}');
  expect(await readFile(join(destinations.dataRoot, 'voxel51/dataset.json'), 'utf8')).toBe('{}');
  expect(await readFile(join(destinations.dataRoot, 'tasks/voxel51/ids.json'), 'utf8')).toBe('{"next_id":2}');
  expect(await readFile(join(destinations.dataRoot, 'voxel51/000001/snapshot.json'), 'utf8')).toBe('{"id":"latest"}');
  expect(await readFile(join(destinations.dataRoot, 'voxel51/000001/parse.json'), 'utf8')).toBe('{"attemptId":"parse-provenance"}');
  expect(await Bun.file(join(destinations.dataRoot, 'work/tmp/temporary.json')).exists()).toBe(false);
  expect(await Bun.file(join(destinations.vaultRoot, '03_InvoiceSamples/generated.md')).exists()).toBe(false);
  await expect(restoreBackup({ backup: result.path, destinationRoots: { originalRoot: paths.originalRoot, dataRoot: join(paths.dataRoot, 'restore-data'), vaultRoot: join(paths.backupRoot, 'restore-vault') }, currentRoots: { originalRoot: paths.originalRoot, dataRoot: paths.dataRoot, vaultRoot: paths.vaultRoot } })).rejects.toThrow('BACKUP_DESTINATION_CURRENT_ROOT');
});

test('rejects changed content for an existing backup id and reapplies current withdrawals on restore', async () => {
  const paths = await fixturePaths();
  await mkdir(join(paths.originalRoot, 'datasets/invoices/samples/a'), { recursive: true });
  await mkdir(join(paths.dataRoot, 'datasets/invoices/samples/a'), { recursive: true });
  await writeFile(join(paths.originalRoot, 'datasets/invoices/samples/a/original.jpg'), 'original');
  await writeFile(join(paths.dataRoot, 'datasets/invoices/samples/a/record.json'), JSON.stringify({ dataset_id: 'invoices', sample_id: 'a', source_record_id: 'source-a' }));
  await createBackup(paths, 'same-id');
  await writeFile(join(paths.originalRoot, 'datasets/invoices/samples/a/original.jpg'), 'changed');
  await expect(createBackup(paths, 'same-id')).rejects.toThrow('BACKUP_ID_CONFLICT');

  await saveWithdrawalList(paths.dataRoot, { schema: 'flowmate-withdrawals/1', entries: [{ dataset_id: 'invoices', sample_id: 'a', reason: 'source withdrawal', withdrawn_at: '2026-09-08T00:00:00.000Z' }] });
  const withdrawnBackup = await createBackup(paths, 'withdrawal');
  const restoreRoot = await mkdtemp(join(tmpdir(), 'flowmate-restore-withdrawal-')); roots.push(restoreRoot);
  const destinations = { originalRoot: join(restoreRoot, 'original'), dataRoot: join(restoreRoot, 'data'), vaultRoot: join(restoreRoot, 'vault') };
  await restoreBackup({ backup: withdrawnBackup.path, destinationRoots: destinations, currentRoots: { originalRoot: paths.originalRoot, dataRoot: paths.dataRoot, vaultRoot: paths.vaultRoot } });
  expect(await Bun.file(join(destinations.dataRoot, 'policies/withdrawals.json')).exists()).toBe(true);
  expect(JSON.parse(await Bun.file(join(destinations.dataRoot, 'policies/withdrawals.json')).text()).entries).toHaveLength(1);
});

test('verifies a current withdrawal policy even when it was added after the backup', async () => {
  const paths = await fixturePaths();
  await mkdir(join(paths.originalRoot, 'datasets/invoices'), { recursive: true });
  await writeFile(join(paths.originalRoot, 'datasets/invoices/source.json'), '{}');
  const backup = await createBackup(paths, 'policy-added-after-backup');

  const currentList = { schema: 'flowmate-withdrawals/1' as const, entries: [{ dataset_id: 'invoices', sample_id: 'a', reason: 'withdrawn later', withdrawn_at: '2026-09-08T00:00:00.000Z' }] };
  await saveWithdrawalList(paths.dataRoot, currentList);
  const restoreRoot = await mkdtemp(join(tmpdir(), 'flowmate-restore-policy-')); roots.push(restoreRoot);
  const destinations = { originalRoot: join(restoreRoot, 'original'), dataRoot: join(restoreRoot, 'data'), vaultRoot: join(restoreRoot, 'vault') };
  const currentRoots = { originalRoot: paths.originalRoot, dataRoot: paths.dataRoot, vaultRoot: paths.vaultRoot };
  await restoreBackup({ backup: backup.path, destinationRoots: destinations, currentRoots });
  await verifyRestoredBackup({ backup: backup.path, destinationRoots: destinations, currentRoots });

  await rm(join(destinations.dataRoot, 'policies/withdrawals.json'));
  await expect(verifyRestoredBackup({ backup: backup.path, destinationRoots: destinations, currentRoots })).rejects.toThrow('BACKUP_RESTORE_MISSING');
});

test('refuses backup while the Flowmate run lock is held and detects tampering', async () => {
  const paths = await fixturePaths();
  await mkdir(join(paths.dataRoot, 'work'), { recursive: true });
  await writeFile(join(paths.dataRoot, 'work/run.lock'), '{}');
  await expect(createBackup(paths, 'busy')).rejects.toThrow('PROJECT_BUSY');
  await rm(join(paths.dataRoot, 'work/run.lock'));
  await mkdir(paths.originalRoot, { recursive: true });
  const result = await createBackup(paths, 'tamper');
  await writeFile(join(result.path, 'data.zip'), 'changed');
  await expect(verifyBackup(result.path)).rejects.toThrow(/BACKUP_(CHECKSUM|CONTENT|FILE)|JSON Parse/);
  await expect(createBackup(paths, 'tamper')).rejects.toThrow(/BACKUP_(CHECKSUM|CONTENT|FILE|DESTINATION)|JSON Parse/);
});

async function replaceArchive(path: string, bytes: Uint8Array): Promise<void> {
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  manifest.archive.bytes = bytes.byteLength;
  manifest.archive.sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(path, 'data.zip'), bytes);
  await writeFile(join(path, 'manifest.json'), canonicalJson(manifest));
}

test('validates ZIP payload hashes, exact entry set, and paths before restore', async () => {
  const paths = await fixturePaths();
  await mkdir(paths.originalRoot, { recursive: true });
  await writeFile(join(paths.originalRoot, 'source.txt'), 'original');
  const backup = await createBackup(paths, 'zip-validation');
  const archive = await readFile(join(backup.path, 'data.zip'));
  const payload = unzipSync(archive);
  await replaceArchive(backup.path, zipSync({ ...payload, 'payload/original/source.txt': Buffer.from('tampered') }));
  await expect(verifyBackup(backup.path)).rejects.toThrow('BACKUP_CHECKSUM_MISMATCH');
  await replaceArchive(backup.path, zipSync({ ...payload, 'payload/original/extra.txt': Buffer.from('extra') }));
  await expect(verifyBackup(backup.path)).rejects.toThrow('BACKUP_FILE_SET_MISMATCH');
  await replaceArchive(backup.path, zipSync({}));
  await expect(verifyBackup(backup.path)).rejects.toThrow('BACKUP_FILE_SET_MISMATCH');
  await replaceArchive(backup.path, zipSync({ ...payload, '../escape.txt': Buffer.from('escape') }));
  await expect(verifyBackup(backup.path)).rejects.toThrow('BACKUP_PATH_INVALID');
  const destinations = { originalRoot: join(paths.projectRoot, 'restored-original'), dataRoot: join(paths.projectRoot, 'restored-data'), vaultRoot: join(paths.projectRoot, 'restored-vault') };
  const currentRoots = { originalRoot: paths.originalRoot, dataRoot: paths.dataRoot, vaultRoot: paths.vaultRoot };
  await expect(restoreBackup({ backup: backup.path, destinationRoots: destinations, currentRoots })).rejects.toThrow('BACKUP_PATH_INVALID');
  expect(await Bun.file(join(destinations.originalRoot, 'source.txt')).exists()).toBe(false);
  await replaceArchive(backup.path, new Uint8Array(3));
  await expect(verifyBackup(backup.path)).rejects.toThrow('BACKUP_ARCHIVE_INVALID');
  await replaceArchive(backup.path, archive);
  await writeFile(join(backup.path, 'unexpected.txt'), 'extra');
  await expect(verifyBackup(backup.path)).rejects.toThrow('BACKUP_FILE_SET_MISMATCH');
});

test('rejects duplicate ZIP entries even when their bytes and names match', async () => {
  const paths = await fixturePaths();
  await mkdir(paths.originalRoot, { recursive: true });
  await writeFile(join(paths.originalRoot, 'source.txt'), 'original');
  const backup = await createBackup(paths, 'duplicate-entry');
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, bytes) => { if (error) throw error; chunks.push(bytes); });
  for (let i = 0; i < 2; i += 1) {
    const file = new ZipPassThrough('payload/original/source.txt');
    zip.add(file);
    file.push(Buffer.from('original'), true);
  }
  zip.end();
  await replaceArchive(backup.path, Buffer.concat(chunks));
  await expect(verifyBackup(backup.path)).rejects.toThrow('BACKUP_FILE_SET_MISMATCH');
});

test('allocates distinct timestamp directories for different backups in one second', async () => {
  const paths = await fixturePaths();
  const first = await createBackup(paths, 'first');
  const second = await createBackup(paths, 'second');
  expect(first.path).not.toBe(second.path);
  expect(basename(first.path)).toMatch(/^\d{8}-\d{6}$/);
  expect(basename(second.path)).toMatch(/^\d{8}-\d{6}$/);
  expect((await verifyBackup(first.path)).manifest.backup_id).toBe('first');
  expect((await verifyBackup(second.path)).manifest.backup_id).toBe('second');
});

test('recovers interrupted publication before archiving and excludes both roots transaction work', async () => {
  const paths = await fixturePaths();
  const plan = await publicationPaths(paths, 'voxel51', '000001');
  const [data, original] = plan.swaps;
  if (!data || !original) throw new Error('fixture publication plan missing');
  for (const path of [data.target, data.backup, original.target, original.stage]) await mkdir(path, { recursive: true });
  // A crash after publishing data but before publishing original must roll back.
  await writeFile(join(data.target, 'record.json'), 'new record');
  await writeFile(join(data.backup, 'record.json'), 'committed record');
  await writeFile(join(original.target, 'original.jpg'), 'committed original');
  await writeFile(join(original.stage, 'original.jpg'), 'new original');
  await writeFile(plan.journal, canonicalJson({ schema_version: 1, dataset_id: 'voxel51', sample_id: '000001', existed: [true, true] }));
  await mkdir(join(paths.originalRoot, 'work/uncommitted'), { recursive: true });
  await writeFile(join(paths.originalRoot, 'work/uncommitted/download.part'), 'temporary');
  const backup = await createBackup(paths, 'recover-before-backup');
  const payload = unzipSync(await readFile(join(backup.path, 'data.zip')));
  expect(Buffer.from(payload['payload/data/voxel51/000001/record.json']!).toString()).toBe('committed record');
  expect(Buffer.from(payload['payload/original/voxel51/000001/original.jpg']!).toString()).toBe('committed original');
  expect(backup.files.some(file => /^payload\/(original|data)\/work\//.test(file.path))).toBe(false);
  expect(await Bun.file(plan.journal).exists()).toBe(false);
});
