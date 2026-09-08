import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectPaths, loadRuntimeConfig } from '../shared/config.ts';
import { processIdentity } from './run-lock.ts';
import { assignWindowsProcessToJob, closeWindowsProcessJob, createWindowsProcessJob, inspectWindowsNamedJob, retryRetainedWindowsJobClosures, terminateWindowsProcessJob, terminateWindowsProcessTree, windowsProcessStartIso, type WindowsProcessJob,  } from '../platform/windows-native.ts';
import type { RuntimePolicy } from '../types/config.ts';

export interface ProcessContext { policy: RuntimePolicy; safetyRoot: string }
export interface ProcessRecordMetadata {
  kind: 'mineru-api';
  host: '127.0.0.1';
  port: number;
}
export interface ManagedProcessSpec extends ProcessContext {
  executable: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number | null;
  stdinText?: string;
  recordMetadata?: ProcessRecordMetadata;
}
export interface ManagedProcessResult {
  reason: 'exit' | 'timeout' | 'cancelled' | 'output-limit' | 'supervisor-error';
  exitCode: number | null; stdout: string; stderr: string; cleanupConfirmed: boolean;
  pid: number | null; elapsedMs: number; activePids: number[];
}
export interface ProcessRecord {
  v: 1; id: string; jobName: string; executable: string; ownerPid: number; pid: number | null;
  startedAt: string | null; createdAt: string; cleanupState: 'launching' | 'running' | 'unconfirmed';
  recordMetadata?: ProcessRecordMetadata;
}
type Started = { v: 1; id: string; kind: 'started'; pid: number; startedAt: string; jobName: string };
type Finished = { v: 1; id: string; kind: 'finished'; terminationRequestedElapsedMs?: number | null; treeEmptyElapsedMs?: number | null } & Omit<ManagedProcessResult, 'stdout' | 'stderr' | 'pid'>;
export type SupervisorEvent = Started | Finished | { v: 1; id: string; kind: 'stdout' | 'stderr'; dataBase64: string }
  | { v: 1; id: string; kind: 'deadline'; elapsedMs: number };
type Options = { signal?: AbortSignal; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void;
  onEvent?: (event: Exclude<SupervisorEvent, { kind: 'stdout' | 'stderr' }>) => void };
const reasons = new Set(['exit', 'timeout', 'cancelled', 'output-limit', 'supervisor-error']);
const windowsJobLauncher = fileURLToPath(new URL('../cli.ts', import.meta.url));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const processJobName = (id: string): string => `Local\\Fsd.Process.${createHash('sha256').update(id, 'utf8').digest('hex')}`;

export function createProcessContext(projectRoot: string, processesRoot?: string, policy?: RuntimePolicy): ProcessContext {
  const safetyRoot = processesRoot ?? join(loadProjectPaths({ root: projectRoot }).stateRoot, 'operations', 'locks', 'processes');
  return { policy: policy ?? loadRuntimeConfig(projectRoot), safetyRoot };
}

function isProcessStartedAt(value: unknown): value is string {
  return typeof value === 'string' && (Number.isFinite(Date.parse(value)) || /^(?:windows|linux):.+$/.test(value));
}

function matchesProcessStart(recorded: string, pid: number, actual: string | null | undefined): boolean {
  if (actual === recorded) return true;
  if (!Number.isFinite(Date.parse(recorded))) return false;
  const nativeIso = windowsProcessStartIso(pid);
  return typeof nativeIso === 'string' && Date.parse(nativeIso) === Date.parse(recorded);
}

function isRecordMetadata(value: unknown): value is ProcessRecordMetadata {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as Record<string, unknown>;
  return metadata.kind === 'mineru-api'
    && metadata.host === '127.0.0.1'
    && integer(metadata.port)
    && Number(metadata.port) > 0
    && Number(metadata.port) <= 65535;
}

