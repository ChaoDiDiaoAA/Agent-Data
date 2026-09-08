import type { WeeklySchedule } from '../src/types/config.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleDescriptor } from '../src/library/schedule/schedule-config.ts';
import { routeScheduleConfig } from '../src/cli/routes.ts';
import { parseLibrarySelection } from '../src/shared/engine-context.ts';
import { join } from 'node:path';

test('default FSD schedule descriptor uses the engine and library task identity', () => {
  const descriptor = routeScheduleConfig(['--format', 'json'], { root: join(import.meta.dirname, '..') });
  assert.equal(descriptor.taskName, 'paper-knowledge-engine-fsd-weekly');
  assert.deepEqual(descriptor.command, ['--library', 'fsd', 'run-task', '--mode', 'weekly']);
  assert.deepEqual(parseLibrarySelection(descriptor.command), {
    libraryId: 'fsd',
    argv: ['run-task', '--mode', 'weekly'],
  });
});

const config: { weeklySchedule: WeeklySchedule } = { weeklySchedule: {
  enabled: true, taskName: 'alternate-weekly', dayOfWeek: 'tuesday', intervalWeeks: 3, startDate: '2026-09-01', localTime: '08:30', timezone: 'Asia/Tokyo', maxPapers: 4,
} };

test('descriptor is derived from normalized config and points to the Bun runner', () => {
  const descriptor = buildScheduleDescriptor(config, 'D:/builder', 'Asia/Tokyo');
  assert.deepEqual(descriptor, {
    enabled: true, taskName: 'alternate-weekly', dayOfWeek: 'Tuesday', intervalWeeks: 3, startDate: '2026-09-01', startBoundary: '2026-09-01T08:30:00',
    localTime: '08:30', timezone: 'Asia/Tokyo', systemTimezone: 'Asia/Tokyo', timezoneMatches: true, maxPapers: 4,
    entrypoint: 'D:\\builder\\automation\\weekly\\run-weekly-task.ts', command: ['--library', 'fsd', 'run-task', '--mode', 'weekly'],
  });
});

test('descriptor reports a timezone mismatch without preventing inspection', () => {
  assert.equal(buildScheduleDescriptor(config, 'D:/builder', 'UTC').timezoneMatches, false);
});
