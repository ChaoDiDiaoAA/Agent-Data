import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskCommand, quoteTaskCommand } from '../automation/weekly/install-weekly-task.ts';
import { runWeeklyTask } from '../automation/weekly/run-weekly-task.ts';

const descriptor = {
  enabled: true, taskName: 'schedule-behavior-test', dayOfWeek: 'Monday', intervalWeeks: 3, startDate: '2026-08-31', localTime: '22:30',
  timezone: 'Asia/Shanghai', systemTimezone: 'Asia/Shanghai', timezoneMatches: true, entrypoint: 'D:\\fsd\\automation\\weekly\\run-weekly-task.ts', command: ['--library', 'fsd', 'run-task', '--mode', 'weekly'],
};

test('scheduled task action is a direct Bun command with no shell wrapper', () => {
  assert.deepEqual(buildTaskCommand(descriptor, 'C:\\Users\\yyc\\.bun\\bin\\bun.exe'), [
    'C:\\Users\\yyc\\.bun\\bin\\bun.exe', 'D:\\fsd\\automation\\weekly\\run-weekly-task.ts', '--library', 'fsd', 'run-task', '--mode', 'weekly',
  ]);
  assert.equal(quoteTaskCommand(buildTaskCommand(descriptor, 'C:\\Program Files\\Bun\\bun.exe')),
    '"C:\\Program Files\\Bun\\bun.exe" "D:\\fsd\\automation\\weekly\\run-weekly-task.ts" "--library" "fsd" "run-task" "--mode" "weekly"');
});

test('scheduled task descriptor preserves the configured weekly phase', () => {
  assert.equal(descriptor.intervalWeeks, 3);
  assert.equal(descriptor.startDate, '2026-08-31');
  assert.equal(descriptor.localTime, '22:30');
});

test('in-process weekly runner selects fsd before the run-task subcommand', async () => {
  const calls: string[][] = [];
  await runWeeklyTask(async argv => {
    calls.push(argv);
  });

  assert.deepEqual(calls, [['--library', 'fsd', 'run-task', '--mode', 'weekly']]);
});
