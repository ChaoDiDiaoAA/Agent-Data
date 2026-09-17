import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildCatalog, cardContent, verifyCatalog } from '../src/catalog.ts';
import { migrateLegacyStorage } from '../src/task.ts';
import { createBackup, restoreBackup, restoreSmoke, verifyBackup } from '../src/backup.ts';
import type { DataWatchPaths, DatasetManifest } from '../src/contracts.ts';

async function roots(): Promise<DataWatchPaths> {
  const root = await mkdtemp(join(tmpdir(), 'datawatch-catalog-'));
  return {
    projectRoot: root,
    paperEngineRoot: join(root, 'engine'),
    originalRoot: join(root, 'original'),
    dataRoot: join(root, 'data'),
    vaultRoot: join(root, 'vault'),
    backupRoot: join(root, 'backup'),
  };
}

test('publishes an immutable dataset copy and preserves user notes', async () => {
  const paths = await roots();
  const body = new TextEncoder().encode('abc');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const manifest: DatasetManifest = {
    schema_version: 1,
    dataset_id: 'fda-recalls',
    source_id: 'fda-recalls',
    repository: 'wapplewhite4/fda-recall-intelligence',
    revision: 'a'.repeat(40),
    homepage: 'https://huggingface.co/datasets/wapplewhite4/fda-recall-intelligence',
    declared_license: 'CC BY 4.0',
    license_evidence: 'https://creativecommons.org/licenses/by/4.0/',
    data_kind: 'public-fda-recall-sample',
    origin_kind: 'public_redacted',
    retrieved_at: new Date().toISOString(),
    files: [{ path: 'README.md', bytes: 3, url: 'https://example.test/readme', sha256 }],
  };
  await mkdir(join(paths.originalRoot, manifest.dataset_id), { recursive: true });
  await writeFile(join(paths.originalRoot, manifest.dataset_id, 'README.md'), body);
  await mkdir(paths.vaultRoot, { recursive: true });
  await writeFile(join(paths.vaultRoot, 'my-note.md'), 'keep me');
  await buildCatalog(paths, [manifest]);
  expect(await verifyCatalog(paths, [manifest])).toEqual({ datasets: 1, files: 1 });
  expect(await readFile(join(paths.vaultRoot, 'my-note.md'), 'utf8')).toBe('keep me');
  expect(await readFile(join(paths.vaultRoot, manifest.dataset_id, 'raw', 'README.md'), 'utf8')).toBe('abc');
  const overviewPath = join(paths.vaultRoot, 'indexes', 'overview.md');
  const registryPath = join(paths.vaultRoot, '.datawatch-assets.json');
  const overview = await readFile(overviewPath, 'utf8');
  const registry = await readFile(registryPath, 'utf8');
  await writeFile(overviewPath, 'user overview');
  await expect(buildCatalog(paths, [manifest])).rejects.toThrow('CATALOG_USER_FILE_CONFLICT');
  await writeFile(overviewPath, overview);
  await writeFile(join(paths.vaultRoot, manifest.dataset_id, 'raw', 'README.md'), 'user raw');
  await expect(buildCatalog(paths, [manifest])).rejects.toThrow('CATALOG_USER_FILE_CONFLICT');
  await writeFile(join(paths.vaultRoot, manifest.dataset_id, 'raw', 'README.md'), 'abc');
  await writeFile(registryPath, registry.replace('datawatch-data', 'user registry'));
  await expect(buildCatalog(paths, [manifest])).rejects.toThrow('CATALOG_USER_FILE_CONFLICT');
  await writeFile(registryPath, registry);
  const cardPath = join(paths.vaultRoot, manifest.dataset_id, 'dataset.md');
  await writeFile(cardPath, 'user card');
  await expect(buildCatalog(paths, [manifest])).rejects.toThrow('CATALOG_USER_FILE_CONFLICT');
  await writeFile(join(paths.vaultRoot, manifest.dataset_id, 'manifest.json'), 'user metadata');
  await expect(buildCatalog(paths, [manifest])).rejects.toThrow('CATALOG_USER_FILE_CONFLICT');
});

