import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { canonicalJson, hashCanonical } from '../shared/manifest.ts';
import { resolveHistoricalCleanupTopology } from '../shared/historical-compatibility.ts';
import type { LibraryPaths } from '../shared/paths.ts';
import {
  cleanupPathsOverlap,
  collectExpiredWork,
  inspectCleanupTarget,
  normalizeCleanupPath,
  protectedCleanupMember,
  resolveCleanupPathIdentity,
  snapshotContainsProtectedMember,
  type CleanupPathIdentity,
  type CleanupTargetSnapshot,
} from './work-gc.ts';

export type CleanupReason =
  | 'known old root'
  | 'work/tests'
  | 'work/publishing'
  | 'diagnostics older than 30 days'
  | 'old bun-tests'
  | 'old Evidence staging'
  | 'empty validation'
  | 'Trellis __pycache__'
  | 'accepted old Vault projection';

export interface CleanupPlanEntry extends CleanupTargetSnapshot { reason: CleanupReason }

export interface CleanupPlan {
  schemaVersion: 1;
  entries: CleanupPlanEntry[];
  planSha256: string;
}

/** Opt-ins select fixed compatibility identities; no path authority is accepted. */
export interface HistoricalCleanupAcceptance {
  knownOldRoots?: readonly ('data' | 'code' | 'pdf')[];
  oldBunTests?: true;
  oldEvidenceStaging?: true;
  emptyValidation?: true;
  acceptedOldVaultProjectionSha256?: string;
}

export interface CleanupPlanInput {
  libraryPaths: LibraryPaths;
  projectRoot: string;
  now?: Date | string;
  historical?: HistoricalCleanupAcceptance;
  operationId?: string;
}

export interface CleanupResult {
  operationId: string;
  planSha256: string;
  quarantineRoot: string;
  recoveryManifestPath: string;
  recoveryManifestSha256: string;
  moved: Array<{ path: string; quarantinePath: string; reason: CleanupReason; bytes: number; fileCount: number }>;
}

export interface CleanupApplyDependencies {
  move?: typeof rename;
  rollbackMove?: typeof rename;
}

type CandidateSpec = { path: string; reason: CleanupReason; expectedSha256?: string };
type ProtectedIdentity = CleanupPathIdentity & { declared: string };
type RecoveryMove = CleanupResult['moved'][number] & { entry: CleanupPlanEntry };

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function protectedDeclarations(input: CleanupPlanInput): string[] {
  const paths = input.libraryPaths;
  return [
    paths.pdfRoot ?? join(paths.workRoot, 'downloads'),
    paths.archiveRoot,
    paths.databasePath,
    paths.runsRoot,
    paths.operationsRoot,
    join(paths.dataRoot, 'receipts'),
    paths.vaultRoot,
    join(paths.vaultRoot, '.obsidian'),
    join(resolve(input.projectRoot), '.trellis', 'tasks'),
  ].map(path => resolve(path));
}

async function protectedIdentities(input: CleanupPlanInput): Promise<ProtectedIdentity[]> {
  const identities: ProtectedIdentity[] = [];
  for (const declared of protectedDeclarations(input)) {
    try { identities.push({ declared, ...(await resolveCleanupPathIdentity(declared)) }); }
    catch (error) {
      throw new Error(`CLEANUP_UNSAFE: protected path is linked or reparsed: ${declared}`, { cause: error });
    }
  }
  return identities;
}

function overlapsProtected(identity: CleanupPathIdentity, protectedRoots: readonly ProtectedIdentity[]): boolean {
  return protectedRoots.some(protectedRoot =>
    cleanupPathsOverlap(identity.lexical, protectedRoot.lexical)
    || cleanupPathsOverlap(identity.lexical, protectedRoot.physical)
    || cleanupPathsOverlap(identity.physical, protectedRoot.lexical)
    || cleanupPathsOverlap(identity.physical, protectedRoot.physical));
}

