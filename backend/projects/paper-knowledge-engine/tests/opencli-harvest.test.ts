import type { ArxivFailure, RetryEvent } from '../opencli/arxiv/retry.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildArxivQuery, harvestArxiv, parseArxivAtom } from '../opencli/arxiv/harvest.ts';
import { withArxivRetry } from '../opencli/arxiv/retry.ts';

const fixture = await readFile(new URL('./fixtures/arxiv-page.xml', import.meta.url), 'utf8');
const baseOptions = {
  from: '2026-08-01', to: '2026-08-02', dateMode: 'submitted', query: 'all:"legacy modernization"', categories: ['cs.SE'],
  pageSize: 100, maxResults: 100, requestIntervalMs: 3000,
};

test('harvest preserves Atom author order and deduplicates names', () => {
  const papers = parseArxivAtom(fixture);
  assert.deepEqual(papers.find(paper => paper.baseId === '2601.00001')?.authors, ['Example Author', 'Second Author']);
});

test('invalid Atom is an error, never a successful empty harvest', async () => {
  await assert.rejects(() => harvestArxiv(baseOptions, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>upstream failure</html>' }) }), /invalid.*Atom/i);
});

test('harvest uses the canonical export.arxiv.org API endpoint by default', async () => {
  let requestedUrl = '';
  await harvestArxiv(baseOptions, {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, text: async () => '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' };
    },
  });
  assert.match(requestedUrl, /^https:\/\/export\.arxiv\.org\/api\/query\?/);
});

test('harvest uses an explicitly selected arXiv API endpoint', async () => {
  let requestedUrl = '';
  await harvestArxiv(baseOptions, {
    apiBase: 'https://arxiv.org/api/query',
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, text: async () => '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' };
    },
  });
  assert.match(requestedUrl, /^https:\/\/arxiv\.org\/api\/query\?/);
});

test('generic HTTP 429 is deferred immediately instead of retried in-process', async () => {
  const now = Date.parse('2026-09-04T00:00:00.000Z');
  const waits: number[] = [];
  const deferred: RetryEvent[] = [];
  let calls = 0;
  await assert.rejects(() => harvestArxiv({ ...baseOptions, maxAttempts: 6, maxBackoffMs: 180000, requestTimeoutMs: 1000, retryJitterMs: 0, capacityCooldownMs: 900_000 }, {
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 429, headers: { get: (name: string) => name === 'retry-after' ? '30' : null } };
    },
    sleep: async ms => waits.push(ms),
    clock: () => now,
    onDeferred: event => deferred.push(event),
  }), { code: 'ARXIV_CAPACITY_LIMITED' });
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0]?.httpStatus, 429);
  assert.equal(deferred[0]?.rateLimitKind, 'request-rate');
  assert.equal(deferred[0]?.retryNotBefore, '2026-09-04T00:15:00.000Z');
});

test('503 responses retain normal retry behavior before a successful response', async () => {
  const waits: number[] = [];
  const retries: RetryEvent[] = [];
  let calls = 0;
  const papers = await harvestArxiv({ ...baseOptions, maxAttempts: 2, maxBackoffMs: 6000, retryJitterMs: 0 }, {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503, text: async () => 'temporarily unavailable' };
      return { ok: true, status: 200, text: async () => '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' };
    },
    sleep: async ms => waits.push(ms),
    onRetry: event => retries.push(event),
  });
  assert.deepEqual(papers, []);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [3000]);
  assert.equal(retries[0]?.httpStatus, 503);
});

test('system-capacity 429 is deferred once with bounded safe diagnostics', async () => {
  const now = Date.parse('2026-09-04T00:00:00.000Z');
  const waits: number[] = [];
  const deferred: RetryEvent[] = [];
  let calls = 0;
  const headerValues: Record<string, string> = {
    'retry-after': '120',
    server: 'envoy',
    via: '1.1 varnish',
    'x-cache': 'MISS',
    'x-served-by': 'cache-a',
    'set-cookie': 'secret=1',
  };
  const body = `${'x'.repeat(300)}Rate exceeded. TAIL_SHOULD_NOT_APPEAR`;

  await assert.rejects(async () => {
    try {
      await harvestArxiv({ ...baseOptions, maxAttempts: 6, capacityCooldownMs: 900_000 } as typeof baseOptions, {
        fetchImpl: async () => {
          calls += 1;
          return {
            ok: false,
            status: 429,
            headers: { get: (name: string) => headerValues[name.toLowerCase()] ?? null },
            text: async () => body,
          };
        },
        sleep: async (ms: number) => waits.push(ms),
        clock: () => now,
        onDeferred: (event: RetryEvent) => deferred.push(event),
      } as never);
    } catch (caught) {
      const error = caught as ArxivFailure & { diagnostic?: string; rateLimitKind?: string; retryNotBefore?: string };
      assert.equal(error.code, 'ARXIV_CAPACITY_LIMITED');
      assert.equal(error.rateLimitKind, 'system-capacity');
      assert.equal(error.retryNotBefore, '2026-09-04T00:15:00.000Z');
      assert.match(error.diagnostic ?? '', /server=envoy/);
      assert.match(error.diagnostic ?? '', /x-served-by=cache-a/);
      assert.doesNotMatch(error.diagnostic ?? '', /Rate exceeded|set-cookie|secret=1|TAIL_SHOULD_NOT_APPEAR/i);
      throw caught;
    }
  }, { code: 'ARXIV_CAPACITY_LIMITED' });

  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0]?.type, 'discovery-deferred');
  assert.equal(deferred[0]?.waitMs, 900_000);
  assert.equal((deferred[0] as RetryEvent & { retryNotBefore?: string }).retryNotBefore, '2026-09-04T00:15:00.000Z');
});

