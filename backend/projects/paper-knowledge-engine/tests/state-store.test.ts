import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateDatabase } from '../src/runtime/sqlite.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openStateStore } from '../src/library/state/state-store.ts';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';

test('closed file store releases retained internal statements immediately', async () => {
  const fx = await makeRuntimeFixture();
  try {
    const path = join(fx.root, 'state.sqlite');
    const store = openStateStore(path);
    store.upsertDiscovered({ baseId: 'retained', version: 1 });
    assert.equal(present(store.findByBaseId('retained')).version, 1);
    store.close(); store.close();
    assert.throws(() => store.findByBaseId('retained'), /closed|finalized|not open/);
    const renamed = join(fx.root, 'renamed.sqlite');
    await rename(path, renamed);
    await unlink(renamed);
  } finally { await fx.dispose(); }
});

for (const failure of ['read migration', 'execute migration', 'prepare statements', 'backfill']) {
  test(`initialization failure releases the file: ${failure}`, async () => {
    const fx = await makeRuntimeFixture();
    try {
      const path = join(fx.root, 'failed.sqlite');
      const migration = join(fx.root, 'broken.sql');
      if (failure === 'execute migration') await writeFile(migration, 'CREATE TABLE x(n INTEGER); INVALID SQL;');
      if (failure === 'prepare statements') await writeFile(migration, 'CREATE TABLE papers(downloaded_version INTEGER);');
      if (failure === 'backfill') await writeFile(migration, "CREATE TABLE papers(base_id TEXT,pdf_path INTEGER); INSERT INTO papers VALUES('id',42);");
      assert.throws(() => openStateStore(path, [migration]));
      await unlink(path);
    } finally { await fx.dispose(); }
  });
}

test('state rows reject unsafe business integers before comparisons or JSON serialization', () => {
  const store = openStateStore(':memory:');
  try {
    store.upsertDiscovered({ baseId: 'large-version', version: 9007199254740993n });
    assert.throws(() => store.findByBaseId('large-version'), /version.*safe integer/i);
    assert.throws(() => store.exportManifest(), /version.*safe integer/i);
  } finally { store.close(); }
});

test('state reads reject malformed actual SELECT text and preserve null versus missing rows', async () => {
  const fx = await makeRuntimeFixture();
  try {
    const path = join(fx.root, 'loose.sqlite');
    const schema = join(fx.root, 'loose.sql');
    const migrations = ['001-initial.sql', '002-local-mineru.sql', '003-harvest-checkpoints.sql', '004-evidence-reviews.sql', '005-paper-source-metadata.sql'];
    const { readFile } = await import('node:fs/promises');
    const sql = (await Promise.all(migrations.map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')))).join('\n');
    await writeFile(schema, sql.replaceAll(') STRICT;', ');'));
    const store = openStateStore(path, [schema]);
    const raw = createStateDatabase(path);
    try {
      store.upsertDiscovered({ baseId: 'bad-text', version: 1 });
      assert.equal(present(store.findByBaseId('bad-text')).pdf_path, null);
      assert.equal(store.findByBaseId('absent'), undefined);
      raw.prepare('UPDATE papers SET title=? WHERE base_id=?').run(new Uint8Array([42]), 'bad-text');
      assert.throws(() => store.findByBaseId('bad-text'), /title.*text/);
      assert.throws(() => store.exportManifest(), /title.*text/);
      const run = store.startRun({ from: '2026-01-01', to: '2026-08-01' }, 'current');
      raw.prepare('UPDATE runs SET finished_at=? WHERE run_id=?').run(new Uint8Array([42]), run.id);
      assert.throws(() => store.getRun(run.id), /finished_at.*text/);
    } finally { raw.close(); store.close(); }
    await unlink(path);
  } finally { await fx.dispose(); }
});

test('harvest observation JSON rejects invalid metadata before merging', async () => {
  const fx = await makeRuntimeFixture();
  try {
    const path = join(fx.root, 'observations.sqlite');
    const store = openStateStore(path);
    const raw = createStateDatabase(path);
    try {
      const run = store.startRun({ from: '2026-01-01', to: '2026-08-01' }, 'current');
      const shard = { runId: run.id, shardKey: 'k', shardIndex: 1, totalShards: 1, track: 'A', dateMode: 'updated', query: 'all:test', categories: ['cs.SE'] };
      store.beginHarvestShard(shard);
      store.completeHarvestShard(shard, [{
        baseId: 'sample', arxivId: 'samplev1', version: 1, title: 'Sample',
        authors: ['Sample Author'], categories: ['cs.SE'],
        published: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z',
      }]);
      for (const metadata of ['[]', '{"baseId":42}', '{"baseId":"sample","version":"1"}']) {
        raw.prepare('UPDATE harvest_observations SET metadata_json=?').run(metadata);
        assert.throws(() => store.listHarvestObservations(run.id), /metadata_json/);
      }
    } finally { raw.close(); store.close(); }
  } finally { await fx.dispose(); }
});

test('deduplicates papers by base arXiv id and content hash', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.00001', version: 1, sha256: 'a'.repeat(64), status: 'discovered' });
  assert.equal(present(store.findByBaseId('2601.00001')).version, 1);
  assert.equal(present(store.findBySha256('a'.repeat(64))).base_id, '2601.00001');
  store.close();
});

test('source metadata is versioned and does not overwrite another arXiv version', () => {
  const store = openStateStore(':memory:');
  const v1 = {
    schemaVersion: 1 as const,
    baseId: '2608.23146',
    arxivId: '2608.23146v1',
    version: 1,
    title: 'Original title',
    authors: ['Nafiseh Soveizi'],
    categories: ['cs.SE'],
    published: '2026-08-24T11:52:33Z',
    updated: '2026-08-24T11:52:33Z',
  };
  const v2 = { ...v1, arxivId: '2608.23146v2', version: 2, title: 'Revised title', authors: ['Nafiseh Soveizi', 'Coauthor'] };
  try {
    store.upsertSourceMetadata(v1);
    store.upsertSourceMetadata(v2);
    assert.deepEqual(store.findSourceMetadata(v1.baseId, 1)?.authors, v1.authors);
    assert.deepEqual(store.findSourceMetadata(v1.baseId, 2)?.authors, v2.authors);
  } finally {
    store.close();
  }
});

test('rediscovery does not downgrade a processed paper', () => {
  const store = openStateStore(':memory:');
  const pdfPath = 'D:\\paper\\2601.00003.pdf';
  store.upsertDiscovered({ baseId: '2601.00003', version: 1, status: 'discovered' });
  store.markDownloaded('2601.00003', pdfPath, 'AI-FSD', 'c'.repeat(64));
  store.markParsedStatus('2601.00003');

  store.upsertDiscovered({ baseId: '2601.00003', version: 1, status: 'discovered' });

  const paper = store.findByBaseId('2601.00003');
  assert.ok(paper);
  assert.equal(paper.status, 'parsed');
  assert.equal(paper.pdf_path, pdfPath);
  store.close();
});


test('keeps configured model attempts distinct and retries failures', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.1', arxivId: '2601.1v1', version: 1, status: 'downloaded' });
  const identity = { baseId: '2601.1', version: 1, sha256: 'a'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto' };
  const pipeline = store.reserveParseAttempt(identity);
  assert.ok(pipeline);
  assert.equal(store.reserveParseAttempt(identity), null);
  store.failParseAttempt(pipeline.attemptId, { errorClass: 'timeout', errorMessage: 'timed out' });
  assert.notEqual(present(store.reserveParseAttempt(identity)).attemptId, pipeline.attemptId);
  const vlm = store.reserveParseAttempt({ ...identity, model: 'vlm', cliBackend: 'vlm-engine' });
  assert.ok(vlm);
  assert.notEqual(vlm.attemptId, pipeline.attemptId);
  store.close();
});

test('finds the successful attempt for the requested config model', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.2', arxivId: '2601.2v1', version: 1, status: 'downloaded' });
  const common = { baseId: '2601.2', version: 1, sha256: 'b'.repeat(64), method: 'auto' };
  const pipeline = store.reserveParseAttempt({ ...common, model: 'pipeline', cliBackend: 'pipeline' });
  assert.ok(pipeline);
  store.finishParseAttempt(pipeline.attemptId, { markdownPath: 'p.md', contentListPath: 'p.json', pageTextPath: 'pages.txt', pageCount: 8, elapsedMs: 10 });
  const vlm = store.reserveParseAttempt({ ...common, model: 'vlm', cliBackend: 'vlm-engine' });
  assert.ok(vlm);
  store.failParseAttempt(vlm.attemptId, { errorClass: 'cuda_oom', errorMessage: 'out of memory' });
  assert.equal(present(store.findSuccessfulParse('2601.2', 'pipeline')).model, 'pipeline');
  assert.equal(store.findSuccessfulParse('2601.2', 'vlm'), undefined);
  store.close();
});

