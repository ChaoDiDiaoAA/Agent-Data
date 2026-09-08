import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer as createTcpServer, type Socket } from 'node:net';
import type { runMineruCli } from '../src/mineru/mineru-cli-runner.ts';
import type { MinerUCliConfig } from '../src/types/config.ts';
import type { MinerUCliJob, MinerUExecution } from '../src/types/jobs.ts';
import type { ManagedProcessResult, ManagedProcessSpec, ProcessContext, runManagedProcess } from '../src/runtime/process.ts';
import { createMineruApiSession } from '../src/mineru/mineru-api-session.ts';
import { buildMinerUProcessEnv } from '../src/mineru/mineru-cli-runner.ts';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';

type ManagedProcessOptions = Parameters<typeof runManagedProcess>[1];
type ClientRunResult = MinerUExecution;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function baseResult(partial: Partial<ManagedProcessResult> = {}): ManagedProcessResult {
  return {
    reason: 'exit',
    exitCode: 0,
    cleanupConfirmed: true,
    stdout: '',
    stderr: '',
    elapsedMs: 1,
    pid: 999,
    activePids: [],
    ...partial,
  };
}

function healthyPayload(config: Pick<MinerUCliConfig, 'maxConcurrency' | 'processingWindowSize'>) {
  return {
    status: 'healthy',
    protocol_version: 2,
    max_concurrent_requests: config.maxConcurrency,
    processing_window_size: config.processingWindowSize,
  };
}

function clientResult(job: MinerUCliJob, config: Pick<MinerUCliConfig, 'cliBackend' | 'taskTimeoutMs'>): ClientRunResult {
  return {
    exitCode: 0,
    cleanupConfirmed: true,
    elapsedMs: 1,
    stdoutSummary: '',
    stderrSummary: '',
    errorCode: null,
    timedOut: false,
  };
}

function createManagedProcessDouble(options: {
  onLaunch?: (launch: {
    spec: ManagedProcessSpec;
    signal: AbortSignal | undefined;
    resolve(result?: Partial<ManagedProcessResult>): void;
    reject(error: unknown): void;
    stderr(chunk: string): void;
    aborted(): boolean;
  }) => void;
} = {}) {
  const launches: {
    spec: ManagedProcessSpec;
    signal: AbortSignal | undefined;
    finish: ReturnType<typeof deferred<ManagedProcessResult>>;
    aborted: boolean;
  }[] = [];
  const managedProcess: typeof runManagedProcess = (async (spec: ManagedProcessSpec, processOptions: ManagedProcessOptions = {}) => {
    const finish = deferred<ManagedProcessResult>();
    const launch = { spec, signal: processOptions.signal, finish, aborted: false };
    launches.push(launch);
    processOptions.onEvent?.({
      v: 1,
      id: `launch-${launches.length}`,
      kind: 'started',
      pid: 1000 + launches.length,
      startedAt: new Date().toISOString(),
      jobName: `job-${launches.length}`,
    });
    if (processOptions.signal) {
      if (processOptions.signal.aborted) launch.aborted = true;
      processOptions.signal.addEventListener('abort', () => { launch.aborted = true; }, { once: true });
    }
    options.onLaunch?.({
      spec,
      signal: processOptions.signal,
      resolve(result = {}) {
        finish.resolve(baseResult({ ...result, pid: 1000 + launches.length }));
      },
      reject(error) {
        finish.reject(error);
      },
      stderr(chunk) {
        processOptions.onStderr?.(chunk);
      },
      aborted() {
        return launch.aborted;
      },
    });
    return await finish.promise;
  }) as typeof runManagedProcess;
  return { managedProcess, launches };
}

