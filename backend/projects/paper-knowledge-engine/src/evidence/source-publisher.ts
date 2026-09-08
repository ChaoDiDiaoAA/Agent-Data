import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ResearchEvidencePublication } from '../types/research-sources.ts';
import { canonicalJson } from '../shared/manifest.ts';
import { normalizeSourceVersion, sourceDate } from '../research/source-normalizer.ts';
import { requireSourceHash, requireVersionId, sha256 } from '../research/source-identity.ts';
import type { VerifiedResearchArchive } from './render-source.ts';
import { renderResearchIndexes, renderResearchSourceEvidence } from './render-source.ts';
import {
  createOrReplaySourceReceipt,
  equivalentSourceReceipt,
  parseSourcePublicationReceipt,
  recoverSourcePublicationReceiptTemporary,
  type SourcePublicationReceiptInput,
  type SourcePublicationSourceReceipt,
} from './source-receipt-store.ts';
import {
  installResearchEvidenceTargets,
  verifyResearchEvidenceTargets,
  type ResearchEvidenceTarget,
} from './research-publication-transaction.ts';
import { withRunLock } from '../runtime/run-lock.ts';

export interface ResearchEvidencePublicationStore {
  reserveResearchEvidencePublication(input: { runId: string; publicationId: string; inputSha256: string }): 'reserved' | 'replayed';
  completeResearchEvidencePublication(input: { runId: string; publicationId: string; receiptPath: string; receiptSha256: string }): void;
  failResearchEvidencePublication(input: { runId: string; publicationId: string; errorCode: string }): void;
  findResearchEvidencePublication(runId: string): ResearchEvidencePublication | undefined;
}

export interface ResearchEvidencePublicationInput {
  readonly runId: string;
  readonly stateRoot: string;
  readonly vaultRoot: string;
  readonly tempRoot: string;
  readonly store: ResearchEvidencePublicationStore;
  readonly selectionHash: string;
  readonly publicationId?: string;
  readonly archives: readonly VerifiedResearchArchive[];
  readonly now?: () => string;
}

export interface ResearchEvidencePublicationResult {
  readonly status: 'completed';
  readonly runId: string;
  readonly publicationId: string;
  readonly selectionHash: string;
  readonly receiptPath: string;
  readonly receiptSha256: string;
  readonly sourceCount: number;
  readonly replayed: boolean;
}

export class ResearchEvidencePublicationError extends Error {
  constructor(readonly code: 'EVIDENCE_CONFLICT' | 'EVIDENCE_PATH' | 'EVIDENCE_IO', message: string, cause?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'ResearchEvidencePublicationError';
    if (cause !== undefined) this.cause = cause;
  }
}

const safeRunId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const safePublicationId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function conflict(message: string): never { throw new ResearchEvidencePublicationError('EVIDENCE_CONFLICT', message); }
function pathError(message: string): never { throw new ResearchEvidencePublicationError('EVIDENCE_PATH', message); }

function normalizeTarget(file: { path?: string; relativePath?: string; bytes: Uint8Array; sha256: string }): ResearchEvidenceTarget {
  const relativePath = file.path ?? file.relativePath;
  if (!relativePath || !(file.bytes instanceof Uint8Array) || sha256(file.bytes) !== file.sha256) conflict(`rendered target hash differs: ${relativePath ?? '(unknown)'}`);
  return { relativePath, bytes: new Uint8Array(file.bytes), sha256: file.sha256 };
}

function mergeTargets(groups: readonly (readonly ResearchEvidenceTarget[])[]): ResearchEvidenceTarget[] {
  const targets = groups.flatMap(group => group).map(normalizeTarget).sort((left, right) => compareText(left.relativePath, right.relativePath));
  for (let index = 1; index < targets.length; index += 1) {
    if (targets[index - 1]!.relativePath === targets[index]!.relativePath) conflict(`duplicate research Evidence target: ${targets[index]!.relativePath}`);
  }
  return targets;
}

function archiveManifestHash(archive: VerifiedResearchArchive): string {
  return sha256(canonicalJson(archive.manifest));
}