test('supports forced reparses, successful lookups, and single migration callers', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.3', arxivId: '2601.3v1', version: 1, status: 'parsed' });
  const identity = { baseId: '2601.3', version: 1, sha256: 'c'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto' };
  const first = store.reserveParseAttempt(identity);
  assert.ok(first);
  store.finishParseAttempt(first.attemptId, { markdownPath: 'first.md' });
  assert.equal(store.reserveParseAttempt(identity), null);
  const forced = store.reserveParseAttempt(identity, { force: true });
  assert.ok(forced);
  assert.notEqual(forced.attemptId, first.attemptId);
  assert.equal(present(store.findParseAttempt(identity)).status, 'pending');
  store.failParseAttempt(forced.attemptId, {
    errorClass: 'process_error',
    errorMessage: 'Bearer secret at https://example.test/private',
  });
  assert.equal(present(store.findParseAttempt(identity)).status, 'failed');
  assert.equal(present(store.findParseAttempt(identity)).errorMessage, 'Bearer [redacted] at [redacted-url]');
  assert.equal(present(store.findSuccessfulParse('2601.3', 'pipeline')).markdownPath, 'first.md');
  assert.equal(store.hasSuccessfulParse('2601.3'), true);
  store.close();

  const initialMigration = fileURLToPath(new URL('../migrations/001-initial.sql', import.meta.url));
  const legacyStore = openStateStore(':memory:', initialMigration);
  legacyStore.upsertDiscovered({ baseId: '2601.4', version: 1, status: 'discovered' });
  assert.equal(present(legacyStore.findByBaseId('2601.4')).status, 'discovered');
  legacyStore.close();
});

test('preserves reserved provenance when finishing with normalized artifacts', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.5', arxivId: '2601.5v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.5',
    version: 1,
    sha256: 'd'.repeat(64),
    model: 'pipeline',
    cliBackend: 'pipeline',
    method: 'auto',
    sourcePath: 'D:/papers/2601.5.pdf',
    outputDir: 'D:/state/extracted/2601.5/pipeline',
  });
  assert.ok(attempt);
  store.finishParseAttempt(attempt.attemptId, {
    rawOutputDir: 'D:/state/extracted/2601.5/pipeline',
    normalizedDir: 'D:/state/extracted/2601.5/pipeline/normalized',
    markdownPath: 'normalized/full.md',
  });
  const result = store.findParseAttempt({
    baseId: '2601.5',
    version: 1,
    sha256: 'd'.repeat(64),
    model: 'pipeline',
    method: 'auto',
  });
  assert.ok(result);
  assert.equal(result.sourcePath, 'D:/papers/2601.5.pdf');
  assert.equal(result.outputDir, 'D:/state/extracted/2601.5/pipeline');

  const forced = store.reserveParseAttempt({
    baseId: '2601.5',
    version: 1,
    sha256: 'd'.repeat(64),
    model: 'pipeline',
    cliBackend: 'pipeline',
    method: 'auto',
    sourcePath: 'D:/papers/2601.5.pdf',
    outputDir: 'D:/state/extracted/2601.5/pipeline',
  }, { force: true });
  assert.ok(forced);
  store.finishParseAttempt(forced.attemptId, {
    sourcePath: 'D:/papers/2601.5-override.pdf',
    outputDir: 'D:/state/extracted/override',
    markdownPath: 'normalized/full.md',
  });
  const overridden = store.findParseAttempt({
    baseId: '2601.5',
    version: 1,
    sha256: 'd'.repeat(64),
    model: 'pipeline',
    method: 'auto',
  });
  assert.ok(overridden);
  assert.equal(overridden.sourcePath, 'D:/papers/2601.5-override.pdf');
  assert.equal(overridden.outputDir, 'D:/state/extracted/override');
});

test('Archive PDF adoption rolls back with failed attempt completion and rejects mismatched paths', async () => {
  const fx = await makeRuntimeFixture();
  const path = join(fx.root, 'atomic-adoption.sqlite');
  const store = openStateStore(path);
  const raw = createStateDatabase(path);
  const baseId = '2601.00009';
  const sha256 = 'a'.repeat(64);
  const download = join(fx.root, 'download.pdf');
  const outputDir = join(fx.root, 'archive', `${baseId}-v1`);
  const permanent = join(outputDir, 'source.pdf');
  try {
    store.upsertDiscovered({ baseId, version: 1 });
    store.markDownloaded(baseId, download, 'AI-FSD', sha256, 1);
    const attempt = store.reserveParseAttempt({ baseId, version: 1, sha256, model: 'pipeline', cliBackend: 'pipeline', sourcePath: download });
    assert.ok(attempt);
    assert.throws(() => store.finishParseAttempt(attempt.attemptId, { outputDir, sourcePath: download, archivePdfPath: permanent }), /Archive PDF identity/);
    raw.exec("CREATE TRIGGER reject_finish BEFORE UPDATE OF status ON parse_attempts WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'completion rejected'); END");
    assert.throws(() => store.finishParseAttempt(attempt.attemptId, { outputDir, sourcePath: permanent, archivePdfPath: permanent }), /completion rejected/);
    assert.equal(store.findByBaseId(baseId)?.pdf_path, download);
    assert.equal(store.findByBaseId(baseId)?.status, 'downloaded');
    assert.equal(store.findParseAttempt({ baseId, version: 1, sha256, model: 'pipeline' })?.status, 'pending');
    raw.exec('DROP TRIGGER reject_finish');
    store.upsertDiscovered({ baseId, version: 2 });
    assert.throws(() => store.finishParseAttempt(attempt.attemptId, { outputDir, sourcePath: permanent, archivePdfPath: permanent }), /superseded/);
    assert.equal(store.findByBaseId(baseId)?.pdf_path, download);
  } finally { raw.close(); store.close(); await fx.dispose(); }
});


