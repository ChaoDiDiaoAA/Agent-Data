import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { resolveOwnedPath } from './config.ts';
import { canonicalJson, realTree, withRunLock } from './engine-bridge.ts';
import { writeCanonicalJson } from './file-store.ts';
import { recoverPublications } from './publication.ts';
import type { FlowmatePaths } from './contracts.ts';

const backupSchema = 'flowmate-public-backup/1' as const;
const withdrawalSchema = 'flowmate-withdrawals/1' as const;
export const withdrawalListRelativePath = 'policies/withdrawals.json' as const;

const zipEntryLimit = 0xffff;
const zip64EndOfCentralDirectorySignature = 0x06064b50;
const zip64EndOfCentralDirectoryLocatorSignature = 0x07064b50;
const endOfCentralDirectorySignature = 0x06054b50;

export interface BackupFile { path: string; sha256: string; bytes: number }
export interface BackupManifest { schema: typeof backupSchema; backup_id: string; created_at: string; content_hash: string; archive: BackupFile; files: BackupFile[] }
export interface BackupResult { path: string; manifest: BackupManifest; files: BackupFile[] }
export interface BackupDestinationRoots { originalRoot: string; dataRoot: string; vaultRoot: string }
export interface RestoreBackupInput { backup: string; destinationRoots: BackupDestinationRoots; currentRoots: BackupDestinationRoots }
export interface WithdrawalEntry { dataset_id: string; sample_id: string; source_record_id?: string; reason: string; withdrawn_at: string }
export interface WithdrawalList { schema: typeof withdrawalSchema; entries: WithdrawalEntry[] }

export function withdrawalListPath(dataRoot: string): string { return resolveOwnedPath(dataRoot, withdrawalListRelativePath); }

function fail(code: string): never { throw new Error(code); }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

/**
 * fflate writes a classic ZIP footer, whose entry count is only 16 bits. A
 * Flowmate backup can contain more than 65,535 files once enough invoice
 * samples and Vault assets have accumulated. Keep the existing ZIP payload
 * and add a standards-compliant ZIP64 end-of-central-directory pair so
 * readers can recover the full entry count. Local and central file headers
 * remain unchanged because current backups stay below the 4 GiB offset/size
 * limits. Archives whose central directory or offsets exceed those classic
 * 32-bit fields are rejected explicitly below.
 */
