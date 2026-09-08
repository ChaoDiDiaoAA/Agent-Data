import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { collectExpiredWork } from '../src/maintenance/work-gc.ts';

const NOW = new Date('2026-09-05T12:00:00.000Z');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'work-gc-'));
  const workRoot = join(root, 'work');
  await mkdir(workRoot);
  return { root, workRoot };
}

async function old(path: string): Promise<void> {
  const timestamp = new Date('2026-07-01T00:00:00.000Z');
  await utimes(path, timestamp, timestamp);
}

test('plans only exact disposable work targets and diagnostics older than thirty days', async () => {
  const f = await fixture();
  try {
    const testsRoot = join(f.workRoot, 'tests');
    const publishingRoot = join(f.workRoot, 'publishing');
    const oldDiagnostic = join(f.workRoot, 'diagnostics', 'old-attempt');
    const freshDiagnostic = join(f.workRoot, 'diagnostics', 'fresh-attempt');
    const parsingRoot = join(f.workRoot, 'parsing');
    for (const path of [testsRoot, publishingRoot, oldDiagnostic, freshDiagnostic, parsingRoot]) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'payload.txt'), path);
    }
    await old(join(oldDiagnostic, 'payload.txt'));
    await old(oldDiagnostic);

    const plan = await collectExpiredWork({ workRoot: f.workRoot, now: NOW });
    assert.deepEqual(plan.entries.map(entry => entry.path), [oldDiagnostic, publishingRoot, testsRoot].sort());
    assert.deepEqual(plan.entries.map(entry => entry.reason).sort(), [
      'diagnostics older than 30 days', 'work/publishing', 'work/tests',
    ].sort());
    assert.ok(plan.entries.every(entry => entry.bytes > 0 && entry.fileCount === 1));
    assert.match(plan.planSha256, /^[0-9a-f]{64}$/);
    await access(join(freshDiagnostic, 'payload.txt'));
    await access(join(parsingRoot, 'payload.txt'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('fails closed when a disposable work target contains a link or reparse point', async () => {
  const f = await fixture();
  try {
    const target = join(f.workRoot, 'tests');
    const outside = join(f.root, 'outside');
    await mkdir(target);
    await mkdir(outside);
    try {
      await symlink(outside, join(target, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await assert.rejects(collectExpiredWork({ workRoot: f.workRoot, now: NOW }), /link|reparse/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
