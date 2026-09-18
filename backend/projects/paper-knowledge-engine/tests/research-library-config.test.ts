import assert from 'node:assert/strict';
import { readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { listLibraries, loadEngineContext } from '../src/shared/engine-context.ts';
import { runConfiguredTask } from '../src/library/execution.ts';
import { runTask } from '../src/library/pipeline.ts';
import { configurationFiles } from '../src/shared/config-files.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import { deriveLibraryPaths } from '../src/shared/paths.ts';
import { captureOperationPolicy } from '../src/library/operations/operation-store.ts';
import { resolveArxivApiBase } from '../src/discovery/arxiv-transport.ts';
import { makeResearchFixture, researchFixtureId } from './helpers/research-library-fixture.ts';

const researchTrackIds = [
  'harness-control-loop', 'agent-loop', 'runtime-execution', 'tool-mcp', 'context-prompt',
  'memory-state-session', 'guardrails-policy', 'permissions-authorization',
  'identity-tenancy-governance', 'hitl-approval', 'sandbox-isolation', 'testing-evaluation',
  'agent-evaluation-methodology', 'tracing-observability', 'reliability-operations',
];

test('loads Agent Engineering as a paper library with all configured tracks', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId: 'agent-engineering' });

  assert.equal(context.library.kind, 'paper');
  assert.equal(context.library.libraryId, 'agent-engineering');
  assert.equal(context.library.displayName, 'Agent Engineering（Agent 工程知识库）');
  assert.deepEqual(context.library.tracks.map(track => track.id), researchTrackIds);
});
test('generic Research configuration admits the resolved arXiv API host before discovery', () => {
  const root = makeResearchFixture();
  try {
    const context = loadEngineContext({ root, libraryId: researchFixtureId });
    const library = context.library;
    if (library.kind !== 'research') throw new Error('expected research library');
    const apiHost = new URL(resolveArxivApiBase(context.machine.network?.arxivApiBase)).hostname;
    assert.ok(library.sourcePolicy.allowedDomains.includes(apiHost));
    assert.ok(library.tracks
      .filter(track => track.sourceKinds.some(kind => kind === 'paper' || kind === 'technical-report'))
      .every(track => track.domains.includes(apiHost)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects a Research configuration when the default arXiv API host is removed from its allowlist', () => {
  const root = makeResearchFixture();
  try {
    const machinePath = join(root, 'config', 'machine.local.yaml');
    const machine = YAML.parse(readFileSync(machinePath, 'utf8')) as Record<string, any>;
    const apiHost = new URL(resolveArxivApiBase(machine.network?.arxiv_api_base)).hostname;
    const path = join(root, 'config', researchFixtureId, 'source-policy.yaml');
    const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    raw.allowed_domains = raw.allowed_domains.filter((value: string) => value !== apiHost);
    writeFileSync(path, YAML.stringify(raw));
    const queryPath = join(root, 'config', researchFixtureId, 'query-matrix.yaml');
    const query = YAML.parse(readFileSync(queryPath, 'utf8')) as Record<string, any>;
    for (const track of query.tracks) track.domains = track.domains.filter((value: string) => value !== apiHost);
    writeFileSync(queryPath, YAML.stringify(query));
    assert.throws(
      () => loadEngineContext({ root, libraryId: researchFixtureId }),
      new RegExp(`INVALID_FIELD.*machine\\.local\\.yaml.*network\\.arxiv_api_base.*${apiHost}`),
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects a Research Track when it omits the resolved arXiv API host', () => {
  const root = makeResearchFixture();
  try {
    const machinePath = join(root, 'config', 'machine.local.yaml');
    const machine = YAML.parse(readFileSync(machinePath, 'utf8')) as Record<string, any>;
    const apiHost = new URL(resolveArxivApiBase(machine.network?.arxivApiBase)).hostname;
    const path = join(root, 'config', researchFixtureId, 'query-matrix.yaml');
    const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    raw.tracks[0].domains = raw.tracks[0].domains.filter((value: string) => value !== apiHost);
    writeFileSync(path, YAML.stringify(raw));
    assert.throws(
      () => loadEngineContext({ root, libraryId: researchFixtureId }),
      new RegExp(`INVALID_FIELD.*query-matrix\\.yaml.*tracks\\.0\\.domains.*arXiv API host ${apiHost}`),
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects an arXiv-enabled Research Track without configured arXiv categories', () => {
  const root = makeResearchFixture();
  try {
    const path = join(root, 'config', researchFixtureId, 'query-matrix.yaml');
    const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    raw.tracks[0].arxiv_categories = [];
    writeFileSync(path, YAML.stringify(raw));
    assert.throws(
      () => loadEngineContext({ root, libraryId: researchFixtureId }),
      /INVALID_FIELD.*query-matrix\.yaml.*tracks\.0\.arxiv_categories.*non-empty/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('requires an injected Research workflow before creating state', async () => {
  const root = makeResearchFixture();
  try {
    await assert.rejects(
      () => runConfiguredTask({ mode: 'current' }, root, { libraryId: researchFixtureId as never }),
      /RESEARCH_WORKFLOW_UNCONFIGURED/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects Research configurations at the paper task pipeline boundary', async () => {
  await assert.rejects(
    () => runTask({ mode: 'current', now: '2026-09-06T00:00:00.000Z' }, { config: { libraryKind: 'research' } } as never),
    /UNSUPPORTED_LIBRARY_KIND: research/,
  );
});

test('keeps the Agent paper configuration separate from generic Research configuration files', () => {
  const root = makeResearchFixture();
  try {
    const researchPath = join(root, 'config', researchFixtureId);
    unlinkSync(join(researchPath, 'source-policy.yaml'));
    assert.throws(() => loadEngineContext({ root, libraryId: researchFixtureId }), /MISSING_CONFIG.*source-policy\.yaml/);

    const paperFieldRoot = makeResearchFixture();
    try {
      const path = join(paperFieldRoot, 'config', researchFixtureId, 'library.yaml');
      const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      raw.paper_policy = {};
      writeFileSync(path, YAML.stringify(raw));
      assert.throws(() => loadEngineContext({ root: paperFieldRoot, libraryId: researchFixtureId }), /UNKNOWN_FIELD.*library\.yaml.*paper_policy/);
    } finally { rmSync(paperFieldRoot, { recursive: true, force: true }); }

    const paperFileRoot = makeResearchFixture();
    try {
      writeFileSync(join(paperFileRoot, 'config', researchFixtureId, 'paper-policy.yaml'), 'paper_policy: {}\n');
      assert.throws(() => loadEngineContext({ root: paperFileRoot, libraryId: researchFixtureId }), /UNKNOWN_FIELD.*paper-policy\.yaml/);
    } finally { rmSync(paperFileRoot, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('keeps active files, library listing, paths, and Evidence policies isolated by library kind', () => {
  const root = makeResearchFixture();
  try {
    const research = loadEngineContext({ root, libraryId: researchFixtureId });
    const paper = loadEngineContext({ root, libraryId: 'fsd' });
    assert.equal(paper.library.kind, 'paper');
    assert.deepEqual(listLibraries(root).map(library => library.libraryId), [
      'agent-context', 'agent-engineering', 'agent-memory', 'agent-tool', 'fsd', 'llm-post-training', 'multi-agent-engineering', researchFixtureId, 'skill-prompt-engineering',
    ]);
    assert.deepEqual(configurationFiles(researchFixtureId, 'research').slice(-4), [
      join(researchFixtureId, 'library.yaml'), join(researchFixtureId, 'query-matrix.yaml'),
      join(researchFixtureId, 'source-policy.yaml'), join(researchFixtureId, 'topic-taxonomy.yaml'),
    ]);
    assert.deepEqual(configurationFiles('agent-engineering', 'paper').slice(-4), [
      join('agent-engineering', 'library.yaml'), join('agent-engineering', 'query-matrix.yaml'),
      join('agent-engineering', 'paper-policy.yaml'), join('agent-engineering', 'categories.yaml'),
    ]);
    assert.deepEqual(configurationFiles('multi-agent-engineering', 'paper').slice(-4), [
      join('multi-agent-engineering', 'library.yaml'),
      join('multi-agent-engineering', 'query-matrix.yaml'),
      join('multi-agent-engineering', 'paper-policy.yaml'),
      join('multi-agent-engineering', 'categories.yaml'),
    ]);
    assert.match(captureOperationPolicy(root, asLibraryId(researchFixtureId)).collectionHash, /^[0-9a-f]{64}$/);
    assert.equal(research.paths.dataRoot, join(root, 'data-libraries', researchFixtureId));
    assert.notEqual(research.paths.dataRoot, paper.paths.dataRoot);
    assert.deepEqual(deriveLibraryPaths(research.machine, asLibraryId(researchFixtureId)), research.paths);
    assert.deepEqual(research.engine.researchEvidence, {
      schemaVersion: 1, root: 'Evidence', sourceRoot: 'sources',
      indexRoots: {
        topics: 'indexes/topics.md', sourceTypes: 'indexes/source-types.md',
        lifecycles: 'indexes/lifecycles.md', concepts: 'indexes/concepts.md',
      }, publisherVersion: 1,
    });
    assert.equal(paper.engine.evidence.schemaVersion, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('validates Research task limits, tracks, source policy, and taxonomy as closed contracts', () => {
  const cases: Array<{ path: string; mutate: (value: Record<string, any>) => void; error: RegExp }> = [
    {
      path: 'library.yaml',
      mutate: value => { value.current_task.max_papers = 1; },
      error: /UNKNOWN_FIELD.*library\.yaml.*current_task\.max_papers/,
    },
    {
      path: 'query-matrix.yaml',
      mutate: value => { value.tracks[1].id = value.tracks[0].id; },
      error: /INVALID_FIELD.*query-matrix\.yaml.*tracks/,
    },
    {
      path: 'source-policy.yaml',
      mutate: value => { value.date_lower_bound = '2025-12-31'; },
      error: /INVALID_FIELD.*source-policy\.yaml.*date_lower_bound/,
    },
    {
      path: 'topic-taxonomy.yaml',
      mutate: value => { value.lifecycles = []; },
      error: /INVALID_FIELD.*topic-taxonomy\.yaml.*lifecycles/,
    },
  ];
  for (const item of cases) {
    const root = makeResearchFixture();
    try {
      const path = join(root, 'config', researchFixtureId, item.path);
      const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, any>;
      item.mutate(raw);
      writeFileSync(path, YAML.stringify(raw));
      assert.throws(() => loadEngineContext({ root, libraryId: researchFixtureId }), item.error);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('rejects Research Track domains outside the source-policy allowlist', () => {
  const root = makeResearchFixture();
  try {
    const path = join(root, 'config', researchFixtureId, 'query-matrix.yaml');
    const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    raw.tracks[0].domains[0] = 'unapproved-public.example';
    writeFileSync(path, YAML.stringify(raw));

    assert.throws(
      () => loadEngineContext({ root, libraryId: researchFixtureId }),
      /INVALID_FIELD.*query-matrix\.yaml.*tracks\.0\.domains\.0.*source_policy\.allowed_domains/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
