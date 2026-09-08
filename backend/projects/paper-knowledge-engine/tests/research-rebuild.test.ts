import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import type { ResearchLibraryConfig, ResearchSourceKind } from '../src/types/config.ts';
import type { FetchedSource, ResearchCandidate, SourceVersion } from '../src/types/research-sources.ts';
import type { SourceDiscoveryAdapter } from '../src/research/adapters/types.ts';
import { fetchScope } from '../src/research/adapters/types.ts';
import { sourceIdentity, sha256 } from '../src/research/source-identity.ts';
import { runResearchTask, resumeResearchTask, type ResearchWorkflowDependencies } from '../src/research/research-workflow.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { readVerifiedResearchArchive, writeResearchArchive } from '../src/research/source-archive.ts';
import { publishResearchEvidence, type ResearchEvidencePublicationStore } from '../src/evidence/source-publisher.ts';
import { renderResearchIndexes, renderResearchSourceEvidence } from '../src/evidence/render-source.ts';
import { makeResearchFixture, researchFixtureId } from './helpers/research-library-fixture.ts';

const roots: string[] = [];
afterEach(async () => {
  delete process.env.RESEARCH_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function researchLibrary(): ResearchLibraryConfig {
  const configRoot = makeResearchFixture();
  roots.push(configRoot);
  const loaded = loadEngineContext({ root: configRoot, libraryId: researchFixtureId }).library as ResearchLibraryConfig;
  const tracks = loaded.tracks.filter(track => ['harness-control-loop', 'agent-loop', 'context-prompt', 'runtime-execution'].includes(track.id));
  return { ...loaded, tracks, currentTask: {
    maxSources: 10,
    trackLimits: Object.fromEntries(tracks.map(track => [track.id, 10])),
    sourceKindLimits: { 'official-doc': 10, repository: 10 },
  } };
}

function record(input: { kind: ResearchSourceKind; url: string; version: string; content: string; track: string; commit?: string }): { candidate: ResearchCandidate; fetched: FetchedSource } {
  const contentSha256 = sha256(input.content);
  const identity = sourceIdentity({ kind: input.kind, canonicalUrl: input.url, contentSha256,
    ...(input.kind === 'repository' ? { commit: input.commit ?? input.version } : { revision: input.version }) });
  const source = { sourceId: identity.sourceId, identityKey: identity.identityKey, kind: input.kind, canonicalUrl: identity.canonicalUrl,
    title: `${input.kind} ${input.version}`, publisher: new URL(identity.canonicalUrl).hostname, authors: [], primaryTrack: input.track, secondaryTracks: [], dimensions: {} };
  const version: SourceVersion = { sourceId: source.sourceId, versionId: identity.versionId, versionLabel: identity.versionId,
    publishedAt: null, updatedAt: '2026-03-01T00:00:00.000Z', releasedAt: null, retrievedAt: '2026-09-07T00:00:00.000Z',
    contentSha256, archivePath: '', provenance: { adapter: 'rebuild-fixture', urls: [identity.canonicalUrl] } };
  return {
    candidate: { source, version, matchedTracks: [input.track], dateMatches: ['updated'], discoveryAdapter: 'rebuild-fixture' },
    fetched: { source, version, files: [{ path: 'content.md', contents: Buffer.from(input.content) }], locators: [{ artifactPath: 'content.md', section: input.version }] },
  };
}

function adapterFor(records: readonly { candidate: ResearchCandidate; fetched: FetchedSource }[], options: {
  discover?: (track: string, records: readonly { candidate: ResearchCandidate; fetched: FetchedSource }[]) => readonly ResearchCandidate[];
  onDiscover?: () => void;
  onFetch?: () => void;
} = {}): SourceDiscoveryAdapter {
  const byVersion = new Map(records.map(item => [`${item.candidate.source.sourceId}/${item.candidate.version.versionId}`, item]));
  const adapter: SourceDiscoveryAdapter = {
    id: 'rebuild-fixture',
    kinds: ['official-doc', 'repository'],
    async discover(input) {
      options.onDiscover?.();
      const selected = options.discover?.(input.track.id, records) ?? records.filter(item => item.candidate.source.primaryTrack === input.track.id).map(item => item.candidate);
      return selected.map(candidate => ({ ...candidate, matchedTracks: [input.track.id] }));
    },
    async fetch(input) {
      fetchScope(input, adapter);
      options.onFetch?.();
      const value = byVersion.get(`${input.candidate.source.sourceId}/${input.candidate.version.versionId}`);
      if (!value) throw new Error('rebuild fixture source missing');
      const fetched = structuredClone(value.fetched);
      return { ...fetched, source: input.candidate.source, version: input.candidate.version };
    },
  };
  return adapter;
}

async function filesUnder(root: string, prefix = ''): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [path, bytes] of await filesUnder(root, relative)) result.set(path, bytes);
    } else if (entry.isFile()) result.set(relative.replaceAll('\\', '/'), await readFile(join(root, relative)));
  }
  return result;
}