async function safeCandidateIdentity(path: string, protectedRoots: readonly ProtectedIdentity[]): Promise<CleanupPathIdentity | undefined> {
  if (!isAbsolute(path)) throw new Error(`CLEANUP_UNSAFE: cleanup candidate must be absolute: ${path}`);
  const target = resolve(path);
  if (normalizeCleanupPath(target) === normalizeCleanupPath(parse(target).root)) {
    throw new Error('CLEANUP_UNSAFE: filesystem roots cannot be cleanup targets');
  }
  const identity = await resolveCleanupPathIdentity(target);
  if (overlapsProtected(identity, protectedRoots)) return undefined;
  return identity;
}

async function missing(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

function withoutVolatile(snapshot: CleanupTargetSnapshot): Omit<CleanupTargetSnapshot, 'newestMtimeMs'> {
  const { newestMtimeMs: _newestMtimeMs, ...stable } = snapshot;
  return stable;
}

function fixedCandidateSpecs(input: CleanupPlanInput): CandidateSpec[] {
  const accepted = input.historical;
  if (!accepted) return [];
  const topology = resolveHistoricalCleanupTopology();
  const specs: CandidateSpec[] = [];
  if (accepted.knownOldRoots) {
    specs.push(...accepted.knownOldRoots.map(identity => ({ path: topology.roots[identity], reason: 'known old root' as const })));
  }
  if (accepted.oldBunTests) specs.push(...topology.oldBunTests.map(path => ({ path, reason: 'old bun-tests' as const })));
  if (accepted.oldEvidenceStaging) specs.push({ path: topology.oldEvidenceStaging, reason: 'old Evidence staging' });
  if (accepted.emptyValidation) specs.push({ path: topology.emptyValidation, reason: 'empty validation' });
  if (accepted.acceptedOldVaultProjectionSha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(accepted.acceptedOldVaultProjectionSha256)) {
      throw new Error('CLEANUP_CONFLICT: accepted old Vault projection SHA-256 is invalid');
    }
    specs.push({ path: topology.roots.vault, reason: 'accepted old Vault projection', expectedSha256: accepted.acceptedOldVaultProjectionSha256 });
  }
  return specs;
}

async function evidenceStagingSpecs(input: CleanupPlanInput): Promise<CandidateSpec[]> {
  if (!input.historical?.oldEvidenceStaging) return [];
  const topology = resolveHistoricalCleanupTopology();
  const parent = topology.oldVaultRebuildParent;
  const identity = await resolveCleanupPathIdentity(parent);
  if (!identity.exists) return [];
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('CLEANUP_UNSAFE: Vault parent must be a normal directory');
  return (await readdir(parent, { withFileTypes: true }))
    .filter(entry => entry.name.startsWith(topology.oldVaultRebuildPrefix)
      && /^[A-Za-z0-9._-]+$/.test(entry.name.slice(topology.oldVaultRebuildPrefix.length)))
    .sort((left, right) => compare(left.name, right.name))
    .map(entry => ({ path: join(parent, entry.name), reason: 'old Evidence staging' as const }));
}

async function findTrellisCaches(trellisRoot: string, tasksRoot: string): Promise<string[]> {
  const caches: string[] = [];
  const walk = async (path: string): Promise<void> => {
    if (normalizeCleanupPath(path) === normalizeCleanupPath(tasksRoot) || inside(tasksRoot, path)) return;
    if (await missing(path)) return;
    const identity = await resolveCleanupPathIdentity(path);
    if (!identity.exists) return;
    const info = await lstat(path);
    if (!info.isDirectory()) return;
    if (basename(path) === '__pycache__') { caches.push(path); return; }
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      await walk(join(path, entry.name));
    }
  };
  await walk(trellisRoot);
  return caches;
}