function assertArchiveShape(archive: VerifiedResearchArchive): void {
  const manifest = archive.manifest;
  if (!manifest || manifest.schemaVersion !== 1 || !archive.files || !(archive.files instanceof Map)) conflict('research Archive is not verified');
  const normalized = normalizeSourceVersion(manifest.source, manifest.version);
  if (canonicalJson(normalized) !== canonicalJson({ source: manifest.source, version: manifest.version })
    || manifest.sourceId !== normalized.source.sourceId || manifest.sourceKind !== normalized.source.kind
    || manifest.versionId !== normalized.version.versionId || manifest.identityKey !== normalized.source.identityKey
    || manifest.canonicalUrl !== normalized.source.canonicalUrl || manifest.contentSha256 !== normalized.version.contentSha256
    || normalized.version.archivePath !== `archive/sources/${normalized.source.kind}/${normalized.source.sourceId}/${normalized.version.versionId}`) {
    conflict('research Archive manifest identity differs');
  }
  sourceDate(manifest.createdAt);
  const expected = new Map(manifest.files.map(file => [file.path, file]));
  if (expected.size !== manifest.files.length || expected.size !== archive.files.size) conflict('research Archive inventory differs');
  for (const entry of manifest.files) {
    const bytes = archive.files.get(entry.path);
    if (!bytes || bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) conflict(`research Archive file differs: ${entry.path}`);
  }
  for (const path of archive.files.keys()) if (!expected.has(path)) conflict(`research Archive contains an unmanifested file: ${path}`);
  const metadataBytes = archive.files.get('metadata.json');
  if (!metadataBytes) conflict('research Archive metadata is missing');
  let metadata: unknown;
  try { metadata = JSON.parse(Buffer.from(metadataBytes).toString('utf8')); }
  catch { conflict('research Archive metadata is unreadable'); }
  if (canonicalJson(metadata) !== Buffer.from(metadataBytes).toString('utf8') || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    conflict('research Archive metadata is not canonical');
  }
  const metadataRecord = metadata as Record<string, unknown>;
  if (canonicalJson({ source: metadataRecord.source, version: metadataRecord.version }) !== canonicalJson({ source: manifest.source, version: manifest.version })
    || !Array.isArray(metadataRecord.locators)) conflict('research Archive metadata binding differs');
  const contents = [...archive.files.entries()].filter(([path]) => /^content\.(md|txt)$/.test(path));
  if (contents.length !== 1 || !contents[0]![1].byteLength || sha256(contents[0]![1]) !== manifest.version.contentSha256) conflict('research Archive content is missing or differs');
}

function receiptInput(input: ResearchEvidencePublicationInput, sources: readonly SourcePublicationSourceReceipt[]): SourcePublicationReceiptInput {
  return {
    schemaVersion: 1,
    publisherVersion: 1,
    runId: input.runId,
    publicationId: input.publicationId ?? `research-evidence-${input.selectionHash.slice(0, 32)}`,
    contentSha256: input.selectionHash,
    sources,
  };
}

function receiptSources(archives: readonly VerifiedResearchArchive[], targets: readonly ResearchEvidenceTarget[]): SourcePublicationSourceReceipt[] {
  return archives.map(archive => {
    const root = `Evidence/sources/${archive.manifest.sourceKind}/${archive.manifest.sourceId}/${archive.manifest.versionId}/`;
    const manifest = targets.find(target => target.relativePath === `${root}manifest.json`);
    if (!manifest) conflict(`research Evidence manifest is missing: ${root}`);
    return {
      sourceId: archive.manifest.sourceId,
      versionId: requireVersionId(archive.manifest.versionId),
      archiveManifestSha256: archiveManifestHash(archive),
      evidenceManifestSha256: manifest!.sha256,
    };
  }).sort((left, right) => compareText(left.sourceId, right.sourceId) || compareText(left.versionId, right.versionId));
}

function sourceIdentityKey(archive: VerifiedResearchArchive): string {
  return `${archive.manifest.sourceId}\u0000${archive.manifest.versionId}`;
}

async function readReceiptSha256(path: string): Promise<{ bytes: Uint8Array; sha256: string }> {
  const bytes = await readFile(path);
  return { bytes, sha256: sha256(bytes) };
}

function checkExistingPublication(
  existing: ResearchEvidencePublication | undefined,
  input: ResearchEvidencePublicationInput,
  publicationId: string,
): void {
  if (!existing) return;
  if (existing.publicationId !== publicationId || existing.inputSha256 !== input.selectionHash) conflict('research publication identity differs');
}

