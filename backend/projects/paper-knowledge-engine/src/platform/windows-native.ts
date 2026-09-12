import { dlopen, FFIType, ptr } from 'bun:ffi';

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const STILL_ACTIVE = 259;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const JOB_OBJECT_QUERY = 0x0004;
const JOB_OBJECT_TERMINATE = 0x0008;
const ERROR_FILE_NOT_FOUND = 2;
const ES_SYSTEM_REQUIRED = 0x00000001;
const ES_CONTINUOUS = 0x80000000;
const ES_AWAYMODE_REQUIRED = 0x00000040;

type Kernel32 = ReturnType<typeof dlopen<typeof kernelSymbols>>['symbols'];
const kernelSymbols = {
  GetProcessTimes: { args: [FFIType.uint64_t, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.int32_t },
  GetExitCodeProcess: { args: [FFIType.uint64_t, FFIType.ptr], returns: FFIType.int32_t },
  OpenProcess: { args: [FFIType.uint32_t, FFIType.int32_t, FFIType.uint32_t], returns: FFIType.uint64_t },
  TerminateProcess: { args: [FFIType.uint64_t, FFIType.uint32_t], returns: FFIType.int32_t },
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.uint64_t },
  OpenJobObjectW: { args: [FFIType.uint32_t, FFIType.int32_t, FFIType.ptr], returns: FFIType.uint64_t },
  SetInformationJobObject: { args: [FFIType.uint64_t, FFIType.int32_t, FFIType.ptr, FFIType.uint32_t], returns: FFIType.int32_t },
  AssignProcessToJobObject: { args: [FFIType.uint64_t, FFIType.uint64_t], returns: FFIType.int32_t },
  QueryInformationJobObject: { args: [FFIType.uint64_t, FFIType.int32_t, FFIType.ptr, FFIType.uint32_t, FFIType.ptr], returns: FFIType.int32_t },
  TerminateJobObject: { args: [FFIType.uint64_t, FFIType.uint32_t], returns: FFIType.int32_t },
  SetThreadExecutionState: { args: [FFIType.uint32_t], returns: FFIType.uint32_t },
  CreateToolhelp32Snapshot: { args: [FFIType.uint32_t, FFIType.uint32_t], returns: FFIType.uint64_t },
  Process32FirstW: { args: [FFIType.uint64_t, FFIType.ptr], returns: FFIType.int32_t },
  Process32NextW: { args: [FFIType.uint64_t, FFIType.ptr], returns: FFIType.int32_t },
  CloseHandle: { args: [FFIType.uint64_t], returns: FFIType.int32_t },
  GetLastError: { args: [], returns: FFIType.uint32_t },
};

let kernel32: Kernel32 | undefined;
const retainedWindowsJobs = new Set<WindowsProcessJob>();
function loadKernel32(): Kernel32 | undefined {
  if (process.platform !== 'win32') return undefined;
  if (!kernel32) {
    try { kernel32 = dlopen('kernel32.dll', kernelSymbols).symbols; }
    catch { return undefined; }
  }
  return kernel32;
}

function nativeStartTicks(pid: number): bigint | null | undefined {
  const api = loadKernel32();
  if (!api) return undefined;
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return undefined;
  try {
    const exitCode = new Uint32Array(1);
    if (!api.GetExitCodeProcess(handle, ptr(exitCode))) return undefined;
    if (exitCode[0] !== STILL_ACTIVE) return null;
    const creation = new BigUint64Array(1);
    const ignoredExit = new BigUint64Array(1);
    const kernel = new BigUint64Array(1);
    const user = new BigUint64Array(1);
    if (!api.GetProcessTimes(handle, ptr(creation), ptr(ignoredExit), ptr(kernel), ptr(user))) return undefined;
    return creation[0];
  } finally {
    api.CloseHandle(handle);
  }
}

/** Returns Windows FILETIME creation ticks; null proves the PID has exited. */
export function windowsProcessStartTicks(pid: number): bigint | null | undefined {
  return nativeStartTicks(pid);
}

export function windowsProcessStartIso(pid: number): string | null | undefined {
  const ticks = nativeStartTicks(pid);
  if (ticks === undefined || ticks === null) return ticks;
  const unixMilliseconds = (ticks - 116444736000000000n) / 10000n;
  return new Date(Number(unixMilliseconds)).toISOString();
}

export interface WindowsKeepAwakeLease {
  release(): void;
}

/**
 * Keep a long-running local parse alive while the process is active.  Away
 * mode lets the display turn off without putting the machine into standby;
 * the system-required fallback covers Windows versions that reject away mode.
 */
