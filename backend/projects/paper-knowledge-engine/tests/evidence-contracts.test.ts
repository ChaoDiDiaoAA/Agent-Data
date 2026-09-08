import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, hashCanonical, validateArchiveSource } from '../src/evidence/contracts.ts';

const hash = 'a'.repeat(64);
const valid = {
  schemaVersion: 1,
  baseId: '2601.00001',
  arxivId: '2601.00001v1',
  version: 1,
  title: 'Deterministic archive fixture',
  authors: ['Ada Archive'],
  categories: ['cs.SE'],
  matchedTracks: ['AI-FSD'],
  published: '2026-01-01T00:00:00Z',
  updated: '2026-01-02T00:00:00Z',
  pdfPath: 'pdf/2601.00001v1.pdf',
  pdfSha256: hash,
  parseAttemptId: 'attempt-1',
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
  files: [
    { path: 'normalized/content-list.json', sha256: hash, bytes: 2 },
    { path: 'normalized/full.md', sha256: hash, bytes: 1 },
    { path: 'normalized/page-marked.txt', sha256: hash, bytes: 3 },
    { path: 'normalized/pages.json', sha256: hash, bytes: 4 },
  ],
} as const;

test('ArchiveSource rejects path escape and canonicalizes file order', () => {
  const [a, b, ...rest] = valid.files;
  assert.throws(() => validateArchiveSource({ ...valid, files: [{ path: '../x', sha256: hash, bytes: 1 }, ...rest] }), /path/i);
  assert.equal(
    canonicalJson({ ...valid, files: [b, a, ...rest] }),
    canonicalJson({ ...valid, files: [a, b, ...rest] }),
  );
});

test('canonical JSON sorts object keys, ends in LF, and hashes UTF-8 bytes', () => {
  const canonical = canonicalJson({ z: 1, a: { z: false, a: true } });
  assert.equal(canonical, '{"a":{"a":true,"z":false},"z":1}\n');
  assert.equal(hashCanonical({ z: 1, a: { z: false, a: true } }), createHash('sha256').update(canonical, 'utf8').digest('hex'));
});

test('canonical JSON only sorts exact manifest-entry arrays, not semantic arrays with paths', () => {
  const semantic = [
    { path: 'z-last', label: 'first semantic item' },
    { path: 'a-first', label: 'second semantic item' },
  ];
  const output = canonicalJson({ semantic, files: [...valid.files].reverse() });
  assert.ok(output.indexOf('z-last') < output.indexOf('a-first'));
  assert.ok(output.indexOf('normalized/content-list.json') < output.indexOf('normalized/pages.json'));
});

test('ArchiveSource rejects duplicate paths, invalid hashes, and absolute manifest paths', () => {
  assert.throws(() => validateArchiveSource({ ...valid, files: [...valid.files, { ...valid.files[0] }] }), /duplicate.*path/i);
  assert.throws(() => validateArchiveSource({ ...valid, pdfSha256: 'A'.repeat(64) }), /sha256/i);
  assert.throws(() => validateArchiveSource({ ...valid, files: valid.files.map((entry, index) => index === 0 ? { ...entry, sha256: 'a'.repeat(63) } : entry) }), /sha256/i);
  assert.throws(() => validateArchiveSource({ ...valid, files: valid.files.map((entry, index) => index === 0 ? { ...entry, path: '/absolute.json' } : entry) }), /path/i);
  assert.throws(() => validateArchiveSource({ ...valid, files: valid.files.map((entry, index) => index === 0 ? { ...entry, path: 'C:/absolute.json' } : entry) }), /path/i);
  assert.throws(() => validateArchiveSource({ ...valid, pdfPath: '/absolute.pdf' }), /path/i);
  assert.throws(() => validateArchiveSource({ ...valid, pdfPath: 'D:/absolute.pdf' }), /path/i);
  assert.throws(() => validateArchiveSource({ ...valid, pdfPath: '../escape.pdf' }), /path/i);
  assert.throws(() => validateArchiveSource({ ...valid, pdfPath: 'pdf\\windows.pdf' }), /path/i);
});

test('ArchiveSource rejects unknown normalized files and incomplete new arXiv metadata', () => {
  assert.throws(() => validateArchiveSource({ ...valid, normalized: { ...valid.normalized, pages: 'normalized/other-pages.json' } }), /normalized/i);
  assert.throws(() => validateArchiveSource({ ...valid, files: valid.files.map((entry, index) => index === 0 ? { ...entry, path: 'normalized/unknown.json' } : entry) }), /normalized/i);
  assert.throws(() => validateArchiveSource({ ...valid, pageCount: 0 }), /page/i);
  assert.throws(() => validateArchiveSource({ ...valid, authors: [] }), /authors/i);
});

test('ArchiveSource rejects control characters and duplicate or inconsistent identities', () => {
  assert.throws(() => validateArchiveSource({ ...valid, title: 'bad\u0000title' }), /control/i);
  assert.throws(() => validateArchiveSource({ ...valid, matchedTracks: ['AI-FSD', 'AI-FSD'] }), /duplicate/i);
  assert.throws(() => validateArchiveSource({ ...valid, arxivId: '2601.00001v2' }), /identity/i);
  assert.throws(() => validateArchiveSource({ ...valid, legacy: true }), /unknown/i);
});

test('ArchiveSource validation returns a canonical file ordering without accepting legacy fields', () => {
  const source = validateArchiveSource({ ...valid, files: [...valid.files].reverse() });
  assert.deepEqual(source.files.map((entry) => entry.path), [
    'normalized/content-list.json',
    'normalized/full.md',
    'normalized/page-marked.txt',
    'normalized/pages.json',
  ]);
  assert.throws(() => validateArchiveSource({ baseId: 'legacy' }), /missing|unknown/i);
});