test('creates, verifies, and smoke-restores a backup archive', async () => {
  const paths = await roots();
  await mkdir(join(paths.originalRoot, 'fda-recalls'), { recursive: true });
  await mkdir(paths.dataRoot, { recursive: true });
  await mkdir(paths.vaultRoot, { recursive: true });
  await writeFile(join(paths.originalRoot, 'fda-recalls', 'README.md'), 'raw');
  await writeFile(join(paths.dataRoot, 'state.json'), 'state');
  await writeFile(join(paths.vaultRoot, 'note.md'), 'note');
  const backup = await createBackup(paths, 'backup-test');
  expect((await verifyBackup(backup.path)).backup_id).toBe('backup-test');
  expect(backup.path).toBe(join(paths.backupRoot, 'backup-test.zip'));
  expect(await restoreSmoke(backup.path)).toEqual({ files: 3, bytes: 12 });
  const restored = await roots();
  await restoreBackup(backup.path, restored);
  expect(await readFile(join(restored.originalRoot, 'fda-recalls', 'README.md'), 'utf8')).toBe('raw');
});

test('migrates a verified legacy snapshot into flat current paths', async () => {
  const paths = await roots();
  const revision = 'c'.repeat(40);
  const body = new TextEncoder().encode('legacy');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const manifest: DatasetManifest = {
    schema_version: 1, dataset_id: 'fda-recalls', source_id: 'fda-recalls', repository: 'example/fda', revision,
    homepage: 'https://example.test', declared_license: 'CC BY 4.0', license_evidence: 'https://example.test/license',
    data_kind: 'sample', origin_kind: 'public_redacted', retrieved_at: '2026-01-01T00:00:00.000Z',
    files: [{ path: 'README.md', bytes: body.byteLength, url: 'https://example.test/readme', sha256 }],
  };
  await mkdir(join(paths.originalRoot, 'fda-recalls', revision), { recursive: true });
  await mkdir(join(paths.dataRoot, 'datasets', 'fda-recalls', revision), { recursive: true });
  await writeFile(join(paths.originalRoot, 'fda-recalls', revision, 'README.md'), body);
  await writeFile(join(paths.dataRoot, 'datasets', 'fda-recalls', revision, 'manifest.json'), JSON.stringify(manifest));
  expect(await migrateLegacyStorage(paths)).toEqual({ datasets: 1, files: 1 });
  expect(await readFile(join(paths.originalRoot, 'fda-recalls', 'README.md'), 'utf8')).toBe('legacy');
  expect(await readFile(join(paths.dataRoot, 'fda-recalls', 'manifest.json'), 'utf8')).toContain(revision);
  expect(await readFile(join(paths.vaultRoot, 'fda-recalls', 'raw', 'README.md'), 'utf8')).toBe('legacy');
  await expect(readFile(join(paths.dataRoot, 'datasets', 'fda-recalls', revision, 'manifest.json'), 'utf8')).rejects.toThrow();
});

