import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { windowsProcessStartTicks } from '../platform/windows-native.ts';

export interface ProcessOwner { pid: number; startedAt: string }
export type ProcessInspector = (pid: number) => string | null | undefined;
interface LockOwner extends ProcessOwner { jobId: string; token: string }
interface LockOptions { jobId?: string; inspectProcess?: ProcessInspector; waitMs?: number }
const busy = () => Object.assign(new Error('PROJECT_BUSY'), { code: 'PROJECT_BUSY' });
let selfIdentity: string | undefined;

/** null proves absence; undefined means uncertainty. Never use lock age. */
export function processIdentity(pid: number): string | null | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid && selfIdentity) return selfIdentity;
  let result: string | null | undefined;
  try {
    if (process.platform === 'win32') {
      try { process.kill(pid, 0); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return null;
      }
      const ticks = windowsProcessStartTicks(pid);
      result = ticks === null ? null : ticks === undefined ? undefined : `windows:${ticks}`;
    } else if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      result = `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && process.platform === 'linux') result = null;
  }
  if (pid === process.pid && result) selfIdentity = result;
  return result;
}
export function currentOwner(): ProcessOwner {
  const startedAt = processIdentity(process.pid);
  if (!startedAt) throw Object.assign(new Error('PROCESS_IDENTITY_UNAVAILABLE'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
  return { pid: process.pid, startedAt };
}
export function ownerState(owner: unknown, inspect: ProcessInspector = processIdentity): 'alive' | 'dead' | 'unknown' {
  if (!owner || typeof owner !== 'object' || !('pid' in owner) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0
    || !('startedAt' in owner) || typeof owner.startedAt !== 'string' || !owner.startedAt) return 'unknown';
  const actual = inspect(Number(owner.pid));
  return actual === undefined ? 'unknown' : actual === null || actual !== owner.startedAt ? 'dead' : 'alive';
}
export function assertNoUnconfirmedProcesses(processesRoot: string): void {
  try {
    if (readdirSync(processesRoot).length) throw Object.assign(new Error('PROCESS_CLEANUP_UNCONFIRMED'), { code: 'PROCESS_CLEANUP_UNCONFIRMED' });
  } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
}
/** Reclamation is serialized separately; empty/old/malformed locks always block. */
export function assertLockAvailable(path: string, inspect: ProcessInspector = processIdentity): void {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  let owner: unknown;
  try { owner = JSON.parse(raw); } catch { throw busy(); }
  if (ownerState(owner, inspect) !== 'dead') throw busy();
  let guard: number;
  try { guard = openSync(`${path}.recovery`, 'wx'); } catch { throw busy(); }
  try {
    if (readFileSync(path, 'utf8') !== raw || ownerState(owner, inspect) !== 'dead') throw busy();
    unlinkSync(path);
  } finally { closeSync(guard); unlinkSync(`${path}.recovery`); }
}
export async function withRunLock<T>(path: string, fn: () => T | Promise<T>, options: LockOptions = {}): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const owner: LockOwner = { ...currentOwner(), jobId: options.jobId ?? 'legacy-cli', token: randomUUID() };
  const deadline = Date.now() + (options.waitMs ?? 0);
  let handle: number;
  while (true) {
    try { handle = openSync(path, 'wx'); break; }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
      try { assertLockAvailable(path, options.inspectProcess); }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    }
  }
  const raw = JSON.stringify(owner);
  try { writeFileSync(handle, raw); return await fn(); }
  finally {
    closeSync(handle);
    if (readFileSync(path, 'utf8') === raw) unlinkSync(path);
  }
}
