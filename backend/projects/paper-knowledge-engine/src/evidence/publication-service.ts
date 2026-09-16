import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { StateStore } from '../library/state/state-store.ts';
import { readVerifiedRunSources, type VerifiedArchiveSource as HistoricalArchiveSource } from './archive-reader.ts';
import { prepareEvidenceSources } from './layout-v3.ts';
import { type BufferedEvidenceSource as VerifiedArchiveSource } from './layout-paths.ts';
import { canonicalJson, hashCanonical } from '../shared/manifest.ts';
import { applyEvidencePublication, EvidencePublicationError, planEvidencePublication, verifyEvidencePublication, type EvidencePublicationPlanV3,  } from './publisher.ts';
import { EvidenceReceiptError, readPublicationReceipt, receiptPathForRun, type EvidencePublicationReceipt,  } from './receipt-store.ts';
import { readPublicationBaseline } from './publication-baseline.ts';
import { asLibraryId, type LibraryId } from '../shared/identity.ts';

export type EvidencePublicationEligibility = 'normal' | 'failed-recovery' | 'historical';

async function readPublicationRunSources(
  input: Parameters<typeof readVerifiedRunSources>[0],
  sourceMetadata: 'state' | 'archive' = 'state',
): Promise<VerifiedArchiveSource[]> {
  return prepareEvidenceSources(await readVerifiedRunSources({ ...input, sourceMetadata }));
}

export interface EvidencePublicationResult {
  readonly status: 'completed';
  readonly publicationId: string;
  readonly contentSha256: string;
  readonly receiptPath: string;
  readonly receiptSha256: string;
  readonly sourceCount: number;
  readonly reservationReplayed: boolean;
  readonly applyReplayed: boolean;
}

export interface EvidencePublicationProgress {
  readonly stage: 'verified' | 'reserved' | 'applied' | 'completed';
  readonly runId: string;
  readonly publicationId?: string;
}

type CompletedPublication = ReturnType<StateStore['listCompletedEvidencePublications']>[number];
type SourceIdentity = {
  source: VerifiedArchiveSource;
  normalizedSha256: string;
};
type VerifiedCompletedPublication = {
  publication: CompletedPublication;
  sources: readonly VerifiedArchiveSource[];
};
type VerifiedHistory = {
  identities: ReadonlyMap<string, SourceIdentity>;
  publications: readonly VerifiedCompletedPublication[];
  baselineRunIds: ReadonlySet<string>;
  libraryId?: LibraryId;
};
type PlannedPublication = {
  plan: EvidencePublicationPlanV3;
  prefixLength: number;
  history: readonly VerifiedCompletedPublication[];
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const sourceKey = (source: { baseId: string; version: number }) => `${source.baseId}\u0000${source.version}`;

function conflict(message: string): never {
  throw new EvidencePublicationError('EVIDENCE_CONFLICT', message);
}

function receiptConflict(message: string): never {
  throw new EvidenceReceiptError(message);
}

function registerVerifiedSource(
  identities: Map<string, SourceIdentity>,
  source: VerifiedArchiveSource,
): void {
  const key = sourceKey(source.source);
  const normalizedSha256 = hashCanonical(source.source);
  const existing = identities.get(key);
  if (existing && (existing.source.archiveManifestSha256 !== source.archiveManifestSha256
    || existing.normalizedSha256 !== normalizedSha256)) {
    conflict(`Archive identity differs for ${source.source.baseId}v${source.source.version}`);
  }
  if (!existing) identities.set(key, { source, normalizedSha256 });
}

async function verifiedHistoricalReceiptPath(input: {
  publication: CompletedPublication;
  stateRoot: string;
}): Promise<string> {
  const stateRoot = resolve(input.stateRoot);
  const expected = resolve(receiptPathForRun(stateRoot, input.publication.runId));
  if (resolve(input.publication.receiptPath) !== expected) {
    receiptConflict(`completed publication receipt path differs: ${input.publication.runId}`);
  }
  const descendant = relative(stateRoot, expected);
  if (!descendant || descendant === '..' || descendant.startsWith(`..${sep}`) || isAbsolute(descendant)) {
    receiptConflict(`completed publication receipt path escapes stateRoot: ${input.publication.runId}`);
  }

  let current = stateRoot;
  const parts = descendant.split(sep);
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = resolve(current, parts[index]!);
    let info;
    try { info = await lstat(current); }
    catch { receiptConflict(`completed publication receipt path cannot be inspected: ${input.publication.runId}`); }
    if (info!.isSymbolicLink()) {
      receiptConflict(`completed publication receipt path traverses a symlink: ${input.publication.runId}`);
    }
    const isReceipt = index === parts.length - 1;
    if (isReceipt ? !info!.isFile() : !info!.isDirectory()) {
      receiptConflict(`completed publication receipt path is not a regular file: ${input.publication.runId}`);
    }
  }
  return expected;
}