function historicalReasonAuthorized(input: CleanupPlanInput, entry: CleanupPlanEntry): boolean {
  const accepted = input.historical;
  const topology = resolveHistoricalCleanupTopology();
  if (entry.reason === 'known old root') {
    return accepted?.knownOldRoots?.some(identity =>
      normalizeCleanupPath(topology.roots[identity]) === normalizeCleanupPath(entry.path)) === true;
  }
  if (entry.reason === 'old bun-tests') {
    return accepted?.oldBunTests === true
      && topology.oldBunTests.some(path => normalizeCleanupPath(path) === normalizeCleanupPath(entry.path));
  }
  if (entry.reason === 'empty validation') {
    return accepted?.emptyValidation === true && normalizeCleanupPath(topology.emptyValidation) === normalizeCleanupPath(entry.path);
  }
  if (entry.reason === 'accepted old Vault projection') {
    return accepted?.acceptedOldVaultProjectionSha256 === entry.sha256
      && normalizeCleanupPath(topology.roots.vault) === normalizeCleanupPath(entry.path);
  }
  if (entry.reason === 'old Evidence staging') {
    if (accepted?.oldEvidenceStaging !== true) return false;
    if (normalizeCleanupPath(topology.oldEvidenceStaging) === normalizeCleanupPath(entry.path)) return true;
    const name = basename(entry.path);
    return normalizeCleanupPath(dirname(resolve(entry.path))) === normalizeCleanupPath(topology.oldVaultRebuildParent)
      && name.startsWith(topology.oldVaultRebuildPrefix)
      && /^[A-Za-z0-9._-]+$/.test(name.slice(topology.oldVaultRebuildPrefix.length));
  }
  return false;
}

function reasonAuthorized(input: CleanupPlanInput, entry: CleanupPlanEntry): boolean {
  const workRoot = resolve(input.libraryPaths.workRoot);
  if (entry.reason === 'work/tests') return normalizeCleanupPath(entry.path) === normalizeCleanupPath(join(workRoot, 'tests'));
  if (entry.reason === 'work/publishing') return normalizeCleanupPath(entry.path) === normalizeCleanupPath(join(workRoot, 'publishing'));
  if (entry.reason === 'diagnostics older than 30 days') {
    return normalizeCleanupPath(dirname(resolve(entry.path))) === normalizeCleanupPath(join(workRoot, 'diagnostics'));
  }
  if (entry.reason === 'Trellis __pycache__') {
    const trellisRoot = join(resolve(input.projectRoot), '.trellis');
    const tasksRoot = join(trellisRoot, 'tasks');
    return basename(entry.path) === '__pycache__' && inside(trellisRoot, resolve(entry.path)) && !cleanupPathsOverlap(entry.path, tasksRoot);
  }
  return historicalReasonAuthorized(input, entry);
}

async function addSnapshot(
  entries: Map<string, CleanupPlanEntry>,
  input: CleanupPlanInput,
  protectedRoots: readonly ProtectedIdentity[],
  spec: CandidateSpec,
  suppliedSnapshot?: CleanupTargetSnapshot,
): Promise<void> {
  const identity = await safeCandidateIdentity(spec.path, protectedRoots);
  if (!identity || !identity.exists) return;
  const snapshot = suppliedSnapshot ?? await inspectCleanupTarget(identity.lexical);
  if (!snapshot) return;
  const prospective = { ...withoutVolatile(snapshot), newestMtimeMs: snapshot.newestMtimeMs, reason: spec.reason };
  if (!reasonAuthorized(input, prospective)) throw new Error(`CLEANUP_UNSAFE: candidate is outside the closed cleanup policy: ${spec.path}`);
  if (snapshotContainsProtectedMember(snapshot)) return;
  if (spec.reason === 'empty validation' && (snapshot.type !== 'directory' || snapshot.members.length !== 0)) return;
  if (spec.expectedSha256 !== undefined && snapshot.sha256 !== spec.expectedSha256) {
    throw new Error('CLEANUP_PLAN_CHANGED: accepted old Vault projection hash no longer matches');
  }
  const key = normalizeCleanupPath(snapshot.path);
  const existing = entries.get(key);
  if (existing && existing.reason !== spec.reason) throw new Error(`CLEANUP_UNSAFE: target has multiple cleanup reasons: ${snapshot.path}`);
  entries.set(key, prospective);
}