test('redacts escaped and nested JSON credentials from parse failures', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.7', arxivId: '2601.7v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.7',
    version: 1,
    sha256: 'f'.repeat(64),
    model: 'vlm',
    cliBackend: 'vlm-engine',
    method: 'auto',
  });
  assert.ok(attempt);
  store.failParseAttempt(attempt.attemptId, {
    errorClass: 'process_error',
    errorMessage: 'MINERU_TOOLS_CONFIG_JSON="{\\"secret_key\\":\\"supersecret\\",\\"nested\\":{\\"api_key\\":\\"nested-secret\\"}}" plain {"secret_key":"plain-super"}',
  });
  const result = store.findParseAttempt({
    baseId: '2601.7',
    version: 1,
    sha256: 'f'.repeat(64),
    model: 'vlm',
    method: 'auto',
  });
  assert.ok(result);
  assert.doesNotMatch(present(result.errorMessage), /supersecret|nested-secret|plain-super/);
  store.close();
});
test('redacts credentials from parse failure messages', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.6', arxivId: '2601.6v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.6',
    version: 1,
    sha256: 'e'.repeat(64),
    model: 'vlm',
    cliBackend: 'vlm-engine',
    method: 'auto',
  });
  assert.ok(attempt);
  store.failParseAttempt(attempt.attemptId, {
    errorClass: 'process_error',
    errorMessage: 'token=supersecret password=hunter2 api-key=apikey123 MINERU_TOOLS_CONFIG_JSON={"api_key":"configsecret"} proxy_password=proxysecret',
  });
  const result = store.findParseAttempt({
    baseId: '2601.6',
    version: 1,
    sha256: 'e'.repeat(64),
    model: 'vlm',
    method: 'auto',
  });
  assert.ok(result);
  assert.doesNotMatch(present(result.errorMessage), /supersecret|hunter2|apikey123|configsecret|proxysecret/);
  store.close();
});
test('reclaims stale active attempts and scopes successful identity to version hash model and method', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.resume', version: 1, sha256: 'a'.repeat(64), status: 'downloaded' });
  const identity = { baseId: '2601.resume', version: 1, sha256: 'a'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto' };
  const first = store.reserveParseAttempt(identity, { startedAt: '2000-01-01T00:00:00.000Z' });
  assert.ok(first);
  const reclaimed = store.reserveParseAttempt(identity, { staleAfterMs: 1 });
  assert.ok(reclaimed);
  store.finishParseAttempt(reclaimed.attemptId, { markdownPath: 'v1.md' });
  assert.equal(present(store.findSuccessfulParse({ ...identity })).markdownPath, 'v1.md');
  assert.equal(store.findSuccessfulParse({ ...identity, version: 2 }), undefined);
  assert.equal(store.findSuccessfulParse({ ...identity, sha256: 'b'.repeat(64) }), undefined);
  assert.equal(store.findSuccessfulParse({ ...identity, model: 'vlm' }), undefined);
  assert.equal(store.findSuccessfulParse({ ...identity, method: 'ocr' }), undefined);
  store.close();
});

test('redacts namespaced credentials with punctuation in unquoted values', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.8', arxivId: '2601.8v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.8',
    version: 1,
    sha256: '0'.repeat(64),
    model: 'pipeline',
    cliBackend: 'pipeline',
    method: 'auto',
  });
  assert.ok(attempt);
  store.failParseAttempt(attempt.attemptId, {
    errorMessage: 'MINERU_API_KEY=comma-secret,comma-tail token=semi-secret;semi-tail namespace.secret_key=brace-secret}',
  });
  const result = store.findParseAttempt({
    baseId: '2601.8',
    version: 1,
    sha256: '0'.repeat(64),
    model: 'pipeline',
    method: 'auto',
  });
  assert.ok(result);
  assert.doesNotMatch(present(result.errorMessage), /comma-secret|comma-tail|semi-secret|semi-tail|brace-secret/);
  store.close();
});
test('redacts Authorization values and direct config JSON values', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.9', arxivId: '2601.9v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.9', version: 1, sha256: '9'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto',
  });
  assert.ok(attempt);
  store.failParseAttempt(attempt.attemptId, {
    errorMessage: 'Authorization: basic-secret config={"host":"internal","nested":{"password":"nested-secret"}} "config": "{\\"host\\":\\"escaped-internal\\"}"',
  });
  const result = store.findParseAttempt({
    baseId: '2601.9', version: 1, sha256: '9'.repeat(64), model: 'pipeline', method: 'auto',
  });
  assert.ok(result);
  assert.doesNotMatch(present(result.errorMessage), /basic-secret|internal|nested-secret/);
  store.close();
});
test('redacts the complete nested direct config value', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.12', arxivId: '2601.12v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.12', version: 1, sha256: '2'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto',
  });
  assert.ok(attempt);
  store.failParseAttempt(attempt.attemptId, {
    errorMessage: 'config={"nested":{"safe":"x"},"host":"internal"} trailing',
  });
  const result = store.findParseAttempt({
    baseId: '2601.12', version: 1, sha256: '2'.repeat(64), model: 'pipeline', method: 'auto',
  });
  assert.ok(result);
  assert.doesNotMatch(present(result.errorMessage), /safe|internal/);
  store.close();
});
test('redacts config assignments after arbitrary delimiters without matching identifier substrings', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.13', arxivId: '2601.13v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.13', version: 1, sha256: '3'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto',
  });
  assert.ok(attempt);
  store.failParseAttempt(attempt.attemptId, {
    errorMessage: '{"config":{"host":"internal"}} (config={"host":"paren"}) error:config={"host":"colon"} myconfig={"host":"identifier"}',
  });
  const result = store.findParseAttempt({
    baseId: '2601.13', version: 1, sha256: '3'.repeat(64), model: 'pipeline', method: 'auto',
  });
  assert.ok(result);
  assert.doesNotMatch(present(result.errorMessage), /internal|paren|colon/);
  assert.match(present(result.errorMessage), /myconfig=\{"host":"identifier"\}/);
  store.close();
});

test('redacts escaped quoted config values through the escaped closing quote', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.14', arxivId: '2601.14v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.14', version: 1, sha256: '4'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto',
  });
  assert.ok(attempt);
  store.failParseAttempt(attempt.attemptId, {
    errorMessage: String.raw`config=\"{\"host\": \"escaped-internal\"}\" trailing`,
  });
  const result = store.findParseAttempt({
    baseId: '2601.14', version: 1, sha256: '4'.repeat(64), model: 'pipeline', method: 'auto',
  });
  assert.ok(result);
  assert.doesNotMatch(present(result.errorMessage), /escaped-internal/);
  store.close();
});
test('consumes escaped array config values without leaking array contents', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.15', arxivId: '2601.15v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.15', version: 1, sha256: '5'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto',
  });
  assert.ok(attempt);
  store.failParseAttempt(attempt.attemptId, { errorMessage: String.raw`config=\"[\"array-secret\"]\" trailing` });
  const result = store.findParseAttempt({ baseId: '2601.15', version: 1, sha256: '5'.repeat(64), model: 'pipeline', method: 'auto' });
  assert.ok(result);
  assert.doesNotMatch(present(result.errorMessage), /array-secret/);
  store.close();
});

