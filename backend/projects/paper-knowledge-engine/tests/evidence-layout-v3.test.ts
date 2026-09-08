import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/shared/manifest.ts';
import type { VerifiedArchiveV2 } from '../src/shared/archive-v2.ts';
import { verifyArchiveV2 } from '../src/shared/archive-v2.ts';
import type { LibraryId } from '../src/shared/identity.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (text: string) => new TextEncoder().encode(text);
function fixture(baseId = '2601.00001'): VerifiedArchiveV2 {
  const source = { title: 'Source facts', authors: ['Ada Archive'], categories: ['cs.SE'], matchedTracks: ['AI-FSD'],
    arxivId: `${baseId}v1`, published: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z', parseAttemptId: 'attempt-1', pageCount: 2 };
  const pages = [{ page: 1, text: 'First page' }, { page: 2, text: 'Second page' }];
  const fullMarkdown = '# Parsed text\n\n![Figure](assets/figure.png)\n';
  const contentList = [{ type: 'image', img_path: 'assets/figure.png' }];
  const payloads = new Map([
    ['source.pdf', encode('%PDF fixture')], ['source.json', encode(canonicalJson(source))],
    ['document.md', encode(fullMarkdown)], ['pages.json', encode(canonicalJson(pages))],
    ['content-list.json', encode(canonicalJson(contentList))], ['assets/figure.png', new Uint8Array([137, 80, 78, 71])],
  ]);
  return { root: 'D:/not-read', source, pages, fullMarkdown, contentList, payloads,
    manifest: { schemaVersion: 2, libraryId: 'fsd' as LibraryId, sourceKind: 'arxiv', baseId, version: 1,
      pdfSha256: hash(payloads.get('source.pdf')!), parser: { name: 'MinerU', version: '3.4.5', model: 'pipeline', method: 'auto' },
      artifacts: { pdf: 'source.pdf', document: 'document.md', pages: 'pages.json', contentList: 'content-list.json', assetsRoot: 'assets' },
      files: [...payloads].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) } };
}

