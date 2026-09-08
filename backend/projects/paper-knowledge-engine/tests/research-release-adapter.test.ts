import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { ReleaseAdapter } from '../src/research/adapters/release-adapter.ts';
import { approveCandidate, type DiscoveryInput, type PolicyApprovedCandidate } from '../src/research/adapters/types.ts';
import { createHttpClient, type HttpFetch } from '../src/research/http-client.ts';
import type { ResearchCandidate, SourcePolicyConfig } from '../src/types/research-sources.ts';

const projectUrl = 'https://github.com/Example/Project.git';
const releaseUrl = 'https://github.com/Example/Project/releases/tag/v1.2.0';
const repositoryApiUrl = 'https://api.github.com/repos/Example/Project';
const releaseApiUrl = `${repositoryApiUrl}/releases/tags/v1.2.0`;
const tag = 'refs/tags/v1.2.0';

function input(revision: string | null = tag, patch: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return {
    track: { id: 'runtime-execution', query: 'release', sourceKinds: ['release'], arxivCategories: [], domains: ['github.com', 'api.github.com'], dateFields: ['released', 'retrieved'] },
    query: 'release', window: { from: '2026-01-01', to: '2026-09-07' }, allowedSourceKinds: ['release'], allowedDomains: ['github.com', 'api.github.com'],
    policy: { dateLowerBound: '2026-01-01', sourceKinds: ['release'], allowedDomains: ['github.com', 'api.github.com'],
      identityVersionRules: {} as SourcePolicyConfig['identityVersionRules'], maxResponseBytes: 10000,
      requestTimeoutMs: 1000, maxAttempts: 1, retainAllVersions: true, contentHash: 'sha256' },
    signal: new AbortController().signal,
    targets: [{ kind: 'release', url: projectUrl, ...(revision === null ? {} : { revision }) }], purpose: 'research', ...patch,
  };
}

function metadata(patch: Record<string, unknown> = {}) {
  return {
    id: 123, url: `${repositoryApiUrl}/releases/123`, html_url: releaseUrl,
    tag_name: 'v1.2.0', name: 'Project 1.2.0', draft: false, prerelease: false,
    body: '## Changes\r\n\r\n- Added controlled tools\r\n', published_at: '2026-09-05T12:30:00Z',
    created_at: '2026-09-01T00:00:00Z', target_commitish: 'main',
    assets_url: `${repositoryApiUrl}/releases/123/assets`,
    tarball_url: `${repositoryApiUrl}/tarball/v1.2.0`, zipball_url: `${repositoryApiUrl}/zipball/v1.2.0`,
    assets: [
      { id: 1, name: 'checksums.txt', url: `${repositoryApiUrl}/releases/assets/1`, browser_download_url: 'https://github.com/Example/Project/releases/download/v1.2.0/checksums.txt', content_type: 'text/plain', size: 120 },
      { id: 2, name: 'project.zip', url: `${repositoryApiUrl}/releases/assets/2`, browser_download_url: 'https://github.com/Example/Project/releases/download/v1.2.0/project.zip', content_type: 'application/zip', size: 5000 },
    ],
    ...patch,
  };
}

function repositoryMetadata(patch: Record<string, unknown> = {}) {
  return { id: 456, name: 'Project', full_name: 'Example/Project', private: false, visibility: 'public',
    html_url: 'https://github.com/Example/Project', url: repositoryApiUrl, default_branch: 'main', ...patch };
}

function fixture(payload: () => unknown = () => metadata(), contentType = 'application/json; charset=utf-8',
  repository: () => unknown = () => repositoryMetadata()) {
  const requests: string[] = [];
  const options: RequestInit[] = [];
  const fetch: HttpFetch = async (url, init) => {
    requests.push(url);
    options.push(init);
    if (url !== releaseApiUrl && url !== repositoryApiUrl) throw new Error(`unexpected request: ${url}`);
    return new Response(JSON.stringify(url === repositoryApiUrl ? repository() : payload()), { headers: { 'content-type': contentType, etag: '"release-1"' } });
  };
  return { requests, options, adapter: new ReleaseAdapter({ http: createHttpClient({ fetch }), now: () => '2026-09-07T00:00:00.000Z' }) };
}