test('leaves legacy files untouched when a user dataset note conflicts during migration', async () => {
  const paths = await roots();
  const revision = 'd'.repeat(40);
  const body = new TextEncoder().encode('legacy');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const manifest: DatasetManifest = {
    schema_version: 1, dataset_id: 'fda-recalls', source_id: 'fda-recalls', repository: 'example/fda', revision,
    homepage: 'https://example.test', declared_license: 'CC BY 4.0', license_evidence: 'https://example.test/license',
    data_kind: 'sample', origin_kind: 'public_redacted', retrieved_at: '2026-01-01T00:00:00.000Z',
    files: [{ path: 'README.md', bytes: body.byteLength, url: 'https://example.test/readme', sha256 }],
  };
  await mkdir(join(paths.originalRoot, 'fda-recalls', revision), { recursive: true });
  await mkdir(join(paths.dataRoot, 'datasets', 'fda-recalls', revision), { recursive: true });
  await mkdir(join(paths.vaultRoot, 'fda-recalls'), { recursive: true });
  await writeFile(join(paths.originalRoot, 'fda-recalls', revision, 'README.md'), body);
  await writeFile(join(paths.dataRoot, 'datasets', 'fda-recalls', revision, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(paths.vaultRoot, 'fda-recalls', 'dataset.md'), 'my note');
  await expect(migrateLegacyStorage(paths)).rejects.toThrow('CATALOG_USER_FILE_CONFLICT');
  expect(await readFile(join(paths.originalRoot, 'fda-recalls', revision, 'README.md'), 'utf8')).toBe('legacy');
  expect(await readFile(join(paths.vaultRoot, 'fda-recalls', 'dataset.md'), 'utf8')).toBe('my note');
});

test('does not clean legacy files when a flat migration destination conflicts', async () => {
  const paths = await roots();
  const revision = 'f'.repeat(40);
  const body = new TextEncoder().encode('legacy');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const manifest: DatasetManifest = {
    schema_version: 1, dataset_id: 'fda-recalls', source_id: 'fda-recalls', repository: 'example/fda', revision,
    homepage: 'https://example.test', declared_license: 'CC BY 4.0', license_evidence: 'https://example.test/license', data_kind: 'sample', origin_kind: 'public_redacted', retrieved_at: '2026-01-01T00:00:00.000Z',
    files: [{ path: 'README.md', bytes: body.byteLength, url: 'https://example.test/readme', sha256 }],
  };
  await mkdir(join(paths.originalRoot, 'fda-recalls', revision), { recursive: true });
  await mkdir(join(paths.dataRoot, 'datasets', 'fda-recalls', revision), { recursive: true });
  await writeFile(join(paths.originalRoot, 'fda-recalls', revision, 'README.md'), body);
  await writeFile(join(paths.originalRoot, 'fda-recalls', 'README.md'), 'user content');
  await writeFile(join(paths.dataRoot, 'datasets', 'fda-recalls', revision, 'manifest.json'), JSON.stringify(manifest));
  await expect(migrateLegacyStorage(paths)).rejects.toThrow('MIGRATION_DESTINATION_CONFLICT');
  expect(await readFile(join(paths.originalRoot, 'fda-recalls', revision, 'README.md'), 'utf8')).toBe('legacy');
  expect(await readFile(join(paths.originalRoot, 'fda-recalls', 'README.md'), 'utf8')).toBe('user content');
});

test('preserves a user note inside a legacy Evidence snapshot during cleanup', async () => {
  const paths = await roots();
  const revision = 'e'.repeat(40);
  const body = new TextEncoder().encode('legacy');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const manifest: DatasetManifest = {
    schema_version: 1, dataset_id: 'fda-recalls', source_id: 'fda-recalls', repository: 'example/fda', revision,
    homepage: 'https://example.test', declared_license: 'CC BY 4.0', license_evidence: 'https://example.test/license', data_kind: 'sample', origin_kind: 'public_redacted', retrieved_at: '2026-01-01T00:00:00.000Z',
    files: [{ path: 'README.md', bytes: body.byteLength, url: 'https://example.test/readme', sha256 }],
  };
  const legacy = join(paths.vaultRoot, 'Evidence', 'datasets', 'fda-recalls', revision);
  await mkdir(join(paths.originalRoot, 'fda-recalls', revision), { recursive: true });
  await mkdir(join(paths.dataRoot, 'datasets', 'fda-recalls', revision), { recursive: true });
  await mkdir(legacy, { recursive: true });
  await writeFile(join(paths.originalRoot, 'fda-recalls', revision, 'README.md'), body);
  await writeFile(join(paths.dataRoot, 'datasets', 'fda-recalls', revision, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(legacy, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(legacy, 'dataset.md'), cardContent(manifest));
  await mkdir(join(legacy, 'raw'), { recursive: true });
  await writeFile(join(legacy, 'raw', 'README.md'), 'legacy');
  await mkdir(join(legacy, 'raw', 'nested', 'sha'), { recursive: true });
  await writeFile(join(legacy, 'raw', 'nested', 'sha', 'old.txt'), 'legacy');
  const nestedSha = createHash('sha256').update('legacy').digest('hex');
  await writeFile(join(paths.vaultRoot, '.datawatch-assets.json'), JSON.stringify({ generated_by: 'datawatch-data', files: [
    { path: 'Evidence/datasets/fda-recalls/' + revision + '/raw/README.md' },
    { path: 'Evidence/datasets/fda-recalls/' + revision + '/raw/nested/sha/old.txt', bytes: 6, sha256: nestedSha },
  ] }));
  await writeFile(join(legacy, 'my-note.md'), 'keep');
  await migrateLegacyStorage(paths);
  expect(await readFile(join(legacy, 'my-note.md'), 'utf8')).toBe('keep');
  await expect(readFile(join(legacy, 'dataset.md'), 'utf8')).rejects.toThrow();
  await expect(readFile(join(legacy, 'raw', 'README.md'), 'utf8')).rejects.toThrow();
  await expect(readFile(join(legacy, 'raw', 'nested', 'sha', 'old.txt'), 'utf8')).rejects.toThrow();
  await expect(readFile(join(legacy, 'raw'), 'utf8')).rejects.toThrow();
});

test('stops migration before deleting edited legacy generated assets', async () => {
  const paths = await roots();
  const revision = 'g'.repeat(40);
  const body = 'legacy';
  const sha256 = createHash('sha256').update(body).digest('hex');
  const manifest: DatasetManifest = {
    schema_version: 1, dataset_id: 'fda-recalls', source_id: 'fda-recalls', repository: 'example/fda', revision,
    homepage: 'https://example.test', declared_license: 'CC BY 4.0', license_evidence: 'https://example.test/license', data_kind: 'sample', origin_kind: 'public_redacted', retrieved_at: '2026-01-01T00:00:00.000Z',
    files: [{ path: 'README.md', bytes: body.length, url: 'https://example.test/readme', sha256 }],
  };
  const legacy = join(paths.vaultRoot, 'Evidence', 'datasets', 'fda-recalls', revision);
  await mkdir(join(paths.originalRoot, 'fda-recalls', revision), { recursive: true });
  await mkdir(join(paths.dataRoot, 'datasets', 'fda-recalls', revision), { recursive: true });
  await mkdir(join(legacy, 'raw'), { recursive: true });
  await writeFile(join(paths.originalRoot, 'fda-recalls', revision, 'README.md'), body);
  await writeFile(join(paths.dataRoot, 'datasets', 'fda-recalls', revision, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(legacy, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(legacy, 'dataset.md'), cardContent(manifest) + '\nuser annotation');
  await writeFile(join(legacy, 'raw', 'README.md'), 'user edited');
  await writeFile(join(paths.vaultRoot, '.datawatch-assets.json'), JSON.stringify({ generated_by: 'datawatch-data', files: [
    { path: 'Evidence/datasets/fda-recalls/' + revision + '/raw/README.md', bytes: body.length, sha256 },
  ] }));
  await expect(migrateLegacyStorage(paths)).rejects.toThrow('CATALOG_USER_FILE_CONFLICT');
  expect(await readFile(join(legacy, 'dataset.md'), 'utf8')).toContain('user annotation');
  expect(await readFile(join(legacy, 'raw', 'README.md'), 'utf8')).toBe('user edited');
  expect(await readFile(join(paths.originalRoot, 'fda-recalls', revision, 'README.md'), 'utf8')).toBe(body);
});
