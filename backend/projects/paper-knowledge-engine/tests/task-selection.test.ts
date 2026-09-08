import type { TaskLimitConfig } from '../src/types/config.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTaskDecisions, taskPaperLimit } from '../src/library/selection/task-selection.ts';

const config = {
  currentTask: { maxPapers: 7, trackLimits: { A: 4, B: 3 } },
  weeklySchedule: { maxPapers: 4 },
};
const decision = (track: string | null, id: string, accepted = true) => ({
  accepted,
  primaryTrack: accepted ? track : null,
  paper: { baseId: id },
  reasons: { dateAccepted: accepted, technologyAccepted: accepted, taskAccepted: accepted, excluded: !accepted },
});
const decisions = [
  decision('A', '7'), decision('A', '1'), decision('A', '5'), decision('A', '3'), decision('A', '9'),
  decision('B', '8'), decision('B', '2'), decision('B', '6'), decision('B', '4'),
  decision(null, '0', false),
];

test('limits are derived from config for each mode', () => {
  assert.equal(taskPaperLimit(config, 'current'), 7);
  assert.equal(taskPaperLimit(config, 'weekly'), 4);
});

test('current selection round-robins fully supplied priority quotas', () => {
  assert.deepEqual(selectTaskDecisions(decisions, config, 'current').map((item) => item.paper.baseId), ['9', '8', '7', '6', '5', '4', '3']);
});

test('weekly selection stops at the configured weekly ceiling', () => {
  assert.deepEqual(selectTaskDecisions(decisions, config, 'weekly').map((item) => item.paper.baseId), ['9', '8', '7', '6']);
});

test('different config changes behavior without code changes', () => {
  const alternate = { currentTask: { maxPapers: 3, trackLimits: { A: 2, B: 1 } }, weeklySchedule: { maxPapers: 2 } };
  assert.deepEqual(selectTaskDecisions(decisions, alternate, 'current').map((item) => item.paper.baseId), ['9', '8', '7']);
  assert.deepEqual(selectTaskDecisions(decisions, alternate, 'weekly').map((item) => item.paper.baseId), ['9', '8']);
});

test('fills reachable quotas with recent papers first', () => {
  const accepted = (track: string, baseId: string, updatedAt: string) => ({
    accepted: true,
    primaryTrack: track,
    paper: { baseId, updatedAt },
    reasons: { dateAccepted: true, technologyAccepted: true, taskAccepted: true, excluded: false },
  });
  const quotaConfig = {
    currentTask: { maxPapers: 3, trackLimits: { A: 2, B: 1 } },
    weeklySchedule: { maxPapers: 3 },
  };
  const candidates = [
    accepted('A', '2601.1', '2026-01-01'),
    accepted('A', '2608.2', '2026-08-20'),
    accepted('A', '2608.3', '2026-08-21'),
    accepted('B', '2607.1', '2026-07-01'),
  ];
  assert.deepEqual(selectTaskDecisions(candidates, quotaConfig, 'current').map((item) => item.paper.baseId), ['2608.3', '2607.1', '2608.2']);
});

test('breaks equal update times by submitted time then descending base ID', () => {
  const candidates = [
    { ...decision('A', '2608.1'), paper: { baseId: '2608.1', updatedAt: '2026-08-20', submittedAt: '2026-08-19' } },
    { ...decision('A', '2608.3'), paper: { baseId: '2608.3', updatedAt: '2026-08-20', submittedAt: '2026-08-18' } },
    { ...decision('A', '2608.2'), paper: { baseId: '2608.2', updatedAt: '2026-08-20', submittedAt: '2026-08-18' } },
  ];
  const quotaConfig = {
    currentTask: { maxPapers: 3, trackLimits: { A: 3 } },
    weeklySchedule: { maxPapers: 3 },
  };
  assert.deepEqual(selectTaskDecisions(candidates, quotaConfig, 'current').map((item) => item.paper.baseId), ['2608.1', '2608.3', '2608.2']);
});

test('weekly selection can exceed the current task ceiling without changing current selection', () => {
  const independent = {
    currentTask: { maxPapers: 3, trackLimits: { A: 2, B: 1 } },
    weeklySchedule: { maxPapers: 8 },
  };
  assert.equal(taskPaperLimit(independent, 'current'), 3);
  assert.equal(taskPaperLimit(independent, 'weekly'), 8);
  const weekly = selectTaskDecisions(decisions, independent, 'weekly');
  assert.equal(weekly.length, 8);
  assert.equal(new Set(weekly.map(item => item.paper.baseId)).size, 8);
  assert.ok(weekly.every(item => item.accepted));
  assert.equal(selectTaskDecisions(decisions, independent, 'current').length, 3);
});

