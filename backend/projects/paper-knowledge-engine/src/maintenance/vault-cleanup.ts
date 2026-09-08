import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonicalJson, hashCanonical } from '../shared/manifest.ts';
import { LEGACY_EVIDENCE_ROOT } from '../shared/historical-compatibility.ts';

/** The legacy paths are intentionally a closed list from design section 6.2. */
export const LEGACY_VAULT_PATHS = [
  '00-Home', '00-Inbox', '01-Paper-Notes', '02-AI-Techniques',
  '03-Modernization-Lifecycle', '04-Engineering-Methods', '05-Migration-Targets',
  '06-Evidence', '07-Evaluation-Methods', '08-Templates', '09-Case-Studies', '99-Meta', 'log.md',
] as const;

export type LegacyVaultPath = typeof LEGACY_VAULT_PATHS[number];
export type VaultCleanupClassification = 'empty' | 'known_placeholder' | 'manual_content' | 'unsafe' | 'changed';

export interface VaultCleanupCandidate {
  path: LegacyVaultPath;
  classification: VaultCleanupClassification;
  exists: boolean;
  sha256: string;
  fileCount: number;
  bytes: number;
  reason?: string;
}
export interface VaultCleanupPlan {
  schemaVersion: 1;
  candidates: VaultCleanupCandidate[];
  planSha256: string;
}
/** Local-only inspection data. Do not put resolved paths into public job DTOs. */
export interface VaultCleanupReview extends VaultCleanupPlan {
  resolvedVaultRoot: string;
  resolvedCandidates: Array<VaultCleanupCandidate & { resolvedTarget: string }>;
  obsidianSha256: string;
}
export interface VaultCleanupApplyResult {
  operationId: string;
  planSha256: string;
  backupRoot: string;
  moved: Array<{ path: LegacyVaultPath; fileCount: number; bytes: number }>;
  skipped: Array<{ path: LegacyVaultPath; classification: VaultCleanupClassification }>;
  recoverySnapshotSha256: string;
}

/**
 * Legacy placeholders are identified by exact immutable file hashes, not names.
 * A user who edits even one formerly-generated placeholder has manual content;
 * it must never become eligible for an automatic recovery move.
 */
const KNOWN_PLACEHOLDERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '00-Home': {
    'Knowledge-Base-Overview.md': '80c902687a5b60824a144fe75b99a9136f3755a5ad5898ddaa40adcd2af02de9',
    'Modernization-Roadmap.md': '81da8d454b78c819f4bdc651ae7c8f3d6a76cb929ff149d463ab1db31de5c514',
    'Reading-Queue.md': '0c15245b2f23a23dc9d304f531dfca0237cff10210c55df98e3531f0e53fce28',
    'Research-Scope.md': '94b30b29379393432478f4a4d5aa21f7c4a3974f29058e86849b119de1eee5df',
    'Weekly-Updates.md': 'b17b057fa91855f650b233ed534d67ceffb911a304d200828c4023a5aa29d6ee',
  },
  '08-Templates': {
    'claim-note.md': '064119f2e374692e8defe5927f0a8946fbab27e59f7b86112b431069b013ad0e',
    'evidence-matrix.md': '1c1bc80505e4d786dbfdae3edc86b6d07af3b3b83dfc74be0d4eb83ddd836222',
    'knowledge-feedback.md': '481a97fb5cd89691467482bf6013a2b764a69952a3b9162748f0d37a446cb73c',
    'paper-note.md': '47fc60703b76784b209089dff9d8a0efe87596262e9ab84e0ec054c57ad8a64b',
    'weekly-report.md': 'ec96f57b7d6c23867ad9997f0e30ec460d51b1ba90d731591b995c69a0d8ee35',
    'wiki-index.md': '75cffd8f88ba233ed8d3fbec2a3e9af1ec7facf61a9666448bb6362ea7ae79a0',
    'wiki-lint-report.md': '97d1881243d9dea9b9731b93ab6f2ac0f2b65898431b621973edb02a25d34d53',
    'wiki-log.md': '2a138f1d71e5ef9671ccf395e1a789204319a53a7305ed639dc8a27b6105cd4c',
    'wiki-page.md': '33130e56222e687f5ef09abbe9d892ac945f9a9cd59536b71bf46c65d823a4f0',
  },
};
const protectedPaths = new Set(['.obsidian', LEGACY_EVIDENCE_ROOT, 'index.md', 'README.md']);
const hidden = (name: string) => name.startsWith('.');
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function isInside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function candidatePath(vaultRoot: string, path: LegacyVaultPath): string {
  if (!LEGACY_VAULT_PATHS.includes(path)) throw new Error(`VAULT_CLEANUP_UNSAFE: non-allowlisted target ${path}`);
  if (protectedPaths.has(path) || path.includes('/') || path.includes('\\')) {
    throw new Error(`VAULT_CLEANUP_UNSAFE: protected target ${path}`);
  }
  const target = resolve(vaultRoot, path);
  if (!isInside(vaultRoot, target)) throw new Error(`VAULT_CLEANUP_UNSAFE: target escapes Vault ${path}`);
  return target;
}
async function assertNoLink(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`VAULT_CLEANUP_UNSAFE: link or reparse point at ${label}`);
}
async function safeVaultRoot(root: string): Promise<string> {
  const declared = resolve(root);
  await assertNoLink(declared, 'Vault root');
  const resolved = await realpath(declared);
  if (resolved !== declared) throw new Error('VAULT_CLEANUP_UNSAFE: Vault root resolves through a link or reparse point');
  if (resolve(resolved).endsWith(`${sep}.obsidian`)) throw new Error('VAULT_CLEANUP_UNSAFE: Vault root must not be .obsidian');
  return resolved;
}