async function withSessionFixture(run: (context: {
  config: MinerUCliConfig;
  processContext: ProcessContext;
  job: MinerUCliJob;
  root: string;
  stateRoot: string;
  tempRoot: string;
}) => Promise<void>) {
  const fixture = await makeRuntimeFixture();
  const config: MinerUCliConfig = {
    sourceRoot: join(fixture.root, 'MinerU'),
    venvRoot: join(fixture.root, 'MinerU', '.venv'),
    tempRoot: fixture.paths.tempRoot,
    model: 'pipeline',
    cliBackend: 'pipeline',
    modelSourceRuntime: 'local',
    mineruToolsConfig: join(fixture.root, 'mineru.runtime.json'),
    modelScopeCacheRoot: join(fixture.root, 'modelscope'),
    taskTimeoutMs: 3_600_000,
    resultDownloadTimeoutMs: 600_000,
    maxConcurrency: 1,
    processingWindowSize: 1,
    pipelineBatchRatio: 1,
    vlmBatchSize: 1,
    vlmCacheMaxEntryCount: 0.5,
    apiHost: '127.0.0.1',
    apiPort: 17_860,
    apiStartupTimeoutMs: 500,
    pipelineMethod: 'auto',
    pipelineLanguage: 'ch',
    formulaEnabled: true,
    tableEnabled: true,
    cudaVisibleDevices: '0',
    pipelineDeviceMode: 'cuda',
    vlmDevice: 'cuda',
    vlmLmdeployBackend: 'turbomind',
  };
  const processContext: ProcessContext = {
    safetyRoot: join(fixture.paths.stateRoot, 'locks', 'processes'),
    policy: { processCleanupTimeoutMs: 1_800, diagnosticTimeoutMs: 5_000, maxOutputBytes: 16_384 },
  };
  const job: MinerUCliJob = {
    arxivId: '2401.00001',
    model: 'pipeline',
    fileSource: join(fixture.paths.pdfRoot, 'paper.pdf'),
    outputDir: join(fixture.paths.tempRoot, 'job-output'),
  };
  try {
    await run({
      config,
      processContext,
      job,
      root: fixture.root,
      stateRoot: fixture.paths.stateRoot,
      tempRoot: fixture.paths.tempRoot,
    });
  } finally {
    await fixture.dispose();
  }
}

async function withHealthListener(
  respond: (socket: Socket) => void,
  run: (port: number, closed: Promise<void>, received: Promise<void>) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  const closed = deferred<void>();
  const received = deferred<void>();
  const server = createTcpServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); closed.resolve(); });
    socket.once('data', () => { received.resolve(); respond(socket); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(address.port, closed.promise, received.promise); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function within<T>(promise: Promise<T>, ms = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture deadline exceeded')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

test('silent health connection times out and closes its socket when startup fails', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    await withHealthListener(() => {}, async (apiPort, closed) => {
      const processes = createManagedProcessDouble({ onLaunch(launch) {
        launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled' }), { once: true });
      } });
      const session = createMineruApiSession({ config: { ...config, apiPort, apiStartupTimeoutMs: 100 }, processContext,
        dependencies: { checkPortAvailable: async () => {}, managedProcess: processes.managedProcess } });
      try {
        await assert.rejects(within(session.ensureReady()), /MINERU_API_STARTUP_TIMEOUT|did not become healthy/);
        await within(closed);
        assert.equal(processes.launches[0].aborted, true);
      } finally { await session.dispose(); }
    });
  });
});

test('stalled health probes are closed before retrying and a later healthy response can start the session', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    let requests = 0;
    let closedStalls = 0;
    const body = JSON.stringify(healthyPayload(config));
    await withHealthListener(socket => {
      requests += 1;
      if (requests <= 2) {
        socket.once('close', () => { closedStalls += 1; });
      } else {
        assert.equal(closedStalls, 2);
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      }
    }, async apiPort => {
      const processes = createManagedProcessDouble({ onLaunch(launch) {
        launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled' }), { once: true });
      } });
      const session = createMineruApiSession({ config: { ...config, apiPort, apiStartupTimeoutMs: 5000 }, processContext,
        dependencies: { checkPortAvailable: async () => {}, managedProcess: processes.managedProcess } });
      try {
        assert.equal(await within(session.ensureReady(), 4000), `http://127.0.0.1:${apiPort}`);
        assert.equal(requests, 3);
      } finally { await session.dispose(); }
    });
  });
});

