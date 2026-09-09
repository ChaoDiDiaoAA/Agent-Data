import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { StateStore } from '../library/state/state-store.ts';
import { canonicalJson, hashCanonical } from '../shared/manifest.ts';
import { archivePath, assertRealPath, realTree, verifyArchiveV2 } from '../shared/archive-v2.ts';
import { readVerifiedRunSources } from '../evidence/archive-reader.ts';
import { prepareEvidenceSources } from '../evidence/layout-v3.ts';
import { planEvidencePublication, verifyEvidencePublication } from '../evidence/publisher.ts';
import { verifyCompletedReceipt } from '../evidence/publication-service.ts';
import { publicationIdentity, type ArchiveV2PublicationBaseline, type RendererUpgradePublicationBaseline } from '../evidence/publication-baseline.ts';
import type { LibraryId } from '../shared/identity.ts';
import type { ArchiveMigrationPlan } from './archive-migration.ts';
import type { LibraryStatePlan } from './library-state-migration.ts';
import type { VaultRebuildPlan } from './vault-rebuild.ts';

type ReviewedPlan = { path: string; sha256: string };
export interface PublicationBaselineInput {
  stateRoot: string;
  vaultRoot: string;
  store: StateStore;
  archivePlan: ReviewedPlan;
  libraryPlan: ReviewedPlan;
  vaultPlan: ReviewedPlan;
}
export interface RendererUpgradeBaselineInput {
  libraryId: LibraryId;
  stateRoot: string;
  vaultRoot: string;
  store: StateStore;
  vaultPlan: ReviewedPlan;
}
const hash = (x: Uint8Array) => createHash('sha256').update(x).digest('hex');
const fail = (detail: string): never => { throw new Error(`EVIDENCE_BASELINE_CONFLICT: ${detail}`); };
const key = (s: { baseId: string; version: number }) => `${s.baseId}\0${s.version}`;
async function regular(path: string) {
  await assertRealPath(path);
  if (!(await lstat(path)).isFile()) fail('expected regular file');
  return readFile(path);
}
async function reviewed<T extends { sha256: string; schemaVersion: number }>(input: ReviewedPlan): Promise<T> {
  const bytes = await regular(input.path);
  const plan = JSON.parse(bytes.toString()) as T;
  const { sha256, ...body } = plan;
  if (!/^[0-9a-f]{64}$/.test(input.sha256) || sha256 !== input.sha256 || hashCanonical(body) !== sha256
    || plan.schemaVersion !== 1 || canonicalJson(plan) !== bytes.toString()) fail('reviewed migration plan hash differs');
  return plan;
}

/** Read-only dry-run. Reviewed plans are explicit authority, independently hash-pinned
 * by the operator. Their old paths are never opened; all active paths are derived. */
