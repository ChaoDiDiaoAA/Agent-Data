import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { canonicalJson, hashCanonical } from '../shared/manifest.ts';
import { renderEvidenceV3 } from '../evidence/layout-v3.ts';
import { EVIDENCE_LAYOUT_V3, type EvidenceFile } from '../evidence/layout-paths.ts';
import { planEvidencePublication } from '../evidence/publisher.ts';
import { assertUniqueVaultPaths, validateVault, vaultAbsolutePath, type VaultValidationReport } from '../evidence/vault-validator.ts';
import { assertRealPath, pathIdentity, realTree, verifyArchiveV2, type VerifiedArchiveV2 } from '../shared/archive-v2.ts';
import { assertLibraryId, type LibraryId } from '../shared/identity.ts';
import type { LibraryPaths } from '../shared/paths.ts';
import { createHash } from 'node:crypto';

export type VaultRuntimeRoots = Pick<LibraryPaths, 'dataRoot' | 'workRoot' | 'runsRoot' | 'operationsRoot' | 'backupRoot' | 'pdfRoot'>;
export interface VaultRebuildInput {
  legacyVaultRoot: string; archiveRoot: string; vaultRoot: string; libraryId: LibraryId;
  /** dataRoot is also the compatibility stateRoot; workRoot owns all temporary runtime work. */
  runtimeRoots: VaultRuntimeRoots;
}
interface FileEntry { path: string; sha256: string; bytes: number }
interface TreeSnapshot { directories: string[]; files: FileEntry[] }
export interface VaultRebuildPlan extends VaultRebuildInput {
  schemaVersion: 1;
  sha256: string;
  publicationId: string;
  stagingRoot: string;
  sourceIdentity: { archive: string; legacyVault: string };
  archive: TreeSnapshot;
  settings: TreeSnapshot;
  paperCount: number;
  directories: string[];
  files: FileEntry[];
}
export interface VaultRebuildResult { vaultRoot: string; publicationId: string; planSha256: string; replayed: boolean; validation: VaultValidationReport }
interface VaultRebuildApplyInput extends VaultRebuildInput {
  planFile: string;
  planSha256: string;
  /** Filesystem fault seam: must perform one atomic directory rename. */
  install?: (staging: string, destination: string) => Promise<void>;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const info = (path: string) => lstat(path).catch(error => { if (absent(error)) return null; throw error; });
const fail = (code: string, detail: string): never => { throw new Error(`VAULT_REBUILD_${code}: ${detail}`); };
const key = (path: string) => path.replaceAll('\\', '/').toLowerCase();
const inside = (a: string, b: string) => key(a) === key(b) || key(b).startsWith(key(a) + '/');
const disjoint = (a: string, b: string) => { if (inside(a, b) || inside(b, a)) fail('PATH_UNSAFE', `overlapping roots: ${a}, ${b}`); };
const runtimeRootNames = ['dataRoot', 'workRoot', 'runsRoot', 'operationsRoot', 'backupRoot'] as const;

function canonicalRuntimeRoots(value: VaultRuntimeRoots): VaultRuntimeRoots {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).filter(name => name !== 'pdfRoot').sort().join(',') !== [...runtimeRootNames].sort().join(',')) fail('PATH_UNSAFE', 'complete runtime protection roots required');
  const roots = Object.fromEntries(runtimeRootNames.map(name => [name, vaultAbsolutePath(value[name])])) as VaultRuntimeRoots;
  if ('pdfRoot' in value) roots.pdfRoot = vaultAbsolutePath(value.pdfRoot!);
  return roots;
}
function protectRuntime(projection: string, roots: VaultRuntimeRoots): void {
  // Runtime roots intentionally nest (dataRoot contains work/runs/operations).
  // Disjointness is required for every projection/runtime pair, in both directions.
  for (const runtime of Object.values(roots)) disjoint(projection, runtime);
}

