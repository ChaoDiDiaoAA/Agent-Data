import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { VerifiedArchiveSource } from '../src/evidence/archive-reader.ts';
import { authorPageId, renderEvidenceIndexesV3 as renderEvidenceIndexes } from '../src/evidence/render-indexes.ts';

const decoder = new TextDecoder();
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const page = (files: ReturnType<typeof renderEvidenceIndexes>, path: string) => {
  const file = files.find(candidate => candidate.path === path);
  if (!file) throw new Error(`Missing rendered file: ${path}`);
  return decoder.decode(file.bytes);
};

function fixture(input: {
  baseId: string;
  version: number;
  title: string;
  authors: string[];
  categories?: string[];
  tracks?: string[];
  published?: string;
}): VerifiedArchiveSource {
  const pdfSha256 = sha256(`${input.baseId} PDF`);
  return {
    source: {
      schemaVersion: 1,
      baseId: input.baseId,
      arxivId: `${input.baseId}v${input.version}`,
      version: input.version,
      title: input.title,
      authors: input.authors,
      categories: input.categories ?? ['cs.SE'],
      matchedTracks: input.tracks ?? ['AI-FSD'],
      published: input.published ?? '2026-01-01T00:00:00Z',
      updated: '2026-01-02T00:00:00Z',
      pdfPath: `pdf/${pdfSha256}.pdf`,
      pdfSha256,
      parseAttemptId: `attempt-${input.version}`,
      model: 'pipeline',
      cliBackend: 'pipeline',
      method: 'auto',
      pageCount: 1,
      normalized: {
        fullMarkdown: 'normalized/full.md',
        pageMarkedText: 'normalized/page-marked.txt',
        pages: 'normalized/pages.json',
        contentList: 'normalized/content-list.json',
      },
      files: [],
    },
    archiveRoot: 'D:/fixture/archive',
    archiveManifestSha256: sha256('archive'),
    fullMarkdown: '',
    pages: [{ page: 1, text: '' }],
    contentList: [],
    assets: [],
  };
}

test('indexes create stable bidirectional paper relationships', () => {
  const paperA = fixture({ baseId: '2601.00001', version: 1, title: 'Paper A', authors: ['Alice Example'] });
  const paperB = fixture({ baseId: '2601.00002', version: 1, title: 'Paper B', authors: ['Bob Example'], categories: ['cs.AI'], tracks: ['AI-TDD'] });
  const files = renderEvidenceIndexes([paperB, paperA]);
  const paperLink = '[[Evidence/papers/2601.00001-v1/paper|Paper A]]';

  expect(page(files, 'Evidence/indexes/authors.md')).toContain(paperLink);
  expect(page(files, 'Evidence/indexes/categories.md')).toContain(paperLink);
  expect(page(files, 'Evidence/indexes/tracks.md')).toContain(paperLink);
  expect(page(files, 'Evidence/indexes/years.md')).toContain(paperLink);
  expect(files.map(file => file.path)).toEqual(['Evidence/indexes/authors.md', 'Evidence/indexes/categories.md', 'Evidence/indexes/tracks.md', 'Evidence/indexes/years.md']);
  expect(page(files, 'Evidence/indexes/authors.md')).toContain('## Alice Example');
});

test('indexes accept arXiv categories with and without a namespace separator', () => {
  const files = renderEvidenceIndexes([fixture({
    baseId: '2601.00003', version: 1, title: 'Category Paper', authors: ['Ada'],
    categories: ['quant-ph', 'hep-th', 'cs.AI'],
  })]);
  const categories = page(files, 'Evidence/indexes/categories.md');
  expect(categories).toContain('## quant-ph');
  expect(categories).toContain('## hep-th');
  expect(categories).toContain('## cs.AI');
});

test('author page identities canonicalize equivalent names without unsafe paths', () => {
  expect(authorPageId(' Alice   Example ')).toBe(authorPageId('Alice Example'));
  expect(authorPageId('Ada\u00a0Lovelace')).toBe(authorPageId('Ada Lovelace'));
  expect(authorPageId('Alice Example')).toMatch(/^alice-example--[0-9a-f]{8}$/);
  expect(authorPageId('Ada-Lovelace')).not.toBe(authorPageId('Ada Lovelace'));
  expect(authorPageId('Ada-Lovelace').replace(/--[0-9a-f]{8}$/, '')).toBe('ada-lovelace');
  expect(authorPageId('Ada Lovelace').replace(/--[0-9a-f]{8}$/, '')).toBe('ada-lovelace');
});

test('indexes deduplicate sources and remain byte-identical across input permutations', () => {
  const versionTwo = fixture({ baseId: '2601.00001', version: 2, title: 'Paper A v2', authors: ['Alice Example'] });
  const versionOne = fixture({ baseId: '2601.00001', version: 1, title: 'Paper A', authors: ['Alice Example'] });
  const first = renderEvidenceIndexes([versionTwo, versionOne, versionOne]);
  const second = renderEvidenceIndexes([versionOne, versionTwo]);

  expect(first.map(file => ({ path: file.path, bytes: [...file.bytes], sha256: file.sha256 })))
    .toEqual(second.map(file => ({ path: file.path, bytes: [...file.bytes], sha256: file.sha256 })));
  const author = page(first, 'Evidence/indexes/authors.md');
  expect(author).toContain('[[Evidence/papers/2601.00001-v1/paper|Paper A]]');
  expect(author).toContain('[[Evidence/papers/2601.00001-v2/paper|Paper A v2]]');
  expect(author.indexOf('-v1/')).toBeLessThan(author.indexOf('-v2/'));
  expect(author.split('[[Evidence/papers/2601.00001-v1/paper|Paper A]]')).toHaveLength(2);
});

test('indexes reject unsafe category, track, and year path values', () => {
  expect(() => renderEvidenceIndexes([fixture({ baseId: '2601.00001', version: 1, title: 'Unsafe category', authors: ['Ada'], categories: ['../outside'] })]))
    .toThrow('unsafe category');
  expect(() => renderEvidenceIndexes([fixture({ baseId: '2601.00001', version: 1, title: 'Unsafe track', authors: ['Ada'], tracks: ['AI/FSD'] })]))
    .toThrow('unsafe track');
  expect(() => renderEvidenceIndexes([fixture({ baseId: '2601.00001', version: 1, title: 'Unsafe year', authors: ['Ada'], published: '../../escape' })]))
    .toThrow('unsafe year');
});