export function acquireWindowsKeepAwake(): WindowsKeepAwakeLease | undefined {
  const api = loadKernel32();
  if (!api) return undefined;
  const requested = ES_CONTINUOUS + ES_SYSTEM_REQUIRED + ES_AWAYMODE_REQUIRED;
  const applied = api.SetThreadExecutionState(requested) || api.SetThreadExecutionState(ES_CONTINUOUS + ES_SYSTEM_REQUIRED);
  if (!applied) return undefined;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      api.SetThreadExecutionState(ES_CONTINUOUS);
    },
  };
}

export interface WindowsProcessJob {
  readonly name: string;
  handle: bigint | null;
}

function wideString(value: string): Uint16Array {
  const result = new Uint16Array(value.length + 1);
  for (let index = 0; index < value.length; index += 1) result[index] = value.charCodeAt(index);
  return result;
}

/** Create a named, non-breakaway Windows Job Object whose final handle owns its process lifetime. */
export function createWindowsProcessJob(name: string): WindowsProcessJob | undefined {
  const api = loadKernel32();
  if (!api || !name || name.includes('\0')) return undefined;
  const encodedName = wideString(name);
  const handle = api.CreateJobObjectW(null, ptr(encodedName));
  if (!handle) return undefined;
  const limits = new Uint8Array(144);
  new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (!api.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(limits), limits.byteLength)) {
    api.CloseHandle(handle);
    return undefined;
  }
  return { name, handle: handle as bigint };
}

/** Open an existing named job for read-only membership inspection. */
export function openWindowsProcessJob(name: string, access: 'query' | 'terminate' = 'query'): WindowsProcessJob | undefined {
  const api = loadKernel32();
  if (!api || !name || name.includes('\0')) return undefined;
  const encodedName = wideString(name);
  const desiredAccess = JOB_OBJECT_QUERY | (access === 'terminate' ? JOB_OBJECT_TERMINATE : 0);
  const handle = api.OpenJobObjectW(desiredAccess, 0, ptr(encodedName));
  return handle ? { name, handle: handle as bigint } : undefined;
}

export type WindowsNamedJobInspection =
  | { state: 'absent'; activePids: [] }
  | { state: 'present'; activePids: number[] }
  | { state: 'unknown'; activePids: number[] };

/** Inspect a named job without treating access/query/close failures as absence. */
export function inspectWindowsNamedJob(name: string): WindowsNamedJobInspection {
  const api = loadKernel32();
  if (!api || !name || name.includes('\0')) return { state: 'unknown', activePids: [] };
  const encodedName = wideString(name);
  const handle = api.OpenJobObjectW(JOB_OBJECT_QUERY, 0, ptr(encodedName));
  if (!handle) return api.GetLastError() === ERROR_FILE_NOT_FOUND
    ? { state: 'absent', activePids: [] }
    : { state: 'unknown', activePids: [] };
  const job: WindowsProcessJob = { name, handle: handle as bigint };
  const activePids = windowsJobActivePids(job);
  const closed = closeWindowsProcessJob(job);
  if (activePids === undefined || !closed) return { state: 'unknown', activePids: activePids ?? [] };
  return { state: 'present', activePids };
}

/** Assign a live process before it can create unsupervised descendants. */
export function assignWindowsProcessToJob(job: WindowsProcessJob, pid: number): boolean {
  const api = loadKernel32();
  if (!api || !job.handle) return false;
  const processHandle = api.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!processHandle) return false;
  try { return Boolean(api.AssignProcessToJobObject(job.handle, processHandle)); }
  finally { api.CloseHandle(processHandle); }
}

/** Return every PID currently associated with the job; undefined means the query itself was not trustworthy. */
export function windowsJobActivePids(job: WindowsProcessJob): number[] | undefined {
  const api = loadKernel32();
  if (!api || !job.handle) return undefined;
  for (let capacity = 16; capacity <= 4096; capacity *= 2) {
    const buffer = new Uint8Array(8 + capacity * 8);
    const returned = new Uint32Array(1);
    const ok = api.QueryInformationJobObject(job.handle, JOB_OBJECT_BASIC_PROCESS_ID_LIST, ptr(buffer), buffer.byteLength, ptr(returned));
    const view = new DataView(buffer.buffer);
    const assigned = view.getUint32(0, true);
    const listed = view.getUint32(4, true);
    if (!ok && assigned <= capacity) return undefined;
    if (assigned > capacity || listed > capacity) continue;
    const pids: number[] = [];
    for (let index = 0; index < listed; index += 1) {
      const pid = Number(view.getBigUint64(8 + index * 8, true));
      if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
    }
    return pids.sort((left, right) => left - right);
  }
  return undefined;
}