export async function verifyCompletedReceipt(
  publication: CompletedPublication,
  stateRoot: string,
): Promise<EvidencePublicationReceipt> {
  const receiptPath = await verifiedHistoricalReceiptPath({ publication, stateRoot });
  let bytes: Uint8Array;
  try { bytes = await readFile(receiptPath); }
  catch { receiptConflict(`completed publication receipt cannot be read: ${publication.runId}`); }
  if (sha256(bytes!) !== publication.receiptSha256) {
    receiptConflict(`completed publication receipt hash differs: ${publication.runId}`);
  }
  const receipt = await readPublicationReceipt(receiptPath);
  if (!receipt || Buffer.from(bytes!).toString('utf8') !== canonicalJson(receipt)) {
    receiptConflict(`completed publication receipt is not canonical: ${publication.runId}`);
  }
  if (receipt.runId !== publication.runId || receipt.publicationId !== publication.publicationId
    || receipt.contentSha256 !== publication.inputSha256
    || (receipt.publisherVersion !== 1 && receipt.publisherVersion !== 2 && receipt.publisherVersion !== 3)) {
    receiptConflict(`completed publication receipt identity differs: ${publication.runId}`);
  }
  if (canonicalJson(receipt.sources) !== canonicalJson(publication.sources)) {
    receiptConflict(`completed publication receipt sources differ: ${publication.runId}`);
  }
  return receipt;
}

