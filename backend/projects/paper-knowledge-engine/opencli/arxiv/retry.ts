export type ArxivRateLimitKind = 'request-rate' | 'system-capacity';

export interface ArxivFailure extends Error {
  httpStatus?: number;
  code?: string;
  retryAfterMs?: number;
  stderr?: string;
  diagnostic?: string;
  rateLimitKind?: ArxivRateLimitKind;
  retryNotBefore?: string;
  transportCode?: string;
}
export interface RetryEvent {
  attempt: number;
  maxAttempts: number;
  waitMs: number;
  error?: ArxivFailure;
  type?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  diagnostic?: string;
  rateLimitKind?: ArxivRateLimitKind;
  retryNotBefore?: string;
  transportCode?: string;
}
export interface RetryPolicy {
  maxAttempts: number;
  maxBackoffMs: number;
  requestIntervalMs: number;
  retryJitterMs: number;
  capacityCooldownMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  random?: () => number;
  clock?: () => number;
  onRetry?: (event: RetryEvent) => unknown;
  onDeferred?: (event: RetryEvent) => unknown;
  onFailure?: (event: RetryEvent) => unknown;
}
const failureFields = (error: unknown): Partial<ArxivFailure> => error && typeof error === 'object' ? error as Partial<ArxivFailure> : {};
const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED']);
const bunTransportCodes = new Map([
  ['ConnectionRefused', 'ECONNREFUSED'],
  ['ConnectionReset', 'ECONNRESET'],
  ['ConnectTimeoutError', 'ETIMEDOUT'],
  ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'],
  ['TimeoutError', 'ETIMEDOUT'],
]);
export const arxivProgressPrefix = '__ARXIV_PROGRESS__=';

export function isArxivTransportCode(value: unknown): value is string {
  return typeof value === 'string' && transientCodes.has(value);
}

export function serializeArxivProgress(event: RetryEvent) {
  const { error: _error, ...safeEvent } = event;
  return `${arxivProgressPrefix}${JSON.stringify(safeEvent)}\n`;
}

export function parseRetryAfterMs(value: unknown) {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const seconds = Number(text);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export function normalizeArxivTransportFailure(source: unknown) {
  const fields = failureFields(source);
  const stderr = String(fields.stderr ?? fields.message ?? source);
  const statusMatch = stderr.match(/__ARXIV_STATUS__=(\d+)/);
  const codeMatch = stderr.match(/__ARXIV_CODE__=([^\r\n]*)/);
  const retryMatch = stderr.match(/__ARXIV_RETRY_AFTER__=([^\r\n]*)/);
  const normalized: ArxivFailure = source instanceof Error ? source as ArxivFailure
    : new Error(stderr.includes('Rate exceeded') ? 'arXiv Rate exceeded' : 'arXiv request failed');
  normalized.httpStatus = fields.httpStatus ?? (statusMatch ? Number(statusMatch[1]) : stderr.includes('Rate exceeded') ? 429 : undefined);
  const rawCodes = [fields.code, failureFields(fields.cause).code, codeMatch?.[1].trim(), fields.name]
    .filter((value): value is string => typeof value === 'string');
  let transportCode = rawCodes.map(code => transientCodes.has(code) ? code : bunTransportCodes.get(code)).find(Boolean);
  if (!transportCode && /Unable to connect\. Is the computer able to access the url\?/i.test(stderr)) transportCode = 'ECONNREFUSED';
  normalized.code = transportCode ?? (typeof fields.code === 'string' ? fields.code : undefined);
  normalized.transportCode = transportCode;
  normalized.retryAfterMs = fields.retryAfterMs ?? parseRetryAfterMs(retryMatch?.[1]);
  if (fields.diagnostic !== undefined) normalized.diagnostic = fields.diagnostic;
  return normalized;
}

export async function withArxivRetry<T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  const {
    maxAttempts,
    maxBackoffMs,
    requestIntervalMs,
    retryJitterMs,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    clock = Date.now,
    onRetry = () => undefined,
    onDeferred = () => undefined,
    onFailure = () => undefined,
    capacityCooldownMs = 900_000,
  } = policy;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (caught) {
      const normalized = normalizeArxivTransportFailure(caught);
      const normalizedFields = failureFields(normalized);
      const error = normalizedFields.transportCode || normalizedFields.httpStatus !== undefined || normalizedFields.code !== undefined
        ? normalizedFields
        : failureFields(caught);
      if (error.httpStatus === 429) {
        const rateLimitKind: ArxivRateLimitKind = error.rateLimitKind === 'system-capacity'
          ? 'system-capacity'
          : 'request-rate';
        const retryAfter = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs! : 0;
        const waitMs = Math.max(capacityCooldownMs, retryAfter);
        const retryNotBefore = new Date(clock() + waitMs).toISOString();
        if (normalized instanceof Error) {
          const failure = normalized;
          failure.code = 'ARXIV_CAPACITY_LIMITED';
          failure.retryAfterMs = waitMs;
          failure.rateLimitKind = rateLimitKind;
          failure.retryNotBefore = retryNotBefore;
        }
        onDeferred({
          type: 'discovery-deferred', attempt, maxAttempts, waitMs,
          error: normalized,
          httpStatus: 429, retryAfterMs: waitMs, rateLimitKind,
          retryNotBefore, diagnostic: error.diagnostic,
        });
        throw normalized;
      }
      const retryable = ((error.httpStatus ?? 0) >= 500 && (error.httpStatus ?? 0) <= 599)
        || transientCodes.has(error.code ?? '')
        || transientCodes.has(failureFields(error.cause).code ?? '');
      if (!retryable || attempt === maxAttempts) {
        if (error.transportCode) onFailure({
          type: 'discovery-transport-failed', attempt, maxAttempts, waitMs: 0,
          error: normalized, transportCode: error.transportCode,
        });
        throw normalized;
      }
      const exponential = Math.min(requestIntervalMs * (2 ** (attempt - 1)), maxBackoffMs);
      const retryAfter = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs! : 0;
      const jitter = Math.floor(random() * (retryJitterMs + 1));
      const waitMs = Math.max(exponential, retryAfter) + jitter;
      onRetry({ attempt, maxAttempts, waitMs, error: normalized });
      await sleep(waitMs);
    }
  }
  throw new Error('unreachable arxiv retry state');
}
