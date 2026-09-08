import type { ExecFileOptions } from 'node:child_process';
type ChildOptions = ExecFileOptions & { onStderr?: (chunk: string) => void };
type Progress = import('../src/types/jobs.ts').ProgressEvent;
type ManagedProcessResult = import('../src/runtime/process.ts').ManagedProcessResult;
type ManagedProcess = typeof import('../src/runtime/process.ts').runManagedProcess;
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runHarvestShards } from '../src/discovery/opencli-runner.ts';
import { formatProgressEvent } from '../src/cli/progress.ts';
import { createProcessContext, runManagedProcess } from '../src/runtime/process.ts';

const testRoot = process.env.FSD_TEST_ROOT;
assert.ok(testRoot, 'harvest tests require the isolated preload root');
const tempRoot = join(testRoot, 'opencli-runner');
const processContext = createProcessContext(resolve(import.meta.dirname, '..'), join(tempRoot, 'processes'));

const arxiv = {
  pageSize: 100,
  requestIntervalMs: 6000,
  maxAttempts: 6,
  maxBackoffMs: 180000,
  requestTimeoutMs: 60000,
  retryJitterMs: 1000,
  capacityCooldownMs: 900000,
};

test('OpenCLI receives explicit proxy only in child environment, including failed invocations', async () => {
  const before = { ...process.env };
  for (const fail of [false, true]) {
    const run = runHarvestShards([
      { track: 'A', dateMode: 'submitted', query: 'all:a', categories: [], maxResults: 1 },
    ], { from: '2026-08-01', to: '2026-08-02' }, {
      arxiv, tempRoot, processContext, network: { httpProxy: 'http://127.0.0.1:7897' },
      managedProcess: async spec => {
        assert.equal(spec.env.HTTP_PROXY, 'http://127.0.0.1:7897');
        assert.equal(spec.env.HTTPS_PROXY, 'http://127.0.0.1:7897');
        assert.equal(spec.env.http_proxy, process.platform === 'win32' ? undefined : 'http://127.0.0.1:7897');
        assert.equal(spec.env.https_proxy, process.platform === 'win32' ? undefined : 'http://127.0.0.1:7897');
        assert.equal(spec.env.NO_PROXY, 'localhost,127.0.0.1,::1');
        assert.equal(spec.env.no_proxy, process.platform === 'win32' ? undefined : spec.env.NO_PROXY);
        if (process.platform === 'win32') assert.equal(new Set(Object.keys(spec.env).map(key => key.toUpperCase())).size, Object.keys(spec.env).length);
        assert.deepEqual({ ...process.env }, before);
        if (fail) throw new Error('fixture child failure');
        return { reason: 'exit', exitCode: 0, stdout: '{"papers":[]}', stderr: '', cleanupConfirmed: true, activePids: [], pid: 999, elapsedMs: 1 };
      },
    });
    if (fail) await assert.rejects(run, /fixture child failure/);
    else assert.deepEqual(await run, []);
    assert.deepEqual({ ...process.env }, before);
  }
});

