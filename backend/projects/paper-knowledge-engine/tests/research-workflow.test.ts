import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runResearchTask, resumeResearchTask, type ResearchWorkflowDependencies, type ResearchWorkflowStore } from '../src/research/research-workflow.ts';
import { parseResearchSource } from '../src/research/research-parse.ts';
import { researchFixture } from './fixtures/research-source.ts';
import { selectionCandidate, selectionLibrary } from './research-selection.test.ts';
import { fetchScope, type SourceDiscoveryAdapter } from '../src/research/adapters/types.ts';
import { canonicalJson } from '../src/shared/manifest.ts';
import { sha256, sourceIdentity } from '../src/research/source-identity.ts';
import type { ResearchArchiveManifest } from '../src/research/source-archive.ts';
import type { ResearchRun, ResearchShard, ResearchObservation, SourceVersion, ResearchEvidenceSource, ResearchEvidencePublication, FetchedSource } from '../src/types/research-sources.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const clone = <T>(v: T): T => structuredClone(v);

function fakeStore() {
  const runs = new Map<string, ResearchRun>(), versions = new Map<string, SourceVersion>();
  const shards = new Map<string, ResearchShard>(), observations = new Map<string, ResearchObservation>();
  const bindings = new Map<string, { requestSha256: string; selectionSha256: string | null }>();
  const publications = new Map<string, ResearchEvidencePublication>(), published = new Map<string, ResearchEvidenceSource[]>();
  let watermark: string | null = null;
  const store: ResearchWorkflowStore = {
    getLastSuccess: () => watermark,
    getResearchRun: id => clone(runs.get(id)),
    startResearchRun(window, mode) {
      const run: ResearchRun = { id: `run-${runs.size + 1}`, kind: `research_${mode}`, ...window, status: 'running', startedAt: '2026-09-07T00:00:00.000Z' };
      runs.set(run.id, run); return clone(run);
    },
    resumeResearchRun(id, window, mode) {
      const run = runs.get(id)!;
      if (!run || run.kind !== `research_${mode}` || run.from !== window.from || run.to !== window.to) throw new Error('RESEARCH_RESUME_CONFLICT');
      if (run.status !== 'completed') run.status = 'running';
      return { ...clone(run), resumed: true };
    },
    getResearchRunCheckpoint: id => clone(bindings.get(id)),
    bindResearchRunCheckpoint(id, requestSha256, selectionSha256) {
      const old = bindings.get(id);
      if (old && (old.requestSha256 !== requestSha256 || (old.selectionSha256 && old.selectionSha256 !== selectionSha256))) throw new Error('RESEARCH_RESUME_CONFLICT');
      bindings.set(id, { requestSha256, selectionSha256: selectionSha256 ?? old?.selectionSha256 ?? null });
    },
    awaitResearchEvidence(id) { runs.get(id)!.status = 'awaiting_evidence'; },
    failRun(id, _message) { runs.get(id)!.status = 'failed'; },
    completeResearchWorkflowRun(id, selectionHash, expected) {
      const publication = publications.get(id);
      if (publication?.status !== 'completed' || publication.inputSha256 !== selectionHash
        || canonicalJson(published.get(id)) !== canonicalJson(expected)) throw new Error('RESEARCH_PUBLICATION_INCOMPLETE');
      const run = runs.get(id)!; run.status = 'completed';
      if (run.kind !== 'research_backfill' && (!watermark || run.to > watermark)) watermark = run.to;
    },
    upsertResearchSource() {},
    findResearchSourceVersion: (id, version) => clone(versions.get(`${id}/${version}`)),
    upsertResearchSourceVersion(version) {
      const key = `${version.sourceId}/${version.versionId}`, old = versions.get(key);
      if (old && canonicalJson(old) !== canonicalJson(version)) throw new Error('SOURCE_VERSION_CONFLICT');
      versions.set(key, clone(version)); return old ? 'replayed' : 'inserted';
    },
    beginResearchShard(input) {
      const key = `${input.runId}/${input.shardKey}`, old = shards.get(key);
      if (old?.status === 'completed') return false;
      shards.set(key, { ...input, status: 'running', candidateCount: 0, acceptedCount: 0, newVersionCount: 0, archivedCount: 0,
        errorCode: null, errorMessage: null, startedAt: '2026-09-07T00:00:00.000Z', finishedAt: null }); return true;
    },
    completeResearchShard(input) { Object.assign(shards.get(`${input.runId}/${input.shardKey}`)!, input, { status: 'completed' }); },
    failResearchShard(input) { Object.assign(shards.get(`${input.runId}/${input.shardKey}`)!, input, { status: 'failed' }); },
    findResearchShard: (id, key) => clone(shards.get(`${id}/${key}`)),
    listCompletedResearchShards: id => [...shards.values()].filter(s => s.runId === id && s.status === 'completed').map(s => s.shardKey),
    recordResearchObservation(input) {
      const key = `${input.runId}/${input.shardKey}/${input.sourceId}/${input.versionId}`, old = observations.get(key);
      if (old && canonicalJson(old) !== canonicalJson(input)) throw new Error('observation conflict'); observations.set(key, clone(input));
    },
    findResearchEvidencePublication: id => clone(publications.get(id)),
    listResearchEvidenceSources: id => clone(published.get(id) ?? []),
  };
  return { store, runs, versions, shards, observations, publications, published };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'research-workflow-')); roots.push(root);
  const state = fakeStore(), library = selectionLibrary(); library.tracks = library.tracks.slice(0, 2);
  const archives = new Map<string, { manifest: ResearchArchiveManifest; files: Map<string, Uint8Array> }>();
  const calls = { discover: 0, fetch: [] as string[], write: [] as string[], parse: 0 };
  let hits = [selectionCandidate(), selectionCandidate('r2')], failVersion = '', failArchive = '';
  const adapter: SourceDiscoveryAdapter = { id: 'docs', kinds: ['official-doc', 'paper', 'technical-report'],
    async discover(input) { calls.discover++; return hits.map(hit => ({ ...clone(hit), matchedTracks: [input.track.id], source: { ...clone(hit.source), primaryTrack: input.track.id } })); },
    async fetch(input) {
      fetchScope(input, adapter); const candidate = input.candidate; calls.fetch.push(candidate.version.versionId);
      expect(await readFile(join(root, 'runs/run-1/selection.sha256'), 'utf8')).toMatch(/^[a-f0-9]{64}$/);
      if (candidate.version.versionId === failVersion) throw new Error('Bearer secret-value https://private.example/path token=private-value');
      return { ...researchFixture(), source: candidate.source, version: candidate.version };
    } };
  const deps: ResearchWorkflowDependencies = { library, stateRoot: root, store: state.store, adapters: [adapter], now: () => '2026-09-07T00:00:00.000Z',
    archive: {
      async write(input) {
        calls.write.push(input.fetched.version.versionId);
        if (input.fetched.version.versionId === failArchive) throw new Error('archive unavailable');
        const { source } = input.fetched, version = { ...input.fetched.version,
          archivePath: `archive/sources/${source.kind}/${source.sourceId}/${input.fetched.version.versionId}` };
        const path = join(root, version.archivePath);
        const manifest: ResearchArchiveManifest = { schemaVersion: 1, libraryId: library.libraryId, sourceId: source.sourceId,
          sourceKind: source.kind, versionId: version.versionId, identityKey: source.identityKey, canonicalUrl: source.canonicalUrl,
          contentSha256: version.contentSha256, source: clone(source), version: clone(version), files: [], createdAt: version.retrievedAt };
        const existing = archives.get(path);
        if (existing && canonicalJson(existing.manifest) !== canonicalJson(manifest)) throw new Error('RESEARCH_ARCHIVE_CONFLICT');
        archives.set(path, { manifest, files: new Map(input.fetched.files.map(f => [f.path, f.contents])) });
        return { archivePath: path, manifest };
      },
      async read(path) { const value = archives.get(path); if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return clone(value); },
    },
    mineru: { async parse() { calls.parse++; return { markdown: 'Full text\r\n', pages: [{ page: 1, startLine: 1, endLine: 1 }] }; } },
  };
  const publish: NonNullable<ResearchWorkflowDependencies['publish']> = async input => {
    const sources = input.archives.map(a => ({ sourceId: a.manifest.sourceId, versionId: a.manifest.versionId,
      archiveManifestSha256: sha256(canonicalJson(a.manifest)), evidenceManifestSha256: 'b'.repeat(64) }))
      .sort((a, b) => `${a.sourceId}/${a.versionId}`.localeCompare(`${b.sourceId}/${b.versionId}`));
    state.published.set(input.runId, sources);
    state.publications.set(input.runId, { runId: input.runId, publicationId: 'publication', inputSha256: input.selectionHash,
      status: 'completed', receiptPath: 'fake-receipt', receiptSha256: 'c'.repeat(64), reservedAt: deps.now!(), completedAt: deps.now!(), failedAt: null, errorCode: null });
  };
  return { root, deps, state, archives, calls, publish, setHits: (value: typeof hits) => { hits = value; },
    failFetch: (value: string) => { failVersion = value; }, failArchive: (value: string) => { failArchive = value; } };
}