/** Read-only creation of a closed, exact-path cleanup plan. */
export async function createCleanupPlan(input: CleanupPlanInput): Promise<CleanupPlan> {
  if (!isAbsolute(input.projectRoot)) throw new Error('CLEANUP_UNSAFE: projectRoot must be absolute');
  const projectRoot = resolve(input.projectRoot);
  const protectedRoots = await protectedIdentities(input);
  const entries = new Map<string, CleanupPlanEntry>();

  const work = await collectExpiredWork({ workRoot: input.libraryPaths.workRoot, now: input.now });
  for (const entry of work.entries) await addSnapshot(entries, input, protectedRoots, { path: entry.path, reason: entry.reason }, entry);
  for (const spec of [...fixedCandidateSpecs(input), ...(await evidenceStagingSpecs(input))]) {
    await addSnapshot(entries, input, protectedRoots, spec);
  }

  const trellisRoot = join(projectRoot, '.trellis');
  const tasksRoot = join(trellisRoot, 'tasks');
  for (const cache of await findTrellisCaches(trellisRoot, tasksRoot)) {
    await addSnapshot(entries, input, protectedRoots, { path: cache, reason: 'Trellis __pycache__' });
  }

  const sorted = [...entries.values()].sort((a, b) => compare(normalizeCleanupPath(a.path), normalizeCleanupPath(b.path)));
  for (let index = 0; index < sorted.length; index++) {
    for (let other = index + 1; other < sorted.length; other++) {
      if (cleanupPathsOverlap(sorted[index]!.path, sorted[other]!.path)) throw new Error('CLEANUP_UNSAFE: cleanup targets overlap');
    }
  }
  const body = { schemaVersion: 1 as const, entries: sorted };
  return { ...body, planSha256: hashCanonical(body) };
}

function sameSnapshot(current: CleanupTargetSnapshot | undefined, planned: CleanupPlanEntry): boolean {
  return current !== undefined
    && normalizeCleanupPath(current.path) === normalizeCleanupPath(planned.path)
    && sameSnapshotContents(current, planned);
}

function sameSnapshotContents(current: CleanupTargetSnapshot, planned: CleanupPlanEntry): boolean {
  return current.type === planned.type
    && current.sha256 === planned.sha256
    && current.bytes === planned.bytes
    && current.fileCount === planned.fileCount;
}

async function validateEntryForMove(input: CleanupPlanInput, entry: CleanupPlanEntry): Promise<void> {
  if (!reasonAuthorized(input, entry)) throw new Error(`CLEANUP_UNSAFE: target is no longer allowlisted: ${entry.path}`);
  if (protectedCleanupMember(basename(entry.path)) || entry.members.some(protectedCleanupMember)) {
    throw new Error(`CLEANUP_UNSAFE: target contains a protected member: ${entry.path}`);
  }
  const identity = await safeCandidateIdentity(entry.path, await protectedIdentities(input));
  if (!identity || !identity.exists) throw new Error(`CLEANUP_PLAN_CHANGED: target disappeared: ${entry.path}`);
  const current = await inspectCleanupTarget(identity.lexical);
  if (!sameSnapshot(current, entry)) throw new Error(`CLEANUP_PLAN_CHANGED: target drifted: ${entry.path}`);
  if (entry.reason === 'empty validation' && current!.members.length !== 0) {
    throw new Error(`CLEANUP_PLAN_CHANGED: validation is no longer empty: ${entry.path}`);
  }
}