type TreeFile = { path: string; sha256: string; bytes: number };
type InspectedTree = { exists: boolean; files: TreeFile[]; unsafeReason?: string };
async function inspectTree(root: string, relativePath = ''): Promise<InspectedTree> {
  let info;
  try { info = await lstat(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, files: [] }; throw error; }
  if (info.isSymbolicLink()) return { exists: true, files: [], unsafeReason: `link or reparse point: ${relativePath || '.'}` };
  if (hidden(relativePath.split('/').at(-1) ?? '')) return { exists: true, files: [], unsafeReason: `unexpected hidden content: ${relativePath}` };
  if (info.isFile()) {
    const bytes = await readFile(root);
    return { exists: true, files: [{ path: relativePath, sha256: sha256(bytes), bytes: bytes.byteLength }] };
  }
  if (!info.isDirectory()) return { exists: true, files: [], unsafeReason: `unsupported filesystem entry: ${relativePath || '.'}` };
  const entries = await readdir(root, { withFileTypes: true });
  const files: TreeFile[] = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const nested = await inspectTree(join(root, entry.name), childRelative);
    if (nested.unsafeReason) return nested;
    files.push(...nested.files);
  }
  return { exists: true, files };
}
function treeHash(files: readonly TreeFile[]): string { return hashCanonical(files); }
function knownPlaceholder(path: LegacyVaultPath, files: readonly TreeFile[]): boolean {
  const expected = KNOWN_PLACEHOLDERS[path];
  if (!expected || files.length !== Object.keys(expected).length) return false;
  return files.every(file => expected[file.path] === file.sha256);
}
function classify(path: LegacyVaultPath, tree: InspectedTree): Omit<VaultCleanupCandidate, 'path'> {
  const files = tree.files.sort((left, right) => compareText(left.path, right.path));
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  if (tree.unsafeReason) return { classification: 'unsafe', exists: tree.exists, sha256: treeHash(files), fileCount: files.length, bytes, reason: tree.unsafeReason };
  if (files.length === 0) return { classification: 'empty', exists: tree.exists, sha256: treeHash(files), fileCount: 0, bytes: 0 };
  if (knownPlaceholder(path, files)) return { classification: 'known_placeholder', exists: true, sha256: treeHash(files), fileCount: files.length, bytes };
  return { classification: 'manual_content', exists: true, sha256: treeHash(files), fileCount: files.length, bytes };
}
function publicPlan(candidates: VaultCleanupCandidate[]): VaultCleanupPlan {
  const canonicalCandidates = [...candidates].sort((left, right) => compareText(left.path, right.path));
  return { schemaVersion: 1, candidates: canonicalCandidates, planSha256: hashCanonical({ schemaVersion: 1, candidates: canonicalCandidates }) };
}
async function directoryFingerprint(path: string): Promise<string> {
  try { return treeHash((await inspectTree(path)).files); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return hashCanonical([]); throw error; }
}