export async function createPublicationBaseline(input: PublicationBaselineInput): Promise<ArchiveV2PublicationBaseline> {
  const [archive, library, vault] = await Promise.all([
    reviewed<ArchiveMigrationPlan>(input.archivePlan), reviewed<LibraryStatePlan>(input.libraryPlan), reviewed<VaultRebuildPlan>(input.vaultPlan),
  ]);
  const root = resolve(input.stateRoot), archiveRoot = join(root, 'archive');
  const migration = input.store.getLibraryLayoutMigration();
  if (!migration || migration.library_id !== library.libraryId || library.libraryId !== archive.libraryId || library.libraryId !== vault.libraryId
    || migration.source_sha256 !== library.database.sourceSha256
    || migration.history_sha256 !== hashCanonical({ files: library.files, directories: library.directories })
    || migration.rewritten_cells !== library.database.changes.length || library.archivePlanSha256 !== archive.sha256
    || resolve(library.paths.dataRoot) !== root || resolve(library.paths.databasePath) !== join(root, 'library.sqlite')
    || resolve(archive.paths.dataRoot) !== root || resolve(archive.paths.archiveRoot) !== archiveRoot
    || resolve(vault.archiveRoot) !== archiveRoot || resolve(vault.runtimeRoots.dataRoot) !== root || resolve(vault.vaultRoot) !== resolve(input.vaultRoot)) {
    fail('migrated provenance or roots differ from reviewed plans');
  }
  const papers = new Map(archive.papers.map(p => [key(p), p]));
  if (!papers.size || papers.size !== archive.papers.length || vault.paperCount !== papers.size) fail('migration paper membership differs');
  for (const paper of papers.values()) {
    archivePath(`${paper.baseId}-v${paper.version}`);
    const target = join(archiveRoot, `${paper.baseId}-v${paper.version}`);
    if (resolve(paper.targetRoot) !== target) fail('migration Archive target differs');
    const verified = await verifyArchiveV2(target);
    if (verified.manifest.libraryId !== library.libraryId || key(verified.manifest) !== key(paper)) fail('Archive identity differs');
    for (const file of paper.targetFiles) {
      const path = archivePath(file.path), bytes = await regular(join(target, path));
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail('Archive differs from reviewed migration');
      const vaultFile = vault.archive.files.find(f => f.path === `${paper.baseId}-v${paper.version}/${path}`);
      if (!vaultFile || vaultFile.sha256 !== file.sha256 || vaultFile.bytes !== file.bytes) fail('Vault rebuild Archive binding differs');
    }
  }
  const completed = input.store.listCompletedEvidencePublications();
  const publications: ArchiveV2PublicationBaseline['publications'] = [];
  const sources = new Map<string, Awaited<ReturnType<typeof prepareEvidenceSources>>[number]>();
  for (const publication of completed) {
    const receipt = await verifyCompletedReceipt(publication, root);
    if (receipt.publisherVersion === 3) fail('baseline must be installed before any V3 publication');
    const file = library.files.find(f => resolve(f.targetPath) === resolve(publication.receiptPath));
    if (!file || file.sha256 !== publication.receiptSha256 || file.sourceSha256 !== file.sha256) fail('legacy receipt is not bound to library migration');
    for (const row of publication.sources) {
      const paper = papers.get(key(row));
      // Archive v1 identity hashes the file inventory, excluding source.json.
      const oldManifest = paper?.inputs.filter(f => f.path !== 'source.json').map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
      if (!oldManifest || hashCanonical(oldManifest) !== row.archiveManifestSha256) fail('legacy receipt Archive binding differs');
    }
    const runManifest = library.files.find(f => resolve(f.targetPath) === join(root, 'runs', publication.runId, 'mineru-jobs.json'));
    if (!runManifest || hash(await regular(join(root, 'runs', publication.runId, 'mineru-jobs.json'))) !== runManifest.sha256) fail('migrated run inputs differ');
    for (const source of await prepareEvidenceSources(await readVerifiedRunSources({
      runId: publication.runId,
      stateRoot: root,
      store: input.store,
      sourceMetadata: 'archive',
    }))) {
      if (!publication.sources.some(row => key(row) === key(source.source))) fail('run Archive absent from legacy receipt');
      const expected = papers.get(key(source.source))?.targetFiles.find(f => f.path === 'manifest.json')?.sha256;
      if (source.source.schemaVersion !== 2 || expected !== source.archiveManifestSha256) fail('migrated run Archive binding differs');
      const existing = sources.get(key(source.source));
      if (existing && canonicalJson(existing.source) !== canonicalJson(source.source)) fail('conflicting run Archive identity');
      sources.set(key(source.source), source);
    }
    publications.push({ original: publicationIdentity(publication), projection: null! });
  }
  if (!publications.length || sources.size !== papers.size) fail('legacy history does not cover migration Archives');
  for (const entry of publications) {
    const current = entry.original.sources.map(row => sources.get(key(row)) ?? fail('legacy source has no verified migrated run'));
    entry.projection = planEvidencePublication({ runId: entry.original.runId, sources: current });
  }
  const projection = planEvidencePublication({ runId: `vault-rebuild-${library.libraryId}`, sources: [...sources.values()] });
  if (projection.publicationId !== vault.publicationId) fail('rebuilt Vault projection differs from reviewed plan');
  await verifyEvidencePublication({ plan: projection, vaultRoot: input.vaultRoot });
  const body = { schemaVersion: 1 as const, kind: 'archive-v2-publication-baseline' as const, libraryId: library.libraryId,
    migration: migration!, plans: { archive: archive.sha256, library: library.sha256, vault: vault.sha256 }, publications };
  return { ...body, sha256: hashCanonical(body) };
}

