import type { PaperMetadata } from '../src/types/papers.ts';
import type { PaperPolicy } from '../src/types/config.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTrackReachability, evaluateCandidate as evaluateSource } from '../src/library/selection/paper-policy.ts';
import { loadPaperPolicy } from '../src/shared/config.ts';
import { runHarvestShards } from '../src/discovery/opencli-runner.ts';

const productionPolicy = loadPaperPolicy('config/fsd/paper-policy.yaml');
const evaluateCandidate = <P extends PaperMetadata>(paper: P, policy: Partial<PaperPolicy>) => evaluateSource({ baseId: '2608.99999', arxivId: '2608.99999v1', version: 1, ...paper }, policy);

const rules = { startDate: '2026-01-01', excludedDomains: ['autonomous driving'], trackPriority: ['AI-TDD', '99-Unclassified'], aiTechniqueTerms: ['llm'], programStructureTerms: ['ast'], engineeringTaskTerms: ['code2doc', 'tdd'] };
const paper = ({ ai = [], structures = [], tasks = [] }: { ai?: string[]; structures?: string[]; tasks?: string[] }) => ({
  title: 'Software migration', summary: [...ai, ...structures, ...tasks].join(' '), published: '2026-02-01T00:00:00Z', updated: '2026-02-01T00:00:00Z',
  submittedAt: '2026-02-01', hasImportant2026Version: false,
  aiTechniques: ai, programStructures: structures,
  engineeringTasks: tasks, normalizedText: 'software migration', matchedTracks: ['AI-TDD'],
});

test('production priority contains only quota-backed harvest tracks', () => {
  assert.deepEqual(productionPolicy.trackPriority, [
    'AI-FSD', 'LLM-Wiki', 'AI-TDD', 'AI-DDD',
    'AI-Program-Analysis-AST', 'Code-Translation', 'Verification', 'Evaluation',
  ]);
});

test('accepts reachable active tracks while allowing historical category mappings', () => {
  assert.doesNotThrow(() => assertTrackReachability({
    plan: { tracks: ['A', 'B'] },
    rules: { trackPriority: ['B', 'A'] },
    trackLimits: { A: 2, B: 1 },
    categories: { tracks: { A: {}, B: {}, Historical: {} } },
  }));
});

test('rejects drift between plan, policy priority, and quota tracks', () => {
  const aligned = {
    plan: { tracks: ['A', 'B'] },
    rules: { trackPriority: ['A', 'B'] },
    trackLimits: { A: 2, B: 1 },
    categories: { tracks: { A: {}, B: {} } },
  };
  assert.throws(
    () => assertTrackReachability({ ...aligned, rules: { trackPriority: ['A', 'C'] } }),
    /plan, policy priority, and quota tracks must exactly match/,
  );
  assert.throws(
    () => assertTrackReachability({ ...aligned, plan: { tracks: ['A'] } }),
    /plan, policy priority, and quota tracks must exactly match/,
  );
});

test('rejects an active track without a category mapping', () => {
  assert.throws(() => assertTrackReachability({
    plan: { tracks: ['A', 'B'] },
    rules: { trackPriority: ['A', 'B'] },
    trackLimits: { A: 2, B: 1 },
    categories: { tracks: { A: {} } },
  }), /categories must contain every active track: B/);
});

test('production snake-case policy automatically accepts a matching candidate', () => {
  const decision = evaluateCandidate({
    baseId: '2608.99999',
    arxivId: '2608.99999v1',
    version: 1,
    title: 'Large language model for legacy modernization',
    summary: 'Repository understanding and test generation with behavior preservation',
    published: '2026-08-01T00:00:00Z',
    updated: '2026-08-01T00:00:00Z',
    matchedTracks: ['AI-FSD'],
  }, productionPolicy);
  assert.equal(decision.status, 'accepted');
  assert.equal(decision.signals.technologyMatched, true);
  assert.equal(decision.signals.taskMatched, true);
});

test('ambiguous AI words supply no technology signal and are rejected', () => {
  const decision = evaluateCandidate({
    baseId: '2608.99998',
    arxivId: '2608.99998v1',
    version: 1,
    title: 'Model-driven agent skills and repository wiki maintenance',
    summary: 'A repository documentation workflow without a concrete implementation technique',
    published: '2026-08-01T00:00:00Z',
    updated: '2026-08-01T00:00:00Z',
    matchedTracks: ['LLM-Wiki'],
  }, productionPolicy);
  assert.equal(decision.accepted, false);
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.signals.technologyMatched, false);
});

for (const [title, ai, tasks] of [
  ['Large language models for test generation', 'large language model', 'test generation'],
  ['LLMs for test generation', 'llm', 'test generation'],
  ['Coding agents for repository benchmarks', 'coding agent', 'repository benchmark'],
  ['Large-language-models for test-generation', 'large language model', 'test generation'],
  ['Large\nlanguage models for test\ngeneration', 'large language model', 'test generation'],
  ['LLMs recovering business rules and bounded contexts', 'llm', 'business rule'],
  ['LLMs for implicit-requirement recovery', 'llm', 'requirements recovery'],
]) {
  test(`recognizes equivalent word forms: ${title.replaceAll('\n', ' ')}`, () => {
    const result = evaluateCandidate({ title, summary: '', published: '2026-08-01', matchedTracks: ['AI-TDD'] }, productionPolicy);
    assert.equal(result.status, 'accepted');
    assert.ok(result.paper.aiTechniques.includes(ai));
    assert.ok(result.paper.engineeringTasks.includes(tasks));
  });
}

