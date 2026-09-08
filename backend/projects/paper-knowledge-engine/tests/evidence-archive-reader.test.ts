import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson } from '../src/evidence/contracts.ts';
import { archiveFileManifest } from '../src/shared/manifest.ts';
import { readVerifiedRunSources } from '../src/evidence/archive-reader.ts';
import type { StateStore } from '../src/library/state/state-store.ts';
import { writeArchiveV2 } from '../src/mineru/archive-writer.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import { archiveTestPdf } from './fixtures/library-paths.ts';
import { cp } from 'node:fs/promises';

const sha256 = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
const identifier = { baseId: '2601.00001', version: 1, sha256: sha256('frozen PDF'), model: 'pipeline', method: 'auto' };
const sourceTemplate = () => ({
  schemaVersion: 1 as const,
  baseId: identifier.baseId,
  arxivId: '2601.00001v1',
  version: identifier.version,
  title: 'Frozen evidence',
  authors: ['Ada Archive'],
  categories: ['cs.SE'],
  matchedTracks: ['AI-FSD'],
  published: '2026-01-01T00:00:00Z',
  updated: '2026-01-02T00:00:00Z',
  pdfPath: `pdf/${identifier.sha256}.pdf`,
  pdfSha256: identifier.sha256,
  parseAttemptId: 'attempt-1',
  model: 'pipeline' as const,
  cliBackend: 'pipeline' as const,
  method: 'auto' as const,
  pageCount: 1,
  normalized: {
    fullMarkdown: 'normalized/full.md' as const,
    pageMarkedText: 'normalized/page-marked.txt' as const,
    pages: 'normalized/pages.json' as const,
    contentList: 'normalized/content-list.json' as const,
  },
});

test('reads Archive v2 from the library papers root with frozen metadata and assets', async () => {
  const f = await fixture();
  try {
    const workspace = join(f.stateRoot, 'work', 'parsing', 'attempt-1');
    await mkdir(workspace, { recursive: true });
    const pdf = await archiveTestPdf();
    await writeFile(join(workspace, 'source.pdf'), pdf);
    for (const [from, to] of [['full.md', 'document.md'], ['pages.json', 'pages.json'], ['content-list.json', 'content-list.json']]) {
      await cp(join(f.archiveRoot, 'normalized', from), join(workspace, to));
    }
    await cp(join(f.archiveRoot, 'assets'), join(workspace, 'assets'), { recursive: true });
    const paths = { dataRoot: f.stateRoot, workRoot: join(f.stateRoot, 'work'), archiveRoot: join(f.stateRoot, 'archive'),
      operationsRoot: join(f.stateRoot, 'operations'), runsRoot: join(f.stateRoot, 'runs'), databasePath: join(f.stateRoot, 'library.sqlite'),
      backupRoot: join(f.root, 'backup'), vaultRoot: join(f.root, 'vault') };
    const s = sourceTemplate();
    const archive = await writeArchiveV2({ paths, workspace, attemptId: 'attempt-1', libraryId: asLibraryId('fsd'),
      baseId: s.baseId, version: s.version, sourceKind: 'arxiv', pdfSha256: sha256(pdf),
      parser: { name: 'MinerU', version: '3.1.0', model: 'pipeline', method: 'auto' },
      source: { title: s.title, authors: s.authors, categories: s.categories, matchedTracks: s.matchedTracks,
        published: s.published, updated: s.updated, arxivId: s.arxivId, pageCount: 1, parseAttemptId: 'attempt-1' } });
    const identity = { ...identifier, sha256: sha256(pdf), outputDir: archive.root };
    await writeFile(join(f.runRoot, 'mineru-jobs.json'), JSON.stringify({ runId: 'run-1', jobs: [identity] }));
    f.store.findSuccessfulParse = (() => ({ ...identity, attemptId: 'attempt-1', cliBackend: 'pipeline', pageCount: 1 })) as unknown as typeof f.store.findSuccessfulParse;
    const [read] = await readVerifiedRunSources({ runId: 'run-1', stateRoot: f.stateRoot, paths, libraryId: asLibraryId('fsd'), store: f.store });
    assert.equal(read.source.schemaVersion, 2);
    assert.equal(read.source.title, 'Frozen evidence');
    assert.equal(read.source.pdfPath, 'source.pdf');
    assert.equal(read.assets.length, 1);
    assert.equal(read.pages[0].text, 'Evidence');
  } finally { await removeFixture(f); }
});