/** Explicit offline apply: regenerate from current inputs, compare the complete
 * approved baseline, then insert once. Never changes receipts or publications. */
export async function applyPublicationBaseline(input: PublicationBaselineInput & { baseline: ArchiveV2PublicationBaseline; baselineSha256: string }) {
  const history = JSON.stringify(input.store.listCompletedEvidencePublications());
  const current = await createPublicationBaseline(input);
  if (current.sha256 !== input.baselineSha256 || canonicalJson(current) !== canonicalJson(input.baseline)) fail('reviewed baseline or inputs drifted');
  return input.store.installPublicationBaseline({ sha256: current.sha256, canonicalJson: canonicalJson(current), completedHistoryJson: history });
}

async function verifyArchiveSnapshot(root: string, expected: VaultRebuildPlan['archive']): Promise<void> {
  const paths = await realTree(root);
  const directories = paths.filter(path => path.endsWith('/'));
  const files = [];
  for (const path of paths.filter(path => !path.endsWith('/'))) {
    const bytes = await regular(join(root, archivePath(path)));
    files.push({ path, sha256: hash(bytes), bytes: bytes.length });
  }
  if (canonicalJson({ directories, files }) !== canonicalJson(expected)) fail('Archive snapshot differs from reviewed Vault rebuild');
}

/** Read-only dry-run for an already-Archive-v2 library whose immutable V3
 * receipts predate the current deterministic renderer. */
