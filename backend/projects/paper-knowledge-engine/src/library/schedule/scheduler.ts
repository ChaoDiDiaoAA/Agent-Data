export interface ScheduleView { enabled: boolean; nextRunAt: string | null; running: boolean; lastWindow?: string }
export interface Scheduler { start(): void; stop(): void; nextRun(): ScheduleView; }

export class InternalScheduler implements Scheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastWindow: string | undefined;
  constructor(private readonly enabled: boolean, private readonly task: () => Promise<void>, private readonly intervalMs = 7 * 24 * 60 * 60 * 1000) {}
  start(): void { if (this.running || !this.enabled) return; this.running = true; this.schedule(); }
  stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  nextRun(): ScheduleView { return { enabled: this.enabled, running: this.running, nextRunAt: this.running ? new Date(Date.now() + this.intervalMs).toISOString() : null, ...(this.lastWindow ? { lastWindow: this.lastWindow } : {}) }; }
  private schedule(): void { if (!this.running) return; this.timer = setTimeout(async () => { this.timer = undefined; const window = new Date().toISOString().slice(0, 10); if (this.lastWindow !== window) { this.lastWindow = window; try { await this.task(); } catch { /* task state remains in operation store */ } } this.schedule(); }, this.intervalMs); }
}
