import { createHttpClient, ResearchAdapterError, type HttpFetch, type HttpScope, type ResearchHttpClient } from '../engine-bridge.ts';
import type { SourceConfig } from '../contracts.ts';

export interface RedirectHop { from_origin: string; to_origin: string }
export interface SourceTransport { http: ResearchHttpClient; redirect_chain: RedirectHop[] }

export function assertRevision(revision: string): void {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('INVALID_HUGGINGFACE_REVISION');
}

/** Capture only origins, never signed CDN query strings. Shared HTTP retains all other policy checks. */
export function createSourceHttp(config: SourceConfig, options: { fetch?: HttpFetch; network?: HttpScope['network'] } = {}): SourceTransport {
  const redirect_chain: RedirectHop[] = [];
  const transport = options.fetch ?? ((url, init) => fetch(url, init));
  const client = createHttpClient({ fetch: async (url, init) => {
    const response = await transport(url, init);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (location) {
        const from = new URL(url).origin;
        let to: string;
        try { to = new URL(location, url).origin; }
        catch { await response.body?.cancel(); throw new ResearchAdapterError('RESEARCH_REDIRECT_REJECTED'); }
        if (to !== from && !config.redirect_origins.includes(to)) {
          await response.body?.cancel();
          throw new ResearchAdapterError(`REDIRECT_ORIGIN_NOT_ALLOWED: ${to}`);
        }
        redirect_chain.push({ from_origin: from, to_origin: to });
      }
    }
    return response;
  } });
  return {
    redirect_chain,
    http: { async get(url, scope) {
      if (!config.allowed_origins.includes(new URL(url).origin)) throw new Error('SOURCE_ORIGIN_NOT_ALLOWED');
      const requestScope = options.network === undefined || scope.network !== undefined ? scope : { ...scope, network: options.network };
      return client.get(url, requestScope);
    } },
  };
}

export function metadataScope(config: SourceConfig, maxBytes: number): HttpScope {
  const domains = [...new Set([...config.allowed_origins, ...config.redirect_origins].map(origin => {
    const url = new URL(origin);
    if (origin !== url.origin || url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('SOURCE_ORIGIN_INVALID');
    return url.hostname;
  }))];
  return {
    policy: {
      dateLowerBound: '1970-01-01', sourceKinds: ['official-doc'], allowedDomains: domains,
      identityVersionRules: {} as HttpScope['policy']['identityVersionRules'], maxResponseBytes: maxBytes,
      requestTimeoutMs: 30_000, maxAttempts: 1, retainAllVersions: true, contentHash: 'sha256',
    },
    allowedDomains: domains, allowedRedirectOrigins: config.redirect_origins,
    signal: new AbortController().signal,
  };
}

export async function resolveHuggingFaceRevision(config: SourceConfig, options: { http?: ResearchHttpClient } = {}): Promise<string> {
  if (config.revision.kind !== 'huggingface-api') throw new Error('INVALID_REVISION_KIND');
  const http = options.http ?? createSourceHttp(config).http;
  const response = await http.get(config.revision.url, metadataScope(config, 2 * 1024 * 1024));
  const value: unknown = JSON.parse(Buffer.from(response.bytes).toString('utf8'));
  const sha = value && typeof value === 'object' && 'sha' in value ? value.sha : undefined;
  if (typeof sha !== 'string') throw new Error('INVALID_HUGGINGFACE_REVISION');
  assertRevision(sha);
  return sha;
}