async function fixture(mutate?: (value: Fixture) => Promise<void>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'archive-reader-'));
  const stateRoot = join(root, 'state');
  const archiveRoot = join(stateRoot, 'extracted', 'p-2601.00001');
  const runRoot = join(stateRoot, 'runs', 'run-1');
  await mkdir(join(archiveRoot, 'normalized'), { recursive: true });
  await mkdir(join(archiveRoot, 'pdf'), { recursive: true });
  await mkdir(join(archiveRoot, 'assets'), { recursive: true });
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(stateRoot, 'papers.sqlite'), 'frozen SQLite fixture');
  await writeFile(join(archiveRoot, 'pdf', `${identifier.sha256}.pdf`), 'frozen PDF');
  await writeFile(join(archiveRoot, 'normalized', 'full.md'), '# Evidence\n![Figure](assets/figure.png)\n');
  await writeFile(join(archiveRoot, 'normalized', 'page-marked.txt'), '--- PAGE 1 ---\nEvidence\n');
  await writeFile(join(archiveRoot, 'normalized', 'pages.json'), JSON.stringify([{ page: 1, text: 'Evidence' }]));
  await writeFile(join(archiveRoot, 'normalized', 'content-list.json'), JSON.stringify([{ type: 'image', img_path: 'assets/figure.png' }]));
  await writeFile(join(archiveRoot, 'assets', 'figure.png'), 'image bytes');
  const source = { ...sourceTemplate(), files: await archiveFileManifest(archiveRoot) };
  await writeFile(join(archiveRoot, 'source.json'), canonicalJson(source));
  await writeFile(join(runRoot, 'mineru-jobs.json'), JSON.stringify({ runId: 'run-1', jobs: [{ ...identifier, outputDir: archiveRoot }] }));
  const value: Fixture = {
    root, stateRoot, archiveRoot, runRoot, source,
    store: {
      findSuccessfulParse: (identity: typeof identifier) => ({ ...identity, attemptId: 'attempt-1', cliBackend: 'pipeline', outputDir: archiveRoot, pageCount: 1, status: 'succeeded' }),
      findSourceMetadata: () => ({ schemaVersion: 1, baseId: identifier.baseId, arxivId: '2601.00001v1', version: 1, title: 'Frozen evidence', authors: ['Ada Archive'], categories: ['cs.SE'], published: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z' }),
    } as unknown as ArchiveReaderStore,
  };
  await mutate?.(value);
  return value;
}

interface Fixture {
  root: string; stateRoot: string; archiveRoot: string; runRoot: string; source: Record<string, unknown>;
  store: ArchiveReaderStore;
}
type ArchiveReaderStore = Pick<StateStore, 'findSuccessfulParse' | 'findSourceMetadata'>;
async function removeFixture(value: Fixture) { await rm(value.root, { recursive: true, force: true }); }
async function rewriteSource(value: Fixture, change: (source: Record<string, unknown>) => Record<string, unknown> = source => source) {
  const source = change({ ...value.source, files: await archiveFileManifest(value.archiveRoot) });
  value.source = source;
  await writeFile(join(value.archiveRoot, 'source.json'), canonicalJson(source));
}
async function snapshot(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const info = await lstat(path);
    result.set(relative(root, path), `${info.mtimeMs}:${sha256(await readFile(path))}`);
  }
  return result;
}

test('reads a verified frozen Archive without mutating files or SQLite', async () => {
  const value = await fixture();
  try {
    const before = await snapshot(value.root);
    const sources = await readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].fullMarkdown, '# Evidence\n![Figure](assets/figure.png)\n');
    assert.deepEqual(sources[0].pages, [{ page: 1, text: 'Evidence' }]);
    assert.equal(sources[0].assets[0].relativePath, 'assets/figure.png');
    assert.deepEqual(await snapshot(value.root), before);
  } finally { await removeFixture(value); }
});

test('returns hash-verified asset contents with their retained hash and length', async () => {
  const value = await fixture();
  try {
    const sources = await readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store });
    const asset = sources[0].assets[0];
    assert.ok(asset.contents instanceof Uint8Array);
    assert.deepEqual(asset.contents, new TextEncoder().encode('image bytes'));
    assert.equal(asset.bytes, 11);
    assert.equal(asset.sha256, 'de7030234493a8bea844dbe1d8676e68a2c1a4b014c721f0425a22b6df66faec');

    asset.contents[0] = 'X'.charCodeAt(0);
    assert.equal(await readFile(join(value.archiveRoot, 'assets', 'figure.png'), 'utf8'), 'image bytes');
  } finally { await removeFixture(value); }
});

