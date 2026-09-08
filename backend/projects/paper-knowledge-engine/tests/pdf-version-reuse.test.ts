import { removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';
import type { TestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { openStateStore } from '../src/library/state/state-store.ts';
import { createStateDatabase } from '../src/runtime/sqlite.ts';
import { downloadAcceptedPdf } from '../src/library/sources/pdf-store.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-version-'));
  const store = openStateStore(':memory:');
  t.after(async () => { store.close(); await removeOwnedTestDirectory(root); });
  const paper = { baseId: '2608.23146', arxivId: '2608.23146v1', version: 1, title: 'Paper', pdfUrl: 'https://example.test/paper.pdf' };
  const makePdf = async (title: string) => { const doc = await PDFDocument.create(); doc.setTitle(title); doc.addPage(); return Buffer.from(await doc.save()); };
  let body: Buffer = await makePdf('v1');
  let calls = 0;
  const options = { stateStore: store, pdfRoot: join(root, 'pdf'), tempRoot: join(root, 'tmp'), fetchImpl: async () => {
    calls++; return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => body };
  } };
  const download = (p = paper) => downloadAcceptedPdf({ accepted: true, primaryTrack: 'AI-FSD', paper: p }, options);
  store.upsertDiscovered(paper);
  const first = await download();
  return { store, paper, first, download, makePdf, setBody: (value: Buffer) => { body = value; }, calls: () => calls };
}

test('rediscovering v2 downloads v2 instead of relabelling the v1 PDF', async (t) => {
  const f = await fixture(t);
  const v2 = { ...f.paper, version: 2, arxivId: '2608.23146v2' };
  const body = await f.makePdf('v2'); f.setBody(body);
  f.store.upsertDiscovered(v2);
  const result = await f.download(v2);
  assert.equal(f.calls(), 2);
  assert.notEqual(result.pdfPath, f.first.pdfPath);
  assert.deepEqual(await readFile(result.pdfPath), body);
  assert.equal(f.store.findByBaseId(v2.baseId)?.downloaded_version, 2);
});

for (const damage of ['missing', 'modified']) {
  test(`a ${damage} cached PDF is downloaded again, not silently reused`, async (t) => {
    const f = await fixture(t);
    if (damage === 'missing') await rm(f.first.pdfPath);
    else await writeFile(f.first.pdfPath, 'corrupted');
    const result = await f.download();
    assert.equal(f.calls(), 2);
    assert.equal(result.pdfPath, f.first.pdfPath);
    assert.equal((await readFile(result.pdfPath)).subarray(0, 5).toString(), '%PDF-');
  });
}

test('verified same-version reuse does not download or create another file', async (t) => {
  const f = await fixture(t);
  f.store.upsertDiscovered(f.paper);
  const result = await f.download();
  assert.equal(f.calls(), 1);
  assert.equal(result.skipped, 'existing-version');
  assert.equal(result.pdfPath, f.first.pdfPath);
});

test('older rediscovery cannot downgrade latest metadata or the downloaded version', async (t) => {
  const f = await fixture(t);
  const v2 = { ...f.paper, version: 2, arxivId: '2608.23146v2', title: 'Updated' };
  f.store.upsertDiscovered(v2);
  f.store.upsertDiscovered(f.paper);
  const row = f.store.findByBaseId(f.paper.baseId);
  assert.ok(row); assert.equal(row.version, 2);
  assert.ok(row); assert.equal(row.title, 'Updated');
  assert.ok(row); assert.equal(row.downloaded_version, 1);
});

test('legacy migration derives PDF version from the filename, not already-updated metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-migrate-'));
  t.after(() => removeOwnedTestDirectory(root));
  const path = join(root, 'legacy.sqlite');
  const db = createStateDatabase(path);
  db.exec(await readFile(new URL('../migrations/001-initial.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO papers(base_id,version,title,pdf_path,sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('2608.23146', 2, 'Updated metadata', 'D:/paper/2608.23146v1_Paper.pdf', 'h', 'downloaded', 'now', 'now');
  db.close();
  for (let run = 0; run < 2; run++) {
    const store = openStateStore(path);
    try {
      const row = store.findByBaseId('2608.23146');
      assert.ok(row); assert.equal(row.version, 2);
      assert.ok(row); assert.equal(row.downloaded_version, 1);
      assert.ok(row); assert.equal(row.pdf_path, 'D:/paper/2608.23146v1_Paper.pdf');
    } finally { store.close(); }
  }
});

test('same bytes under a different paper ID reuse a verified file with a usable path', async (t) => {
  const f = await fixture(t);
  const other = { ...f.paper, baseId: '2608.23147', arxivId: '2608.23147v1' };
  f.store.upsertDiscovered(other);
  const result = await f.download(other);
  assert.equal(result.skipped, 'duplicate-content');
  assert.equal(result.pdfPath, f.first.pdfPath);
  assert.equal(result.duplicateOf, f.paper.baseId);
  assert.equal(f.store.findByBaseId(other.baseId)?.status, 'excluded');
});

test('an outdated request cannot overwrite a downloaded newer version', async (t) => {
  const f = await fixture(t);
  const v2 = { ...f.paper, version: 2, arxivId: '2608.23146v2' };
  f.store.upsertDiscovered(v2); f.setBody(await f.makePdf('v2'));
  const newer = await f.download(v2);
  await assert.rejects(f.download(f.paper), /旧版本|stale version/i);
  assert.equal(f.store.findByBaseId(f.paper.baseId)?.pdf_path, newer.pdfPath);
  assert.equal(f.store.findByBaseId(f.paper.baseId)?.downloaded_version, 2);
});

for (const damage of ['missing', 'modified']) {
  test(`identical new ID repairs the ${damage} canonical file without stealing its hash`, async (t) => {
    const f = await fixture(t);
    if (damage === 'missing') await rm(f.first.pdfPath);
    else await writeFile(f.first.pdfPath, 'broken');
    const other = { ...f.paper, baseId: '2608.23147', arxivId: '2608.23147v1' };
    f.store.upsertDiscovered(other);
    const result = await f.download(other);
    assert.equal(result.duplicateOf, f.paper.baseId);
    assert.equal((await readFile(f.first.pdfPath)).subarray(0, 5).toString(), '%PDF-');
    assert.equal(f.store.findByBaseId(other.baseId)?.status, 'excluded');
  });
}

test('download commit rejects a version superseded while the fetch was in flight', async (t) => {
  const f = await fixture(t);
  const v2 = { ...f.paper, version: 2, arxivId: '2608.23146v2' };
  f.store.upsertDiscovered(v2); f.setBody(await f.makePdf('v2'));
  const newer = await f.download(v2);
  assert.throws(() => f.store.markDownloaded(f.paper.baseId, f.first.pdfPath, 'AI-FSD', f.first.sha256, 1), /旧版本|stale version/i);
  assert.equal(f.store.findByBaseId(f.paper.baseId)?.pdf_path, newer.pdfPath);
});
