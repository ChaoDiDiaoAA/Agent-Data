import { expect, test } from 'bun:test';
import { createHttpClient, type HttpScope } from '../src/research/http-client.ts';
import type { SourcePolicyConfig } from '../src/types/research-sources.ts';
import { normalizeHtml, OfficialDocAdapter } from '../src/research/adapters/official-doc-adapter.ts';
import { approveCandidate, type DiscoveryInput } from '../src/research/adapters/types.ts';
import { sha256 } from '../src/research/source-identity.ts';

const policy: SourcePolicyConfig = {
  dateLowerBound: '2026-01-01', sourceKinds: ['official-doc'], allowedDomains: ['docs.example.com'],
  identityVersionRules: {} as SourcePolicyConfig['identityVersionRules'], maxResponseBytes: 4096,
  requestTimeoutMs: 100, maxAttempts: 1, retainAllVersions: true, contentHash: 'sha256',
};
const scope = (patch: Partial<HttpScope> = {}): HttpScope => ({ policy, allowedDomains: ['docs.example.com'], signal: new AbortController().signal, ...patch });

test('HTTP returns bounded bytes and final headers through the configured machine proxy without changing env', async () => {
  const before = { ...process.env };
  const requests: { url: string; options: RequestInit & { proxy?: string } }[] = [];
  const client = createHttpClient({ fetch: async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? new Response(null, { status: 302, headers: { location: '/guide' } })
      : new Response('abc', { headers: { etag: '"r1"' } });
  } });
  const result = await client.get('https://docs.example.com/start', scope({ network: { httpProxy: 'http://proxy.example.com:8080' } }));
  expect(result.url).toBe('https://docs.example.com/guide');
  expect(Buffer.from(result.bytes).toString()).toBe('abc');
  expect(result.headers.get('etag')).toBe('"r1"');
  expect(requests.map(r => r.options.proxy)).toEqual(['http://proxy.example.com:8080', 'http://proxy.example.com:8080']);
  expect(requests[0].options.redirect).toBe('manual');
  expect(requests[0].options.credentials).toBe('omit');
  expect(process.env).toEqual(before);
});

test('HTTP rejects unapproved, credential, traversal and non-HTTPS URLs before transport', async () => {
  let calls = 0;
  const client = createHttpClient({ fetch: async () => { calls++; return new Response('bad'); } });
  for (const url of ['http://docs.example.com/a', 'https://evil.example.com/a', 'https://u:p@docs.example.com/a', 'https://docs.example.com/a/../secret']) {
    await expect(client.get(url, scope())).rejects.toMatchObject({ code: 'RESEARCH_URL_REJECTED' });
  }
  expect(calls).toBe(0);
});

test('HTTP refuses redirect scope expansion, downgrade and loops', async () => {
  for (const location of ['https://evil.example.com/a', 'http://docs.example.com/a', '/loop']) {
    let calls = 0;
    const client = createHttpClient({ fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); } });
    await expect(client.get('https://docs.example.com/a', scope())).rejects.toMatchObject({ code: 'RESEARCH_REDIRECT_REJECTED' });
    expect(calls).toBeLessThanOrEqual(6);
  }
});

test('HTTP caps streamed/decompressed bytes and advertised length and cancels failed bodies', async () => {
  for (const advertised of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(30)); }, cancel() { cancelled = true; } });
    const client = createHttpClient({ fetch: async () => new Response(stream, { headers: advertised ? { 'content-length': '30' } : {} }) });
    await expect(client.get('https://docs.example.com/a', scope({ policy: { ...policy, maxResponseBytes: 20 } }))).rejects.toMatchObject({ code: 'RESEARCH_RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  }
});

test('HTTP times out even a non-cooperative transport and aborts its signal', async () => {
  let signal: AbortSignal | undefined;
  const client = createHttpClient({ fetch: async (_url, options) => { signal = options.signal!; return new Promise<Response>(() => {}); } });
  await expect(client.get('https://docs.example.com/a', scope({ policy: { ...policy, requestTimeoutMs: 15 } }))).rejects.toMatchObject({ code: 'RESEARCH_TIMEOUT' });
  expect(signal?.aborted).toBe(true);
});

