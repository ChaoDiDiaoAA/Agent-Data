import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { isResearchLibrary, type ResearchLibraryConfig, type ResearchSourceKind } from '../src/types/config.ts';
import type { FetchedSource, ResearchCandidate, SourceVersion } from '../src/types/research-sources.ts';
import type { SourceDiscoveryAdapter } from '../src/research/adapters/types.ts';
import { fetchScope } from '../src/research/adapters/types.ts';
import { sourceIdentity, sha256 } from '../src/research/source-identity.ts';
import { runResearchTask } from '../src/research/research-workflow.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { writeResearchArchive } from '../src/research/source-archive.ts';
import { publishResearchEvidence, type ResearchEvidencePublicationStore } from '../src/evidence/source-publisher.ts';
import { canonicalJson } from '../src/shared/manifest.ts';
import { makeResearchFixture, researchFixtureId } from './helpers/research-library-fixture.ts';

const roots: string[] = [];
const fixtureRoot = resolve(process.cwd(), 'tests/fixtures/research-sources');

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type FixtureRecord = { candidate: ResearchCandidate; fetched: FetchedSource };

async function fixtureText(path: string): Promise<string> {
  return readFile(join(fixtureRoot, path), 'utf8');
}

function sourceFor(input: {
  kind: ResearchSourceKind;
  url: string;
  content: string;
  revision?: string;
  commit?: string;
  tag?: string;
  track: string;
  title: string;
}): FixtureRecord {
  const contentSha256 = sha256(input.content);
  const identity = sourceIdentity({ kind: input.kind, canonicalUrl: input.url, contentSha256,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    ...(input.commit === undefined ? {} : { commit: input.commit }),
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    ...(input.kind === 'paper' ? { arxivId: '2601.00001v1' } : {}) });
  const dimensions = {
    lifecycles: ['model-invocation'],
    controlBoundaries: ['execution'],
    evidenceLevel: 'official-specification-or-source',
    testingLevels: ['integration'],
    ...(input.kind === 'evaluation-method' ? { evaluation: { objects: ['agent-loop'], units: ['trajectory'], adjudicators: ['human'], metrics: ['reliability'], replayStrategies: ['trace-replay'] } } : {}),
  };
  const source = {
    sourceId: identity.sourceId,
    identityKey: identity.identityKey,
    kind: input.kind,
    canonicalUrl: identity.canonicalUrl,
    title: input.title,
    publisher: input.url ? new URL(identity.canonicalUrl).hostname : null,
    authors: [],
    primaryTrack: input.track,
    secondaryTracks: [],
    dimensions,
  };
  const version: SourceVersion = {
    sourceId: source.sourceId,
    versionId: identity.versionId,
    versionLabel: identity.versionId,
    publishedAt: input.kind === 'paper' ? '2026-02-01T00:00:00.000Z' : null,
    updatedAt: input.kind === 'paper' || input.kind === 'release' ? null : '2026-03-01T00:00:00.000Z',
    releasedAt: input.kind === 'release' ? '2026-04-01T00:00:00.000Z' : null,
    retrievedAt: '2026-09-07T00:00:00.000Z',
    contentSha256,
    archivePath: '',
    provenance: { adapter: 'fixture', urls: input.url ? [identity.canonicalUrl] : [] },
  };
  const files = [{ path: 'content.md', contents: Buffer.from(input.content) } as { path: string; contents: Uint8Array }];
  return {
    candidate: { source, version, matchedTracks: [input.track], dateMatches: input.kind === 'paper' ? ['published'] : input.kind === 'release' ? ['released'] : ['updated'], discoveryAdapter: 'fixture' },
    fetched: { source, version, files, locators: [{ artifactPath: 'content.md', section: input.title }] },
  };
}

async function makeRecords(): Promise<FixtureRecord[]> {
  const paper = sourceFor({ kind: 'paper', url: 'https://arxiv.org/abs/2601.00001v1', track: 'harness-control-loop', title: 'A deterministic agent loop', content: 'A deterministic paper source\n' });
  const paperFetched: FetchedSource = { ...paper.fetched, files: [
    { path: 'content.md', contents: Buffer.from('A deterministic paper source\n') },
    { path: 'source.pdf', contents: await readFile(join(fixtureRoot, 'arxiv-paper.pdf')) },
    { path: 'metadata/arxiv.json', contents: Buffer.from(canonicalJson(JSON.parse(await fixtureText('arxiv-paper-metadata.json')))) },
  ] };
  const official = sourceFor({ kind: 'official-doc', url: 'https://openai.com/docs/agents', revision: 'r1', track: 'harness-control-loop', title: 'Agent harness control', content: await fixtureText('official-doc.html') });
  const specification = sourceFor({ kind: 'specification', url: 'https://modelcontextprotocol.io/specification', revision: '2026-06', track: 'tool-mcp', title: 'Tool and MCP specification', content: await fixtureText('specification.md') });
  const repository = sourceFor({ kind: 'repository', url: 'https://github.com/example/agent-harness', commit: 'a'.repeat(40), track: 'runtime-execution', title: 'Agent harness repository', content: await fixtureText('fake-repository/commit.txt') });
  const release = sourceFor({ kind: 'release', url: 'https://github.com/example/agent-runtime', tag: 'v1.0.0', track: 'reliability-operations', title: 'Agent runtime release', content: await fixtureText('release.json') });
  const evaluation = sourceFor({ kind: 'evaluation-method', url: 'https://openai.com/research/agent-evaluation', revision: 'r1', track: 'agent-evaluation-methodology', title: 'Agent evaluation methodology', content: await fixtureText('evaluation-method.md') });
  return [{ ...paper, fetched: paperFetched }, official, specification, repository, release, evaluation];
}

