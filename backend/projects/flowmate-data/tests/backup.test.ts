import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  await mkdir(join(paths.dataRoot, 'datasets/public-invoices'), { recursive: true });
  await mkdir(join(paths.dataRoot, 'releases/v1'), { recursive: true });
  await mkdir(join(paths.vaultRoot, 'notes'), { recursive: true });
  await mkdir(join(paths.vaultRoot, '03_InvoiceSamples'), { recursive: true });
  await writeFile(join(paths.originalRoot, 'datasets/public-invoices/samples/a/original.jpg'), 'original');
  await writeFile(join(paths.dataRoot, 'datasets/public-invoices/record.json'), '{}');
  await writeFile(join(paths.dataRoot, 'releases/v1/manifest.json'), '{}');
  await writeFile(join(paths.vaultRoot, 'notes/user.md'), '# keep');
  await writeFile(join(paths.vaultRoot, '03_InvoiceSamples/generated.md'), '---\ngenerated_by: flowmate-data\nschema_version: 1\n---\n');
  const result = await createBackup(paths, 'p0-smoke');
  expect(result.manifest.schema).toBe('flowmate-public-backup/1');
  expect(result.manifest.files.some(file => file.path.includes('user.md'))).toBe(true);
  expect(result.manifest.files.some(file => file.path.includes('generated.md'))).toBe(false);
  expect((await verifyBackup(result.path)).manifest.backup_id).toBe('p0-smoke');

  const restoreRoot = await mkdtemp(join(tmpdir(), 'flowmate-restore-')); roots.push(restoreRoot);
  const destinations = { originalRoot: join(restoreRoot, 'original'), dataRoot: join(restoreRoot, 'data'), vaultRoot: join(restoreRoot, 'vault') };
  await restoreBackup({ backup: result.path, destinationRoots: destinations, currentRoots: { originalRoot: paths.originalRoot, dataRoot: paths.dataRoot, vaultRoot: paths.vaultRoot } });
  expect(await readFile(join(destinations.originalRoot, 'datasets/public-invoices/samples/a/original.jpg'), 'utf8')).toBe('original');
  expect(await readFile(join(destinations.vaultRoot, 'notes/user.md'), 'utf8')).toBe('# keep');
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
  const target = join(result.path, result.manifest.files[0]?.path ?? 'manifest.json');
  if (await Bun.file(target).exists()) await writeFile(target, 'changed');
  await expect(verifyBackup(result.path)).rejects.toThrow(/BACKUP_(CHECKSUM|CONTENT|FILE)|JSON Parse/);
  await expect(createBackup(paths, 'tamper')).rejects.toThrow(/BACKUP_(CHECKSUM|CONTENT|FILE|DESTINATION)|JSON Parse/);
});