test('health response exceeding 16 KiB is disconnected without waiting for the body to finish', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    await withHealthListener(socket => {
      socket.write(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4001\r\n${' '.repeat(16385)}\r\n`);
    }, async (apiPort, closed) => {
      const processes = createManagedProcessDouble({ onLaunch(launch) {
        launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled' }), { once: true });
      } });
      const session = createMineruApiSession({ config: { ...config, apiPort, apiStartupTimeoutMs: 5000 }, processContext,
        dependencies: { checkPortAvailable: async () => {}, managedProcess: processes.managedProcess } });
      const ready = session.ensureReady();
      void ready.catch(() => {});
      try { await within(closed, 500); }
      finally { await session.dispose(); await assert.rejects(within(ready)); }
    });
  });
});

for (const termination of ['dispose', 'caller abort', 'server exit'] as const) {
  test(`${termination} cancels an in-flight health request and closes its socket`, async () => {
    await withSessionFixture(async ({ config, processContext }) => {
      await withHealthListener(() => {}, async (apiPort, closed, received) => {
        const controller = new AbortController();
        const processes = createManagedProcessDouble({ onLaunch(launch) {
          launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled' }), { once: true });
        } });
        const session = createMineruApiSession({ config: { ...config, apiPort, apiStartupTimeoutMs: 5000 }, processContext,
          signal: controller.signal,
          dependencies: { checkPortAvailable: async () => {}, managedProcess: processes.managedProcess } });
        const ready = session.ensureReady();
        void ready.catch(() => {});
        try {
          await within(received);
          if (termination === 'dispose') await session.dispose();
          else if (termination === 'caller abort') controller.abort();
          else processes.launches[0].finish.resolve(baseResult({ exitCode: 1 }));
          await assert.rejects(within(ready, 500));
          await within(closed, 500);
        } finally { await session.dispose(); }
      });
    });
  });
}

for (const response of [
  'HTTP/1.1 503 Unavailable\r\nContent-Length: 1000000\r\n\r\n',
  'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: keep-alive\r\n\r\n{',
] as const) {
  test(`failed health response closes a keep-alive socket: ${response.slice(0, 12)}`, async () => {
    await withSessionFixture(async ({ config, processContext }) => {
      await withHealthListener(socket => { socket.write(response); }, async (apiPort, closed) => {
        const processes = createManagedProcessDouble({ onLaunch(launch) {
          launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled' }), { once: true });
        } });
        const session = createMineruApiSession({ config: { ...config, apiPort, apiStartupTimeoutMs: 5000 }, processContext,
          dependencies: { checkPortAvailable: async () => {}, managedProcess: processes.managedProcess } });
        const ready = session.ensureReady();
        void ready.catch(() => {});
        try { await within(closed, 500); }
        finally { await session.dispose(); await assert.rejects(within(ready)); }
      });
    });
  });
}

test('MinerU child environment always excludes loopback from inherited proxies', async () => {
  await withSessionFixture(async ({ config }) => {
    const before = { ...process.env };
    const env = buildMinerUProcessEnv(config);
    for (const key of process.platform === 'win32' ? ['NO_PROXY'] : ['NO_PROXY', 'no_proxy']) {
      for (const host of ['127.0.0.1', 'localhost', '::1']) assert.ok(env[key]?.split(',').includes(host));
      assert.equal(new Set(env[key].split(',')).size, env[key].split(',').length);
    }
    if (process.platform === 'win32') assert.equal(new Set(Object.keys(env).map(key => key.toUpperCase())).size, Object.keys(env).length);
    assert.equal(env.HTTP_PROXY, process.env.HTTP_PROXY);
    assert.deepEqual({ ...process.env }, before);
  });
});

test('MinerU health request bypasses an inherited proxy with no loopback exclusions', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json(healthyPayload(config)) });
    let proxyRequests = 0;
    const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
      proxyRequests += 1;
      return Response.json({ status: 'wrong server' });
    } });
    const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
    const inherited = { ...process.env };
    for (const key of keys) process.env[key] = key.toLowerCase() === 'no_proxy' ? '' : `http://127.0.0.1:${proxy.port}`;
    const processes = createManagedProcessDouble({ onLaunch(launch) {
      launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled' }), { once: true });
    } });
    const session = createMineruApiSession({ config: { ...config, apiPort: server.port! }, processContext,
      dependencies: { checkPortAvailable: async () => {}, managedProcess: processes.managedProcess } });
    try {
      assert.equal(await session.ensureReady(), `http://127.0.0.1:${server.port}`);
      assert.equal(proxyRequests, 0);
    } finally {
      for (const key of keys) delete process.env[key];
      for (const [key, value] of Object.entries(inherited)) if (keys.includes(key) && value !== undefined) process.env[key] = value;
      await session.dispose(); await server.stop(true); await proxy.stop(true);
    }
  });
});

