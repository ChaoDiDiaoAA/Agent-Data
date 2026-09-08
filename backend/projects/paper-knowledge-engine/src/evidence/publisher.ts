import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { archivePath, type VerifiedArchiveV2 } from '../shared/archive-v2.ts';
import { EVIDENCE_LAYOUT_V3, evidencePaperRoot, type BufferedEvidenceSource, type EvidenceInput } from './layout-paths.ts';
import { bufferArchiveV2, prepareEvidenceSources, renderBufferedEvidenceV3 } from './layout-v3.ts';
import { canonicalJson, hashCanonical, normalizeArchivePath } from '../shared/manifest.ts';
import { createOrReplayReceipt, EvidenceReceiptError, equivalentReceipt, readPublicationReceipt, recoverPublicationReceiptTemporary, type EvidencePublicationReceiptV3, type EvidencePublicationSourceReceipt,  } from './receipt-store.ts';
import { replaceFileWithRetry } from './atomic-replace.ts';
import { withRunLock } from '../runtime/run-lock.ts';

export type { EvidencePublicationReceipt, EvidencePublicationReceiptV1, EvidencePublicationReceiptV3 } from './receipt-store.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const safeRunId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sha256Hex = /^[0-9a-f]{64}$/;

export class EvidencePublicationError extends Error {
  constructor(readonly code: 'EVIDENCE_CONFLICT' | 'EVIDENCE_INTERRUPTED' | 'EVIDENCE_PATH' | 'EVIDENCE_IO', message: string, cause?: unknown) {
    super(`${code}: ${message}`);
    if (cause !== undefined) this.cause = cause;
  }
}

type TargetFile = { readonly relativePath: string; readonly bytes: Uint8Array; readonly sha256: string };
export interface EvidencePublicationPlanV3 {
  readonly schemaVersion: 1;
  readonly publisherVersion: 3;
  readonly runId: string;
  readonly publicationId: string;
  readonly contentSha256: string;
  readonly sources: readonly EvidencePublicationSourceReceipt[];
}
type EvidencePublicationPlanPrivate = {
  readonly targets: readonly TargetFile[];
  readonly predecessorTargets?: readonly TargetFile[];
};
const evidencePublicationPlans = new WeakMap<EvidencePublicationPlanV3, EvidencePublicationPlanPrivate>();
type JournalAction = {
  target: string;
  expectedSha256: string;
  backup: string | null;
  backupSha256: string | null;
  replacementStarted: boolean;
  installed: boolean;
};
type JournalBinding = {
  readonly publisherVersion: 3;
  readonly runId: string;
  readonly publicationId: string;
  readonly contentSha256: string;
};
type Journal = JournalBinding & { schemaVersion: 1; actions: JournalAction[] };
type StatePaths = { stateRoot: string; evidenceRoot: string; backupsRoot: string; journalPath: string; receiptPath: string };

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function rejectPath(message: string): never { throw new EvidencePublicationError('EVIDENCE_PATH', message); }

async function realDirectory(path: string, label: string): Promise<string> {
  let info;
  try { info = await lstat(path); } catch { rejectPath(`${label} must be an existing real directory`); }
  if (!info!.isDirectory() || info!.isSymbolicLink()) rejectPath(`${label} must not be a symlink or junction`);
  return await realpath(path);
}

function assertVaultRoot(path: string): void {
  if (basename(path).toLowerCase() === '.obsidian' || path.split(/[\\/]+/).some(part => part.toLowerCase() === '.obsidian')) {
    rejectPath('vaultRoot must not be .obsidian or nested inside it');
  }
}

async function assertSafeDescendant(root: string, candidate: string, label: string, allowMissing = false): Promise<void> {
  const lexical = resolve(candidate);
  if (!isInside(root, lexical)) rejectPath(`${label} escapes its root`);
  const parts = relative(root, lexical).split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) rejectPath(`${label} traverses a symlink or junction`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return;
      throw error;
    }
  }
}

async function ensureDirectoryChain(root: string, parts: readonly string[], label: string): Promise<string> {
  let current = root;
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\')) rejectPath(`${label} has an unsafe path component`);
    const candidate = resolve(current, part);
    if (!isInside(current, candidate)) rejectPath(`${label} escapes its root`);
    try {
      const info = await lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink()) rejectPath(`${label} traverses a symlink or junction`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(candidate);
      const created = await lstat(candidate);
      if (!created.isDirectory() || created.isSymbolicLink()) rejectPath(`${label} created through a symlink or junction`);
    }
    current = candidate;
  }
  return current;
}