for (const fail of [false, true]) test(`execFile proxy environment is unambiguous and parent-isolated: failure=${fail}`, async () => {
  const before = { ...process.env };
  const run = runHarvestShards([
    { track: 'A', dateMode: 'submitted', query: 'all:a', categories: [], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv, processContext, network: { httpProxy: 'http://127.0.0.1:7897' },
    execFile: async (_file, _args, options) => {
      const env = options.env;
      assert.ok(env);
      assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7897');
      assert.equal(env.HTTPS_PROXY, env.HTTP_PROXY);
      assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
      if (process.platform === 'win32') {
        assert.equal(new Set(Object.keys(env).map(key => key.toUpperCase())).size, Object.keys(env).length);
        assert.equal(env.http_proxy, undefined);
        assert.equal(env.https_proxy, undefined);
        assert.equal(env.no_proxy, undefined);
      } else {
        assert.equal(env.http_proxy, env.HTTP_PROXY);
        assert.equal(env.https_proxy, env.HTTPS_PROXY);
        assert.equal(env.no_proxy, env.NO_PROXY);
      }
      assert.deepEqual({ ...process.env }, before);
      if (fail) throw new Error('fixture execFile failure');
      return { stdout: '{"papers":[]}' };
    },
  });
  if (fail) await assert.rejects(run, /fixture execFile failure/);
  else assert.deepEqual(await run, []);
  assert.deepEqual({ ...process.env }, before);
});

test('execFile without configured proxy retains default environment inheritance', async () => {
  await runHarvestShards([
    { track: 'A', dateMode: 'submitted', query: 'all:a', categories: [], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv, processContext,
    execFile: async (_file, _args, options) => {
      assert.equal(options.env, undefined);
      return { stdout: '{"papers":[]}' };
    },
  });
});

test('OpenCLI direct route removes protocol and ALL_PROXY aliases and passes the selected API base', async () => {
  await runHarvestShards([
    { track: 'A', dateMode: 'submitted', query: 'all:a', categories: [], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv, processContext, tempRoot,
    network: { openCliProxyMode: 'direct', arxivApiBase: 'https://arxiv.org/api/query' },
    managedProcess: async spec => {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
        assert.equal(spec.env[key], undefined, key);
      }
      assert.equal(spec.env.NO_PROXY, '*');
      if (process.platform !== 'win32') assert.equal(spec.env.no_proxy, '*');
      assert.equal(spec.args[spec.args.indexOf('--api-base') + 1], 'https://arxiv.org/api/query');
      return { reason: 'exit', exitCode: 0, stdout: '{"papers":[]}', stderr: '', cleanupConfirmed: true, activePids: [], pid: 999, elapsedMs: 1 };
    },
  });
});

test('real OpenCLI discovers arXiv papers through the explicit HTTP proxy', async () => {
  const xml = await readFile(new URL('./fixtures/arxiv-page.xml', import.meta.url), 'utf8');
  const requests: string[] = [];
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests.push(request.url);
    return new Response(xml, { headers: { 'Content-Type': 'application/atom+xml' } });
  } });
  const before = { ...process.env };
  try {
    const papers = await runHarvestShards([
      { track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 100 },
    ], { from: '2026-01-01', to: '2026-08-31' }, {
      arxiv, tempRoot, processContext, signal: AbortSignal.timeout(15000),
      network: { httpProxy: `http://127.0.0.1:${proxy.port}` },
      managedProcess: (spec, options) => runManagedProcess({ ...spec,
        env: { ...spec.env, FSD_ARXIV_API_BASE: 'http://arxiv.invalid/query' },
      }, options),
    });
    assert.deepEqual(papers.map(paper => paper.arxivId).sort(), ['2601.00001v2', '2608.23146v1']);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]).hostname, 'arxiv.invalid');
    assert.deepEqual({ ...process.env }, before);
  } finally { await proxy.stop(true); }
});

test('absent proxy preserves inherited OpenCLI environment', async () => {
  const inherited = { ...process.env };
  await runHarvestShards([
    { track: 'A', dateMode: 'submitted', query: 'all:a', categories: [], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv, tempRoot, processContext,
    managedProcess: async spec => {
      const expected = Object.fromEntries(Object.entries(inherited).map(([key, value]) => [process.platform === 'win32' ? key.toUpperCase() : key, value]));
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) assert.equal(spec.env[key], expected[key]);
      return { reason: 'exit', exitCode: 0, stdout: '{"papers":[]}', stderr: '', cleanupConfirmed: true, activePids: [], pid: 999, elapsedMs: 1 };
    },
  });
});

const deferredProgress = {
  type: 'discovery-deferred', attempt: 1, maxAttempts: 6, waitMs: 900000,
  httpStatus: 429, retryAfterMs: 900000, rateLimitKind: 'system-capacity',
  retryNotBefore: '2026-09-04T00:15:00.000Z',
  diagnostic: 'body=Rate exceeded.; server=envoy',
} as const;

const requestRateDeferredProgress = {
  ...deferredProgress,
  rateLimitKind: 'request-rate',
  diagnostic: 'server=envoy; retry-after=30',
} as const;