async function ensureSafeDirectoryPath(path: string, label: string): Promise<string> {
  const target = resolve(path);
  const volumeRoot = parse(target).root;
  if (!volumeRoot) throw new Error(`CLEANUP_UNSAFE: invalid ${label}`);
  const parts = relative(volumeRoot, target).split(/[\\/]+/).filter(Boolean);
  let current = volumeRoot;
  for (const part of parts) {
    current = join(current, part);
    try { await mkdir(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const identity = await resolveCleanupPathIdentity(current);
    const info = await lstat(current);
    if (!identity.exists || !info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`CLEANUP_UNSAFE: ${label} contains a link, reparse point, or non-directory`);
    }
  }
  return target;
}

async function assertSafeQuarantineRoot(input: CleanupPlanInput, entries: readonly CleanupPlanEntry[]): Promise<string> {
  const backupRoot = resolve(input.libraryPaths.backupRoot);
  const protectedRoots = await protectedIdentities(input);
  const backupIdentity = await resolveCleanupPathIdentity(backupRoot);
  if (overlapsProtected(backupIdentity, protectedRoots)) throw new Error('CLEANUP_UNSAFE: backup root overlaps protected data');
  for (const entry of entries) {
    const targetIdentity = await resolveCleanupPathIdentity(entry.path);
    if (cleanupPathsOverlap(backupIdentity.lexical, targetIdentity.lexical)
      || cleanupPathsOverlap(backupIdentity.physical, targetIdentity.physical)) {
      throw new Error('CLEANUP_UNSAFE: backup root overlaps a cleanup target');
    }
  }
  return ensureSafeDirectoryPath(backupRoot, 'backup root');
}

async function createQuarantineDirectories(backupRoot: string, operationId: string): Promise<{ operationRoot: string; targetsRoot: string }> {
  await ensureSafeDirectoryPath(join(backupRoot, 'cleanup-quarantine'), 'cleanup quarantine root');
  const operationRoot = join(backupRoot, 'cleanup-quarantine', operationId);
  if (!await missing(operationRoot)) throw new Error('CLEANUP_CONFLICT: cleanup quarantine operation already exists');
  await mkdir(operationRoot);
  await resolveCleanupPathIdentity(operationRoot);
  const targetsRoot = join(operationRoot, 'targets');
  await mkdir(targetsRoot);
  await resolveCleanupPathIdentity(targetsRoot);
  return { operationRoot, targetsRoot };
}

async function revalidateQuarantinePaths(backupRoot: string, operationRoot: string, targetsRoot: string): Promise<void> {
  for (const [path, label] of [
    [backupRoot, 'backup root'],
    [join(backupRoot, 'cleanup-quarantine'), 'cleanup quarantine root'],
    [operationRoot, 'cleanup operation root'],
    [targetsRoot, 'cleanup targets root'],
  ] as const) {
    const identity = await resolveCleanupPathIdentity(path);
    const info = await lstat(path);
    if (!identity.exists || !info.isDirectory() || info.isSymbolicLink()) throw new Error(`CLEANUP_UNSAFE: unsafe ${label}`);
  }
}

async function rollbackMoves(
  moves: readonly RecoveryMove[],
  rollbackMove: typeof rename,
  operationRoot: string,
  planSha256: string,
  failure: unknown,
): Promise<void> {
  const restored: string[] = [];
  for (const move of [...moves].reverse()) {
    const destination = await inspectCleanupTarget(move.quarantinePath);
    if (!destination || !sameSnapshotContents(destination, move.entry)) throw new Error(`CLEANUP_ROLLBACK_FAILED: quarantined target drifted: ${move.path}`);
    if (!await missing(move.path)) throw new Error(`CLEANUP_ROLLBACK_FAILED: original path was recreated: ${move.path}`);
    await rollbackMove(move.quarantinePath, move.path);
    const restoredSnapshot = await inspectCleanupTarget(move.path);
    if (!sameSnapshot(restoredSnapshot, move.entry)) throw new Error(`CLEANUP_ROLLBACK_FAILED: restore verification failed: ${move.path}`);
    restored.push(move.path);
  }
  await writeFile(join(operationRoot, 'rollback.json'), canonicalJson({
    schemaVersion: 1,
    planSha256,
    status: 'rolled-back',
    restored,
    error: failure instanceof Error ? failure.message : String(failure),
  }), { flag: 'wx' });
}

/** Moves an explicitly confirmed, hash-bound plan into recovery quarantine. */
export async function applyCleanupPlan(
  input: CleanupPlanInput & { planSha256: string; confirm: true },
  dependencies: CleanupApplyDependencies = {},
): Promise<CleanupResult> {
  if (input.confirm !== true) throw new Error('CLEANUP_CONFIRMATION_REQUIRED: apply requires literal confirm:true');
  if (!/^[0-9a-f]{64}$/.test(input.planSha256)) throw new Error('CLEANUP_CONFLICT: invalid plan SHA-256');
  const plan = await createCleanupPlan(input);
  if (plan.planSha256 !== input.planSha256) throw new Error('CLEANUP_PLAN_CHANGED: reviewed plan no longer matches');

  for (const entry of plan.entries) await validateEntryForMove(input, entry);
  const backupRoot = await assertSafeQuarantineRoot(input, plan.entries);
  const operationId = input.operationId ?? randomUUID();
  if (!/^[A-Za-z0-9._-]+$/.test(operationId)) throw new Error('CLEANUP_UNSAFE: invalid cleanup operation id');
  const { operationRoot, targetsRoot } = await createQuarantineDirectories(backupRoot, operationId);
  const recoveryManifestPath = join(operationRoot, 'recovery-manifest.json');
  const manifest = {
    schemaVersion: 1,
    operationId,
    planSha256: plan.planSha256,
    status: 'prepared',
    targets: plan.entries.map((entry, index) => ({
      sourcePath: entry.path,
      quarantinePath: join(targetsRoot, String(index).padStart(4, '0')),
      reason: entry.reason,
      type: entry.type,
      sha256: entry.sha256,
      bytes: entry.bytes,
      fileCount: entry.fileCount,
    })),
  };
  const manifestText = canonicalJson(manifest);
  const recoveryManifestSha256 = sha256(manifestText);
  await revalidateQuarantinePaths(backupRoot, operationRoot, targetsRoot);
  await writeFile(recoveryManifestPath, manifestText, { flag: 'wx' });
  if (sha256(await readFile(recoveryManifestPath)) !== recoveryManifestSha256) {
    throw new Error('CLEANUP_CONFLICT: recovery manifest verification failed');
  }

  const moved: RecoveryMove[] = [];
  let pending: RecoveryMove | undefined;
  try {
    for (let index = 0; index < plan.entries.length; index++) {
      const entry = plan.entries[index]!;
      const quarantinePath = join(targetsRoot, String(index).padStart(4, '0'));
      await validateEntryForMove(input, entry);
      await revalidateQuarantinePaths(backupRoot, operationRoot, targetsRoot);
      if (!await missing(quarantinePath)) throw new Error(`CLEANUP_CONFLICT: quarantine target already exists: ${quarantinePath}`);
      pending = { path: entry.path, quarantinePath, reason: entry.reason, bytes: entry.bytes, fileCount: entry.fileCount, entry };
      await (dependencies.move ?? rename)(entry.path, quarantinePath);
      const quarantined = await inspectCleanupTarget(quarantinePath);
      if (!quarantined || !sameSnapshotContents(quarantined, entry) || !await missing(entry.path)) {
        throw new Error(`CLEANUP_CONFLICT: quarantine verification failed: ${entry.path}`);
      }
      moved.push(pending);
      pending = undefined;
    }
  } catch (error) {
    if (pending && await missing(pending.path) && !await missing(pending.quarantinePath)) moved.push(pending);
    try { await rollbackMoves(moved, dependencies.rollbackMove ?? rename, operationRoot, plan.planSha256, error); }
    catch (rollbackError) { throw new Error('CLEANUP_ROLLBACK_FAILED: cleanup could not restore every moved target', { cause: rollbackError }); }
    throw error;
  }

  const publicMoved = moved.map(({ entry: _entry, ...move }) => move);
  try {
    await writeFile(join(operationRoot, 'commit.json'), canonicalJson({
      schemaVersion: 1,
      operationId,
      planSha256: plan.planSha256,
      recoveryManifestSha256,
      status: 'committed',
      moved: publicMoved.map(move => ({ path: move.path, quarantinePath: move.quarantinePath })),
    }), { flag: 'wx' });
  } catch (error) {
    try { await rollbackMoves(moved, dependencies.rollbackMove ?? rename, operationRoot, plan.planSha256, error); }
    catch (rollbackError) { throw new Error('CLEANUP_ROLLBACK_FAILED: commit failed and cleanup could not restore every target', { cause: rollbackError }); }
    throw error;
  }
  return {
    operationId,
    planSha256: plan.planSha256,
    quarantineRoot: operationRoot,
    recoveryManifestPath,
    recoveryManifestSha256,
    moved: publicMoved,
  };
}
