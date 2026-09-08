import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { BufferedEvidenceSource as VerifiedArchiveSource } from '../src/evidence/layout-paths.ts';
import { renderPaperEvidenceV3 as renderPaperEvidence, type RenderedFile } from '../src/evidence/render-paper.ts';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const decoder = new TextDecoder();
const paths = (files: RenderedFile[]) => files.map(file => file.path);
const text = (files: RenderedFile[], suffix: string) => decoder.decode(files.find(file => file.path.endsWith(suffix))?.bytes);

function fixture(archiveRoot: string): VerifiedArchiveSource {
  const pdfSha256 = sha256('frozen PDF');
  const figure = new Uint8Array([137, 80, 78, 71]);
  return {
    pdfContents: new TextEncoder().encode('frozen PDF'),
    source: {
      schemaVersion: 1,
      baseId: '2601.00001',
      arxivId: '2601.00001v1',
      version: 1,
      title: 'Frozen evidence',
      authors: ['Ada Archive'],
      categories: ['cs.SE'],
      matchedTracks: ['AI-FSD'],
      published: '2026-01-01T00:00:00Z',
      updated: '2026-01-02T00:00:00Z',
      pdfPath: `pdf/${pdfSha256}.pdf`,
      pdfSha256,
      parseAttemptId: 'attempt-1',
      model: 'pipeline',
      cliBackend: 'pipeline',
      method: 'auto',
      pageCount: 2,
      normalized: {
        fullMarkdown: 'normalized/full.md',
        pageMarkedText: 'normalized/page-marked.txt',
        pages: 'normalized/pages.json',
        contentList: 'normalized/content-list.json',
      },
      files: [
        { path: 'assets/figure.png', sha256: sha256(figure), bytes: figure.byteLength },
        { path: 'normalized/content-list.json', sha256: sha256('[]'), bytes: 2 },
        { path: 'normalized/full.md', sha256: sha256(''), bytes: 0 },
        { path: 'normalized/page-marked.txt', sha256: sha256(''), bytes: 0 },
        { path: 'normalized/pages.json', sha256: sha256('[]'), bytes: 2 },
        { path: `pdf/${pdfSha256}.pdf`, sha256: pdfSha256, bytes: 10 },
      ],
    },
    archiveRoot,
    archiveManifestSha256: sha256('archive manifest'),
    fullMarkdown: '# Evidence\n![Figure](assets/figure.png)\n',
    pages: [{ page: 1, text: 'First page' }, { page: 2, text: 'Second page' }],
    contentList: [{ type: 'image', src: 'assets/figure.png' }],
    assets: [{
      sourcePath: `${archiveRoot}/assets/figure.png`,
      relativePath: 'assets/figure.png',
      sha256: sha256(figure),
      bytes: figure.byteLength,
      contents: figure,
    }],
  };
}

test('paper renderer emits only readable source facts, pages, PDF and referenced assets', () => {
  const files = renderPaperEvidence(fixture('D:/fixtures/one'));
  expect(paths(files)).toEqual([
    'Evidence/papers/2601.00001-v1/assets/figure.png',
    'Evidence/papers/2601.00001-v1/pages.md',
    'Evidence/papers/2601.00001-v1/paper.md',
    'Evidence/papers/2601.00001-v1/source.pdf',
  ]);
  const paper = text(files, 'paper.md');
  expect(paper).toContain('![Figure](assets/figure.png)');
  expect(paper).toContain('[source.pdf](source.pdf)');
  expect(paper).toContain('[pages.md](pages.md)');
  expect(paper).toContain('[[Evidence/indexes/authors|Authors]]');
  expect(paper).toContain('attempt-1');
  expect(paper).toContain(fixture('unused').archiveManifestSha256);
  expect(paper).not.toContain('D:/fixtures');
  expect(paper).not.toContain('pages.json');
  expect(text(files, 'pages.md')).toBe('# PAGE 1\n\nFirst page\n\n^page-1\n\n# PAGE 2\n\nSecond page\n\n^page-2\n');
  expect(files.find(file => file.path.endsWith('/source.pdf'))!.bytes).toEqual(new TextEncoder().encode('frozen PDF'));
});

test('paper renderer is byte-identical across archive roots', () => {
  const first = renderPaperEvidence(fixture('D:/fixtures/one'));
  const second = renderPaperEvidence(fixture('E:/temporary/two'));
  expect(second.map(file => ({ path: file.path, bytes: [...file.bytes], sha256: file.sha256 })))
    .toEqual(first.map(file => ({ path: file.path, bytes: [...file.bytes], sha256: file.sha256 })));
  for (const file of first) expect(file.sha256).toBe(sha256(file.bytes));
});