export function zipPayload(payload: Record<string, Uint8Array>): Uint8Array {
  const archive = zipSync(payload, { level: 6 });
  const entryCount = Object.keys(payload).length;
  if (entryCount <= zipEntryLimit) return archive;
  if (entryCount > 0xffffffff) fail('BACKUP_ARCHIVE_TOO_MANY_FILES');

  // zipSync always emits an empty-comment EOCD as its final 22 bytes.
  const end = archive.length - 22;
  if (end < 0) fail('BACKUP_ARCHIVE_INVALID');
  const sourceView = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  if (sourceView.getUint32(end, true) !== endOfCentralDirectorySignature) fail('BACKUP_ARCHIVE_INVALID');
  const centralSize = sourceView.getUint32(end + 12, true);
  const centralOffset = sourceView.getUint32(end + 16, true);
  if (archive.byteLength > 0xffffffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('BACKUP_ARCHIVE_TOO_LARGE');
  const zip64Offset = end;
  const locatorOffset = zip64Offset + 56;
  const output = new Uint8Array(archive.length + 76);
  output.set(archive.subarray(0, end), 0);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  // ZIP64 end of central directory record (fixed 56 bytes).
  view.setUint32(zip64Offset, zip64EndOfCentralDirectorySignature, true);
  view.setBigUint64(zip64Offset + 4, 44n, true);
  view.setUint16(zip64Offset + 12, 45, true); // version made by
  view.setUint16(zip64Offset + 14, 45, true); // version needed
  view.setUint32(zip64Offset + 16, 0, true); // number of this disk
  view.setUint32(zip64Offset + 20, 0, true); // disk with central directory
  view.setBigUint64(zip64Offset + 24, BigInt(entryCount), true);
  view.setBigUint64(zip64Offset + 32, BigInt(entryCount), true);
  view.setBigUint64(zip64Offset + 40, BigInt(centralSize), true);
  view.setBigUint64(zip64Offset + 48, BigInt(centralOffset), true);

  // ZIP64 locator (fixed 20 bytes).
  view.setUint32(locatorOffset, zip64EndOfCentralDirectoryLocatorSignature, true);
  view.setUint32(locatorOffset + 4, 0, true);
  view.setBigUint64(locatorOffset + 8, BigInt(zip64Offset), true);
  view.setUint32(locatorOffset + 16, 1, true);

  // Preserve the original EOCD while replacing all classic fields that can
  // no longer represent the archive. ZIP readers use the ZIP64 record above.
  output.set(archive.subarray(end), end + 76);
  const outputEnd = end + 76;
  view.setUint16(outputEnd + 8, zipEntryLimit, true);
  view.setUint16(outputEnd + 10, zipEntryLimit, true);
  view.setUint32(outputEnd + 12, 0xffffffff, true);
  view.setUint32(outputEnd + 16, 0xffffffff, true);
  view.setUint16(outputEnd + 20, 0, true);
  return output;
}
function safeId(value: string): void { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail('BACKUP_INVALID_ID'); }
function safeRelative(value: string): string {
  if (typeof value !== 'string' || !value || /[\\:\u0000-\u001f\u007f]/u.test(value) || posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('BACKUP_PATH_INVALID');
  return value;
}
function safeWithdrawalValue(value: unknown, code = 'BACKUP_WITHDRAWAL_LIST_INVALID'): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}
function validateWithdrawalList(value: unknown): WithdrawalList {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('BACKUP_WITHDRAWAL_LIST_INVALID');
  const candidate = value as { schema?: unknown; entries?: unknown };
  if (candidate.schema !== withdrawalSchema || !Array.isArray(candidate.entries)) fail('BACKUP_WITHDRAWAL_LIST_INVALID');
  const entries = candidate.entries.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('BACKUP_WITHDRAWAL_LIST_INVALID');
    const entry = item as Record<string, unknown>;
    const allowed = new Set(['dataset_id', 'sample_id', 'source_record_id', 'reason', 'withdrawn_at']);
    if (Object.keys(entry).some(key => !allowed.has(key))) fail('BACKUP_WITHDRAWAL_LIST_INVALID');
    return {
      dataset_id: safeWithdrawalValue(entry.dataset_id),
      sample_id: safeWithdrawalValue(entry.sample_id),
      ...(entry.source_record_id === undefined ? {} : { source_record_id: safeWithdrawalValue(entry.source_record_id) }),
      reason: safeWithdrawalValue(entry.reason),
      withdrawn_at: safeWithdrawalValue(entry.withdrawn_at),
    } satisfies WithdrawalEntry;
  }).sort((left, right) => `${left.dataset_id}/${left.sample_id}`.localeCompare(`${right.dataset_id}/${right.sample_id}`));
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.dataset_id}/${entry.sample_id}`;
    if (keys.has(key)) fail('BACKUP_WITHDRAWAL_DUPLICATE');
    keys.add(key);
  }
  const normalized = { schema: withdrawalSchema, entries } satisfies WithdrawalList;
  if (canonicalJson(value) !== canonicalJson(normalized)) fail('BACKUP_WITHDRAWAL_LIST_INVALID');
  return normalized;
}
export async function loadWithdrawalList(path: string): Promise<WithdrawalList> {
  try {
    const bytes = await readFile(path, 'utf8');
    return validateWithdrawalList(JSON.parse(bytes));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { schema: withdrawalSchema, entries: [] };
    if (error instanceof SyntaxError) fail('BACKUP_WITHDRAWAL_LIST_INVALID');
    throw error;
  }
}
export async function saveWithdrawalList(dataRoot: string, list: WithdrawalList, options: { lockHeld?: boolean } = {}): Promise<void> {
  const normalized = validateWithdrawalList(list);
  const operation = () => writeCanonicalJson(withdrawalListPath(dataRoot), normalized);
  if (options.lockHeld) { await operation(); return; }
  await withRunLock(resolveOwnedPath(dataRoot, 'work/run.lock'), operation, { jobId: 'flowmate-withdrawals' });
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; } }
async function walk(source: string, prefix: string, include: (path: string) => Promise<boolean>, output: Array<{ relative: string; source: string }>): Promise<void> {
  if (!(await exists(source))) return;
  if ((await lstat(source)).isSymbolicLink()) fail('BACKUP_SYMLINK_REJECTED');
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const current = join(source, entry.name);
    const relativePath = `${prefix}/${entry.name}`;
    if (/^payload\/(data|original)\/work$/i.test(relativePath)) continue;
    if (entry.isSymbolicLink()) fail('BACKUP_SYMLINK_REJECTED');
    if (entry.isDirectory()) await walk(current, relativePath, include, output);
    else if (entry.isFile() && await include(current)) output.push({ relative: relativePath.replaceAll('\\', '/'), source: current });
    else if (!entry.isDirectory() && !entry.isFile()) fail('BACKUP_FILE_INVALID');
  }
}
async function generatedCatalog(path: string): Promise<boolean> {
  if (!path.toLowerCase().endsWith('.md')) return false;
  const text = await readFile(path, 'utf8');
  return text.startsWith('---\ngenerated_by: flowmate-data\n');
}
async function destinationForPayload(roots: BackupDestinationRoots, path: string): Promise<string> {
  const parts = path.split('/');
  if (parts.length < 3 || parts[0] !== 'payload') fail('BACKUP_PAYLOAD_INVALID');
  const root = parts[1] === 'original' ? roots.originalRoot : parts[1] === 'data' ? roots.dataRoot : parts[1] === 'vault' ? roots.vaultRoot : fail('BACKUP_PAYLOAD_INVALID');
  return resolveOwnedPath(root, parts.slice(2).join('/'));
}
function assertIndependentRoots(roots: BackupDestinationRoots): void {
  const values = Object.values(roots).map(value => resolve(value));
  if (values.some(value => !value || !/^[A-Za-z]:[\\/]/.test(value))) fail('BACKUP_DESTINATION_INVALID');
  for (let index = 0; index < values.length; index += 1) for (let next = index + 1; next < values.length; next += 1) {
    const left = values[index]!.toLowerCase(); const right = values[next]!.toLowerCase();
    if (left === right || left.startsWith(`${right}\\`) || right.startsWith(`${left}\\`)) fail('BACKUP_DESTINATION_OVERLAP');
  }
}
async function safeRootRealpath(root: string): Promise<string | undefined> {
  const resolved = resolve(root);
  const parsed = win32.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(current); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    if (info.isSymbolicLink()) fail('BACKUP_DESTINATION_SYMLINK');
    if (!info.isDirectory()) fail('BACKUP_DESTINATION_INVALID');
  }
  try {
    const actual = resolve(await realpath(resolved));
    if (actual.toLowerCase() !== resolved.toLowerCase()) fail('BACKUP_DESTINATION_SYMLINK');
    return actual;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function assertRestoreRoots(destinationRoots: BackupDestinationRoots, currentRoots: BackupDestinationRoots): Promise<void> {
  assertIndependentRoots(destinationRoots);
  assertIndependentRoots(currentRoots);
  const destinationReal = (await Promise.all(Object.values(destinationRoots).map(safeRootRealpath))).filter((value): value is string => value !== undefined).map(value => value.toLowerCase());
  const currentReal = (await Promise.all(Object.values(currentRoots).map(safeRootRealpath))).filter((value): value is string => value !== undefined).map(value => value.toLowerCase());
  for (const destination of destinationReal) for (const root of currentReal) {
    if (destination === root || destination.startsWith(`${root}\\`) || root.startsWith(`${destination}\\`)) fail('BACKUP_DESTINATION_CURRENT_ROOT');
  }
}

async function createBackupUnlocked(paths: FlowmatePaths, backupId: string): Promise<BackupResult> {
  safeId(backupId);
  await recoverPublications(paths);
  const staging = resolveOwnedPath(paths.backupRoot, `.work/${crypto.randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    const sources: Array<{ relative: string; source: string }> = [];
    await walk(paths.originalRoot, 'payload/original', async () => true, sources);
    await walk(paths.dataRoot, 'payload/data', async () => true, sources);
    const policyPath = withdrawalListPath(paths.dataRoot);
    if (await exists(policyPath)) {
      await loadWithdrawalList(policyPath);
    }
    await walk(paths.vaultRoot, 'payload/vault', async path => !(await generatedCatalog(path)), sources);
    const files: BackupFile[] = [];
    const payload: Record<string, Uint8Array> = Object.create(null);
    for (const source of sources.sort((left, right) => left.relative.localeCompare(right.relative))) {
      safeRelative(source.relative);
      const bytes = await readFile(source.source);
      payload[source.relative] = bytes;
      files.push({ path: source.relative, sha256: digest(bytes), bytes: bytes.byteLength });
    }
    const contentHash = digest(Buffer.from(canonicalJson({ backup_id: backupId, files })));
    const archiveBytes = zipPayload(payload);
    const manifest: BackupManifest = { schema: backupSchema, backup_id: backupId, created_at: new Date().toISOString(), content_hash: contentHash, archive: { path: 'data.zip', sha256: digest(archiveBytes), bytes: archiveBytes.byteLength }, files };
    await writeFile(join(staging, 'data.zip'), archiveBytes, { flag: 'wx' });
    await writeFile(join(staging, 'manifest.json'), canonicalJson(manifest), { flag: 'wx' });
    await verifyBackup(staging);
    await mkdir(paths.backupRoot, { recursive: true });
    for (const entry of await readdir(paths.backupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.work') continue;
      const candidate = join(paths.backupRoot, entry.name, 'manifest.json');
      if (await exists(candidate)) {
        let existing: BackupManifest | undefined;
        try { existing = JSON.parse(await readFile(candidate, 'utf8')) as BackupManifest; } catch { existing = undefined; }
        if (!existing) continue;
        if (existing.backup_id === backupId) {
          if (existing.content_hash !== contentHash) fail('BACKUP_ID_CONFLICT');
          const existingPath = join(paths.backupRoot, entry.name);
          const verifiedExisting = await verifyBackup(existingPath);
          return { path: existingPath, manifest: verifiedExisting.manifest, files: verifiedExisting.files };
        }
      }
    }
    // Allocate the next free second so independent backups never overwrite one another.
    let timestamp = new Date(manifest.created_at).getTime();
    let destination: string;
    do {
      const name = new Date(timestamp).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      destination = resolveOwnedPath(paths.backupRoot, name);
      timestamp += 1000;
    } while (await exists(destination));
    // Publish only after the archive and every payload checksum are verified.
    await mkdir(dirname(destination), { recursive: true });
    try { await rename(staging, destination); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code))) fail('BACKUP_DESTINATION_CONFLICT');
      throw error;
    }
    return { path: destination, manifest, files };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await rmdir(dirname(staging)).catch(() => undefined);
  }
}