test('source/version replay keeps duplicate Track hits and revisions separate while Evidence rebuild stays byte-identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-rebuild-')); roots.push(root);
  const stateRoot = join(root, 'state'); await mkdir(stateRoot, { recursive: true });
  const library = researchLibrary();
  const docV1 = record({ kind: 'official-doc', url: 'https://openai.com/docs/agents', version: 'r1', track: 'harness-control-loop', content: 'Agent harness v1\n' });
  const docV2 = record({ kind: 'official-doc', url: 'https://openai.com/docs/agents', version: 'r2', track: 'context-prompt', content: 'Agent harness v2\n' });
  const commit1 = 'b'.repeat(40), commit2 = 'c'.repeat(40);
  const repoV1 = record({ kind: 'repository', url: 'https://github.com/example/agent-runtime', version: commit1, commit: commit1, track: 'runtime-execution', content: 'commit one\n' });
  const repoV2 = record({ kind: 'repository', url: 'https://github.com/example/agent-runtime', version: commit2, commit: commit2, track: 'runtime-execution', content: 'commit two\n' });
  const records = [docV1, docV2, repoV1, repoV2];
  const store = openStateStore(join(stateRoot, 'library.sqlite'));
  try {
    const result = await runResearchTask({ mode: 'current' }, {
      library, stateRoot, store, adapters: [adapterFor(records, {
        discover(track) {
          if (track === 'harness-control-loop' || track === 'agent-loop') return [docV1.candidate];
          if (track === 'context-prompt') return [docV2.candidate];
          if (track === 'runtime-execution') return [repoV1.candidate, repoV2.candidate];
          return [];
        },
      })],
      now: () => '2026-09-07T12:00:00.000Z',
      publish: async input => {
        await publishResearchEvidence({ runId: input.runId, stateRoot, tempRoot: join(root, 'work'), vaultRoot: join(root, 'vault'),
          store: input.store as unknown as ResearchEvidencePublicationStore, selectionHash: input.selectionHash, archives: input.archives,
          now: () => '2026-09-07T12:00:00.000Z' });
      },
    });
    expect(result).toMatchObject({ status: 'completed', counters: { candidates: 5, accepted: 4, newVersions: 4, archived: 4, published: 4 } });
    const sources = store.listResearchSources(), versions = store.listAllResearchSourceVersions();
    expect(sources).toHaveLength(2);
    expect(versions.map(version => version.versionId).sort()).toEqual([commit1, commit2, 'r1', 'r2'].sort());
    expect(sources.find(source => source.kind === 'official-doc')?.secondaryTracks).toContain('agent-loop');
    expect(store.getLastSuccess()).toBe(result.window.to);

    const vault = join(root, 'vault');
    const published = await filesUnder(vault);
    const archives = await Promise.all(versions.map(version => readVerifiedResearchArchive(join(stateRoot, version.archivePath))));
    const rendered = [
      ...(await Promise.all(archives.map(archive => renderResearchSourceEvidence({ archive, evidenceRoot: join(root, 'rebuilt') })))).flat(),
      ...(await renderResearchIndexes({ sources: archives })),
    ];
    const rebuild = join(root, 'rebuilt');
    for (const file of rendered) {
      const path = join(rebuild, file.path);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, file.bytes);
    }
    const rebuilt = await filesUnder(rebuild);
    expect([...rebuilt.keys()].sort()).toEqual([...published.keys()].sort());
    for (const [path, bytes] of published) expect(rebuilt.get(path)).toEqual(bytes);
  } finally {
    store.close();
  }
});

type RecoveryPhase = 'discovery' | 'selection' | 'fetch' | 'archive' | 'publish';

