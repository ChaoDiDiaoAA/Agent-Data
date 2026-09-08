import { expect, test } from 'bun:test';
import { ArxivAdapter, mergeArxivCandidates } from '../src/research/adapters/arxiv-adapter.ts';
import { approveCandidate, type DiscoveryInput } from '../src/research/adapters/types.ts';
import { createHttpClient } from '../src/research/http-client.ts';
import { runHarvestShards } from '../src/discovery/opencli-runner.ts';
import type { ArxivConfig } from '../src/types/config.ts';
import { sha256 } from '../src/research/source-identity.ts';

const arxiv: ArxivConfig = { pageSize: 10, requestIntervalMs: 3000, maxAttempts: 1, maxBackoffMs: 100,
  requestTimeoutMs: 100, retryJitterMs: 0, capacityCooldownMs: 100, candidatePoolMultiplier: 1, maxResultsPerShard: 10 };
const paper = { baseId: '2601.01234', arxivId: '2601.01234v2', version: 2, title: 'Agent loops',
  summary: 'Observe.\nAct.', authors: ['Ada', 'Grace'], categories: ['cs.SE', 'cs.AI'],
  published: '2026-01-03T00:00:00Z', updated: '2026-02-04T00:00:00Z' };
function discovery(): DiscoveryInput {
  return { track: { id: 'agent-loop', query: 'agent', sourceKinds: ['paper', 'technical-report'],
    domains: ['arxiv.org', 'export.arxiv.org'], dateFields: ['published', 'updated'],
    arxivCategories: ['cs.AI', 'cs.PL', 'cs.SE'] } as DiscoveryInput['track'],
  query: 'all:agent', window: { from: '2026-01-01', to: '2026-09-06' },
  allowedSourceKinds: ['paper', 'technical-report'], allowedDomains: ['arxiv.org', 'export.arxiv.org'],
  policy: { dateLowerBound: '2026-01-01', sourceKinds: ['paper', 'technical-report'], allowedDomains: ['arxiv.org', 'export.arxiv.org'],
    identityVersionRules: {} as DiscoveryInput['policy']['identityVersionRules'], maxResponseBytes: 16000,
    requestTimeoutMs: 1000, maxAttempts: 1, retainAllVersions: true, contentHash: 'sha256' },
  network: { openCliProxyMode: 'direct', arxivApiBase: 'https://arxiv.org/api/query' }, signal: new AbortController().signal };
}
const runner: typeof runHarvestShards = async () => [{ ...paper, matchedTracks: [], dateModes: [] }];
const make = (run = runner) => new ArxivAdapter({ arxiv, runner: run, now: () => '2026-09-06T00:00:00Z',
  http: createHttpClient({ fetch: async () => new Response('%PDF-1.7\nfixture', { headers: { 'content-type': 'application/pdf' } }) }) });

