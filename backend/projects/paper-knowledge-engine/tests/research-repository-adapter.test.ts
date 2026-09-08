import { expect, test } from 'bun:test';
import { RepositoryAdapter, type RepositoryReadBoundary, type RepositoryReadRequest, type RepositorySnapshot } from '../src/research/adapters/repository-adapter.ts';
import { approveCandidate, type DiscoveryInput, type PolicyApprovedCandidate } from '../src/research/adapters/types.ts';
import type { ResearchCandidate, SourcePolicyConfig } from '../src/types/research-sources.ts';
import { sha256 } from '../src/research/source-identity.ts';

const commit = '0123456789abcdef0123456789abcdef01234567';
const otherCommit = '89abcdef0123456789abcdef0123456789abcdef';
const repositoryUrl = 'https://github.com/Example/Project.git';

function input(revision: string | null = commit, patch: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return {
    track: { id: 'agent-loop', query: 'repository', sourceKinds: ['repository'], arxivCategories: [], domains: ['github.com'], dateFields: ['retrieved'] },
    query: 'repository', window: { from: '2026-01-01', to: '2026-09-07' }, allowedSourceKinds: ['repository'], allowedDomains: ['github.com'],
    policy: { dateLowerBound: '2026-01-01', sourceKinds: ['repository'], allowedDomains: ['github.com'],
      identityVersionRules: {} as SourcePolicyConfig['identityVersionRules'], maxResponseBytes: 10000,
      requestTimeoutMs: 1000, maxAttempts: 1, retainAllVersions: true, contentHash: 'sha256' },
    signal: new AbortController().signal, targets: [{ kind: 'repository', url: repositoryUrl, ...(revision === null ? {} : { revision }) }],
    purpose: 'research', ...patch,
  };
}

function snapshot(patch: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    canonicalUrl: repositoryUrl, visibility: 'public', commit, tag: null, defaultBranch: 'main',
    files: [
      { path: 'src/z.ts', type: 'text', contents: Buffer.from('export const z = 1;\n') },
      { path: 'README.md', type: 'text', contents: Buffer.from('# Project\n') },
    ],
    ...patch,
  };
}

function boundary(value: RepositorySnapshot | ((request: RepositoryReadRequest) => RepositorySnapshot | Promise<RepositorySnapshot>)) {
  const calls: RepositoryReadRequest[] = [];
  const read: RepositoryReadBoundary = { async read(request) {
    calls.push(request);
    return typeof value === 'function' ? value(request) : value;
  } };
  return { read, calls };
}

const adapter = (read: RepositoryReadBoundary) => new RepositoryAdapter({ repository: read, now: () => '2026-09-07T00:00:00.000Z' });

const repositoryTampering: [string, (candidate: ResearchCandidate) => void][] = [
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
  ['archive path', c => { c.version.archivePath = 'forged/content.txt'; }],
  ['provenance URLs', c => { c.version.provenance.urls = ['https://github.com/example/other']; }],
  ['provenance adapter', c => { c.version.provenance.adapter = 'forged'; }],
  ['provenance parent', c => { c.version.provenance.parentSourceId = 'a'.repeat(32); }],
  ['provenance revision', c => { c.version.provenance.revision = otherCommit; }],
  ['notes comma collision', c => { c.version.provenance.notes = [c.version.provenance.notes!.join(',')]; }],
];
for (const [field, tamper] of repositoryTampering) {
  test(`repository replay rejects reapproved ${field} tampering`, async () => {
    const controlled = boundary(snapshot({ tag: 'v1.2.0' }));
    const request = input('refs/tags/v1.2.0');
    const [candidate] = await adapter(controlled.read).discover(request);
    const replay: ResearchCandidate = JSON.parse(JSON.stringify(candidate));
    tamper(replay);
    await expect(adapter(controlled.read).fetch({ candidate: approveCandidate(replay, request), signal: request.signal }))
      .rejects.toMatchObject({ code: 'RESEARCH_SOURCE_CHANGED' });
  });
}

test('repository replay returns recaptured facts and retrieval time and rechecks the current policy window', async () => {
  const controlled = boundary(snapshot()); const request = input();
  const [candidate] = await adapter(controlled.read).discover(request);
  const replay: ResearchCandidate = JSON.parse(JSON.stringify(candidate));
  replay.version.retrievedAt = '2026-01-02T00:00:00.000Z';
  // Reordered JSON keys are equivalent; retrieval time is observation data, never trusted from replay.
  replay.source = Object.fromEntries(Object.entries(replay.source).reverse()) as ResearchCandidate['source'];
  const approved = approveCandidate(replay, request);
  const fresh = new RepositoryAdapter({ repository: controlled.read, now: () => '2026-09-07T01:00:00.000Z' });
  const fetched = await fresh.fetch({ candidate: approved, signal: request.signal });
  expect(fetched.source).toEqual(candidate.source);
  expect(fetched.source).not.toBe(approved.source);
  expect(fetched.version.retrievedAt).toBe('2026-09-07T01:00:00.000Z');
  const expired = new RepositoryAdapter({ repository: controlled.read, now: () => '2026-09-08T00:00:00.000Z' });
  await expect(expired.fetch({ candidate: approved, signal: request.signal }))
    .rejects.toMatchObject({ code: 'RESEARCH_POLICY_REJECTED' });
});