async function verifyCompletedHistory(input: {
  completed: readonly CompletedPublication[];
  stateRoot: string;
  store: StateStore;
  libraryId?: LibraryId;
  sourceOverrides?: ReadonlyMap<string, readonly VerifiedArchiveSource[]>;
}): Promise<VerifiedHistory> {
  const historicalIdentities = new Map<string, SourceIdentity>();
  const authenticatedReceipts = new Map<string, EvidencePublicationReceipt>();
  const publications: VerifiedCompletedPublication[] = [];
  const baseline = readPublicationBaseline(input.store);
  const libraryId = baseline ? asLibraryId(baseline.libraryId) : input.libraryId;
  const attestations = new Map(baseline?.publications.map(p => [p.original.runId, p]) ?? []);
  // Effective rows describe the reviewed V3 projection of migrated Archives.
  // Original SQLite identities and receipt bytes remain authenticated below.
  const effective = input.completed.map(publication => {
    const attested = attestations.get(publication.runId);
    return attested ? { ...publication, sources: [...attested.projection.sources] } : publication;
  });

  for (const publication of effective) {
    const original = input.completed.find(p => p.runId === publication.runId)!;
    authenticatedReceipts.set(
      publication.runId,
      await verifyCompletedReceipt(original, input.stateRoot),
    );
    const rows = new Map(publication.sources.map(source => [sourceKey(source), source]));
    if (rows.size !== publication.sources.length) {
      conflict(`completed publication source membership differs: ${publication.runId}`);
    }
    for (const row of publication.sources) {
      const key = sourceKey(row);
      const existing = historicalIdentities.get(key);
      if (existing && existing.source.archiveManifestSha256 !== row.archiveManifestSha256) {
        conflict(`completed publication Archive identity differs for ${row.baseId}v${row.version}`);
      }
    }

    const verified = input.sourceOverrides?.get(publication.runId) ?? await readPublicationRunSources({
      runId: publication.runId,
      stateRoot: input.stateRoot,
      store: input.store,
      libraryId,
    }, 'archive');
    const verifiedByKey = new Map<string, VerifiedArchiveSource>();
    for (const source of verified) {
      const row = rows.get(sourceKey(source.source));
      if (!row || row.archiveManifestSha256 !== source.archiveManifestSha256) {
        conflict(`completed run Archive is not represented by its publication: ${source.source.baseId}v${source.source.version}`);
      }
      const key = sourceKey(source.source);
      if (verifiedByKey.has(key)) conflict(`completed run Archive source membership differs: ${publication.runId}`);
      verifiedByKey.set(key, source);
    }
    // Publication rows are cumulative: a no-op run may repeat an earlier source,
    // but every source first appearing in this row must come from this run.
    const newRows = publication.sources.filter(row => !historicalIdentities.has(sourceKey(row)));
    if (newRows.some(row => !verifiedByKey.has(sourceKey(row)))) {
      conflict(`completed run Archive source membership differs: ${publication.runId}`);
    }
    for (const source of verified) {
      registerVerifiedSource(historicalIdentities, source);
    }
    if (historicalIdentities.size !== publication.sources.length || publication.sources.some(row => {
      const verifiedSource = historicalIdentities.get(sourceKey(row));
      return !verifiedSource || verifiedSource.source.archiveManifestSha256 !== row.archiveManifestSha256;
    })) {
      conflict(`completed publication source membership differs: ${publication.runId}`);
    }
    publications.push({
      publication,
      sources: publication.sources.map(row => historicalIdentities.get(sourceKey(row))!.source),
    });
  }
  for (const verified of publications) {
    const regenerated = planEvidencePublication({
      runId: verified.publication.runId,
      sources: verified.sources,
    });
    if (canonicalJson(regenerated.sources) !== canonicalJson(verified.publication.sources)) {
      receiptConflict(
        `completed publication Evidence manifest identity differs: ${verified.publication.runId}; `
        + 'current renderer differs from immutable history; run evidence-renderer-baseline after a reviewed vault-rebuild',
      );
    }
    const receipt = authenticatedReceipts.get(verified.publication.runId)!;
    const attested = attestations.get(verified.publication.runId);
    if (attested) {
      const wrongBaselineKind = baseline!.kind === 'archive-v2-publication-baseline'
        ? receipt.publisherVersion === 3
        : receipt.publisherVersion !== 3;
      if (wrongBaselineKind || canonicalJson(regenerated) !== canonicalJson(attested.projection)) {
        receiptConflict(`completed publication baseline projection differs: ${verified.publication.runId}`);
      }
      continue;
    }
    if (regenerated.contentSha256 !== receipt.contentSha256
      || regenerated.contentSha256 !== verified.publication.inputSha256) {
      receiptConflict(`completed publication target content identity differs: ${verified.publication.runId}`);
    }
    const expectedPublicationId = receipt.publisherVersion === 1
      ? `evidence-${regenerated.contentSha256.slice(0, 32)}`
      : regenerated.publicationId;
    if (expectedPublicationId !== receipt.publicationId
      || expectedPublicationId !== verified.publication.publicationId) {
      receiptConflict(`completed publication derived identity differs: ${verified.publication.runId}`);
    }
  }
  return {
    identities: historicalIdentities,
    publications,
    baselineRunIds: new Set(attestations.keys()),
    libraryId,
  };
}

/** Read-only publication-history preflight used before a configured paper task
 * starts discovery. It intentionally performs the same immutable receipt,
 * Archive, and renderer checks as publication, so a renderer upgrade cannot
 * waste a long-running download/parse batch before reporting remediation. */
export async function verifyEvidencePublicationHistory(input: {
  stateRoot: string;
  store: StateStore;
  libraryId?: LibraryId;
}): Promise<void> {
  const completed = input.store.listCompletedEvidencePublications();
  if (!completed.length) return;
  await verifyCompletedHistory({
    completed,
    stateRoot: input.stateRoot,
    store: input.store,
    libraryId: input.libraryId,
  });
}

