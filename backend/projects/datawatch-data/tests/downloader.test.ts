import { expect, test } from 'bun:test';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDownloader } from '../src/downloader.ts';

test('downloads bytes to an immutable destination and reuses a matching file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datawatch-download-'));
  const bytes = new TextEncoder().encode('abc');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let calls = 0;
  const downloader = createDownloader({
    get: async () => {
      calls += 1;
      return { url: 'https://example.test/file.csv', status: 200, headers: new Headers(), bytes };
    },
  });
  const request = {
    url: 'https://example.test/file.csv',
    destination: join(root, 'file.csv'),
    temporaryPath: join(root, 'file.csv.part'),
    expectedBytes: 3,
    expectedSha256: sha256,
    maxBytes: 1024,
  };
  await downloader.download(request);
  await downloader.download(request);
  expect(new Uint8Array(await readFile(request.destination))).toEqual(bytes);
  expect((await stat(request.destination)).size).toBe(3);
  expect(calls).toBe(1);
});

test('retries transient status failures and rejects a hash mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datawatch-download-'));
  const bytes = new TextEncoder().encode('abc');
  let calls = 0;
  const downloader = createDownloader({
    get: async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('server busy'), { code: 'RESEARCH_HTTP_STATUS', status: 503 });
      return { url: 'https://example.test/file.csv', status: 200, headers: new Headers(), bytes };
    },
    sleep: async () => undefined,
  });
  await expect(downloader.download({
    url: 'https://example.test/file.csv',
    destination: join(root, 'file.csv'),
    temporaryPath: join(root, 'file.csv.part'),
    expectedBytes: 3,
    expectedSha256: '0'.repeat(64),
    maxBytes: 1024,
  })).rejects.toThrow('FILE_HASH_MISMATCH');
  expect(calls).toBe(3);
});

test('replaces a prior current-snapshot file when a new revision has the same size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'datawatch-download-'));
  const destination = join(root, 'file.csv');
  await Bun.write(destination, 'old');
  const downloader = createDownloader({
    get: async () => ({ url: 'https://example.test/file.csv', status: 200, headers: new Headers(), bytes: new TextEncoder().encode('new') }),
  });
  await downloader.download({
    url: 'https://example.test/file.csv', destination, temporaryPath: join(root, 'file.csv.part'),
    expectedBytes: 3, maxBytes: 1024, replaceExisting: true,
  });
  expect(await readFile(destination, 'utf8')).toBe('new');
});