test('recognizes configured program-structure plurals without adding an AI requirement', () => {
  const result = evaluateCandidate({ title: 'Abstract syntax trees for specification recovery', published: '2026-08-01', matchedTracks: ['AI-Program-Analysis-AST'] }, productionPolicy);
  assert.equal(result.status, 'accepted');
  assert.equal(result.signals.lane, 'program-analysis');
  assert.deepEqual(result.paper.programStructures, ['abstract syntax tree']);
});

test('word-form handling preserves signal boundaries and hard date/domain exclusions', () => {
  for (const title of ['Rags and irs for test generation', 'Smallmodel and llama for test generation']) {
    const result = evaluateCandidate({ title, published: '2026-08-01' }, productionPolicy);
    assert.equal(result.status, 'rejected');
    assert.equal(result.signals.technologyMatched, false);
  }
  assert.equal(evaluateCandidate({ title: 'LLMs for image synthesis', published: '2026-08-01' }, productionPolicy).signals.taskMatched, false);
  for (const title of ['LLMs for test generation in autonomous driving',
    'LLMs for test-generation in autonomous-driving', 'LLMs for test generation in autonomous\ndriving',
    'LLMs for test generation in autonomous   driving']) {
    assert.equal(evaluateCandidate({ title, published: '2026-08-01', matchedTracks: ['AI-TDD'] }, productionPolicy).status, 'rejected', title);
  }
  assert.equal(evaluateCandidate({ title: 'LLMs for test generation', published: '2025-01-01', updated: '2025-01-01', matchedTracks: ['AI-TDD'] }, productionPolicy).status, 'rejected');
});

test('equivalent forms come from configured variants, not broad stemming or synonyms', () => {
  const input = { title: 'LLMs for code2doc', published: '2026-08-01', matchedTracks: ['AI-TDD'] };
  assert.equal(evaluateCandidate(input, { ...rules, termVariants: { llm: ['llms'] } }).signals.technologyMatched, true);
  assert.equal(evaluateCandidate(input, { ...rules, termVariants: {} }).signals.technologyMatched, false);
});

test('accepts both technology lanes and assigns an active primary track', () => {
  const candidate = evaluateCandidate(paper({ ai: ['LLM'], tasks: ['Code2Doc'] }), rules);
  assert.equal(candidate.status, 'accepted');
  assert.equal(candidate.primaryTrack, 'AI-TDD');
  assert.equal(candidate.lane, 'ai');
  assert.equal(candidate.signals.lane, 'ai');
  assert.equal(evaluateCandidate(paper({ structures: ['AST'], tasks: ['TDD'] }), rules).signals.lane, 'program-analysis');
  assert.equal(evaluateCandidate(paper({ structures: ['AST'], tasks: [] }), rules).signals.taskMatched, false);
});

test('rejects papers before the start date unless an important 2026 version exists', () => {
  const old = paper({ ai: ['LLM'], tasks: ['Code2Doc'] });
  old.published = '2025-12-31';
  old.updated = '2025-12-31';
  assert.equal(evaluateCandidate(old, rules).status, 'rejected');
  old.updated = '2026-02-01';
  assert.equal(evaluateCandidate(old, rules).status, 'accepted');
});

test('runner passes each date mode to OpenCLI and merges matched tracks', async () => {
  const calls: string[][] = [];
  const papers = await runHarvestShards([
    { track: 'AI-TDD', dateMode: 'submitted', query: 'all:test', categories: ['cs.SE'] },
    { track: 'Verification', dateMode: 'updated', query: 'all:test', categories: ['cs.SE'] },
  ], { from: '2026-01-01T00:00:00Z', to: '2026-01-07T00:00:00Z' }, {
  pageSize: 100,
  requestIntervalMs: 3100,
  sleep: async () => undefined,
    execFile: async (_file: string, args: string[]) => {
      calls.push(args);
      const dateMode = args[args.indexOf('--date-mode') + 1];
      return { stdout: JSON.stringify({ schemaVersion: 1, dateMode, papers: [{ arxivId: '2601.1v1', baseId: '2601.1', version: 1, title: 'T', summary: 'S', published: '2026-01-02T00:00:00Z', updated: '2026-01-02T00:00:00Z', categories: ['cs.SE'], pdfUrl: 'https://arxiv.org/pdf/2601.1v1' }] }) };
    },
  });
  assert.deepEqual(calls.map((args) => args[args.indexOf('--date-mode') + 1]), ['submitted', 'updated']);
  assert.deepEqual(papers[0].matchedTracks, ['AI-TDD', 'Verification']);
  assert.deepEqual(papers[0].dateModes, ['submitted', 'updated']);
});

test('runner also accepts OpenCLI table rows returned as a raw JSON array', async () => {
  const papers = await runHarvestShards([{ track: 'AI-TDD', dateMode: 'submitted', query: 'all:test', categories: ['cs.SE'] }], { from: '2026-01-01', to: '2026-01-07' }, {
    requestIntervalMs: 3100,
    sleep: async () => undefined,
    execFile: async () => ({ stdout: JSON.stringify([{ arxivId: '2601.1v1', baseId: '2601.1', version: 1, title: 'T', summary: 'S', published: '2026-01-02T00:00:00Z', updated: '2026-01-02T00:00:00Z', categories: ['cs.SE'], pdfUrl: 'https://arxiv.org/pdf/2601.1v1' }]) }),
  });
  assert.equal(papers[0].baseId, '2601.1');
});