test('two concurrent ensureReady calls launch one server and resolve the same URL', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    const processes = createManagedProcessDouble({
      onLaunch(launch) {
        launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled' }), { once: true });
      },
    });
    let fetches = 0;
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {},
        fetchHealth: async (url) => {
          fetches += 1;
          assert.equal(url, 'http://127.0.0.1:17860/health');
          return healthyPayload(config);
        },
        managedProcess: processes.managedProcess,
        runClient: async () => {
          throw new Error('runClient should not be called by ensureReady');
        },
        sleep: async () => {},
      },
    });

    const [first, second] = await Promise.all([session.ensureReady(), session.ensureReady()]);
    assert.equal(first, 'http://127.0.0.1:17860');
    assert.equal(second, first);
    assert.equal(processes.launches.length, 1);
    assert.equal(fetches, 1);

    await session.dispose();
  });
});

test('two sequential run calls launch one server and invoke two clients with exactly the same URL', async () => {
  await withSessionFixture(async ({ config, processContext, job }) => {
    const processes = createManagedProcessDouble({
      onLaunch(launch) {
        launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled' }), { once: true });
      },
    });
    const apiUrls: string[] = [];
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {},
        fetchHealth: async () => healthyPayload(config),
        managedProcess: processes.managedProcess,
        runClient: async (_job, options) => {
          apiUrls.push(options.apiUrl ?? '');
          return clientResult(_job, options.config);
        },
        sleep: async () => {},
      },
    });

    const first = await session.run(job);
    const second = await session.run({ ...job, arxivId: '2401.00002', outputDir: join(processContext.safetyRoot, 'next-output') });
    assert.equal(first.exitCode, 0);
    assert.equal(second.exitCode, 0);
    assert.equal(processes.launches.length, 1);
    assert.deepEqual(apiUrls, ['http://127.0.0.1:17860', 'http://127.0.0.1:17860']);

    await session.dispose();
  });
});

test('failed client result keeps separate bounded redacted client and API diagnostics', async () => {
  await withSessionFixture(async ({ config, processContext, job }) => {
    const processes = createManagedProcessDouble({
      onLaunch(launch) {
        launch.stderr('API Layout Predict failed password=server-secret\n');
        launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled' }), { once: true });
      },
    });
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {},
        fetchHealth: async () => healthyPayload(config),
        managedProcess: processes.managedProcess,
        runClient: async (currentJob, options) => ({
          ...clientResult(currentJob, options.config),
          exitCode: 1,
          stderrSummary: 'client httpx.ReadTimeout token=client-secret',
        }),
        sleep: async () => {},
      },
    });

    const result = await session.run(job);
    assert.match(result.clientStderrSummary ?? '', /client httpx\.ReadTimeout/);
    assert.match(result.apiStderrSummary ?? '', /API Layout Predict failed/);
    assert.match(result.stderrSummary ?? '', /\[MinerU client\]/);
    assert.match(result.stderrSummary ?? '', /\[MinerU API\]/);
    assert.doesNotMatch(JSON.stringify(result), /server-secret|client-secret/);
    assert.ok((result.stderrSummary?.length ?? 0) <= 4000);

    await session.dispose();
  });
});