test('paper renderer rewrites every verified local Markdown asset link', () => {
  const source = fixture('D:/fixtures/links');
  const table = new TextEncoder().encode('name,value\nAda,1\n');
  source.fullMarkdown = [
    '[Download](tables/data.csv?download=1#records)',
    '![Figure][figure]',
    '[figure]: assets/figure.png#diagram',
    '<img src="tables/data.csv?preview=1">',
    '<source srcset="tables/data.csv#one 1x, https://example.test/remote.csv 2x">',
    '[External](https://example.test/data.csv) [Anchor](#records)',
    '',
  ].join('\r\n');
  source.contentList = [{ type: 'table', src: 'tables/data.csv' }];
  source.assets.push({
    sourcePath: 'D:/fixtures/links/tables/data.csv',
    relativePath: 'tables/data.csv',
    sha256: sha256(table),
    bytes: table.byteLength,
    contents: table,
  });

  const rendered = renderPaperEvidence(source);
  const document = text(rendered, 'paper.md');
  expect(document).toContain([
    '[Download](assets/tables/data.csv?download=1#records)',
    '![Figure][figure]',
    '[figure]: assets/figure.png#diagram',
    '<img src="assets/tables/data.csv?preview=1">',
    '<source srcset="assets/tables/data.csv#one 1x, https://example.test/remote.csv 2x">',
    '[External](https://example.test/data.csv) [Anchor](#records)',
    '',
  ].join('\n'));
  expect(rendered.some(file => file.path.endsWith('assets/tables/data.csv'))).toBe(true);
});

test('paper renderer rewrites a raw Markdown image only when its normalized Archive asset is verified', () => {
  const source = fixture('D:/fixtures/raw-image');
  source.fullMarkdown = [
    '😀 The literal delimiter \\` is prose.',
    '![Figure](images/figure.png)',
    'Inline code: `![example](images/not-a-resource.png)`.',
  ].join('\n');
  source.contentList = [];
  source.assets[0] = { ...source.assets[0]!, sourcePath: 'D:/fixtures/raw-image/assets/images/figure.png', relativePath: 'assets/images/figure.png' };

  const rendered = renderPaperEvidence(source);
  expect(text(rendered, 'paper.md')).toContain('![Figure](assets/images/figure.png)');
  expect(text(rendered, 'paper.md')).toContain('`![example](images/not-a-resource.png)`');
  expect(rendered.some(file => file.path.endsWith('assets/images/figure.png'))).toBe(true);
});

test('paper template embeds the full document without unresolved placeholders', () => {
  const paper = text(renderPaperEvidence(fixture('D:/fixtures/template')), 'paper.md');
  expect(paper).not.toMatch(/\{\{[A-Za-z]+\}\}/);
  expect(paper).toContain('## MinerU document');
  expect(paper).toContain('# Evidence\n![Figure](assets/figure.png)');
});

test('paper renderer canonically renders a verified local PDF source', () => {
  const source = fixture('D:/fixtures/local');
  source.source = {
    schemaVersion: 1,
    sourceKind: 'local_pdf',
    baseId: 'local-fixture',
    version: 1,
    title: 'Local frozen evidence',
    pdfPath: source.source.pdfPath,
    pdfSha256: source.source.pdfSha256,
    parseAttemptId: source.source.parseAttemptId,
    parserConfigKey: 'fixture-config',
    model: 'pipeline',
    cliBackend: 'pipeline',
    method: 'auto',
    pageCount: 2,
    normalized: { fullMarkdown: 'normalized/full.md', pageMarkedText: 'normalized/page-marked.txt', pages: 'normalized/pages.json', contentList: 'normalized/content-list.json' },
    files: source.source.files,
  };

  const files = renderPaperEvidence(source);
  expect(text(files, 'paper.md')).toContain('local-fixturev1');
  expect(files.some(file => file.path.endsWith('.json'))).toBe(false);
});

test('paper rendering rejects asset file-directory collisions before planning writes', () => {
  const source = fixture('D:/fixtures/collision');
  source.fullMarkdown = '[Data](assets/data) [Child](assets/data/child.csv)';
  source.contentList = [];
  source.assets = ['assets/data', 'assets/data/child.csv'].map(relativePath => {
    const contents = new TextEncoder().encode('resource');
    return { relativePath, sourcePath: relativePath, contents, sha256: sha256(contents), bytes: contents.length };
  });
  expect(() => renderPaperEvidence(source)).toThrow('collision');
});
