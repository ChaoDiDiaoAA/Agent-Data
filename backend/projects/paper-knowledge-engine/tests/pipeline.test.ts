import type { ProgressEvent } from '../src/types/jobs.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRunWindow } from '../src/library/schedule/run-window.ts';
import { runParseManifest } from '../src/library/pipeline.ts';


const config = { startDate: '2026-01-01', overlapHours: 48, currentTask: { maxPapers: 100, trackLimits: {} }, weeklySchedule: { maxPapers: 100 } };

test('weekly window overlaps last success by 48 hours but not before 2026', () => {
  const window = computeRunWindow('2026-02-10T00:00:00Z', '2026-02-17T01:00:00Z', config);
  assert.equal(window.from, '2026-02-08T00:00:00.000Z');
  assert.equal(window.to, '2026-02-17T01:00:00.000Z');
});


test('runs parse manifest serially and returns parsed results', async () => {
  const order: string[] = [];
  const result = await runParseManifest('run-1', {
    runId: 'run-1',
    jobs: [{ baseId: '2608.1' }, { baseId: '2608.2' }],
  }, {
    parseOne: async (job) => { order.push(job.baseId); return { ...job, status: 'succeeded', attemptId: `attempt-${job.baseId}` }; },
  });
  assert.deepEqual(order, ['2608.1', '2608.2']);
  assert.equal(result.status, 'parsed');
});

test('marks successful parse state without writing a semantic note', async () => {
  const parsed: string[] = [];
  await runParseManifest('run-1', {
    runId: 'run-1',
    jobs: [{ baseId: '2608.1' }],
  }, {
    parseOne: async () => ({ status: 'succeeded' }),
    markParsed: (baseId) => { parsed.push(baseId); },
  });
  assert.deepEqual(parsed, ['2608.1']);
});

test('reports serial MinerU progress and per-paper elapsed time', async () => {
  const progress: ProgressEvent[] = [];
  const ticks = [0, 0, 100, 100, 260];
  await runParseManifest('run-1', {
    runId: 'run-1',
    jobs: [
      { baseId: '2608.1', arxivId: '2608.1v1', model: 'pipeline' },
      { baseId: '2608.2', arxivId: '2608.2v1', model: 'pipeline' },
    ],
  }, {
    clock: () => { const tick = ticks.shift(); assert.ok(tick !== undefined); return tick; },
    onProgress: (event) => progress.push(event),
    parseOne: async (job) => ({ ...job, status: 'succeeded', attemptId: `attempt-${job.baseId}` }),
  });

  assert.deepEqual(progress, [
    { type: 'parse-start', phase: 'parse', current: 1, total: 2, baseId: '2608.1', arxivId: '2608.1v1', model: 'pipeline', totalElapsedMs: 0 },
    { type: 'parse-complete', phase: 'parse', current: 1, total: 2, baseId: '2608.1', arxivId: '2608.1v1', model: 'pipeline', status: 'succeeded', elapsedMs: 100, totalElapsedMs: 100 },
    { type: 'parse-start', phase: 'parse', current: 2, total: 2, baseId: '2608.2', arxivId: '2608.2v1', model: 'pipeline', totalElapsedMs: 100 },
    { type: 'parse-complete', phase: 'parse', current: 2, total: 2, baseId: '2608.2', arxivId: '2608.2v1', model: 'pipeline', status: 'succeeded', elapsedMs: 160, totalElapsedMs: 260 },
  ]);
});

test('reports the active MinerU paper when the runner throws', async () => {
  const progress: ProgressEvent[] = [];
  const ticks = [0, 0, 80];
  await assert.rejects(() => runParseManifest('run-1', {
    runId: 'run-1',
    jobs: [{ baseId: '2608.1', arxivId: '2608.1v1', model: 'pipeline' }],
  }, {
    clock: () => { const tick = ticks.shift(); assert.ok(tick !== undefined); return tick; },
    onProgress: (event) => progress.push(event),
    parseOne: async () => { throw new Error('mineru crashed'); },
  }), /mineru crashed/);
  assert.deepEqual(progress.at(-1), {
    type: 'parse-failed', phase: 'parse', current: 1, total: 1,
    baseId: '2608.1', arxivId: '2608.1v1', model: 'pipeline',
    error: 'mineru crashed', elapsedMs: 80, totalElapsedMs: 80,
  });
});