test('launch spec uses python fast_api with shared env, metadata, and dedicated safety root', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    const portChecks: Array<{ host: '127.0.0.1'; port: number }> = [];
    const processes = createManagedProcessDouble({
      onLaunch(launch) {
        launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled' }), { once: true });
      },
    });
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async (host, port) => {
          portChecks.push({ host, port });
        },
        fetchHealth: async () => healthyPayload(config),
        managedProcess: processes.managedProcess,
        runClient: async () => {
          throw new Error('runClient should not be called');
        },
        sleep: async () => {},
      },
    });

    await session.ensureReady();
    assert.deepEqual(portChecks, [{ host: '127.0.0.1', port: 17_860 }]);
    assert.equal(processes.launches.length, 1);
    const [launch] = processes.launches;
    assert.equal(launch.spec.executable, join(config.venvRoot, 'Scripts', 'python.exe'));
    assert.deepEqual(launch.spec.args, ['-m', 'mineru.cli.fast_api', '--host', '127.0.0.1', '--port', '17860']);
    assert.equal(launch.spec.timeoutMs, null);
    assert.equal(launch.spec.cwd, config.sourceRoot);
    assert.equal(launch.spec.env.PYTHONUTF8, '1');
    assert.equal(launch.spec.env.PYTHONIOENCODING, 'utf-8');
    assert.equal(launch.spec.env.CUDA_VISIBLE_DEVICES, '0');
    assert.equal(launch.spec.env.MINERU_DEVICE_MODE, 'cuda');
    assert.equal(launch.spec.env.MINERU_API_MAX_CONCURRENT_REQUESTS, '1');
    assert.equal(launch.spec.env.MINERU_PROCESSING_WINDOW_SIZE, '1');
    assert.equal(launch.spec.env.MINERU_VIRTUAL_VRAM_SIZE, '5');
    assert.deepEqual(launch.spec.recordMetadata, { kind: 'mineru-api', host: '127.0.0.1', port: 17_860 });
    assert.equal(launch.spec.safetyRoot, join(dirname(processContext.safetyRoot), 'mineru-api-process'));

    await session.dispose();
  });
});

test('dispose before first use makes no dependency call', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    let calls = 0;
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => { calls += 1; },
        fetchHealth: async () => {
          calls += 1;
          return healthyPayload(config);
        },
        managedProcess: (async () => {
          calls += 1;
          return baseResult();
        }) as typeof runManagedProcess,
        runClient: async () => {
          calls += 1;
          throw new Error('runClient should not be called');
        },
        sleep: async () => { calls += 1; },
      },
    });

    await session.dispose();
    assert.equal(calls, 0);
  });
});

test('dispose after start aborts the server and succeeds only with confirmed cleanup', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    let aborted = false;
    const processes = createManagedProcessDouble({
      onLaunch(launch) {
        launch.signal?.addEventListener('abort', () => {
          aborted = true;
          launch.resolve({ reason: 'cancelled', cleanupConfirmed: true });
        }, { once: true });
      },
    });
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {},
        fetchHealth: async () => healthyPayload(config),
        managedProcess: processes.managedProcess,
        runClient: async () => {
          throw new Error('runClient should not be called');
        },
        sleep: async () => {},
      },
    });

    await session.ensureReady();
    await session.dispose();
    assert.equal(aborted, true);
  });
});

test('dispose after start rejects with PROCESS_CLEANUP_UNCONFIRMED when abort cleanup is unconfirmed', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    let aborted = false;
    const processes = createManagedProcessDouble({
      onLaunch(launch) {
        launch.signal?.addEventListener('abort', () => {
          aborted = true;
          launch.resolve({ reason: 'cancelled', cleanupConfirmed: false, activePids: [1001] });
        }, { once: true });
      },
    });
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {},
        fetchHealth: async () => healthyPayload(config),
        managedProcess: processes.managedProcess,
        runClient: async () => {
          throw new Error('runClient should not be called');
        },
        sleep: async () => {},
      },
    });

    await session.ensureReady();
    await assert.rejects(() => session.dispose(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PROCESS_CLEANUP_UNCONFIRMED');
      return true;
    });
    assert.equal(aborted, true);
  });
});