function managedProcessWithDeferred(result: ManagedProcessResult): ManagedProcess {
  return async (spec, options = {}) => {
    assert.equal(spec.env.TEMP, tempRoot);
    assert.equal(spec.env.TMP, tempRoot);
    options.onStderr?.(`__ARXIV_PROGRESS__=${JSON.stringify(deferredProgress)}\n`);
    return result;
  };
}

test('rejects malformed CLI paper identity before checkpoint completion', async () => {
  for (const paper of [{ baseId: 1 }, { baseId: 'one', version: '1' }, { baseId: 'one', arxivId: 'otherv1', version: 1 }, { baseId: 'one', authors: ['valid', 1] }]) {
    const checkpoints: Array<{ kind: string; key: string; index: number; error?: unknown }> = [];
    let rejected: unknown;
    await assert.rejects(runHarvestShards([{ key: 'bad', track: 'A', dateMode: 'submitted', query: 'all:a', categories: [], maxResults: 1 }],
      { from: '2026-08-01', to: '2026-08-02' }, { arxiv, execFile: async () => ({ stdout: JSON.stringify({ papers: [paper] }) }),
        checkpoint: { completedKeys: new Set(),
          start: (shard, index) => { checkpoints.push({ kind: 'start', key: shard.key, index }); },
          complete: (shard, index) => { checkpoints.push({ kind: 'complete', key: shard.key, index }); },
          fail: (shard, index, error) => { checkpoints.push({ kind: 'fail', key: shard.key, index, error }); },
          loadMergedPapers: () => [],
        },
      }), error => { rejected = error; return error instanceof Error && /paper identity|paper metadata/.test(error.message); });
    assert.deepEqual(checkpoints, [{ kind: 'start', key: 'bad', index: 0 }, { kind: 'fail', key: 'bad', index: 0, error: rejected }]);
  }
});

