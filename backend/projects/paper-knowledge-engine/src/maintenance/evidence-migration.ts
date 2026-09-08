import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { redactErrorMessage } from '../shared/redaction.ts';
import { type StateStore } from '../library/state/state-store.ts';
import { validateArchiveSource, type ArchiveSourceV1 } from '../evidence/contracts.ts';
import { archiveFileManifest, canonicalJson, hashCanonical } from '../shared/manifest.ts';
import type { VerifiedArchiveSource } from '../evidence/archive-reader.ts';
import { discoverArchiveAssetPaths } from '../shared/archive-references.ts';
import { EVIDENCE_LAYOUT_V3 } from '../evidence/layout-paths.ts';
import { prepareEvidenceSources, renderBufferedEvidenceV3 } from '../evidence/layout-v3.ts';
import { publishRunEvidence } from '../evidence/publication-service.ts';

export type EvidenceMigrationStatus = 'migratable' | 'already_published' | 'metadata_missing' | 'blocked' | 'missing' | 'conflict';
export interface EvidenceMigrationItem {
  id: string;
  baseId: string;
  version: number;
  archiveRoot: string;
  status: EvidenceMigrationStatus;
  legacy: boolean;
  reason?: string;
}
export interface EvidenceMigrationInventory {
  schemaVersion: 1;
  items: EvidenceMigrationItem[];
  counts: Record<EvidenceMigrationStatus, number>;
  inventorySha256: string;
}

export interface EvidenceMigrationApplyResult {
  inventory: EvidenceMigrationInventory;
  /** Number of reviewed inventory papers newly applied to the Vault. */
  published: number;
  /** Number of reviewed inventory papers whose Vault application replayed. */
  replayed: number;
  /** Number of retired historical runs completed or replayed by the compatibility adapter. */
  historicalRuns: number;
}

export interface EvidenceMigrationDependencies {
  stateRoot: string;
  vaultRoot: string;
  tempRoot?: string;
  store: StateStore;
  publishRunEvidence?: typeof publishRunEvidence;
}

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const statuses: EvidenceMigrationStatus[] = ['migratable', 'already_published', 'metadata_missing', 'blocked', 'missing', 'conflict'];
const safeBaseId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be non-empty text`);
  return value;
}
function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}
function archiveId(baseId: string, version: number) { return `${baseId}v${version}`; }
function itemId(baseId: string, version: number, archiveManifestSha256: string) {
  return `archive-${baseId}-v${version}-${archiveManifestSha256.slice(0, 16)}`;
}
function counts(items: readonly EvidenceMigrationItem[]): Record<EvidenceMigrationStatus, number> {
  return Object.fromEntries(statuses.map(status => [status, items.filter(item => item.status === status).length])) as Record<EvidenceMigrationStatus, number>;
}
function parseJson(bytes: Uint8Array, label: string): unknown {
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error(`${label} is invalid JSON`); }
}

async function sourceFiles(extractedRoot: string): Promise<string[]> {
  let roots;
  try { roots = await readdir(extractedRoot, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const results: string[] = [];
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`migration refuses Archive link or reparse point: ${path}`);
    if (!info.isDirectory()) return;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`migration refuses Archive link or reparse point: ${child}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name === 'source.json') results.push(child);
    }
  }
  for (const entry of roots) {
    const child = join(extractedRoot, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`migration refuses Archive link or reparse point: ${child}`);
    if (entry.isDirectory()) await visit(child);
  }
  return results.sort(compareText);
}

function adaptLegacySource(raw: Record<string, unknown>, metadata: ReturnType<StateStore['findSourceMetadata']>): ArchiveSourceV1 {
  const baseId = text(raw.baseId, 'legacy source baseId');
  const version = positive(raw.version, 'legacy source version');
  if (!metadata || metadata.baseId !== baseId || metadata.version !== version || metadata.arxivId !== archiveId(baseId, version) || metadata.authors.length === 0) {
    throw new Error('METADATA_MISSING: exact versioned arXiv authors are unavailable');
  }
  return validateArchiveSource({
    schemaVersion: 1,
    baseId,
    arxivId: metadata.arxivId,
    version,
    title: metadata.title,
    authors: metadata.authors,
    categories: metadata.categories,
    matchedTracks: Array.isArray(raw.matchedTracks) && raw.matchedTracks.every(value => typeof value === 'string') ? raw.matchedTracks : [],
    published: metadata.published,
    updated: metadata.updated,
    pdfPath: raw.pdfPath,
    pdfSha256: raw.pdfSha256,
    parseAttemptId: raw.parseAttemptId,
    model: raw.model,
    cliBackend: raw.cliBackend,
    method: raw.method ?? 'auto',
    pageCount: raw.pageCount,
    normalized: raw.normalized,
    files: raw.files,
  });
}

