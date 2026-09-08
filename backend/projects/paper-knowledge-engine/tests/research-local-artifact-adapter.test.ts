import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalArtifactAdapter } from '../src/research/adapters/local-artifact-adapter.ts';
import { approveCandidate, type DiscoveryInput, type PolicyApprovedCandidate } from '../src/research/adapters/types.ts';
import type { SourcePolicyConfig } from '../src/types/research-sources.ts';
import { sha256 } from '../src/research/source-identity.ts';
import { writeResearchArchive, readVerifiedResearchArchive } from '../src/research/source-archive.ts';

function input(paths: string[], patch: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return { track: { id: 'agent-loop', query: 'local', sourceKinds: ['local-artifact'], arxivCategories: [], domains: [], dateFields: ['retrieved'] }, query: 'local',
    window: { from: '2026-01-01', to: '2026-09-06' }, allowedSourceKinds: ['local-artifact'], allowedDomains: [],
    policy: { dateLowerBound: '2026-01-01', sourceKinds: ['local-artifact'], allowedDomains: [], identityVersionRules: {} as SourcePolicyConfig['identityVersionRules'],
      maxResponseBytes: 10000, requestTimeoutMs: 1000, maxAttempts: 1, retainAllVersions: true, contentHash: 'sha256' },
    signal: new AbortController().signal, localPaths: paths, purpose: 'research', localPurpose: 'methodology', ...patch };
}
const adapter = () => new LocalArtifactAdapter({ now: () => '2026-09-06T00:00:00.000Z' });
async function fixture(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'task3-local-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('local hash is computed from lossless content before identity and ignores the supplied filename', () => fixture(async root => {
  const first = join(root, 'first.md'), renamed = join(root, 'renamed.md');
  await writeFile(first, 'abc'); await writeFile(renamed, 'abc');
  const a = adapter(); const request = input([first, renamed]); const candidates = await a.discover(request);
  expect(candidates).toHaveLength(2);
  expect(candidates[0].source.identityKey).toBe(candidates[1].source.identityKey);
  const fetched = await a.fetch({ candidate: approveCandidate(candidates[0], request), signal: request.signal });
  const content = fetched.files.find(f => f.path === 'content.txt')!.contents;
  expect(candidates[0].source.identityKey).toBe(`local:${sha256(content)}`);
  expect(candidates[0].version.contentSha256).toBe(sha256(content));
  expect(JSON.parse(Buffer.from(content).toString()).files).toEqual([{ path: '', encoding: 'utf8', content: 'abc', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }]);
  expect(candidates[0].version.provenance.notes).toContain(`local-path:${first}`);
  expect(Buffer.from(content).toString()).not.toContain('first.md');
  const archive = await writeResearchArchive({ root: join(root, 'archive-output'), libraryId: 'test-research', fetched });
  expect((await readVerifiedResearchArchive(archive.archivePath)).manifest.identityKey).toBe(candidates[0].source.identityKey);
}));

test('local import supports PDF, Markdown, HTML, text, JSON and code as inert bytes', () => fixture(async root => {
  const files = { 'a.pdf': '%PDF-1.7\nfixture', 'a.md': '# Method\n', 'a.html': '<html><body>Method</body></html>', 'a.txt': 'text\r\n',
    'a.json': '{"protocol":"replay"}', 'a.ts': 'throw new Error("MUST NOT EXECUTE");', 'a.ps1': 'throw "MUST NOT EXECUTE"' };
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  const a = adapter(); const request = input(Object.keys(files).map(name => join(root, name)));
  const candidates = await a.discover(request);
  expect(candidates).toHaveLength(7);
  for (const candidate of candidates) {
    const fetched = await a.fetch({ candidate: approveCandidate(candidate, request), signal: request.signal });
    expect(fetched.locators.length).toBeGreaterThan(0);
  }
  expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(files['a.ts']);
}));

test('directory inventory is sorted, lossless and independent of root path or creation order', () => fixture(async root => {
  const one = join(root, 'one'), two = join(root, 'two');
  for (const dir of [one, two]) await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(one, 'src', 'b.ts'), 'export const b = 1;'); await writeFile(join(one, 'a.md'), '# A');
  await writeFile(join(two, 'a.md'), '# A'); await writeFile(join(two, 'src', 'b.ts'), 'export const b = 1;');
  const a = adapter(); const request = input([one, two]); const candidates = await a.discover(request);
  expect(candidates[0].source.identityKey).toBe(candidates[1].source.identityKey);
  const fetched = await a.fetch({ candidate: approveCandidate(candidates[0], request), signal: request.signal });
  const snapshot = JSON.parse(Buffer.from(fetched.files[0].contents).toString());
  expect(snapshot.files.map((f: { path: string }) => f.path)).toEqual(['a.md', 'src/b.ts']);
  expect(snapshot.files[1].content).toBe('export const b = 1;');
}));

