import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { get as httpGet, type ClientRequest } from 'node:http';
import type { MinerUCliConfig } from '../types/config.ts';
import type { MinerUCliJob, MinerUExecution } from '../types/jobs.ts';
import type { ManagedProcessResult, ProcessContext } from '../runtime/process.ts';
import { inspectProcessRecord, resolveProcessRecord, runManagedProcess } from '../runtime/process.ts';
import { buildMinerUProcessEnv, runMineruCli } from './mineru-cli-runner.ts';
import { pipelineBatchRatioToVirtualVram } from './mineru-local-config.ts';
import { redactErrorMessage } from '../shared/redaction.ts';

export interface MineruApiSession {
  ensureReady(): Promise<string>;
  run(job: MinerUCliJob): Promise<MinerUExecution>;
  dispose(): Promise<void>;
}

export interface MineruApiSessionDependencies {
  checkPortAvailable(host: '127.0.0.1', port: number): Promise<void>;
  fetchHealth(url: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<unknown>;
  managedProcess: typeof runManagedProcess;
  runClient: (job: MinerUCliJob, options: Parameters<typeof runMineruCli>[1]) => Promise<MinerUExecution>;
  sleep(ms: number): Promise<void>;
}

interface ServerLaunch {
  apiUrl: string;
  controller: AbortController;
  started: Promise<number>;
  resolveStarted(pid: number): void;
  rejectStarted(error: unknown): void;
  finished: Promise<ManagedProcessResult>;
  resolveFinished(result: ManagedProcessResult): void;
  rejectFinished(error: unknown): void;
  outcome?: { kind: 'result'; result: ManagedProcessResult } | { kind: 'error'; error: unknown };
}

type SessionState =
  | { kind: 'idle' }
  | { kind: 'starting'; ready: Promise<string>; launch: ServerLaunch }
  | { kind: 'ready'; apiUrl: string; launch: ServerLaunch }
  | { kind: 'ended'; launch: ServerLaunch }
  | { kind: 'disposed' };

const HEALTH_INTERVAL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 1000;
const HEALTH_BODY_LIMIT_BYTES = 16 * 1024;
const DIAGNOSTIC_PART_LIMIT = 1_900;
const API_DIAGNOSTIC_BUFFER_LIMIT = 8_000;

function diagnosticPart(value: unknown): string {
  return redactErrorMessage(String(value ?? '')).slice(-DIAGNOSTIC_PART_LIMIT);
}

function attachFailureDiagnostics<T extends { exitCode: number; stderrSummary?: string }>(result: T, apiStderrBuffer: string) {
  if (result.exitCode === 0) return result;
  const clientStderrSummary = diagnosticPart(result.stderrSummary);
  const apiStderrSummary = diagnosticPart(apiStderrBuffer);
  const sections = [
    clientStderrSummary ? `[MinerU client]\n${clientStderrSummary}` : '',
    apiStderrSummary ? `[MinerU API]\n${apiStderrSummary}` : '',
  ].filter(Boolean);
  return {
    ...result,
    clientStderrSummary,
    apiStderrSummary,
    stderrSummary: sections.join('\n').slice(-4_000),
  };
}

function sessionError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function cleanupUnconfirmedError() {
  return Object.assign(
    sessionError('PROCESS_CLEANUP_UNCONFIRMED', 'MinerU API cleanup could not be confirmed'),
    { cleanupConfirmed: false },
  );
}

function sessionDisposedError() {
  return sessionError('MINERU_API_SESSION_DISPOSED', 'MinerU API session has been disposed');
}

function apiUnavailableError(message: string) {
  return sessionError('MINERU_API_UNAVAILABLE', message);
}

function isHealthyPayload(value: unknown, config: Pick<MinerUCliConfig, 'maxConcurrency' | 'processingWindowSize'>) {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return payload.status === 'healthy'
    && payload.protocol_version === 2
    && payload.max_concurrent_requests === config.maxConcurrency
    && payload.processing_window_size === config.processingWindowSize;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function cancelledLaunchResult(): ManagedProcessResult {
  return {
    reason: 'cancelled',
    exitCode: 0,
    stdout: '',
    stderr: '',
    cleanupConfirmed: true,
    pid: null,
    elapsedMs: 0,
    activePids: [],
  };
}

function createServerLaunch(apiUrl: string): ServerLaunch {
  const started = createDeferred<number>();
  const finished = createDeferred<ManagedProcessResult>();
  return {
    apiUrl,
    controller: new AbortController(),
    started: started.promise,
    resolveStarted: started.resolve,
    rejectStarted: started.reject,
    finished: finished.promise,
    resolveFinished: finished.resolve,
    rejectFinished: finished.reject,
  };
}

async function defaultCheckPortAvailable(host: '127.0.0.1', port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    const done = (error?: Error | null) => {
      server.removeAllListeners();
      if (error) reject(error);
      else resolve();
    };
    server.once('error', (error) => {
      void server.close();
      done(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => done(error ?? null));
    });
  });
}

