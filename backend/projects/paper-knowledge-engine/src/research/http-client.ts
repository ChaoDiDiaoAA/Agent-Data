import type { MachineConfig } from '../types/config.ts';
import type { SourcePolicyConfig } from '../types/research-sources.ts';
import { normalizeSourceUrl } from './source-identity.ts';
export interface HttpScope { policy: SourcePolicyConfig; allowedDomains: readonly string[]; allowedRedirectOrigins?: readonly string[]; network?: MachineConfig['network']; signal: AbortSignal }
export type HttpFetch = (url: string, options: RequestInit & { proxy?: string }) => Promise<Response>;
export interface HttpResult { url: string; status: number; headers: Headers; bytes: Uint8Array }
export class ResearchAdapterError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); this.name = 'ResearchAdapterError'; }
}
export function approvedHttpsUrl(value: string, scope: Pick<HttpScope, 'policy' | 'allowedDomains'>): string {
  try {
    normalizeSourceUrl(value);
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || !scope.policy.allowedDomains.includes(url.hostname) || !scope.allowedDomains.includes(url.hostname)) throw new Error();
    url.hash = '';
    return url.href;
  } catch { throw new ResearchAdapterError('RESEARCH_URL_REJECTED'); }
}

function exactHttpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    if (value !== url.origin && value !== url.href) return undefined;
    return url.origin;
  } catch { return undefined; }
}

function allowsRedirect(scope: HttpScope, currentUrl: string, nextUrl: string): boolean {
  const initialOrigin = new URL(currentUrl).origin;
  const nextOrigin = new URL(nextUrl).origin;
  if (nextOrigin === initialOrigin) return true;
  return scope.allowedRedirectOrigins?.some(value => exactHttpsOrigin(value) === nextOrigin) ?? false;
}

/** Also bounds OpenCLI's existing managed-process boundary without changing its environment. */
export async function withRequestLimits<T>(scope: Pick<HttpScope, 'policy' | 'signal'>, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (![scope.policy.requestTimeoutMs, scope.policy.maxResponseBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new ResearchAdapterError('RESEARCH_INVALID_LIMIT');
  if (scope.signal.aborted) throw new ResearchAdapterError('RESEARCH_ABORTED');
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (code: string) => { const error = new ResearchAdapterError(code); controller.abort(error); rejectAbort(error); };
  const onAbort = () => abort('RESEARCH_ABORTED');
  scope.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort('RESEARCH_TIMEOUT'), scope.policy.requestTimeoutMs);
  try { return await Promise.race([work(controller.signal), aborted]); }
  finally { clearTimeout(timer); scope.signal.removeEventListener('abort', onAbort); }
}

export function createHttpClient(options: { fetch?: HttpFetch } = {}) {
  const transport: HttpFetch = options.fetch ?? ((url, init) => fetch(url, init));
  return { async get(inputUrl: string, scope: HttpScope): Promise<HttpResult> {
    const initialUrl = approvedHttpsUrl(inputUrl, scope);
    return withRequestLimits(scope, async signal => {
      let url = initialUrl;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancel = () => { void reader?.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        for (let redirects = 0; ; redirects++) {
          signal.throwIfAborted();
          const response = await transport(url, {
            method: 'GET', redirect: 'manual', credentials: 'omit', signal,
            // Match the existing machine HTTP boundary. Empty explicitly disables ambient proxies.
            proxy: scope.network?.httpProxy ?? '',
          });
          if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
          reader = response.body?.getReader();
          if (response.redirected || (response.url && response.url !== url)) throw new ResearchAdapterError('RESEARCH_REDIRECT_REJECTED');
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            cancel(); reader = undefined;
            try {
              const location = response.headers.get('location');
              if (!location || redirects >= 5) throw new Error();
              // Validate traversal before URL resolution erases it.
              const locationPath = location.split(/[?#]/, 1)[0]!;
              if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(decodeURIComponent(locationPath)) || /%2f|%5c|\\/i.test(locationPath)) throw new Error();
              const next = approvedHttpsUrl(new URL(location, url).href, scope);
              if (!allowsRedirect(scope, url, next)) throw new Error();
              url = next;
              continue;
            } catch { throw new ResearchAdapterError('RESEARCH_REDIRECT_REJECTED'); }
          }
          if (!response.ok) throw new ResearchAdapterError('RESEARCH_HTTP_STATUS', response.status);
          const length = response.headers.get('content-length');
          if (length !== null && (!/^\d+$/.test(length) || Number(length) > scope.policy.maxResponseBytes)) throw new ResearchAdapterError('RESEARCH_RESPONSE_TOO_LARGE');
          const chunks: Uint8Array[] = []; let total = 0;
          while (reader) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            total += value.byteLength;
            if (total > scope.policy.maxResponseBytes) throw new ResearchAdapterError('RESEARCH_RESPONSE_TOO_LARGE');
            chunks.push(value);
          }
          return { url, status: response.status, headers: response.headers, bytes: new Uint8Array(Buffer.concat(chunks, total)) };
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof ResearchAdapterError) throw error;
        throw new ResearchAdapterError('RESEARCH_TRANSPORT_FAILED');
      } finally { cancel(); signal.removeEventListener('abort', cancel); }
    });
  } };
}
export type ResearchHttpClient = ReturnType<typeof createHttpClient>;