async function ensureParentDirectory(root: string, path: string, label: string): Promise<void> {
  const parts = relative(root, path).split(sep);
  parts.pop();
  await ensureDirectoryChain(root, parts, label);
  await assertSafeDescendant(root, path, label, true);
}

async function statePaths(stateRoot: string, runId: string): Promise<StatePaths> {
  const evidenceRoot = await ensureDirectoryChain(stateRoot, ['runs', runId, 'evidence'], 'state evidence directory');
  const backupsRoot = await ensureDirectoryChain(evidenceRoot, ['backups'], 'state evidence backups directory');
  const journalPath = join(evidenceRoot, 'publication-journal.json');
  const receiptPath = join(evidenceRoot, 'publication.json');
  await Promise.all([
    assertSafeDescendant(evidenceRoot, journalPath, 'publication journal', true),
    assertSafeDescendant(evidenceRoot, `${journalPath}.new`, 'publication journal temporary', true),
    assertSafeDescendant(evidenceRoot, receiptPath, 'publication receipt', true),
    assertSafeDescendant(evidenceRoot, `${receiptPath}.new`, 'publication receipt temporary', true),
  ]);
  return { stateRoot, evidenceRoot, backupsRoot, journalPath, receiptPath };
}

function targetPath(vaultRoot: string, relativePath: string): string {
  const normalized = archivePath(relativePath);
  if (!normalized.startsWith(EVIDENCE_LAYOUT_V3.root + '/')) rejectPath(`unexpected rendered target ${normalized}`);
  return resolve(vaultRoot, ...normalized.split('/'));
}

function renderedTargets(sources: readonly BufferedEvidenceSource[]): TargetFile[] {
  const rendered = renderBufferedEvidenceV3(sources);
  const targets = new Map<string, TargetFile>();
  for (const file of rendered) {
    const relativePath = normalizeArchivePath(file.path);
    if (file.bytes.byteLength === 0 && sha256(file.bytes) !== file.sha256) throw new Error(`rendered hash mismatch: ${relativePath}`);
    if (sha256(file.bytes) !== file.sha256) throw new Error(`rendered hash mismatch: ${relativePath}`);
    if (targets.has(relativePath)) throw new Error(`duplicate rendered target: ${relativePath}`);
    targets.set(relativePath, { relativePath, bytes: new Uint8Array(file.bytes), sha256: file.sha256 });
  }
  return [...targets.values()].sort((left, right) => compareText(left.relativePath, right.relativePath));
}

