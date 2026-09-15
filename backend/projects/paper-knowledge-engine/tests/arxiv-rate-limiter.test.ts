import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withArxivRequestSlot } from '../src/discovery/arxiv-rate-limiter.ts';
import { harvestArxiv } from '../opencli/arxiv/harvest.ts';

test('shared arXiv request slots enforce spacing across sequential callers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-engine-arxiv-rate-'));
  try {
    const lockPath = join(root, 'arxiv-request.lock');
    let now = 1_000;
    const waits: number[] = [];
    const starts: number[] = [];
    const options = {
      lockPath,
      intervalMs: 10_000,
      clock: () => now,
      sleep: async (ms: number) => { waits.push(ms); now += ms; },
    };

    await withArxivRequestSlot(options, async () => { starts.push(now); });
    await withArxivRequestSlot(options, async () => { starts.push(now); });

    assert.deepEqual(starts, [1_000, 11_000]);
    assert.deepEqual(waits, [10_000]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shared arXiv request slots serialize overlapping callers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-engine-arxiv-overlap-'));
  try {
    const lockPath = join(root, 'arxiv-request.lock');
    let now = 1_000;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const holdFirst = new Promise<void>(resolve => { releaseFirst = resolve; });
    const starts: string[] = [];
    const options = {
      lockPath,
      intervalMs: 3_000,
      clock: () => now,
      sleep: async (ms: number) => { now += ms; },
    };

    const first = withArxivRequestSlot(options, async () => {
      starts.push('first');
      markFirstStarted();
      await holdFirst;
    });
    await firstStarted;
    const second = withArxivRequestSlot(options, async () => { starts.push('second'); });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(starts, ['first']);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(starts, ['first', 'second']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('arXiv harvest applies the shared slot to requests from separate harvest calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-engine-arxiv-harvest-rate-'));
  try {
    const lockPath = join(root, 'arxiv-request.lock');
    let now = 1_000;
    const waits: number[] = [];
    let calls = 0;
    const options = {
      from: '2026-08-01', to: '2026-08-02', dateMode: 'submitted', query: 'all:test', categories: ['cs.SE'],
      pageSize: 100, maxResults: 1, requestIntervalMs: 3_000, rateLimitPath: lockPath,
    };
    const dependencies = {
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, text: async () => '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' };
      },
      clock: () => now,
      sleep: async (ms: number) => { waits.push(ms); now += ms; },
    };

    await harvestArxiv(options, dependencies);
    await harvestArxiv(options, dependencies);

    assert.equal(calls, 2);
    assert.deepEqual(waits, [3_000]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an arXiv 429 opens a shared cooldown for later harvest calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-engine-arxiv-cooldown-'));
  try {
    const lockPath = join(root, 'arxiv-request.lock');
    let now = 1_000;
    const waits: number[] = [];
    let calls = 0;
    const options = {
      from: '2026-08-01', to: '2026-08-02', dateMode: 'submitted', query: 'all:test', categories: ['cs.SE'],
      pageSize: 100, maxResults: 1, requestIntervalMs: 3_000, capacityCooldownMs: 900_000, rateLimitPath: lockPath,
    };
    const dependencies = {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 429, headers: { get: () => '30' }, text: async () => 'rate limited' };
        return { ok: true, status: 200, text: async () => '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' };
      },
      clock: () => now,
      sleep: async (ms: number) => { waits.push(ms); now += ms; },
    };

    await assert.rejects(() => harvestArxiv(options, dependencies), { code: 'ARXIV_CAPACITY_LIMITED' });
    now += 60_000;
    await assert.rejects(() => harvestArxiv(options, dependencies), {
      code: 'ARXIV_CAPACITY_LIMITED', retryNotBefore: '1970-01-01T00:15:01.000Z',
    });
    assert.equal(calls, 1, 'a second harvest must not fetch during shared cooldown');
    assert.deepEqual(waits, [], 'shared cooldown must defer instead of silently sleeping');
    now = 901_000;
    await harvestArxiv(options, dependencies);
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('consecutive 429s escalate across harvest calls and a success resets cooldown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-engine-arxiv-escalation-'));
  try {
    let now = 1_000;
    let limited = true;
    const options = {
      from: '2026-08-01', to: '2026-08-02', dateMode: 'submitted', query: 'all:test', categories: ['cs.SE'],
      pageSize: 100, maxResults: 1, requestIntervalMs: 3_000, capacityCooldownMs: 900_000,
      rateLimitPath: join(root, 'request.lock'),
    };
    const dependencies = {
      clock: () => now,
      sleep: async (ms: number) => { now += ms; },
      fetchImpl: async () => limited
        ? { ok: false, status: 429, text: async () => 'Rate exceeded' }
        : { ok: true, status: 200, text: async () => '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' },
    };
    for (const [at, deadline] of [
      [1_000, '1970-01-01T00:15:01.000Z'],
      [901_000, '1970-01-01T00:45:01.000Z'],
      [2_701_000, '1970-01-01T01:45:01.000Z'],
      [6_301_000, '1970-01-01T02:45:01.000Z'],
    ] as const) {
      now = at;
      await assert.rejects(() => harvestArxiv(options, dependencies), {
        code: 'ARXIV_CAPACITY_LIMITED', retryNotBefore: deadline, rateLimitKind: 'system-capacity',
      });
    }
    now = 9_901_000;
    limited = false;
    await harvestArxiv(options, dependencies);
    now += 3_000;
    limited = true;
    await assert.rejects(() => harvestArxiv(options, dependencies), {
      code: 'ARXIV_CAPACITY_LIMITED', retryNotBefore: '1970-01-01T03:00:04.000Z',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy cooldown state defers without making a request or changing its deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-engine-arxiv-legacy-cooldown-'));
  try {
    const lockPath = join(root, 'request.lock');
    await writeFile(`${lockPath}.state.json`, JSON.stringify({ nextRequestAt: 901_000 }));
    let calls = 0;
    await assert.rejects(() => withArxivRequestSlot({
      lockPath, intervalMs: 3_000, clock: () => 61_000, sleep: async () => {},
    }, () => { calls += 1; }), {
      code: 'ARXIV_CAPACITY_LIMITED', retryNotBefore: '1970-01-01T00:15:01.000Z',
    });
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt shared state fails closed instead of discarding a possible cooldown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-engine-arxiv-invalid-state-'));
  try {
    const lockPath = join(root, 'request.lock');
    let calls = 0;
    for (const value of ['{', '{}', '{"nextRequestAt":-1}', '{"nextRequestAt":1000,"consecutive429":-1}']) {
      await writeFile(`${lockPath}.state.json`, value);
      await assert.rejects(() => withArxivRequestSlot({ lockPath, intervalMs: 3_000 }, () => { calls += 1; }));
    }
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a longer server Retry-After takes precedence over adaptive cooldown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-engine-arxiv-retry-after-'));
  try {
    await assert.rejects(() => withArxivRequestSlot({
      lockPath: join(root, 'request.lock'), intervalMs: 3_000, clock: () => 1_000,
    }, () => { throw Object.assign(new Error('limited'), { httpStatus: 429, retryAfterMs: 7_200_000 }); }), {
      retryNotBefore: '1970-01-01T02:00:01.000Z', retryAfterMs: 7_200_000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local deferrals and transport errors do not reset or increment consecutive 429s', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-engine-arxiv-failure-count-'));
  try {
    let now = 1_000;
    const options = {
      lockPath: join(root, 'request.lock'), intervalMs: 3_000, clock: () => now,
      sleep: async (ms: number) => { now += ms; },
    };
    const limited = () => { throw Object.assign(new Error('limited'), { httpStatus: 429 }); };
    await assert.rejects(() => withArxivRequestSlot(options, limited), { retryAfterMs: 900_000 });
    for (let i = 0; i < 4; i += 1) {
      now += 1_000;
      await assert.rejects(() => withArxivRequestSlot(options, limited), {
        retryNotBefore: '1970-01-01T00:15:01.000Z',
      });
    }
    now = 901_000;
    await assert.rejects(() => withArxivRequestSlot(options, () => {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    }), { code: 'ECONNRESET' });
    now += 3_000;
    await assert.rejects(() => withArxivRequestSlot(options, limited), { retryAfterMs: 1_800_000 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