test('current freezes duplicate Track hits before fetch, archives v1/v2 and awaits publication without a watermark', async () => {
  const f = await fixture(); const result = await runResearchTask({ mode: 'current' }, f.deps);
  expect(result).toMatchObject({ mode: 'current', resumed: false, status: 'awaiting_evidence', window: { from: '2026-01-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' },
    counters: { candidates: 4, accepted: 2, newVersions: 2, archived: 2, published: 0 } });
  expect(f.state.runs.get(result.runId)?.kind).toBe('research_current'); expect(f.state.store.getLastSuccess()).toBeNull();
  expect(f.calls.fetch).toEqual(['r1', 'r2']); expect(f.calls.parse).toBe(0);
  expect(await readdir(join(f.root, 'runs', result.runId))).toEqual(expect.arrayContaining(['request.json', 'selection.json', 'selection.sha256', 'counters.json', 'shards']));
});

test('full publication alone advances current/weekly watermark; backfill is independent and replay counts are unique', async () => {
  const f = await fixture(); f.deps.publish = f.publish;
  const first = await runResearchTask({ mode: 'current' }, f.deps);
  expect(first.status).toBe('completed'); expect(first.counters.published).toBe(2);
  const watermark = f.state.store.getLastSuccess(); expect(watermark).toBe(first.window.to);
  f.setHits([]); f.deps.now = () => '2026-09-08T00:00:00.000Z';
  const weekly = await runResearchTask({ mode: 'weekly' }, f.deps);
  expect(weekly.window.from).toBe(watermark!); expect(f.state.runs.get(weekly.runId)?.kind).toBe('research_weekly');
  expect(f.state.store.getLastSuccess()).toBe(weekly.window.to);
  f.setHits([selectionCandidate()]);
  const backfill = await runResearchTask({ mode: 'backfill', from: '2026-01-01', to: '2026-06-30' }, f.deps);
  expect(backfill.status).toBe('completed'); expect(backfill.counters).toMatchObject({ newVersions: 0, archived: 1, published: 1 });
  expect(f.state.runs.get(backfill.runId)?.kind).toBe('research_backfill'); expect(f.state.store.getLastSuccess()).toBe(weekly.window.to);
});