async function prospectiveDirectory(path: string): Promise<void> {
  const entry = await info(path);
  if (!entry) {
    const parent = dirname(path); if (parent === path) fail('PATH_UNSAFE', 'missing filesystem root');
    await prospectiveDirectory(parent); return;
  }
  await assertRealPath(path);
  if (!entry.isDirectory()) fail('PATH_UNSAFE', 'expected directory: ' + path);
  // Windows permits callers to address an existing name with different casing.
  // Reject that alias even on case-sensitive volumes so plans remain portable.
  const parent = dirname(path);
  if (parent !== path) {
    const name = path.slice(parent.length).replace(/^[\\/]/, '');
    const names = await readdir(parent);
    if (names.some(n => n.toLowerCase() === name.toLowerCase() && n !== name)) fail('PATH_UNSAFE', 'case alias: ' + path);
  }
}
async function checkedRoots(input: VaultRebuildInput): Promise<VaultRebuildInput> {
  try {
    assertLibraryId(input.libraryId);
    const roots = { libraryId: input.libraryId, legacyVaultRoot: vaultAbsolutePath(input.legacyVaultRoot),
      archiveRoot: vaultAbsolutePath(input.archiveRoot), vaultRoot: vaultAbsolutePath(input.vaultRoot),
      runtimeRoots: canonicalRuntimeRoots(input.runtimeRoots) };
    const values = [roots.legacyVaultRoot, roots.archiveRoot, roots.vaultRoot];
    for (let i = 0; i < values.length; i++) for (const b of values.slice(i + 1)) disjoint(values[i]!, b);
    protectRuntime(roots.legacyVaultRoot, roots.runtimeRoots);
    protectRuntime(roots.vaultRoot, roots.runtimeRoots);
    for (const path of [...values, ...Object.values(roots.runtimeRoots)]) await prospectiveDirectory(path);
    await assertRealPath(roots.archiveRoot); await assertRealPath(roots.legacyVaultRoot);
    return roots;
  } catch (error) { return fail('PATH_UNSAFE', String(error)); }
}
async function tree(root: string): Promise<{ snapshot: TreeSnapshot; payloads: Map<string, Uint8Array> }> {
  const paths = await realTree(root); assertUniqueVaultPaths(paths);
  const files: FileEntry[] = [], payloads = new Map<string, Uint8Array>();
  for (const path of paths.filter(p => !p.endsWith('/'))) {
    await assertRealPath(join(root, path));
    const bytes = await readFile(join(root, path));
    files.push({ path, sha256: hash(bytes), bytes: bytes.length }); payloads.set(path, bytes);
  }
  return { snapshot: { directories: paths.filter(p => p.endsWith('/')), files }, payloads };
}
async function prepare(input: VaultRebuildInput) {
  const roots = await checkedRoots(input);
  let archive: Awaited<ReturnType<typeof tree>>, settings: Awaited<ReturnType<typeof tree>>;
  try { archive = await tree(roots.archiveRoot); }
  catch (error) { return fail('PATH_UNSAFE', String(error)); }
  const packages = archive.snapshot.directories.filter(p => /^[^/]+\/$/.test(p));
  for (const path of [...archive.snapshot.directories, ...archive.snapshot.files.map(f => f.path)]) {
    if (!packages.some(p => path.startsWith(p))) fail('INVALID_ARCHIVE', `unexpected path: ${path}`);
  }
  const sources: VerifiedArchiveV2[] = [];
  for (const path of packages) {
    try {
      const source = await verifyArchiveV2(join(roots.archiveRoot, path));
      if (source.manifest.libraryId !== roots.libraryId || path !== `${source.manifest.baseId}-v${source.manifest.version}/`) throw new Error('Archive directory/library identity mismatch');
      sources.push(source);
    } catch (error) { return fail('INVALID_ARCHIVE', `${path}: ${error}`); }
  }
  const settingsRoot = join(roots.legacyVaultRoot, '.obsidian');
  try {
    const aliases = (await readdir(roots.legacyVaultRoot)).filter(n => n.toLowerCase() === '.obsidian');
    if (aliases.some(n => n !== '.obsidian')) throw new Error('case alias for .obsidian');
    settings = await info(settingsRoot) ? await tree(settingsRoot) : { snapshot: { directories: [], files: [] }, payloads: new Map() };
  } catch (error) { return fail('PATH_UNSAFE', String(error)); }
  const hasSettings = !!await info(settingsRoot);
  const files: EvidenceFile[] = renderEvidenceV3(sources);
  for (const [path, bytes] of settings.payloads) files.push({ path: `.obsidian/${path}`, bytes, sha256: hash(bytes) });
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const directories = new Set([
    `${EVIDENCE_LAYOUT_V3.root}/`,
    `${EVIDENCE_LAYOUT_V3.papersRoot}/`,
    `${posix.dirname(EVIDENCE_LAYOUT_V3.indexes.authors)}/`,
    ...(hasSettings ? ['.obsidian/', ...settings.snapshot.directories.map(p => `.obsidian/${p}`)] : []),
  ]);
  for (const file of files) for (let p = posix.dirname(file.path); p !== '.'; p = posix.dirname(p)) directories.add(p + '/');
  const { publicationId } = planEvidencePublication({ runId: `vault-rebuild-${roots.libraryId}`, sources });
  const stagingRoot = join(dirname(roots.vaultRoot), `.${roots.libraryId}-rebuild-${publicationId}`);
  disjoint(stagingRoot, roots.legacyVaultRoot); disjoint(stagingRoot, roots.archiveRoot); disjoint(stagingRoot, roots.vaultRoot);
  protectRuntime(stagingRoot, roots.runtimeRoots);
  try { await prospectiveDirectory(stagingRoot); } catch (error) { return fail('PATH_UNSAFE', String(error)); }
  const body = { schemaVersion: 1 as const, ...roots, publicationId, stagingRoot,
    sourceIdentity: { archive: await pathIdentity(roots.archiveRoot), legacyVault: await pathIdentity(roots.legacyVaultRoot) },
    archive: archive.snapshot, settings: settings.snapshot, paperCount: sources.length,
    directories: [...directories].sort(), files: files.map(f => ({ path: f.path, sha256: f.sha256, bytes: f.bytes.length })) };
  return { plan: { ...body, sha256: hashCanonical(body) } satisfies VaultRebuildPlan, sources, files };
}

