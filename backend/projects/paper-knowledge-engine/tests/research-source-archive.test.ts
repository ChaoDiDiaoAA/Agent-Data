import { test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeResearchArchive, readVerifiedResearchArchive } from '../src/research/source-archive.ts';
import { researchFixture } from './fixtures/research-source.ts';
import { canonicalJson } from '../src/shared/manifest.ts';

async function fixture(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'research-archive-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('concurrent identical writers install one verified version', () => fixture(async root => {
  const input = { root, libraryId: 'research-fixture', fetched: researchFixture() };
  const results = await Promise.all([writeResearchArchive(input), writeResearchArchive(input), writeResearchArchive(input)]);
  expect(results[1]).toEqual(results[0]);
  expect(results[2]).toEqual(results[0]);
}));

test('replays a concurrent identical install when rename reports EPERM after the target appears', () => fixture(async root => {
  const script = `import { mock } from 'bun:test';
    const fs = { ...await import('node:fs/promises') };
    let injectedRace = false;
    mock.module('node:fs/promises', () => ({ ...fs, rename: async (from, to) => {
      if (injectedRace) return fs.rename(from, to);
      injectedRace = true;
      await fs.cp(from, to, { recursive: true, errorOnExist: true });
      throw Object.assign(new Error('simulated Windows concurrent rename failure'), { code: 'EPERM' });
    } }));
    const { writeResearchArchive, readVerifiedResearchArchive } = await import(${JSON.stringify(new URL('../src/research/source-archive.ts', import.meta.url).href)});
    const { researchFixture } = await import(${JSON.stringify(new URL('./fixtures/research-source.ts', import.meta.url).href)});
    try {
  const result = await writeResearchArchive({ root: process.argv[1], libraryId: 'research-fixture', fetched: researchFixture() });
      const verified = await readVerifiedResearchArchive(result.archivePath);
      if (verified.manifest.sourceId !== result.manifest.sourceId) throw new Error('installed archive identity changed');
    } catch (error) {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    }`;
  const child = Bun.spawn([process.execPath, '-e', script, root], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(exit).toBe(0);
}));

test('rejects symlink or junction ancestors and linked payloads without touching the target', () => fixture(async root => {
  const target = join(root, 'target'); await mkdir(target);
  const link = join(root, 'linked'); await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const first = await writeResearchArchive({ root: target, libraryId: 'research-fixture', fetched: researchFixture() });
  const linkedPath = first.archivePath.replace(target, link);
  await expect(readVerifiedResearchArchive(linkedPath)).rejects.toThrow(/link|real path|reparse/i);
  await expect(writeResearchArchive({ root: link, libraryId: 'research-fixture', fetched: researchFixture('r2') })).rejects.toThrow(/link|real path|reparse/i);
  await symlink(target, join(first.archivePath, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(readVerifiedResearchArchive(first.archivePath)).rejects.toThrow(/link|real path|reparse/i);
  await unlink(join(first.archivePath, 'linked-dir'));
  expect(await readFile(join(first.archivePath, 'content.md'), 'utf8')).toBe('Agent guide\n');
}));

test('verification rejects manifest tamper, missing content, cross identity and unexpected files', () => fixture(async root => {
  const result = await writeResearchArchive({ root, libraryId: 'research-fixture', fetched: researchFixture() });
  await expect(readVerifiedResearchArchive(result.archivePath, { sourceId: 'b'.repeat(32) })).rejects.toThrow();
  await expect(readVerifiedResearchArchive(result.archivePath, { libraryId: 'other-library' })).rejects.toThrow();
  await expect(readVerifiedResearchArchive(result.archivePath, { versionId: 'r2' })).rejects.toThrow();
  const sourcePath = join(result.archivePath, 'source.json');
  const original = await readFile(sourcePath);
  for (const edit of [
    (m: typeof result.manifest) => { m.source.title = 'tampered'; },
    (m: typeof result.manifest) => { m.sourceId = 'b'.repeat(32); },
    (m: typeof result.manifest) => { m.version.contentSha256 = 'b'.repeat(64); },
    (m: typeof result.manifest) => { m.files[0].path = '../escape'; },
  ]) {
    const manifest = structuredClone(result.manifest); edit(manifest);
    await writeFile(sourcePath, JSON.stringify(manifest) + '\n');
    await expect(readVerifiedResearchArchive(result.archivePath)).rejects.toThrow();
  }
  await writeFile(sourcePath, original);
  await writeFile(join(result.archivePath, 'extra.txt'), 'unexpected');
  await expect(readVerifiedResearchArchive(result.archivePath)).rejects.toThrow();
  await unlink(join(result.archivePath, 'extra.txt'));
  await unlink(join(result.archivePath, 'content.md'));
  await expect(readVerifiedResearchArchive(result.archivePath)).rejects.toThrow();
  const fetched = researchFixture(); fetched.version.sourceId = 'b'.repeat(32);
  await expect(writeResearchArchive({ root, libraryId: 'research-fixture', fetched })).rejects.toThrow();
}));

test('rejects unsafe payload paths, reserved files, missing or duplicate content and wrong content hash', () => fixture(async root => {
  for (const path of ['../escape', '/absolute', 'C:/escape', 'a\\b', 'CON', 'a:stream', 'source.json', 'metadata.json']) {
    const fetched = researchFixture(); fetched.files.push({ path, contents: Buffer.from('bad') });
  await expect(writeResearchArchive({ root, libraryId: 'research-fixture', fetched })).rejects.toThrow();
  }
  for (const files of [[], [{ path: 'content.md', contents: Buffer.from('bad') }], [...researchFixture().files, { path: 'content.txt', contents: Buffer.from('Agent guide\n') }]]) {
  await expect(writeResearchArchive({ root, libraryId: 'research-fixture', fetched: { ...researchFixture(), files } })).rejects.toThrow();
  }
}));

test('identical replay succeeds while same-version conflicts preserve the existing bytes', () => fixture(async root => {
  const input = { root, libraryId: 'research-fixture', fetched: researchFixture() };
  const first = await writeResearchArchive(input);
  const replay = await writeResearchArchive(input);
  expect(replay).toEqual(first);
  await expect(writeResearchArchive({ ...input, fetched: researchFixture('r1', 'Changed\n') })).rejects.toThrow(/conflict/i);
  expect(await readFile(join(first.archivePath, 'content.md'), 'utf8')).toBe('Agent guide\n');
  const next = await writeResearchArchive({ ...input, fetched: researchFixture('r2', 'Changed\n') });
  expect(next.archivePath).not.toBe(first.archivePath);
}));

test('writes and verifies a canonical generic Archive with normalized content', () => fixture(async root => {
  const fetched = researchFixture();
  fetched.files[0].contents = Buffer.from('Agent guide\r\n');
  const result = await writeResearchArchive({ root, libraryId: 'research-fixture', fetched });
  expect(result.archivePath.replaceAll('\\', '/')).toEndWith(`/archive/sources/official-doc/${fetched.source.sourceId}/r1`);
  expect(result.manifest.schemaVersion).toBe(1);
  expect(result.manifest.files.map(f => f.path)).toEqual(['content.md', 'metadata.json']);
  expect(await readFile(join(result.archivePath, 'source.json'), 'utf8')).toBe(canonicalJson(result.manifest));
  const verified = await readVerifiedResearchArchive(result.archivePath, { libraryId: 'research-fixture', sourceId: fetched.source.sourceId, versionId: 'r1' });
  expect(Buffer.from(verified.files.get('content.md')!).toString()).toBe('Agent guide\n');
}));