test('failed shard retries fixed selection, completed shard skips and failure files are sanitized', async () => {
  const f = await fixture(); f.failFetch('r2');
  const failed = await runResearchTask({ mode: 'current' }, f.deps); expect(failed.status).toBe('failed');
  const path = join(f.root, 'runs', failed.runId), hash = await readFile(join(path, 'selection.sha256'), 'utf8');
  const failure = await readFile(join(path, 'failure.json'), 'utf8');
  expect(failure).not.toContain('secret-value'); expect(failure).not.toContain('private.example'); expect(failure).not.toContain('private-value');
  const discoveryCount = f.calls.discover; f.setHits([selectionCandidate('r3')]); f.failFetch(''); f.deps.publish = f.publish;
  const result = await resumeResearchTask(failed.runId, { mode: 'current' }, f.deps);
  expect(result).toMatchObject({ resumed: true, status: 'completed', counters: { candidates: 4, accepted: 2, newVersions: 2, archived: 2, published: 2 } });
  expect(f.calls.discover).toBe(discoveryCount); expect(f.calls.fetch).toEqual(['r1', 'r2', 'r2']);
  expect(await readFile(join(path, 'selection.sha256'), 'utf8')).toBe(hash); expect(f.state.observations.size).toBe(2);
  const replay = await resumeResearchTask(failed.runId, { mode: 'current' }, f.deps);
  expect(replay.counters).toEqual(result.counters); expect(f.calls.fetch).toEqual(['r1', 'r2', 'r2']); expect(f.state.published.size).toBe(1);
});