/** Read-only inspection. It creates no Vault, backup, state, or temporary directory. */
export async function createVaultCleanupReview(input: { vaultRoot: string }): Promise<VaultCleanupReview> {
  const vaultRoot = await safeVaultRoot(input.vaultRoot);
  const resolvedCandidates: VaultCleanupReview['resolvedCandidates'] = [];
  for (const path of LEGACY_VAULT_PATHS) {
    const target = candidatePath(vaultRoot, path);
    const candidate = { path, ...classify(path, await inspectTree(target)) };
    resolvedCandidates.push({ ...candidate, resolvedTarget: target });
  }
  const plan = publicPlan(resolvedCandidates.map(({ resolvedTarget: _resolvedTarget, ...candidate }) => candidate));
  return { ...plan, resolvedVaultRoot: vaultRoot, resolvedCandidates, obsidianSha256: await directoryFingerprint(join(vaultRoot, '.obsidian')) };
}
/** Explicit sanitized shape for CLI / public transport. */
export function publicVaultCleanupPlan(review: VaultCleanupReview): VaultCleanupPlan { return publicPlan(review.candidates); }

function assertPlanSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('VAULT_CLEANUP_CONFLICT: plan SHA-256 must be lowercase hexadecimal');
}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    // Windows realpath(D:\\) is permitted to report D:; keep it a volume root
    // rather than resolving it relative to the current directory.
    const withoutExtendedPrefix = value.replace(/^\\\\\?\\/, '');
    const resolved = /^[A-Za-z]:$/.test(withoutExtendedPrefix) ? `${withoutExtendedPrefix}\\` : resolve(withoutExtendedPrefix);
    const root = parse(resolved).root;
    return resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
  };
  const leftResolved = normalize(left);
  const rightResolved = normalize(right);
  return process.platform === 'win32'
    ? leftResolved.toLocaleLowerCase('en-US') === rightResolved.toLocaleLowerCase('en-US')
    : leftResolved === rightResolved;
}

/**
 * Creates and validates every directory component one at a time.  A recursive
 * mkdir followed by a final lstat is insufficient: an existing junction in an
 * ancestor would already have redirected the operation before that check.
 */
async function ensureSafeDirectoryPath(path: string, label: string): Promise<string> {
  const declared = resolve(path);
  const volumeRoot = parse(declared).root;
  if (!volumeRoot) throw new Error(`VAULT_CLEANUP_UNSAFE: invalid ${label}`);
  const relativeParts = relative(volumeRoot, declared).split(/[\\/]+/).filter(Boolean);
  let current = volumeRoot;
  // Validate the volume root as well: callers must not inherit an implicit
  // redirected ancestor before creating the configured backup path.
  await assertNoLink(current, label);
  if (!samePath(await realpath(current), current)) {
    throw new Error(`VAULT_CLEANUP_UNSAFE: ${label} resolves through a link or reparse point`);
  }
  for (const part of relativeParts) {
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`VAULT_CLEANUP_UNSAFE: link or reparse point at ${label}`);
    }
    const actual = await realpath(current);
    if (!samePath(actual, current)) {
      throw new Error(`VAULT_CLEANUP_UNSAFE: ${label} resolves through a link or reparse point`);
    }
  }
  const info = await lstat(declared);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`VAULT_CLEANUP_UNSAFE: link or reparse point at ${label}`);
  const actual = await realpath(declared);
  if (!samePath(actual, declared)) throw new Error(`VAULT_CLEANUP_UNSAFE: ${label} resolves through a link or reparse point`);
  return actual;
}