test('arXiv uses the existing runner with fixed dates, Track, query, explicit proxy/API route and no parent environment writes', async () => {
  const before = { ...process.env }; const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const adapter = make((shards, window, options) => runHarvestShards(shards, window, { ...options, sleep: async () => {},
    execFile: async (_file, args, opts) => { calls.push({ args, env: opts.env }); return { stdout: JSON.stringify([paper]) }; } }));
  const input = discovery(); const [candidate] = await adapter.discover(input);
  expect(calls).toHaveLength(2);
  for (const { args, env } of calls) {
    for (const [flag, value] of [['--from', '2026-01-01'], ['--to', '2026-09-06'], ['--track', 'agent-loop'],
      ['--query', 'all:agent'], ['--categories', 'cs.AI,cs.PL,cs.SE'], ['--api-base', 'https://arxiv.org/api/query']]) expect(args[args.indexOf(flag) + 1]).toBe(value);
    expect(env?.HTTP_PROXY).toBeUndefined(); expect(env?.NO_PROXY).toBe('*');
  }
  expect(calls.map(c => c.args[c.args.indexOf('--date-mode') + 1])).toEqual(['submitted', 'updated']);
  expect(candidate.source).toMatchObject({ kind: 'paper', identityKey: 'arxiv:2601.01234', canonicalUrl: 'https://arxiv.org/abs/2601.01234', authors: ['Ada', 'Grace'] });
  expect(candidate.version).toMatchObject({ versionId: 'v2', publishedAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-02-04T00:00:00.000Z' });
  expect(candidate.dateMatches).toEqual(['published', 'updated']); expect(process.env).toEqual(before);
});

test('arXiv preserves abstract, categories and versioned locators through approved generic PDF fetch and reapproval', async () => {
  const adapter = make(); const input = discovery(); const [candidate] = await adapter.discover(input);
  const fetched = await make().fetch({ candidate: approveCandidate(structuredClone(candidate), input), signal: input.signal });
  const content = fetched.files.find(f => f.path === 'content.txt')!.contents;
  expect(JSON.parse(Buffer.from(content).toString())).toMatchObject({ baseId: '2601.01234', version: 2, abstract: 'Observe.\nAct.', categories: ['cs.AI', 'cs.SE'] });
  expect(sha256(content)).toBe(candidate.version.contentSha256);
  expect(Buffer.from(fetched.files.find(f => f.path === 'source.pdf')!.contents).toString()).toBe('%PDF-1.7\nfixture');
  expect(fetched.version.provenance.urls).toContain('https://arxiv.org/pdf/2601.01234v2');
  expect(fetched.locators).toContainEqual({ artifactPath: 'content.txt', section: 'Abstract', fragment: '/abstract' });
  await expect(adapter.fetch({ candidate: candidate as never, signal: input.signal })).rejects.toMatchObject({ code: 'RESEARCH_APPROVAL_REQUIRED' });
});

test('arXiv maps technical reports explicitly and merges repeated Track observations without mutable adapter state', async () => {
  const adapter = make(); const first = discovery(); first.allowedSourceKinds = ['technical-report'];
  const second = { ...first, track: { ...first.track, id: 'context' } };
  const a = await adapter.discover(first); const b = await adapter.discover(second);
  expect(a[0].source.kind).toBe('technical-report');
  const merged = mergeArxivCandidates([...a, ...b, ...a]);
  expect(merged).toHaveLength(1); expect(merged[0].matchedTracks).toEqual(['agent-loop', 'context']);
  expect(merged[0].source.secondaryTracks).toEqual(['context']);
  expect(mergeArxivCandidates([...b, ...a])).toEqual(merged); expect(a[0].matchedTracks).toEqual(['agent-loop']);
});

test('arXiv rejects disallowed kind/domain/date and pre-abort before invoking OpenCLI', async () => {
  let calls = 0; const adapter = make(async () => { calls++; return []; });
  for (const mutate of [(i: DiscoveryInput) => { i.allowedSourceKinds = ['release']; },
    (i: DiscoveryInput) => { i.allowedDomains = []; }, (i: DiscoveryInput) => { i.window.from = '2025-12-31'; },
    (i: DiscoveryInput) => { i.track.dateFields = ['released']; },
    (i: DiscoveryInput) => { i.network = { openCliProxyMode: 'configured' }; },
    (i: DiscoveryInput) => { i.signal = AbortSignal.abort(); }]) {
    const input = discovery(); mutate(input); await expect(adapter.discover(input)).rejects.toThrow();
  }
  expect(calls).toBe(0);
  expect(await make().discover({ ...discovery(), window: { from: '2026-08-01', to: '2026-09-06' } })).toEqual([]);
});

test('arXiv preserves runner errors, bounds discovery, validates metadata and rejects invalid PDF bytes', async () => {
  const error = Object.assign(new Error('capacity'), { code: 'ARXIV_CAPACITY_LIMITED', retryNotBefore: '2026-09-07' });
  await expect(make(async () => { throw error; }).discover(discovery())).rejects.toBe(error);
  const small = discovery(); small.policy.maxResponseBytes = 10;
  await expect(make().discover(small)).rejects.toMatchObject({ code: 'RESEARCH_RESPONSE_TOO_LARGE' });
  const slow = discovery(); slow.policy.requestTimeoutMs = 10; let signal: AbortSignal | undefined;
  await expect(make(async (_s, _w, opts) => { signal = opts?.signal; return new Promise(() => {}); }).discover(slow)).rejects.toMatchObject({ code: 'RESEARCH_TIMEOUT' });
  expect(signal?.aborted).toBe(true);
  await expect(make(async () => [{ ...paper, arxivId: '2601.99999v2', matchedTracks: [], dateModes: [] }]).discover(discovery())).rejects.toMatchObject({ code: 'RESEARCH_ARXIV_METADATA_INVALID' });
  const input = discovery(); const [candidate] = await make().discover(input);
  const invalid = new ArxivAdapter({ arxiv, http: createHttpClient({ fetch: async () => new Response('not PDF') }) });
  await expect(invalid.fetch({ candidate: approveCandidate(candidate, input), signal: input.signal })).rejects.toMatchObject({ code: 'RESEARCH_PDF_INVALID' });
});

test('arXiv reapproval cannot detach source facts or dates from the discovered metadata hash', async () => {
  const input = discovery(); const [candidate] = await make().discover(input); let requests = 0;
  const adapter = new ArxivAdapter({ arxiv, http: createHttpClient({ fetch: async () => {
    requests++; return new Response('%PDF-1.7\nfixture');
  } }) });
  for (const mutate of [(c: typeof candidate) => { c.source.title = 'Different paper'; },
    (c: typeof candidate) => { c.source.authors = ['Someone else']; },
    (c: typeof candidate) => { c.version.publishedAt = '2026-01-05T00:00:00Z'; }]) {
    const changed = structuredClone(candidate); mutate(changed);
    await expect(adapter.fetch({ candidate: approveCandidate(changed, input), signal: input.signal })).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_CHANGED' });
  }
  expect(requests).toBe(0);
});