function fixtureAdapter(records: readonly FixtureRecord[]): SourceDiscoveryAdapter {
  const bySource = new Map(records.map(record => [record.candidate.source.sourceId, record]));
  const adapter: SourceDiscoveryAdapter = {
    id: 'fixture',
    kinds: ['paper', 'official-doc', 'specification', 'repository', 'release', 'evaluation-method'],
    async discover(input) {
      const matching = records.filter(record => {
        const source = record.candidate.source;
        if (source.kind === 'official-doc') return input.track.id === 'harness-control-loop' || input.track.id === 'agent-loop';
        return source.primaryTrack === input.track.id;
      });
      return matching.map(record => ({ ...record.candidate, matchedTracks: [input.track.id] }));
    },
    async fetch(input) {
      fetchScope(input, adapter);
      const record = bySource.get(input.candidate.source.sourceId);
      if (!record) throw new Error('fixture source missing');
      const fetched = structuredClone(record.fetched);
      return { ...fetched, source: input.candidate.source, version: input.candidate.version };
    },
  };
  return adapter;
}

test('research current run integrates six source kinds, multi-Track dedupe, generic Archive and Evidence', async () => {
  const configRoot = makeResearchFixture();
  roots.push(configRoot);
  const engine = loadEngineContext({ root: configRoot, libraryId: researchFixtureId });
  expect(isResearchLibrary(engine.library)).toBe(true);
  const library = engine.library as ResearchLibraryConfig;
  expect(library.tracks).toHaveLength(15);

  const ownedRoot = await mkdtemp(join(tmpdir(), 'research-e2e-'));
  roots.push(ownedRoot);
  const stateRoot = join(ownedRoot, researchFixtureId);
  await mkdir(stateRoot, { recursive: true });
  const records = await makeRecords();
  const store = openStateStore(join(stateRoot, 'library.sqlite'));
  try {
    const result = await runResearchTask({ mode: 'current' }, {
      library,
      stateRoot,
      store,
      adapters: [fixtureAdapter(records)],
      fullTextKinds: ['paper'],
      mineru: { async parse(input) {
        expect(input.pdf[0]).toBe(0x25);
        return { markdown: 'Parsed deterministic paper text\n', pages: [{ page: 1, startLine: 1, endLine: 1 }] };
      } },
      now: () => '2026-09-07T12:00:00.000Z',
      publish: async input => {
        await publishResearchEvidence({ runId: input.runId, stateRoot, tempRoot: join(ownedRoot, 'work'), vaultRoot: join(ownedRoot, 'vault'),
          store: input.store as unknown as ResearchEvidencePublicationStore, selectionHash: input.selectionHash, archives: input.archives,
          now: () => '2026-09-07T12:00:00.000Z' });
      },
    });

    expect(result).toMatchObject({ status: 'completed', mode: 'current', resumed: false,
      counters: { candidates: 7, accepted: 6, newVersions: 6, archived: 6, published: 6 } });
    const sources = store.listResearchSources();
    const versions = store.listAllResearchSourceVersions();
    expect(sources).toHaveLength(6);
    expect(versions).toHaveLength(6);
    expect(sources.find(source => source.kind === 'official-doc')?.secondaryTracks).toContain('agent-loop');
    expect(new Set(sources.map(source => source.sourceId)).size).toBe(6);
    expect(new Set(versions.map(version => `${version.sourceId}/${version.versionId}`)).size).toBe(6);

    const sourceKinds = await readdir(join(stateRoot, 'archive', 'sources'));
    expect(sourceKinds.sort()).toEqual(['evaluation-method', 'official-doc', 'paper', 'release', 'repository', 'specification']);
    const evidenceRoot = join(ownedRoot, 'vault', 'Evidence');
    expect(await readdir(join(evidenceRoot, 'sources'))).toEqual(sourceKinds);
    expect(await stat(join(evidenceRoot, 'indexes', 'topics.md'))).toBeTruthy();
    expect(await stat(join(stateRoot, 'runs', result.runId, 'evidence', 'source-publication.json'))).toBeTruthy();
    await expect(stat(join(evidenceRoot, 'papers'))).rejects.toThrow();
    await expect(stat(join(ownedRoot, 'vault', 'Knowledge'))).rejects.toThrow();
  } finally {
    store.close();
  }
});
