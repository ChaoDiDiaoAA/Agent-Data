import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';
import { buildHarvestPlan } from '../src/discovery/harvest-plan.ts';
import { routeHarvestPlan, routeScheduleConfig } from '../src/cli/routes.ts';
import { evaluateCandidate } from '../src/library/selection/paper-policy.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { asLibraryId } from '../src/shared/identity.ts';

const libraryId = asLibraryId('agent-memory');
const expectedTracks = [
  'mem-foundations', 'mem-working-context', 'mem-episodic', 'mem-semantic',
  'mem-procedural-skills', 'mem-writing', 'mem-organization', 'mem-retrieval',
  'mem-consolidation', 'mem-personalization', 'mem-shared', 'mem-reflection',
  'mem-rsi', 'mem-transfer', 'mem-security', 'mem-evaluation',
  'mem-posttrain-sft', 'mem-posttrain-rl', 'mem-posttrain-distillation',
  'mem-posttrain-parametric',
];

function candidate(title: string, summary: string, track: string) {
  return {
    baseId: '2609.12345', arxivId: '2609.12345v1', version: 1,
    title, summary, matchedTracks: [track],
    published: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z',
  };
}

test('agent-memory config exposes 20 tracks, 200 papers, and 40 harvest shards', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId });
  assert.equal(context.library.kind, 'paper');
  assert.equal(context.library.libraryId, libraryId);
  assert.equal(context.library.startDate, '2026-01-01');
  assert.equal(context.library.currentTask.maxPapers, 200);
  assert.deepEqual(context.library.tracks.map(track => track.id), expectedTracks);
  assert.deepEqual(Object.keys(context.library.currentTask.trackLimits), expectedTracks);
  assert.deepEqual(Object.keys(context.library.categories.tracks), expectedTracks);

  const matrix = YAML.parse(readFileSync('config/agent-memory/query-matrix.yaml', 'utf8'));
  const plan = buildHarvestPlan({ matrix, trackLimits: context.library.currentTask.trackLimits, arxiv: {
    pageSize: 100, candidatePoolMultiplier: 25, maxResultsPerShard: 200,
  } });
  assert.equal(plan.totalShards, 40);
  assert.equal(plan.shards.filter(shard => shard.dateMode === 'submitted').length, 20);
  assert.equal(plan.shards.filter(shard => shard.dateMode === 'updated').length, 20);
});

test('agent-memory exposes a disabled manual weekly schedule through the CLI routes', () => {
  const schedule = routeScheduleConfig(['--format', 'json'], { root: process.cwd(), libraryId });
  assert.equal(schedule.enabled, false);
  if (!('maxPapers' in schedule)) throw new Error('expected paper schedule');
  assert.equal(schedule.maxPapers, 20);
  assert.equal(schedule.taskName, 'paper-knowledge-engine-agent-memory-weekly');
  assert.deepEqual(schedule.command, ['--library', libraryId, 'run-task', '--mode', 'weekly']);

  const plan = routeHarvestPlan(['--mode', 'weekly', '--format', 'json'], { root: process.cwd(), libraryId });
  assert.equal(plan.trackCount, 20);
  assert.equal(plan.totalShards, 40);
  assert.equal(plan.maxPapers, 20);
});

test('agent-memory policy accepts runtime, RSI, and post-training memory evidence', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId });
  const rules = context.library.kind === 'paper' ? context.library.paperPolicy : {};
  const runtime = evaluateCandidate(candidate(
    'Agentic episodic memory for long-horizon language agents',
    'We organize persistent experience memories, retrieve them across sessions, and evaluate memory consolidation for language model agents.',
    'mem-episodic',
  ), rules);
  assert.equal(runtime.accepted, true);

  const rsi = evaluateCandidate(candidate(
    'Memory-guided recursive self-improvement for language agents',
    'Agents write lessons from failed trials into a skill memory and reuse them to improve future policies through recursive self-improvement.',
    'mem-rsi',
  ), rules);
  assert.equal(rsi.accepted, true);

  const postTraining = evaluateCandidate(candidate(
    'Training long-term memory in language models',
    'We use supervised fine-tuning and preference optimization to teach a language model to write, retrieve, and retain episodic memories across tasks.',
    'mem-posttrain-sft',
  ), rules);
  assert.equal(postTraining.accepted, true);
});

test('agent-memory policy rejects unrelated training, GPU memory, and financial RSI papers', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId });
  const rules = context.library.kind === 'paper' ? context.library.paperPolicy : {};
  const ordinaryFineTuning = evaluateCandidate(candidate(
    'Instruction tuning for text classification',
    'We improve a language model with supervised fine-tuning on sentiment data without memory or persistent state.',
    'mem-posttrain-sft',
  ), rules);
  assert.equal(ordinaryFineTuning.accepted, false);

  const gpuMemory = evaluateCandidate(candidate(
    'Memory efficient training of large language models',
    'We reduce GPU memory consumption with quantization and checkpointing during large model training.',
    'mem-posttrain-parametric',
  ), rules);
  assert.equal(gpuMemory.accepted, false);

  const financialRsi = evaluateCandidate(candidate(
    'RSI momentum indicators for portfolio trading',
    'A technical analysis study of the relative strength index.',
    'mem-rsi',
  ), rules);
  assert.equal(financialRsi.accepted, false);
});
