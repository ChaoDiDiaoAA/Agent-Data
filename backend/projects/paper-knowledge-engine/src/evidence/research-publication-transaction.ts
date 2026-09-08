import { copyFile, lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, normalizeArchivePath } from '../shared/manifest.ts';
import { replaceFileWithRetry } from './atomic-replace.ts';
import { SOURCE_EVIDENCE_LAYOUT_V1, researchEvidencePath } from '../shared/research-evidence-policy.ts';

export interface ResearchEvidenceTarget {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface ResearchPublicationBinding {
  readonly publisherVersion: 1;
  readonly runId: string;
  readonly publicationId: string;
  readonly contentSha256: string;
}

export class ResearchPublicationTransactionError extends Error {
  constructor(
    readonly code: 'EVIDENCE_CONFLICT' | 'EVIDENCE_INTERRUPTED' | 'EVIDENCE_PATH' | 'EVIDENCE_IO',
    message: string,
    cause?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ResearchPublicationTransactionError';
    if (cause !== undefined) this.cause = cause;
  }
}

type JournalAction = {
  target: string;
  expectedSha256: string;
  backup: string | null;
  backupSha256: string | null;
  replacementStarted: boolean;
  installed: boolean;
};
type Journal = ResearchPublicationBinding & { schemaVersion: 1; actions: JournalAction[] };
type StatePaths = {
  evidenceRoot: string;
  backupsRoot: string;
  journalPath: string;
};

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const sha256Pattern = /^[0-9a-f]{64}$/;
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function conflict(message: string): never { throw new ResearchPublicationTransactionError('EVIDENCE_CONFLICT', message); }
function rejectPath(message: string): never { throw new ResearchPublicationTransactionError('EVIDENCE_PATH', message); }

function inside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function assertSafeBinding(binding: ResearchPublicationBinding): void {
  if (binding.publisherVersion !== 1 || !safeSegment.test(binding.runId) || !safeSegment.test(binding.publicationId)
    || !sha256Pattern.test(binding.contentSha256)) rejectPath('research publication binding is unsafe');
}

async function existingRealDirectory(path: string, label: string): Promise<void> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { await mkdir(path, { recursive: true }); info = await lstat(path); } else throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) rejectPath(`${label} must be a real directory`);
}

async function assertSafeDescendant(root: string, candidate: string, label: string, allowMissing = false): Promise<void> {
  const lexical = resolve(candidate);
  if (!inside(root, lexical)) rejectPath(`${label} escapes its root`);
  const parts = relative(root, lexical).split(sep);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) rejectPath(`${label} traverses a symlink or junction`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return;
      throw error;
    }
  }
}

async function ensureParent(root: string, target: string, label: string): Promise<void> {
  const parts = relative(root, target).split(sep);
  parts.pop();
  let current = root;
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\')) rejectPath(`${label} has an unsafe path`);
    const next = join(current, part);
    try {
      const info = await lstat(next);
      if (!info.isDirectory() || info.isSymbolicLink()) rejectPath(`${label} traverses a symlink or junction`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(next);
    }
    current = next;
  }
  await assertSafeDescendant(root, target, label, true);
}

function targetPath(vaultRoot: string, relativePath: string): string {
  let normalized: string;
  try { normalized = researchEvidencePath(relativePath); }
  catch { rejectPath(`target path is outside research Evidence: ${relativePath}`); }
  if (!normalized!.startsWith(`${SOURCE_EVIDENCE_LAYOUT_V1.sourcesRoot}/`)
    && !Object.values(SOURCE_EVIDENCE_LAYOUT_V1.indexRoots).includes(normalized! as never)) {
    rejectPath(`target path is not a research Evidence file: ${normalized}`);
  }
  return resolve(vaultRoot, ...normalized!.split('/'));
}

function normalizeTargets(targets: readonly ResearchEvidenceTarget[]): ResearchEvidenceTarget[] {
  const result = targets.map(target => {
    let relativePath: string;
    try { relativePath = researchEvidencePath(normalizeArchivePath(target.relativePath)); }
    catch { rejectPath(`target path is unsafe: ${target.relativePath}`); }
    if (!relativePath!.startsWith(`${SOURCE_EVIDENCE_LAYOUT_V1.sourcesRoot}/`)
      && !Object.values(SOURCE_EVIDENCE_LAYOUT_V1.indexRoots).includes(relativePath! as never)) {
      rejectPath(`target path is outside research Evidence: ${relativePath}`);
    }
    if (!(target.bytes instanceof Uint8Array) || !sha256Pattern.test(target.sha256) || hash(target.bytes) !== target.sha256) {
      conflict(`target hash differs: ${relativePath}`);
    }
    return { relativePath: relativePath!, bytes: new Uint8Array(target.bytes), sha256: target.sha256 };
  }).sort((left, right) => compareText(left.relativePath, right.relativePath));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]!.relativePath === result[index]!.relativePath) conflict(`duplicate target: ${result[index]!.relativePath}`);
  }
  return result;
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) rejectPath(`managed Evidence path is a symlink or junction: ${relativePath}`);
    if (entry.isDirectory()) { result.push(`${relativePath}/`); result.push(...await listFiles(path, relativePath)); }
    else if (entry.isFile()) result.push(relativePath);
    else rejectPath(`managed Evidence path is not a regular file: ${relativePath}`);
  }
  return result.sort(compareText);
}

