import type { HarvestShard, PaperMetadata } from '../src/types/papers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { loadConfig, loadPaperPolicy } from '../src/shared/config.ts';
import { buildHarvestPlan } from '../src/discovery/harvest-plan.ts';
import { evaluateCandidate } from '../src/library/selection/paper-policy.ts';

const matrix = YAML.parse(readFileSync('config/fsd/query-matrix.yaml', 'utf8'));
const config = loadConfig({ root: process.cwd() });
const plan = buildHarvestPlan({ matrix, trackLimits: config.currentTask.trackLimits, arxiv: config.arxiv });
const rules = loadPaperPolicy('config/fsd/paper-policy.yaml');

// Independent Boolean witnesses for our flat AND-of-OR recipes, not an arXiv
// stemmer or ranking emulator. Live API checks separately verify real retrieval.
function matchesRecipe(shard: HarvestShard, paper: PaperMetadata & { categories: string[] }) {
  const groups = shard.query.split(' AND ').map(group => {
    assert.match(group, /^all:\([^()]+\)$/);
    return group.slice(5, -1).split(' OR ').map(term => term.replace(/^"|"$/g, '').toLowerCase());
  });
  const text = `${paper.title ?? ''} ${paper.summary ?? ''}`.toLowerCase();
  return shard.categories.some(category => paper.categories.includes(category))
    && groups.every(group => group.some(term => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`).test(text);
    }));
}

const input = (title: string, extra: Partial<PaperMetadata> = {}) => ({ baseId: '2607.12345', arxivId: '2607.12345v1', version: 1, title, summary: '', published: '2026-07-01', updated: '2026-07-01', categories: ['cs.SE'], ...extra });

for (const [name, paper, task] of [
  // Wording witness, not a reproduction of the complete abstract.
  ['CodeWiki task wording', input('CodeWiki', {
    summary: 'Automated repository-level documentation with LLM-based assessment.',
    published: '2025-10-28', updated: '2026-04-04',
  }), 'repository-level documentation'],
  ['repository documentation', input('RAG for repository documentation'), 'repository documentation'],
  ['codebase wiki', input('Large language model for codebase wiki maintenance'), 'codebase wiki'],
  ['GraphRAG spelling', input('GraphRAG for repository wiki generation'), 'repository wiki'],
] satisfies [string, ReturnType<typeof input>, string][]) {
  test(`Wiki query and automatic filtering accept ${name}`, () => {
    const shard = plan.shards.find(s => s.track === 'LLM-Wiki' && s.dateMode === 'updated');
    assert.ok(shard);
    assert.equal(matchesRecipe(shard, paper), true, 'must be discoverable with the production recipe');
    const decision = evaluateCandidate({ ...paper, matchedTracks: [shard.track] }, rules);
    assert.equal(decision.status, 'accepted', 'must pass automatic filtering without a review');
    assert.equal(decision.accepted, true);
    assert.deepEqual(decision.paper.eligibleTracks, ['LLM-Wiki']);
    assert.equal(decision.signals.technologyMatched, true);
    assert.ok(decision.paper.engineeringTasks.includes(task));
  });
}

for (const title of [
  'AST for specification recovery',
  'Control flow graph for test generation',
  'Program analysis with a call graph for architecture recovery',
]) {
  test(`AST query reaches the independent program-analysis path: ${title}`, () => {
    const shard = plan.shards.find(s => s.track === 'AI-Program-Analysis-AST');
    assert.ok(shard);
    const paper = input(title);
    assert.equal(matchesRecipe(shard, paper), true);
    const decision = evaluateCandidate({ ...paper, matchedTracks: [shard.track] }, rules);
    assert.equal(decision.status, 'accepted');
    assert.equal(decision.accepted, true);
    assert.equal(decision.lane, 'program-analysis');
    assert.deepEqual(decision.paper.eligibleTracks, ['AI-Program-Analysis-AST']);
    assert.equal(decision.signals.lane, 'program-analysis');
    assert.equal(decision.signals.taskMatched, true);
    assert.equal(decision.paper.aiTechniques.length, 0);
  });
}

for (const [track, title, expectedQuery, expectedStatus, technologyMatched, taskMatched] of [
  ['LLM-Wiki', 'LLM for function-level documentation and docstring generation', false, 'rejected', true, false],
  ['LLM-Wiki', 'LLM wiki about world history', false, 'rejected', true, false],
  ['LLM-Wiki', 'Repository-level documentation maintained by hand', false, 'rejected', false, true],
  ['LLM-Wiki', 'RAG for repository documentation in autonomous-driving systems', true, 'rejected', true, true],
  ['AI-Program-Analysis-AST', 'AST and CST for generic compiler parsing optimization', false, 'rejected', true, false],
  ['AI-Program-Analysis-AST', 'LLM for image generation', false, 'rejected', true, false],
  ['AI-Program-Analysis-AST', 'Test generation using random input sampling', false, 'rejected', false, true],
  ['AI-Program-Analysis-AST', 'AST for test generation in autonomous driving', true, 'rejected', true, true],
] satisfies [string, string, boolean, string, boolean, boolean][]) {
  test(`keeps scope gates for ${title}`, () => {
    const shard = plan.shards.find(s => s.track === track);
    assert.ok(shard);
    const paper = input(title);
    assert.equal(matchesRecipe(shard, paper), expectedQuery);
    const decision = evaluateCandidate({ ...paper, matchedTracks: [track] }, rules);
    assert.equal(decision.status, expectedStatus);
    assert.equal(decision.signals.technologyMatched, technologyMatched);
    assert.equal(decision.signals.taskMatched, taskMatched);
  });
}

test('Wiki and AST discovery does not override date eligibility', () => {
  for (const [track, title] of [['LLM-Wiki', 'LLM repository-level documentation'], ['AI-Program-Analysis-AST', 'AST for test generation']]) {
    const paper = input(title, { published: '2025-01-01', updated: '2025-12-31' });
    const shard = plan.shards.find(s => s.track === track);
    assert.ok(shard);
    assert.equal(matchesRecipe(shard, paper), true);
    assert.equal(evaluateCandidate({ ...paper, matchedTracks: [track] }, rules).status, 'rejected');
  }
});

test('active category restrictions still apply to the sparse recipes', () => {
  for (const [track, title] of [['LLM-Wiki', 'LLM repository-level documentation'], ['AI-Program-Analysis-AST', 'AST for test generation']]) {
    const shard = plan.shards.find(s => s.track === track);
    assert.ok(shard);
    assert.equal(matchesRecipe(shard, input(title, { categories: ['math.NT'] })), false);
  }
});