export async function createRendererUpgradeBaseline(
  input: RendererUpgradeBaselineInput,
): Promise<RendererUpgradePublicationBaseline> {
  const vault = await reviewed<VaultRebuildPlan>(input.vaultPlan);
  const root = resolve(input.stateRoot);
  const archiveRoot = join(root, 'archive');
  if (vault.libraryId !== input.libraryId
    || resolve(vault.archiveRoot) !== archiveRoot
    || resolve(vault.runtimeRoots.dataRoot) !== root
    || resolve(vault.vaultRoot) !== resolve(input.vaultRoot)) {
    fail('renderer baseline roots or library differ from reviewed Vault rebuild');
  }
  await verifyArchiveSnapshot(archiveRoot, vault.archive);
  const packagePaths = vault.archive.directories.filter(path => /^[^/]+\/$/.test(path));
  if (!packagePaths.length || packagePaths.length !== vault.paperCount) fail('renderer baseline Archive membership differs');
  const archives = await Promise.all(packagePaths.map(async path => {
    const archive = await verifyArchiveV2(join(archiveRoot, path));
    if (archive.manifest.libraryId !== input.libraryId
      || path !== `${archive.manifest.baseId}-v${archive.manifest.version}/`) fail('renderer baseline Archive identity differs');
    return archive;
  }));
  const allSources = await prepareEvidenceSources(archives);
  const allByKey = new Map(allSources.map(source => [key(source.source), source]));
  if (allByKey.size !== allSources.length) fail('renderer baseline has duplicate Archive identities');
  const rebuilt = planEvidencePublication({ runId: `vault-rebuild-${input.libraryId}`, sources: allSources });
  if (rebuilt.publicationId !== vault.publicationId) fail('renderer baseline Vault projection differs from reviewed rebuild');
  await verifyEvidencePublication({ plan: rebuilt, vaultRoot: input.vaultRoot });

  const completed = input.store.listCompletedEvidencePublications();
  if (!completed.length) fail('renderer baseline requires completed V3 publications');
  const historical = new Map<string, (typeof allSources)[number]>();
  const publications: RendererUpgradePublicationBaseline['publications'] = [];
  for (const publication of completed) {
    const receipt = await verifyCompletedReceipt(publication, root);
    if (receipt.publisherVersion !== 3) fail('renderer baseline accepts only completed V3 publications');
    const runSources = await prepareEvidenceSources(await readVerifiedRunSources({
      runId: publication.runId,
      stateRoot: root,
      libraryId: input.libraryId,
      store: input.store,
      sourceMetadata: 'archive',
    }));
    const originalKeys = new Set(publication.sources.map(source => key(source)));
    const rows = new Map(publication.sources.map(source => [key(source), source]));
    if (rows.size !== publication.sources.length) fail('renderer baseline completed source membership differs');
    for (const row of publication.sources) {
      const existing = historical.get(key(row));
      if (existing && existing.archiveManifestSha256 !== row.archiveManifestSha256) {
        fail('renderer baseline completed Archive identity differs');
      }
    }
    const runByKey = new Map<string, (typeof runSources)[number]>();
    for (const source of runSources) {
      const identity = key(source.source);
      const archive = allByKey.get(identity);
      if (!archive || archive.archiveManifestSha256 !== source.archiveManifestSha256
        || canonicalJson(archive.source) !== canonicalJson(source.source)) fail('renderer baseline run Archive identity differs');
      if (!originalKeys.has(identity)) fail('renderer baseline run Archive is absent from its completed publication');
      if (runByKey.has(identity)) fail('renderer baseline run Archive source membership differs');
      runByKey.set(identity, source);
    }
    // Publication rows are cumulative: a no-op run may repeat an earlier source,
    // but every source first appearing in this row must come from this run.
    const newRows = publication.sources.filter(row => !historical.has(key(row)));
    if (newRows.some(row => !runByKey.has(key(row)))) {
      fail('renderer baseline run Archive source membership differs');
    }
    for (const source of runSources) {
      const identity = key(source.source);
      const existing = historical.get(identity);
      if (existing && (existing.archiveManifestSha256 !== source.archiveManifestSha256
        || canonicalJson(existing.source) !== canonicalJson(source.source))) fail('renderer baseline has conflicting run Archive identities');
      historical.set(identity, source);
    }
    if (historical.size !== publication.sources.length || publication.sources.some(row => {
      const source = historical.get(key(row));
      return !source || source.archiveManifestSha256 !== row.archiveManifestSha256;
    })) fail('renderer baseline completed source membership differs');
    const sources = publication.sources.map(row => historical.get(key(row))!);
    const projection = planEvidencePublication({ runId: publication.runId, sources });
    if (projection.sources.length !== publication.sources.length) fail('renderer baseline completed source membership differs');
    publications.push({ original: publicationIdentity(publication), projection });
  }
  const represented = new Set(publications.flatMap(publication => publication.original.sources.map(source => key(source))));
  if ([...historical.keys()].some(identity => !represented.has(identity))) fail('renderer baseline has an unrepresented completed Archive');
  const body = {
    schemaVersion: 1 as const,
    kind: 'evidence-v3-renderer-upgrade-baseline' as const,
    libraryId: input.libraryId,
    vaultPlanSha256: vault.sha256,
    publications,
  };
  return { ...body, sha256: hashCanonical(body) };
}

/** Explicit offline apply: re-authenticate the reviewed rebuild, immutable
 * completed history, current Archives, and every current renderer projection. */
export async function applyRendererUpgradeBaseline(input: RendererUpgradeBaselineInput & {
  baseline: RendererUpgradePublicationBaseline;
  baselineSha256: string;
}) {
  const history = JSON.stringify(input.store.listCompletedEvidencePublications());
  const current = await createRendererUpgradeBaseline(input);
  if (current.sha256 !== input.baselineSha256 || canonicalJson(current) !== canonicalJson(input.baseline)) {
    fail('reviewed renderer baseline or inputs drifted');
  }
  return input.store.installPublicationBaseline({
    sha256: current.sha256,
    canonicalJson: canonicalJson(current),
    completedHistoryJson: history,
    libraryId: input.libraryId,
  });
}