test('consumes escaped nested object-array config values and braces in JSON strings', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.16', arxivId: '2601.16v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.16', version: 1, sha256: '6'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto',
  });
  assert.ok(attempt);
  store.failParseAttempt(attempt.attemptId, {
    errorMessage: String.raw`config=\"{\"nested\":[\"array-secret\"],\"message\":\"literal } brace\"}\" trailing`,
  });
  const result = store.findParseAttempt({ baseId: '2601.16', version: 1, sha256: '6'.repeat(64), model: 'pipeline', method: 'auto' });
  assert.ok(result);
  assert.doesNotMatch(present(result.errorMessage), /array-secret|literal \} brace/);
  store.close();
});
test('redacts escaped config JSON with escaped quotes and braces through all subsequent fields', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.17', arxivId: '2601.17v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.17', version: 1, sha256: '7'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto',
  });
  assert.ok(attempt);
  store.failParseAttempt(attempt.attemptId, {
    errorMessage: String.raw`config=\"{\"message\":\"escaped quote: \\\" and literal } brace\",\"safe_after\":\"leak-marker\",\"api_key\":\"secret\"}\" trailing`,
  });
  const result = store.findParseAttempt({ baseId: '2601.17', version: 1, sha256: '7'.repeat(64), model: 'pipeline', method: 'auto' });
  assert.ok(result);
  assert.doesNotMatch(present(result.errorMessage), /escaped quote|literal \} brace|leak-marker|secret/);
  store.close();
});
test('redacts escaped config with five-backslash outer close and trailing fields', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.18', arxivId: '2601.18v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.18', version: 1, sha256: '8'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto',
  });
  assert.ok(attempt);
  const errorMessage = String.raw`config=\"{\"message\":\"literal } ends __FIVE__,\"safe_after\":\"five-leak-marker\",\"api_key\":\"five-secret\"}\" trailing`
    .replace('__FIVE__', `${'\\'.repeat(5)}"`);
  store.failParseAttempt(attempt.attemptId, { errorMessage });
  const result = store.findParseAttempt({ baseId: '2601.18', version: 1, sha256: '8'.repeat(64), model: 'pipeline', method: 'auto' });
  assert.ok(result);
  assert.doesNotMatch(present(result.errorMessage), /escaped quote|literal \} brace|five-leak-marker|five-secret/);
  assert.equal(result.errorMessage, 'config=[redacted] trailing');
  store.close();
});
test('redacts escaped config after ordinary backslash text without swallowing trailing output', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.20', arxivId: '2601.20v1', version: 1, status: 'downloaded' });
  const attempt = store.reserveParseAttempt({
    baseId: '2601.20', version: 1, sha256: '9'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto',
  });
  assert.ok(attempt);
  const errorMessage = String.raw`config=\"{\"message\":\"line\\nnext } still\",\"safe_after\":\"newline-leak\",\"api_key\":\"newline-secret\"}\" trailing`;
  store.failParseAttempt(attempt.attemptId, { errorMessage });
  const result = store.findParseAttempt({ baseId: '2601.20', version: 1, sha256: '9'.repeat(64), model: 'pipeline', method: 'auto' });
  assert.ok(result);
  assert.equal(result.errorMessage, 'config=[redacted] trailing');
  assert.doesNotMatch(present(result.errorMessage), /line|newline-leak|newline-secret/);
  store.close();
});

test('does not let an older local run overwrite a newer last_success watermark', () => {
  const store = openStateStore(':memory:');
  const older = store.startRun({ from: '2026-02-01T00:00:00Z', to: '2026-02-02T00:00:00Z' }, 'weekly');
  const newer = store.startRun({ from: '2026-02-03T00:00:00Z', to: '2026-02-04T00:00:00Z' }, 'weekly');
  store.recordLocalParseManifest(newer.id, { jobs: [] });
  store.recordLocalParseManifest(older.id, { jobs: [] });
  store.completeRun(newer.id, 'running', '2026-02-04T00:00:00Z');
  store.completeRun(older.id, 'running', '2026-02-02T00:00:00Z');
  assert.equal(store.getLastSuccess(), '2026-02-04T00:00:00Z');
  store.close();
});

