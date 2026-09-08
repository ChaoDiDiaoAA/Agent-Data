import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { buildHarvestPlan } from '../src/discovery/harvest-plan.ts';

// Fixed budgets make planner arithmetic independent of editable production limits.
const trackLimits = {
  'AI-FSD': 8, 'LLM-Wiki': 8, 'AI-TDD': 8, 'AI-DDD': 8,
  'AI-Program-Analysis-AST': 12, 'Code-Translation': 8, Verification: 4, Evaluation: 4,
};
const arxiv = { pageSize: 100, candidatePoolMultiplier: 25, maxResultsPerShard: 200 };

test('production recipes produce eight tracks and sixteen stable shards with fixture budgets', () => {
  const matrix = YAML.parse(readFileSync('config/fsd/query-matrix.yaml', 'utf8'));
  const plan = buildHarvestPlan({ matrix, trackLimits, arxiv });
  assert.deepEqual(plan.tracks, [
    'AI-FSD', 'LLM-Wiki', 'AI-TDD', 'AI-DDD',
    'AI-Program-Analysis-AST', 'Code-Translation', 'Verification', 'Evaluation',
  ]);
  assert.equal(plan.totalShards, 16);
  assert.equal(plan.shards.filter((item) => item.dateMode === 'submitted').length, 8);
  assert.equal(plan.shards.filter((item) => item.dateMode === 'updated').length, 8);
  assert.equal(new Set(plan.shards.map((item) => item.key)).size, 16);
  assert.equal(plan.maximumCandidateObservations, 3000);
});

test('uses a focused AI-TDD recipe and caps a supplied large quota at 200 per shard', () => {
  const matrix = YAML.parse(readFileSync('config/fsd/query-matrix.yaml', 'utf8'));
  const plan = buildHarvestPlan({ matrix, trackLimits, arxiv });
  const recipe = matrix.tracks.find((item: { id: string }) => item.id === 'AI-TDD');
  assert.doesNotMatch(recipe.query, /\bAST\b|program analysis/i);
  assert.deepEqual(plan.shards.filter((item) => item.track === 'AI-TDD').map((item) => item.maxResults), [200, 200]);
});

test('rejects drift between recipes and quota tracks', () => {
  assert.throws(() => buildHarvestPlan({
    matrix: { tracks: [{ id: 'AI-FSD', query: 'all:test', categories: ['cs.SE'], date_modes: ['submitted', 'updated'] }] },
    trackLimits: { 'AI-FSD': 1, 'AI-TDD': 1 },
    arxiv: { pageSize: 100, candidatePoolMultiplier: 10, maxResultsPerShard: 200 },
  }), /harvest tracks must exactly match track limits/);
});

test('updated coverage uses its configured scan budget even when selection quotas shrink', () => {
  const matrix = { tracks: [{ id: 'A', query: 'all:test', categories: ['cs.SE'], date_modes: ['submitted', 'updated'] }] };
  const policy = { pageSize: 20, candidatePoolMultiplier: 5, maxResultsPerShard: 137 };
  const small = buildHarvestPlan({ matrix, trackLimits: { A: 1 }, arxiv: policy });
  const large = buildHarvestPlan({ matrix, trackLimits: { A: 30 }, arxiv: policy });
  assert.deepEqual(small.shards.map(shard => shard.maxResults), [20, 137]);
  assert.deepEqual(large.shards.map(shard => shard.maxResults), [137, 137]);
  assert.equal(small.shards[1].key, large.shards[1].key);
  const changed = buildHarvestPlan({ matrix, trackLimits: { A: 1 }, arxiv: { ...policy, maxResultsPerShard: 173 } });
  assert.equal(changed.shards[1].maxResults, 173);
  assert.notEqual(changed.shards[1].key, small.shards[1].key);
});