for (const [label, entry] of [
  ['null', null], ['number', 1], ['string', 'file'], ['boolean', true], ['array', []], ['missing fields', {}],
  ['missing path', { type: 'text', contents: Buffer.from('x') }],
  ['invalid contents', { path: 'a', type: 'text', contents: 'x' }],
  ['extra field', { path: 'a', type: 'text', contents: Buffer.from('x'), target: '../secret' }],
  ['array with file properties', Object.assign([], { path: 'a', type: 'text', contents: Buffer.from('x') })],
  ['inherited file properties', Object.create({ path: 'a', type: 'text', contents: Buffer.from('x') })],
  ['throwing accessor', { path: 'a', get type() { throw new Error('must not execute'); }, contents: Buffer.from('x') }],
] as [string, unknown][]) {
  test(`repository rejects malformed file entry: ${label} with a stable error`, async () => {
    const files = [entry] as RepositorySnapshot['files'];
    await expect(adapter(boundary(snapshot({ files })).read).discover(input()))
      .rejects.toMatchObject({ name: 'ResearchAdapterError', code: 'RESEARCH_REPOSITORY_TYPE_REJECTED' });
  });
}

test('commit discovery and fetch use only the controlled read-only boundary and return a deterministic text inventory', async () => {
  const controlled = boundary(snapshot());
  const source = adapter(controlled.read); const request = input();
  const [candidate] = await source.discover(request);
  expect(controlled.calls).toHaveLength(1);
  expect(controlled.calls[0]).toMatchObject({
    url: 'https://github.com/Example/Project.git', revision: { kind: 'commit', value: commit }, maxBytes: 10000,
    safety: { readOnly: true, hooks: 'disabled', builds: 'disabled', repositoryCode: 'never-execute' },
  });
  expect(candidate.source.identityKey).toBe('repo:https://github.com/example/project');
  expect(candidate.source.canonicalUrl).toBe('https://github.com/example/project');
  expect(candidate.version.versionId).toBe(commit);
  expect(candidate.version.provenance).toMatchObject({ revision: commit, urls: ['https://github.com/example/project'] });
  expect(candidate.dateMatches).toEqual(['retrieved']);

  const fetched = await source.fetch({ candidate: approveCandidate(candidate, request), signal: request.signal });
  const inventoryBytes = fetched.files.find(file => file.path === 'content.txt')!.contents;
  const inventory = JSON.parse(Buffer.from(inventoryBytes).toString());
  expect(inventory.repository).toEqual({ url: 'https://github.com/example/project', commit, tag: null, defaultBranch: 'main' });
  expect(inventory.files).toEqual([
    { path: 'README.md', content: '# Project\n', sha256: sha256('# Project\n') },
    { path: 'src/z.ts', content: 'export const z = 1;\n', sha256: sha256('export const z = 1;\n') },
  ]);
  expect(candidate.version.contentSha256).toBe(sha256(inventoryBytes));
  expect(fetched.locators).toEqual([
    { artifactPath: 'content.txt', section: 'README.md', fragment: '/files/0' },
    { artifactPath: 'content.txt', section: 'src/z.ts', fragment: '/files/1' },
  ]);
  expect(controlled.calls).toHaveLength(2);
});

test('an explicit safe tag is resolved to a full commit and preserves tag/default-branch provenance', async () => {
  const controlled = boundary(snapshot({ commit: otherCommit, tag: 'v1.2.0', defaultBranch: 'trunk' }));
  const source = adapter(controlled.read); const request = input('refs/tags/v1.2.0');
  const [candidate] = await source.discover(request);
  expect(controlled.calls[0].revision).toEqual({ kind: 'tag', value: 'v1.2.0' });
  expect(candidate.version.versionId).toBe('v1.2.0');
  expect(candidate.version.provenance).toEqual({
    adapter: 'repository', urls: ['https://github.com/example/project'], revision: otherCommit,
    notes: ['default-branch:trunk', 'tag:v1.2.0'],
  });
  const fetched = await source.fetch({ candidate: approveCandidate(candidate, request), signal: request.signal });
  expect(JSON.parse(Buffer.from(fetched.files[0].contents).toString()).repository)
    .toEqual({ url: 'https://github.com/example/project', commit: otherCommit, tag: 'v1.2.0', defaultBranch: 'trunk' });
});