export async function createBackup(paths: FlowmatePaths, backupId: string): Promise<BackupResult> {
  const lockPath = resolveOwnedPath(paths.dataRoot, 'work/run.lock');
  return withRunLock(lockPath, () => createBackupUnlocked(paths, backupId), { jobId: `backup:${backupId}` });
}

function validateFile(file: BackupFile): void {
  if (!file || typeof file !== 'object' || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('BACKUP_MANIFEST_INVALID');
  safeRelative(file.path);
}

async function readVerifiedBackup(path: string): Promise<BackupResult & { payload: Record<string, Uint8Array> }> {
  // realTree rejects symlinks before any archive or manifest is read.
  const actual = await realTree(path);
  if (actual.length !== 2 || !actual.includes('manifest.json') || !actual.includes('data.zip')) fail('BACKUP_FILE_SET_MISMATCH');
  const manifestBytes = await readFile(join(path, 'manifest.json'));
  let manifest: BackupManifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) as BackupManifest; }
  catch { fail('BACKUP_MANIFEST_INVALID'); }
  if (!manifest || manifestBytes.toString('utf8') !== canonicalJson(manifest) || manifest.schema !== backupSchema || !Array.isArray(manifest.files) || typeof manifest.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.content_hash) || typeof manifest.created_at !== 'string' || !Number.isFinite(Date.parse(manifest.created_at))) fail('BACKUP_MANIFEST_INVALID');
  safeId(manifest.backup_id);
  validateFile(manifest.archive);
  if (manifest.archive.path !== 'data.zip') fail('BACKUP_MANIFEST_INVALID');
  const expected = new Map<string, BackupFile>();
  const destinationNames = new Set<string>();
  for (const file of manifest.files) {
    validateFile(file);
    if (!/^payload\/(original|data|vault)\/.+/.test(file.path) || /^payload\/(original|data)\/work(?:\/|$)/i.test(file.path)) fail('BACKUP_PAYLOAD_INVALID');
    if (destinationNames.has(file.path.toLowerCase())) fail('BACKUP_FILE_SET_MISMATCH');
    destinationNames.add(file.path.toLowerCase());
    expected.set(file.path, file);
  }
  for (const name of destinationNames) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i += 1) if (destinationNames.has(parts.slice(0, i).join('/'))) fail('BACKUP_FILE_SET_MISMATCH');
  }
  if (digest(Buffer.from(canonicalJson({ backup_id: manifest.backup_id, files: manifest.files }))) !== manifest.content_hash) fail('BACKUP_CONTENT_HASH_MISMATCH');
  const archive = await readFile(join(path, 'data.zip'));
  if (archive.byteLength !== manifest.archive.bytes || digest(archive) !== manifest.archive.sha256) fail('BACKUP_CHECKSUM_MISMATCH');
  if (archive.byteLength < 22) fail('BACKUP_ARCHIVE_INVALID');
  const seen = new Set<string>();
  let payload: Record<string, Uint8Array>;
  try {
    payload = unzipSync(archive, { filter: entry => {
      safeRelative(entry.name);
      const file = expected.get(entry.name);
      if (!file || seen.has(entry.name)) fail('BACKUP_FILE_SET_MISMATCH');
      if (entry.originalSize !== file.bytes) fail('BACKUP_CHECKSUM_MISMATCH');
      seen.add(entry.name);
      return true;
    } });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('BACKUP_')) throw error;
    fail('BACKUP_ARCHIVE_INVALID');
  }
  if (seen.size !== expected.size || Object.keys(payload).length !== expected.size) fail('BACKUP_FILE_SET_MISMATCH');
  for (const file of manifest.files) {
    const bytes = payload[file.path];
    if (!bytes || bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256) fail('BACKUP_CHECKSUM_MISMATCH');
  }
  return { path, manifest, files: manifest.files, payload };
}

