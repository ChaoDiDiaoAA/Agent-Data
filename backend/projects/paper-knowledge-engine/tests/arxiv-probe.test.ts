import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runArxivProbe } from '../src/discovery/arxiv-probe.ts';

const arxiv = {
  pageSize: 100, requestIntervalMs: 6000, maxAttempts: 6, maxBackoffMs: 180000,
  requestTimeoutMs: 60000, retryJitterMs: 1000, capacityCooldownMs: 900000,
  candidatePoolMultiplier: 10, maxResultsPerShard: 100,
};
const projectRoot = join(import.meta.dirname, '..');

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'arxiv-probe-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('probe uses the selected direct route and performs no state writes', async () => {
  await withTempRoot(async root => {
    const before = await readdir(root);
    let seenArgs: string[] = [];
    let seenEnv: Record<string, string | undefined> | undefined;
    const result = await runArxivProbe({
      arxiv, projectRoot, tempRoot: root,
      network: { openCliProxyMode: 'direct', arxivApiBase: 'https://arxiv.org/api/query' },
      execFile: async (_file, args, options) => {
        seenArgs = args;
        seenEnv = options.env;
        return { stdout: '{"papers":[]}' };
      },
    });
    assert.deepEqual(result, {
      apiBase: 'https://arxiv.org/api/query', proxyMode: 'direct', status: 'reachable',
    });
    assert.equal(seenArgs[seenArgs.indexOf('--api-base') + 1], 'https://arxiv.org/api/query');
    assert.equal(seenArgs[seenArgs.indexOf('--date-mode') + 1], 'submitted');
    assert.equal(seenArgs[seenArgs.indexOf('--max-results') + 1], '1');
    assert.equal(seenEnv?.NO_PROXY, '*');
    assert.equal(seenEnv?.HTTP_PROXY, undefined);
    assert.deepEqual(await readdir(root), before);
  });
});

test('probe reports HTTP 429 as rate-limited and preserves the retry status', async () => {
  await withTempRoot(async root => {
    const result = await runArxivProbe({
      arxiv, projectRoot, tempRoot: root,
      network: { openCliProxyMode: 'configured', httpProxy: 'http://127.0.0.1:7897' },
      execFile: async (_file, _args, options) => {
        options.onStderr?.(`__ARXIV_PROGRESS__=${JSON.stringify({
          type: 'discovery-deferred', attempt: 1, maxAttempts: 6, waitMs: 900000,
          httpStatus: 429, retryAfterMs: 900000, rateLimitKind: 'request-rate',
          retryNotBefore: '2026-09-06T01:00:00.000Z',
        })}\n`);
        throw Object.assign(new Error('child rate limited'), { code: 1 });
      },
    });
    assert.deepEqual(result, {
      apiBase: 'https://export.arxiv.org/api/query', proxyMode: 'configured', status: 'rate-limited',
      httpStatus: 429, errorCode: 'ARXIV_CAPACITY_LIMITED',
    });
  });
});

test('probe reports structured transport failures as unreachable', async () => {
  await withTempRoot(async root => {
    const result = await runArxivProbe({
      arxiv, projectRoot, tempRoot: root,
      network: { openCliProxyMode: 'direct', arxivApiBase: 'https://arxiv.org/api/query' },
      execFile: async (_file, _args, options) => {
        options.onStderr?.('__ARXIV_PROGRESS__={"type":"discovery-transport-failed","attempt":2,"maxAttempts":6,"waitMs":0,"transportCode":"ECONNREFUSED"}\n');
        throw Object.assign(new Error('child transport failure'), { code: 1 });
      },
    });
    assert.deepEqual(result, {
      apiBase: 'https://arxiv.org/api/query', proxyMode: 'direct', status: 'unreachable',
      errorCode: 'ARXIV_TRANSPORT_UNAVAILABLE',
    });
  });
});
