import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { readFileSync } from 'node:fs';
import { buildHarvestPlan } from '../src/discovery/harvest-plan.ts';
import { evaluateCandidate } from '../src/library/selection/paper-policy.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { routeHarvestPlan, routeScheduleConfig } from '../src/cli/routes.ts';
import { main } from '../src/cli.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';
import { asLibraryId } from '../src/shared/identity.ts';

const libraryId = asLibraryId('agent-context');
const expectedTracks = [
  'ctx-foundations', 'ctx-assembly-budget', 'ctx-retrieval', 'ctx-compression',
  'ctx-long-horizon', 'ctx-memory', 'ctx-tool-context', 'ctx-isolation-security',
  'ctx-evaluation', 'ctx-rsi-reflection', 'ctx-rsi-experience', 'ctx-rsi-evolution',
  'ctx-pt-long-context', 'ctx-pt-retrieval-grounding', 'ctx-pt-memory-policy',
  'ctx-pt-context-distillation', 'ctx-pt-context-data', 'ctx-pt-context-evaluation',
];

function candidate(title: string, summary: string, track: string, dates = { published: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z' }) {
  return {
    baseId: '2609.12345', arxivId: '2609.12345v1', version: 1,
    title, summary, matchedTracks: [track], ...dates,
  };
}

test('agent-context config exposes 18 tracks, 180 papers, and 36 harvest shards', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId });
  assert.equal(context.library.kind, 'paper');
  assert.equal(context.library.libraryId, libraryId);
  assert.equal(context.library.displayName, 'Agent & LLM Context（上下文知识库）');
  assert.equal(context.library.startDate, '2026-01-01');
  assert.equal(context.library.currentTask.maxPapers, 180);
  assert.deepEqual(context.library.tracks.map(track => track.id), expectedTracks);
  assert.deepEqual(Object.keys(context.library.currentTask.trackLimits), expectedTracks);
  assert.deepEqual(Object.keys(context.library.categories.tracks), expectedTracks);

  const matrix = YAML.parse(readFileSync('config/agent-context/query-matrix.yaml', 'utf8'));
  const plan = buildHarvestPlan({ matrix, trackLimits: context.library.currentTask.trackLimits, arxiv: {
    pageSize: 100, candidatePoolMultiplier: 25, maxResultsPerShard: 200,
  } });
  assert.equal(plan.totalShards, 36);
  assert.equal(plan.shards.filter(shard => shard.dateMode === 'submitted').length, 18);
  assert.equal(plan.shards.filter(shard => shard.dateMode === 'updated').length, 18);

  const routePlan = routeHarvestPlan(['--mode', 'current', '--format', 'json'], { root: process.cwd(), libraryId });
  assert.equal(routePlan.trackCount, 18);
  assert.equal(routePlan.totalShards, 36);
  assert.equal(routePlan.maxPapers, 180);
  const schedule = routeScheduleConfig(['--format', 'json'], { root: process.cwd(), libraryId });
  assert.equal(schedule.enabled, true);
  if (!('maxPapers' in schedule)) throw new Error('expected paper schedule');
  assert.equal(schedule.maxPapers, 18);
  assert.deepEqual(schedule.command, ['--library', libraryId, 'run-task', '--mode', 'weekly']);
});

test('agent-context policy accepts one evidence-backed example for every track', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId });
  const rules = context.library.kind === 'paper' ? context.library.paperPolicy : {};
  const examples: Record<string, [string, string]> = {
    'ctx-foundations': ['Agent context engineering', 'A language model context management architecture for agents.'],
    'ctx-assembly-budget': ['Context assembly and token budget', 'An agent selects context under a token budget.'],
    'ctx-retrieval': ['Agentic retrieval for context', 'A language model performs context retrieval and memory retrieval.'],
    'ctx-compression': ['Prompt compression for agents', 'History compression reduces an agent context.'],
    'ctx-long-horizon': ['Long-horizon agent context', 'Working context supports a long horizon language model agent.'],
    'ctx-memory': ['Episodic memory for agents', 'A language model uses semantic memory and long-term memory.'],
    'ctx-tool-context': ['Tool context for agents', 'Tool results and tool descriptions are organized as execution context.'],
    'ctx-isolation-security': ['Context injection defense', 'Agents detect prompt injection and memory poisoning through context isolation.'],
    'ctx-evaluation': ['Context benchmark for agents', 'A memory benchmark measures context evaluation for language models.'],
    'ctx-rsi-reflection': ['Reflective memory for agents', 'Reflective memory turns failure feedback into reusable context.'],
    'ctx-rsi-experience': ['Skill memory for self-improving agents', 'Experience memory and experience replay improve future agent behavior.'],
    'ctx-rsi-evolution': ['Recursive self-improvement through memory evolution', 'A self-evolving agent updates context and memory.'],
    'ctx-pt-long-context': ['Long-context post-training', 'Supervised fine-tuning teaches a language model to use a long context window.'],
    'ctx-pt-retrieval-grounding': ['Retrieval augmented post-training', 'Retrieval training improves context grounding and grounded generation in a language model.'],
    'ctx-pt-memory-policy': ['Learned memory policy', 'Reinforcement learning trains a language model memory policy and context management.'],
    'ctx-pt-context-distillation': ['Context distillation', 'Knowledge distillation transfers long-context behavior in a language model.'],
    'ctx-pt-context-data': ['Long-context training data', 'Synthetic data and data curation create long-context data for a language model.'],
    'ctx-pt-context-evaluation': ['Context faithfulness after post-training', 'Post-training evaluation measures context utilization and evidence attribution in a language model.'],
  };
  for (const track of expectedTracks) {
    const [title, summary] = examples[track]!;
    const decision = evaluateCandidate(candidate(title, summary, track), rules);
    assert.equal(decision.accepted, true, track);
    assert.ok(decision.paper.engineeringTasks.length > 0, track);
  }
});