test('HTTP aborts stalled body reads and handles pre-abort without transport', async () => {
  const controller = new AbortController(); let calls = 0; let cancelled = false;
  const client = createHttpClient({ fetch: async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); } });
  const pending = client.get('https://docs.example.com/a', scope({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toMatchObject({ code: 'RESEARCH_ABORTED' });
  expect(cancelled).toBe(true);
  await expect(client.get('https://docs.example.com/a', scope({ signal: controller.signal }))).rejects.toMatchObject({ code: 'RESEARCH_ABORTED' });
  expect(calls).toBe(1);
});

test('HTTP reports stable status and transport errors', async () => {
  await expect(createHttpClient({ fetch: async () => new Response('no', { status: 503 }) }).get('https://docs.example.com/a', scope())).rejects.toMatchObject({ code: 'RESEARCH_HTTP_STATUS', status: 503 });
  await expect(createHttpClient({ fetch: async () => { throw new Error('socket secret'); } }).get('https://docs.example.com/a', scope())).rejects.toMatchObject({ code: 'RESEARCH_TRANSPORT_FAILED' });
});

const html = '<!DOCTYPE html><html><head><title>Agent Guide</title></head><body><h1 id="loop">Agent Loop</h1><p>Observe &amp; act. <a href="/reference#tools">Tools</a></p><script>throw new Error("never execute")</script></body></html>';
function discovery(patch: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return { ...scope(), track: { id: 'agent-loop', query: 'agent', sourceKinds: ['official-doc'], arxivCategories: [], domains: ['docs.example.com'], dateFields: ['retrieved'] },
    query: 'agent', window: { from: '2026-01-01', to: '2026-09-06' }, allowedSourceKinds: ['official-doc'],
    targets: [{ kind: 'official-doc', url: 'https://docs.example.com/start' }], ...patch };
}
function docAdapter(body = html) {
  return new OfficialDocAdapter({ now: () => '2026-09-06T00:00:00.000Z', http: createHttpClient({ fetch: async () => new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8', etag: '"v1"', 'last-modified': 'Fri, 04 Sep 2026 00:00:00 GMT' },
  }) }) });
}

test('official docs preserve raw HTML and HTTP provenance with deterministic Markdown and citation locators', async () => {
  const adapter = docAdapter(); const input = discovery();
  const [candidate] = await adapter.discover(input);
  const fetched = await adapter.fetch({ candidate: approveCandidate(candidate, input), signal: input.signal });
  const file = (path: string) => Buffer.from(fetched.files.find(f => f.path === path)!.contents).toString();
  expect(candidate.source.title).toBe('Agent Guide');
  expect(candidate.dateMatches).toEqual(['retrieved']);
  expect(file('content.html')).toBe(html);
  expect(file('content.md')).toBe('# Agent Guide\n\n# Agent Loop\n\nObserve & act. [Tools](https://docs.example.com/reference#tools)\n');
  expect(fetched.version.contentSha256).toBe(sha256(file('content.md')));
  expect(JSON.parse(file('metadata/http.json'))).toMatchObject({ url: 'https://docs.example.com/start', status: 200, etag: '"v1"', lastModified: 'Fri, 04 Sep 2026 00:00:00 GMT', retrievedAt: '2026-09-06T00:00:00.000Z', rawSha256: sha256(html) });
  expect(fetched.locators).toContainEqual({ artifactPath: 'content.md', section: 'Agent Loop', fragment: 'loop', startLine: 3, endLine: 3 });
  expect(fetched.locators).toContainEqual({ artifactPath: 'content.html', section: 'https://docs.example.com/reference#tools', fragment: 'tools' });
  expect(await adapter.fetch({ candidate: approveCandidate(candidate, input), signal: input.signal })).toEqual(fetched);
});

test('HTML normalization emits deterministic standalone named-anchor locators without changing headings or links', async () => {
  const body = '<!DOCTYPE html><html><head><title>Anchors</title></head><body><a id="setup"></a><h2 id="heading">Heading</h2><p><a name="setup"></a>Read <a href="/guide#part">the guide</a>.</p></body></html>';
  const normalized = await normalizeHtml(Buffer.from(body), 'https://docs.example.com/start');
  expect(normalized.markdown).toBe('# Anchors\n\n## Heading\n\nRead [the guide](https://docs.example.com/guide#part).\n');
  expect(normalized.locators).toContainEqual({ artifactPath: 'content.md', section: 'Heading', fragment: 'heading', startLine: 3, endLine: 3 });
  expect(normalized.locators).toContainEqual({ artifactPath: 'content.html', section: 'https://docs.example.com/guide#part', fragment: 'part' });
  expect(normalized.locators.filter(locator => locator.fragment === 'setup')).toEqual([
    { artifactPath: 'content.html', section: 'setup', fragment: 'setup' },
    { artifactPath: 'content.md', section: 'setup', fragment: 'setup' },
  ]);
});