test('fills unused category quotas from accepted candidates without exceeding either total ceiling', () => {
  const candidates = Array.from({ length: 10 }, (_, index) => decision('A', String(index)));
  candidates.push(decision('A', 'rejected', false), decision('Unknown', 'unknown'));
  const current = selectTaskDecisions(candidates, config, 'current');
  assert.equal(current.length, 7);
  assert.equal(current.filter(item => item.selectionReason === 'quota').length, 4);
  assert.equal(current.filter(item => item.selectionReason === 'spillover').length, 3);
  assert.ok(current.every(item => item.accepted && item.primaryTrack === 'A'));
  assert.equal(selectTaskDecisions(candidates, config, 'weekly').length, 4);
});

const tagged = (id: string, tracks: string[], updated = '2026-08-01') => ({
  ...decision(tracks[0], id),
  paper: { baseId: id, primaryTrack: tracks[0], matchedTracks: tracks, updated },
});

test('reassigns multi-label papers to cover a scarce category and retains every label', () => {
  const candidates = [tagged('shared', ['AI-TDD', 'AST'], '2026-08-03'), tagged('tdd-only', ['AI-TDD'], '2026-08-02')];
  const before = structuredClone(candidates);
  const limits = { currentTask: { maxPapers: 2, trackLimits: { 'AI-TDD': 1, AST: 1 } }, weeklySchedule: { maxPapers: 2 } };
  const result = selectTaskDecisions(candidates, limits, 'current');
  assert.deepEqual(result.map(item => [item.paper.baseId, item.primaryTrack]), [['tdd-only', 'AI-TDD'], ['shared', 'AST']]);
  assert.deepEqual(result[1].paper.matchedTracks, ['AI-TDD', 'AST']);
  assert.equal(result[1].paper.primaryTrack, 'AST');
  assert.deepEqual(candidates, before);
});

test('uses an augmenting assignment rather than a greedy single-label choice', () => {
  const candidates = [tagged('ab', ['A', 'B'], '2026-08-03'), tagged('bc', ['B', 'C'], '2026-08-02'), tagged('a', ['A'], '2026-08-01')];
  const limits = { currentTask: { maxPapers: 3, trackLimits: { A: 1, B: 1, C: 1 } }, weeklySchedule: { maxPapers: 3 } };
  const result = selectTaskDecisions(candidates, limits, 'current');
  assert.deepEqual(result.map(item => [item.paper.baseId, item.primaryTrack]), [['a', 'A'], ['ab', 'B'], ['bc', 'C']]);
  assert.ok(result.every(item => item.selectionReason === 'quota'));
});

test('never fills with rejected, disabled or unregistered tracks and deduplicates identities', () => {
  const limits = { currentTask: { maxPapers: 4, trackLimits: { A: 2, B: 2, Off: 0 } }, weeklySchedule: { maxPapers: 4 } };
  const candidates = [tagged('same', ['A']), tagged('same', ['A']), decision('A', 'rejected', false), tagged('disabled', ['Off']), tagged('unknown', ['Outside'])];
  assert.deepEqual(selectTaskDecisions(candidates, limits, 'current').map(item => item.paper.baseId), ['same']);
  assert.deepEqual(selectTaskDecisions([], limits, 'current'), []);
});

test('explicit matched labels are authoritative over a stale primary category', () => {
  const candidate = { ...tagged('outside', ['Unknown']), primaryTrack: 'A' };
  assert.deepEqual(selectTaskDecisions([candidate], config, 'current'), []);
});

test('content-reviewed categories take precedence while retaining retrieval labels', () => {
  const candidate = { ...tagged('reviewed', ['A']), paper: { ...tagged('reviewed', ['A']).paper, eligibleTracks: ['B'] } };
  const selected = selectTaskDecisions([candidate], config, 'current');
  assert.equal(selected[0].primaryTrack, 'B');
  assert.deepEqual(selected[0].paper.matchedTracks, ['A']);
});

test('spillover takes recent eligible papers and is independent of input ordering', () => {
  const candidates = [tagged('a-new', ['A'], '2026-08-03'), tagged('a-old', ['A'], '2026-08-01'), tagged('a-mid', ['A'], '2026-08-02')];
  const limits = { currentTask: { maxPapers: 2, trackLimits: { A: 1, B: 1 } }, weeklySchedule: { maxPapers: 2 } };
  assert.deepEqual(selectTaskDecisions(candidates, limits, 'current').map(item => item.paper.baseId), ['a-new', 'a-mid']);
  assert.deepEqual(selectTaskDecisions([...candidates].reverse(), limits, 'current'), selectTaskDecisions(candidates, limits, 'current'));
});

test('current and weekly limits are independent', () => {
  const cfg: TaskLimitConfig = { currentTask: { maxPapers: 2 }, weeklySchedule: { maxPapers: 7 } };
  assert.equal(taskPaperLimit(cfg, 'current'), 2);
  assert.equal(taskPaperLimit(cfg, 'weekly'), 7);
});
