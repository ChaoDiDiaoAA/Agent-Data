import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRunLock } from '../src/engine-bridge.ts';

test('serializes concurrent workbench operations through the shared run lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datawatch-lock-'));
  const lock = join(root, 'work', 'run.lock');
  const events: string[] = [];
  const first = withRunLock(lock, async () => {
    events.push('first-start');
    await new Promise(resolve => setTimeout(resolve, 60));
    events.push('first-end');
  }, { jobId: 'first' });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = withRunLock(lock, async () => { events.push('second'); }, { jobId: 'second', waitMs: 1000 });
  await Promise.all([first, second]);
  expect(events).toEqual(['first-start', 'first-end', 'second']);
});