/** Verify a real Archive first, then inject page text to exercise renderer defenses independently. */
async function resourceFixture(options: { pageText: string; csv?: boolean; markdown?: string; pdfAttachment?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'evidence-v3-resources-'));
  try {
    const value = fixture();
    const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage();
    const payloads = new Map(value.payloads);
    payloads.set('source.pdf', await pdf.save());
    const fullMarkdown = options.markdown ?? value.fullMarkdown;
    const contentList = [...value.contentList];
    if (options.csv) {
      payloads.set('assets/tables/data.csv', encode('name,value\na,1\n'));
      contentList.push({ type: 'table', text: '<a href="assets/tables/data.csv">data</a>' });
    }
    if (options.pdfAttachment) {
      payloads.set('assets/source.pdf', encode('separate PDF attachment'));
      contentList.push({ type: 'text', text: '[attachment](assets/source.pdf)' });
    }
    payloads.set('document.md', encode(fullMarkdown));
    payloads.set('content-list.json', encode(canonicalJson(contentList)));
    payloads.set('pages.json', encode(canonicalJson(value.pages)));
    for (const [path, bytes] of payloads) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), bytes);
    }
    await writeFile(join(root, 'manifest.json'), canonicalJson({ ...value.manifest,
      pdfSha256: hash(payloads.get('source.pdf')!),
      files: [...payloads].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) }));
    const archive = await verifyArchiveV2(root);
    archive.pages[0].text = options.pageText;
    return { archive, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

// Dynamic import makes the initial RED an explicit missing public behavior assertion.
async function renderer() {
  const path = '../src/evidence/layout-v3.ts';
  const module = await import(path).catch(() => null);
  expect(module?.renderEvidenceV3).toBeFunction();
  return module as { renderEvidenceV3(sources: VerifiedArchiveV2[]): { path: string; bytes: Uint8Array; sha256: string }[] };
}

test('v3 publishes exactly one compact paper package and four aggregate indexes', async () => {
  const { renderEvidenceV3 } = await renderer();
  const files = renderEvidenceV3([fixture()]);
  expect(files.map(file => file.path)).toEqual([
    'Evidence/indexes/authors.md', 'Evidence/indexes/categories.md', 'Evidence/indexes/tracks.md', 'Evidence/indexes/years.md',
    'Evidence/papers/2601.00001-v1/assets/figure.png', 'Evidence/papers/2601.00001-v1/pages.md',
    'Evidence/papers/2601.00001-v1/paper.md', 'Evidence/papers/2601.00001-v1/source.pdf',
  ]);
  const paper = new TextDecoder().decode(files.find(file => file.path.endsWith('/paper.md'))!.bytes);
  expect(paper).toContain('[source.pdf](source.pdf)');
  expect(paper).toContain('[pages.md](pages.md)');
  expect(paper).toContain('# Parsed text\n\n![Figure](assets/figure.png)');
  expect(paper).not.toContain('D:/not-read');
  expect(files.find(file => file.path.endsWith('/source.pdf'))!.bytes).toEqual(fixture().payloads.get('source.pdf')!);
});

test('v3 rendering is deterministic across roots, order and exact duplicate inputs', async () => {
  const { renderEvidenceV3 } = await renderer();
  const a = fixture(), b = fixture('2601.00002');
  const first = renderEvidenceV3([b, a, a]);
  a.root = 'E:/another-root';
  expect(renderEvidenceV3([a, b])).toEqual(first);
  for (const file of first) expect(file.sha256).toBe(hash(file.bytes));
  expect(renderEvidenceV3([]).map(file => file.path)).toEqual([
    'Evidence/indexes/authors.md', 'Evidence/indexes/categories.md', 'Evidence/indexes/tracks.md', 'Evidence/indexes/years.md',
  ]);
});

test('v3 fails closed on missing PDF, referenced assets, changed bytes and case aliases', async () => {
  const { renderEvidenceV3 } = await renderer();
  for (const path of ['source.pdf', 'assets/figure.png']) {
    const source = fixture();
    (source.payloads as Map<string, Uint8Array>).delete(path);
    expect(() => renderEvidenceV3([source])).toThrow();
  }
  const changed = fixture();
  (changed.payloads as Map<string, Uint8Array>).set('assets/figure.png', encode('changed'));
  expect(() => renderEvidenceV3([changed])).toThrow();
  expect(() => renderEvidenceV3([fixture('Paper'), fixture('paper')])).toThrow();
});

test('v3 pages rewrite checked local HTML and Markdown resources to the published assets', async () => {
  const f = await resourceFixture({ csv: true, pageText: [
    '<a href="tables/data.csv?download=1#rows">data</a>',
    '[data](tables/data.csv)', '[reference][data]', '[data]: tables/data.csv',
    '<img src="figure.png" srcset="figure.png 1x, assets/figure.png 2x">',
  ].join('\n') });
  try {
    const { renderEvidenceV3 } = await renderer();
    const files = renderEvidenceV3([f.archive]);
    const pages = new TextDecoder().decode(files.find(file => file.path.endsWith('/pages.md'))!.bytes);
    expect(pages).toContain('href="assets/tables/data.csv?download=1#rows"');
    expect(pages).toContain('[data](assets/tables/data.csv)');
    expect(pages).toContain('[data]: assets/tables/data.csv');
    expect(pages).toContain('src="assets/figure.png" srcset="assets/figure.png 1x, assets/figure.png 2x"');
    expect(files.filter(file => file.path.endsWith('/assets/tables/data.csv'))).toHaveLength(1);
    expect(files.find(file => file.path.endsWith('/assets/tables/data.csv'))!.bytes).toEqual(encode('name,value\na,1\n'));
    expect(renderEvidenceV3([f.archive])).toEqual(files);
  } finally { await f.close(); }
});

for (const kind of ['missing', 'unmanifested'] as const) {
  test(`v3 pages reject ${kind} resource references even when document and content-list are valid`, async () => {
    const f = await resourceFixture({ pageText: '<a href="tables/data.csv">data</a>' });
    try {
      if (kind === 'unmanifested') (f.archive.payloads as Map<string, Uint8Array>).set('assets/tables/data.csv', encode('extra bytes'));
      const { renderEvidenceV3 } = await renderer();
      expect(() => renderEvidenceV3([f.archive])).toThrow(/absent|missing|manifest/);
    } finally { await f.close(); }
  });
}

for (const pageText of [
  '<a href="../secret.csv">escape</a>', '<a href="%2e%2e/secret.csv">encoded escape</a>',
  '[escape](C:/secret.csv)', '<a href="tables/data.csv" href="../secret.csv">ambiguous</a>',
  '<a href="&#46;&#46;/secret.csv">entities</a>',
]) {
  test(`v3 page text retains safe reference rejection: ${pageText}`, async () => {
    const f = await resourceFixture({ pageText });
    try {
      const { renderEvidenceV3 } = await renderer();
      expect(() => renderEvidenceV3([f.archive])).toThrow();
    } finally { await f.close(); }
  });
}

for (const pdfAttachment of [false, true]) {
  test(`v3 fixed source.pdf links remain package-local, separate attachment=${pdfAttachment}`, async () => {
    const f = await resourceFixture({
      markdown: '# Parsed text\n[PDF](source.pdf)\n<a href="source.pdf#page=2">PDF page 2</a>',
      pageText: '[PDF](source.pdf#page=1)\n<a href="source.pdf">source</a>',
      pdfAttachment,
    });
    try {
      const { renderEvidenceV3 } = await renderer();
      const files = renderEvidenceV3([f.archive]);
      const paper = new TextDecoder().decode(files.find(file => file.path.endsWith('/paper.md'))!.bytes);
      const pages = new TextDecoder().decode(files.find(file => file.path.endsWith('/pages.md'))!.bytes);
      expect(paper).toContain('# Parsed text\n[PDF](source.pdf)');
      expect(paper).toContain('href="source.pdf#page=2"');
      expect(pages).toContain('[PDF](source.pdf#page=1)');
      expect(pages).toContain('href="source.pdf"');
      expect(files.find(file => file.path === 'Evidence/papers/2601.00001-v1/source.pdf')!.bytes).toEqual(f.archive.payloads.get('source.pdf')!);
      const attachment = files.find(file => file.path.endsWith('/assets/source.pdf'));
      if (pdfAttachment) expect(attachment!.bytes).toEqual(encode('separate PDF attachment'));
      else expect(attachment).toBeUndefined();
    } finally { await f.close(); }
  });
}

for (const target of ['source.json', 'document.md', 'pages.json', 'content-list.json', 'paper.md', 'pages.md', 'SOURCE.PDF', '../source.pdf', '%2e%2e/source.pdf']) {
  test(`v3 fixed-output allowance does not authorize ${target}`, async () => {
    const f = await resourceFixture({ pageText: `[not an allowed fixed output](${target})` });
    try {
      const { renderEvidenceV3 } = await renderer();
      expect(() => renderEvidenceV3([f.archive])).toThrow();
    } finally { await f.close(); }
  });
}
