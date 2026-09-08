import { processIdentity, type ProcessOwner } from '../runtime/run-lock.ts';
import { terminateWindowsProcessTree } from './windows-native.ts';
import type { MinerUExecution } from '../types/jobs.ts';

export interface ProcessLaunchOptions { cwd?: string; timeoutMs?: number; signal?: AbortSignal; }
export interface ProcessInspection { state: 'alive' | 'dead' | 'unknown'; owner: ProcessOwner; }
export interface WindowsProcessAdapter { launch(command: string[], options: ProcessLaunchOptions): Promise<MinerUExecution>; inspect(owner: ProcessOwner): ProcessInspection; resolve(recordPath: string): ProcessInspection; }

export class BunWindowsProcessAdapter implements WindowsProcessAdapter {
  inspect(owner: ProcessOwner): ProcessInspection { const actual = processIdentity(owner.pid); return { state: actual === undefined ? 'unknown' : actual === owner.startedAt ? 'alive' : 'dead', owner }; }
  resolve(recordPath: string): ProcessInspection { void recordPath; return { state: 'unknown', owner: { pid: 0, startedAt: '' } }; }
  launch(command: string[], options: ProcessLaunchOptions): Promise<MinerUExecution> {
    if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== 'string' || !part || /[\x00-\x1f]/.test(part))) return Promise.reject(Object.assign(new Error('INVALID_REQUEST'), { code: 'INVALID_REQUEST' }));
    return (async () => {
      const started = Date.now();
      const child = Bun.spawn(command, { cwd: options.cwd, windowsHide: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      let reason: 'exit' | 'timeout' | 'cancelled' = 'exit';
      let termination: Promise<boolean> | undefined;
      const terminate = (next: 'timeout' | 'cancelled') => { if (!termination) { reason = next; child.kill(); termination = terminateWindowsProcessTree(child.pid, options.timeoutMs ?? 5000); } };
      const onAbort = () => terminate('cancelled');
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = options.timeoutMs ? setTimeout(() => terminate('timeout'), options.timeoutMs) : undefined;
      const exitCode = await child.exited;
      if (termination) await termination;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const finalReason = reason as 'exit' | 'timeout' | 'cancelled';
      return { exitCode, elapsedMs: Date.now() - started, errorCode: finalReason === 'timeout' ? 'timeout' : finalReason === 'cancelled' ? 'cancelled' : exitCode === 0 ? null : 'process_error', timedOut: finalReason === 'timeout', cleanupConfirmed: true };
    })();
  }
}
