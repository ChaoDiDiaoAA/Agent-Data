import { readFile, writeFile, rename, lstat, unlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StateStore } from '../library/state/state-store.ts';
import type { ResearchLibraryConfig, MachineConfig } from '../types/config.ts';
import type { RunWindow } from '../types/jobs.ts';
import type { ResearchCandidate, ResearchRun, ResearchRunMode, ResearchSourceKind, FetchedSource, ResearchEvidenceSource } from '../types/research-sources.ts';
import { safeMkdir } from '../mineru/archive-writer.ts';
import { assertRealPath } from '../shared/archive-v2.ts';
import { canonicalJson } from '../shared/manifest.ts';
import { errorField, redactErrorMessage } from '../shared/redaction.ts';
import { withRunLock } from '../runtime/run-lock.ts';
import { approveCandidate, type SourceDiscoveryAdapter, type DiscoveryInput } from './adapters/types.ts';
import { readVerifiedResearchArchive, writeResearchArchive } from './source-archive.ts';
import { normalizeSourceVersion, sourceDate } from './source-normalizer.ts';
import { sha256, requireSourceHash } from './source-identity.ts';
import { selectResearchCandidates, researchDiscoveryInput, type ResearchSelectionOptions } from './research-selection.ts';
import { createResearchSelectionCheckpoint, assertResearchResume, researchCheckpointHash,
  type ResearchRequestCheckpoint, type ResearchSelectionCheckpoint } from './research-checkpoints.ts';
import { calculateResearchCounters, formatResearchCounters, researchVersionKey, type ResearchCounters } from './research-counters.ts';
import { parseResearchSource, type ResearchMineruBoundary } from './research-parse.ts';

export interface ResearchRunRequest {
  mode: ResearchRunMode; from?: string; to?: string; limit?: number; tracks?: string[]; sourceKinds?: ResearchSourceKind[];
}
export interface ResearchRunResult {
  runId: string; mode: ResearchRunMode; window: RunWindow; counters: ResearchCounters;
  resumed: boolean; status: 'completed' | 'failed' | 'awaiting_evidence';
}
export type ResearchWorkflowStore = Pick<StateStore,
  'getLastSuccess' | 'startResearchRun' | 'failRun' |
  'upsertResearchSource' | 'upsertResearchSourceVersion' | 'findResearchSourceVersion' |
  'beginResearchShard' | 'completeResearchShard' | 'failResearchShard' | 'findResearchShard' |
  'listCompletedResearchShards' | 'recordResearchObservation' | 'findResearchEvidencePublication' | 'listResearchEvidenceSources'> & {
    /** Research-only lifecycle port; callers must supply these operations atomically. */
    getResearchRun(runId: string): ResearchRun | undefined;
    resumeResearchRun(runId: string, window: RunWindow, mode: ResearchRunMode): ResearchRun;
    getResearchRunCheckpoint(runId: string): { requestSha256: string; selectionSha256: string | null } | undefined;
    bindResearchRunCheckpoint(runId: string, requestSha256: string, selectionSha256?: string): void;
    awaitResearchEvidence(runId: string): void;
    completeResearchWorkflowRun(runId: string, selectionSha256: string, expected: ResearchEvidenceSource[]): void;
  };
