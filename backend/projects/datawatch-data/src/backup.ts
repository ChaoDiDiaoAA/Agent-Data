import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import type { DataWatchPaths } from './contracts.ts';
import { withRunLock } from './engine-bridge.ts';
import { pathExists, resolveOwnedPath, sha256, sha256File, writeAtomic, writeCanonicalJson } from './util.ts';

const backupSchema = 'datawatch-backup/1';

export interface BackupFile {
  path: string;
  bytes: number;
  sha256: string;
}
export interface BackupManifest {
  schema: typeof backupSchema;
  backup_id: string;
  created_at: string;
  archive: BackupFile;
  files: BackupFile[];
}
export interface BackupResult {
  path: string;
  manifestPath: string;
  manifest: BackupManifest;
}

function fail(code: string): never { throw new Error(code); }
function safeId(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail('BACKUP_INVALID_ID');
  return value;
}
function safeArchivePath(value: string): string {
  if (!value || value.includes('\\') || value.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(value)) fail('BACKUP_PATH_INVALID');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part))) fail('BACKUP_PATH_INVALID');
  return value;
}
async function collect(root: string, prefix: string, output: Record<string, Uint8Array>): Promise<void> {
  if (!(await pathExists(root))) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail('BACKUP_SYMLINK_REJECTED');
    const source = join(root, entry.name);
    const path = prefix + '/' + entry.name;
    if (entry.isDirectory()) {
      if (path === 'data/work') continue;
      await collect(source, path, output);
    } else if (entry.isFile()) {
      output[safeArchivePath(path)] = await readFile(source);
    } else {
      fail('BACKUP_FILE_INVALID');
    }
  }
}

export async function createBackupUnlocked(paths: DataWatchPaths, backupId: string): Promise<BackupResult> {
  safeId(backupId);
  const payload: Record<string, Uint8Array> = {};
  await collect(paths.originalRoot, 'original', payload);
  await collect(paths.dataRoot, 'data', payload);
  await collect(paths.vaultRoot, 'vault', payload);
  const archive = zipSync(payload, { level: 6 });
  const archiveSha256 = sha256(archive);
  const files = Object.entries(payload).map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest: BackupManifest = {
    schema: backupSchema,
    backup_id: backupId,
    created_at: new Date().toISOString(),
    archive: { path: backupId + '.zip', bytes: archive.byteLength, sha256: archiveSha256 },
    files,
  };
  await mkdir(paths.backupRoot, { recursive: true });
  const archivePath = join(paths.backupRoot, backupId + '.zip');
  await writeAtomic(archivePath, archive);
  const manifestPath = join(paths.backupRoot, backupId + '.manifest.json');
  await writeCanonicalJson(manifestPath, manifest);
  return { path: archivePath, manifestPath, manifest };
}

export async function createBackup(paths: DataWatchPaths, backupId = 'backup-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)): Promise<BackupResult> {
  return withRunLock(resolveOwnedPath(paths.dataRoot, 'work/run.lock'), () => createBackupUnlocked(paths, backupId), { jobId: `backup:${backupId}` });
}

function manifestPathForArchive(path: string): string {
  return path.toLowerCase().endsWith('.manifest.json') ? path : path.replace(/\.zip$/i, '.manifest.json');
}
export async function verifyBackup(path: string): Promise<BackupManifest> {
  const isLegacyManifest = path.toLowerCase().endsWith('.json') && !path.toLowerCase().endsWith('.manifest.json');
  const archivePath = path.toLowerCase().endsWith('.manifest.json') ? path.slice(0, -'.manifest.json'.length) + '.zip'
    : isLegacyManifest ? join(dirname(path), 'datawatch.zip') : path;
  let manifestText: string;
  try { manifestText = await readFile(manifestPathForArchive(archivePath), 'utf8'); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    manifestText = await readFile(join(dirname(archivePath), 'manifest.json'), 'utf8');
  }
  const manifest = JSON.parse(manifestText) as BackupManifest;
  if (manifest.schema !== backupSchema || !manifest.archive || !Array.isArray(manifest.files)) fail('BACKUP_MANIFEST_INVALID');
  const archive = await readFile(archivePath);
  if (archive.byteLength !== manifest.archive.bytes || sha256(archive) !== manifest.archive.sha256) fail('BACKUP_ARCHIVE_HASH_MISMATCH');
  const entries = unzipSync(archive);
  const expected = new Map(manifest.files.map(file => [safeArchivePath(file.path), file]));
  const actual = Object.keys(entries).sort();
  if (actual.length !== expected.size || actual.some(path => !expected.has(path))) fail('BACKUP_ENTRY_SET_MISMATCH');
  for (const path of actual) {
    const bytes = entries[path]!;
    const file = expected.get(path)!;
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) fail('BACKUP_FILE_HASH_MISMATCH');
  }
  return manifest;
}

export async function restoreBackup(path: string, destinations: { originalRoot: string; dataRoot: string; vaultRoot: string }): Promise<void> {
  const isLegacyManifest = path.toLowerCase().endsWith('.json') && !path.toLowerCase().endsWith('.manifest.json');
  const archivePath = path.toLowerCase().endsWith('.manifest.json') ? path.slice(0, -'.manifest.json'.length) + '.zip'
    : isLegacyManifest ? join(dirname(path), 'datawatch.zip') : path;
  const manifest = await verifyBackup(archivePath);
  const entries = unzipSync(await readFile(archivePath));
  for (const file of manifest.files) {
    const parts = file.path.split('/');
    const root = parts.shift();
    const destinationRoot = root === 'original' ? destinations.originalRoot : root === 'data' ? destinations.dataRoot : root === 'vault' ? destinations.vaultRoot : fail('BACKUP_ENTRY_ROOT_INVALID');
    const destination = join(destinationRoot, ...parts);
    await mkdir(dirname(destination), { recursive: true });
    if (await pathExists(destination)) {
      const info = await stat(destination);
      if (!info.isFile() || info.size !== file.bytes || await sha256File(destination) !== file.sha256) fail('BACKUP_RESTORE_CONFLICT');
      continue;
    }
    await writeFile(destination, entries[file.path]!);
  }
}

export async function restoreSmoke(path: string): Promise<{ files: number; bytes: number }> {
  const manifest = await verifyBackup(path);
  return { files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
}