/** A dry-run creates no plan file, staging directory, runtime receipt or Vault. */
export async function createVaultRebuildPlan(input: VaultRebuildInput): Promise<VaultRebuildPlan> { return (await prepare(input)).plan; }

async function readBoundPlan(input: VaultRebuildApplyInput): Promise<VaultRebuildPlan> {
  try {
    const path = vaultAbsolutePath(input.planFile); await assertRealPath(path);
    for (const root of [input.legacyVaultRoot, input.archiveRoot, input.vaultRoot]) if (inside(root, path)) fail('PATH_UNSAFE', 'plan file must be outside source and target roots');
    const bytes = await readFile(path, 'utf8'), raw = JSON.parse(bytes);
    const { sha256, ...body } = raw;
    if (!/^[0-9a-f]{64}$/.test(input.planSha256) || sha256 !== input.planSha256 || hashCanonical(body) !== sha256 || canonicalJson(raw) !== bytes) throw new Error('reviewed plan SHA-256 mismatch');
    // Never trust paths or payloads from JSON: callers must match a freshly derived plan.
    return raw as VaultRebuildPlan;
  } catch (error) { return fail('PLAN_DRIFT', String(error)); }
}
async function reviewed(input: VaultRebuildApplyInput) {
  const plan = await readBoundPlan(input);
  try {
    const prepared = await prepare(input);
    if (canonicalJson(plan) !== canonicalJson(prepared.plan)) throw new Error('source/settings inventory or plan differs');
    if (inside(prepared.plan.stagingRoot, input.planFile)) throw new Error('plan file is inside staging');
    return prepared;
  } catch (error) { return fail('PLAN_DRIFT', String(error)); }
}
async function exact(root: string, plan: VaultRebuildPlan) {
  const actual = (await tree(root)).snapshot;
  const files = new Map(actual.files.map(file => [file.path, file]));
  for (const file of plan.files) {
    if (canonicalJson(files.get(file.path) ?? null) !== canonicalJson(file)) fail('TARGET_CONFLICT', 'missing or changed file: ' + file.path);
    files.delete(file.path);
  }
  if (files.size) fail('TARGET_CONFLICT', 'unexpected file: ' + files.keys().next().value);
  const directories = new Set(actual.directories);
  for (const path of plan.directories) if (!directories.delete(path)) fail('TARGET_CONFLICT', 'missing directory: ' + path);
  if (directories.size) fail('TARGET_CONFLICT', 'unexpected directory: ' + directories.values().next().value);
}
async function validated(root: string, sources: VerifiedArchiveV2[]) {
  const report = await validateVault({ vaultRoot: root, sources });
  if (!report.valid) fail('VALIDATION_FAILED', canonicalJson(report));
  return report;
}
async function makeParents(path: string): Promise<void> {
  await prospectiveDirectory(path);
  if (await info(path)) return;
  await makeParents(dirname(path)); await mkdir(path); await assertRealPath(path);
}
async function inode(path: string): Promise<string> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail('PATH_UNSAFE', 'expected real directory');
  return `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`;
}