export function parseSupervisorEvent(line: string, id: string): SupervisorEvent {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== 'object') throw new Error('Invalid supervisor event');
  const event = value as Record<string, unknown>;
  if (event.v !== 1 || event.id !== id) throw new Error('Invalid supervisor identity');
  switch (event.kind) {
    case 'started':
      if (!integer(event.pid) || event.pid === 0 || event.jobName !== processJobName(id) || !isProcessStartedAt(event.startedAt)) throw new Error('Invalid started event');
      break;
    case 'stdout': case 'stderr':
      if (typeof event.dataBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.dataBase64)) throw new Error('Invalid output encoding');
      break;
    case 'deadline': if (!integer(event.elapsedMs)) throw new Error('Invalid deadline'); break;
    case 'finished':
      if (!reasons.has(String(event.reason)) || !(event.exitCode === null || Number.isInteger(event.exitCode))
        || typeof event.cleanupConfirmed !== 'boolean' || !integer(event.elapsedMs)
        || !Array.isArray(event.activePids) || !event.activePids.every(pid => integer(pid) && pid > 0)
        || (event.cleanupConfirmed && event.activePids.length > 0)) throw new Error('Invalid finished event');
      for (const key of ['terminationRequestedElapsedMs', 'treeEmptyElapsedMs']) {
        const time = event[key];
        if (time !== undefined && time !== null && (!integer(time) || time > Number(event.elapsedMs))) throw new Error('Invalid lifecycle time');
      }
      if (typeof event.treeEmptyElapsedMs === 'number' && (!event.cleanupConfirmed
        || (typeof event.terminationRequestedElapsedMs === 'number' && event.treeEmptyElapsedMs < event.terminationRequestedElapsedMs))) throw new Error('Invalid tree-empty time');
      break;
    default: throw new Error('Unknown supervisor event');
  }
  return value as SupervisorEvent;
}

async function durableWrite(path: string, record: ProcessRecord): Promise<void> {
  const handle = await open(path, 'wx');
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

export async function assertProcessSafety(context: ProcessContext): Promise<void> {
  try {
    if ((await readdir(context.safetyRoot)).length) throw Object.assign(new Error('PROCESS_CLEANUP_UNCONFIRMED: inspect project process safety records before retrying'), { code: 'PROCESS_CLEANUP_UNCONFIRMED', cleanupConfirmed: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function notify(options: Options, event: Exclude<SupervisorEvent, { kind: 'stdout' | 'stderr' }>) {
  options.onEvent?.(structuredClone(event));
}

type CleanupResult = { cleanupConfirmed: boolean; activePids: number[] };

async function terminateChild(child: Bun.Subprocess, pid: number, timeoutMs: number, windowsJob?: WindowsProcessJob): Promise<CleanupResult> {
  if (process.platform === 'win32') {
    if (windowsJob) return terminateWindowsProcessJob(windowsJob, timeoutMs);
    child.kill();
    const cleanupConfirmed = await terminateWindowsProcessTree(pid, timeoutMs);
    return { cleanupConfirmed, activePids: cleanupConfirmed ? [] : [pid] };
  }
  child.kill('SIGKILL');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 10));
  return { cleanupConfirmed: child.exitCode !== null, activePids: child.exitCode === null ? [pid] : [] };
}

async function confirmProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (processIdentity(pid) === null) return true;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  return processIdentity(pid) === null;
}

interface OutputConsumer { finished: Promise<void>; cancel(): Promise<void> }

function consumeOutput(stream: ReadableStream<Uint8Array>, kind: 'stdout' | 'stderr', limit: number,
  result: ManagedProcessResult, options: Options, state: { counts: Record<'stdout' | 'stderr', number>; outputLimit: boolean; observerFailed: boolean; streamFailed: boolean }): OutputConsumer {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const reader = stream.getReader();
  const finished = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const bytes = next.value;
        if (!bytes) continue;
      const remaining = Math.max(0, limit - state.counts[kind]);
      const accepted = bytes.subarray(0, remaining);
      state.counts[kind] += bytes.byteLength;
      if (accepted.byteLength) {
        const text = decoder.decode(accepted, { stream: true });
        result[kind] += text;
        try { (kind === 'stdout' ? options.onStdout : options.onStderr)?.(text); }
        catch { state.observerFailed = true; }
      }
      if (state.counts[kind] > limit) state.outputLimit = true;
      }
      const rest = decoder.decode();
      if (rest) {
        result[kind] += rest;
        try { (kind === 'stdout' ? options.onStdout : options.onStderr)?.(rest); }
        catch { state.observerFailed = true; }
      }
    } catch { state.streamFailed = true; }
    finally { try { reader.releaseLock(); } catch { /* The reader may already be released after cancellation. */ } }
  })();
  return {
    finished,
    async cancel() {
      try { await reader.cancel(); }
      catch { state.streamFailed = true; }
    }
  };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ settled: false }>(resolve => { timer = setTimeout(() => resolve({ settled: false }), Math.max(1, timeoutMs)); });
  const settled = promise.then(value => ({ settled: true as const, value }));
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return result;
}

