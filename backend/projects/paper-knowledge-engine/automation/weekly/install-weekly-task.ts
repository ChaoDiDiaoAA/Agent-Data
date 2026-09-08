import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildScheduleDescriptor } from '../../src/library/schedule/schedule-config.ts';
import { loadConfig } from '../../src/shared/config.ts';

export interface ScheduledTaskDescriptor {
  enabled: boolean; taskName: string; dayOfWeek: string; intervalWeeks: number; startDate: string; localTime: string;
  timezone: string; systemTimezone: string; timezoneMatches: boolean; entrypoint: string; command: string[];
}

export function quoteTaskCommand(parts: string[]): string {
  return parts.map(part => `"${part.replaceAll('"', '\\"')}"`).join(' ');
}

export function buildTaskCommand(descriptor: ScheduledTaskDescriptor, bunExecutable = process.execPath): string[] {
  return [bunExecutable, descriptor.entrypoint, ...descriptor.command];
}

function runNative(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['schtasks.exe', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', windowsHide: true });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function descriptor(root: string): ScheduledTaskDescriptor {
  const config = loadConfig({ root });
  return buildScheduleDescriptor(config, root, Intl.DateTimeFormat().resolvedOptions().timeZone) as ScheduledTaskDescriptor;
}

function fail(result: { status: number; stderr: string }, label: string): never {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  throw new Error(`${label} failed`);
}

export function installWeeklyTask(root: string, action = 'Install'): unknown {
  if (process.platform !== 'win32') throw new Error('weekly task installation is only supported on Windows');
  const schedule = descriptor(root);
  const normalized = action.toLowerCase();
  if (!['install', 'status', 'uninstall'].includes(normalized)) throw new Error('action must be install, status, or uninstall');
  if (normalized === 'status') {
    const result = runNative(['/Query', '/TN', schedule.taskName, '/FO', 'LIST', '/V']);
    if (result.status !== 0) return { taskName: schedule.taskName, installed: false };
    return { taskName: schedule.taskName, installed: true, raw: result.stdout };
  }
  if (normalized === 'uninstall') {
    const result = runNative(['/Delete', '/TN', schedule.taskName, '/F']);
    if (result.status !== 0 && !/not found|cannot find/i.test(result.stderr)) fail(result, 'task uninstall');
    return { taskName: schedule.taskName, uninstalled: result.status === 0 };
  }
  if (!schedule.enabled) return { taskName: schedule.taskName, installed: false, disabled: true };
  if (!schedule.timezoneMatches) throw new Error(`system timezone ${schedule.systemTimezone} does not match ${schedule.timezone}`);
  const [year, month, day] = schedule.startDate.split('-');
  const result = runNative(['/Create', '/TN', schedule.taskName, '/TR', quoteTaskCommand(buildTaskCommand(schedule)), '/SC', 'WEEKLY', '/MO', String(schedule.intervalWeeks),
    '/D', schedule.dayOfWeek.slice(0, 3), '/ST', schedule.localTime, '/SD', `${month}/${day}/${year}`, '/F']);
  if (result.status !== 0) fail(result, 'task installation');
  return { taskName: schedule.taskName, installed: true };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const actionArg = process.argv.find((value, index) => index > 1 && (value === '--action' || value === '-Action'));
const action = actionArg ? process.argv[process.argv.indexOf(actionArg) + 1] : 'Install';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(installWeeklyTask(root, action))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