test('system-capacity classification scans the full stream across chunk boundaries', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${'x'.repeat(300)}rAtE ex`));
      controller.enqueue(encoder.encode('CeEdEd after the retained diagnostic'));
      controller.close();
    },
  });

  await assert.rejects(() => harvestArxiv({ ...baseOptions, maxAttempts: 1, capacityCooldownMs: 900_000 }, {
    fetchImpl: async () => ({ ok: false, status: 429, body }),
  }), (caught: unknown) => {
    const error = caught as ArxivFailure;
    assert.equal(error.code, 'ARXIV_CAPACITY_LIMITED');
    assert.equal(error.rateLimitKind, 'system-capacity');
    assert.doesNotMatch(error.diagnostic ?? '', /rate exceeded/i);
    return true;
  });
});

test('stream diagnostics remain within 256 UTF-8 bytes after invalid-byte replacement', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(256).fill(0xff));
      controller.close();
    },
  });

  await assert.rejects(() => harvestArxiv({ ...baseOptions, maxAttempts: 1 }, {
    fetchImpl: async () => ({ ok: false, status: 400, body }),
  }), (caught: unknown) => {
    const diagnostic = (caught as ArxivFailure).diagnostic ?? '';
    assert.match(diagnostic, /^body=/);
    assert.ok(new TextEncoder().encode(diagnostic.slice('body='.length)).byteLength <= 256);
    return true;
  });
});

test('request timeout aborts a Bun fetch request', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(() => harvestArxiv({ ...baseOptions, maxAttempts: 1, requestTimeoutMs: 20 }, {
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), { once: true });
    }),
  }), /timeout|ETIMEDOUT/);
  assert.equal(signal?.aborted, true);
});

test('statusless transport errors retain retryable network codes', async () => {
  let attempts = 0;
  const result = await withArxivRetry(async () => {
    attempts += 1;
    if (attempts === 1) { const error: ArxivFailure = Object.assign(new Error('reset'), { code: 'ECONNRESET' }); throw error; }
    return 'ok';
  }, { maxAttempts: 2, maxBackoffMs: 6000, requestIntervalMs: 3000, retryJitterMs: 0, sleep: async () => {} });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
});

test('normalizes Bun transport error shapes, retries within the configured bound, and emits a failure marker', async () => {
  const cases = [
    { error: Object.assign(new TypeError('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' }), code: 'ECONNREFUSED' },
    { error: Object.assign(new Error('connection timed out'), { name: 'TimeoutError' }), code: 'ETIMEDOUT' },
    { error: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }), code: 'ETIMEDOUT' },
    { error: Object.assign(new Error('nested reset'), { cause: { code: 'ECONNRESET' } }), code: 'ECONNRESET' },
  ];
  for (const value of cases) {
    let attempts = 0;
    const failures: RetryEvent[] = [];
    await assert.rejects(() => harvestArxiv({ ...baseOptions, maxAttempts: 2, retryJitterMs: 0 }, {
      fetchImpl: async () => { attempts += 1; throw value.error; },
      sleep: async () => undefined,
      onFailure: event => failures.push(event),
    }), (caught: unknown) => (caught as ArxivFailure).code === value.code);
    assert.equal(attempts, 2);
    assert.deepEqual(failures.map(event => ({ type: event.type, transportCode: event.transportCode })), [
      { type: 'discovery-transport-failed', transportCode: value.code },
    ]);
  }
});

test('arXiv query uses the selected submitted-date channel', () => {
  assert.equal(buildArxivQuery(baseOptions), '(all:"legacy modernization") AND (cat:cs.SE) AND submittedDate:[202608010000 TO 202608022359]');
});

test('updated harvest returns its bounded window candidates with a truncation warning', async () => {
  const truncations: Record<string, unknown>[] = [];
  const papers = await harvestArxiv({ ...baseOptions, from: '2026-01-01', to: '2026-09-07', dateMode: 'updated', pageSize: 1, maxResults: 1 }, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => fixture }),
    onTruncated: (event: Record<string, unknown>) => truncations.push(event),
  } as never);
  assert.equal(papers.length, 1);
  assert.deepEqual(truncations, [{ type: 'discovery-scan-truncated', track: undefined, dateMode: 'updated', from: '2026-01-01', scannedEntries: 1 }]);
});