/** Publish only verified generic research Archives into Evidence/sources. */
export async function publishResearchEvidence(input: ResearchEvidencePublicationInput): Promise<ResearchEvidencePublicationResult> {
  requireSourceHash(input.selectionHash);
  if (!safeRunId.test(input.runId)) pathError('runId is unsafe');
  const publicationId = input.publicationId ?? `research-evidence-${input.selectionHash.slice(0, 32)}`;
  if (!safePublicationId.test(publicationId)) pathError('publicationId is unsafe');
  const unique = new Map<string, VerifiedResearchArchive>();
  for (const archive of input.archives) {
    assertArchiveShape(archive);
    const key = sourceIdentityKey(archive);
    if (unique.has(key)) conflict(`duplicate research source/version: ${key}`);
    unique.set(key, archive);
  }
  const archives = [...unique.values()].sort((left, right) => compareText(sourceIdentityKey(left), sourceIdentityKey(right)));
  const sourceFiles = await Promise.all(archives.map(archive => renderResearchSourceEvidence({ archive, evidenceRoot: resolve(input.vaultRoot, 'Evidence') })));
  const indexFiles = await renderResearchIndexes({ sources: archives });
  const targets = mergeTargets([
    sourceFiles.flatMap(files => files.map(file => normalizeTarget(file))),
    indexFiles.map(file => normalizeTarget(file)),
  ]);
  const sources = receiptSources(archives, targets);
  const receipt = receiptInput({ ...input, publicationId }, sources);
  const receiptPath = join(input.stateRoot, 'runs', input.runId, 'evidence', 'source-publication.json');
  const lockPath = join(input.stateRoot, 'runs', input.runId, 'evidence', 'source-publication.lock');

  await mkdir(input.stateRoot, { recursive: true });
  await mkdir(input.tempRoot, { recursive: true });
  await mkdir(input.vaultRoot, { recursive: true });

  return withRunLock(lockPath, async () => {
    const existing = input.store.findResearchEvidencePublication(input.runId);
    checkExistingPublication(existing, input, publicationId);
    const reservation = input.store.reserveResearchEvidencePublication({ runId: input.runId, publicationId, inputSha256: input.selectionHash });
    const replayedReservation = reservation === 'replayed' && existing?.status === 'completed';
    let reserved = reservation === 'reserved';
    try {
      await recoverSourcePublicationReceiptTemporary({ path: receiptPath, receipt });
      const currentReceipt = await readFile(receiptPath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (currentReceipt !== null) {
        const parsed = parseSourcePublicationReceipt(currentReceipt);
        if (!equivalentSourceReceipt(parsed, receipt)) conflict('existing research receipt differs from this publication');
        await verifyResearchEvidenceTargets({ vaultRoot: input.vaultRoot, targets });
        const digest = sha256(Buffer.from(currentReceipt));
        if (!existing || existing.status !== 'completed') input.store.completeResearchEvidencePublication({ runId: input.runId, publicationId, receiptPath, receiptSha256: digest });
        return { status: 'completed', runId: input.runId, publicationId, selectionHash: input.selectionHash, receiptPath, receiptSha256: digest, sourceCount: archives.length, replayed: true };
      }

      await installResearchEvidenceTargets({
        stateRoot: input.stateRoot,
        tempRoot: input.tempRoot,
        vaultRoot: input.vaultRoot,
        binding: { publisherVersion: 1, runId: input.runId, publicationId, contentSha256: input.selectionHash },
        targets,
      });
      const created = await createOrReplaySourceReceipt({ path: receiptPath, receipt, publishedAt: input.now?.() });
      const receiptBytes = await readReceiptSha256(receiptPath);
      const parsed = parseSourcePublicationReceipt(Buffer.from(receiptBytes.bytes).toString('utf8'));
      if (!equivalentSourceReceipt(parsed, receipt)) conflict('written research receipt differs from this publication');
      input.store.completeResearchEvidencePublication({ runId: input.runId, publicationId, receiptPath, receiptSha256: receiptBytes.sha256 });
      reserved = false;
      return { status: 'completed', runId: input.runId, publicationId, selectionHash: input.selectionHash, receiptPath, receiptSha256: receiptBytes.sha256, sourceCount: archives.length, replayed: created.status === 'replayed' || replayedReservation };
    } catch (error) {
      if (reserved) {
        try { input.store.failResearchEvidencePublication({ runId: input.runId, publicationId, errorCode: error instanceof Error ? error.name || 'EVIDENCE_FAILED' : 'EVIDENCE_FAILED' }); }
        catch { /* preserve the original publication error */ }
      }
      throw error;
    }
  }, { waitMs: 30_000, jobId: `research-evidence:${input.runId}` });
}

export const publishSourceEvidence = publishResearchEvidence;