test('archive failure resumes the persisted fetch boundary without downloading again', async () => {
  const f = await fixture(); f.failArchive('r2');
  const first = await runResearchTask({ mode: 'current' }, f.deps); expect(first.status).toBe('failed');
  f.failArchive(''); const result = await resumeResearchTask(first.runId, { mode: 'current' }, f.deps);
  expect(result.status).toBe('awaiting_evidence'); expect(f.calls.fetch).toEqual(['r1', 'r2']);
  expect(f.calls.write).toEqual(['r1', 'r2', 'r2']);
});

test('resume rejects mode, window, config and rehashed selection changes before any work', async () => {
  const f = await fixture(); const result = await runResearchTask({ mode: 'current' }, f.deps);
  const before = clone(f.calls);
  await expect(resumeResearchTask(result.runId, { mode: 'weekly' }, f.deps)).rejects.toThrow('RESEARCH_RESUME_CONFLICT');
  await expect(resumeResearchTask(result.runId, { mode: 'current', to: '2026-10-01' }, f.deps)).rejects.toThrow('RESEARCH_RESUME_CONFLICT');
  const changed = { ...f.deps, library: { ...f.deps.library, currentTask: { ...f.deps.library.currentTask, maxSources: 9 } } };
  await expect(resumeResearchTask(result.runId, { mode: 'current' }, changed)).rejects.toThrow('RESEARCH_RESUME_CONFLICT');
  const path = join(f.root, 'runs', result.runId), selection = JSON.parse(await readFile(join(path, 'selection.json'), 'utf8'));
  selection.selected.reverse(); await writeFile(join(path, 'selection.json'), canonicalJson(selection));
  await writeFile(join(path, 'selection.sha256'), sha256(canonicalJson(selection)));
  await expect(resumeResearchTask(result.runId, { mode: 'current' }, f.deps)).rejects.toThrow('RESEARCH_RESUME_CONFLICT');
  expect(f.calls).toEqual(before);
});

test('policy rejects benchmark candidates; incomplete publication and invalid requests cannot advance watermark', async () => {
  const f = await fixture(); const bad = selectionCandidate(); bad.source.kind = 'leaderboard' as never;
  f.setHits([bad]); expect((await runResearchTask({ mode: 'current' }, f.deps)).counters.accepted).toBe(0);
  await expect(runResearchTask({ mode: 'backfill' }, f.deps)).rejects.toThrow();
  await expect(runResearchTask({ mode: 'current', sourceKinds: ['single-result' as never] }, f.deps)).rejects.toThrow();
  f.setHits([selectionCandidate()]); f.deps.publish = async input => { await f.publish(input); f.state.published.set(input.runId, []); };
  const failed = await runResearchTask({ mode: 'current' }, f.deps); expect(failed.status).toBe('failed'); expect(f.state.store.getLastSuccess()).toBeNull();
});

function paperSource(kind: 'paper' | 'technical-report' = 'paper'): FetchedSource {
  const fetched = researchFixture(); const identity = sourceIdentity({ kind, arxivId: '2601.01234v1',
    canonicalUrl: 'https://arxiv.org/abs/2601.01234v1', contentSha256: fetched.version.contentSha256 });
  return { ...fetched, source: { ...fetched.source, ...identity, kind },
    version: { ...fetched.version, sourceId: identity.sourceId, versionId: identity.versionId, versionLabel: 'v1' },
    files: [...fetched.files, { path: 'source.pdf', contents: Buffer.from('%PDF-1.7\nfixture') }] };
}

test('paper and technical-report use only injected generic MinerU and preserve PDF hash/page locators', async () => {
  for (const kind of ['paper', 'technical-report'] as const) {
    let calls = 0; const fetched = paperSource(kind);
    const parsed = await parseResearchSource(fetched, { requireFullText: true, mineru: { async parse(input) {
      calls++; expect(input.pdfSha256).toBe(sha256(fetched.files[1].contents));
      return { markdown: 'Full text\r\n', pages: [{ page: 1, startLine: 1, endLine: 1 }] };
    } } });
    expect(calls).toBe(1); expect(parsed.version.contentSha256).toBe(sha256('Full text\n'));
    expect(parsed.files.find(f => f.path === 'content.md')?.contents).toEqual(Buffer.from('Full text\n'));
    expect(parsed.files.some(f => f.path === 'metadata/pdf.json')).toBe(true);
    expect(parsed.locators).toContainEqual({ artifactPath: 'source.pdf', page: 1 });
    expect(fetched.version.contentSha256).toBe(sha256('Agent guide\n'));
  }
});

