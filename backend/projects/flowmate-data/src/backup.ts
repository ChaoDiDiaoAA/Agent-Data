import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { resolveOwnedPath } from './config.ts';
import { canonicalJson, realTree, withRunLock } from './engine-bridge.ts';
import { writeCanonicalJson } from './file-store.ts';
import type { FlowmatePaths } from './contracts.ts';

const backupSchema = 'flowmate-public-backup/1' as const;
const withdrawalSchema = 'flowmate-withdrawals/1' as const;
export const withdrawalListRelativePath = 'policies/withdrawals.json' as const;

export interface BackupFile { path: string; sha256: string; bytes: number }
export interface BackupManifest { schema: typeof backupSchema; backup_id: string; created_at: string; content_hash: string; files: BackupFile[] }
export interface BackupResult { path: string; manifest: BackupManifest; files: BackupFile[] }
export interface BackupDestinationRoots { originalRoot: string; dataRoot: string; vaultRoot: string }
export interface RestoreBackupInput { backup: string; destinationRoots: BackupDestinationRoots; currentRoots: BackupDestinationRoots }
export interface WithdrawalEntry { dataset_id: string; sample_id: string; source_record_id?: string; reason: string; withdrawn_at: string }
export interface WithdrawalList { schema: typeof withdrawalSchema; entries: WithdrawalEntry[] }

export function withdrawalListPath(dataRoot: string): string { return resolveOwnedPath(dataRoot, withdrawalListRelativePath); }