async function defaultFetchHealth(url: string, { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number }): Promise<unknown> {
  // Bun fetch inherits proxies even with proxy: ''; node:http keeps this loopback probe direct.
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  let request: ClientRequest | undefined;
  try {
    return await new Promise((resolve, reject) => {
      request = httpGet(url, { signal: controller.signal, agent: false }, response => {
        const read = async () => {
          if (response.statusCode !== 200) {
            throw new Error(`MinerU health probe failed: ${response.statusCode}`);
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > HEALTH_BODY_LIMIT_BYTES) throw new Error('MinerU health response exceeds 16 KiB');
            chunks.push(buffer);
          }
          return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        };
        void read().then(resolve, reject);
      }).once('error', reject);
    });
  } finally {
    request?.destroy();
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function ensureCleanupRecordClear(safetyRoot: string): Promise<void> {
  const recordPath = join(safetyRoot, 'active.json');
  if (!existsSync(recordPath)) return;
  let inspection;
  try {
    inspection = await inspectProcessRecord(recordPath);
  } catch {
    throw cleanupUnconfirmedError();
  }
  if (inspection.ownerAlive || !inspection.cleanupConfirmed) throw cleanupUnconfirmedError();
  let resolved;
  try {
    resolved = await resolveProcessRecord(recordPath);
  } catch {
    throw cleanupUnconfirmedError();
  }
  if (!resolved.resolved) throw cleanupUnconfirmedError();
}

function syncStateWithSettledLaunch(state: SessionState): SessionState {
  if ((state.kind === 'starting' || state.kind === 'ready') && state.launch.outcome) return { kind: 'ended', launch: state.launch };
  return state;
}

function unavailableFromEndedLaunch(launch: ServerLaunch): never {
  if (launch.outcome?.kind === 'result') {
    unavailableFromLaunchResult(launch.outcome.result, 'MinerU API is no longer available for this operation');
  }
  throw cleanupUnconfirmedError();
}

async function waitForLaunchResult(launch: ServerLaunch): Promise<ManagedProcessResult> {
  try {
    return await launch.finished;
  } catch {
    throw cleanupUnconfirmedError();
  }
}

function unavailableFromLaunchResult(result: ManagedProcessResult, message: string) {
  if (!result.cleanupConfirmed) throw cleanupUnconfirmedError();
  throw apiUnavailableError(message);
}

export function createMineruApiSession(options: {
  config: MinerUCliConfig;
  processContext: ProcessContext;
  signal?: AbortSignal;
  dependencies?: Partial<MineruApiSessionDependencies>;
}): MineruApiSession {
  const { config, processContext, signal } = options;
  const dependencies: MineruApiSessionDependencies = {
    checkPortAvailable: defaultCheckPortAvailable,
    fetchHealth: defaultFetchHealth,
    managedProcess: runManagedProcess,
    runClient: runMineruCli,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...options.dependencies,
  };
  const apiUrl = `http://${config.apiHost}:${config.apiPort}`;
  const apiSafetyRoot = join(dirname(processContext.safetyRoot), 'mineru-api-process');
  let apiStderrBuffer = '';
  let state: SessionState = { kind: 'idle' };

  const observeLaunch = (launch: ServerLaunch) => {
    launch.finished.then(
      (result) => {
        launch.outcome = { kind: 'result', result };
        state = syncStateWithSettledLaunch(state);
      },
      (error) => {
        launch.outcome = { kind: 'error', error };
        state = syncStateWithSettledLaunch(state);
      },
    );
    void launch.finished.catch(() => {});
  };

  const startLaunch = (launch: ServerLaunch) => (async () => {
    try {
      await ensureCleanupRecordClear(apiSafetyRoot);
      try {
        await dependencies.checkPortAvailable('127.0.0.1', config.apiPort);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          throw sessionError('MINERU_API_PORT_IN_USE', `MinerU API port ${config.apiPort} is already in use`);
        }
        throw error;
      }
      if (launch.controller.signal.aborted) {
        launch.resolveFinished(cancelledLaunchResult());
        throw sessionDisposedError();
      }

      const managed = dependencies.managedProcess({
        executable: join(config.venvRoot, 'Scripts', 'python.exe'),
        args: ['-m', 'mineru.cli.fast_api', '--host', config.apiHost, '--port', String(config.apiPort)],
        cwd: config.sourceRoot,
        env: {
          ...buildMinerUProcessEnv(config),
          ...(config.model === 'pipeline'
            ? { MINERU_VIRTUAL_VRAM_SIZE: String(pipelineBatchRatioToVirtualVram(config.pipelineBatchRatio)) }
            : {}),
        },
        timeoutMs: null,
        ...processContext,
        safetyRoot: apiSafetyRoot,
        recordMetadata: { kind: 'mineru-api', host: '127.0.0.1', port: config.apiPort },
      }, {
        signal: launch.controller.signal,
        onStderr(chunk) {
          apiStderrBuffer = `${apiStderrBuffer}${chunk}`.slice(-API_DIAGNOSTIC_BUFFER_LIMIT);
        },
        onEvent(event) {
          if (event.kind === 'started') launch.resolveStarted(event.pid);
        },
      });
      void managed.catch((error) => {
        launch.rejectStarted(error);
        launch.rejectFinished(error);
      });
      managed.then((result) => {
        launch.resolveFinished(result);
      }, () => {});

      let remainingMs = config.apiStartupTimeoutMs;
      const deadline = performance.now() + remainingMs;
      while (true) {
        const probe = new AbortController();
        const outcome = await Promise.race([
          dependencies.fetchHealth(`${apiUrl}/health`, {
            signal: AbortSignal.any([launch.controller.signal, probe.signal]),
            timeoutMs: Math.max(1, Math.min(HEALTH_REQUEST_TIMEOUT_MS, remainingMs)),
          }).then(
            (health) => ({ kind: 'health' as const, health }),
            () => ({ kind: 'health-error' as const }),
          ),
          launch.finished.then(
            (result) => ({ kind: 'finished' as const, result }),
            (error) => ({ kind: 'finished-error' as const, error }),
          ),
        ]).finally(() => probe.abort());
        if (outcome.kind === 'finished') unavailableFromLaunchResult(outcome.result, 'MinerU API exited before readiness');
        if (outcome.kind === 'finished-error') throw cleanupUnconfirmedError();
        if (outcome.kind === 'health' && isHealthyPayload(outcome.health, config)) return apiUrl;
        remainingMs = Math.min(remainingMs, deadline - performance.now());
        if (remainingMs <= 0) break;

        const delayMs = Math.min(HEALTH_INTERVAL_MS, remainingMs);
        const pause = await Promise.race([
          dependencies.sleep(delayMs).then(() => ({ kind: 'sleep' as const })),
          launch.finished.then(
            (result) => ({ kind: 'finished' as const, result }),
            (error) => ({ kind: 'finished-error' as const, error }),
          ),
        ]);
        if (pause.kind === 'finished') unavailableFromLaunchResult(pause.result, 'MinerU API exited before readiness');
        if (pause.kind === 'finished-error') throw cleanupUnconfirmedError();
        remainingMs -= delayMs;
      }

      launch.controller.abort();
      const result = await waitForLaunchResult(launch);
      if (!result.cleanupConfirmed) throw cleanupUnconfirmedError();
      throw sessionError('MINERU_API_STARTUP_TIMEOUT', 'MinerU API did not become healthy before the startup timeout');
    } catch (error) {
      if (!launch.outcome) launch.rejectFinished(error);
      throw error;
    }
  })();

  async function ensureLaunchReady(): Promise<{ apiUrl: string; launch: ServerLaunch }> {
    while (true) {
      state = syncStateWithSettledLaunch(state);
      if (state.kind === 'disposed') throw sessionDisposedError();
      if (state.kind === 'ended') unavailableFromEndedLaunch(state.launch);
      if (state.kind === 'ready') return { apiUrl: state.apiUrl, launch: state.launch };
      if (state.kind === 'starting') {
        const current = state.launch;
        try {
          const readyUrl = await state.ready;
          return { apiUrl: readyUrl, launch: current };
        } catch (error) {
          if (state.kind === 'starting' && state.launch === current) state = { kind: 'idle' };
          throw error;
        }
        continue;
      }

      const launch = createServerLaunch(apiUrl);
      if (signal) {
        if (signal.aborted) launch.controller.abort();
        else signal.addEventListener('abort', () => launch.controller.abort(), { once: true });
      }
      observeLaunch(launch);
      const ready = startLaunch(launch);
      state = { kind: 'starting', ready, launch };
      ready.then(
        (readyUrl) => {
          if (state.kind === 'starting' && state.launch === launch) state = { kind: 'ready', apiUrl: readyUrl, launch };
        },
        () => {
          if (state.kind === 'starting' && state.launch === launch) state = { kind: 'idle' };
        },
      );
    }
  }

  return {
    async ensureReady() {
      return (await ensureLaunchReady()).apiUrl;
    },
    async run(job) {
      const current = await ensureLaunchReady();
      const client = Promise.resolve(dependencies.runClient(job, {
        config,
        processContext,
        apiUrl: current.apiUrl,
        signal,
      }));
      void client.catch(() => {});

      const outcome = await Promise.race([
        client.then(
          (result) => ({ kind: 'client' as const, result }),
          (error) => ({ kind: 'client-error' as const, error }),
        ),
        current.launch.finished.then(
          (result) => ({ kind: 'finished' as const, result }),
          (error) => ({ kind: 'finished-error' as const, error }),
        ),
      ]);

      if (outcome.kind === 'client') return attachFailureDiagnostics(outcome.result, apiStderrBuffer);
      if (outcome.kind === 'client-error') throw outcome.error;
      if (outcome.kind === 'finished') unavailableFromLaunchResult(outcome.result, 'MinerU API became unavailable during request');
      throw cleanupUnconfirmedError();
    },
    async dispose() {
      if (state.kind === 'disposed') return;
      if (state.kind === 'idle') {
        state = { kind: 'disposed' };
        return;
      }
      const currentState = state;
      const current = currentState.launch;
      state = { kind: 'disposed' };
      if (currentState.kind !== 'ended') current.controller.abort();
      const result = await waitForLaunchResult(current);
      if (!result.cleanupConfirmed) throw cleanupUnconfirmedError();
    },
  };
}