export async function verifyBackup(path: string): Promise<BackupResult> {
  const { payload: _payload, ...result } = await readVerifiedBackup(path);
  return result;
}

async function verifyRestoredFileSet(backup: string, roots: BackupDestinationRoots, currentList?: WithdrawalList): Promise<void> {
  const verified = await readVerifiedBackup(backup);
  const expected = new Set<string>();
  for (const file of verified.manifest.files) {
    const destination = await destinationForPayload(roots, file.path);
    const bytes = file.path === `payload/data/${withdrawalListRelativePath}` && currentList
      ? Buffer.from(canonicalJson(currentList))
      : verified.payload[file.path]!;
    if (!(await exists(destination))) fail('BACKUP_RESTORE_MISSING');
    const restored = await readFile(destination);
    if (digest(restored) !== digest(bytes) || restored.byteLength !== bytes.byteLength) fail('BACKUP_RESTORE_CHECKSUM_MISMATCH');
    expected.add(destination.toLowerCase());
  }
  if (currentList) {
    // The current policy is authoritative even when the frozen backup did not
    // contain a policy file. Verify the restored destination independently so
    // deletion or tampering cannot hide behind the backup file set.
    const policyDestination = withdrawalListPath(roots.dataRoot);
    const policyBytes = Buffer.from(canonicalJson(currentList));
    if (!(await exists(policyDestination))) fail('BACKUP_RESTORE_MISSING');
    const restoredPolicy = await readFile(policyDestination);
    if (digest(restoredPolicy) !== digest(policyBytes) || restoredPolicy.byteLength !== policyBytes.byteLength) fail('BACKUP_RESTORE_CHECKSUM_MISMATCH');
    expected.add(policyDestination.toLowerCase());
  }
  for (const root of Object.values(roots)) {
    if (!(await exists(root))) continue;
    for (const name of (await realTree(root)).filter(value => !value.endsWith('/'))) {
      if (root.toLowerCase() === roots.dataRoot.toLowerCase() && resolve(root, name).toLowerCase() === resolve(roots.dataRoot, 'work/run.lock').toLowerCase()) continue;
      if (!expected.has(resolve(root, name).toLowerCase())) fail('BACKUP_RESTORE_FILE_SET_MISMATCH');
    }
  }
}
async function verifyRestoredBackupUnlocked(input: RestoreBackupInput): Promise<void> {
  await assertRestoreRoots(input.destinationRoots, input.currentRoots);
  const destinations = Object.values(input.destinationRoots).map(value => resolve(value).toLowerCase());
  const current = Object.values(input.currentRoots).map(value => resolve(value).toLowerCase());
  for (const destination of destinations) for (const root of current) {
    if (destination === root || destination.startsWith(`${root}\\`) || root.startsWith(`${destination}\\`)) fail('BACKUP_DESTINATION_CURRENT_ROOT');
  }
  const currentPolicy = withdrawalListPath(input.currentRoots.dataRoot);
  const hasCurrentPolicy = await exists(currentPolicy);
  const currentList = hasCurrentPolicy ? await loadWithdrawalList(currentPolicy) : undefined;
  await verifyRestoredFileSet(input.backup, input.destinationRoots, currentList);
}