async function recoveryRun(phase: RecoveryPhase): Promise<{ first: Awaited<ReturnType<typeof runResearchTask>>; resumed: Awaited<ReturnType<typeof resumeResearchTask>>; fetchCalls: number; initialFetchCalls: number; discoverCalls: number; initialDiscoverCalls: number; selectionHash: string }> {
  const root = await mkdtemp(join(tmpdir(), `research-recovery-${phase}-`)); roots.push(root);
  const stateRoot = join(root, 'state'); await mkdir(stateRoot, { recursive: true });
  const library = researchLibrary();
  const source = record({ kind: 'official-doc', url: 'https://openai.com/docs/recovery', version: 'r1', track: 'harness-control-loop', content: 'Recovery source\n' });
  let discoverCalls = 0, fetchCalls = 0, failed = false;
  const controller = new AbortController();
  const adapter = adapterFor([source], {
    onDiscover: () => {
      discoverCalls++;
      if (phase === 'discovery' && !failed) { failed = true; throw new Error('discovery interruption'); }
      if (phase === 'selection' && !failed) { failed = true; controller.abort(); }
    },
    onFetch: () => {
      fetchCalls++;
      if (phase === 'fetch' && !failed) { failed = true; throw new Error('fetch interruption'); }
    },
  });
  const store = openStateStore(join(stateRoot, 'library.sqlite'));
  const archive = {
    write: async (input: Parameters<typeof writeResearchArchive>[0]) => {
      if (phase === 'archive' && !failed) { failed = true; throw new Error('archive interruption'); }
      return writeResearchArchive(input);
    },
    read: readVerifiedResearchArchive,
  };
  const makeDependencies = (signal?: AbortSignal): ResearchWorkflowDependencies => ({
    library, stateRoot, store, adapters: [adapter], archive,
    ...(signal === undefined ? {} : { signal }),
    now: () => '2026-09-07T12:00:00.000Z',
    ...(phase === 'publish' ? { publish: async input => {
      await publishResearchEvidence({ runId: input.runId, stateRoot, tempRoot: join(root, 'work'), vaultRoot: join(root, 'vault'),
        store: input.store as unknown as ResearchEvidencePublicationStore, selectionHash: input.selectionHash, archives: input.archives,
        now: () => '2026-09-07T12:00:00.000Z' });
    } } : {}),
  });
  try {
    if (phase === 'publish') process.env.RESEARCH_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL = '1';
    const first = await runResearchTask({ mode: 'current' }, makeDependencies(phase === 'selection' ? controller.signal : undefined));
    expect(first.status).toBe('failed');
    const selectionPath = join(stateRoot, 'runs', first.runId, 'selection.sha256');
    const selectionHash = await readFile(selectionPath, 'utf8').catch(() => '');
    const initialDiscoverCalls = discoverCalls, initialFetchCalls = fetchCalls;
    delete process.env.RESEARCH_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL;
    const resumed = await resumeResearchTask(first.runId, { mode: 'current' }, makeDependencies());
    expect(resumed.runId).toBe(first.runId);
    const resumedSelectionHash = await readFile(selectionPath, 'utf8');
    if (selectionHash) expect(resumedSelectionHash).toBe(selectionHash);
    else expect(resumedSelectionHash).toMatch(/^[a-f0-9]{64}$/);
    if (phase === 'publish') expect(resumed.status).toBe('completed');
    else expect(resumed.status).toBe('awaiting_evidence');
    return { first, resumed, fetchCalls, initialFetchCalls, discoverCalls, initialDiscoverCalls, selectionHash };
  } finally {
    store.close();
  }
}

test('discovery, selection, fetch, archive and publish interruptions resume from fixed checkpoints', async () => {
  const discovery = await recoveryRun('discovery');
  expect(discovery.discoverCalls).toBeGreaterThan(discovery.initialDiscoverCalls);
  expect(discovery.selectionHash).toBe('');

  const selection = await recoveryRun('selection');
  expect(selection.discoverCalls).toBe(selection.initialDiscoverCalls);
  expect(selection.selectionHash).toMatch(/^[a-f0-9]{64}$/);

  const fetch = await recoveryRun('fetch');
  expect(fetch.fetchCalls).toBeGreaterThan(fetch.initialFetchCalls);
  expect(fetch.selectionHash).toMatch(/^[a-f0-9]{64}$/);

  const archive = await recoveryRun('archive');
  expect(archive.fetchCalls).toBe(archive.initialFetchCalls);
  expect(archive.selectionHash).toMatch(/^[a-f0-9]{64}$/);

  const publish = await recoveryRun('publish');
  expect(publish.fetchCalls).toBe(publish.initialFetchCalls);
  expect(publish.selectionHash).toMatch(/^[a-f0-9]{64}$/);
});