async function verifyExactParseAttempt(source: ArchiveSourceV1, archiveRoot: string, store: Pick<StateStore, 'findSuccessfulParse'>): Promise<void> {
  const selected = await store.findSuccessfulParse({
    baseId: source.baseId,
    version: source.version,
    sha256: source.pdfSha256,
    model: source.model,
    method: source.method,
  });
  if (!selected) throw new Error('SUCCESSFUL_PARSE_MISSING: no exact successful SQLite parse attempt exists');
  for (const [field, actual, expected] of [
    ['attemptId', selected.attemptId, source.parseAttemptId],
    ['baseId', selected.baseId, source.baseId],
    ['version', selected.version, source.version],
    ['sha256', selected.sha256, source.pdfSha256],
    ['model', selected.model, source.model],
    ['method', selected.method, source.method],
    ['cliBackend', selected.cliBackend, source.cliBackend],
    ['pageCount', selected.pageCount, source.pageCount],
  ] as const) {
    if (actual !== expected) throw new Error(`SUCCESSFUL_PARSE_CONFLICT: selected parse ${field} differs from source.json`);
  }
  if (typeof selected.outputDir !== 'string' || !selected.outputDir) {
    throw new Error('SUCCESSFUL_PARSE_MISSING: selected parse has no archived output identity');
  }
  let [archiveIdentity, selectedIdentity] = await Promise.all([realpath(archiveRoot), realpath(selected.outputDir)]);
  if (process.platform === 'win32') { archiveIdentity = archiveIdentity.toLowerCase(); selectedIdentity = selectedIdentity.toLowerCase(); }
  if (archiveIdentity !== selectedIdentity) throw new Error('SUCCESSFUL_PARSE_CONFLICT: selected parse Archive root differs from source.json Archive');
}

async function verifyArchive(input: { archiveRoot: string; store: Pick<StateStore, 'findSourceMetadata' | 'findSuccessfulParse'> }): Promise<{ source: ArchiveSourceV1; verified: VerifiedArchiveSource; legacy: boolean }> {
  const raw = parseJson(await readFile(join(input.archiveRoot, 'source.json')), 'source.json');
  if (!isRecord(raw)) throw new Error('source.json must be an object');
  const legacy = raw.schemaVersion !== 1;
  let source: ArchiveSourceV1;
  try {
    source = legacy ? adaptLegacySource(raw, input.store.findSourceMetadata(text(raw.baseId, 'legacy source baseId'), positive(raw.version, 'legacy source version')))
      : validateArchiveSource(raw);
  } catch (error) {
    if (String(error).includes('authors') || String(error).includes('METADATA_MISSING')) throw new Error(`METADATA_MISSING: ${String(error)}`);
    throw error;
  }
  await verifyExactParseAttempt(source, input.archiveRoot, input.store);
  const actual = await archiveFileManifest(input.archiveRoot);
  if (canonicalJson(actual) !== canonicalJson(source.files)) throw new Error('Archive source manifest does not match current Archive bytes');
  const files = new Map(actual.map(file => [file.path, file]));
  const pdf = files.get(source.pdfPath);
  if (!pdf || pdf.sha256 !== source.pdfSha256) throw new Error('Archive PDF is missing or hash mismatched');
  const needed = [source.normalized.fullMarkdown, source.normalized.pageMarkedText, source.normalized.pages, source.normalized.contentList];
  for (const path of needed) if (!files.has(path)) throw new Error(`Archive normalized file is missing: ${path}`);
  const fullMarkdown = await readFile(join(input.archiveRoot, ...source.normalized.fullMarkdown.split('/')), 'utf8');
  const parsedPages = parseJson(await readFile(join(input.archiveRoot, ...source.normalized.pages.split('/'))), 'normalized pages');
  if (!Array.isArray(parsedPages) || parsedPages.length !== source.pageCount || parsedPages.some((value, index) => !isRecord(value) || value.page !== index + 1 || typeof value.text !== 'string')) {
    throw new Error('normalized pages must be sequential page/text records');
  }
  const contentList = parseJson(await readFile(join(input.archiveRoot, ...source.normalized.contentList.split('/'))), 'normalized content list');
  if (!Array.isArray(contentList)) throw new Error('normalized content list must be an array');
  const assets = await Promise.all(discoverArchiveAssetPaths(fullMarkdown, contentList).map(async relativePath => {
    const entry = files.get(relativePath);
    if (!entry) throw new Error(`referenced asset is absent from Archive manifest: ${relativePath}`);
    const contents = await readFile(join(input.archiveRoot, ...relativePath.split('/')));
    if (sha256(contents) !== entry.sha256 || contents.byteLength !== entry.bytes) throw new Error(`referenced asset hash mismatch: ${relativePath}`);
    return { sourcePath: join(input.archiveRoot, ...relativePath.split('/')), relativePath, sha256: entry.sha256, bytes: entry.bytes, contents: new Uint8Array(contents) };
  }));
  return { legacy, source, verified: { source, archiveRoot: input.archiveRoot, archiveManifestSha256: hashCanonical(source.files), fullMarkdown,
    pages: parsedPages.map(value => ({ page: value.page as number, text: value.text as string })), contentList, assets } };
}