test('runner preserves harvested author arrays', async () => {
  const papers = await runHarvestShards([
    { track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv,
    execFile: async () => ({ stdout: JSON.stringify({
      schemaVersion: 1,
      dateMode: 'submitted',
      papers: [{ baseId: '2608.23146', arxivId: '2608.23146v1', version: 1, authors: ['Nafiseh Soveizi'] }],
    }) }),
  });
  assert.deepEqual(papers[0].authors, ['Nafiseh Soveizi']);
});

test('runner fails a checkpoint shard before completion when source authors are missing', async () => {
  const events: string[] = [];
  await assert.rejects(() => runHarvestShards([
    { key: 'authors-required', track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv,
    execFile: async () => ({ stdout: JSON.stringify({ papers: [{
      baseId: '2608.23146', arxivId: '2608.23146v1', version: 1,
      title: 'Missing authors', categories: ['cs.SE'], published: '2026-08-01T00:00:00Z', updated: '2026-08-01T00:00:00Z',
    }] }) }),
    checkpoint: {
      completedKeys: new Set(),
      start: () => events.push('start'),
      complete: () => events.push('complete'),
      fail: () => events.push('fail'),
      loadMergedPapers: () => [],
    },
  }), /source metadata.*authors/i);
  assert.deepEqual(events, ['start', 'fail']);
});

function runFixtureChild(source: string, options: ChildOptions) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const { onStderr, ...execOptions } = options;
    const child = execFileCallback(process.execPath, ['-e', source], { ...execOptions, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
    if (onStderr) child.stderr?.on('data', onStderr);
  });
}

test('runner passes the shard budget', async () => {
  let command: string[] = [];
  await runHarvestShards([
    { key: 'a', track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 120 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv,
    execFile: async (_file: string, args: string[]) => {
      command = args;
      return { stdout: JSON.stringify({ schemaVersion: 1, dateMode: 'submitted', papers: [] }) };
    },
  });
  assert.equal(command[command.indexOf('--max-results') + 1], '120');
  assert.equal(command[command.indexOf('--page-size') + 1], '100');
  assert.equal(command[command.indexOf('--request-interval-ms') + 1], '6000');
  assert.equal(command[command.indexOf('--max-attempts') + 1], '6');
  assert.equal(command[command.indexOf('--max-backoff-ms') + 1], '180000');
  assert.equal(command[command.indexOf('--request-timeout-ms') + 1], '60000');
  assert.equal(command[command.indexOf('--retry-jitter-ms') + 1], '1000');
  assert.equal(command[command.indexOf('--capacity-cooldown-ms') + 1], '900000');
});

test('streams and formats retry progress across the child-process stderr boundary', async () => {
  const output: string[] = [];
  const retry = {
    type: 'discovery-retry', attempt: 1, maxAttempts: 6,
    waitMs: 30500, httpStatus: 429, retryAfterMs: 30000,
  };
  const stdout = JSON.stringify({ schemaVersion: 1, dateMode: 'submitted', papers: [] });
  const source = [
    `const retry = ${JSON.stringify(retry)};`,
    `process.stderr.write('__ARXIV_PROGRESS__=');`,
    'setTimeout(() => {',
    `  process.stderr.write(JSON.stringify(retry) + '\\n');`,
    `  process.stdout.write(${JSON.stringify(stdout)});`,
    '}, 5);',
  ].join('\n');

  await runHarvestShards([
    { track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 100 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv,
    execFile: (_file: string, _args: string[], options: ChildOptions) => runFixtureChild(source, options),
    onProgress: (event: Progress) => { const line = formatProgressEvent(event); if (line !== null) output.push(line); },
  });

  assert.ok(output.includes('[发现 1/1] arXiv 限流，第 1/6 次重试，等待 30.5 秒'));
});

test('streams an updated-scan truncation warning across the child-process stderr boundary', async () => {
  const progress: Progress[] = [];
  const marker = { type: 'discovery-scan-truncated', dateMode: 'updated', from: '2026-01-01', scannedEntries: 200 };
  const stdout = JSON.stringify({ schemaVersion: 1, dateMode: 'updated', papers: [] });
  const source = [
    `process.stderr.write('__ARXIV_PROGRESS__=${JSON.stringify(marker)}\\n');`,
    `process.stdout.write(${JSON.stringify(stdout)});`,
  ].join('\n');

  await runHarvestShards([
    { track: 'A', dateMode: 'updated', query: 'all:a', categories: ['cs.SE'], maxResults: 200 },
  ], { from: '2026-01-01', to: '2026-09-07' }, {
    arxiv,
    execFile: (_file: string, _args: string[], options: ChildOptions) => runFixtureChild(source, options),
    onProgress: (event: Progress) => progress.push(event),
  });

  assert.equal(progress.find((event) => event.type === 'discovery-scan-truncated')?.scannedEntries, 200);
});

test('preserves an arXiv capacity deferral across the child-process boundary', async () => {
  const progress: Progress[] = [];
  let checkpointFailure: unknown;

  await assert.rejects(() => runHarvestShards([
    { key: 'capacity', track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv,
    onProgress: (event: Progress) => progress.push(event),
    checkpoint: {
      completedKeys: new Set(), start: () => undefined, complete: () => undefined,
      fail: (_shard, _index, error) => { checkpointFailure = error; }, loadMergedPapers: () => [],
    },
    execFile: async (_file, _args, options: ChildOptions) => {
      options.onStderr?.(`__ARXIV_PROGRESS__=${JSON.stringify(deferredProgress)}\n`);
      throw Object.assign(new Error('OpenCLI child exited with code 1'), { code: 1 });
    },
  }), (caught: unknown) => {
    const error = caught as Error & { code?: string; retryNotBefore?: string; diagnostic?: string };
    assert.equal(error.code, 'ARXIV_CAPACITY_LIMITED');
    assert.equal(error.retryNotBefore, deferredProgress.retryNotBefore);
    assert.equal(error.diagnostic, deferredProgress.diagnostic);
    assert.equal(checkpointFailure, error);
    return true;
  });

  assert.equal(progress.find((event) => event.type === 'discovery-deferred')?.retryNotBefore, deferredProgress.retryNotBefore);
});

test('promotes the structured child transport marker to a safe route-aware error', async () => {
  const marker = {
    type: 'discovery-transport-failed', attempt: 2, maxAttempts: 6, waitMs: 0,
    transportCode: 'ECONNREFUSED',
  };
  await assert.rejects(() => runHarvestShards([
    { key: 'transport', track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv, network: { openCliProxyMode: 'direct', arxivApiBase: 'https://arxiv.org/api/query' },
    checkpoint: {
      completedKeys: new Set(), start: () => undefined, complete: () => undefined,
      fail: (_shard, _index, error) => { assert.equal((error as Error & { code?: string }).code, 'ARXIV_TRANSPORT_UNAVAILABLE'); },
      loadMergedPapers: () => [],
    },
    execFile: async (_file, _args, options: ChildOptions) => {
      options.onStderr?.(`__ARXIV_PROGRESS__=${JSON.stringify(marker)}\n`);
      throw Object.assign(new Error('child failed with private proxy details'), { code: 1 });
    },
  }), (caught: unknown) => {
    const error = caught as Error & { code?: string };
    assert.equal(error.code, 'ARXIV_TRANSPORT_UNAVAILABLE');
    assert.match(error.message, /direct route/);
    assert.match(error.message, /arxiv\.org/);
    assert.doesNotMatch(error.message, /private proxy/);
    return true;
  });
});

test('preserves a generic arXiv request-rate deferral across the child-process boundary', async () => {
  const progress: Progress[] = [];
  await assert.rejects(() => runHarvestShards([
    { key: 'request-rate', track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv,
    onProgress: (event: Progress) => progress.push(event),
    checkpoint: {
      completedKeys: new Set(), start: () => undefined, complete: () => undefined,
      fail: () => undefined, loadMergedPapers: () => [],
    },
    execFile: async (_file, _args, options: ChildOptions) => {
      options.onStderr?.(`__ARXIV_PROGRESS__=${JSON.stringify(requestRateDeferredProgress)}\n`);
      throw Object.assign(new Error('OpenCLI child exited with code 1'), { code: 1 });
    },
  }), (caught: unknown) => {
    const error = caught as Error & { code?: string; rateLimitKind?: string };
    assert.equal(error.code, 'ARXIV_CAPACITY_LIMITED');
    assert.equal(error.rateLimitKind, 'request-rate');
    return true;
  });
  assert.equal(progress.find((event) => event.type === 'discovery-deferred')?.rateLimitKind, 'request-rate');
});

test('deferred marker never masks unconfirmed managed-process cleanup', async () => {
  let checkpointFailure: unknown;
  await assert.rejects(() => runHarvestShards([
    { key: 'cleanup', track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv, tempRoot, processContext,
    checkpoint: {
      completedKeys: new Set(), start: () => undefined, complete: () => undefined,
      fail: (_shard, _index, error) => { checkpointFailure = error; }, loadMergedPapers: () => [],
    },
    managedProcess: managedProcessWithDeferred({
      reason: 'exit', exitCode: 1, stdout: '', stderr: 'child failed', cleanupConfirmed: false,
      pid: 123, elapsedMs: 10, activePids: [123],
    }),
  }), (caught: unknown) => {
    const error = caught as Error & { code?: string; cleanupConfirmed?: boolean };
    assert.equal(error.code, 'PROCESS_CLEANUP_UNCONFIRMED');
    assert.equal(error.cleanupConfirmed, false);
    assert.equal(checkpointFailure, error);
    return true;
  });
});

test('deferred marker never masks managed non-exit process reasons', async () => {
  for (const reason of ['cancelled', 'timeout', 'output-limit', 'supervisor-error'] as const) {
    let checkpointFailure: unknown;
    await assert.rejects(() => runHarvestShards([
      { key: reason, track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 1 },
    ], { from: '2026-08-01', to: '2026-08-02' }, {
      arxiv, tempRoot, processContext,
      checkpoint: {
        completedKeys: new Set(), start: () => undefined, complete: () => undefined,
        fail: (_shard, _index, error) => { checkpointFailure = error; }, loadMergedPapers: () => [],
      },
      managedProcess: managedProcessWithDeferred({
        reason, exitCode: 1, stdout: '', stderr: `${reason} failure`, cleanupConfirmed: true,
        pid: 123, elapsedMs: 10, activePids: [],
      }),
    }), (caught: unknown) => {
      const error = caught as Error & { code?: string };
      assert.equal(error.code, `PROCESS_${reason.toUpperCase().replaceAll('-', '_')}`);
      assert.equal(checkpointFailure, error);
      return true;
    });
  }
});

test('deferred marker never masks an injected child abort', async () => {
  let checkpointFailure: unknown;
  const aborted = Object.assign(new Error('OpenCLI child aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
  await assert.rejects(() => runHarvestShards([
    { key: 'abort', track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv,
    checkpoint: {
      completedKeys: new Set(), start: () => undefined, complete: () => undefined,
      fail: (_shard, _index, error) => { checkpointFailure = error; }, loadMergedPapers: () => [],
    },
    execFile: async (_file, _args, options: ChildOptions) => {
      options.onStderr?.(`__ARXIV_PROGRESS__=${JSON.stringify(deferredProgress)}\n`);
      throw aborted;
    },
  }), (caught: unknown) => {
    assert.equal(caught, aborted);
    assert.equal(checkpointFailure, aborted);
    return true;
  });
});

test('waits the configured interval between shard subprocesses', async () => {
  const waits: number[] = [];
  const commands: string[][] = [];
  const stdout = JSON.stringify({ schemaVersion: 1, dateMode: 'submitted', papers: [] });
  await runHarvestShards([
    { track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 100 },
    { track: 'B', dateMode: 'submitted', query: 'all:b', categories: ['cs.SE'], maxResults: 100 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv: { ...arxiv, requestIntervalMs: 3100 },
    sleep: async (ms: number) => waits.push(ms),
    execFile: async (_file: string, args: string[]) => {
      commands.push(args);
      return { stdout: stdout.replace('"submitted"', JSON.stringify(args[args.indexOf('--date-mode') + 1])) };
    },
  });
  assert.deepEqual(waits, [3100]);
  assert.deepEqual(commands.map((args) => args[args.indexOf('--request-interval-ms') + 1]), ['3100', '3100']);
});

test('reports shard progress with cumulative unique paper counts and elapsed time', async () => {
  const progress: Progress[] = [];
  const ticks = [0, 0, 100, 100, 250];
  const responses = [
    [{ baseId: '1', arxivId: '1v1', version: 1 }],
    [{ baseId: '1', arxivId: '1v1', version: 1 }, { baseId: '2', arxivId: '2v1', version: 1 }],
  ];
  await runHarvestShards([
    { track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 100 },
    { track: 'B', dateMode: 'updated', query: 'all:b', categories: ['cs.PL'], maxResults: 100 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv: { ...arxiv, requestIntervalMs: 3000 },
    sleep: async () => undefined,
    clock: () => { const tick = ticks.shift(); assert.notEqual(tick, undefined); return tick!; },
    onProgress: (event: Progress) => progress.push(event),
    execFile: async (_file: string, args: string[]) => ({
      stdout: JSON.stringify({
        schemaVersion: 1,
        dateMode: args[args.indexOf('--date-mode') + 1],
        papers: responses.shift(),
      }),
    }),
  });

  assert.deepEqual(progress, [
    { type: 'discovery-shard-start', phase: 'discovery', current: 1, total: 2, track: 'A', dateMode: 'submitted', categories: ['cs.SE'], totalElapsedMs: 0 },
    { type: 'discovery-shard-complete', phase: 'discovery', current: 1, total: 2, track: 'A', dateMode: 'submitted', categories: ['cs.SE'], shardPaperCount: 1, discoveredCount: 1, elapsedMs: 100, totalElapsedMs: 100 },
    { type: 'discovery-shard-start', phase: 'discovery', current: 2, total: 2, track: 'B', dateMode: 'updated', categories: ['cs.PL'], totalElapsedMs: 100 },
    { type: 'discovery-shard-complete', phase: 'discovery', current: 2, total: 2, track: 'B', dateMode: 'updated', categories: ['cs.PL'], shardPaperCount: 2, discoveredCount: 2, elapsedMs: 150, totalElapsedMs: 250 },
  ]);
});

test('reports the active shard and elapsed time when OpenCLI fails', async () => {
  const progress: Progress[] = [];
  const ticks = [0, 0, 75];
  await assert.rejects(() => runHarvestShards([
    { track: 'A', dateMode: 'updated', query: 'all:a', categories: ['cs.SE'], maxResults: 100 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv: { ...arxiv, requestIntervalMs: 3000 },
    clock: () => { const tick = ticks.shift(); assert.notEqual(tick, undefined); return tick!; },
    onProgress: (event: Progress) => progress.push(event),
    execFile: async () => { throw new Error('network unavailable'); },
  }), /network unavailable/);
  assert.deepEqual(progress.at(-1), {
    type: 'discovery-shard-failed', phase: 'discovery', current: 1, total: 1,
    track: 'A', dateMode: 'updated', categories: ['cs.SE'],
    error: 'network unavailable', elapsedMs: 75, totalElapsedMs: 75,
  });
});

test('skips completed checkpoint shards and returns all persisted papers', async () => {
  const calls: string[] = [];
  const progress: Progress[] = [];
  const persisted = {
    baseId: 'persisted', arxivId: 'persistedv1', version: 1, title: 'Persisted',
    authors: ['Persisted Author'], categories: ['cs.SE'], published: '2026-08-01T00:00:00Z', updated: '2026-08-01T00:00:00Z',
  };
  const fresh = {
    baseId: 'fresh', arxivId: 'freshv1', version: 1, title: 'Fresh',
    authors: ['Fresh Author'], categories: ['cs.PL'], published: '2026-08-01T00:00:00Z', updated: '2026-08-01T00:00:00Z',
  };
  const checkpoint = {
    completedKeys: new Set(['key-1']),
    start: (shard: { key: string }) => calls.push(`start:${shard.key}`),
    complete: (shard: { key: string }) => calls.push(`complete:${shard.key}`),
    fail: (shard: { key: string }) => calls.push(`fail:${shard.key}`),
    loadMergedPapers: () => [persisted, fresh],
  };

  const result = await runHarvestShards([
    { key: 'key-1', track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 1 },
    { key: 'key-2', track: 'B', dateMode: 'updated', query: 'all:b', categories: ['cs.PL'], maxResults: 1 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv,
    checkpoint,
    sleep: async () => undefined,
    onProgress: (event: Progress) => progress.push(event),
    execFile: async (_file: string, args: string[]) => {
      calls.push(`exec:${args[args.indexOf('--track') + 1]}`);
      return { stdout: JSON.stringify({ schemaVersion: 1, dateMode: 'updated', papers: [fresh] }) };
    },
  });

  assert.deepEqual(calls, ['start:key-2', 'exec:B', 'complete:key-2']);
  assert.deepEqual(progress.map((event: Progress) => event.type), [
    'discovery-shard-skipped',
    'discovery-shard-start',
    'discovery-shard-complete',
  ]);
  assert.deepEqual(result, [persisted, fresh]);
});

test('marks the active checkpoint shard failed without changing runner retry options', async () => {
  const calls: string[] = [];
  const checkpoint = {
    completedKeys: new Set<string>(),
    start: (shard: { key: string }) => calls.push(`start:${shard.key}`),
    complete: (shard: { key: string }) => calls.push(`complete:${shard.key}`),
    fail: (shard: { key: string }, index: number, error: unknown) => { assert.ok(error instanceof Error); return calls.push(`fail:${shard.key}:${index}:${error.message}`); },
    loadMergedPapers: () => [],
  };
  await assert.rejects(() => runHarvestShards([
    { key: 'key-1', track: 'A', dateMode: 'submitted', query: 'all:a', categories: ['cs.SE'], maxResults: 7 },
  ], { from: '2026-08-01', to: '2026-08-02' }, {
    arxiv,
    checkpoint,
    execFile: async (_file: string, args: string[]) => {
      assert.equal(args[args.indexOf('--max-results') + 1], '7');
      assert.equal(args[args.indexOf('--max-attempts') + 1], '6');
      throw new Error('Rate exceeded');
    },
  }), /Rate exceeded/);
  assert.deepEqual(calls, ['start:key-1', 'fail:key-1:0:Rate exceeded']);
});