test('agent-context policy rejects unrelated or misleading context candidates', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId });
  const rules = context.library.kind === 'paper' ? context.library.paperPolicy : {};
  const ordinaryFineTuning = evaluateCandidate(candidate(
    'Instruction tuning for sentiment classification',
    'Supervised fine-tuning improves a language model on labeled sentiment data.',
    'ctx-pt-long-context',
  ), rules);
  assert.equal(ordinaryFineTuning.accepted, false);

  const kvCache = evaluateCandidate(candidate(
    'KV cache optimization for language models',
    'We reduce inference latency and GPU memory use with cache optimization.',
    'ctx-pt-long-context',
  ), rules);
  assert.equal(kvCache.accepted, false);

  const ordinaryMemory = evaluateCandidate(candidate(
    'Memory management for distributed systems',
    'A systems study of allocation, paging, and cache eviction without language model context.',
    'ctx-memory',
  ), rules);
  assert.equal(ordinaryMemory.accepted, false);

  const contextlessDistillation = evaluateCandidate(candidate(
    'Knowledge distillation for image classification',
    'A student vision model learns from a teacher network for image labels.',
    'ctx-pt-context-distillation',
  ), rules);
  assert.equal(contextlessDistillation.accepted, false);

  const financialRsi = evaluateCandidate(candidate(
    'RSI momentum indicators for financial trading',
    'The relative strength index predicts stock market movement.',
    'ctx-rsi-evolution',
  ), rules);
  assert.equal(financialRsi.accepted, false);

  const spoofedTrack = evaluateCandidate(candidate(
    'Generic preference optimization',
    'A language model is trained on ordinary preference data for sentiment ranking.',
    'ctx-pt-context-distillation',
  ), rules);
  assert.equal(spoofedTrack.accepted, false);

  const historical = evaluateCandidate(candidate(
    'Context engineering for agents',
    'A language model context architecture is evaluated.',
    'ctx-foundations',
    { published: '2025-12-20T00:00:00Z', updated: '2025-12-20T00:00:00Z' },
  ), rules);
  assert.equal(historical.accepted, false);
});

test('agent-context keeps cross-classification labels while prioritizing RSI and accepts a 2026 update', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId });
  const rules = context.library.kind === 'paper' ? context.library.paperPolicy : {};
  const crossClassified = evaluateCandidate({
    ...candidate(
      'Recursive self-improvement through context distillation',
      'A language model agent reflects on experience, evolves its memory context, and uses knowledge distillation during post-training.',
      'ctx-foundations',
      { published: '2025-12-20T00:00:00Z', updated: '2026-02-10T00:00:00Z' },
    ),
    matchedTracks: ['ctx-foundations', 'ctx-pt-context-distillation', 'ctx-rsi-evolution'],
  }, rules);
  assert.equal(crossClassified.accepted, true);
  assert.equal(crossClassified.primaryTrack, 'ctx-rsi-evolution');
  assert.deepEqual(crossClassified.paper.matchedTracks, [
    'ctx-foundations', 'ctx-pt-context-distillation', 'ctx-rsi-evolution',
  ]);
  assert.deepEqual(crossClassified.paper.eligibleTracks, [
    'ctx-rsi-evolution', 'ctx-pt-context-distillation', 'ctx-foundations',
  ]);
});

test('agent-context has isolated paths and is selectable without creating state', async () => {
  const root = await mkdtemp(join(process.env.FSD_TEST_ROOT ?? process.cwd(), 'agent-context-'));
  try {
    await writeLayeredConfigFixture({ root });
    await cp(join(process.cwd(), 'config', libraryId), join(root, 'config', libraryId), { recursive: true });
    const lines: string[] = [];
    await main(['--library', libraryId], {
      root, interactive: true, readLine: async () => '0', writeLine: line => { lines.push(line); },
    });
    assert.ok(lines.some(line => line.includes('Agent & LLM Context')));
    const pickerLines: string[] = [];
    const pickerChoices = ['2', '0'];
    await main([], {
      root, interactive: true, readLine: async () => pickerChoices.shift() ?? '0',
      writeLine: line => { pickerLines.push(line); },
    });
    assert.ok(pickerLines.includes('2. Agent & LLM Context'));
    assert.equal((await readdir(root)).sort().join(','), 'config');
    const context = loadEngineContext({ root, libraryId });
    const fsd = loadEngineContext({ root, libraryId: 'fsd' });
    assert.notEqual(context.paths.dataRoot, fsd.paths.dataRoot);
    assert.match(context.paths.dataRoot, /agent-context/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
