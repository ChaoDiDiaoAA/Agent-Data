import type { RunWindow } from '../../types/jobs.ts';
export function computeRunWindow(lastSuccess: string | null | undefined, now: string | number | Date, { startDate, overlapHours }: { startDate: string; overlapHours: number }): RunWindow {
  const floor = new Date(`${startDate}T00:00:00Z`);
  const candidate = lastSuccess ? new Date(new Date(lastSuccess).getTime() - overlapHours * 3600000) : floor;
  return { from: new Date(Math.max(floor.getTime(), candidate.getTime())).toISOString(), to: new Date(now).toISOString() };
}

export function resolveTaskWindow(from?: string | null, to?: string | null) {
  if (!from && !to) return undefined;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('run-task requires both --from and --to in YYYY-MM-DD format');
  }
  const window = { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` };
  if (Date.parse(window.from) > Date.parse(window.to)) throw new Error('run-task date range is inverted');
  return window;
}