test('occupied port throws MINERU_API_PORT_IN_USE and never invokes managedProcess', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    let launchCount = 0;
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {
          throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
        },
        fetchHealth: async () => healthyPayload(config),
        managedProcess: (async () => {
          launchCount += 1;
          return baseResult();
        }) as typeof runManagedProcess,
        runClient: async () => {
          throw new Error('runClient should not be called');
        },
        sleep: async () => {},
      },
    });

    await assert.rejects(() => session.ensureReady(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'MINERU_API_PORT_IN_USE');
      return true;
    });
    assert.equal(launchCount, 0);
  });
});

test('startup timeout aborts, awaits cleanup, and throws MINERU_API_STARTUP_TIMEOUT', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    let aborted = false;
    let sleeps = 0;
    const processes = createManagedProcessDouble({
      onLaunch(launch) {
        launch.signal?.addEventListener('abort', () => {
          aborted = true;
          launch.resolve({ reason: 'cancelled', cleanupConfirmed: true });
        }, { once: true });
      },
    });
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {},
        fetchHealth: async () => ({ status: 'starting' }),
        managedProcess: processes.managedProcess,
        runClient: async () => {
          throw new Error('runClient should not be called');
        },
        sleep: async () => {
          sleeps += 1;
        },
      },
    });

    await assert.rejects(() => session.ensureReady(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'MINERU_API_STARTUP_TIMEOUT');
      return true;
    });
    assert.equal(aborted, true);
    assert.ok(sleeps >= 2);
  });
});

test('wrong health status, protocol, concurrency, or processing window never become ready', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    for (const payload of [
      { status: 'starting', protocol_version: 2, max_concurrent_requests: 1, processing_window_size: 1 },
      { status: 'healthy', protocol_version: 1, max_concurrent_requests: 1, processing_window_size: 1 },
      { status: 'healthy', protocol_version: 2, max_concurrent_requests: 2, processing_window_size: 1 },
      { status: 'healthy', protocol_version: 2, max_concurrent_requests: 1, processing_window_size: 2 },
    ]) {
      const processes = createManagedProcessDouble({
        onLaunch(launch) {
          launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled', cleanupConfirmed: true }), { once: true });
        },
      });
      const session = createMineruApiSession({
        config: { ...config, apiStartupTimeoutMs: 250 },
        processContext,
        dependencies: {
          checkPortAvailable: async () => {},
          fetchHealth: async () => payload,
          managedProcess: processes.managedProcess,
          runClient: async () => {
            throw new Error('runClient should not be called');
          },
          sleep: async () => {},
        },
      });

      await assert.rejects(() => session.ensureReady(), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'MINERU_API_STARTUP_TIMEOUT');
        return true;
      });
      assert.equal(processes.launches.length, 1);
    }
  });
});

test('server exit before readiness throws MINERU_API_UNAVAILABLE', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    const processes = createManagedProcessDouble();
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {},
        fetchHealth: async () => await new Promise<never>(() => {}),
        managedProcess: processes.managedProcess,
        runClient: async () => {
          throw new Error('runClient should not be called');
        },
        sleep: async () => {},
      },
    });

    const pending = session.ensureReady();
    for (let index = 0; index < 20 && processes.launches.length === 0; index += 1) await Promise.resolve();
    assert.equal(processes.launches.length, 1);
    processes.launches[0]?.finish.resolve(baseResult({ reason: 'exit', exitCode: 1, cleanupConfirmed: true }));
    await assert.rejects(() => pending, (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'MINERU_API_UNAVAILABLE');
      return true;
    });
  });
});