test('local refuses implicit/relative paths, symlink directories, unsupported/binary files and oversized snapshots', () => fixture(async root => {
  const a = adapter();
  await expect(a.discover(input([]))).rejects.toMatchObject({ code: 'RESEARCH_LOCAL_PATH_REJECTED' });
  await expect(a.discover(input(['relative.md']))).rejects.toMatchObject({ code: 'RESEARCH_LOCAL_PATH_REJECTED' });
  const target = join(root, 'target'), link = join(root, 'link'); await mkdir(target); await writeFile(join(target, 'a.md'), 'hello');
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(a.discover(input([link]))).rejects.toMatchObject({ code: 'RESEARCH_LOCAL_PATH_REJECTED' });
  await expect(a.discover(input([join(link, 'a.md')]))).rejects.toMatchObject({ code: 'RESEARCH_LOCAL_PATH_REJECTED' });
  const bad = join(root, 'bad.exe'); await writeFile(bad, 'MZ');
  await expect(a.discover(input([bad]))).rejects.toMatchObject({ code: 'RESEARCH_LOCAL_TYPE_REJECTED' });
  const binary = join(root, 'binary.txt'); await writeFile(binary, Buffer.from([0xff, 0x00]));
  await expect(a.discover(input([binary]))).rejects.toMatchObject({ code: 'RESEARCH_LOCAL_TYPE_REJECTED' });
  const request = input([target]); request.policy.maxResponseBytes = 4;
  await expect(a.discover(request)).rejects.toMatchObject({ code: 'RESEARCH_RESPONSE_TOO_LARGE' });
}));

test('local rejects benchmark-only purpose, leaderboard directory and JSON source markers', () => fixture(async root => {
  const method = join(root, 'method.md'); await writeFile(method, '# Evaluation protocol');
  const a = adapter();
  for (const purpose of ['benchmark-dataset', 'leaderboard', 'single-result'] as const) {
    await expect(a.discover(input([method], { purpose }))).rejects.toMatchObject({ code: 'RESEARCH_BENCHMARK_REJECTED' });
  }
  const board = join(root, 'leaderboard'); await mkdir(board); await writeFile(join(board, 'scores.json'), '[1,2,3]');
  await expect(a.discover(input([board]))).rejects.toMatchObject({ code: 'RESEARCH_BENCHMARK_REJECTED' });
  const disguised = join(root, 'data.json'); await writeFile(disguised, '{"sourceKind":"single-result","score":0.9}');
  await expect(a.discover(input([disguised]))).rejects.toMatchObject({ code: 'RESEARCH_BENCHMARK_REJECTED' });
}));

test.each([
  ['data.json', '{"results":[{"model":"Atlas","accuracy":0.91}]}'],
  ['notes.md', '| Model | Accuracy |\n| --- | --- |\n| Atlas | 0.91 |\n'],
])('local requires an allowlisted research purpose for neutral artifact %s', (name, content) => fixture(async root => {
  const path = join(root, name); await writeFile(path, content);
  for (const localPurpose of [undefined, null, '', 'research', 'benchmark-dataset', 'leaderboard', 'single-result', 'unknown', 1, ['methodology']]) {
    // Serialized callers must pass the same runtime boundary as typed callers.
    const patch = JSON.parse(JSON.stringify({ localPurpose }));
    const request = input([path], { localPurpose: undefined, ...patch });
    await expect(adapter().discover(request)).rejects.toMatchObject({ code: 'RESEARCH_LOCAL_PURPOSE_REJECTED' });
  }
}));

test('local carries each allowed research purpose through serialized reapproval and frozen fetch scope', () => fixture(async root => {
  const path = join(root, 'document.txt'); await writeFile(path, 'Research material');
  for (const localPurpose of ['methodology', 'technical-report', 'specification', 'evaluation-method', 'source-code'] as const) {
    const request = input([path], { localPurpose });
    const [candidate] = await adapter().discover(request);
    expect(candidate.version.provenance.notes).toContain(`local-purpose:${localPurpose}`);
    const serialized = JSON.parse(JSON.stringify(candidate));
    const approved = approveCandidate(serialized, request);
    request.localPurpose = undefined;
    serialized.version.provenance.notes = [];
    const fetched = await adapter().fetch({ candidate: approved, signal: request.signal });
    expect(fetched.version.provenance.notes).toContain(`local-purpose:${localPurpose}`);
  }
}));