type VerifiedArchive = Awaited<ReturnType<typeof readVerifiedResearchArchive>>;
type DiscoveryTargets = Pick<DiscoveryInput, 'targets' | 'localPaths' | 'localPurpose' | 'purpose'>;
export interface ResearchWorkflowDependencies {
  library: ResearchLibraryConfig;
  stateRoot: string;
  store: ResearchWorkflowStore;
  adapters: readonly SourceDiscoveryAdapter[];
  archive?: { write: typeof writeResearchArchive; read: typeof readVerifiedResearchArchive };
  mineru?: ResearchMineruBoundary;
  /** Explicit policy until the library configuration adds a full-text requirement. */
  fullTextKinds?: readonly ('paper' | 'technical-report')[];
  allowUndatedBackfill?: boolean;
  discoveryTargets?: Readonly<Record<string, DiscoveryTargets>>;
  network?: MachineConfig['network'];
  /** Hash of caller-owned engine/parser settings, in addition to the library snapshot. */
  configSnapshot?: unknown;
  signal?: AbortSignal;
  now?: () => string;
  publish?: (input: { runId: string; selectionHash: string; archives: readonly VerifiedArchive[]; store: ResearchWorkflowStore }) => Promise<void>;
  log?: (event: { runId: string; counters: ResearchCounters; text: string }) => void;
}
type PreparedSource = Omit<FetchedSource, 'files'> & { files: { path: string; base64: string }[] };
interface ShardCheckpoint {
  schemaVersion: 1; selectionHash: string; key: string; status: 'fetched' | 'archived' | 'failed';
  prepared?: PreparedSource; preparedSha256?: string; archiveManifestSha256?: string;
  error?: { code: string; message: string };
}
const archiveApi = (deps: ResearchWorkflowDependencies) => deps.archive ?? { write: writeResearchArchive, read: readVerifiedResearchArchive };
const conflict = (): never => { throw new Error('RESEARCH_RESUME_CONFLICT'); };
function safeRunId(id: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,100}$/.test(id)) return conflict(); return id; }
async function exists(path: string): Promise<boolean> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return false; await assertRealPath(path); return true;
}
async function json<T>(path: string): Promise<T> {
  await assertRealPath(path); const raw = await readFile(path, 'utf8'); const value = JSON.parse(raw);
  if (canonicalJson(value) !== raw) return conflict(); return value;
}
async function atomic(path: string, bytes: string) {
  await safeMkdir(dirname(path)); if (await exists(path)) await assertRealPath(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
const writeJson = (path: string, value: unknown) => atomic(path, canonicalJson(value));
function failure(error: unknown) {
  const raw = errorField(error, 'code');
  const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,70}$/.test(raw) ? raw : 'RESEARCH_RUN_FAILED';
  return { code, message: redactErrorMessage(error).slice(0, 2000) };
}
function normalizeRequest(request: ResearchRunRequest, deps: ResearchWorkflowDependencies, saved?: ResearchRequestCheckpoint): ResearchRequestCheckpoint {
  if (deps.library.kind !== 'research') throw new Error('UNSUPPORTED_LIBRARY_KIND');
  if (!['current', 'weekly', 'backfill'].includes(request.mode)) throw new Error('RESEARCH_REQUEST_INVALID');
  if (request.mode === 'backfill' && !saved && (!request.from || !request.to)) throw new Error('RESEARCH_BACKFILL_WINDOW_REQUIRED');
  const from = sourceDate(request.from ?? saved?.window.from ?? deps.store.getLastSuccess() ?? deps.library.startDate);
  const rawTo = request.to ?? saved?.window.to ?? (deps.now?.() ?? new Date().toISOString());
  const to = /^\d{4}-\d{2}-\d{2}$/.test(rawTo) ? `${sourceDate(rawTo).slice(0, 10)}T23:59:59.999Z` : sourceDate(rawTo);
  const tracks = request.tracks ?? saved?.tracks ?? deps.library.tracks.map(t => t.id);
  const kinds = request.sourceKinds ?? saved?.sourceKinds ?? deps.library.sourcePolicy.sourceKinds;
  const limit = request.limit ?? saved?.limit ?? (request.mode === 'weekly' ? deps.library.weeklySchedule.maxSources : deps.library.currentTask.maxSources);
  const configSha256 = researchCheckpointHash({ library: deps.library, network: deps.network ?? null,
    fullTextKinds: deps.fullTextKinds ?? [], allowUndatedBackfill: deps.allowUndatedBackfill ?? false,
    discoveryTargets: deps.discoveryTargets ?? {}, configSnapshot: deps.configSnapshot ?? null,
    adapters: deps.adapters.map(adapter => ({ id: adapter.id, kinds: adapter.kinds })).sort((a, b) => a.id.localeCompare(b.id)) });
  const normalized = { mode: request.mode, window: { from, to }, tracks: [...new Set(tracks)].sort(), sourceKinds: [...new Set(kinds)].sort(), limit, configSha256 };
  selectResearchCandidates([], selectionOptions(normalized, deps));
  if (!tracks.length || !kinds.length || new Set(deps.adapters.map(a => a.id)).size !== deps.adapters.length) throw new Error('RESEARCH_REQUEST_INVALID');
  return normalized;
}
function selectionOptions(request: ResearchRequestCheckpoint, deps: ResearchWorkflowDependencies): ResearchSelectionOptions {
  return { library: deps.library, window: request.window, mode: request.mode, limit: request.limit,
    tracks: request.tracks, sourceKinds: request.sourceKinds, allowUndatedBackfill: deps.allowUndatedBackfill };
}
function scope(request: ResearchRequestCheckpoint, deps: ResearchWorkflowDependencies, track: string, signal: AbortSignal) {
  return { ...researchDiscoveryInput(selectionOptions(request, deps), track, signal), ...deps.discoveryTargets?.[track], network: deps.network };
}
function expectedPath(deps: ResearchWorkflowDependencies, candidate: ResearchCandidate): string {
  return resolve(deps.stateRoot, 'archive', 'sources', candidate.source.kind, candidate.source.sourceId, candidate.version.versionId);
}
function assertArchive(archive: VerifiedArchive, candidate: ResearchCandidate, deps: ResearchWorkflowDependencies) {
  const m = archive.manifest;
  if (m.libraryId !== deps.library.libraryId || m.sourceId !== candidate.source.sourceId || m.versionId !== candidate.version.versionId
    || m.sourceKind !== candidate.source.kind || m.identityKey !== candidate.source.identityKey || m.canonicalUrl !== candidate.source.canonicalUrl)
    throw new Error('SOURCE_VERSION_CONFLICT');
  const discovery = archive.files.get('metadata/discovery.json');
  const originalHash = discovery ? JSON.parse(Buffer.from(discovery).toString('utf8')).contentSha256 : m.contentSha256;
  if (originalHash !== candidate.version.contentSha256) throw new Error('SOURCE_VERSION_CONFLICT');
  if (deps.fullTextKinds?.includes(candidate.source.kind as 'paper') && !archive.files.has('metadata/pdf.json')) throw new Error('SOURCE_VERSION_CONFLICT');
}
function encode(fetched: FetchedSource): PreparedSource {
  return { ...fetched, files: fetched.files.map(file => ({ path: file.path, base64: Buffer.from(file.contents).toString('base64') })) };
}
function decode(prepared: PreparedSource): FetchedSource {
  return { ...prepared, files: prepared.files.map(file => ({ path: file.path, contents: Buffer.from(file.base64, 'base64') })) };
}

export async function runResearchTask(request: ResearchRunRequest, deps: ResearchWorkflowDependencies): Promise<ResearchRunResult> {
  return locked(deps, async () => {
    const normalized = normalizeRequest(request, deps);
    const run = deps.store.startResearchRun(normalized.window, request.mode);
    if (run.resumed || run.replayed) return recover(run.id, request, deps);
    const root = join(deps.stateRoot, 'runs', safeRunId(run.id));
    await writeJson(join(root, 'request.json'), normalized);
    deps.store.bindResearchRunCheckpoint(run.id, researchCheckpointHash(normalized));
    return execute(run, normalized, deps, false);
  });
}
export async function resumeResearchTask(runId: string, request: ResearchRunRequest, deps: ResearchWorkflowDependencies): Promise<ResearchRunResult> {
  safeRunId(runId); return locked(deps, () => recover(runId, request, deps));
}
async function locked<T>(deps: ResearchWorkflowDependencies, work: () => Promise<T>) {
  const root = join(deps.stateRoot, 'operations', 'locks'); await safeMkdir(root);
  return withRunLock(join(root, 'research-sync.lock'), work);
}
async function recover(runId: string, request: ResearchRunRequest, deps: ResearchWorkflowDependencies): Promise<ResearchRunResult> {
  const root = join(deps.stateRoot, 'runs', safeRunId(runId));
  let saved: ResearchRequestCheckpoint, normalized: ResearchRequestCheckpoint, selection: ResearchSelectionCheckpoint | undefined;
  try {
    saved = await json<ResearchRequestCheckpoint>(join(root, 'request.json'));
    normalized = normalizeRequest(request, deps, saved);
    const binding = deps.store.getResearchRunCheckpoint(runId), run = deps.store.getResearchRun(runId);
    if (!binding || !run || run.kind !== `research_${normalized.mode}` || run.from !== normalized.window.from || run.to !== normalized.window.to
      || binding.requestSha256 !== researchCheckpointHash(normalized) || canonicalJson(saved) !== canonicalJson(normalized)) return conflict();
    if (await exists(join(root, 'selection.json'))) {
      selection = await json<ResearchSelectionCheckpoint>(join(root, 'selection.json'));
      const actual = researchCheckpointHash(selection);
      // A crash during initial freeze may leave selection.json before the hash/binding.
      const hasHash = await exists(join(root, 'selection.sha256'));
      if (binding.selectionSha256 && !hasHash) return conflict();
      const storedHash = hasHash ? await readFile(join(root, 'selection.sha256'), 'utf8') : actual;
      assertResearchResume({ savedRequest: saved, request: normalized, selection, storedHash, expectedHash: binding.selectionSha256 ?? actual });
      if (!binding.selectionSha256) {
        await atomic(join(root, 'selection.sha256'), actual);
        deps.store.bindResearchRunCheckpoint(runId, binding.requestSha256, actual);
      }
    } else if (binding.selectionSha256) return conflict();
  } catch { return conflict(); }
  const run = deps.store.resumeResearchRun(runId, normalized.window, normalized.mode);
  return execute(run, normalized, deps, true, selection);
}

async function execute(run: ResearchRun, request: ResearchRequestCheckpoint, deps: ResearchWorkflowDependencies,
  resumed: boolean, frozen?: ResearchSelectionCheckpoint): Promise<ResearchRunResult> {
  const root = join(deps.stateRoot, 'runs', safeRunId(run.id)), signal = deps.signal ?? new AbortController().signal;
  let selection = frozen, candidateCount = frozen?.candidateCount ?? 0;
  const verified: VerifiedArchive[] = [];
  const counters = () => calculateResearchCounters({ candidateCount, accepted: selection?.accepted ?? [],
    newVersions: selection?.accepted.filter(v => v.isNewVersion) ?? [], archived: verified.map(a => a.manifest),
    published: deps.store.listResearchEvidenceSources(run.id).filter(v => verified.some(a => researchVersionKey(a.manifest) === researchVersionKey(v))) });
  async function result(status: ResearchRunResult['status']): Promise<ResearchRunResult> {
    const value = counters(); await writeJson(join(root, 'counters.json'), value);
    try { deps.log?.({ runId: run.id, counters: value, text: formatResearchCounters(value) }); } catch { /* Observers cannot change run outcome. */ }
    return { runId: run.id, mode: request.mode, window: request.window, counters: value, resumed, status };
  }
  try {
    signal.throwIfAborted();
    if (!selection) {
      const hits: ResearchCandidate[] = [];
      for (const track of request.tracks) for (const adapter of deps.adapters) {
        const input = scope(request, deps, track, signal);
        if (!adapter.kinds.some(k => input.allowedSourceKinds.includes(k) && input.track.sourceKinds.includes(k))) continue;
        const key = `discovery-${sha256(`${track}/${adapter.id}`)}`, path = join(root, 'shards', `${key}.json`);
        const batch = await exists(path) ? await json<{ candidates: ResearchCandidate[]; sha256: string }>(path) : undefined;
        const candidates = batch?.candidates ?? [...await adapter.discover(input)];
        if (batch && batch.sha256 !== researchCheckpointHash(candidates)) return conflict();
        if (candidates.some(c => c.discoveryAdapter !== adapter.id)) throw new Error('RESEARCH_ADAPTER_MISMATCH');
        if (!batch) await writeJson(path, { candidates, sha256: researchCheckpointHash(candidates) });
        hits.push(...candidates); candidateCount = hits.length;
      }
      const selected = selectResearchCandidates(hits, selectionOptions(request, deps));
      selection = createResearchSelectionCheckpoint({ candidateCount, accepted: selected.accepted.map(c => ({ sourceId: c.source.sourceId,
        versionId: c.version.versionId, isNewVersion: !deps.store.findResearchSourceVersion(c.source.sourceId, c.version.versionId) })), selected: selected.selected });
      await writeJson(join(root, 'selection.json'), selection);
      await atomic(join(root, 'selection.sha256'), researchCheckpointHash(selection));
      deps.store.bindResearchRunCheckpoint(run.id, researchCheckpointHash(request), researchCheckpointHash(selection));
    }
    const selectionHash = researchCheckpointHash(selection);
    for (const [index, candidate] of selection.selected.entries()) {
      signal.throwIfAborted();
      const key = sha256(researchVersionKey(candidate.version)), path = join(root, 'shards', `${key}.json`);
      let checkpoint = await exists(path) ? await json<ShardCheckpoint>(path) : undefined;
      if (checkpoint && (checkpoint.schemaVersion !== 1 || checkpoint.selectionHash !== selectionHash || checkpoint.key !== key)) return conflict();
      const identity = { runId: run.id, shardKey: key };
      if (deps.store.findResearchShard(run.id, key)?.status === 'completed') {
        const archive = await archiveApi(deps).read(expectedPath(deps, candidate), { libraryId: deps.library.libraryId, sourceId: candidate.source.sourceId, versionId: candidate.version.versionId });
        assertArchive(archive, candidate, deps);
        if (checkpoint?.archiveManifestSha256 && checkpoint.archiveManifestSha256 !== researchCheckpointHash(archive.manifest)) throw new Error('SOURCE_VERSION_CONFLICT');
        verified.push(archive); continue;
      }
      deps.store.beginResearchShard({ ...identity, shardIndex: index + 1, track: candidate.source.primaryTrack, sourceKind: candidate.source.kind });
      try {
        let archive: VerifiedArchive;
        const previous = deps.store.findResearchSourceVersion(candidate.source.sourceId, candidate.version.versionId);
        if (previous?.archivePath) {
          if (resolve(deps.stateRoot, previous.archivePath) !== expectedPath(deps, candidate)) throw new Error('SOURCE_VERSION_CONFLICT');
          archive = await archiveApi(deps).read(expectedPath(deps, candidate)); assertArchive(archive, candidate, deps);
        } else {
          let fetched: FetchedSource;
          if (checkpoint?.prepared) {
            if (researchCheckpointHash(checkpoint.prepared) !== checkpoint.preparedSha256) return conflict();
            fetched = decode(checkpoint.prepared);
          } else {
            const adapter = deps.adapters.find(a => a.id === candidate.discoveryAdapter);
            if (!adapter) throw new Error('RESEARCH_ADAPTER_MISSING');
            fetched = await adapter.fetch({ candidate: approveCandidate(candidate, scope(request, deps, candidate.source.primaryTrack, signal)), signal });
            normalizeSourceVersion(fetched.source, fetched.version);
            if (canonicalJson(fetched.source) !== canonicalJson(candidate.source) || canonicalJson(fetched.version) !== canonicalJson(candidate.version)) throw new Error('RESEARCH_SOURCE_CHANGED');
            const content = fetched.files.filter(file => /^content\.(md|txt)$/.test(file.path));
            if (content.length !== 1 || sha256(content[0].contents) !== candidate.version.contentSha256) throw new Error('RESEARCH_SOURCE_CHANGED');
            fetched = await parseResearchSource(fetched, { requireFullText: deps.fullTextKinds?.includes(candidate.source.kind as 'paper') ?? false, mineru: deps.mineru, signal });
            const prepared = encode(fetched);
            checkpoint = { schemaVersion: 1, selectionHash, key, status: 'fetched', prepared, preparedSha256: researchCheckpointHash(prepared) };
            await writeJson(path, checkpoint);
          }
          const written = await archiveApi(deps).write({ root: deps.stateRoot, libraryId: deps.library.libraryId, fetched });
          if (resolve(written.archivePath) !== expectedPath(deps, candidate)) throw new Error('SOURCE_VERSION_CONFLICT');
          archive = await archiveApi(deps).read(written.archivePath, { libraryId: deps.library.libraryId, sourceId: candidate.source.sourceId, versionId: candidate.version.versionId });
          assertArchive(archive, candidate, deps);
          if (researchCheckpointHash(written.manifest) !== researchCheckpointHash(archive.manifest) || archive.manifest.contentSha256 !== fetched.version.contentSha256) throw new Error('SOURCE_VERSION_CONFLICT');
        }
        deps.store.upsertResearchSource(archive.manifest.source);
        deps.store.upsertResearchSourceVersion(archive.manifest.version, null);
        deps.store.recordResearchObservation({ ...identity, sourceId: candidate.source.sourceId, versionId: candidate.version.versionId,
          metadata: { matchedTracks: candidate.matchedTracks }, decisionStatus: 'accepted', decisionReason: 'selected', observedAt: candidate.version.retrievedAt });
        checkpoint = { schemaVersion: 1, selectionHash, key, status: 'archived', archiveManifestSha256: researchCheckpointHash(archive.manifest) };
        await writeJson(path, checkpoint);
        deps.store.completeResearchShard({ ...identity, candidateCount: 1, acceptedCount: 1, archivedCount: 1,
          newVersionCount: Number(selection.accepted.find(v => researchVersionKey(v) === researchVersionKey(candidate.version))!.isNewVersion) });
        verified.push(archive); await writeJson(join(root, 'counters.json'), counters());
      } catch (error) {
        const safe = failure(error);
        await writeJson(path, { ...checkpoint, schemaVersion: 1, selectionHash, key, status: 'failed', error: safe });
        deps.store.failResearchShard({ ...identity, errorCode: safe.code, errorMessage: safe.message }); throw error;
      }
    }
    if (run.status !== 'completed' && deps.publish) await deps.publish({ runId: run.id, selectionHash, archives: verified, store: deps.store });
    const publication = deps.store.findResearchEvidencePublication(run.id);
    if (publication?.status === 'completed') {
      const sources = deps.store.listResearchEvidenceSources(run.id);
      if (sources.length !== verified.length || sources.some(source => !verified.some(a => researchVersionKey(a.manifest) === researchVersionKey(source)
        && researchCheckpointHash(a.manifest) === source.archiveManifestSha256))) throw new Error('RESEARCH_PUBLICATION_INCOMPLETE');
      deps.store.completeResearchWorkflowRun(run.id, selectionHash, sources);
      return result('completed');
    }
    if (deps.publish) throw new Error('RESEARCH_PUBLICATION_INCOMPLETE');
    deps.store.awaitResearchEvidence(run.id); return result('awaiting_evidence');
  } catch (error) {
    const safe = failure(error); await writeJson(join(root, 'failure.json'), safe);
    deps.store.failRun(run.id, safe.message); return result('failed');
  }
}
