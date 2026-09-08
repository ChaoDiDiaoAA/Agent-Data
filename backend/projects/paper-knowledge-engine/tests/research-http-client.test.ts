import { expect, test } from 'bun:test';
import { createHttpClient, type HttpScope } from '../src/research/http-client.ts';
import type { SourcePolicyConfig } from '../src/types/research-sources.ts';

const policy: SourcePolicyConfig = {
  dateLowerBound: '2026-01-01', sourceKinds: ['official-doc'], allowedDomains: ['source.example', 'cdn.example'],
  identityVersionRules: {} as SourcePolicyConfig['identityVersionRules'], maxResponseBytes: 4096,
  requestTimeoutMs: 100, maxAttempts: 1, retainAllVersions: true, contentHash: 'sha256',
};

function scope(patch: Partial<HttpScope> = {}): HttpScope {
  return { policy, allowedDomains: ['source.example', 'cdn.example'], signal: new AbortController().signal, ...patch };
}

test('HTTP rejects a cross-origin redirect unless that origin is explicitly allowed', async () => {
  const client = createHttpClient({ fetch: async () => new Response(null, { status: 302, headers: { location: 'https://cdn.example/file' } }) });

  await expect(client.get('https://source.example/file', scope())).rejects.toMatchObject({ code: 'RESEARCH_REDIRECT_REJECTED' });
});

test('HTTP follows an explicitly allowed HTTPS redirect origin', async () => {
  const requests: string[] = [];
  const client = createHttpClient({ fetch: async url => {
    requests.push(url);
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/file' } })
      : new Response('downloaded');
  } });

  const result = await client.get('https://source.example/file', scope({ allowedRedirectOrigins: ['https://cdn.example'] }));

  expect(Buffer.from(result.bytes).toString()).toBe('downloaded');
  expect(result.url).toBe('https://cdn.example/file');
  expect(requests).toEqual(['https://source.example/file', 'https://cdn.example/file']);
});

test('HTTP checks every redirect hop against the domain and source policy', async () => {
  const client = createHttpClient({ fetch: async () => new Response(null, { status: 302, headers: { location: 'https://cdn.example/file' } }) });
  const redirectScope = { allowedRedirectOrigins: ['https://cdn.example'] };

  await expect(client.get('https://source.example/file', scope({ ...redirectScope, allowedDomains: ['source.example'] })))
    .rejects.toMatchObject({ code: 'RESEARCH_REDIRECT_REJECTED' });
  await expect(client.get('https://source.example/file', scope({ ...redirectScope, policy: { ...policy, allowedDomains: ['source.example'] } })))
    .rejects.toMatchObject({ code: 'RESEARCH_REDIRECT_REJECTED' });
});

test('HTTP does not treat a later cross-origin hop as same-origin with the initial URL', async () => {
  const requests: string[] = [];
  const client = createHttpClient({ fetch: async url => {
    requests.push(url);
    if (requests.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/file' } });
    if (requests.length === 2) return new Response(null, { status: 302, headers: { location: 'https://source.example/file' } });
    return new Response('must not fetch');
  } });

  await expect(client.get('https://source.example/file', scope({ allowedRedirectOrigins: ['https://cdn.example'] })))
    .rejects.toMatchObject({ code: 'RESEARCH_REDIRECT_REJECTED' });
  expect(requests).toEqual(['https://source.example/file', 'https://cdn.example/file']);
});