async function stageFiles(root: string, targets: readonly TargetFile[]): Promise<void> {
  for (const target of targets) {
    const destination = resolve(root, ...target.relativePath.split('/'));
    if (!isInside(root, destination)) rejectPath('staging path escapes publication root');
    await ensureParentDirectory(root, destination, 'staging file');
    try {
      const existing = await readFile(destination);
      if (sha256(existing) !== target.sha256) throw new EvidencePublicationError('EVIDENCE_CONFLICT', `staging file differs: ${target.relativePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(destination, target.bytes, { flag: 'wx' });
    }
    const bytes = await readFile(destination);
    if (sha256(bytes) !== target.sha256) throw new Error(`staging hash mismatch: ${target.relativePath}`);
  }
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) rejectPath(`managed target traverses a symlink or junction: ${relativePath}`);
    if (entry.isDirectory()) { files.push(relativePath + '/'); files.push(...await listFiles(path, relativePath)); }
    else if (entry.isFile()) files.push(relativePath);
    else rejectPath(`managed target is not a regular file: ${relativePath}`);
  }
  return files.sort(compareText);
}

type InstalledState = 'absent' | 'current' | 'predecessor';

function evidenceRelativePath(target: TargetFile): string {
  if (!target.relativePath.startsWith(EVIDENCE_LAYOUT_V3.root + '/')) rejectPath('target outside Evidence');
  return target.relativePath.slice(EVIDENCE_LAYOUT_V3.root.length + 1);
}

async function assertKnownManagedPaths(
  vaultRoot: string,
  targets: readonly TargetFile[],
  allowedTransactionArtifacts: ReadonlySet<string> = new Set(),
): Promise<readonly string[]> {
  const rootEntries = await readdir(vaultRoot);
  if (rootEntries.some(name => name.toLowerCase() === EVIDENCE_LAYOUT_V3.root.toLowerCase() && name !== EVIDENCE_LAYOUT_V3.root)) {
    rejectPath('Evidence root has a different Windows case identity');
  }
  const expectedEvidence = new Set(targets.map(evidenceRelativePath).filter((path): path is string => path !== null));
  const expectedDirectories = new Set<string>();
  for (const path of expectedEvidence) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) expectedDirectories.add(parts.slice(0, i).join('/') + '/');
  }
  const evidenceRoot = join(vaultRoot, EVIDENCE_LAYOUT_V3.root);
  await assertSafeDescendant(vaultRoot, evidenceRoot, EVIDENCE_LAYOUT_V3.root, true);
  const evidenceFiles = await listFiles(evidenceRoot);
  for (const relativePath of evidenceFiles) {
    if (!expectedEvidence.has(relativePath) && !expectedDirectories.has(relativePath) && !allowedTransactionArtifacts.has(relativePath)) {
      throw new EvidencePublicationError('EVIDENCE_CONFLICT', `unknown manual file ${relativePath}`);
    }
  }
  return evidenceFiles;
}

async function installedTargetHashes(vaultRoot: string, targets: readonly TargetFile[]): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>();
  for (const target of targets) {
    const absolute = targetPath(vaultRoot, target.relativePath);
    await assertSafeDescendant(vaultRoot, absolute, `managed target ${target.relativePath}`, true);
    try {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) rejectPath(`managed target is not a real file: ${target.relativePath}`);
      hashes.set(target.relativePath, sha256(await readFile(absolute)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hashes.set(target.relativePath, null);
    }
  }
  return hashes;
}

async function classifyInstalled(
  vaultRoot: string,
  targets: readonly TargetFile[],
  predecessorTargets?: readonly TargetFile[],
): Promise<InstalledState> {
  await assertKnownManagedPaths(vaultRoot, targets);

  const hashes = await installedTargetHashes(vaultRoot, targets);
  if (targets.every(target => hashes.get(target.relativePath) === target.sha256)) return 'current';

  if (predecessorTargets) {
    const predecessorByPath = new Map(predecessorTargets.map(target => [target.relativePath, target]));
    const predecessorMatches = predecessorTargets.every(target => hashes.get(target.relativePath) === target.sha256);
    if (predecessorMatches) {
      const partiallyInstalled = targets.some(target => !predecessorByPath.has(target.relativePath) && hashes.get(target.relativePath) !== null);
      if (partiallyInstalled) {
        throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'current publication is partially installed');
      }
      return 'predecessor';
    }
  }

  if (targets.every(target => hashes.get(target.relativePath) === null)) return 'absent';
  const changed = targets.find(target => {
    const installed = hashes.get(target.relativePath);
    return installed !== null && installed !== target.sha256;
  });
  if (changed) throw new EvidencePublicationError('EVIDENCE_CONFLICT', `managed file differs: ${changed.relativePath}`);
  throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'managed target is incomplete');
}

async function writeJournal(path: string, journal: Journal): Promise<void> {
  const parent = dirname(path);
  const temporary = `${path}.new`;
  await assertSafeDescendant(parent, path, 'publication journal', true);
  await assertSafeDescendant(parent, temporary, 'publication journal temporary', true);
  await writeFile(temporary, canonicalJson(journal), { flag: 'wx' });
  await replacePublicationFile(temporary, path);
}

async function replacePublicationFile(source: string, destination: string): Promise<void> {
  try {
    await replaceFileWithRetry(source, destination);
  } catch (error) {
    if (error instanceof EvidencePublicationError) throw error;
    throw new EvidencePublicationError('EVIDENCE_IO', 'Evidence 文件事务写入失败，恢复材料已保留，请稍后重试', error);
  }
}

function expectedTargetMap(targets: readonly TargetFile[]): Map<string, TargetFile> {
  return new Map(targets.map(target => [target.relativePath, target]));
}

function parseJournal(bytes: Uint8Array, expected: ReadonlyMap<string, TargetFile>, binding: JournalBinding): Journal {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal is unreadable'); }
  if (Buffer.from(bytes).toString('utf8') !== canonicalJson(value)) throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal is not canonical publisher bytes');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal is invalid');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ['actions', 'contentSha256', 'publicationId', 'publisherVersion', 'runId', 'schemaVersion'];
  if (keys.join('\u0000') !== expectedKeys.join('\u0000') || record.schemaVersion !== 1 || !Array.isArray(record.actions)
    || record.publisherVersion !== binding.publisherVersion || record.runId !== binding.runId
    || record.publicationId !== binding.publicationId || record.contentSha256 !== binding.contentSha256) {
    throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal is not for this publication');
  }
  const actions = record.actions as unknown[];
  for (const action of actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal action is invalid');
    const record = action as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const allowed = keys.join('\u0000') === ['backup', 'backupSha256', 'expectedSha256', 'installed', 'replacementStarted', 'target'].join('\u0000');
    if (!allowed || typeof record.target !== 'string' || typeof record.installed !== 'boolean'
      || typeof record.replacementStarted !== 'boolean' || typeof record.expectedSha256 !== 'string' || !sha256Hex.test(record.expectedSha256)
      || (record.backup !== null && typeof record.backup !== 'string')
      || (record.backupSha256 !== null && (typeof record.backupSha256 !== 'string' || !sha256Hex.test(record.backupSha256)))) {
      throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal action is invalid');
    }
    let target: string;
    try { target = normalizeArchivePath(record.target); }
    catch { throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal action target is unsafe'); }
    const expectedTarget = expected.get(target);
    if (!expectedTarget || record.expectedSha256 !== expectedTarget.sha256) {
      throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal action is not for this publication');
    }
    if ((record.backup === null) !== (record.backupSha256 === null)) {
      throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal backup identity is invalid');
    }
    if (record.backup !== null) {
      let backup: string;
      try { backup = normalizeArchivePath(record.backup); }
      catch { rejectPath('journal backup path is unsafe'); }
      if (backup !== target) throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal action is not for this publication');
    }
  }
  return value as Journal;
}

async function rollbackTargetState(input: {
  vaultRoot: string;
  target: string;
  expectedSha256: string;
  backupSha256: string | null;
  label: string;
}): Promise<'absent' | 'expected' | 'backup'> {
  try {
    const info = await lstat(input.target);
    if (!info.isFile() || info.isSymbolicLink()) rejectPath(`${input.label} is not a real file`);
    const hash = sha256(await readFile(input.target));
    if (hash === input.expectedSha256) return 'expected';
    if (input.backupSha256 && hash === input.backupSha256) return 'backup';
    throw new EvidencePublicationError('EVIDENCE_CONFLICT', `${input.label} contains unexpected bytes`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

async function recoverJournal(
  state: StatePaths,
  vaultRoot: string,
  targets: readonly TargetFile[],
  binding: JournalBinding,
): Promise<void> {
  const expected = expectedTargetMap(targets);
  const inspected = await inspectJournalForRecovery(state, targets, binding);
  if (!inspected) return;
  const journal = inspected.journal;
  for (const action of [...journal.actions].reverse()) {
    const target = targetPath(vaultRoot, action.target);
    const expectedTarget = expected.get(action.target);
    if (!expectedTarget) throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal action is not for this publication');
    await assertSafeDescendant(vaultRoot, target, `journal target ${action.target}`, true);
    const temporary = `${target}.new`;
    await assertSafeDescendant(vaultRoot, temporary, `journal temporary ${action.target}`, true);
    try {
      const temporaryBytes = await readFile(temporary);
      if (sha256(temporaryBytes) !== expectedTarget.sha256) throw new EvidencePublicationError('EVIDENCE_CONFLICT', `unexpected install temporary: ${action.target}`);
      if (!action.replacementStarted && !action.installed) throw new EvidencePublicationError('EVIDENCE_CONFLICT', `uncommitted install temporary: ${action.target}`);
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!action.replacementStarted && !action.installed) continue;
    const targetState = await rollbackTargetState({
      vaultRoot,
      target,
      expectedSha256: action.expectedSha256,
      backupSha256: action.backupSha256,
      label: `journal target ${action.target}`,
    });
    if (action.backup) {
      let backupRelative: string;
      try { backupRelative = normalizeArchivePath(action.backup); }
      catch { rejectPath('journal backup path is unsafe'); }
      const backup = resolve(state.backupsRoot, ...backupRelative!.split('/'));
      if (!isInside(state.backupsRoot, backup)) rejectPath('journal backup path escapes evidence backups');
      await assertSafeDescendant(state.backupsRoot, backup, 'journal backup', false);
      const backupBytes = await readFile(backup);
      if (sha256(backupBytes) !== action.backupSha256) throw new EvidencePublicationError('EVIDENCE_CONFLICT', `journal backup differs: ${action.target}`);
      await ensureParentDirectory(vaultRoot, target, `recovery target ${action.target}`);
      const recovery = `${target}.recovery`;
      await assertSafeDescendant(vaultRoot, recovery, `recovery temporary ${action.target}`, true);
      let recoveryPresent = false;
      try {
        const recoveryBytes = await readFile(recovery);
        if (sha256(recoveryBytes) !== action.backupSha256) throw new EvidencePublicationError('EVIDENCE_CONFLICT', `unexpected recovery temporary: ${action.target}`);
        recoveryPresent = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (targetState === 'backup') {
        if (recoveryPresent) await unlink(recovery);
      } else if (recoveryPresent) {
        await replacePublicationFile(recovery, target);
      } else {
        await writeFile(recovery, backupBytes, { flag: 'wx' });
        await replacePublicationFile(recovery, target);
      }
    } else {
      if (targetState === 'expected') await unlink(target);
    }
  }
  for (const path of inspected.cleanupPaths) {
    await assertSafeDescendant(state.evidenceRoot, path, 'publication journal', false);
    await unlink(path);
  }
}

async function installFiles(input: {
  vaultRoot: string;
  state: StatePaths;
  stageRoot: string;
  targets: readonly TargetFile[];
  journalBinding: JournalBinding;
}): Promise<void> {
  const { journalPath } = input.state;
  await recoverJournal(input.state, input.vaultRoot, input.targets, input.journalBinding);
  const journal: Journal = { schemaVersion: 1, ...input.journalBinding, actions: [] };
  await writeJournal(journalPath, journal);
  let installs = 0;
  for (const targetFile of input.targets) {
    const target = targetPath(input.vaultRoot, targetFile.relativePath);
    const staged = resolve(input.stageRoot, ...targetFile.relativePath.split('/'));
    await assertSafeDescendant(input.vaultRoot, target, `install target ${targetFile.relativePath}`, true);
    const backupRelative = targetFile.relativePath;
    let backup: string | null = null;
    let backupSha256: string | null = null;
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink()) rejectPath(`install target is not a real file: ${targetFile.relativePath}`);
      backup = backupRelative;
      backupSha256 = sha256(await readFile(target));
      const backupPath = resolve(input.state.backupsRoot, ...backupRelative.split('/'));
      if (!isInside(input.state.backupsRoot, backupPath)) rejectPath('backup path escapes evidence backups');
      await ensureParentDirectory(input.state.backupsRoot, backupPath, 'publication backup');
      await assertSafeDescendant(input.state.backupsRoot, backupPath, 'publication backup', true);
      await copyFile(target, backupPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const action: JournalAction = {
      target: targetFile.relativePath,
      expectedSha256: targetFile.sha256,
      backup,
      backupSha256,
      replacementStarted: false,
      installed: false,
    };
    journal.actions.push(action);
    await writeJournal(journalPath, journal);
    action.replacementStarted = true;
    await writeJournal(journalPath, journal);
    await ensureParentDirectory(input.vaultRoot, target, `install target ${targetFile.relativePath}`);
    const temporary = `${target}.new`;
    await assertSafeDescendant(input.vaultRoot, temporary, `install temporary ${targetFile.relativePath}`, true);
    await writeFile(temporary, await readFile(staged), { flag: 'wx' });
    await replacePublicationFile(temporary, target);
    if (sha256(await readFile(target)) !== targetFile.sha256) throw new Error(`installed hash mismatch: ${targetFile.relativePath}`);
    action.installed = true;
    await writeJournal(journalPath, journal);
    installs++;
    if (Number(process.env.FSD_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL) === installs) {
      throw new EvidencePublicationError('EVIDENCE_INTERRUPTED', 'synthetic interruption after journaled install');
    }
  }
  await assertSafeDescendant(input.state.evidenceRoot, journalPath, 'publication journal', false);
  await unlink(journalPath);
}

function sourceReceipts(sources: readonly BufferedEvidenceSource[], targets: readonly TargetFile[]): EvidencePublicationSourceReceipt[] {
  return [...sources].sort((left, right) => compareText(left.source.baseId, right.source.baseId) || left.source.version - right.source.version).map(source => {
    const prefix = evidencePaperRoot(source.source.baseId, source.source.version) + '/';
    const entries = targets.filter(target => target.relativePath.startsWith(prefix))
      .map(target => ({ path: target.relativePath, sha256: target.sha256, bytes: target.bytes.byteLength }));
    return { baseId: source.source.baseId, version: source.source.version, archiveManifestSha256: source.archiveManifestSha256, evidenceManifestSha256: hashCanonical(entries) };
  });
}

function validatePredecessorSources(
  currentSources: readonly EvidencePublicationSourceReceipt[],
  predecessor: EvidencePublicationPlanV3,
  currentTargets: readonly TargetFile[],
  predecessorTargets: readonly TargetFile[],
): void {
  const currentByIdentity = new Map(currentSources.map(source => [`${source.baseId}\u0000${source.version}`, source]));
  for (const source of predecessor.sources) {
    const identity = `${source.baseId}\u0000${source.version}`;
    const current = currentByIdentity.get(identity);
    if (!current) throw new EvidencePublicationError('EVIDENCE_CONFLICT', `predecessor source was removed: ${source.baseId}v${source.version}`);
    if (current.archiveManifestSha256 !== source.archiveManifestSha256) {
      throw new EvidencePublicationError('EVIDENCE_CONFLICT', `predecessor Archive identity changed: ${source.baseId}v${source.version}`);
    }
  }

  const currentByPath = new Map(currentTargets.map(target => [target.relativePath, target]));
  for (const target of predecessorTargets) {
    if (!target.relativePath.startsWith(EVIDENCE_LAYOUT_V3.papersRoot + '/')) continue;
    const current = currentByPath.get(target.relativePath);
    if (!current || current.sha256 !== target.sha256 || current.bytes.byteLength !== target.bytes.byteLength) {
      throw new EvidencePublicationError('EVIDENCE_CONFLICT', `immutable predecessor target differs: ${target.relativePath}`);
    }
  }
}

/** Build a deterministic filesystem-free publication value with private rendered target bytes. */
export function planEvidencePublication(input: {
  runId: string;
  sources: readonly (BufferedEvidenceSource | VerifiedArchiveV2)[];
  predecessor?: EvidencePublicationPlanV3;
}): EvidencePublicationPlanV3 {
  if (!safeRunId.test(input.runId)) rejectPath('runId is unsafe');
  const buffered = input.sources.map(source => 'manifest' in source ? bufferArchiveV2(source) : source);
  const unique = new Map(buffered.map(source => [evidencePaperRoot(source.source.baseId, source.source.version), source]));
  const targets = renderedTargets(buffered);
  const sources = sourceReceipts([...unique.values()], targets);
  let predecessorTargets: readonly TargetFile[] | undefined;
  if (input.predecessor) {
    const predecessorPrivate = evidencePublicationPlans.get(input.predecessor);
    if (!predecessorPrivate) throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'predecessor plan was not created by this publisher');
    predecessorTargets = predecessorPrivate.targets;
    validatePredecessorSources(sources, input.predecessor, targets, predecessorTargets);
  }
  const contentSha256 = hashCanonical(targets.map(target => ({
    path: target.relativePath,
    sha256: target.sha256,
    bytes: target.bytes.byteLength,
  })));
  const publicationId = `evidence-${hashCanonical({ runId: input.runId, contentSha256, publisherVersion: 3 }).slice(0, 32)}`;
  const plan = Object.freeze({
    schemaVersion: 1 as const,
    publisherVersion: 3 as const,
    runId: input.runId,
    publicationId,
    contentSha256,
    sources: Object.freeze(sources.map(source => Object.freeze({ ...source }))),
  });
  evidencePublicationPlans.set(plan, { targets, predecessorTargets });
  return plan;
}

/** Verify that an opaque v3 plan is the exact installed Vault projection without writing filesystem state. */
export async function verifyEvidencePublication(input: {
  plan: EvidencePublicationPlanV3;
  vaultRoot: string;
}): Promise<void> {
  const planPrivate = evidencePublicationPlans.get(input.plan);
  if (!planPrivate) throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'plan was not created by this publisher');
  if (!safeRunId.test(input.plan.runId)) rejectPath('runId is unsafe');
  assertVaultRoot(input.vaultRoot);
  const vaultRoot = await realDirectory(input.vaultRoot, 'vaultRoot');
  const installed = await classifyInstalled(vaultRoot, planPrivate.targets);
  if (installed !== 'current') {
    throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'installed Vault is not the exact publication projection');
  }
}

async function inspectJournalPaths(state: StatePaths): Promise<{ journal: boolean; temporary: boolean }> {
  const presence = { journal: false, temporary: false };
  for (const [key, path, label] of [
    ['journal', state.journalPath, 'publication journal'],
    ['temporary', `${state.journalPath}.new`, 'publication journal temporary'],
  ] as const) {
    await assertSafeDescendant(state.stateRoot, path, label, true);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) rejectPath(`${label} must be a real file`);
      presence[key] = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return presence;
}

function unresolvedStatePaths(stateRoot: string, runId: string): StatePaths {
  const evidenceRoot = resolve(stateRoot, 'runs', runId, 'evidence');
  return {
    stateRoot,
    evidenceRoot,
    backupsRoot: join(evidenceRoot, 'backups'),
    journalPath: join(evidenceRoot, 'publication-journal.json'),
    receiptPath: join(evidenceRoot, 'publication.json'),
  };
}

type InspectedJournal = {
  journal: Journal;
  source: 'durable' | 'temporary';
  cleanupPaths: readonly string[];
};

function journalActionsEqual(left: JournalAction, right: JournalAction): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function inspectJournalForRecovery(
  state: StatePaths,
  targets: readonly TargetFile[],
  binding: JournalBinding,
): Promise<InspectedJournal | null> {
  const presence = await inspectJournalPaths(state);
  if (!presence.journal && !presence.temporary) return null;
  const expected = expectedTargetMap(targets);
  const journalPath = state.journalPath;
  const temporaryPath = `${state.journalPath}.new`;
  const parse = async (path: string): Promise<Journal> => {
    try { return parseJournal(await readFile(path), expected, binding); }
    catch (error) {
      if (error instanceof EvidencePublicationError) throw error;
      throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal is unreadable');
    }
  };
  if (presence.journal && !presence.temporary) {
    return { journal: await parse(journalPath), source: 'durable', cleanupPaths: [journalPath] };
  }
  if (!presence.journal && presence.temporary) {
    return { journal: await parse(temporaryPath), source: 'temporary', cleanupPaths: [temporaryPath] };
  }

  const durable = await parse(journalPath);
  const temporary = await parse(temporaryPath);
  if (durable.actions.length > temporary.actions.length
    || durable.actions.some((action, index) => !journalActionsEqual(action, temporary.actions[index]!))) {
    throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'publication journal snapshots diverge');
  }
  return {
    journal: temporary,
    source: durable.actions.length === temporary.actions.length ? 'durable' : 'temporary',
    cleanupPaths: [journalPath, temporaryPath],
  };
}

function journalOwnedEvidenceArtifacts(vaultRoot: string, journal: Journal): ReadonlySet<string> {
  const evidenceRoot = resolve(vaultRoot, EVIDENCE_LAYOUT_V3.root);
  const allowed = new Set<string>();
  const addIfManaged = (path: string) => {
    if (!isInside(evidenceRoot, path)) return;
    allowed.add(relative(evidenceRoot, path).split(sep).join('/'));
  };
  for (const action of journal.actions) {
    if (!action.replacementStarted && !action.installed) continue;
    const target = targetPath(vaultRoot, action.target);
    addIfManaged(`${target}.new`);
    if (action.backup !== null) addIfManaged(`${target}.recovery`);
  }
  return allowed;
}

/** Apply an opaque v3 plan after classifying the installed Vault without creating filesystem state. */
export async function applyEvidencePublication(input: {
  plan: EvidencePublicationPlanV3;
  stateRoot: string;
  tempRoot: string;
  vaultRoot: string;
}): Promise<{ status: 'published' | 'replayed'; receipt: EvidencePublicationReceiptV3 }> {
  const planPrivate = evidencePublicationPlans.get(input.plan);
  if (!planPrivate) throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'plan was not created by this publisher');
  if (!safeRunId.test(input.plan.runId)) rejectPath('runId is unsafe');
  assertVaultRoot(input.vaultRoot);
  const [stateRoot, tempRoot, vaultRoot] = await Promise.all([
    realDirectory(input.stateRoot, 'stateRoot'), realDirectory(input.tempRoot, 'tempRoot'), realDirectory(input.vaultRoot, 'vaultRoot'),
  ]);
  for (const runtimeRoot of [stateRoot, tempRoot]) {
    if (runtimeRoot === vaultRoot || isInside(vaultRoot, runtimeRoot) || isInside(runtimeRoot, vaultRoot)) {
      rejectPath('runtime publication roots must be disjoint from the Vault');
    }
  }

  const unresolvedState = unresolvedStatePaths(stateRoot, input.plan.runId);
  const publicationLock = join(unresolvedState.evidenceRoot, 'publication.lock');
  await assertSafeDescendant(stateRoot, publicationLock, 'publication lock', true);
  const journalBinding: JournalBinding = {
    publisherVersion: 3,
    runId: input.plan.runId,
    publicationId: input.plan.publicationId,
    contentSha256: input.plan.contentSha256,
  };
  const preflightJournal = await inspectJournalForRecovery(unresolvedState, planPrivate.targets, journalBinding);
  const preflightArtifacts = preflightJournal
    ? journalOwnedEvidenceArtifacts(vaultRoot, preflightJournal.journal)
    : new Set<string>();
  await assertKnownManagedPaths(vaultRoot, planPrivate.targets, preflightArtifacts);
  if (!preflightJournal) {
    await classifyInstalled(vaultRoot, planPrivate.targets, planPrivate.predecessorTargets);
  }

  return withRunLock(publicationLock, async () => {
    const state = await statePaths(stateRoot, input.plan.runId);
    const inspectedJournal = await inspectJournalForRecovery(state, planPrivate.targets, journalBinding);
    const allowedTransactionArtifacts = inspectedJournal
      ? journalOwnedEvidenceArtifacts(vaultRoot, inspectedJournal.journal)
      : new Set<string>();
    await assertKnownManagedPaths(vaultRoot, planPrivate.targets, allowedTransactionArtifacts);
    if (inspectedJournal) {
      await recoverJournal(state, vaultRoot, planPrivate.targets, journalBinding);
    }
    const installed = await classifyInstalled(vaultRoot, planPrivate.targets, planPrivate.predecessorTargets);
    const receiptInput = {
      schemaVersion: 1 as const,
      publicationId: input.plan.publicationId,
      runId: input.plan.runId,
      publisherVersion: 3 as const,
      contentSha256: input.plan.contentSha256,
      sources: input.plan.sources,
    };
    await recoverPublicationReceiptTemporary<EvidencePublicationReceiptV3>({ path: state.receiptPath, receipt: receiptInput });
    const manifestPath = join(state.evidenceRoot, 'manifest.json');
    const manifestContents = canonicalJson({ schemaVersion: 3, publicationId: input.plan.publicationId, sources: input.plan.sources,
      files: planPrivate.targets.map(target => ({ path: target.relativePath, sha256: target.sha256, bytes: target.bytes.byteLength })) });
    await assertSafeDescendant(state.evidenceRoot, manifestPath, 'publication manifest', true);
    try {
      if (await readFile(manifestPath, 'utf8') !== manifestContents) throw new EvidenceReceiptError('publication manifest differs from this plan');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(manifestPath, manifestContents, { flag: 'wx' });
    }
    const existingReceipt = await readPublicationReceipt(state.receiptPath);
    if (existingReceipt) {
      if (existingReceipt.publisherVersion !== 3 || !equivalentReceipt(existingReceipt, receiptInput)) {
        throw new EvidenceReceiptError('existing receipt differs from this publication');
      }
      if (installed !== 'current') throw new EvidenceReceiptError('existing receipt does not match installed Evidence files');
      return { status: 'replayed' as const, receipt: existingReceipt };
    }

    if (installed !== 'current') {
      const predecessorByPath = new Map(planPrivate.predecessorTargets?.map(target => [target.relativePath, target]) ?? []);
      const installTargets = installed === 'predecessor'
        ? planPrivate.targets.filter(target => predecessorByPath.get(target.relativePath)?.sha256 !== target.sha256)
        : planPrivate.targets;
      const stageRoot = await ensureDirectoryChain(tempRoot, ['evidence-publications', input.plan.publicationId], 'staging root');
      await stageFiles(stageRoot, installTargets);
      await installFiles({ vaultRoot, state, stageRoot, targets: installTargets, journalBinding });
    }
    const verified = await classifyInstalled(vaultRoot, planPrivate.targets, planPrivate.predecessorTargets);
    if (verified !== 'current') throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'installed publication cannot be verified');
    await assertSafeDescendant(state.evidenceRoot, state.receiptPath, 'publication receipt', true);
    await assertSafeDescendant(state.evidenceRoot, `${state.receiptPath}.new`, 'publication receipt temporary', true);
    const receipt = await createOrReplayReceipt<EvidencePublicationReceiptV3>({ path: state.receiptPath, receipt: receiptInput });
    return { status: receipt.status === 'replayed' ? 'replayed' as const : 'published' as const, receipt: receipt.receipt };
  }, { waitMs: 30_000 });
}

/** Convenience entry point; every active publication uses the v3 planner and transaction. */
export async function publishEvidence(input: {
  runId: string; stateRoot: string; tempRoot: string; vaultRoot: string; sources: readonly EvidenceInput[];
}): Promise<{ status: 'published' | 'replayed'; receipt: EvidencePublicationReceiptV3 }> {
  if (!safeRunId.test(input.runId)) rejectPath('runId is unsafe');
  const sources = await prepareEvidenceSources(input.sources);
  return applyEvidencePublication({ ...input, plan: planEvidencePublication({ runId: input.runId, sources }) });
}