test('local reapproval rejects missing, forged or ambiguous purpose provenance and changed purpose grants', () => fixture(async root => {
  const path = join(root, 'document.txt'); await writeFile(path, 'Research material');
  const request = input([path]); const [candidate] = await adapter().discover(request);
  for (const purposes of [[], ['specification'], ['benchmark-dataset'], ['leaderboard'], ['single-result'], ['unknown'],
    ['methodology', 'specification'], ['methodology', 'methodology'], ['methodology ']]) {
    const serialized = JSON.parse(JSON.stringify(candidate));
    serialized.version.provenance.notes = candidate.version.provenance.notes!
      .filter(note => !note.startsWith('local-purpose:')).concat(purposes.map(purpose => `local-purpose:${purpose}`));
    expect(() => approveCandidate(serialized, request)).toThrow('RESEARCH_LOCAL_PURPOSE_REJECTED');
    await expect(adapter().fetch({ candidate: serialized as PolicyApprovedCandidate, signal: request.signal }))
      .rejects.toMatchObject({ code: 'RESEARCH_APPROVAL_REQUIRED' });
  }
  const withoutNotes = JSON.parse(JSON.stringify(candidate));
  delete withoutNotes.version.provenance.notes;
  expect(() => approveCandidate(withoutNotes, request)).toThrow('RESEARCH_LOCAL_PURPOSE_REJECTED');
  for (const localPurpose of [undefined, 'specification', 'benchmark-dataset', 'leaderboard', 'single-result', 'unknown']) {
    const patch = JSON.parse(JSON.stringify({ localPurpose }));
    expect(() => approveCandidate(candidate, input([path], { localPurpose: undefined, ...patch })))
      .toThrow('RESEARCH_LOCAL_PURPOSE_REJECTED');
  }
  for (const purpose of ['benchmark-dataset', 'leaderboard', 'single-result'] as const) {
    expect(() => approveCandidate(candidate, input([path], { purpose }))).toThrow('RESEARCH_BENCHMARK_REJECTED');
  }
}));

test('local fetch rechecks explicit path, detects changed bytes and honors cancellation', () => fixture(async root => {
  const path = join(root, 'a.md'); await writeFile(path, 'before');
  const a = adapter(); const request = input([path]); const [candidate] = await a.discover(request);
  await expect(a.fetch({ candidate: approveCandidate(candidate, input([])), signal: request.signal }))
    .rejects.toMatchObject({ code: 'RESEARCH_LOCAL_PATH_REJECTED' });
  const approved = approveCandidate(candidate, request);
  await writeFile(path, 'after');
  await expect(a.fetch({ candidate: approved, signal: request.signal })).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_CHANGED' });
  const controller = new AbortController(); controller.abort();
  await expect(a.discover(input([path], { signal: controller.signal }))).rejects.toMatchObject({ code: 'RESEARCH_ABORTED' });
  await expect(a.fetch({ candidate: approved, signal: controller.signal })).rejects.toMatchObject({ code: 'RESEARCH_ABORTED' });
}));

test('local fetch requires a live approval and allows serialized candidates only after explicit reapproval', () => fixture(async root => {
  const path = join(root, 'a.md'); await writeFile(path, 'abc');
  const request = input([path]); const [candidate] = await adapter().discover(request);
  const serialized = JSON.parse(JSON.stringify(candidate));
  await expect(adapter().fetch({ candidate: serialized as PolicyApprovedCandidate, signal: request.signal }))
    .rejects.toMatchObject({ code: 'RESEARCH_APPROVAL_REQUIRED' });
  const approved = approveCandidate(serialized, request);
  request.localPaths = []; // Approval captures the original grant, independent of later caller edits.
  const fetched = await adapter().fetch({ candidate: approved, signal: request.signal });
  expect(fetched.source.identityKey).toBe(candidate.source.identityKey);
  const sibling = join(root, 'sibling.md'); await writeFile(sibling, 'abc');
  for (const paths of [[sibling], [root]]) {
    await expect(adapter().fetch({ candidate: approveCandidate(serialized, input(paths)), signal: request.signal }))
      .rejects.toMatchObject({ code: 'RESEARCH_LOCAL_PATH_REJECTED' });
  }
}));