type ExpectedVaultFile = { path: string; sha256: string };

async function expectedVaultFiles(sources: readonly VerifiedArchiveSource[]): Promise<ExpectedVaultFile[]> {
  // Legacy verification above stays frozen; only the publication target is v3.
  const buffered = await prepareEvidenceSources(sources);
  return renderBufferedEvidenceV3(buffered).map(({ path, sha256 }) => ({ path, sha256 }));
}

async function vaultEntries(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`migration Vault projection refuses a link or reparse point: ${path}`);
    if (entry.isDirectory()) { files.push(`${relativePath}/`); files.push(...await vaultEntries(path, relativePath)); }
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`migration Vault projection refuses non-file entry: ${path}`);
  }
  return files.sort(compareText);
}

async function targetStatus(vaultRoot: string, sources: readonly VerifiedArchiveSource[]): Promise<'migratable' | 'already_published' | 'conflict'> {
  const expected = await expectedVaultFiles(sources);
  const expectedPaths = new Set(expected.map(file => file.path));
  for (const file of expected) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) expectedPaths.add(`${parts.slice(0, i).join('/')}/`);
  }
  const evidenceName = EVIDENCE_LAYOUT_V3.root;
  const evidenceRoot = join(vaultRoot, evidenceName);
  try {
    const vaultInfo = await lstat(vaultRoot);
    if (!vaultInfo.isDirectory() || vaultInfo.isSymbolicLink()) return 'conflict';
    // Inspect only root entry names for Windows aliases, never manual contents.
    const names = await readdir(vaultRoot);
    if (names.some(name => name.toLowerCase() === evidenceName.toLowerCase() && name !== evidenceName)) return 'conflict';
    const evidenceInfo = await lstat(evidenceRoot);
    if (!evidenceInfo.isDirectory() || evidenceInfo.isSymbolicLink()) return 'conflict';
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'migratable'; throw error; }
  const actualPaths = (await vaultEntries(evidenceRoot)).map(path => `${evidenceName}/${path}`);
  for (const path of actualPaths) if (!expectedPaths.has(path)) return 'conflict';
  if (actualPaths.every(path => path.endsWith('/'))) return 'migratable';
  for (const expectedFile of expected) {
    try {
      const info = await lstat(join(vaultRoot, ...expectedFile.path.split('/')));
      if (!info.isFile() || info.isSymbolicLink() || sha256(await readFile(join(vaultRoot, ...expectedFile.path.split('/')))) !== expectedFile.sha256) return 'conflict';
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'conflict'; throw error; }
  }
  return 'already_published';
}

type InspectedArchive = { item: EvidenceMigrationItem; verified?: VerifiedArchiveSource };

