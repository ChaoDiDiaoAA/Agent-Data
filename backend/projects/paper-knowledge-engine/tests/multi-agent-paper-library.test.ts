import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeCliOperation, routeHarvestPlan, routeScheduleConfig } from '../src/cli/routes.ts';
import { evaluateCandidate } from '../src/library/selection/paper-policy.ts';
import { configurationFiles } from '../src/shared/config-files.ts';
import { listLibraries, loadEngineContext } from '../src/shared/engine-context.ts';
import { asLibraryId } from '../src/shared/identity.ts';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\');
const libraryId = asLibraryId('multi-agent-engineering');
const trackIds = [
  'mas-foundations', 'mas-topology', 'mas-roles-capabilities', 'mas-lifecycle-composition',
  'mas-task-decomposition', 'mas-delegation-handoff', 'mas-planning-scheduling',
  'mas-communication', 'mas-shared-state-memory', 'mas-coordination-consensus',
  'mas-conflict-negotiation', 'mas-synthesis-verification', 'mas-security-governance',
  'mas-fault-tolerance', 'mas-resource-governance', 'mas-observability',
  'mas-human-oversight', 'mas-evaluation-methodology',
];

test('loads Multi-Agent Engineering through the four-file paper contract', () => {
  const context = loadEngineContext({ root, libraryId });
  if (context.library.kind !== 'paper') throw new Error('expected Multi-Agent paper library');
  assert.equal(context.library.libraryId, libraryId);
  assert.equal(context.library.displayName, 'Multi-Agent Engineering（Multi-Agent 工程知识库）');
  assert.equal(context.library.startDate, '2026-01-01');
  assert.equal(context.library.currentTask.maxPapers, 90);
  assert.deepEqual(Object.keys(context.library.currentTask.trackLimits), trackIds);
  assert.ok(Object.values(context.library.currentTask.trackLimits).every(limit => limit === 5));
  assert.equal(context.library.weeklySchedule.maxPapers, 18);
  assert.equal(context.library.overlapHours, 48);
  assert.equal(context.library.downloadAfterHardFilter, true);
  assert.deepEqual(context.library.tracks.map(track => track.id), trackIds);
  assert.ok(context.library.tracks.every(track =>
    track.dateModes.length === 2
    && track.dateModes.includes('submitted')
    && track.dateModes.includes('updated')));
  assert.deepEqual(context.library.paperPolicy.trackPriority, trackIds);
  assert.deepEqual(Object.keys(context.library.categories.tracks), trackIds);
  assert.equal(context.library.categories.fallbackPdf, '99-Unclassified');
  assert.ok(listLibraries(root).some(library => library.libraryId === libraryId));
  assert.deepEqual(configurationFiles(libraryId, 'paper').slice(-4), [
    join(libraryId, 'library.yaml'), join(libraryId, 'query-matrix.yaml'),
    join(libraryId, 'paper-policy.yaml'), join(libraryId, 'categories.yaml'),
  ]);
  for (const forbidden of ['source-policy.yaml', 'topic-taxonomy.yaml', 'synthesis-policy.yaml']) {
    assert.equal(existsSync(join(root, 'config', libraryId, forbidden)), false);
  }
});

test('exposes paper schedule, 36 arXiv shards, and no Research backfill', () => {
  const context = loadEngineContext({ root, libraryId });
  const plan = routeHarvestPlan(['--mode', 'current', '--format', 'json'], { root, libraryId });
  assert.deepEqual(plan, {
    trackCount: 18,
    totalShards: 36,
    submittedShards: 18,
    updatedShards: 18,
    maximumCandidateObservations: plan.maximumCandidateObservations,
    maxPapers: 90,
  });
  const schedule = routeScheduleConfig(['--format', 'json'], { root, libraryId });
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.taskName, 'paper-knowledge-engine-multi-agent-engineering-weekly');
  assert.equal(schedule.dayOfWeek, 'Monday');
  assert.equal(schedule.intervalWeeks, 4);
  assert.equal(schedule.startDate, '2026-08-31');
  assert.equal(schedule.localTime, '22:30');
  assert.equal(schedule.timezone, 'Asia/Shanghai');
  if (!('maxPapers' in schedule)) throw new Error('expected paper schedule with maxPapers');
  assert.equal(schedule.maxPapers, 18);
  assert.deepEqual(schedule.command, ['--library', libraryId, 'run-task', '--mode', 'weekly']);
  assert.throws(
    () => normalizeCliOperation(
      'run-task',
      ['--mode', 'backfill', '--from', '2026-01-01', '--to', '2026-09-07'],
      libraryId,
      context.library.kind,
    ),
    /UNSUPPORTED_LIBRARY_KIND/,
  );
});