function fail(code: string): never { throw new Error(code); }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function safeId(value: string): void { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail('BACKUP_INVALID_ID'); }
function safeRelative(value: string): string {
  if (!value || value.includes('\\') || value.includes(':') || posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail('BACKUP_PATH_INVALID');
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
function backupPath(root: string, value: string): string { return resolveOwnedPath(root, safeRelative(value)); }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; } }
async function walk(source: string, prefix: string, include: (path: string) => Promise<boolean>, output: Array<{ relative: string; source: string }>): Promise<void> {
  if (!(await exists(source))) return;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const current = join(source, entry.name);
    const relativePath = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) fail('BACKUP_SYMLINK_REJECTED');
    if (entry.isDirectory()) await walk(current, relativePath, include, output);
    else if (entry.isFile() && await include(current)) output.push({ relative: relativePath.replaceAll('\\', '/'), source: current });
    else if (!entry.isDirectory() && !entry.isFile()) fail('BACKUP_FILE_INVALID');
  }
}
async function writeStagedFile(staging: string, relativePath: string, source: string): Promise<BackupFile> {
  const target = backupPath(staging, relativePath);
  const bytes = await readFile(source);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
  return { path: relativePath, sha256: digest(bytes), bytes: bytes.byteLength };
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
  const staging = resolveOwnedPath(paths.backupRoot, `.work/${crypto.randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    const sources: Array<{ relative: string; source: string }> = [];
    await walk(paths.originalRoot, 'payload/original', async () => true, sources);
    await walk(resolveOwnedPath(paths.dataRoot, 'datasets'), 'payload/data/datasets', async () => true, sources);
    await walk(resolveOwnedPath(paths.dataRoot, 'releases'), 'payload/data/releases', async () => true, sources);
    const policyPath = withdrawalListPath(paths.dataRoot);
    if (await exists(policyPath)) {
      await loadWithdrawalList(policyPath);
      sources.push({ relative: `payload/data/${withdrawalListRelativePath}`, source: policyPath });
    }
    await walk(paths.vaultRoot, 'payload/vault', async path => !(await generatedCatalog(path)), sources);
    const files: BackupFile[] = [];
    for (const source of sources.sort((left, right) => left.relative.localeCompare(right.relative))) files.push(await writeStagedFile(staging, source.relative, source.source));
    const contentHash = digest(Buffer.from(canonicalJson({ backup_id: backupId, files })));
    const manifest: BackupManifest = { schema: backupSchema, backup_id: backupId, created_at: new Date().toISOString(), content_hash: contentHash, files };
    await writeFile(join(staging, 'manifest.json'), canonicalJson(manifest), { flag: 'wx' });
    const checksums = { schema: backupSchema, files: [...files, { path: 'manifest.json', sha256: digest(Buffer.from(canonicalJson(manifest))), bytes: Buffer.byteLength(canonicalJson(manifest)) }].sort((left, right) => left.path.localeCompare(right.path)) };
    await writeFile(join(staging, 'checksums.json'), canonicalJson(checksums), { flag: 'wx' });
    await verifyBackup(staging);
    await mkdir(paths.backupRoot, { recursive: true });
    const destination = resolveOwnedPath(paths.backupRoot, `${manifest.created_at.slice(0, 10)}-${contentHash.slice(0, 12)}`);
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
    if (await exists(destination)) fail('BACKUP_DESTINATION_CONFLICT');
    // A backup directory is published only after its manifest and every checksum is verified.
    await mkdir(dirname(destination), { recursive: true });
    try { await rename(staging, destination); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code))) fail('BACKUP_DESTINATION_CONFLICT');
      throw error;
    }
    return { path: destination, manifest, files };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function createBackup(paths: FlowmatePaths, backupId: string): Promise<BackupResult> {
  const lockPath = resolveOwnedPath(paths.dataRoot, 'work/run.lock');
  return withRunLock(lockPath, () => createBackupUnlocked(paths, backupId), { jobId: `backup:${backupId}` });
}

export async function verifyBackup(path: string): Promise<BackupResult> {
  const manifestBytes = await readFile(join(path, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as BackupManifest;
  if (manifestBytes.toString('utf8') !== canonicalJson(manifest) || manifest.schema !== backupSchema || !Array.isArray(manifest.files) || !/^[0-9a-f]{64}$/.test(manifest.content_hash)) fail('BACKUP_MANIFEST_INVALID');
  const checksumBytes = await readFile(join(path, 'checksums.json'));
  const checksums = JSON.parse(checksumBytes.toString('utf8')) as { schema?: string; files?: BackupFile[] };
  if (checksumBytes.toString('utf8') !== canonicalJson(checksums) || checksums.schema !== backupSchema || !Array.isArray(checksums.files) || checksums.files.some(file => file.path === 'checksums.json')) fail('BACKUP_CHECKSUMS_INVALID');
  const actual = new Set((await realTree(path)).filter(name => !name.endsWith('/')));
  const expected = new Set(['manifest.json', 'checksums.json', ...checksums.files.map(file => file.path)]);
  if (actual.size !== expected.size || [...actual].some(file => !expected.has(file))) fail('BACKUP_FILE_SET_MISMATCH');
  const manifestFiles = new Set(manifest.files.map(file => file.path));
  const checksumPayload = checksums.files.filter(file => file.path !== 'manifest.json');
  if (manifestFiles.size !== checksumPayload.length || checksumPayload.some(file => !manifestFiles.has(file.path))) fail('BACKUP_FILE_SET_MISMATCH');
  for (const file of checksums.files) {
    safeRelative(file.path);
    const bytes = await readFile(backupPath(path, file.path));
    if (digest(bytes) !== file.sha256 || bytes.byteLength !== file.bytes) fail('BACKUP_CHECKSUM_MISMATCH');
  }
  const manifestChecksum = checksums.files.find(file => file.path === 'manifest.json');
  if (!manifestChecksum || manifestChecksum.sha256 !== digest(manifestBytes)) fail('BACKUP_MANIFEST_CHECKSUM_MISMATCH');
  if (digest(Buffer.from(canonicalJson({ backup_id: manifest.backup_id, files: manifest.files }))) !== manifest.content_hash) fail('BACKUP_CONTENT_HASH_MISMATCH');
  return { path, manifest, files: manifest.files };
}

async function verifyRestoredFileSet(backup: string, roots: BackupDestinationRoots, currentList?: WithdrawalList): Promise<void> {
  const verified = await verifyBackup(backup);
  const expected = new Set<string>();
  for (const file of verified.manifest.files) {
    const destination = await destinationForPayload(roots, file.path);
    const payloadPath = file.path === `payload/data/${withdrawalListRelativePath}` && currentList
      ? undefined
      : backupPath(backup, file.path);
    const bytes = payloadPath ? await readFile(payloadPath) : Buffer.from(canonicalJson(currentList));
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
  const verified = await verifyBackup(input.backup);
  for (const file of verified.manifest.files) {
    const destination = await destinationForPayload(input.destinationRoots, file.path);
    const source = backupPath(input.backup, file.path);
    if (file.path === `payload/data/${withdrawalListRelativePath}` && currentList) continue;
    if (await exists(destination)) {
      const existing = await readFile(destination);
      if (digest(existing) !== file.sha256) fail('BACKUP_RESTORE_CONFLICT');
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source), { flag: 'wx' });
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