test('unfixed or unsafe revisions and unapproved URLs fail before the repository boundary', async () => {
  const controlled = boundary(snapshot()); const source = adapter(controlled.read);
  for (const revision of [null, 'main', '0123456', 'refs/heads/main', 'refs/tags/../main', 'refs/tags/release/v1']) {
    await expect(source.discover(input(revision))).rejects.toMatchObject({ code: 'RESEARCH_REPOSITORY_REVISION_REJECTED' });
  }
  for (const url of ['http://github.com/example/project', 'https://user:secret@github.com/example/project',
    'https://evil.example.com/example/project', 'https://github.com/example/../private']) {
    await expect(source.discover(input(commit, { targets: [{ kind: 'repository', url, revision: commit }] })))
      .rejects.toMatchObject({ code: 'RESEARCH_URL_REJECTED' });
  }
  expect(controlled.calls).toHaveLength(0);
});

test('private repositories and boundary metadata that expands or changes the approved source fail closed', async () => {
  const cases: [Partial<RepositorySnapshot>, string][] = [
    [{ visibility: 'private' }, 'RESEARCH_REPOSITORY_PRIVATE'],
    [{ canonicalUrl: 'https://github.com/example/other' }, 'RESEARCH_REPOSITORY_METADATA_REJECTED'],
    [{ commit: otherCommit }, 'RESEARCH_REPOSITORY_METADATA_REJECTED'],
    [{ tag: 'unexpected' }, 'RESEARCH_REPOSITORY_METADATA_REJECTED'],
    [{ defaultBranch: '../main' }, 'RESEARCH_REPOSITORY_METADATA_REJECTED'],
  ];
  for (const [patch, code] of cases) {
    const controlled = boundary(snapshot(patch));
    await expect(adapter(controlled.read).discover(input())).rejects.toMatchObject({ code });
  }
});

test('traversal, duplicate paths, symlinks and binary repository entries are rejected', async () => {
  const cases: [RepositorySnapshot['files'], string][] = [
    [[{ path: '../secret', type: 'text', contents: Buffer.from('x') }], 'RESEARCH_REPOSITORY_PATH_REJECTED'],
    [[{ path: 'a/../../secret', type: 'text', contents: Buffer.from('x') }], 'RESEARCH_REPOSITORY_PATH_REJECTED'],
    [[{ path: 'README.md', type: 'text', contents: Buffer.from('a') }, { path: 'readme.md', type: 'text', contents: Buffer.from('b') }], 'RESEARCH_REPOSITORY_PATH_REJECTED'],
    [[{ path: 'link', type: 'symlink', contents: Buffer.from('../outside') }], 'RESEARCH_REPOSITORY_TYPE_REJECTED'],
    [[{ path: 'image.png', type: 'binary', contents: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }], 'RESEARCH_REPOSITORY_TYPE_REJECTED'],
    [[{ path: 'bad.txt', type: 'text', contents: Buffer.from([0xff, 0x00]) }], 'RESEARCH_REPOSITORY_TYPE_REJECTED'],
  ];
  for (const [files, code] of cases) {
    await expect(adapter(boundary(snapshot({ files })).read).discover(input())).rejects.toMatchObject({ code });
  }
});

test('aggregate size, approval, cancellation and changed repository snapshots are enforced', async () => {
  const oversized = boundary(snapshot({ files: [{ path: 'large.txt', type: 'text', contents: Buffer.from('12345') }] }));
  await expect(adapter(oversized.read).discover(input(commit, { policy: { ...input().policy, maxResponseBytes: 4 } })))
    .rejects.toMatchObject({ code: 'RESEARCH_RESPONSE_TOO_LARGE' });

  let current = snapshot(); const controlled = boundary(() => current); const source = adapter(controlled.read); const request = input();
  const [candidate] = await source.discover(request);
  await expect(source.fetch({ candidate: candidate as PolicyApprovedCandidate, signal: request.signal }))
    .rejects.toMatchObject({ code: 'RESEARCH_APPROVAL_REQUIRED' });
  const approved = approveCandidate(candidate, request);
  current = snapshot({ files: [{ path: 'README.md', type: 'text', contents: Buffer.from('changed') }] });
  await expect(source.fetch({ candidate: approved, signal: request.signal })).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_CHANGED' });

  const controller = new AbortController(); controller.abort();
  const aborted = input(commit, { signal: controller.signal });
  await expect(source.discover(aborted)).rejects.toMatchObject({ code: 'RESEARCH_ABORTED' });
  await expect(source.fetch({ candidate: approved, signal: controller.signal })).rejects.toMatchObject({ code: 'RESEARCH_ABORTED' });
});