test('local snapshot preserves UTF-8 BOM, CRLF and binary PDF bytes without using names as metadata', () => fixture(async root => {
  const path = join(root, 'two  spaces.md'); const text = '\ufeff# A\r\n'; await writeFile(path, text);
  const pdf = join(root, 'a.pdf'); const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 255, 128])]);
  await writeFile(pdf, bytes);
  const request = input([path, pdf]); const candidates = await adapter().discover(request);
  for (const [index, candidate] of candidates.entries()) {
    expect(candidate.source.title).not.toContain(index === 0 ? 'two' : 'a.pdf');
    expect(candidate.source.canonicalUrl).toBe('');
    const fetched = await adapter().fetch({ candidate: approveCandidate(candidate, request), signal: request.signal });
    const entry = JSON.parse(Buffer.from(fetched.files[0].contents).toString()).files[0];
    expect(entry.path).toBe('');
    expect(entry.encoding).toBe(index === 0 ? 'utf8' : 'base64');
    expect(Buffer.from(entry.content, entry.encoding)).toEqual(index === 0 ? Buffer.from(text) : bytes);
    const archive = await writeResearchArchive({ root: join(root, 'output'), libraryId: 'local-test', fetched });
    expect((await readVerifiedResearchArchive(archive.archivePath)).manifest.contentSha256).toBe(candidate.version.contentSha256);
  }
}));

test('local rejects traversal, device paths, nested links, invalid PDF and snapshot envelope over the byte cap', () => fixture(async root => {
  const path = join(root, 'a.md'); await writeFile(path, 'abc');
  for (const unsafe of [root + '/child/../a.md', path + ':stream', '\\\\?\\C:\\a.md', '\\\\server\\share\\a.md']) {
    await expect(adapter().discover(input([unsafe]))).rejects.toMatchObject({ code: 'RESEARCH_LOCAL_PATH_REJECTED' });
  }
  const dir = join(root, 'snapshot'); await mkdir(dir);
  await symlink(root, join(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(adapter().discover(input([dir]))).rejects.toMatchObject({ code: 'RESEARCH_LOCAL_PATH_REJECTED' });
  const pdf = join(root, 'bad.pdf'); await writeFile(pdf, 'not a PDF');
  await expect(adapter().discover(input([pdf]))).rejects.toMatchObject({ code: 'RESEARCH_LOCAL_TYPE_REJECTED' });
  const limited = input([path]); limited.policy.maxResponseBytes = 3;
  await expect(adapter().discover(limited)).rejects.toMatchObject({ code: 'RESEARCH_RESPONSE_TOO_LARGE' });
}));

test('local rejects nested benchmark markers but accepts evaluation methods mentioning benchmarks', () => fixture(async root => {
  const path = join(root, 'a.json'); await writeFile(path, '{"metadata":{"purpose":"benchmark-dataset"}}');
  await expect(adapter().discover(input([path]))).rejects.toMatchObject({ code: 'RESEARCH_BENCHMARK_REJECTED' });
  await writeFile(path, '{"sourceKind":"evaluation-method","description":"benchmark protocol"}');
  expect(await adapter().discover(input([path]))).toHaveLength(1);
}));

test('local rejects benchmark-only text and code with neutral filenames while accepting evaluation-method documents', () => fixture(async root => {
  const rejected = {
    'notes.md': '# Leaderboard\n\n| Rank | Agent | Score |\n| --- | --- | --- |\n| 1 | Atlas | 0.91 |\n',
    'page.html': '<html><body><h1>Benchmark dataset</h1><p>Task records and expected outputs.</p></body></html>',
    'summary.txt': 'Single evaluation result\nAgent: Atlas\nScore: 0.91\n',
    'artifact.ts': 'export const singleResult = { agent: "Atlas", score: 0.91 };\n',
  };
  for (const [name, content] of Object.entries(rejected)) {
    const path = join(root, name);
    await writeFile(path, content);
    await expect(adapter().discover(input([path]))).rejects.toMatchObject({ code: 'RESEARCH_BENCHMARK_REJECTED' });
  }
  const method = join(root, 'document.md');
  await writeFile(method, '# Evaluation method\n\nThis document defines the benchmark dataset protocol, task sampling, metrics, adjudication, and replay procedure.\n');
  expect(await adapter().discover(input([method]))).toHaveLength(1);
}));

test('local applies source policy and retrieval window and detects directory membership changes', () => fixture(async root => {
  const dir = join(root, 'snapshot'); await mkdir(dir); await writeFile(join(dir, 'a.md'), 'abc');
  const request = input([dir]); const [candidate] = await adapter().discover(request);
  const approved = approveCandidate(candidate, request);
  await writeFile(join(dir, 'b.md'), 'abc');
  await expect(adapter().fetch({ candidate: approved, signal: request.signal })).rejects.toMatchObject({ code: 'RESEARCH_SOURCE_CHANGED' });
  await expect(adapter().discover(input([dir], { allowedSourceKinds: [] }))).rejects.toMatchObject({ code: 'RESEARCH_POLICY_REJECTED' });
  expect(await adapter().discover(input([dir], { window: { from: '2026-01-01', to: '2026-01-02' } }))).toEqual([]);
}));