test('reads legacy MinerU auto assets without mutating the frozen Archive', async () => {
  const value = await fixture(async value => {
    await rm(join(value.archiveRoot, 'assets'), { recursive: true, force: true });
    const raw = join(value.archiveRoot, '2601.00001v1', 'auto');
    await mkdir(join(raw, 'images'), { recursive: true });
    await writeFile(join(raw, 'images', 'figure.png'), 'legacy image bytes');
    await writeFile(join(value.archiveRoot, 'normalized', 'full.md'), '# Evidence\n![Figure](images/figure.png)\n');
    await writeFile(join(value.archiveRoot, 'normalized', 'content-list.json'), JSON.stringify([{ type: 'image', img_path: 'images/figure.png' }]));
    await rewriteSource(value);
  });
  try {
    const before = await snapshot(value.root);
    const sources = await readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store });
    assert.equal(sources[0].assets[0].relativePath, 'images/figure.png');
    assert.match(sources[0].assets[0].sourcePath.replaceAll('\\', '/'), /2601\.00001v1\/auto\/images\/figure\.png$/);
    assert.equal(new TextDecoder().decode(sources[0].assets[0].contents), 'legacy image bytes');
    assert.deepEqual(await snapshot(value.root), before);
  } finally { await removeFixture(value); }
});

test('reads the discriminated local_pdf Archive contract without consulting arXiv metadata', async () => {
  const value = await fixture(async value => {
    const { arxivId, authors, categories, matchedTracks, published, updated, ...shared } = value.source;
    value.source = { ...shared, sourceKind: 'local_pdf', parserConfigKey: 'fixture-parser-config' };
    await writeFile(join(value.archiveRoot, 'source.json'), canonicalJson(value.source));
    value.store.findSourceMetadata = (() => { throw new Error('local PDFs must not query arXiv metadata'); }) as unknown as StateStore['findSourceMetadata'];
  });
  try {
    const sources = await readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store });
    const source = sources[0].source;
    assert.ok('sourceKind' in source);
    assert.equal(source.sourceKind, 'local_pdf');
  } finally { await removeFixture(value); }
});

test('rejects changed PDF bytes', async () => {
  const value = await fixture(async value => { await writeFile(join(value.archiveRoot, 'pdf', `${identifier.sha256}.pdf`), 'changed PDF'); });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /hash|manifest/i); }
  finally { await removeFixture(value); }
});

test('rejects a parse attempt that differs from frozen source.json', async () => {
  const value = await fixture(async value => { value.store.findSuccessfulParse = ((identity: typeof identifier) => ({ ...identity, attemptId: 'other-attempt', cliBackend: 'pipeline', outputDir: value.archiveRoot, pageCount: 1, status: 'succeeded' })) as unknown as StateStore['findSuccessfulParse']; });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /attempt/i); }
  finally { await removeFixture(value); }
});

test('rejects a missing normalized Archive file', async () => {
  const value = await fixture(async value => { await unlink(join(value.archiveRoot, 'normalized', 'full.md')); });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /missing|manifest/i); }
  finally { await removeFixture(value); }
});

test('rejects a changed manifest file hash', async () => {
  const value = await fixture(async value => { await writeFile(join(value.archiveRoot, 'normalized', 'full.md'), '# rewritten'); });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /hash|manifest/i); }
  finally { await removeFixture(value); }
});

test('rejects gaps in normalized pages', async () => {
  const value = await fixture(async value => {
    await writeFile(join(value.archiveRoot, 'normalized', 'pages.json'), JSON.stringify([{ page: 1, text: 'one' }, { page: 3, text: 'three' }]));
    await rewriteSource(value, source => ({ ...source, pageCount: 2 }));
    value.store.findSuccessfulParse = ((identity: typeof identifier) => ({
      ...identity, attemptId: 'attempt-1', cliBackend: 'pipeline', outputDir: value.archiveRoot,
      pageCount: 2, status: 'succeeded',
    })) as unknown as StateStore['findSuccessfulParse'];
  });
  try {
    await assert.rejects(
      readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }),
      /normalized pages must be sequential page\/text records/,
    );
  }
  finally { await removeFixture(value); }
});

test('rejects changed normalized pages bytes before parsing them', async () => {
  const value = await fixture(async value => {
    await writeFile(join(value.archiveRoot, 'normalized', 'pages.json'), JSON.stringify([{ page: 1, text: 'changed' }]));
  });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /hash|manifest/i); }
  finally { await removeFixture(value); }
});

test('rejects changed normalized content-list bytes before parsing them', async () => {
  const value = await fixture(async value => {
    await writeFile(join(value.archiveRoot, 'normalized', 'content-list.json'), JSON.stringify([{ type: 'text', text: 'changed' }]));
  });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /hash|manifest/i); }
  finally { await removeFixture(value); }
});

test('rejects local Markdown asset references absent from the Archive manifest', async () => {
  const value = await fixture(async value => {
    await writeFile(join(value.archiveRoot, 'normalized', 'full.md'), '![Missing](assets/missing.png)');
    await rewriteSource(value);
  });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /asset|manifest/i); }
  finally { await removeFixture(value); }
});