test('official fetch keeps approved source and version authoritative across fresh retrieval observations', async () => {
  let now = '2026-09-06T00:00:00.000Z';
  let etag = '"v1"';
  const adapter = new OfficialDocAdapter({ now: () => now, http: createHttpClient({ fetch: async () => new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', etag, 'last-modified': 'Fri, 04 Sep 2026 00:00:00 GMT' },
  }) }) });
  const request = discovery();
  const [candidate] = await adapter.discover(request);
  const approved = approveCandidate(candidate, request);
  now = '2026-09-07T00:00:00.000Z';
  etag = '"v2"';
  const fetched = await adapter.fetch({ candidate: approved, signal: request.signal });
  const metadata = JSON.parse(Buffer.from(fetched.files.find(file => file.path === 'metadata/http.json')!.contents).toString());
  expect(fetched.source).toEqual(approved.source);
  expect(fetched.version).toEqual(approved.version);
  expect(metadata).toMatchObject({ etag: '"v2"', retrievedAt: '2026-09-07T00:00:00.000Z' });
});

test('official fetch structurally rejects changed stable HTTP, source and version metadata', async () => {
  let lastModified = 'Fri, 04 Sep 2026 00:00:00 GMT';
  const adapter = new OfficialDocAdapter({ now: () => '2026-09-06T00:00:00.000Z', http: createHttpClient({ fetch: async () => new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', etag: '"v1"', 'last-modified': lastModified },
  }) }) });
  const request = discovery();
  const [candidate] = await adapter.discover(request);
  const approved = approveCandidate(candidate, request);
  lastModified = 'Sat, 05 Sep 2026 00:00:00 GMT';
  await expect(adapter.fetch({ candidate: approved, signal: request.signal })).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_CHANGED' });
  lastModified = 'Fri, 04 Sep 2026 00:00:00 GMT';

  const expectChanged = async (mutate: (value: typeof candidate) => void) => {
    const changed = structuredClone(candidate);
    mutate(changed);
    await expect(adapter.fetch({ candidate: approveCandidate(changed, request), signal: request.signal }))
      .rejects.toMatchObject({ code: 'RESEARCH_SOURCE_CHANGED' });
  };
  await expectChanged(value => { value.source.title = 'Changed title'; });
  await expectChanged(value => { value.version.versionLabel = 'changed-label'; });
  await expectChanged(value => { value.version.archivePath = 'changed/source.json'; });
  await expectChanged(value => { value.version.provenance.urls.push('https://docs.example.com/other'); });
  await expectChanged(value => { value.version.provenance.notes = [value.version.provenance.notes!.join(',')]; });
});

test('official docs reject malformed HTML and non-HTML content with stable errors', async () => {
  for (const body of ['not HTML', '<html><body><h1>Missing close</body></html>', '<html><body><p>bad\u0000text</p></body></html>']) {
    await expect(docAdapter(body).discover(discovery())).rejects.toMatchObject({ code: 'RESEARCH_HTML_INVALID' });
  }
  const adapter = new OfficialDocAdapter({ http: createHttpClient({ fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) }) });
  await expect(adapter.discover(discovery())).rejects.toMatchObject({ code: 'RESEARCH_HTML_INVALID' });
});

test('official docs enforce policy kind, Track domain and date window before approval', async () => {
  const adapter = docAdapter();
  await expect(adapter.discover(discovery({ allowedSourceKinds: [] }))).rejects.toMatchObject({ code: 'RESEARCH_POLICY_REJECTED' });
  await expect(adapter.discover(discovery({ track: { ...discovery().track, domains: ['other.example.com'] } }))).rejects.toMatchObject({ code: 'RESEARCH_URL_REJECTED' });
  await expect(adapter.discover(discovery({ window: { from: '2025-01-01', to: '2026-09-06' } }))).rejects.toMatchObject({ code: 'RESEARCH_POLICY_REJECTED' });
  expect(await adapter.discover(discovery({ window: { from: '2026-01-01', to: '2026-01-02' } }))).toEqual([]);
});

test('fetch refuses forged approval and detects raw HTML changes even when normalized text stays identical', async () => {
  let body = html;
  const adapter = new OfficialDocAdapter({ now: () => '2026-09-06T00:00:00.000Z', http: createHttpClient({ fetch: async () => new Response(body, { headers: { 'content-type': 'text/html' } }) }) });
  const input = discovery(); const [candidate] = await adapter.discover(input);
  await expect(adapter.fetch({ candidate: candidate as ReturnType<typeof approveCandidate>, signal: input.signal })).rejects.toMatchObject({ code: 'RESEARCH_APPROVAL_REQUIRED' });
  const approved = approveCandidate(candidate, input);
  body = html.replace('<body>', '<body class="changed">');
  await expect(adapter.fetch({ candidate: approved, signal: input.signal })).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_CHANGED' });
});