export async function verifyRestoredBackup(input: RestoreBackupInput): Promise<void> {
  await assertRestoreRoots(input.destinationRoots, input.currentRoots);
  return withRunLock(resolveOwnedPath(input.currentRoots.dataRoot, 'work/run.lock'), () =>
    withRunLock(resolveOwnedPath(input.destinationRoots.dataRoot, 'work/run.lock'), () => verifyRestoredBackupUnlocked(input), { jobId: 'backup-verify-destination' }),
    { jobId: 'backup-verify-source' });
}

async function restoreBackupUnlocked(input: RestoreBackupInput): Promise<void> {
  await assertRestoreRoots(input.destinationRoots, input.currentRoots);
  const destinations = Object.values(input.destinationRoots).map(value => resolve(value).toLowerCase());
  const current = Object.values(input.currentRoots).map(value => resolve(value).toLowerCase());
  for (const destination of destinations) for (const root of current) {
    if (destination === root || destination.startsWith(`${root}\\`) || root.startsWith(`${destination}\\`)) fail('BACKUP_DESTINATION_CURRENT_ROOT');
  }
  const currentPolicy = withdrawalListPath(input.currentRoots.dataRoot);
  const hasCurrentPolicy = await exists(currentPolicy);
  const currentList = hasCurrentPolicy ? await loadWithdrawalList(currentPolicy) : undefined;
  const verified = await readVerifiedBackup(input.backup);
  for (const file of verified.manifest.files) {
    const destination = await destinationForPayload(input.destinationRoots, file.path);
    if (file.path === `payload/data/${withdrawalListRelativePath}` && currentList) continue;
    if (await exists(destination)) {
      const existing = await readFile(destination);
      if (digest(existing) !== file.sha256) fail('BACKUP_RESTORE_CONFLICT');
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, verified.payload[file.path]!, { flag: 'wx' });
  }
  if (currentList) {
    await saveWithdrawalList(input.destinationRoots.dataRoot, currentList, { lockHeld: true });
  }
  await verifyRestoredBackupUnlocked(input);
}

export async function restoreBackup(input: RestoreBackupInput): Promise<void> {
  await assertRestoreRoots(input.destinationRoots, input.currentRoots);
  return withRunLock(resolveOwnedPath(input.currentRoots.dataRoot, 'work/run.lock'), () =>
    withRunLock(resolveOwnedPath(input.destinationRoots.dataRoot, 'work/run.lock'), () => restoreBackupUnlocked(input), { jobId: 'backup-restore-destination' }),
    { jobId: 'backup-restore-source' });
}