test('fixed public release returns deterministic metadata/notes and parent repository provenance without downloading assets', async () => {
  const f = fixture(); const request = input();
  const [candidate] = await f.adapter.discover(request);
  expect(f.requests).toEqual([repositoryApiUrl, releaseApiUrl]);
  for (const options of f.options) {
    expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual' });
    expect(new Headers(options.headers).has('authorization')).toBe(false);
    expect(new Headers(options.headers).has('cookie')).toBe(false);
  }
  expect(candidate.source).toMatchObject({
    identityKey: 'release:https://github.com/example/project:v1.2.0', canonicalUrl: 'https://github.com/example/project',
    kind: 'release', title: 'Project 1.2.0', publisher: 'github.com', primaryTrack: 'runtime-execution',
  });
  expect(candidate.version).toMatchObject({ versionId: 'v1.2.0', versionLabel: 'Project 1.2.0', releasedAt: '2026-09-05T12:30:00.000Z' });
  expect(candidate.version.provenance).toEqual({
    adapter: 'release', parentSourceId: createHash('sha256').update('repo:https://github.com/example/project').digest('hex').slice(0, 32),
    urls: [repositoryApiUrl, releaseApiUrl, releaseUrl, 'https://github.com/example/project'],
    revision: 'v1.2.0', notes: ['asset-count:2', 'etag:"release-1"'],
  });
  expect(candidate.dateMatches).toEqual(['released', 'retrieved']);

  const fetched = await f.adapter.fetch({ candidate: approveCandidate(candidate, request), signal: request.signal });
  const file = (path: string) => Buffer.from(fetched.files.find(value => value.path === path)!.contents).toString();
  expect(file('content.md')).toBe('# Project 1.2.0\n\n## Changes\n\n- Added controlled tools\n');
  expect(JSON.parse(file('metadata/release.json'))).toEqual({
    schemaVersion: 1, projectUrl: 'https://github.com/example/project', releaseUrl, visibility: 'public', tag: 'v1.2.0',
    name: 'Project 1.2.0', publishedAt: '2026-09-05T12:30:00.000Z', updatedAt: null,
    provider: { name: 'github', repositoryUrl: repositoryApiUrl, releaseUrl: `${repositoryApiUrl}/releases/123`, releaseId: 123 },
    assets: [
      { name: 'checksums.txt', url: 'https://github.com/Example/Project/releases/download/v1.2.0/checksums.txt', mediaType: 'text/plain', size: 120 },
      { name: 'project.zip', url: 'https://github.com/Example/Project/releases/download/v1.2.0/project.zip', mediaType: 'application/zip', size: 5000 },
    ],
  });
  expect(fetched.files.map(value => value.path)).toEqual(['content.md', 'metadata/release.json']);
  expect(fetched.locators).toEqual([{ artifactPath: 'content.md', section: 'Project 1.2.0', startLine: 1, endLine: 1 }]);
  expect(f.requests).toEqual([repositoryApiUrl, releaseApiUrl, repositoryApiUrl, releaseApiUrl]);
});

test('release fetch requires live approval and rejects changed metadata or notes', async () => {
  let body = metadata(); const f = fixture(() => body); const request = input();
  const [candidate] = await f.adapter.discover(request);
  await expect(f.adapter.fetch({ candidate: candidate as PolicyApprovedCandidate, signal: request.signal }))
    .rejects.toMatchObject({ code: 'RESEARCH_APPROVAL_REQUIRED' });
  const approved = approveCandidate(candidate, request);
  body = metadata({ body: 'changed' });
  await expect(f.adapter.fetch({ candidate: approved, signal: request.signal })).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_CHANGED' });
});

test('unfixed or unsafe tags and unapproved project URLs are rejected before HTTP', async () => {
  const f = fixture();
  for (const revision of [null, 'main', 'v1.2.0', 'refs/heads/v1.2.0', 'refs/tags/../v1', 'refs/tags/release/v1']) {
    await expect(f.adapter.discover(input(revision))).rejects.toMatchObject({ code: 'RESEARCH_RELEASE_TAG_REJECTED' });
  }
  for (const url of ['http://github.com/Example/Project', 'https://user:secret@github.com/Example/Project',
    'https://evil.example.com/Example/Project', 'https://github.com/Example/../Private']) {
    await expect(f.adapter.discover(input(tag, { targets: [{ kind: 'release', url, revision: tag }] })))
      .rejects.toMatchObject({ code: 'RESEARCH_URL_REJECTED' });
  }
  expect(f.requests).toEqual([]);
});