function sortedSources(identities: ReadonlyMap<string, SourceIdentity>): VerifiedArchiveSource[] {
  return [...identities.values()]
    .map(identity => identity.source)
    .sort((left, right) => compareText(left.source.baseId, right.source.baseId) || left.source.version - right.source.version);
}

function addSources(identities: Map<string, SourceIdentity>, sources: readonly VerifiedArchiveSource[]): void {
  for (const source of sources) registerVerifiedSource(identities, source);
}

function buildPlan(input: {
  runId: string;
  current: readonly VerifiedArchiveSource[];
  historical: ReadonlyMap<string, SourceIdentity>;
  predecessorRunId?: string;
}): EvidencePublicationPlanV3 {
  const historical = sortedSources(input.historical);
  const cumulative = new Map(input.historical);
  addSources(cumulative, input.current);
  const predecessor = historical.length === 0 ? undefined : planEvidencePublication({
    runId: input.predecessorRunId ?? input.runId,
    sources: historical,
  });
  return planEvidencePublication({ runId: input.runId, sources: sortedSources(cumulative), predecessor });
}

function selectPlan(input: {
  runId: string;
  current: readonly VerifiedArchiveSource[];
  history: VerifiedHistory;
  existing: ReturnType<StateStore['findEvidencePublication']>;
}): PlannedPublication {
  const history = input.history.publications.filter(item => item.publication.runId !== input.runId);
  if (!input.existing) {
    const historical = new Map<string, SourceIdentity>();
    for (const publication of history) addSources(historical, publication.sources);
    return {
      plan: buildPlan({
        runId: input.runId,
        current: input.current,
        historical,
        predecessorRunId: history.at(-1)?.publication.runId,
      }),
      prefixLength: history.length,
      history,
    };
  }

  const matches = new Map<string, PlannedPublication>();
  const historical = new Map<string, SourceIdentity>();
  for (let prefixLength = 0; prefixLength <= history.length; prefixLength++) {
    const plan = buildPlan({
      runId: input.runId,
      current: input.current,
      historical,
      predecessorRunId: prefixLength === 0 ? undefined : history[prefixLength - 1]!.publication.runId,
    });
    if (plan.publicationId === input.existing.publication_id && plan.contentSha256 === input.existing.input_sha256) {
      matches.set(`${plan.publicationId}\u0000${plan.contentSha256}`, { plan, prefixLength, history });
    }
    if (prefixLength < history.length) addSources(historical, history[prefixLength]!.sources);
  }
  if (matches.size !== 1) {
    conflict(`persisted publication identity matched ${matches.size} historical prefixes`);
  }
  return matches.values().next().value!;
}

function hasSupersedingHistory(selection: PlannedPublication): boolean {
  if (selection.prefixLength >= selection.history.length) return false;
  const latest = selection.history.at(-1)!;
  const exactRows = new Set(latest.publication.sources.map(source => canonicalJson(source)));
  return selection.plan.sources.every(source => exactRows.has(canonicalJson(source)));
}

async function verifyLatestSupersedingProjection(
  selection: PlannedPublication,
  vaultRoot: string,
): Promise<boolean> {
  if (!hasSupersedingHistory(selection)) return false;
  const latest = selection.history.at(-1)!;
  const latestPlan = planEvidencePublication({
    runId: latest.publication.runId,
    sources: latest.sources,
  });
  await verifyEvidencePublication({ plan: latestPlan, vaultRoot });
  return true;
}

