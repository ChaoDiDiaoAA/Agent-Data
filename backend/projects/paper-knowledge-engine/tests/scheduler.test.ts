import { expect, test } from 'bun:test';
import { InternalScheduler } from '../src/library/schedule/scheduler.ts';

test('scheduler starts only when enabled and exposes status', () => { const scheduler = new InternalScheduler(false, async () => undefined); scheduler.start(); expect(scheduler.nextRun()).toMatchObject({ enabled: false, running: false, nextRunAt: null }); scheduler.stop(); });