test('docs/spec/repos/releases never start MinerU, and missing or invalid parse results fail closed', async () => {
  let calls = 0; const mineru = { async parse() { calls++; throw new Error('must not start'); } };
  for (const kind of ['official-doc', 'specification', 'repository', 'release', 'evaluation-method', 'local-artifact'] as const) {
    const fetched = researchFixture(); fetched.source.kind = kind;
    expect(await parseResearchSource(fetched, { requireFullText: true, mineru })).toBe(fetched);
  }
  expect(calls).toBe(0);
  expect(await parseResearchSource(paperSource(), { requireFullText: false, mineru })).toBeDefined(); expect(calls).toBe(0);
  await expect(parseResearchSource(paperSource(), { requireFullText: true })).rejects.toThrow('RESEARCH_MINERU_REQUIRED');
  await expect(parseResearchSource(paperSource(), { requireFullText: true, mineru: { async parse() { return { markdown: '', pages: [] }; } } })).rejects.toThrow();
});

test('a committed selection requires its hash file on resume', async () => {
  const f = await fixture(); const run = await runResearchTask({ mode: 'current' }, f.deps);
  await unlink(join(f.root, 'runs', run.runId, 'selection.sha256'));
  await expect(resumeResearchTask(run.runId, { mode: 'current' }, f.deps)).rejects.toThrow('RESEARCH_RESUME_CONFLICT');
});

test('paper workflow persists parsed artifacts before archive retry and never enters FSD parsing', async () => {
  const f = await fixture(); const fetched = paperSource();
  const candidate = { ...selectionCandidate('v1'), source: fetched.source, version: { ...fetched.version, updatedAt: '2026-06-01T00:00:00.000Z' } };
  f.setHits([candidate]); f.deps.fullTextKinds = ['paper']; f.failArchive('v1');
  const adapter = f.deps.adapters[0]; const fetchOriginal = adapter.fetch;
  adapter.fetch = async input => ({ ...await fetchOriginal(input), files: fetched.files });
  const failed = await runResearchTask({ mode: 'current' }, f.deps);
  expect(failed.status).toBe('failed'); expect(f.calls.parse).toBe(1);
  f.failArchive(''); const result = await resumeResearchTask(failed.runId, { mode: 'current' }, f.deps);
  expect(result.status).toBe('awaiting_evidence'); expect(f.calls.parse).toBe(1); expect(f.calls.fetch).toEqual(['v1']);
  const archive = [...f.archives.values()][0];
  expect(archive.manifest.contentSha256).toBe(sha256('Full text\n'));
  expect(archive.files.has('metadata/pdf.json')).toBe(true);
});

test('fetch identity/content drift cannot create an archive or update counters', async () => {
  const f = await fixture(); const adapter = f.deps.adapters[0], original = adapter.fetch;
  adapter.fetch = async input => ({ ...await original(input), files: [{ path: 'content.md', contents: Buffer.from('Changed') }] });
  const result = await runResearchTask({ mode: 'current' }, f.deps);
  expect(result.status).toBe('failed'); expect(result.counters.archived).toBe(0); expect(f.calls.write).toEqual([]);
});

test('discovery failure reuses completed discovery batches and freezes only after all adapters finish', async () => {
  const f = await fixture(), adapter = f.deps.adapters[0], original = adapter.discover;
  let failedOnce = false;
  adapter.discover = async input => { if (input.track.id === 'tools' && !failedOnce) { failedOnce = true; throw new Error('discovery interrupted'); } return original(input); };
  const failed = await runResearchTask({ mode: 'current' }, f.deps); expect(failed.status).toBe('failed'); expect(f.calls.fetch).toEqual([]);
  const result = await resumeResearchTask(failed.runId, { mode: 'current' }, f.deps);
  expect(result.status).toBe('awaiting_evidence'); expect(result.counters.candidates).toBe(4); expect(f.calls.discover).toBe(2);
});

test('aborted research runs and wrong library kinds cannot invoke adapters or FSD paths', async () => {
  const f = await fixture(); f.deps.signal = AbortSignal.abort();
  expect((await runResearchTask({ mode: 'current' }, f.deps)).status).toBe('failed');
  expect(f.calls.discover).toBe(0); expect(f.calls.fetch).toEqual([]);
  await expect(runResearchTask({ mode: 'current' }, { ...f.deps, library: { kind: 'paper' } as never })).rejects.toThrow('UNSUPPORTED_LIBRARY_KIND');
});