export async function applyVaultRebuild(input: VaultRebuildApplyInput): Promise<VaultRebuildResult> {
  const prepared = await reviewed(input), { plan, sources, files } = prepared;
  const result = (replayed: boolean, validation: VaultValidationReport): VaultRebuildResult => ({ vaultRoot: plan.vaultRoot,
    publicationId: plan.publicationId, planSha256: plan.sha256, replayed, validation });
  if (await info(plan.vaultRoot)) {
    try { await exact(plan.vaultRoot, plan); return result(true, await validated(plan.vaultRoot, sources)); }
    catch (error) { return fail('TARGET_CONFLICT', String(error)); }
  }
  await makeParents(dirname(plan.vaultRoot));
  const parentIdentity = await pathIdentity(dirname(plan.vaultRoot));
  const parentUnchanged = async () => {
    if (parentIdentity !== await pathIdentity(dirname(plan.vaultRoot))) fail('PATH_UNSAFE', 'target parent identity changed');
  };
  // Exclusive mkdir owns this transaction. An interrupted staging is retained for diagnosis;
  // its name is never authority to overwrite or remove it.
  try { await mkdir(plan.stagingRoot); } catch (error) { return fail('STAGING_CONFLICT', String(error)); }
  const stageIdentity = await inode(plan.stagingRoot);
  try {
    for (const path of plan.directories) { await parentUnchanged(); await makeParents(join(plan.stagingRoot, path)); }
    for (const file of files) {
      await parentUnchanged(); await assertRealPath(dirname(join(plan.stagingRoot, file.path)));
      await writeFile(join(plan.stagingRoot, file.path), file.bytes, { flag: 'wx' });
    }
    await exact(plan.stagingRoot, plan);
    await validated(plan.stagingRoot, sources);
    await reviewed(input); await parentUnchanged();
    if (await info(plan.vaultRoot)) fail('TARGET_CONFLICT', 'target appeared during staging');
    await (input.install ?? rename)(plan.stagingRoot, plan.vaultRoot);
    await parentUnchanged();
    if (await inode(plan.vaultRoot) !== stageIdentity) fail('PATH_UNSAFE', 'installed directory identity changed');
    await exact(plan.vaultRoot, plan);
    const validation = await validated(plan.vaultRoot, sources);
    await reviewed(input);
    return result(false, validation);
  } catch (error) {
    // Recover only our directory by identity. No recursive delete and no overwrite of
    // competing/user content. A failed transaction cannot remain at the live target.
    await parentUnchanged();
    if (!await info(plan.stagingRoot) && await info(plan.vaultRoot) && await inode(plan.vaultRoot) === stageIdentity) {
      await rename(plan.vaultRoot, plan.stagingRoot);
    }
    return fail('APPLY_FAILED', String(error));
  }
}