test('private or mismatched release metadata fails closed', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ draft: true }, 'RESEARCH_RELEASE_PRIVATE'],
    [{ draft: null }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
    [{ html_url: 'https://github.com/Example/Other/releases/tag/v1.2.0' }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
    [{ url: 'https://api.github.com/repos/Example/Other/releases/123' }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
    [{ id: 124 }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
    [{ tag_name: 'v1.2.1' }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
    [{ published_at: 'not-a-date' }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
    [{ published_at: null }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
    [{ body: 'bad\u0000notes' }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
  ];
  for (const [patch, code] of cases) {
    const f = fixture(() => metadata(patch));
    await expect(f.adapter.discover(input())).rejects.toMatchObject({ code });
  }
});

test('release enforces response type/size, source policy, date window and cancellation through the shared HTTP boundary', async () => {
  await expect(fixture(() => metadata(), 'text/html').adapter.discover(input())).rejects.toMatchObject({ code: 'RESEARCH_RELEASE_METADATA_REJECTED' });
  const oversized = fixture(() => metadata());
  await expect(oversized.adapter.discover(input(tag, { policy: { ...input().policy, maxResponseBytes: 10 } })))
    .rejects.toMatchObject({ code: 'RESEARCH_RESPONSE_TOO_LARGE' });
  await expect(fixture().adapter.discover(input(tag, { allowedSourceKinds: [] }))).rejects.toMatchObject({ code: 'RESEARCH_POLICY_REJECTED' });
  expect(await fixture().adapter.discover(input(tag, { window: { from: '2026-01-01', to: '2026-01-02' } }))).toEqual([]);
  const controller = new AbortController(); controller.abort();
  await expect(fixture().adapter.discover(input(tag, { signal: controller.signal }))).rejects.toMatchObject({ code: 'RESEARCH_ABORTED' });
});

const releaseTampering: [string, (candidate: ResearchCandidate) => void][] = [
  ['title', c => { c.source.title = 'Forged'; }],
  ['publisher', c => { c.source.publisher = 'Forged'; }],
  ['authors', c => { c.source.authors = ['Forged']; }],
  ['primary Track', c => { c.source.primaryTrack = 'forged'; }],
  ['secondary Tracks', c => { c.source.secondaryTracks = ['forged']; }],
  ['dimensions', c => { c.source.dimensions = { lifecycles: ['forged'] }; }],
  ['version label', c => { c.version.versionLabel = 'Forged'; }],
  ['published date', c => { c.version.publishedAt = '2026-09-06'; }],
  ['updated date', c => { c.version.updatedAt = '2026-09-06'; }],
  ['released date', c => { c.version.releasedAt = '2026-09-06'; }],
  ['hash', c => { c.version.contentSha256 = 'a'.repeat(64); }],
  ['archive path', c => { c.version.archivePath = 'forged/content.md'; }],
  ['provenance URLs', c => { c.version.provenance.urls = ['https://github.com/example/other']; }],
  ['provenance adapter', c => { c.version.provenance.adapter = 'forged'; }],
  ['provenance parent', c => { c.version.provenance.parentSourceId = 'a'.repeat(32); }],
  ['provenance revision', c => { c.version.provenance.revision = 'v9'; }],
  ['notes comma collision', c => { c.version.provenance.notes = [c.version.provenance.notes!.join(',')]; }],
];
for (const [field, tamper] of releaseTampering) {
  test(`release replay rejects reapproved ${field} tampering`, async () => {
    const request = input(); const [candidate] = await fixture().adapter.discover(request);
    const replay: ResearchCandidate = JSON.parse(JSON.stringify(candidate));
    tamper(replay);
    await expect(fixture().adapter.fetch({ candidate: approveCandidate(replay, request), signal: request.signal }))
      .rejects.toMatchObject({ code: 'RESEARCH_SOURCE_CHANGED' });
  });
}

test('release notes preserve leading blank lines, code indentation and internal Markdown whitespace', async () => {
  const notes = '\r\n    code()\r\n\r\nparagraph  \r\nnext\r\n\r\n';
  const f = fixture(() => metadata({ body: notes })); const request = input();
  const [candidate] = await f.adapter.discover(request);
  const fetched = await f.adapter.fetch({ candidate: approveCandidate(candidate, request), signal: request.signal });
  expect(Buffer.from(fetched.files[0].contents).toString()).toBe('# Project 1.2.0\n\n\n    code()\n\nparagraph  \nnext\n');
  const [unindented] = await fixture(() => metadata({ body: notes.replace('    code()', 'code()') })).adapter.discover(request);
  expect(candidate.version.contentSha256).not.toBe(unindented.version.contentSha256);
  const [lfOnly] = await fixture(() => metadata({ body: notes.replace(/\r\n/g, '\n') })).adapter.discover(request);
  expect(candidate.version.contentSha256).toBe(lfOnly.version.contentSha256);
  const [blank] = await fixture(() => metadata({ body: ' \r\n\t\r\n' })).adapter.discover(request);
  const [empty] = await fixture(() => metadata({ body: '' })).adapter.discover(request);
  expect(blank.version.contentSha256).toBe(empty.version.contentSha256);
});

test('GitHub mapping requires API allowlisting in every policy layer before HTTP', async () => {
  for (const patch of [
    { allowedDomains: ['github.com'] },
    { track: { ...input().track, domains: ['github.com'] } },
    { policy: { ...input().policy, allowedDomains: ['github.com'] } },
  ]) {
    const f = fixture();
    await expect(f.adapter.discover(input(tag, patch))).rejects.toMatchObject({ code: 'RESEARCH_URL_REJECTED' });
    expect(f.requests).toEqual([]);
  }
  for (const url of ['https://github.com/Example/Project/issues', 'https://github.com/Example/Project?redirect=other']) {
    const f = fixture();
    await expect(f.adapter.discover(input(tag, { targets: [{ kind: 'release', url, revision: tag }] })))
      .rejects.toMatchObject({ code: 'RESEARCH_RELEASE_PROVIDER_REJECTED' });
    expect(f.requests).toEqual([]);
  }
});

test('GitHub repository metadata must independently confirm the fixed public project', async () => {
  for (const [patch, code] of [
    [{ private: true }, 'RESEARCH_RELEASE_PRIVATE'],
    [{ visibility: 'private' }, 'RESEARCH_RELEASE_PRIVATE'],
    [{ private: null }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
    [{ visibility: 'internal' }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
    [{ html_url: 'https://github.com/Example/Other' }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
    [{ url: 'https://api.github.com/repos/Example/Other' }, 'RESEARCH_RELEASE_METADATA_REJECTED'],
  ] as [Record<string, unknown>, string][]) {
    const f = fixture(() => metadata(), 'application/json', () => repositoryMetadata(patch));
    await expect(f.adapter.discover(input())).rejects.toMatchObject({ code });
    expect(f.requests).toEqual([repositoryApiUrl]);
  }
});

test('GitHub nullable name/body and optional update time follow the provider schema', async () => {
  const f = fixture(() => metadata({ name: null, body: null, updated_at: '2026-09-06T00:00:00Z' }));
  const [candidate] = await f.adapter.discover(input());
  expect(candidate.source.title).toBe('v1.2.0');
  expect(candidate.version.updatedAt).toBe('2026-09-06T00:00:00.000Z');
  const request = input();
  const fetched = await f.adapter.fetch({ candidate: approveCandidate(candidate, request), signal: request.signal });
  expect(Buffer.from(fetched.files[0].contents).toString()).toBe('# v1.2.0\n');
});

test('GitHub asset descriptors remain default-closed for unsafe URLs and malformed entries', async () => {
  for (const url of ['http://github.com/Example/file', 'https://user:secret@github.com/Example/file',
    'https://evil.example.com/file', 'https://api.github.com/repos/Example/Project/releases/assets/1']) {
    const f = fixture(() => metadata({ assets: [{ ...metadata().assets[0], browser_download_url: url }] }));
    await expect(f.adapter.discover(input())).rejects.toMatchObject({ code: 'RESEARCH_RELEASE_METADATA_REJECTED' });
    expect(f.requests).toEqual([repositoryApiUrl, releaseApiUrl]);
  }
  for (const entry of [null, 1, [], {}, { ...metadata().assets[0], size: -1 }]) {
    await expect(fixture(() => metadata({ assets: [entry] })).adapter.discover(input()))
      .rejects.toMatchObject({ code: 'RESEARCH_RELEASE_METADATA_REJECTED' });
  }
});

test('release replay replaces untrusted retrieval time and enforces the recaptured date window', async () => {
  const request = input(tag, { track: { ...input().track, dateFields: ['retrieved'] } });
  const [candidate] = await fixture().adapter.discover(request);
  const replay: ResearchCandidate = JSON.parse(JSON.stringify(candidate));
  replay.version.retrievedAt = '2026-01-02T00:00:00.000Z';
  replay.source = Object.fromEntries(Object.entries(replay.source).reverse()) as ResearchCandidate['source'];
  const approved = approveCandidate(replay, request);
  const fetched = await fixture().adapter.fetch({ candidate: approved, signal: request.signal });
  expect(fetched.source).toEqual(candidate.source);
  expect(fetched.source).not.toBe(approved.source);
  expect(fetched.version.retrievedAt).toBe('2026-09-07T00:00:00.000Z');
  const outside = input(tag, { ...request, window: { from: '2026-01-01', to: '2026-01-02' } });
  await expect(fixture().adapter.fetch({ candidate: approveCandidate(replay, outside), signal: request.signal }))
    .rejects.toMatchObject({ code: 'RESEARCH_POLICY_REJECTED' });
});