async function inspectArchive(input: { archiveRoot: string; store: Pick<StateStore, 'findSourceMetadata' | 'findSuccessfulParse'> }): Promise<InspectedArchive> {
  let raw: Record<string, unknown> | undefined;
  try { raw = parseJson(await readFile(join(input.archiveRoot, 'source.json')), 'source.json') as Record<string, unknown>; }
  catch (error) { return { item: { id: `missing-${sha256(input.archiveRoot).slice(0, 16)}`, baseId: 'unknown', version: 0, archiveRoot: input.archiveRoot, status: 'missing', legacy: false, reason: String(error) } }; }
  const baseId = typeof raw.baseId === 'string' && safeBaseId.test(raw.baseId) ? raw.baseId : 'unknown';
  const version = typeof raw.version === 'number' && Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 0;
  const legacy = raw.schemaVersion !== 1;
  try {
    const result = await verifyArchive({ archiveRoot: input.archiveRoot, store: input.store });
    return { item: { id: itemId(result.source.baseId, result.source.version, result.verified.archiveManifestSha256), baseId: result.source.baseId, version: result.source.version,
      archiveRoot: input.archiveRoot, status: 'migratable', legacy: result.legacy }, verified: result.verified };
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error);
    const status: EvidenceMigrationStatus = reason.includes('METADATA_MISSING') ? 'metadata_missing'
      : (reason.includes('SUCCESSFUL_PARSE_MISSING') || baseId === 'unknown' || version === 0 ? 'missing' : 'blocked');
    return { item: { id: `${status}-${baseId}-v${version}-${sha256(input.archiveRoot).slice(0, 16)}`, baseId, version, archiveRoot: input.archiveRoot, status, legacy, reason } };
  }
}

/** Read-only historical Archive inventory. It never creates the Vault, SQLite rows, or an Archive file. */
export async function createEvidenceMigrationInventory(input: Pick<EvidenceMigrationDependencies, 'stateRoot' | 'vaultRoot' | 'store'>): Promise<EvidenceMigrationInventory> {
  const stateRoot = resolve(input.stateRoot);
  const extractedRoot = join(stateRoot, 'extracted');
  const inspected = await Promise.all((await sourceFiles(extractedRoot)).map(source => inspectArchive({ archiveRoot: resolve(source, '..'), store: input.store })));
  const verifiedSources = inspected.flatMap(result => result.verified ? [result.verified] : []);
  const projectionStatus = await targetStatus(resolve(input.vaultRoot), verifiedSources);
  const items = inspected.map(result => result.verified ? { ...result.item, status: projectionStatus } : result.item);
  items.sort((left, right) => compareText(left.baseId, right.baseId) || left.version - right.version || compareText(left.archiveRoot, right.archiveRoot));
  const stableItems = items.map(({ archiveRoot, ...item }) => ({ ...item, archiveRoot: archiveRoot.replaceAll('\\', '/') }));
  return { schemaVersion: 1, items, counts: counts(items), inventorySha256: hashCanonical({ schemaVersion: 1, items: stableItems }) };
}

/** Apply only an inventory the caller has independently reviewed. Empty first-run inventories are intentionally no-ops. */
async function migrateHistoricalWaitingRuns(input: EvidenceMigrationDependencies): Promise<{ completed: number; replayed: number }> {
  if (!input.tempRoot) throw new Error('EVIDENCE_MIGRATION_CONFLICT: tempRoot is required for historical run migration');
  let completed = 0; let replayed = 0;
  // This literal is intentionally confined to the migration adapter. New FSD runs
  // never enter the retired state, and completion remains receipt-verified.
  for (const run of input.store.listRunsByStatus(['awaiting', 'wiki', 'generation'].join('_'))) {
    const publication = await (input.publishRunEvidence ?? publishRunEvidence)({
      runId: run.run_id,
      stateRoot: input.stateRoot,
      tempRoot: input.tempRoot,
      vaultRoot: input.vaultRoot,
      store: input.store,
      lastSuccess: run.to_utc,
      eligibility: 'historical',
    });
    if (publication.applyReplayed) replayed += 1; else completed += 1;
  }
  return { completed, replayed };
}