test('collects manifest-backed reference-style Markdown, HTML, and content-list src assets', async () => {
  const value = await fixture(async value => {
    await writeFile(join(value.archiveRoot, 'normalized', 'full.md'), [
      '![Reference][figure]',
      '[figure]: <assets/figure.png> "caption"',
      '<img alt="figure" src="assets/figure.png">',
      '',
    ].join('\n'));
    await writeFile(join(value.archiveRoot, 'normalized', 'content-list.json'), JSON.stringify([
      { type: 'image', src: 'assets/figure.png' },
    ]));
    await rewriteSource(value);
  });
  try {
    const sources = await readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store });
    assert.deepEqual(sources[0].assets.map(asset => asset.relativePath), ['assets/figure.png']);
  } finally { await removeFixture(value); }
});

test('rejects reference-style Markdown assets absent from the Archive manifest', async () => {
  const value = await fixture(async value => {
    await writeFile(join(value.archiveRoot, 'normalized', 'full.md'), '![Missing][figure]\n[figure]: assets/missing.png\n');
    await rewriteSource(value);
  });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /asset|manifest/i); }
  finally { await removeFixture(value); }
});

test('rejects HTML image assets absent from the Archive manifest', async () => {
  const value = await fixture(async value => {
    await writeFile(join(value.archiveRoot, 'normalized', 'full.md'), '<img src="assets/missing.png" alt="missing">\n');
    await rewriteSource(value);
  });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /asset|manifest/i); }
  finally { await removeFixture(value); }
});

test('fails closed on malformed HTML image references', async () => {
  const value = await fixture(async value => {
    await writeFile(join(value.archiveRoot, 'normalized', 'full.md'), '<img src="assets/missing.png"\n');
    await rewriteSource(value);
  });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /HTML|image|asset/i); }
  finally { await removeFixture(value); }
});

test('fails closed on HTML source elements without src or srcset', async () => {
  const value = await fixture(async value => {
    await writeFile(join(value.archiveRoot, 'normalized', 'full.md'), '<picture><source type="image/png"></picture>\n');
    await rewriteSource(value);
  });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /HTML|image|source|asset/i); }
  finally { await removeFixture(value); }
});

test('rejects content-list src assets absent from the Archive manifest', async () => {
  const value = await fixture(async value => {
    await writeFile(join(value.archiveRoot, 'normalized', 'content-list.json'), JSON.stringify([
      { type: 'image', src: 'assets/missing.png' },
    ]));
    await rewriteSource(value);
  });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /asset|manifest/i); }
  finally { await removeFixture(value); }
});

test('defaults an absent run-manifest method to auto', async () => {
  const value = await fixture(async value => {
    const { method: _method, ...job } = { ...identifier, outputDir: value.archiveRoot };
    await writeFile(join(value.runRoot, 'mineru-jobs.json'), JSON.stringify({ runId: 'run-1', jobs: [job] }));
  });
  try {
    const sources = await readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store });
    assert.equal(sources[0].source.method, 'auto');
  } finally { await removeFixture(value); }
});

for (const invalidMethod of [null, false, 1, 'bogus']) {
  test(`rejects a present invalid run-manifest method ${JSON.stringify(invalidMethod)}`, async () => {
    const value = await fixture(async value => {
      await writeFile(join(value.runRoot, 'mineru-jobs.json'), JSON.stringify({
        runId: 'run-1', jobs: [{ ...identifier, method: invalidMethod, outputDir: value.archiveRoot }],
      }));
    });
    try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /method/i); }
    finally { await removeFixture(value); }
  });
}

test('rejects symlink and junction Archive roots', async () => {
  const value = await fixture(async value => {
    const linked = join(value.stateRoot, 'extracted', 'linked');
    await symlink(value.archiveRoot, linked, 'junction');
    await writeFile(join(value.runRoot, 'mineru-jobs.json'), JSON.stringify({ runId: 'run-1', jobs: [{ ...identifier, outputDir: linked }] }));
  });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /link|reparse/i); }
  finally { await removeFixture(value); }
});

test('rejects Archives outside stateRoot/extracted', async () => {
  const value = await fixture(async value => {
    await writeFile(join(value.runRoot, 'mineru-jobs.json'), JSON.stringify({ runId: 'run-1', jobs: [{ ...identifier, outputDir: value.root }] }));
  });
  try { await assert.rejects(readVerifiedRunSources({ runId: 'run-1', stateRoot: value.stateRoot, store: value.store }), /escapes|extracted|outside/i); }
  finally { await removeFixture(value); }
});

test('rejects run-manifest path escapes', async () => {
  const value = await fixture();
  try { await assert.rejects(readVerifiedRunSources({ runId: '../run-1', stateRoot: value.stateRoot, store: value.store }), /run.*path|safe/i); }
  finally { await removeFixture(value); }
});