async function assertSafeDirectoryPath(path: string, label: string): Promise<string> {
  const declared = resolve(path);
  const volumeRoot = parse(declared).root;
  if (!volumeRoot) throw new Error(`VAULT_CLEANUP_UNSAFE: invalid ${label}`);
  const relativeParts = relative(volumeRoot, declared).split(/[\\/]+/).filter(Boolean);
  let current = volumeRoot;
  await assertNoLink(current, label);
  if (!samePath(await realpath(current), current)) {
    throw new Error(`VAULT_CLEANUP_UNSAFE: ${label} resolves through a link or reparse point`);
  }
  for (const part of relativeParts) {
    current = join(current, part);
    await assertNoLink(current, label);
    const info = await lstat(current);
    if (!info.isDirectory()) throw new Error(`VAULT_CLEANUP_UNSAFE: non-directory at ${label}`);
    const actual = await realpath(current);
    if (!samePath(actual, current)) throw new Error(`VAULT_CLEANUP_UNSAFE: ${label} resolves through a link or reparse point`);
  }
  return declared;
}

async function assertSafeBackupRoot(vaultRoot: string, backupRoot: string): Promise<string> {
  const declared = resolve(backupRoot);
  if (declared === vaultRoot || isInside(vaultRoot, declared) || isInside(declared, vaultRoot)) {
    throw new Error('VAULT_CLEANUP_UNSAFE: backup root must be separate from Vault');
  }
  return ensureSafeDirectoryPath(declared, 'backup root');
}
async function createSafeOperationDirectories(backupRoot: string, operationId: string): Promise<{ operationRoot: string; targetRoot: string }> {
  const cleanupRoot = join(backupRoot, 'vault-cleanup');
  await ensureSafeDirectoryPath(cleanupRoot, 'backup cleanup root');
  const operationRoot = join(cleanupRoot, operationId);
  try {
    await lstat(operationRoot);
    throw new Error('VAULT_CLEANUP_CONFLICT: backup operation already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(operationRoot);
  await assertSafeDirectoryPath(operationRoot, 'backup operation root');
  const targetRoot = join(operationRoot, 'targets');
  await mkdir(targetRoot);
  await assertSafeDirectoryPath(targetRoot, 'backup targets root');
  return { operationRoot, targetRoot };
}
async function revalidateBackupOperationPaths(backupRoot: string, operationRoot: string, targetRoot: string): Promise<void> {
  await assertSafeDirectoryPath(backupRoot, 'backup root');
  await assertSafeDirectoryPath(join(backupRoot, 'vault-cleanup'), 'backup cleanup root');
  await assertSafeDirectoryPath(operationRoot, 'backup operation root');
  await assertSafeDirectoryPath(targetRoot, 'backup targets root');
}
function eligible(candidate: VaultCleanupCandidate): boolean {
  return candidate.classification === 'empty' || candidate.classification === 'known_placeholder';
}

/**
 * Performs only an explicitly confirmed, hash-bound, same-volume recovery move.
 * Manual content is never moved; unsafe or changed paths abort before mutation.
 */
export async function applyVaultCleanup(input: { vaultRoot: string; backupRoot: string; planSha256: string; confirmed: boolean; operationId?: string }): Promise<VaultCleanupApplyResult> {
  if (!input.confirmed) throw new Error('VAULT_CLEANUP_CONFIRMATION_REQUIRED: apply requires execution-time confirmation');
  assertPlanSha256(input.planSha256);
  const before = await createVaultCleanupReview({ vaultRoot: input.vaultRoot });
  if (before.planSha256 !== input.planSha256) throw new Error('VAULT_CLEANUP_CONFLICT: reviewed plan SHA-256 no longer matches Vault');
  if (before.candidates.some(candidate => candidate.classification === 'unsafe' || candidate.classification === 'changed')) {
    throw new Error('VAULT_CLEANUP_BLOCKED: unsafe or changed legacy candidate requires manual investigation');
  }
  const backupRoot = await assertSafeBackupRoot(before.resolvedVaultRoot, input.backupRoot);
  const operationId = input.operationId ?? randomUUID();
  if (!/^[A-Za-z0-9._-]+$/.test(operationId)) throw new Error('VAULT_CLEANUP_UNSAFE: invalid operation id');
  const requestedOperationRoot = resolve(backupRoot, 'vault-cleanup', operationId);
  if (!isInside(backupRoot, requestedOperationRoot)) throw new Error('VAULT_CLEANUP_UNSAFE: backup operation escapes backup root');
  const { operationRoot, targetRoot } = await createSafeOperationDirectories(backupRoot, operationId);
  const snapshot = {
    schemaVersion: 1,
    operationId,
    planSha256: before.planSha256,
    vaultRoot: before.resolvedVaultRoot,
    createdAt: new Date().toISOString(),
    obsidianSha256: before.obsidianSha256,
    candidates: before.candidates,
  };
  const snapshotText = canonicalJson(snapshot);
  const recoverySnapshotSha256 = sha256(snapshotText);
  // This validation is deliberately immediately adjacent to the first write.
  // It closes the window between directory construction and snapshot creation.
  await revalidateBackupOperationPaths(backupRoot, operationRoot, targetRoot);
  await writeFile(join(operationRoot, 'recovery-snapshot.json'), snapshotText, { flag: 'wx' });
  if (sha256(await readFile(join(operationRoot, 'recovery-snapshot.json'))) !== recoverySnapshotSha256) {
    throw new Error('VAULT_CLEANUP_CONFLICT: recovery snapshot verification failed');
  }
  const moved: VaultCleanupApplyResult['moved'] = [];
  const skipped: VaultCleanupApplyResult['skipped'] = [];
  for (const candidate of before.candidates) {
    if (!eligible(candidate) || !candidate.exists) { skipped.push({ path: candidate.path, classification: candidate.classification }); continue; }
    const target = candidatePath(before.resolvedVaultRoot, candidate.path);
    const destination = resolve(targetRoot, candidate.path);
    if (!isInside(targetRoot, destination)) throw new Error(`VAULT_CLEANUP_UNSAFE: backup target escapes snapshot ${candidate.path}`);
    // Re-hash immediately before the move. The plan hash protects the whole tree;
    // this protects the individual target against a time-of-check/time-of-use change.
    const current = classify(candidate.path, await inspectTree(target));
    if (current.exists !== candidate.exists || current.classification !== candidate.classification || current.sha256 !== candidate.sha256) {
      throw new Error(`VAULT_CLEANUP_CONFLICT: target changed after dry-run: ${candidate.path}`);
    }
    try { await lstat(destination); throw new Error(`VAULT_CLEANUP_CONFLICT: backup target already exists: ${candidate.path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Validate every backup ancestor again immediately before its rename.  Do
    // not trust a path merely because it was safe when this operation began.
    await revalidateBackupOperationPaths(backupRoot, operationRoot, targetRoot);
    try { await rename(target, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new Error('VAULT_CLEANUP_RECOVERY_MOVE_REQUIRED: backup root must be on the same filesystem as Vault');
      throw error;
    }
    const recovered = classify(candidate.path, await inspectTree(destination));
    if (recovered.sha256 !== candidate.sha256 || recovered.fileCount !== candidate.fileCount || recovered.bytes !== candidate.bytes) {
      throw new Error(`VAULT_CLEANUP_CONFLICT: backup verification failed: ${candidate.path}`);
    }
    moved.push({ path: candidate.path, fileCount: candidate.fileCount, bytes: candidate.bytes });
  }
  const afterObsidian = await directoryFingerprint(join(before.resolvedVaultRoot, '.obsidian'));
  if (afterObsidian !== before.obsidianSha256) throw new Error('VAULT_CLEANUP_CONFLICT: .obsidian changed during cleanup');
  return { operationId, planSha256: before.planSha256, backupRoot: operationRoot, moved, skipped, recoverySnapshotSha256 };
}