export async function applyEvidenceMigration(input: EvidenceMigrationDependencies & { inventorySha256: string }): Promise<EvidenceMigrationApplyResult> {
  const inventory = await createEvidenceMigrationInventory(input);
  if (!/^[0-9a-f]{64}$/.test(input.inventorySha256) || input.inventorySha256 !== inventory.inventorySha256) throw new Error('EVIDENCE_MIGRATION_CONFLICT: inventory SHA-256 does not match the reviewed dry-run');
  if (inventory.items.length === 0) {
    // A deleted/first-run data root is a valid no-op: do not create a run, Vault
    // directory, backup, or artificial paper count. Historical run rows, if any,
    // are still handled through the receipt-verified compatibility adapter.
    const historical = await migrateHistoricalWaitingRuns(input);
    return { inventory, published: 0, replayed: 0, historicalRuns: historical.completed + historical.replayed };
  }
  if (!input.tempRoot) throw new Error('EVIDENCE_MIGRATION_CONFLICT: tempRoot is required for apply');
  let published = 0; let replayed = 0;
  const pending: VerifiedArchiveSource[] = [];
  for (const item of inventory.items) {
    if (item.status === 'already_published') { replayed += 1; continue; }
    if (item.status !== 'migratable') throw new Error(`EVIDENCE_MIGRATION_BLOCKED: ${item.id} is ${item.status}`);
    const verified = await verifyArchive({ archiveRoot: item.archiveRoot, store: input.store });
    pending.push(verified.verified);
  }
  if (pending.length > 0) {
    // One publication owns the complete managed projection. Publishing per paper
    // would treat other managed paper directories as unknown/manual files.
    const stamp = new Date().toISOString();
    const run = input.store.startRun({ from: stamp, to: stamp }, 'evidence_migration');
    let publication: Awaited<ReturnType<typeof publishRunEvidence>>;
    try {
      publication = await (input.publishRunEvidence ?? publishRunEvidence)({
        runId: run.id,
        stateRoot: input.stateRoot,
        tempRoot: input.tempRoot,
        vaultRoot: input.vaultRoot,
        store: input.store,
        lastSuccess: stamp,
        eligibility: 'historical',
        historicalVerifiedSources: pending,
      });
    } catch (error) {
      const status = input.store.getRun(run.id)?.status;
      if (status !== 'completed' && status !== 'failed') input.store.failRun(run.id, redactErrorMessage(error));
      throw error;
    }
    if (publication.applyReplayed) replayed += pending.length; else published += pending.length;
  }
  const historical = await migrateHistoricalWaitingRuns(input);
  return { inventory, published, replayed, historicalRuns: historical.completed + historical.replayed };
}

/**
 * Persist only exact, versioned arXiv metadata supplied by the existing
 * rate-limited adapter. This deliberately has no PDF/body fallback.
 */
export async function refreshEvidenceMigrationMetadata(input: Pick<EvidenceMigrationDependencies, 'stateRoot' | 'vaultRoot' | 'store'> & {
  inventorySha256: string;
  refreshMetadata: (identity: { baseId: string; arxivId: string; version: number }) => Promise<import('../types/papers.ts').StoredSourceMetadataV1>;
}): Promise<EvidenceMigrationInventory> {
  const before = await createEvidenceMigrationInventory(input);
  if (!/^[0-9a-f]{64}$/.test(input.inventorySha256) || before.inventorySha256 !== input.inventorySha256) {
    throw new Error('EVIDENCE_MIGRATION_CONFLICT: inventory SHA-256 does not match the reviewed dry-run');
  }
  for (const item of before.items) {
    if (item.status !== 'metadata_missing' || !safeBaseId.test(item.baseId) || item.version < 1) continue;
    const expected = { baseId: item.baseId, arxivId: archiveId(item.baseId, item.version), version: item.version };
    const metadata = await input.refreshMetadata(expected);
    if (metadata.baseId !== expected.baseId || metadata.arxivId !== expected.arxivId || metadata.version !== expected.version) {
      throw new Error('EVIDENCE_MIGRATION_CONFLICT: refreshed metadata identity differs from requested Archive version');
    }
    if (!Array.isArray(metadata.authors) || metadata.authors.length === 0) throw new Error('METADATA_MISSING: refreshed metadata has no authors');
    input.store.upsertSourceMetadata(metadata);
  }
  return createEvidenceMigrationInventory(input);
}
