import assert from 'node:assert/strict';
import test from 'node:test';
import YAML from 'yaml';
import { readFileSync } from 'node:fs';
import { buildHarvestPlan } from '../src/discovery/harvest-plan.ts';
import { evaluateCandidate } from '../src/library/selection/paper-policy.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { routeHarvestPlan, routeScheduleConfig } from '../src/cli/routes.ts';
import { asLibraryId } from '../src/shared/identity.ts';

const libraryId = asLibraryId('agent-tool');
const expectedTracks = [
  'tool-foundations', 'tool-selection', 'tool-composition', 'tool-protocol',
  'tool-generation', 'tool-library', 'tool-evaluation', 'tool-security',
  'tool-pt-data', 'tool-pt-sft', 'tool-pt-reward', 'tool-pt-preference',
  'tool-pt-rl', 'tool-pt-transfer', 'tool-pt-evaluation',
  'rsi-tool-repair', 'rsi-agent-evolution', 'rsi-meta-improvement',
];

function candidate(title: string, summary: string, track: string) {
  return {
    baseId: '2609.12345', arxivId: '2609.12345v1', version: 1,
    title, summary, matchedTracks: [track],
    published: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z',
  };
}

test('agent-tool config exposes 18 tracks, 270 papers, and 36 harvest shards', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId });
  assert.equal(context.library.kind, 'paper');
  assert.equal(context.library.libraryId, libraryId);
  assert.equal(context.library.startDate, '2026-01-01');
  assert.equal(context.library.currentTask.maxPapers, 270);
  assert.deepEqual(context.library.tracks.map(track => track.id), expectedTracks);
  assert.deepEqual(Object.keys(context.library.currentTask.trackLimits), expectedTracks);
  assert.deepEqual(Object.keys(context.library.categories.tracks), expectedTracks);

  const matrix = YAML.parse(readFileSync('config/agent-tool/query-matrix.yaml', 'utf8'));
  const plan = buildHarvestPlan({ matrix, trackLimits: context.library.currentTask.trackLimits, arxiv: {
    pageSize: 100, candidatePoolMultiplier: 25, maxResultsPerShard: 200,
  } });
  assert.equal(plan.totalShards, 36);
  assert.equal(plan.shards.filter(shard => shard.dateMode === 'submitted').length, 18);
  assert.equal(plan.shards.filter(shard => shard.dateMode === 'updated').length, 18);
  const routePlan = routeHarvestPlan(['--mode', 'current', '--format', 'json'], { root: process.cwd(), libraryId });
  assert.equal(routePlan.trackCount, 18);
  assert.equal(routePlan.totalShards, 36);
  assert.equal(routePlan.maxPapers, 270);
  const schedule = routeScheduleConfig(['--format', 'json'], { root: process.cwd(), libraryId });
  assert.equal(schedule.enabled, false);
  if (!('maxPapers' in schedule)) throw new Error('expected paper schedule');
  assert.equal(schedule.maxPapers, 12);
  assert.deepEqual(schedule.command, ['--library', libraryId, 'run-task', '--mode', 'weekly']);
});

test('agent-tool policy requires tool or self-improvement evidence and rejects unrelated papers', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId });
  const rules = context.library.kind === 'paper' ? context.library.paperPolicy : {};
  const accepted = evaluateCandidate(candidate(
    'Tool use post-training with self-improving agents',
    'We train a language model with tool-use trajectories and evaluate recursive self-improvement through automatic tool repair.',
    'rsi-tool-repair',
  ), rules);
  assert.equal(accepted.accepted, true);

  for (const [track, title, summary] of [
    ['tool-pt-data', 'Tool-use trajectory data for language models', 'We curate tool use trajectories and failure examples for post-training a language model.'],
    ['tool-pt-sft', 'Supervised fine-tuning for tool calling', 'We use tool calling demonstrations to train a language model with supervised fine-tuning.'],
    ['tool-pt-reward', 'Execution feedback rewards for tool use', 'A language model learns tool use from execution feedback and verified outcomes.'],
    ['tool-pt-preference', 'Preference optimization for tool calling', 'We optimize language model preferences over successful and costly tool calling trajectories.'],
    ['tool-pt-rl', 'Reinforcement learning for tool-use agents', 'Interactive reinforcement learning teaches an agent to use tools in an environment.'],
    ['tool-pt-transfer', 'Distilling tool use across unseen tools', 'We distill tool-use behavior into a language model and measure transfer to new tools.'],
    ['tool-pt-evaluation', 'Post-training evaluation on unseen tools', 'We evaluate language model tool use after post-training on held-out tools.'],
  ] as const) {
    assert.equal(evaluateCandidate(candidate(title, summary, track), rules).accepted, true, track);
  }

  const financialRsi = evaluateCandidate(candidate(
    'RSI momentum indicators for portfolio trading',
    'A technical analysis study of the relative strength index.',
    'rsi-tool-repair',
  ), rules);
  assert.equal(financialRsi.accepted, false);

  const ordinaryFineTuning = evaluateCandidate(candidate(
    'Instruction tuning for text classification',
    'We improve a language model with supervised fine-tuning on sentiment data without tools or agent interaction.',
    'tool-pt-sft',
  ), rules);
  assert.equal(ordinaryFineTuning.accepted, false);
});
