import { createHttpClient as createSharedHttpClient, ResearchAdapterError, type HttpFetch as SharedHttpFetch, type HttpScope } from './engine-bridge.ts';
import type { HttpClient, HttpResult, SourceConfig } from './contracts.ts';

export type HttpFetch = SharedHttpFetch;

function originsToDomains(origins: string[]): string[] {
  return [...new Set(origins.map(origin => new URL(origin).hostname))];
}

function redirectOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function resolveRedirect(source: SourceConfig, currentUrl: string, location: string): string {
  const locationPath = location.split(/[?#]/, 1)[0] ?? '';
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(locationPath); } catch { throw new ResearchAdapterError('RESEARCH_REDIRECT_REJECTED'); }
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(decodedPath) || /%5c|\\/i.test(locationPath)) throw new ResearchAdapterError('RESEARCH_REDIRECT_REJECTED');
  let next: URL;
  try { next = new URL(location, currentUrl); } catch { throw new ResearchAdapterError('RESEARCH_REDIRECT_REJECTED'); }
  if (next.protocol !== 'https:' || next.port || next.username || next.password) throw new ResearchAdapterError('RESEARCH_REDIRECT_REJECTED');
  const currentOrigin = new URL(currentUrl).origin;
  const nextOrigin = next.origin;
  const allowed = nextOrigin === currentOrigin || source.redirect_origins.some(origin => redirectOrigin(origin) === nextOrigin);
  if (!allowed) throw new ResearchAdapterError('RESEARCH_REDIRECT_REJECTED');
  // Hugging Face's cache endpoint uses an encoded slash for repository paths.
  // Keep the traversal checks above while allowing that one documented shape.
  if (/%2f/i.test(locationPath) && !(next.hostname === 'huggingface.co' && next.pathname.startsWith('/api/resolve-cache/'))) {
    throw new ResearchAdapterError('RESEARCH_REDIRECT_REJECTED');
  }
  return next.href;
}

async function followSourceRedirects(source: SourceConfig, transport: SharedHttpFetch, inputUrl: string, init: RequestInit & { proxy?: string }): Promise<Response> {
  let url = inputUrl;
  let redirected = false;
  for (let count = 0; ; count += 1) {
    const response = await transport(url, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!redirected && !response.redirected && (!response.url || response.url === inputUrl)) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    if (count >= 5) throw new ResearchAdapterError('RESEARCH_REDIRECT_REJECTED');
    const location = response.headers.get('location');
    if (!location) throw new ResearchAdapterError('RESEARCH_REDIRECT_REJECTED');
    const next = resolveRedirect(source, url, location);
    await response.body?.cancel().catch(() => undefined);
    redirected = true;
    url = next;
  }
}

export function createSourceHttp(source: SourceConfig, options: { fetch?: HttpFetch; network?: HttpScope['network'] } = {}): HttpClient {
  const baseFetch: SharedHttpFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const client = createSharedHttpClient({ fetch: (url, init) => followSourceRedirects(source, baseFetch, url, init) });
  return {
    async get(url, request) {
      const domains = originsToDomains([...source.allowed_origins, ...source.redirect_origins]);
      const scope: HttpScope = {
        policy: {
          dateLowerBound: '1970-01-01',
          sourceKinds: ['official-doc'],
          allowedDomains: domains,
          identityVersionRules: {} as HttpScope['policy']['identityVersionRules'],
          maxResponseBytes: request.maxBytes,
          requestTimeoutMs: request.timeoutMs,
          maxAttempts: 1,
          retainAllVersions: true,
          contentHash: 'sha256',
        },
        allowedDomains: domains,
        allowedRedirectOrigins: source.redirect_origins,
        ...(options.network ? { network: options.network } : {}),
        signal: request.signal ?? new AbortController().signal,
      };
      return client.get(url, scope) as Promise<HttpResult>;
    },
  };
}

export function metadataRequest(source: SourceConfig, maxBytes: number, timeoutMs: number, signal?: AbortSignal) {
  const domains = originsToDomains([...source.allowed_origins, ...source.redirect_origins]);
  return {
    policy: {
      dateLowerBound: '1970-01-01',
      sourceKinds: ['official-doc'] as ['official-doc'],
      allowedDomains: domains,
      identityVersionRules: {} as HttpScope['policy']['identityVersionRules'],
      maxResponseBytes: maxBytes,
      requestTimeoutMs: timeoutMs,
      maxAttempts: 1,
      retainAllVersions: true,
      contentHash: 'sha256',
    },
    allowedDomains: domains,
    allowedRedirectOrigins: source.redirect_origins,
    signal: signal ?? new AbortController().signal,
  } satisfies HttpScope;
}