function expectedDirectories(targets: readonly ResearchEvidenceTarget[]): Set<string> {
  const result = new Set<string>();
  for (const target of targets) {
    const parts = target.relativePath.split('/').slice(1);
    for (let index = 1; index < parts.length; index += 1) result.add(`${parts.slice(0, index).join('/')}/`);
  }
  return result;
}

async function assertKnownInventory(vaultRoot: string, targets: readonly ResearchEvidenceTarget[]): Promise<void> {
  const entries = await readdir(vaultRoot);
  if (entries.some(name => name.toLowerCase() === 'evidence' && name !== 'Evidence')) rejectPath('Evidence root has a different case identity');
  const root = join(vaultRoot, 'Evidence');
  await assertSafeDescendant(vaultRoot, root, 'Evidence root', true);
  const expected = new Set(targets.map(target => target.relativePath.slice('Evidence/'.length)));
  const actual = await listFiles(root);
  const directories = expectedDirectories(targets);
  for (const path of actual) {
    if (!expected.has(path) && !directories.has(path)) conflict(`unknown manual Evidence file: Evidence/${path}`);
  }
}

async function verifyTargets(vaultRoot: string, targets: readonly ResearchEvidenceTarget[]): Promise<void> {
  await assertKnownInventory(vaultRoot, targets);
  for (const target of targets) {
    const path = targetPath(vaultRoot, target.relativePath);
    await assertSafeDescendant(vaultRoot, path, `managed target ${target.relativePath}`, true);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) rejectPath(`managed target is not a real file: ${target.relativePath}`);
      if (hash(await readFile(path)) !== target.sha256) conflict(`managed file differs: ${target.relativePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') conflict(`managed target is missing: ${target.relativePath}`);
      throw error;
    }
  }
}

async function statePaths(stateRoot: string, binding: ResearchPublicationBinding): Promise<StatePaths> {
  const evidenceRoot = join(stateRoot, 'runs', binding.runId, 'evidence');
  await assertSafeDescendant(stateRoot, evidenceRoot, 'state evidence root', true);
  await existingRealDirectory(evidenceRoot, 'state evidence root');
  const backupsRoot = join(evidenceRoot, 'backups');
  await existingRealDirectory(backupsRoot, 'state evidence backups');
  const journalPath = join(evidenceRoot, 'source-publication-journal.json');
  await assertSafeDescendant(evidenceRoot, journalPath, 'source publication journal', true);
  await assertSafeDescendant(evidenceRoot, `${journalPath}.new`, 'source publication journal temporary', true);
  return { evidenceRoot, backupsRoot, journalPath };
}

function expectedMap(targets: readonly ResearchEvidenceTarget[]): Map<string, ResearchEvidenceTarget> {
  return new Map(targets.map(target => [target.relativePath, target]));
}

function parseJournal(contents: string, binding: ResearchPublicationBinding, targets: readonly ResearchEvidenceTarget[]): Journal {
  let value: unknown;
  try { value = JSON.parse(contents); } catch { conflict('source publication journal is unreadable'); }
  if (canonicalJson(value) !== contents || !value || typeof value !== 'object' || Array.isArray(value)) conflict('source publication journal is not canonical');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join('\u0000');
  const expectedKeys = ['actions', 'contentSha256', 'publicationId', 'publisherVersion', 'runId', 'schemaVersion'].sort().join('\u0000');
  if (keys !== expectedKeys || record.schemaVersion !== 1 || record.publisherVersion !== binding.publisherVersion
    || record.runId !== binding.runId || record.publicationId !== binding.publicationId || record.contentSha256 !== binding.contentSha256
    || !Array.isArray(record.actions)) conflict('source publication journal binding differs');
  const expected = expectedMap(targets);
  const actions = (record.actions as unknown[]).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) conflict('source publication journal action is invalid');
    const action = value as Record<string, unknown>;
    const actionKeys = Object.keys(action).sort().join('\u0000');
    if (actionKeys !== ['backup', 'backupSha256', 'expectedSha256', 'installed', 'replacementStarted', 'target'].sort().join('\u0000')
      || typeof action.target !== 'string' || typeof action.expectedSha256 !== 'string' || !sha256Pattern.test(action.expectedSha256)
      || typeof action.replacementStarted !== 'boolean' || typeof action.installed !== 'boolean'
      || (action.backup !== null && typeof action.backup !== 'string')
      || (action.backupSha256 !== null && (typeof action.backupSha256 !== 'string' || !sha256Pattern.test(action.backupSha256)))) {
      conflict('source publication journal action is invalid');
    }
    let target: string;
    try { target = researchEvidencePath(action.target); } catch { rejectPath('source publication journal target is unsafe'); }
    const expectedTarget = expected.get(target!);
    if (!expectedTarget || expectedTarget.sha256 !== action.expectedSha256) conflict('source publication journal target differs');
    if ((action.backup === null) !== (action.backupSha256 === null)) conflict('source publication journal backup identity differs');
    if (action.backup !== null && action.backup !== target) conflict('source publication journal backup target differs');
    return { target: target!, expectedSha256: action.expectedSha256, backup: action.backup, backupSha256: action.backupSha256,
      replacementStarted: action.replacementStarted, installed: action.installed };
  });
  if (actions.length > targets.length) conflict('source publication journal has too many actions');
  for (let index = 0; index < actions.length; index += 1) {
    const expectedTarget = targets[index];
    if (!expectedTarget || actions[index]!.target !== expectedTarget.relativePath) conflict('source publication journal action order differs');
  }
  return { schemaVersion: 1, ...binding, actions };
}

async function writeJournal(path: string, journal: Journal): Promise<void> {
  const temporary = `${path}.new`;
  await assertSafeDescendant(dirname(path), path, 'source publication journal', true);
  await assertSafeDescendant(dirname(path), temporary, 'source publication journal temporary', true);
  await writeFile(temporary, canonicalJson(journal), { flag: 'wx' });
  try { await replaceFileWithRetry(temporary, path); }
  catch (error) { throw new ResearchPublicationTransactionError('EVIDENCE_IO', 'source publication journal replacement failed', error); }
}

async function removeJournal(state: StatePaths): Promise<void> {
  for (const path of [state.journalPath, `${state.journalPath}.new`]) {
    try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await rm(state.backupsRoot, { recursive: true, force: true });
  await mkdir(state.backupsRoot, { recursive: true });
}

async function restoreTarget(input: {
  vaultRoot: string;
  state: StatePaths;
  action: JournalAction;
}): Promise<void> {
  const target = targetPath(input.vaultRoot, input.action.target);
  const temporary = `${target}.new`;
  await assertSafeDescendant(input.vaultRoot, target, `journal target ${input.action.target}`, true);
  await assertSafeDescendant(input.vaultRoot, temporary, `journal temporary ${input.action.target}`, true);
  try {
    const info = await lstat(temporary);
    if (!info.isFile() || info.isSymbolicLink()) rejectPath(`journal temporary is not a real file: ${input.action.target}`);
    if (hash(await readFile(temporary)) !== input.action.expectedSha256) conflict(`journal temporary differs: ${input.action.target}`);
    await unlink(temporary);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!input.action.replacementStarted && !input.action.installed) return;

  let targetHash: string | null = null;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) rejectPath(`journal target is not a real file: ${input.action.target}`);
    targetHash = hash(await readFile(target));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  if (input.action.backup !== null) {
    const backup = resolve(input.state.backupsRoot, ...input.action.backup.split('/'));
    if (!inside(input.state.backupsRoot, backup)) rejectPath('journal backup escapes state root');
    await assertSafeDescendant(input.state.backupsRoot, backup, 'journal backup', false);
    const backupBytes = await readFile(backup);
    if (hash(backupBytes) !== input.action.backupSha256) conflict(`journal backup differs: ${input.action.target}`);
    if (targetHash === input.action.backupSha256) return;
    if (targetHash !== null && targetHash !== input.action.expectedSha256) conflict(`journal target contains unexpected bytes: ${input.action.target}`);
    await ensureParent(input.vaultRoot, target, `journal recovery ${input.action.target}`);
    const recovery = `${target}.recovery`;
    await writeFile(recovery, backupBytes, { flag: 'wx' });
    await replaceFileWithRetry(recovery, target);
    return;
  }
  if (targetHash === input.action.expectedSha256) await unlink(target);
  else if (targetHash !== null) conflict(`journal target contains unexpected bytes: ${input.action.target}`);
}

async function recover(state: StatePaths, vaultRoot: string, binding: ResearchPublicationBinding, targets: readonly ResearchEvidenceTarget[]): Promise<void> {
  let journal: Journal;
  try {
    journal = parseJournal(await readFile(state.journalPath, 'utf8'), binding, targets);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    let temporaryContents: string;
    try { temporaryContents = await readFile(`${state.journalPath}.new`, 'utf8'); }
    catch (temporaryError) {
      if ((temporaryError as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw temporaryError;
    }
    journal = parseJournal(temporaryContents, binding, targets);
    for (const action of [...journal.actions].reverse()) await restoreTarget({ vaultRoot, state, action });
    await removeJournal(state);
    return;
  }
  let temporaryContents: string | null = null;
  try { temporaryContents = await readFile(`${state.journalPath}.new`, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (temporaryContents !== null) {
    const temporary = parseJournal(temporaryContents, binding, targets);
    if (canonicalJson(temporary) !== canonicalJson(journal)) conflict('source publication journal snapshots diverge');
  }
  for (const action of [...journal.actions].reverse()) await restoreTarget({ vaultRoot, state, action });
  await removeJournal(state);
}

async function install(input: {
  state: StatePaths;
  vaultRoot: string;
  binding: ResearchPublicationBinding;
  targets: readonly ResearchEvidenceTarget[];
}): Promise<void> {
  await recover(input.state, input.vaultRoot, input.binding, input.targets);
  const journal: Journal = { schemaVersion: 1, ...input.binding, actions: [] };
  await writeJournal(input.state.journalPath, journal);
  let count = 0;
  for (const targetFile of input.targets) {
    const target = targetPath(input.vaultRoot, targetFile.relativePath);
    await assertSafeDescendant(input.vaultRoot, target, `install target ${targetFile.relativePath}`, true);
    let backup: string | null = null;
    let backupSha256: string | null = null;
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) rejectPath(`install target is not a real file: ${targetFile.relativePath}`);
      backup = targetFile.relativePath;
      const previous = await readFile(target);
      backupSha256 = hash(previous);
      const backupPath = resolve(input.state.backupsRoot, ...backup.split('/'));
      if (!inside(input.state.backupsRoot, backupPath)) rejectPath('publication backup escapes state root');
      await ensureParent(input.state.backupsRoot, backupPath, 'publication backup');
      await copyFile(target, backupPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const action: JournalAction = { target: targetFile.relativePath, expectedSha256: targetFile.sha256, backup, backupSha256, replacementStarted: false, installed: false };
    journal.actions.push(action);
    await writeJournal(input.state.journalPath, journal);
    action.replacementStarted = true;
    await writeJournal(input.state.journalPath, journal);
    await ensureParent(input.vaultRoot, target, `install target ${targetFile.relativePath}`);
    const temporary = `${target}.new`;
    await assertSafeDescendant(input.vaultRoot, temporary, `install temporary ${targetFile.relativePath}`, true);
    await writeFile(temporary, targetFile.bytes, { flag: 'wx' });
    try { await replaceFileWithRetry(temporary, target); }
    catch (error) { throw new ResearchPublicationTransactionError('EVIDENCE_IO', `install replacement failed: ${targetFile.relativePath}`, error); }
    if (hash(await readFile(target)) !== targetFile.sha256) conflict(`installed hash differs: ${targetFile.relativePath}`);
    action.installed = true;
    await writeJournal(input.state.journalPath, journal);
    count += 1;
    if (Number(process.env.RESEARCH_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL) === count) {
      throw new ResearchPublicationTransactionError('EVIDENCE_INTERRUPTED', 'synthetic interruption after research Evidence install');
    }
  }
  await removeJournal(input.state);
}

export async function verifyResearchEvidenceTargets(input: {
  vaultRoot: string;
  targets: readonly ResearchEvidenceTarget[];
}): Promise<void> {
  const targets = normalizeTargets(input.targets);
  await existingRealDirectory(input.vaultRoot, 'vaultRoot');
  await verifyTargets(input.vaultRoot, targets);
}

/** Install only the generic research Evidence inventory; all filesystem recovery is journal-driven. */
export async function installResearchEvidenceTargets(input: {
  stateRoot: string;
  tempRoot: string;
  vaultRoot: string;
  binding: ResearchPublicationBinding;
  targets: readonly ResearchEvidenceTarget[];
}): Promise<void> {
  assertSafeBinding(input.binding);
  const targets = normalizeTargets(input.targets);
  await existingRealDirectory(input.stateRoot, 'stateRoot');
  await existingRealDirectory(input.tempRoot, 'tempRoot');
  await existingRealDirectory(input.vaultRoot, 'vaultRoot');
  const vault = resolve(input.vaultRoot), temp = resolve(input.tempRoot);
  if (vault === temp || inside(vault, temp) || inside(temp, vault)) rejectPath('tempRoot must be separate from vaultRoot');
  const state = await statePaths(resolve(input.stateRoot), input.binding);
  await recover(state, vault, input.binding, targets);
  await assertKnownInventory(vault, targets);
  await install({ state, vaultRoot: vault, binding: input.binding, targets });
  await verifyTargets(vault, targets);
}
