import type { ProgressEvent, ProgressReporter } from '../types/jobs.ts';
import type { Stage } from '../library/operations/operation-contracts.ts';
export function notifyProgressObserver<T>(observer: ((event: T) => void) | undefined, event: T): void {
  try { observer?.(event); } catch {}
}
export function progressStage(event: ProgressEvent, fallback: Stage = 'acquire'): Stage {
  const phase = event.failedPhase ?? event.phase;
  if (phase === 'discovery') return 'acquire';
  if (phase === 'selection') return 'select';
  if (phase === 'download' || phase === 'parse' || phase === 'archive') return phase;
  if (phase === 'publish' || phase === 'evidence-publish') return 'evidence-publish';
  return fallback;
}