test('does not complete an unknown, running, failed, or completed local run', () => {
  const store = openStateStore(':memory:');
  const success = { status: 'succeeded', lastSuccess: '2026-02-05T00:00:00Z' };
  assert.throws(() => store.completeRun('missing', 'awaiting_local_parse', success.lastSuccess), /eligible|unknown|local run/);
  const running = store.startRun({ from: '2026-02-05T00:00:00Z', to: '2026-02-06T00:00:00Z' }, 'weekly');
  assert.throws(() => store.completeRun(running.id, 'awaiting_local_parse', success.lastSuccess), /eligible|running|local run/);
  store.failRun(running.id, 'parse failed');
  assert.throws(() => store.completeRun(running.id, 'awaiting_local_parse', success.lastSuccess), /eligible|failed|local run/);
  assert.equal(store.getLastSuccess(), null);
  store.close();
});
test('rejects invalid direct completion watermarks', () => {
  const store = openStateStore(':memory:');
  const run = store.startRun({ from: '2026-02-06T00:00:00Z', to: '2026-02-07T00:00:00Z' }, 'weekly');
  store.recordLocalParseManifest(run.id, { jobs: [] });
  assert.throws(() => store.completeRun(run.id, 'awaiting_local_parse', 'not-a-date'), /watermark|last_success|invalid/i);
  store.close();
});
test('parse attempt transitions from pending to running before completion', () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.lifecycle', version: 1, sha256: 'l'.repeat(64), status: 'downloaded' });
  const attempt = store.reserveParseAttempt({ baseId: '2601.lifecycle', version: 1, sha256: 'l'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto' });
  assert.ok(attempt);
  assert.equal(attempt.status, 'pending');
  assert.equal(present(store.startParseAttempt(attempt.attemptId)).status, 'running');
  store.failParseAttempt(attempt.attemptId, { errorClass: 'process_error' });
  assert.equal(present(store.findParseAttempt({ ...attempt, baseId: '2601.lifecycle' })).status, 'failed');
  store.close();
});

test('empty weekly run completes directly from running', () => {
  const store = openStateStore(':memory:');
  try {
    const run = store.startRun({ from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z' }, 'weekly');
    store.completeEmptyRun(run.id, '2026-08-02T00:00:00Z');
    assert.equal(present(store.getRun(run.id)).status, 'completed');
    assert.equal(store.getLastSuccess(), '2026-08-02T00:00:00Z');
  } finally { store.close(); }
});

test('completed same-window replay reuses the run row', () => {
  const store = openStateStore(':memory:');
  const window = { from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z' };
  try {
    const first = store.startRun(window, 'current');
    store.completeEmptyRun(first.id, window.to);
    const replay = store.startRun(window, 'current');
    assert.equal(replay.id, first.id);
    assert.equal(replay.status, 'completed');
    assert.equal(replay.replayed, true);
  } finally { store.close(); }
});

test('commits observations and paper metadata with the shard', () => {
  const store = openStateStore(':memory:');
  const window = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' };
  try {
    const run = store.startRun(window, 'current');
    assert.equal(store.beginHarvestShard({
      runId: run.id,
      shardKey: 'key-a',
      shardIndex: 1,
      totalShards: 16,
      track: 'AI-FSD',
      dateMode: 'submitted',
      query: 'all:test',
      categories: ['cs.SE'],
    }), true);
    const paper = {
      baseId: '2608.1',
      arxivId: '2608.1v1',
      version: 1,
      title: 'Paper',
      summary: 'Transactional checkpoints',
      authors: ['Nafiseh Soveizi'],
      published: '2026-08-20T00:00:00Z',
      updated: '2026-08-21T00:00:00Z',
      categories: ['cs.SE'],
      pdfUrl: 'https://arxiv.org/pdf/2608.1',
    };

    assert.equal(store.completeHarvestShard({ runId: run.id, shardKey: 'key-a' }, [paper]), undefined);
    assert.deepEqual(store.listCompletedHarvestShardKeys(run.id), ['key-a']);
    assert.deepEqual(store.listHarvestObservations(run.id), [{
      track: 'AI-FSD',
      dateMode: 'submitted',
      paper,
    }]);
    assert.equal(present(store.findByBaseId('2608.1')).status, 'discovered');
    assert.equal(present(store.findByBaseId('2608.1')).title, 'Paper');
    assert.deepEqual(store.findSourceMetadata('2608.1', 1), {
      schemaVersion: 1,
      baseId: '2608.1',
      arxivId: '2608.1v1',
      version: 1,
      title: 'Paper',
      authors: ['Nafiseh Soveizi'],
      categories: ['cs.SE'],
      published: '2026-08-20T00:00:00Z',
      updated: '2026-08-21T00:00:00Z',
    });
  } finally { store.close(); }
});

test('direct shard completion rejects incomplete harvested source metadata', () => {
  const store = openStateStore(':memory:');
  try {
    const run = store.startRun({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' }, 'current');
    const shard = {
      runId: run.id, shardKey: 'metadata-required', shardIndex: 1, totalShards: 1,
      track: 'AI-FSD', dateMode: 'submitted' as const, query: 'all:test', categories: ['cs.SE'],
    };
    store.beginHarvestShard(shard);
    assert.throws(() => store.completeHarvestShard(shard, [{
      baseId: '2608.incomplete', arxivId: '2608.incompletev1', version: 1,
      title: 'Incomplete source', authors: [], categories: ['cs.SE'],
      published: '2026-08-20T00:00:00Z', updated: '2026-08-21T00:00:00Z',
    }]), /source metadata.*authors/i);
    assert.deepEqual(store.listCompletedHarvestShardKeys(run.id), []);
    assert.deepEqual(store.listHarvestObservations(run.id), []);
    assert.equal(store.findSourceMetadata('2608.incomplete', 1), undefined);
  } finally { store.close(); }
});

test('rolls back every observation and paper write when shard completion fails', () => {
  const store = openStateStore(':memory:');
  const window = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' };
  try {
    const run = store.startRun(window, 'current');
    const identity = { runId: run.id, shardKey: 'key-rollback' };
    store.beginHarvestShard({
      ...identity,
      shardIndex: 1,
      totalShards: 1,
      track: 'AI-FSD',
      dateMode: 'updated',
      query: 'all:test',
      categories: ['cs.SE'],
    });
    store.upsertDiscovered({
      baseId: '2608.existing',
      arxivId: '2608.conflictv1',
      version: 1,
      title: 'Existing',
    });

    assert.throws(() => store.completeHarvestShard(identity, [{
      baseId: '2608.rollback-a', arxivId: '2608.conflictv1', version: 1, title: 'Conflicting',
      authors: ['Conflict Author'], categories: ['cs.SE'],
      published: '2026-08-20T00:00:00Z', updated: '2026-08-21T00:00:00Z',
    }]));
    assert.deepEqual(store.listCompletedHarvestShardKeys(run.id), []);
    assert.deepEqual(store.listHarvestObservations(run.id), []);
    assert.equal(store.findByBaseId('2608.rollback-a'), undefined);
    assert.equal(present(store.findByBaseId('2608.existing')).title, 'Existing');

    store.completeHarvestShard(identity, []);
    assert.deepEqual(store.listCompletedHarvestShardKeys(run.id), ['key-rollback']);
  } finally { store.close(); }
});

test('retries failed shards but never restarts or recompletes completed shards', () => {
  const store = openStateStore(':memory:');
  const window = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' };
  try {
    const run = store.startRun(window, 'current');
    const shard = {
      runId: run.id,
      shardKey: 'key-retry',
      shardIndex: 2,
      totalShards: 16,
      track: 'LLM-Wiki',
      dateMode: 'updated',
      query: 'all:wiki',
      categories: ['cs.CL', 'cs.SE'],
    };
    const identity = { runId: run.id, shardKey: shard.shardKey };

    assert.equal(store.beginHarvestShard(shard), true);
    assert.equal(store.failHarvestShard(identity, new Error('temporary failure')), undefined);
    assert.equal(store.beginHarvestShard(shard), true);
    store.completeHarvestShard(identity, []);
    assert.equal(store.beginHarvestShard(shard), false);
    assert.throws(() => store.completeHarvestShard(identity, []), /running/i);
  } finally { store.close(); }
});

test('persists arXiv capacity cooldowns and blocks restart before retry_not_before', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fsd-arxiv-cooldown-'));
  const databasePath = join(directory, 'state.sqlite');
  const retryNotBefore = '2999-09-04T00:15:00.000Z';
  const window = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' };
  const shard = {
    runId: '', shardKey: 'key-capacity', shardIndex: 1, totalShards: 1,
    track: 'AI-FSD', dateMode: 'submitted', query: 'all:test', categories: ['cs.SE'],
  };
  let first: ReturnType<typeof openStateStore> | undefined;
  let second: ReturnType<typeof openStateStore> | undefined;
  try {
    first = openStateStore(databasePath);
    const run = first.startRun(window, 'current');
    shard.runId = run.id;
    assert.equal(first.beginHarvestShard(shard), true);
    first.failHarvestShard(
      { runId: run.id, shardKey: shard.shardKey },
      Object.assign(new Error('arXiv system capacity is unavailable'), {
        code: 'ARXIV_CAPACITY_LIMITED', retryNotBefore,
        diagnostic: 'body=Rate exceeded.; server=envoy',
      }),
    );
    first.close();
    first = undefined;

    second = openStateStore(databasePath);
    assert.throws(() => second?.beginHarvestShard(shard), (caught: unknown) => {
      const error = caught as Error & { code?: string; retryNotBefore?: string; diagnostic?: string };
      assert.equal(error.code, 'ARXIV_COOLDOWN_ACTIVE');
      assert.equal(error.retryNotBefore, retryNotBefore);
      assert.equal(error.diagnostic, 'body=Rate exceeded.; server=envoy');
      return true;
    });
  } finally {
    try { second?.close(); } catch {}
    try { first?.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restarts an arXiv capacity-limited shard after its cooldown expires', () => {
  const store = openStateStore(':memory:');
  try {
    const run = store.startRun({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' }, 'current');
    const shard = {
      runId: run.id, shardKey: 'key-expired-capacity', shardIndex: 1, totalShards: 1,
      track: 'AI-FSD', dateMode: 'submitted', query: 'all:test', categories: ['cs.SE'],
    };
    assert.equal(store.beginHarvestShard(shard), true);
    store.failHarvestShard(
      { runId: run.id, shardKey: shard.shardKey },
      Object.assign(new Error('arXiv system capacity is unavailable'), {
        code: 'ARXIV_CAPACITY_LIMITED', retryNotBefore: '2000-01-01T00:00:00.000Z',
      }),
    );
    assert.equal(store.beginHarvestShard(shard), true);
  } finally { store.close(); }
});

test('redacts shard failures and applies migration 003 idempotently', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fsd-checkpoint-'));
  const databasePath = join(directory, 'state.sqlite');
  const window = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' };
  let first;
  let second;
  let db;
  try {
    first = openStateStore(databasePath);
    const run = first.startRun(window, 'current');
    const identity = { runId: run.id, shardKey: 'key-secret' };
    first.beginHarvestShard({
      ...identity,
      shardIndex: 1,
      totalShards: 1,
      track: 'AI-FSD',
      dateMode: 'submitted',
      query: 'all:test',
      categories: ['cs.SE'],
    });
    first.failHarvestShard(identity, new Error('Bearer token-secret at https://example.test/private'));
    first.close();
    first = undefined;

    second = openStateStore(databasePath);
    second.close();
    second = undefined;
    db = createStateDatabase(databasePath);
    const row = db.prepare('SELECT status,error_message FROM harvest_shards WHERE run_id=? AND shard_key=?')
      .get(run.id, identity.shardKey);
    db.close();
    db = undefined;
    assert.ok(row);
    assert.equal(row.status, 'failed');
    assert.equal(row.error_message, 'Bearer [redacted] at [redacted-url]');
    assert.doesNotMatch(textValue(row.error_message), /token-secret|example\.test/);
  } finally {
    try { db?.close(); } catch {}
    try { second?.close(); } catch {}
    try { first?.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test('redacts encoded transport payloads before persisting shard failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fsd-checkpoint-encoded-'));
  const databasePath = join(directory, 'state.sqlite');
  const encodedPayload = 'ZmFrZS1zZWNyZXQ=';
  let store;
  let db;
  try {
    store = openStateStore(databasePath);
    const run = store.startRun({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-30T00:00:00.000Z',
    }, 'current');
    const identity = { runId: run.id, shardKey: 'key-encoded-command' };
    store.beginHarvestShard({
      ...identity,
      shardIndex: 1,
      totalShards: 1,
      track: 'AI-FSD',
      dateMode: 'submitted',
      query: 'all:test',
      categories: ['cs.SE'],
    });
    store.failHarvestShard(identity, new Error(
      `request failed: bun -EncodedCommand ${encodedPayload} after retry`,
    ));
    store.close();
    store = undefined;

    db = createStateDatabase(databasePath);
    const row = db.prepare('SELECT error_message FROM harvest_shards WHERE run_id=? AND shard_key=?')
      .get(run.id, identity.shardKey);
    db.close();
    db = undefined;

    assert.ok(row);
    assert.equal(
      row.error_message,
      'request failed: bun -EncodedCommand [redacted] after retry',
    );
    assert.doesNotMatch(textValue(row.error_message), /ZmFrZS1zZWNyZXQ=|-EncodedCommand\s+ZmFrZS1zZWNyZXQ=/);
  } finally {
    try { db?.close(); } catch {}
    try { store?.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test('excluding an older candidate cannot overwrite a newer parsed version', () => {
  const store = openStateStore(':memory:');
  try {
    const old = { baseId: '2608.10001', arxivId: '2608.10001v1', version: 1, title: 'Old candidate' };
    store.upsertDiscovered(old);
    store.upsertDiscovered({ ...old, version: 2, arxivId: `${old.baseId}v2` });
    store.markDownloaded(old.baseId, 'D:\\paper\\2608.10001v2.pdf', null, 'a'.repeat(64), 2);
    store.markParsedStatus(old.baseId);
    store.upsertDiscovered(old);
    store.markExcluded(old.baseId, 'old version is out of scope', old.version);
    assert.equal(present(store.findByBaseId(old.baseId)).version, 2);
    assert.equal(present(store.findByBaseId(old.baseId)).status, 'parsed');
    store.markExcluded(old.baseId, 'current version is out of scope', 2);
    assert.equal(present(store.findByBaseId(old.baseId)).status, 'excluded');
  } finally { store.close(); }
});

test('same-version rediscovery preserves a permanent PDF exclusion until a newer version appears', () => {
  const store = openStateStore(':memory:');
  try {
    const paper = { baseId: '2604.05013', arxivId: '2604.05013v2', version: 2, title: 'Withdrawn paper' };
    store.upsertDiscovered(paper);
    store.markExcluded(paper.baseId, 'pdf-unavailable:404', paper.version);
    store.upsertDiscovered(paper);
    assert.equal(present(store.findByBaseId(paper.baseId)).status, 'excluded');

    store.upsertDiscovered({ ...paper, arxivId: '2604.05013v3', version: 3 });
    assert.equal(present(store.findByBaseId(paper.baseId)).status, 'discovered');
    assert.equal(present(store.findByBaseId(paper.baseId)).version, 3);
  } finally { store.close(); }
});

test('finds only the newest failed run that has harvest shards', () => {
  const store = openStateStore(':memory:');
  try {
    const older = store.startRun({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' }, 'current');
    store.beginHarvestShard({
      runId: older.id,
      shardKey: 'key-old',
      shardIndex: 1,
      totalShards: 1,
      track: 'AI-FSD',
      dateMode: 'submitted',
      query: 'all:old',
      categories: ['cs.SE'],
    });
    store.failRun(older.id, 'failed');

    const newestWithoutShards = store.startRun({ from: '2026-08-03T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z' }, 'current');
    store.failRun(newestWithoutShards.id, 'failed');
    const otherKind = store.startRun({ from: '2026-08-05T00:00:00.000Z', to: '2026-08-06T00:00:00.000Z' }, 'weekly');
    store.beginHarvestShard({
      runId: otherKind.id,
      shardKey: 'key-weekly',
      shardIndex: 1,
      totalShards: 1,
      track: 'AI-FSD',
      dateMode: 'submitted',
      query: 'all:weekly',
      categories: ['cs.SE'],
    });
    store.failRun(otherKind.id, 'failed');

    assert.equal(present(store.findResumableHarvestRun('current')).run_id, older.id);
    assert.equal(present(store.findResumableHarvestRun('weekly')).run_id, otherKind.id);
    assert.equal(store.findResumableHarvestRun('missing'), undefined);
  } finally { store.close(); }
});

test('fixed-window runs are excluded from automatic harvest resume', () => {
  const store = openStateStore(':memory:');
  try {
    const configured = store.startRun({ from: '2026-01-01T00:00:00.000Z', to: '2026-09-03T00:00:00.000Z' }, 'current');
    store.beginHarvestShard({
      runId: configured.id,
      shardKey: 'configured-shard',
      shardIndex: 1,
      totalShards: 1,
      track: 'AI-FSD',
      dateMode: 'submitted',
      query: 'all:configured',
      categories: ['cs.SE'],
    });
    store.failRun(configured.id, 'configured failure');

    const fixed = store.startRun(
      { from: '2026-09-02T00:00:00.000Z', to: '2026-09-02T23:59:59.999Z' },
      'current',
      { autoResume: false },
    );
    store.beginHarvestShard({
      runId: fixed.id,
      shardKey: 'fixed-shard',
      shardIndex: 1,
      totalShards: 1,
      track: 'AI-FSD',
      dateMode: 'updated',
      query: 'all:fixed',
      categories: ['cs.SE'],
    });
    store.failRun(fixed.id, 'fixed failure');

    assert.equal(present(store.findResumableHarvestRun('current')).run_id, configured.id);
  } finally { store.close(); }
});

function present<T>(value: T | null | undefined): T { assert.ok(value != null); return value; }
function textValue(value: unknown): string { assert.equal(typeof value, 'string'); return String(value); }

const evidenceHash = (text: string) => createHash('sha256').update(text).digest('hex');
const testHash = (character: string) => character.repeat(64);
type EvidenceReceiptSource = {
  baseId: string;
  version: number;
  archiveManifestSha256: string;
  evidenceManifestSha256: string;
};

function evidenceReceipt(input: {
  runId: string;
  publicationId: string;
  contentSha256: string;
  sources?: EvidenceReceiptSource[];
}) {
  return JSON.stringify({
    schemaVersion: 1,
    publicationId: input.publicationId,
    runId: input.runId,
    publishedAt: '2026-09-02T00:00:00.000Z',
    publisherVersion: 1,
    contentSha256: input.contentSha256,
    sources: input.sources ?? [],
  });
}

test('lists only completed evidence publications and their sources deterministically', async () => {
  const fixture = await makeRuntimeFixture();
  const databasePath = join(fixture.root, 'state.sqlite');
  let store = openStateStore(databasePath);
  try {
    for (const paper of [
      { baseId: '2609.20001', arxivId: '2609.20001v1', version: 1, title: 'First source' },
      { baseId: '2609.20001', arxivId: '2609.20001v2', version: 2, title: 'Second source version' },
      { baseId: '2609.90001', arxivId: '2609.90001v1', version: 1, title: 'Later source' },
    ]) store.upsertDiscovered(paper);

    const earlier = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    const tiedOne = store.startRun({ from: '2026-09-02T00:00:00Z', to: '2026-09-03T00:00:00Z' }, 'current');
    const tiedTwo = store.startRun({ from: '2026-09-03T00:00:00Z', to: '2026-09-04T00:00:00Z' }, 'current');
    const reserved = store.startRun({ from: '2026-09-04T00:00:00Z', to: '2026-09-05T00:00:00Z' }, 'current');

    const complete = async (run: typeof earlier, publicationId: string, sources: EvidenceReceiptSource[]) => {
      const inputSha256 = testHash(publicationId.at(-1) ?? 'a');
      store.reserveEvidencePublication({ runId: run.id, publicationId, inputSha256 });
      const receipt = evidenceReceipt({ runId: run.id, publicationId, contentSha256: inputSha256, sources });
      const receiptPath = join(fixture.root, `${publicationId}.json`);
      await writeFile(receiptPath, receipt);
      store.completeEvidencePublication({
        runId: run.id,
        publicationId,
        receiptPath,
        receiptSha256: evidenceHash(receipt),
        lastSuccess: run.to,
      });
      return { inputSha256, receiptPath, receiptSha256: evidenceHash(receipt) };
    };

    const earlierIdentity = await complete(earlier, 'publication-a', [
      { baseId: '2609.90001', version: 1, archiveManifestSha256: testHash('d'), evidenceManifestSha256: testHash('e') },
    ]);
    const tiedOneIdentity = await complete(tiedOne, 'publication-b', [
      { baseId: '2609.20001', version: 2, archiveManifestSha256: testHash('b'), evidenceManifestSha256: testHash('c') },
      { baseId: '2609.20001', version: 1, archiveManifestSha256: testHash('a'), evidenceManifestSha256: testHash('b') },
    ]);
    const tiedTwoIdentity = await complete(tiedTwo, 'publication-c', []);
    store.reserveEvidencePublication({ runId: reserved.id, publicationId: 'publication-z', inputSha256: testHash('f') });
    store.close();

    const raw = createStateDatabase(databasePath);
    try {
      raw.prepare('UPDATE evidence_publications SET completed_at=? WHERE run_id=?').run('2026-09-03T00:00:00.000Z', earlier.id);
      raw.prepare('UPDATE evidence_publications SET completed_at=? WHERE run_id IN (?,?)').run(
        '2026-09-04T00:00:00.000Z', tiedOne.id, tiedTwo.id,
      );
    } finally { raw.close(); }

    store = openStateStore(databasePath);
    const tied = [
      { run: tiedOne, publicationId: 'publication-b', identity: tiedOneIdentity, sources: [
        { baseId: '2609.20001', version: 1, archiveManifestSha256: testHash('a'), evidenceManifestSha256: testHash('b') },
        { baseId: '2609.20001', version: 2, archiveManifestSha256: testHash('b'), evidenceManifestSha256: testHash('c') },
      ] },
      { run: tiedTwo, publicationId: 'publication-c', identity: tiedTwoIdentity, sources: [] },
    ].sort((left, right) => left.run.id.localeCompare(right.run.id));

    assert.deepEqual(store.listCompletedEvidencePublications(), [
      {
        runId: earlier.id,
        publicationId: 'publication-a',
        inputSha256: earlierIdentity.inputSha256,
        receiptPath: earlierIdentity.receiptPath,
        receiptSha256: earlierIdentity.receiptSha256,
        completedAt: '2026-09-03T00:00:00.000Z',
        sources: [{ baseId: '2609.90001', version: 1, archiveManifestSha256: testHash('d'), evidenceManifestSha256: testHash('e') }],
      },
      ...tied.map(({ run, publicationId, identity, sources }) => ({
        runId: run.id,
        publicationId,
        inputSha256: identity.inputSha256,
        receiptPath: identity.receiptPath,
        receiptSha256: identity.receiptSha256,
        completedAt: '2026-09-04T00:00:00.000Z',
        sources,
      })),
    ]);
  } finally {
    try { store.close(); } catch {}
    await fixture.dispose();
  }
});

test('reserves one evidence publication per run, replays matching input, and rejects conflicts', () => {
  const store = openStateStore(':memory:');
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    assert.equal(store.reserveEvidencePublication({ runId: run.id, publicationId: 'publication-1', inputSha256: testHash('a') }), 'reserved');
    assert.equal(store.reserveEvidencePublication({ runId: run.id, publicationId: 'publication-1', inputSha256: testHash('a') }), 'replayed');
    assert.throws(() => store.reserveEvidencePublication({ runId: run.id, publicationId: 'publication-2', inputSha256: testHash('a') }), /EVIDENCE.*CONFLICT/i);
    assert.throws(() => store.reserveEvidencePublication({ runId: run.id, publicationId: 'publication-1', inputSha256: testHash('b') }), /EVIDENCE.*CONFLICT/i);
    assert.equal(present(store.findEvidencePublication(run.id)).status, 'reserved');
  } finally { store.close(); }
});

test('does not complete an evidence run until its receipt file and hash verify', () => {
  const store = openStateStore(':memory:');
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    store.reserveEvidencePublication({ runId: run.id, publicationId: 'publication-1', inputSha256: testHash('a') });
    assert.throws(() => store.completeEvidencePublication({
      runId: run.id, publicationId: 'publication-1', receiptPath: 'missing-receipt.json', receiptSha256: testHash('c'), lastSuccess: run.to,
    }), /EVIDENCE.*RECEIPT/i);
    assert.equal(present(store.getRun(run.id)).status, 'running');
    assert.equal(present(store.findEvidencePublication(run.id)).status, 'reserved');
    assert.equal(store.getLastSuccess(), null);
  } finally { store.close(); }
});

test('records a failed evidence publication without completing its run', () => {
  const store = openStateStore(':memory:');
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    store.reserveEvidencePublication({ runId: run.id, publicationId: 'publication-1', inputSha256: testHash('a') });
    store.failEvidencePublication({ runId: run.id, publicationId: 'publication-1', errorCode: 'EVIDENCE_CONFLICT' });
    assert.equal(present(store.findEvidencePublication(run.id)).status, 'failed');
    assert.equal(present(store.findEvidencePublication(run.id)).error_code, 'EVIDENCE_CONFLICT');
    assert.equal(present(store.getRun(run.id)).status, 'running');
    assert.equal(store.getLastSuccess(), null);
  } finally { store.close(); }
});

test('a failed run recovers only through its reserved Evidence publication', async () => {
  const fixture = await makeRuntimeFixture();
  const store = openStateStore(join(fixture.root, 'state.sqlite'));
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    const inputSha256 = testHash('a');
    store.reserveEvidencePublication({ runId: run.id, publicationId: 'publication-1', inputSha256 });
    store.failRun(run.id, 'publisher interrupted after reservation');
    assert.equal(store.reserveEvidencePublication({ runId: run.id, publicationId: 'publication-1', inputSha256 }), 'replayed');
    const receipt = evidenceReceipt({ runId: run.id, publicationId: 'publication-1', contentSha256: inputSha256 });
    const receiptPath = join(fixture.root, 'recovery-publication.json'); await writeFile(receiptPath, receipt);
    assert.deepEqual(store.completeEvidencePublication({
      runId: run.id, publicationId: 'publication-1', receiptPath, receiptSha256: evidenceHash(receipt), lastSuccess: run.to,
    }), { status: 'completed' });
    assert.equal(present(store.getRun(run.id)).status, 'completed');
    assert.equal(present(store.findEvidencePublication(run.id)).status, 'completed');
  } finally { store.close(); await fixture.dispose(); }
});

test('a failed run cannot create a new Evidence reservation', () => {
  const store = openStateStore(':memory:');
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    store.failRun(run.id, 'parse failed');
    assert.throws(() => store.reserveEvidencePublication({ runId: run.id, publicationId: 'publication-1', inputSha256: testHash('a') }), /failed run.*reserved/i);
  } finally { store.close(); }
});

test('the explicit recovery boundary can reserve a new publication for a failed run', () => {
  const store = openStateStore(':memory:');
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    store.failRun(run.id, 'evidence publish failed after every Archive was verified');
    assert.equal(store.reserveFailedEvidencePublication({
      runId: run.id,
      publicationId: 'publication-1',
      inputSha256: testHash('a'),
    }), 'reserved');
    assert.equal(present(store.findEvidencePublication(run.id)).status, 'reserved');
  } finally { store.close(); }
});

test('completes a receipt-verified evidence publication with its sources and watermark atomically', async () => {
  const fixture = await makeRuntimeFixture();
  const store = openStateStore(join(fixture.root, 'state.sqlite'));
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    store.upsertDiscovered({ baseId: '2609.1', arxivId: '2609.1v1', version: 1, title: 'Evidence source' });
    const inputSha256 = testHash('a');
    store.reserveEvidencePublication({ runId: run.id, publicationId: 'publication-1', inputSha256 });
    const receipt = evidenceReceipt({
      runId: run.id,
      publicationId: 'publication-1',
      contentSha256: inputSha256,
      sources: [{ baseId: '2609.1', version: 1, archiveManifestSha256: testHash('b'), evidenceManifestSha256: testHash('c') }],
    });
    const receiptPath = join(fixture.root, 'publication.json');
    await writeFile(receiptPath, receipt);

    assert.deepEqual(store.completeEvidencePublication({
      runId: run.id, publicationId: 'publication-1', receiptPath, receiptSha256: evidenceHash(receipt), lastSuccess: run.to,
    }), { status: 'completed' });
    assert.equal(present(store.findEvidencePublication(run.id)).status, 'completed');
    assert.equal(present(store.getRun(run.id)).status, 'completed');
    assert.equal(store.getLastSuccess(), run.to);
    const raw = createStateDatabase(join(fixture.root, 'state.sqlite'));
    try {
      const source = raw.prepare(`
        SELECT archive_manifest_sha256,evidence_manifest_sha256 FROM evidence_publication_sources WHERE run_id=?
      `).get(run.id);
      assert.deepEqual(source, { archive_manifest_sha256: testHash('b'), evidence_manifest_sha256: testHash('c') });
    } finally { raw.close(); }
  } finally { store.close(); await fixture.dispose(); }
});

test('rolls back run completion and publication writes when a receipt source cannot be recorded', async () => {
  const fixture = await makeRuntimeFixture();
  const store = openStateStore(join(fixture.root, 'state.sqlite'));
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    const inputSha256 = testHash('a');
    store.reserveEvidencePublication({ runId: run.id, publicationId: 'publication-1', inputSha256 });
    const receipt = evidenceReceipt({
      runId: run.id,
      publicationId: 'publication-1',
      contentSha256: inputSha256,
      sources: [{ baseId: 'missing-source', version: 1, archiveManifestSha256: testHash('b'), evidenceManifestSha256: testHash('c') }],
    });
    const receiptPath = join(fixture.root, 'publication.json');
    await writeFile(receiptPath, receipt);

    assert.throws(() => store.completeEvidencePublication({
      runId: run.id, publicationId: 'publication-1', receiptPath, receiptSha256: evidenceHash(receipt), lastSuccess: run.to,
    }), /FOREIGN KEY|source/i);
    assert.equal(present(store.findEvidencePublication(run.id)).status, 'reserved');
    assert.equal(present(store.getRun(run.id)).status, 'running');
    assert.equal(store.getLastSuccess(), null);
    const raw = createStateDatabase(join(fixture.root, 'state.sqlite'));
    try { assert.equal(raw.prepare('SELECT count(*) AS count FROM evidence_publication_sources WHERE run_id=?').get(run.id)?.count, 0); }
    finally { raw.close(); }
  } finally { store.close(); await fixture.dispose(); }
});