async function readExactPlanReceipt(
  path: string,
  plan: EvidencePublicationPlanV3,
): Promise<{ bytes: Uint8Array; receiptSha256: string } | null> {
  let bytes: Uint8Array;
  try { bytes = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    receiptConflict('publication receipt cannot be read');
  }
  const receipt = await readPublicationReceipt(path);
  if (!receipt || receipt.publisherVersion !== 3 || receipt.runId !== plan.runId
    || receipt.publicationId !== plan.publicationId || receipt.contentSha256 !== plan.contentSha256
    || canonicalJson(receipt.sources) !== canonicalJson(plan.sources)
    || Buffer.from(bytes!).toString('utf8') !== canonicalJson(receipt)) {
    receiptConflict('publication receipt does not match the selected plan');
  }
  return { bytes: bytes!, receiptSha256: sha256(bytes!) };
}

function reserve(
  store: StateStore,
  eligibility: EvidencePublicationEligibility,
  plan: EvidencePublicationPlanV3,
): 'reserved' | 'replayed' {
  const identity = { runId: plan.runId, publicationId: plan.publicationId, inputSha256: plan.contentSha256 };
  if (eligibility === 'historical') return store.reserveHistoricalEvidencePublication(identity);
  if (eligibility === 'failed-recovery') return store.reserveFailedEvidencePublication(identity);
  return store.reserveEvidencePublication(identity);
}

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? Reflect.get(error, 'code') : undefined;
  if (typeof code === 'string' && [
    'EVIDENCE_CONFLICT',
    'EVIDENCE_INTERRUPTED',
    'EVIDENCE_PATH',
    'EVIDENCE_IO',
    'EVIDENCE_RECEIPT_CONFLICT',
  ].includes(code)) return code;
  const message = error instanceof Error ? error.message : '';
  const prefix = message.match(/^(EVIDENCE_[A-Z_]+):/)?.[1];
  return prefix && [
    'EVIDENCE_CONFLICT',
    'EVIDENCE_INTERRUPTED',
    'EVIDENCE_PATH',
    'EVIDENCE_IO',
    'EVIDENCE_RECEIPT_CONFLICT',
  ].includes(prefix) ? prefix : 'EVIDENCE_PUBLICATION_FAILED';
}

function notifyProgress(
  onProgress: ((event: EvidencePublicationProgress) => void) | undefined,
  event: EvidencePublicationProgress,
): void {
  try { onProgress?.(event); } catch {}
}

