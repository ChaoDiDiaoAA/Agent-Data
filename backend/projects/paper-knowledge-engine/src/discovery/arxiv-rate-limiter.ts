import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { withRunLock } from '../runtime/run-lock.ts';

interface RateLimitState {
  nextRequestAt: number;
  cooldownUntil?: number;
  consecutive429?: number;
  rateLimitKind?: 'request-rate' | 'system-capacity';
}

export interface ArxivRequestSlotOptions {
  /** A machine-level lock shared by every paper library using arXiv. */
  lockPath?: string;
  intervalMs: number;
  /** Shared cooldown after an arXiv HTTP 429 response. */
  capacityCooldownMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  clock?: () => number;
  jobId?: string;
  /** Keep waiting for another harvest instead of failing during normal overlap. */
  lockWaitMs?: number;
}

const defaultLockWaitMs = 60 * 60 * 1000;

function readState(statePath: string): RateLimitState {
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { nextRequestAt: 0 };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as RateLimitState;
    const timestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
    if (!parsed || !timestamp(parsed.nextRequestAt)
      || (parsed.cooldownUntil !== undefined && !timestamp(parsed.cooldownUntil))
      || (parsed.consecutive429 !== undefined && (!Number.isSafeInteger(parsed.consecutive429) || parsed.consecutive429 < 0))
      || (parsed.rateLimitKind !== undefined && !['request-rate', 'system-capacity'].includes(parsed.rateLimitKind))) {
      throw new Error('invalid state');
    }
    return parsed;
  } catch (cause) {
    throw Object.assign(new Error(`Invalid arXiv shared rate-limit state: ${statePath}; preserve the file and inspect it before retrying`, { cause }), {
      code: 'ARXIV_RATE_STATE_INVALID',
    });
  }
}

function writeState(statePath: string, state: RateLimitState): void {
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, statePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function rateLimitField(error: unknown, name: string): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = Reflect.get(error, name);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Reserve one arXiv request slot across all OpenCLI child processes.
 *
 * The lock is held while the actual request is running, so two knowledge
 * libraries cannot make overlapping requests through different harvest runs.
 * The sidecar timestamp also preserves spacing after the previous process has
 * released the lock and carries a shared cooldown after an HTTP 429.
 */
export async function withArxivRequestSlot<T>(
  options: ArxivRequestSlotOptions,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (options.lockPath === undefined) return await operation();
  if (!options.lockPath.trim()) throw new Error('arXiv rate-limit lock path must not be empty');
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new Error('arXiv rate-limit interval must be a positive integer');
  }
  if (options.capacityCooldownMs !== undefined
    && (!Number.isSafeInteger(options.capacityCooldownMs) || options.capacityCooldownMs < 1)) {
    throw new Error('arXiv capacity cooldown must be a positive integer');
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const clock = options.clock ?? Date.now;
  const statePath = `${options.lockPath}.state.json`;

  return await withRunLock(options.lockPath, async () => {
    const state = readState(statePath);
    // Older versions stored both spacing and cooldown in nextRequestAt alone.
    const cooldownUntil = state.cooldownUntil ?? (state.nextRequestAt - clock() > options.intervalMs ? state.nextRequestAt : 0);
    if (cooldownUntil > clock()) {
      throw Object.assign(new Error('arXiv shared cooldown is active; no request was sent'), {
        code: 'ARXIV_CAPACITY_LIMITED', httpStatus: 429,
        retryAfterMs: cooldownUntil - clock(), retryNotBefore: new Date(cooldownUntil).toISOString(),
        rateLimitKind: state.rateLimitKind ?? 'request-rate',
      });
    }
    const waitMs = Math.max(0, state.nextRequestAt - clock());
    if (waitMs > 0) await sleep(waitMs);
    const nextRequestAt = clock() + options.intervalMs;
    writeState(statePath, { ...state, nextRequestAt, cooldownUntil: 0 });
    try {
      const result = await operation();
      writeState(statePath, { nextRequestAt, cooldownUntil: 0, consecutive429: 0 });
      return result;
    } catch (error) {
      if (rateLimitField(error, 'httpStatus') === 429) {
        const consecutive429 = Math.min((state.consecutive429 ?? 0) + 1, 3);
        const cooldownMs = Math.max((options.capacityCooldownMs ?? 900_000) * 2 ** (consecutive429 - 1), rateLimitField(error, 'retryAfterMs') ?? 0);
        const cooldownUntil = clock() + cooldownMs;
        const rateLimitKind = Reflect.get(error as object, 'rateLimitKind') === 'system-capacity' ? 'system-capacity' : 'request-rate';
        writeState(statePath, { nextRequestAt: Math.max(nextRequestAt, cooldownUntil), cooldownUntil, consecutive429, rateLimitKind });
        Object.assign(error as object, {
          code: 'ARXIV_CAPACITY_LIMITED', retryAfterMs: cooldownMs,
          retryNotBefore: new Date(cooldownUntil).toISOString(), rateLimitKind,
        });
      }
      throw error;
    }
  }, {
    jobId: options.jobId ?? 'arxiv-api-request',
    waitMs: options.lockWaitMs ?? defaultLockWaitMs,
  });
}
