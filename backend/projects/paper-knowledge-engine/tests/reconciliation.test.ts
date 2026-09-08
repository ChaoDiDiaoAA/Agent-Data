import { removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcilePaperArtifacts, reconcileLibraryArtifacts, repairDuplicatePdf, scanDuplicatePdfs } from '../src/maintenance/reconciliation.ts';
import { vaultFixture } from './helpers/vault-fixture.ts';
import { renderEvidenceV3 } from '../src/evidence/layout-v3.ts';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';

for (const damage of ['missing', 'corrupt'] as const) test(`compact reconciliation reports ${damage} Archive without aborting other papers`, async () => {
  const f = await vaultFixture(2);
  try {
    for (const file of renderEvidenceV3(f.sources)) {
      await mkdir(dirname(join(f.input.vaultRoot, file.path)), { recursive: true });
      await writeFile(join(f.input.vaultRoot, file.path), file.bytes);
    }
    const pdf = join(f.sources[0]!.root, 'source.pdf');
    if (damage === 'missing') await rm(pdf); else await writeFile(pdf, 'corrupt');
    const report = await reconcileLibraryArtifacts({ archiveRoot: f.input.archiveRoot, vaultRoot: f.input.vaultRoot,
      exists: existsSync, rows: f.sources.map(s => ({ base_id: s.manifest.baseId, status: 'parsed', pdf_path: join(s.root, 'source.pdf') })) });
    assert.equal(report.archiveIssues.length, 1);
    assert.deepEqual(damage === 'missing' ? report.missingPdf : report.retryParse, ['2601.00001']);
    assert.ok(report.rebuildNote.includes('2601.00002') || report.consistent.includes('2601.00002'));
    assert.equal(report.evidence.valid, false);
  } finally { await f.close(); }
});

test('compact reconciliation accepts archived PDFs without downloads or legacy Wiki notes', async () => {
  const f = await vaultFixture();
  try {
    for (const file of renderEvidenceV3(f.sources)) {
      await mkdir(dirname(join(f.input.vaultRoot, file.path)), { recursive: true });
      await writeFile(join(f.input.vaultRoot, file.path), file.bytes);
    }
    const input = { archiveRoot: f.input.archiveRoot, vaultRoot: f.input.vaultRoot,
      pdfRoot: join(f.root, 'absent-downloads'), exists: async () => true,
      rows: [{ base_id: '2601.00001', status: 'parsed', pdf_path: join(f.sources[0]!.root, 'source.pdf'), note_path: null },
        { base_id: 'candidate', status: 'discovered', pdf_path: null }] };
    const report = await reconcileLibraryArtifacts(input);
    assert.deepEqual(report.consistent, ['2601.00001']);
    assert.deepEqual(report.missingPdf, []);
    assert.deepEqual(report.rebuildNote, []);
    assert.deepEqual(report.retryWiki, []);
    assert.equal(report.evidence.valid, true);
    await rm(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/pages.md'));
    const broken = await reconcileLibraryArtifacts(input);
    assert.equal(broken.evidence.valid, false);
    assert.deepEqual(broken.consistent, []);
    assert.deepEqual(broken.rebuildNote, ['2601.00001']);
  } finally { await f.close(); }
});

test('absent download cache is empty but access failures are not suppressed', async () => {
  assert.deepEqual(await scanDuplicatePdfs('missing', { readDirectory: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), []);
  await assert.rejects(scanDuplicatePdfs('denied', { readDirectory: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); } }), { code: 'EACCES' });
});

test('derives retry work without moving or deleting classified PDFs', async () => {
  const existing = new Set(['paper/a.pdf', 'paper/b.pdf', 'notes/b.md', 'paper/c.pdf', 'notes/c.md']);
  const report = await reconcilePaperArtifacts({
    rows: [
      { base_id: 'a', status: 'downloaded', pdf_path: 'paper/a.pdf', note_path: null },
      { base_id: 'b', status: 'parsed', pdf_path: 'paper/b.pdf', note_path: 'notes/b.md' },
      { base_id: 'c', status: 'synthesized', pdf_path: 'paper/c.pdf', note_path: 'notes/c.md' },
      { base_id: 'd', status: 'parsed', pdf_path: 'paper/missing.pdf', note_path: 'notes/missing.md' },
    ],
    exists: async (path) => existing.has(path),
  });
  assert.deepEqual(report.retryParse, ['a']);
  assert.deepEqual(report.retryWiki, ['b']);
  assert.deepEqual(report.consistent, ['c']);
  assert.deepEqual(report.missingPdf, ['d']);
});

test('reports duplicate PDF hashes without deleting files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-duplicates-'));
  const first = join(root, '01-A', 'a.pdf');
  const second = join(root, '02-B', 'b.pdf');
  try {
    await mkdir(join(root, '01-A'), { recursive: true });
    await mkdir(join(root, '02-B'), { recursive: true });
    await writeFile(first, '%PDF-same');
    await writeFile(second, '%PDF-same');
    const duplicates = await scanDuplicatePdfs(root);
    assert.equal(duplicates.length, 1);
    assert.deepEqual(duplicates[0].paths.sort(), [first, second].sort());
    assert.equal(await readFile(first, 'utf8'), '%PDF-same');
    assert.equal(await readFile(second, 'utf8'), '%PDF-same');
  } finally { await removeOwnedTestDirectory(root); }
});

test('repair changes SQLite path before removing the registered duplicate', async () => {
  const events: string[][] = [];
  const hash = 'a'.repeat(64);
  const result = await repairDuplicatePdf('2608.23146', 'D:/paper/keep.pdf', {
    pdfRoot: 'D:/paper',
    store: {
      findByBaseId: () => ({ base_id: '2608.23146', pdf_path: 'D:/paper/remove.pdf', sha256: hash }),
      updatePdfPath: (_baseId, path) => events.push(['update', path]),
    },
    scanDuplicates: async () => [{ sha256: hash, paths: ['D:/paper/remove.pdf', 'D:/paper/keep.pdf'] }],
    hashFile: async () => hash,
    removeFile: async (path) => events.push(['remove', path]),
  });
  assert.deepEqual(events, [['update', 'D:/paper/keep.pdf'], ['remove', 'D:/paper/remove.pdf']]);
  assert.deepEqual(result.removedPaths, ['D:/paper/remove.pdf']);
});