async function closeWindowsJobWithin(job: WindowsProcessJob, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    if (closeWindowsProcessJob(job)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 15));
  } while (true);
}

export async function runManagedProcess(spec: ManagedProcessSpec, options: Options = {}): Promise<ManagedProcessResult> {
  const wallStart = Date.now();
  const result: ManagedProcessResult = { reason: 'supervisor-error', exitCode: null, stdout: '', stderr: '', cleanupConfirmed: false, pid: null, elapsedMs: 0, activePids: [] };
  const record: ProcessRecord = {
    v: 1,
    id: randomUUID(),
    jobName: '',
    executable: spec.executable,
    ownerPid: process.pid,
    pid: null,
    startedAt: null,
    createdAt: new Date().toISOString(),
    cleanupState: 'launching',
    recordMetadata: spec.recordMetadata,
  };
  record.jobName = processJobName(record.id);
  const recordPath = join(spec.safetyRoot, 'active.json');
  let owned = false;
  let child: Bun.Subprocess | undefined;
  let windowsJob: WindowsProcessJob | undefined;
  const updateRecord = async () => {
    const temporary = join(spec.safetyRoot, `${record.id}.tmp`);
    await durableWrite(temporary, record);
    await rename(temporary, recordPath);
  };
  try {
    if (process.platform === 'win32') retryRetainedWindowsJobClosures();
    if (!isAbsolute(spec.safetyRoot) || !isAbsolute(spec.cwd)) throw new Error('Managed process paths must be absolute');
    if (!Array.isArray(spec.args) || spec.args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Invalid process arguments');
    if (!spec.executable || spec.executable.includes('\0') || !isAbsolute(spec.executable)) throw new Error('Managed process executable must be absolute');
    for (const value of [spec.policy.processCleanupTimeoutMs, spec.policy.diagnosticTimeoutMs, spec.policy.maxOutputBytes]) {
      if (!integer(value) || value < 1) throw new Error('Invalid runtime policy');
    }
    if (spec.timeoutMs !== null && (!integer(spec.timeoutMs) || spec.timeoutMs > 2147483647)) throw new Error('Invalid process timeout');
    if (spec.stdinText !== undefined && (typeof spec.stdinText !== 'string' || !spec.stdinText.isWellFormed() || Buffer.byteLength(spec.stdinText) > 8 * 1024 * 1024)) throw new Error('Invalid process stdin');
    if (spec.recordMetadata !== undefined && !isRecordMetadata(spec.recordMetadata)) throw new Error('Invalid process record metadata');
    await mkdir(spec.safetyRoot, { recursive: true });
    await durableWrite(recordPath, record); owned = true;
    if ((await readdir(spec.safetyRoot)).some(name => name !== 'active.json')) {
      await rm(recordPath); owned = false;
      throw new Error('Unresolved project process record');
    }

    if (process.platform === 'win32') {
      windowsJob = createWindowsProcessJob(record.jobName);
      if (!windowsJob) throw new Error('Windows Job Object creation failed');
    }

    const command = process.platform === 'win32'
      ? [process.execPath, windowsJobLauncher, '--process-launcher', '--', spec.executable, ...spec.args]
      : [spec.executable, ...spec.args];
    child = Bun.spawn(command, {
      cwd: spec.cwd, env: spec.env, stdin: process.platform === 'win32' || spec.stdinText !== undefined ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    });
    result.pid = child.pid;
    if (windowsJob && !assignWindowsProcessToJob(windowsJob, child.pid)) {
      child.kill();
      await terminateWindowsProcessTree(child.pid, spec.policy.processCleanupTimeoutMs);
      throw new Error('Windows Job Object assignment failed');
    }
    const startedAt = processIdentity(child.pid);
    record.startedAt = startedAt ?? windowsProcessStartIso(child.pid) ?? new Date().toISOString();
    record.pid = child.pid;
    record.cleanupState = 'running';
    await updateRecord();
    notify(options, { v: 1, id: record.id, kind: 'started', pid: child.pid, startedAt: record.startedAt, jobName: record.jobName });

    const outputState = { counts: { stdout: 0, stderr: 0 }, outputLimit: false, observerFailed: false, streamFailed: false };
    const stdout = consumeOutput(child.stdout as ReadableStream<Uint8Array>, 'stdout', spec.policy.maxOutputBytes, result, options, outputState);
    const stderr = consumeOutput(child.stderr as ReadableStream<Uint8Array>, 'stderr', spec.policy.maxOutputBytes, result, options, outputState);
    if (process.platform === 'win32' || spec.stdinText !== undefined) {
      try {
        const input = child.stdin as Bun.FileSink;
        input.write(process.platform === 'win32' ? JSON.stringify(spec.stdinText === undefined ? {} : { stdinText: spec.stdinText }) : spec.stdinText!);
        await input.flush(); await input.end();
      }
      catch { outputState.observerFailed = true; }
    }

    let reason: ManagedProcessResult['reason'] = 'exit';
    let terminationRequestedElapsedMs: number | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let cancellationRequested = false;
    let termination: Promise<CleanupResult> | undefined;
    let cleanupResult: CleanupResult | undefined;
    const requestTermination = (nextReason: 'timeout' | 'cancelled' | 'output-limit') => {
      if (termination) return;
      reason = nextReason;
      terminationRequestedElapsedMs = Date.now() - wallStart;
      termination = terminateChild(child!, child!.pid, spec.policy.processCleanupTimeoutMs, windowsJob);
    };
    const onAbort = () => { cancellationRequested = true; requestTermination('cancelled'); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (spec.timeoutMs !== null && !termination) {
      deadlineTimer = setTimeout(() => {
        try { notify(options, { v: 1, id: record.id, kind: 'deadline', elapsedMs: Date.now() - wallStart }); }
        catch { outputState.observerFailed = true; }
        requestTermination('timeout');
      }, spec.timeoutMs);
    }
    const waitForExit = child.exited.then(code => { result.exitCode = code; return code; });
    while (!termination && child.exitCode === null) {
      if (outputState.outputLimit) requestTermination('output-limit');
      else if (outputState.observerFailed) requestTermination('cancelled');
      else if (cancellationRequested) requestTermination('cancelled');
      else await Promise.race([waitForExit, new Promise(resolve => setTimeout(resolve, 10))]);
    }
    let rootExitConfirmed = true;
    if (termination) {
      const exit = await settleWithin(waitForExit, spec.policy.processCleanupTimeoutMs);
      rootExitConfirmed = exit.settled;
    } else {
      await waitForExit;
    }
    // A successful root exit is not proof that a parser spawned no workers.
    // Sweep the same PID tree before removing the durable safety record.
    if (!termination && process.platform === 'win32') {
      terminationRequestedElapsedMs = Date.now() - wallStart;
      termination = terminateChild(child, child.pid, spec.policy.processCleanupTimeoutMs, windowsJob);
    }
    if (termination) cleanupResult = await termination;
    const jobCloseConfirmed = windowsJob ? await closeWindowsJobWithin(windowsJob, spec.policy.processCleanupTimeoutMs) : true;
    const output = await settleWithin(Promise.all([stdout.finished, stderr.finished]), spec.policy.processCleanupTimeoutMs);
    if (!output.settled) {
      outputState.streamFailed = true;
      await settleWithin(Promise.all([stdout.cancel(), stderr.cancel()]), Math.min(250, spec.policy.processCleanupTimeoutMs));
      await settleWithin(Promise.all([stdout.finished, stderr.finished]), Math.min(250, spec.policy.processCleanupTimeoutMs));
    }
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', onAbort);
    if (outputState.outputLimit) reason = 'output-limit';
    if (outputState.observerFailed) reason = 'supervisor-error';
    else if (outputState.streamFailed && reason === 'exit') reason = 'supervisor-error';
    const rootGone = await confirmProcessGone(child.pid, spec.policy.processCleanupTimeoutMs);
    const nativeCleanupConfirmed = process.platform !== 'win32' || cleanupResult?.cleanupConfirmed === true;
    const cleanupConfirmed = rootExitConfirmed && result.exitCode !== null && rootGone && nativeCleanupConfirmed && jobCloseConfirmed && output.settled;
    result.reason = reason;
    result.cleanupConfirmed = cleanupConfirmed && !outputState.observerFailed;
    result.activePids = result.cleanupConfirmed ? [] : [...new Set([...(cleanupResult?.activePids ?? []), ...(rootGone ? [] : [child.pid])])];
    result.elapsedMs = Date.now() - wallStart;
    notify(options, { v: 1, id: record.id, kind: 'finished', reason: result.reason, exitCode: result.exitCode,
      cleanupConfirmed: result.cleanupConfirmed, elapsedMs: result.elapsedMs, activePids: result.activePids,
      terminationRequestedElapsedMs, treeEmptyElapsedMs: result.cleanupConfirmed ? result.elapsedMs : null });
    if (result.cleanupConfirmed) await unlink(recordPath);
    else { record.cleanupState = 'unconfirmed'; await updateRecord(); }
  } catch {
    result.reason = 'supervisor-error';
    result.cleanupConfirmed = false;
    result.stderr ||= 'PROCESS_CLEANUP_UNCONFIRMED: managed process launch or supervision failed; inspect project safety records';
    if (child && child.exitCode === null) {
      try { await terminateChild(child, child.pid, spec.policy.processCleanupTimeoutMs, windowsJob); } catch { /* Retain the record below. */ }
    }
    if (windowsJob) await closeWindowsJobWithin(windowsJob, spec.policy.processCleanupTimeoutMs);
    if (owned) { record.cleanupState = 'unconfirmed'; try { await updateRecord(); } catch { /* Existing durable marker remains fail-closed. */ } }
  }
  if (!result.elapsedMs) result.elapsedMs = Date.now() - wallStart;
  return result;
}

export interface ProcessRecordInspection {
  ownerAlive: boolean; rootState: 'alive' | 'dead' | 'unknown'; activePids: number[]; cleanupConfirmed: boolean; resolved: boolean; error?: string;
}

function validateRecord(value: unknown): ProcessRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid process record');
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.id !== 'string' || typeof record.jobName !== 'string' || typeof record.executable !== 'string'
    || !integer(record.ownerPid) || record.ownerPid === 0 || !['launching', 'running', 'unconfirmed'].includes(String(record.cleanupState))) throw new Error('Invalid process record');
  if (record.pid !== null && (!integer(record.pid) || record.pid === 0)) throw new Error('Invalid root PID');
  if (record.jobName !== processJobName(String(record.id))) throw new Error('Invalid process job identity');
  if (record.startedAt !== null && !isProcessStartedAt(record.startedAt)) throw new Error('Invalid process start identity');
  if (record.recordMetadata !== undefined && !isRecordMetadata(record.recordMetadata)) throw new Error('Invalid process record metadata');
  return record as unknown as ProcessRecord;
}