export async function publishRunEvidence(input: {
  runId: string;
  stateRoot: string;
  tempRoot: string;
  vaultRoot: string;
  store: StateStore;
  libraryId?: LibraryId;
  lastSuccess: string;
  eligibility?: EvidencePublicationEligibility;
  historicalVerifiedSources?: readonly HistoricalArchiveSource[];
  onProgress?: (event: EvidencePublicationProgress) => void;
}): Promise<EvidencePublicationResult> {
  const eligibility = input.eligibility ?? 'normal';
  if (input.historicalVerifiedSources !== undefined && eligibility !== 'historical') {
    conflict('historical verified sources require historical eligibility');
  }
  const sourceOverrides = input.historicalVerifiedSources === undefined
    ? undefined
    : new Map([[input.runId, await prepareEvidenceSources(input.historicalVerifiedSources)] as const]);
  const existing = input.store.findEvidencePublication(input.runId);
  const completed = input.store.listCompletedEvidencePublications();
  const history = await verifyCompletedHistory({
    completed,
    stateRoot: input.stateRoot,
    store: input.store,
    libraryId: input.libraryId,
    sourceOverrides,
  });
  const current = sourceOverrides?.get(input.runId) ?? await readPublicationRunSources({
    runId: input.runId,
    stateRoot: input.stateRoot,
    store: input.store,
    libraryId: history.libraryId,
  });
  if (eligibility !== 'historical' && current.some(source => source.source.schemaVersion !== 2)) {
    conflict('active publication requires verified Archive v2; legacy Archives require explicit historical eligibility');
  }
  const allIdentities = new Map(history.identities);
  addSources(allIdentities, current);
  if (existing?.status === 'completed' && history.baselineRunIds.has(input.runId)) {
    // Retired receipts retain their renderer and publication identity. Replaying
    // them is read-only acceptance of the entire current cumulative projection.
    const original = completed.find(p => p.runId === input.runId)!;
    const cumulative = planEvidencePublication({ runId: input.runId, sources: sortedSources(history.identities) });
    await verifyEvidencePublication({ plan: cumulative, vaultRoot: input.vaultRoot });
    notifyProgress(input.onProgress, { stage: 'verified', runId: input.runId, publicationId: original.publicationId });
    notifyProgress(input.onProgress, { stage: 'completed', runId: input.runId, publicationId: original.publicationId });
    return { status: 'completed', publicationId: original.publicationId, contentSha256: original.inputSha256,
      receiptPath: original.receiptPath, receiptSha256: original.receiptSha256, sourceCount: original.sources.length,
      reservationReplayed: true, applyReplayed: true };
  }
  const selection = selectPlan({
    runId: input.runId,
    current,
    history,
    existing,
  });
  const plan = selection.plan;
  const receiptPath = resolve(receiptPathForRun(input.stateRoot, input.runId));
  const selectedReceipt = existing ? await readExactPlanReceipt(receiptPath, plan) : null;
  if (existing?.status === 'completed' && (!selectedReceipt
    || existing.receipt_path !== receiptPath || existing.receipt_sha256 !== selectedReceipt.receiptSha256)) {
    receiptConflict('completed publication receipt does not match its persisted identity');
  }
  const superseded = await verifyLatestSupersedingProjection(selection, input.vaultRoot);
  notifyProgress(input.onProgress, { stage: 'verified', runId: input.runId, publicationId: plan.publicationId });

  const reservation = reserve(input.store, eligibility, plan);
  notifyProgress(input.onProgress, { stage: 'reserved', runId: input.runId, publicationId: plan.publicationId });
  try {
    await Promise.all([
      mkdir(input.tempRoot, { recursive: true }),
      mkdir(input.vaultRoot, { recursive: true }),
    ]);
    if (existing?.status === 'completed' && superseded) {
      notifyProgress(input.onProgress, { stage: 'applied', runId: input.runId, publicationId: plan.publicationId });
      notifyProgress(input.onProgress, { stage: 'completed', runId: input.runId, publicationId: plan.publicationId });
      return {
        status: 'completed',
        publicationId: plan.publicationId,
        contentSha256: plan.contentSha256,
        receiptPath,
        receiptSha256: selectedReceipt!.receiptSha256,
        sourceCount: plan.sources.length,
        reservationReplayed: reservation === 'replayed',
        applyReplayed: true,
      };
    }

    const applied = selectedReceipt && superseded
      ? { status: 'replayed' as const }
      : await applyEvidencePublication({
        plan,
        stateRoot: input.stateRoot,
        tempRoot: input.tempRoot,
        vaultRoot: input.vaultRoot,
      });
    notifyProgress(input.onProgress, { stage: 'applied', runId: input.runId, publicationId: plan.publicationId });

    const verifiedReceipt = await readExactPlanReceipt(receiptPath, plan);
    if (!verifiedReceipt) receiptConflict('applied receipt is missing');
    const receiptSha256 = verifiedReceipt.receiptSha256;
    const completion = {
      runId: input.runId,
      publicationId: plan.publicationId,
      receiptPath,
      receiptSha256,
      lastSuccess: input.lastSuccess,
    };
    if (eligibility === 'historical') input.store.completeHistoricalEvidencePublication(completion);
    else input.store.completeEvidencePublication(completion);
    notifyProgress(input.onProgress, { stage: 'completed', runId: input.runId, publicationId: plan.publicationId });
    return {
      status: 'completed',
      publicationId: plan.publicationId,
      contentSha256: plan.contentSha256,
      receiptPath,
      receiptSha256,
      sourceCount: plan.sources.length,
      reservationReplayed: reservation === 'replayed',
      applyReplayed: applied.status === 'replayed',
    };
  } catch (error) {
    if (input.store.findEvidencePublication(input.runId)?.status === 'reserved') {
      try {
        input.store.failEvidencePublication({
          runId: input.runId,
          publicationId: plan.publicationId,
          errorCode: safeErrorCode(error),
        });
      } catch {}
    }
    throw error;
  }
}
