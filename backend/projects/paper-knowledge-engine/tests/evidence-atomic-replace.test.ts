import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { isTransientWindowsReplaceError, replaceFileWithRetry } from '../src/evidence/atomic-replace.ts';

const fixtureRoot = process.env.FSD_TEST_ROOT ?? 'D:/tmp/fsd-evidence-publisher-tests';

test('classifies only transient Windows sharing and permission errors', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    expect(isTransientWindowsReplaceError(Object.assign(new Error(code), { code }), 'win32')).toBe(true);
  }
  for (const code of ['ENOENT', 'EXDEV', 'EEXIST']) {
    expect(isTransientWindowsReplaceError(Object.assign(new Error(code), { code }), 'win32')).toBe(false);
  }
  expect(isTransientWindowsReplaceError(Object.assign(new Error('EPERM'), { code: 'EPERM' }), 'linux')).toBe(false);
});

test('retries a transient Windows replacement without deleting the destination', async () => {
  const root = await mkdtemp(join(fixtureRoot, 'atomic-replace-'));
  const source = join(root, 'journal.json.new');
  const destination = join(root, 'journal.json');
  await writeFile(source, 'new');
  await writeFile(destination, 'old');

  const calls: string[] = [];
  let attempts = 0;
  await replaceFileWithRetry(source, destination, {
    platform: 'win32',
    rename: async (from, to) => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      calls.push('renamed');
      await rename(from, to);
    },
    sleep: async milliseconds => calls.push(`sleep:${milliseconds}`),
  });

  expect(attempts).toBe(3);
  expect(calls).toEqual(['sleep:50', 'sleep:100', 'renamed']);
  expect(await readFile(destination, 'utf8')).toBe('new');
  await expect(readFile(source, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('preserves the original error and both paths when transient replacement is exhausted', async () => {
  const root = await mkdtemp(join(fixtureRoot, 'atomic-replace-'));
  const source = join(root, 'journal.json.new');
  const destination = join(root, 'journal.json');
  await writeFile(source, 'new');
  await writeFile(destination, 'old');

  let attempts = 0;
  const error = Object.assign(new Error('sharing violation'), { code: 'EPERM' });
  await expect(replaceFileWithRetry(source, destination, {
    platform: 'win32',
    maxAttempts: 3,
    rename: async () => {
      attempts += 1;
      throw error;
    },
    sleep: async () => undefined,
  })).rejects.toBe(error);

  expect(attempts).toBe(3);
  expect(await readFile(source, 'utf8')).toBe('new');
  expect(await readFile(destination, 'utf8')).toBe('old');
});