async function readRecord(path: string): Promise<{ record: ProcessRecord; raw: string }> {
  if (!isAbsolute(path) || path.split(/[\\/]/).pop() !== 'active.json') throw new Error('Expected active.json record');
  const raw = await readFile(path, 'utf8');
  return { record: validateRecord(JSON.parse(raw)), raw };
}

export async function inspectProcessRecord(path: string): Promise<ProcessRecordInspection> {
  const { record } = await readRecord(path);
  const ownerIdentity = processIdentity(record.ownerPid);
  const ownerAlive = ownerIdentity !== null;
  let rootState: ProcessRecordInspection['rootState'] = 'unknown';
  if (record.pid !== null && record.startedAt !== null) {
    const actual = processIdentity(record.pid);
    rootState = actual === null ? 'dead' : actual === undefined ? 'unknown' : matchesProcessStart(record.startedAt, record.pid, actual) ? 'alive' : 'dead';
  }
  const job = process.platform === 'win32' ? inspectWindowsNamedJob(record.jobName) : { state: 'absent' as const, activePids: [] as number[] };
  const activePids = [...new Set([...(rootState === 'alive' && record.pid ? [record.pid] : []), ...job.activePids])];
  const cleanupConfirmed = rootState === 'dead' && job.state !== 'unknown' && activePids.length === 0;
  return { ownerAlive, rootState, activePids, cleanupConfirmed, resolved: false,
    ...(job.state === 'unknown' ? { error: 'named process job could not be inspected safely' } : {}) };
}

export async function resolveProcessRecord(path: string): Promise<ProcessRecordInspection> {
  const { raw } = await readRecord(path);
  const inspection = await inspectProcessRecord(path);
  if (inspection.ownerAlive || !inspection.cleanupConfirmed) return inspection;
  const leasePath = join(path, '..', '.resolve.lock');
  let lease: Awaited<ReturnType<typeof open>> | undefined;
  try { lease = await open(leasePath, 'wx'); }
  catch { return { ...inspection, ownerAlive: true, error: 'recovery already in progress' }; }
  try {
    const current = await readFile(path, 'utf8');
    if (current !== raw) return { ...inspection, error: 'record changed during inspection' };
    const latest = await inspectProcessRecord(path);
    if (latest.ownerAlive || !latest.cleanupConfirmed) return latest;
    await unlink(path);
    return { ...latest, resolved: true };
  } catch { return { ...inspection, error: 'record resolution could not establish safe cleanup' }; }
  finally { await lease.close(); await rm(leasePath, { force: true }); }
}