/** Terminate every process in a Job Object and prove its membership list became empty. */
export async function terminateWindowsProcessJob(job: WindowsProcessJob, timeoutMs: number): Promise<{ cleanupConfirmed: boolean; activePids: number[] }> {
  const api = loadKernel32();
  if (!api || !job.handle) return { cleanupConfirmed: false, activePids: [] };
  const terminationAccepted = Boolean(api.TerminateJobObject(job.handle, 1));
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const activePids = windowsJobActivePids(job);
    if (activePids === undefined) return { cleanupConfirmed: false, activePids: [] };
    if (activePids.length === 0) return { cleanupConfirmed: true, activePids: [] };
    if (!terminationAccepted) return { cleanupConfirmed: false, activePids };
    if (Date.now() >= deadline) return { cleanupConfirmed: false, activePids };
    await new Promise(resolve => setTimeout(resolve, 15));
  } while (true);
}

export function closeWindowsProcessJob(job: WindowsProcessJob): boolean {
  const api = loadKernel32();
  if (!api) { retainedWindowsJobs.add(job); return false; }
  if (!job.handle) { retainedWindowsJobs.delete(job); return true; }
  if (!api.CloseHandle(job.handle)) { retainedWindowsJobs.add(job); return false; }
  job.handle = null;
  retainedWindowsJobs.delete(job);
  return true;
}

/** Best-effort retry for handles retained after a prior CloseHandle failure. */
export function retryRetainedWindowsJobClosures(): boolean {
  for (const job of [...retainedWindowsJobs]) closeWindowsProcessJob(job);
  return retainedWindowsJobs.size === 0;
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return true;
    }
    if (nativeStartTicks(pid) === null) return true;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  try { process.kill(pid, 0); return nativeStartTicks(pid) === null; }
  catch (error) { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'); }
}

const TH32CS_SNAPPROCESS = 0x00000002;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
function processTree(rootPid: number): number[] | undefined {
  const api = loadKernel32();
  if (!api) return undefined;
  const snapshot = api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snapshot || snapshot === INVALID_HANDLE_VALUE) return undefined;
  const entry = new Uint8Array(568);
  new DataView(entry.buffer).setUint32(0, entry.byteLength, true);
  const processes: Array<{ pid: number; parentPid: number }> = [];
  try {
    let more = api.Process32FirstW(snapshot, ptr(entry));
    while (more) {
      const view = new DataView(entry.buffer);
      processes.push({ pid: view.getUint32(8, true), parentPid: view.getUint32(32, true) });
      more = api.Process32NextW(snapshot, ptr(entry));
    }
  } finally { api.CloseHandle(snapshot); }
  const children = new Map<number, number[]>();
  for (const item of processes) children.set(item.parentPid, [...(children.get(item.parentPid) ?? []), item.pid]);
  const result: number[] = [];
  const pending = [rootPid];
  while (pending.length) {
    const parent = pending.shift()!;
    for (const child of children.get(parent) ?? []) {
      if (child !== rootPid && !result.includes(child)) { result.push(child); pending.push(child); }
    }
  }
  return [...(processes.some(item => item.pid === rootPid) ? [rootPid] : []), ...result];
}

function terminatePid(pid: number): void {
  const api = loadKernel32();
  if (!api) return;
  const handle = api.OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return;
  try { api.TerminateProcess(handle, 1); }
  finally { api.CloseHandle(handle); }
}

/** Kill a Windows process tree with the native task controller and verify the root is gone. */
export async function terminateWindowsProcessTree(pid: number, timeoutMs: number): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const known = processTree(pid);
  if (known === undefined) return false;
  let taskkillConfirmed = true;
  try {
    const killer = Bun.spawn(['taskkill.exe', '/PID', String(pid), '/T', '/F'], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true,
    });
    const completed = await Promise.race([
      killer.exited.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), Math.max(50, Math.min(timeoutMs, 2000)))),
    ]);
    if (!completed) {
      killer.kill();
      taskkillConfirmed = await Promise.race([
        killer.exited.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), Math.max(50, Math.min(timeoutMs, 500)))),
      ]);
    }
  } catch { /* Fall through to the direct native termination attempt. */ }
  const remaining = processTree(pid);
  if (remaining === undefined) return false;
  for (const member of [...new Set([...known, ...remaining])].reverse()) terminatePid(member);
  terminatePid(pid);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    const current = processTree(pid);
    if (current === undefined) return false;
    if (taskkillConfirmed && current.length === 0 && await waitUntilGone(pid, 0)) return true;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  const current = processTree(pid);
  return taskkillConfirmed && current !== undefined && current.length === 0 && await waitUntilGone(pid, 0);
}