test('after a server crash the current request is not replayed and the operation session cannot restart the API', async () => {
  await withSessionFixture(async ({ config, processContext, job }) => {
    const firstClient = deferred<ClientRunResult>();
    const calls: string[] = [];
    const processes = createManagedProcessDouble({
      onLaunch(launch) {
        launch.signal?.addEventListener('abort', () => launch.resolve({ reason: 'cancelled', cleanupConfirmed: true }), { once: true });
      },
    });
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {},
        fetchHealth: async () => healthyPayload(config),
        managedProcess: processes.managedProcess,
        runClient: async (currentJob, options) => {
          calls.push(`${currentJob.arxivId}:${options.apiUrl}`);
          if (calls.length === 1) return await firstClient.promise;
          return clientResult(currentJob, options.config);
        },
        sleep: async () => {},
      },
    });

    const firstRun = session.run(job);
    for (let index = 0; index < 20 && calls.length === 0; index += 1) await Promise.resolve();
    assert.deepEqual(calls, ['2401.00001:http://127.0.0.1:17860']);

    processes.launches[0]?.finish.resolve(baseResult({ reason: 'exit', exitCode: 1, cleanupConfirmed: true }));
    await assert.rejects(() => firstRun, (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'MINERU_API_UNAVAILABLE');
      return true;
    });
    assert.equal(calls.length, 1);

    firstClient.resolve(clientResult(job, config));

    await assert.rejects(
      () => session.run({ ...job, arxivId: '2401.00002', outputDir: join(processContext.safetyRoot, 'second-output') }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'MINERU_API_UNAVAILABLE');
        return true;
      },
    );
    assert.equal(processes.launches.length, 1);
    assert.deepEqual(calls, ['2401.00001:http://127.0.0.1:17860']);

    await session.dispose();
  });
});

test('dispose reports an unconfirmed API exit that settles after the final client succeeds', async () => {
  await withSessionFixture(async ({ config, processContext, job }) => {
    const processes = createManagedProcessDouble();
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {},
        fetchHealth: async () => healthyPayload(config),
        managedProcess: processes.managedProcess,
        runClient: async (currentJob, options) => clientResult(currentJob, options.config),
        sleep: async () => {},
      },
    });

    const result = await session.run(job);
    assert.equal(result.exitCode, 0);
    processes.launches[0]?.finish.resolve(baseResult({ cleanupConfirmed: false, activePids: [1001] }));
    for (let index = 0; index < 5; index += 1) await Promise.resolve();

    await assert.rejects(() => session.dispose(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PROCESS_CLEANUP_UNCONFIRMED');
      return true;
    });
    assert.equal(processes.launches.length, 1);
  });
});

test('unconfirmed cleanup throws PROCESS_CLEANUP_UNCONFIRMED', async () => {
  await withSessionFixture(async ({ config, processContext }) => {
    const apiSafetyRoot = join(dirname(processContext.safetyRoot), 'mineru-api-process');
    await mkdir(apiSafetyRoot, { recursive: true });
    await writeFile(join(apiSafetyRoot, 'active.json'), '{malformed');
    let launchCount = 0;
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {},
        fetchHealth: async () => healthyPayload(config),
        managedProcess: (async () => {
          launchCount += 1;
          return baseResult();
        }) as typeof runManagedProcess,
        runClient: async () => {
          throw new Error('runClient should not be called');
        },
        sleep: async () => {},
      },
    });

    await assert.rejects(() => session.ensureReady(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PROCESS_CLEANUP_UNCONFIRMED');
      return true;
    });
    assert.equal(launchCount, 0);
  });
});

test('calling run after disposal rejects without launching or invoking the client', async () => {
  await withSessionFixture(async ({ config, processContext, job }) => {
    let launchCount = 0;
    let clientCalls = 0;
    const session = createMineruApiSession({
      config,
      processContext,
      dependencies: {
        checkPortAvailable: async () => {},
        fetchHealth: async () => healthyPayload(config),
        managedProcess: (async () => {
          launchCount += 1;
          return baseResult();
        }) as typeof runManagedProcess,
        runClient: async () => {
          clientCalls += 1;
          throw new Error('runClient should not be called');
        },
        sleep: async () => {},
      },
    });

    await session.dispose();
    await assert.rejects(() => session.run(job), /disposed/i);
    assert.equal(launchCount, 0);
    assert.equal(clientCalls, 0);
  });
});
