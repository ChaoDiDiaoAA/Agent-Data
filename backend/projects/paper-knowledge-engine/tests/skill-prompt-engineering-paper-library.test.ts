import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';
import { main } from '../src/cli.ts';
import { buildHarvestPlan } from '../src/discovery/harvest-plan.ts';
import { routeHarvestPlan, routeScheduleConfig } from '../src/cli/routes.ts';
import { evaluateCandidate } from '../src/library/selection/paper-policy.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { asLibraryId } from '../src/shared/identity.ts';

const libraryId = asLibraryId('skill-prompt-engineering');
const expectedTracks = [
  'pe-foundations', 'pe-instruction-design', 'pe-in-context-learning', 'pe-reasoning',
  'pe-self-refinement', 'pe-optimization', 'pe-structured-output',
  'pe-grounded-tool-prompting', 'pe-safety', 'pe-evaluation',
  'se-representation', 'se-acquisition', 'se-retrieval', 'se-composition',
  'se-procedural-memory', 'se-transfer', 'se-self-evolution',
  'se-evolution-evaluation', 'se-rsi',
];

function candidate(title: string, summary: string, track: string) {
  return {
    baseId: '2609.12345', arxivId: '2609.12345v1', version: 1,
    title, summary, matchedTracks: [track],
    published: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z',
  };
}

test('Skill + Prompt Engineering exposes 19 tracks, 200 papers, and 38 harvest shards', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId });
  assert.equal(context.library.kind, 'paper');
  assert.equal(context.library.libraryId, libraryId);
  assert.equal(context.library.startDate, '2025-01-01');
  assert.equal(context.library.currentTask.maxPapers, 200);
  assert.deepEqual(context.library.tracks.map(track => track.id), expectedTracks);
  assert.deepEqual(Object.keys(context.library.currentTask.trackLimits), expectedTracks);
  assert.deepEqual(Object.keys(context.library.categories.tracks), expectedTracks);
  assert.equal(Object.values(context.library.currentTask.trackLimits).reduce((sum, value) => sum + value, 0), 200);

  const matrix = YAML.parse(readFileSync('config/skill-prompt-engineering/query-matrix.yaml', 'utf8'));
  const plan = buildHarvestPlan({ matrix, trackLimits: context.library.currentTask.trackLimits, arxiv: {
    pageSize: 100, candidatePoolMultiplier: 25, maxResultsPerShard: 200,
  } });
  assert.equal(plan.totalShards, 38);
  assert.equal(plan.shards.filter(shard => shard.dateMode === 'submitted').length, 19);
  assert.equal(plan.shards.filter(shard => shard.dateMode === 'updated').length, 19);
});

test('Skill + Prompt Engineering keeps prompt, skill evolution, and RSI evidence distinct', () => {
  const { library } = loadEngineContext({ root: process.cwd(), libraryId });
  if (library.kind !== 'paper') throw new Error('expected paper library');
  const decide = (title: string, summary: string, track: string) =>
    evaluateCandidate(candidate(title, summary, track), library.paperPolicy);

  assert.equal(decide(
    'Automatic prompt refinement for language models',
    'We optimize prompts through evaluation feedback for a language model.',
    'pe-optimization',
  ).accepted, true);
  assert.equal(decide(
    'Reusable skill acquisition for language agents',
    'The agent extracts executable skills from successful trajectories and reuses them.',
    'se-acquisition',
  ).accepted, true);
  assert.equal(decide(
    'Recursive self-improvement of agent meta-skills',
    'A meta-skill evolves the skill optimizer and applies the improved optimizer to later skill evolution.',
    'se-rsi',
  ).accepted, true);
  assert.equal(decide(
    'Relative strength index momentum strategy',
    'RSI is used for technical analysis of financial markets.',
    'se-rsi',
  ).accepted, false);
  assert.equal(decide(
    'Instruction tuning for text classification',
    'We improve a language model using supervised fine-tuning without prompts, skills, or agent feedback.',
    'se-rsi',
  ).accepted, false);
});

test('Skill + Prompt Engineering uses a disabled manual weekly schedule', () => {
  const schedule = routeScheduleConfig(['--format', 'json'], { root: process.cwd(), libraryId });
  assert.equal(schedule.enabled, false);
  if (!('maxPapers' in schedule)) throw new Error('expected paper schedule');
  assert.equal(schedule.maxPapers, 20);
  assert.equal(schedule.taskName, 'paper-knowledge-engine-skill-prompt-engineering-weekly');
  assert.deepEqual(schedule.command, ['--library', libraryId, 'run-task', '--mode', 'weekly']);

  const plan = routeHarvestPlan(['--mode', 'weekly', '--format', 'json'], { root: process.cwd(), libraryId });
  assert.equal(plan.trackCount, 19);
  assert.equal(plan.totalShards, 38);
  assert.equal(plan.maxPapers, 20);
});

test('library picker presents Skill + Prompt Engineering after the configured paper libraries', async () => {
  const lines: string[] = [];
  await main([], {
    root: process.cwd(),
    interactive: true,
    readLine: async () => '0',
    writeLine: line => { lines.push(line); },
  });
  assert.deepEqual(lines.slice(0, 11), [
    '论文知识引擎（Bun CLI）',
    '请选择方向库：',
    '1. FSD 论文知识库',
    '2. Agent Engineering',
    '3. Multi-Agent Engineering',
    '4. LLM Post-Training',
    '5. Agent Tool & RSI',
    '6. Agent & LLM Context',
    '7. Skill & Prompt Engineering',
    '8. Agent Memory',
    '0. 退出',
  ]);
});