test('accepts a Multi-Agent paper using the shared paper policy', () => {
  const context = loadEngineContext({ root, libraryId });
  if (context.library.kind !== 'paper') throw new Error('expected Multi-Agent paper library');
  const decision = evaluateCandidate({
    baseId: '2609.00001',
    arxivId: '2609.00001v1',
    version: 1,
    title: 'Multi-Agent Task Delegation with Fault-Tolerant Coordination',
    summary: 'A multi-agent system for collaborative planning, delegation, and recovery.',
    authors: ['Fixture Author'],
    categories: ['cs.MA'],
    published: '2026-09-01T00:00:00Z',
    updated: '2026-09-01T00:00:00Z',
    matchedTracks: ['mas-delegation-handoff'],
  }, context.library.paperPolicy);
  assert.equal(decision.accepted, true);
  assert.equal(decision.primaryTrack, 'mas-delegation-handoff');
});

test('rejects a single-agent tools-only planning paper', () => {
  const context = loadEngineContext({ root, libraryId });
  if (context.library.kind !== 'paper') throw new Error('expected Multi-Agent paper library');
  const decision = evaluateCandidate({
    baseId: '2609.00002',
    arxivId: '2609.00002v1',
    version: 1,
    title: 'Planning with a Single LLM Agent',
    summary: 'A single LLM agent invokes tools for planning and scheduling.',
    authors: ['Fixture Author'],
    categories: ['cs.AI'],
    published: '2026-09-02T00:00:00Z',
    updated: '2026-09-02T00:00:00Z',
    matchedTracks: ['mas-planning-scheduling'],
  }, context.library.paperPolicy);
  assert.equal(decision.accepted, false);
});

test('rejects a non-agent shared-memory parallel-program paper', () => {
  const context = loadEngineContext({ root, libraryId });
  if (context.library.kind !== 'paper') throw new Error('expected Multi-Agent paper library');
  const decision = evaluateCandidate({
    baseId: '2609.00003',
    arxivId: '2609.00003v1',
    version: 1,
    title: 'Shared Memory Planning in Parallel Programs',
    summary: 'Parallel programs use shared memory and a communication protocol to improve planning performance and scheduling.',
    authors: ['Fixture Author'],
    categories: ['cs.DC'],
    published: '2026-09-03T00:00:00Z',
    updated: '2026-09-03T00:00:00Z',
    matchedTracks: ['mas-planning-scheduling'],
  }, context.library.paperPolicy);
  assert.equal(decision.accepted, false);
});

test('derives Multi-Agent roots independently from FSD and Agent Engineering', () => {
  const multi = loadEngineContext({ root, libraryId });
  const fsd = loadEngineContext({ root, libraryId: 'fsd' });
  const agent = loadEngineContext({ root, libraryId: 'agent-engineering' });
  const keys = [
    'dataRoot', 'databasePath', 'archiveRoot', 'runsRoot', 'operationsRoot',
    'workRoot', 'backupRoot', 'pdfRoot', 'vaultRoot',
  ] as const;
  for (const key of keys) {
    assert.match(multi.paths[key]!, /multi-agent-engineering/i);
    assert.notEqual(multi.paths[key], fsd.paths[key]);
    assert.notEqual(multi.paths[key], agent.paths[key]);
  }
});
