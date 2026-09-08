import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, rename, symlink } from 'node:fs/promises';
import { join, dirname, toNamespacedPath } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveContext, archiveTestPdf } from './fixtures/library-paths.ts';
import { archiveFileManifest, canonicalJson } from '../src/shared/manifest.ts';
import { createArchiveMigrationPlan, applyArchiveMigration } from '../src/maintenance/archive-migration.ts';
import { createLibraryStatePlan, applyLibraryStatePlan } from '../src/maintenance/library-state-migration.ts';
import { main } from '../src/cli.ts';
import { routeEvidenceMigrate, routeLibraryMigrate } from '../src/cli/routes.ts';
import { fingerprint, readOperationRecord, admitOperation } from '../src/library/operations/operation-store.ts';
import { readPublicationReceipt } from '../src/evidence/receipt-store.ts';

const hash = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
const stamp = '2026-09-04T00:00:00.000Z';
async function put(path: string, body: string | Uint8Array) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); }
async function snapshot(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const rel of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, rel), s = await stat(path);
    result.push([rel, s.mtimeMs, s.isFile() ? hash(await readFile(path)) : null]);
  }
  return result;
}

async function fixture(count = 20, receipts = 8) {
  const root = await mkdtemp(join(tmpdir(), 'library-state-migration-'));
  const legacyStateRoot = join(root, 'old', 'fsd-code2doc', 'state');
  const legacyPdfRoot = join(root, 'pdf', 'fsd-code2doc');
  const { libraryPaths: paths, libraryId } = archiveContext(join(root, 'new', 'fsd'));
  await mkdir(legacyStateRoot, { recursive: true });
  const sourceDb = join(legacyStateRoot, 'papers.sqlite');
  const db = new Database(sourceDb);
  for (const name of (await readdir(new URL('../migrations', import.meta.url))).filter(n => /^00[1-8]-/.test(n)).sort()) {
    db.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  db.exec('ALTER TABLE papers ADD COLUMN downloaded_version INTEGER');
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const baseId = `2601.${String(i).padStart(5, '0')}`;
    ids.push(baseId);
    const pdf = await archiveTestPdf(baseId), sha = hash(pdf);
    const pdfPath = join(legacyPdfRoot, 'AI-FSD', `${baseId}v1.pdf`);
    const archive = join(legacyStateRoot, 'extracted', `p-${baseId}`);
    await put(pdfPath, pdf);
    for (const [path, bytes] of Object.entries({ 'normalized/full.md': '# Paper\n', 'normalized/pages.json': '[{"page":1,"text":"paper"}]',
      'normalized/page-marked.txt': '--- PAGE 1 ---\npaper', 'normalized/content-list.json': '[{"type":"text","text":"paper","page_idx":0}]' })) await put(join(archive, path), bytes);
    await put(join(archive, 'pdf', `${sha}.pdf`), pdf);
    await put(join(archive, 'source.json'), canonicalJson({ schemaVersion: 1, baseId, arxivId: `${baseId}v1`, version: 1,
      title: 'Paper', authors: ['Ada'], categories: ['cs.SE'], matchedTracks: ['AI-FSD'], published: stamp, updated: stamp,
      pdfPath: `pdf/${sha}.pdf`, pdfSha256: sha, parseAttemptId: `parse-${i}`, model: 'pipeline', cliBackend: 'pipeline', method: 'auto', pageCount: 1,
      normalized: { fullMarkdown: 'normalized/full.md', pages: 'normalized/pages.json', contentList: 'normalized/content-list.json', pageMarkedText: 'normalized/page-marked.txt' },
      files: await archiveFileManifest(archive) }));
    db.query(`INSERT INTO papers(base_id,version,title,pdf_path,sha256,status,created_at,updated_at,downloaded_version) VALUES(?,1,'Paper',?,?,'parsed',?,?,1)`)
      .run(baseId, pdfPath, sha, stamp, stamp);
    db.query('INSERT INTO paper_versions(base_id,version,arxiv_id,sha256) VALUES(?,1,?,?)').run(baseId, `${baseId}v1`, sha);
    db.query(`INSERT INTO parse_attempts(attempt_id,base_id,version,sha256,model,cli_backend,method,status,source_path,output_dir,markdown_path,content_list_path,page_text_path,page_count)
      VALUES(?,?,1,?,'pipeline','pipeline','auto','succeeded',?,?,?,?,?,1)`)
      .run(`parse-${i}`, baseId, sha, pdfPath, archive, join(archive, 'normalized/full.md'), join(archive, 'normalized/content-list.json'), join(archive, 'normalized/page-marked.txt'));
  }
  for (let i = 1; i <= receipts; i++) {
    const runId = `run-${i}`, publicationId = `pub-${i}`;
    db.query("INSERT INTO runs(run_id,kind,from_utc,to_utc,status,started_at) VALUES(?,'current',?,?,'completed',?)").run(runId, stamp, stamp, stamp);
    const receiptPath = join(legacyStateRoot, 'runs', runId, 'evidence', 'publication.json');
    const receipt = canonicalJson({ schemaVersion: 1, publisherVersion: 2, publicationId, runId, publishedAt: stamp, contentSha256: hash('evidence'), sources: [] });
    await put(receiptPath, receipt);
    db.query(`INSERT INTO evidence_publications(run_id,publication_id,input_sha256,receipt_path,receipt_sha256,status,reserved_at,completed_at) VALUES(?,?,?,?,?,'completed',?,?)`)
      .run(runId, publicationId, hash('input'), receiptPath, hash(receipt), stamp, stamp);
    await put(join(legacyStateRoot, 'runs', runId, 'task-downloads.json'), JSON.stringify({ runId, projectId: 'fsd-code2doc',
      downloaded: [{ pdfPath: join(legacyPdfRoot, 'AI-FSD', `${ids[0]}v1.pdf`), baseId: ids[0], version: 1 }],
      nested: { projectId: 'fsd-code2doc', archiveRoot: join(legacyStateRoot, 'extracted', `p-${ids[0]}`) } }));
  }
  for (let i = 1; i <= 19; i++) {
    const operation = { kind: 'current', limit: 10 };
    const jobId = `job-${i}`, requestId = `req-${i}`;
    await put(join(legacyStateRoot, 'operations', `${jobId}.json`), JSON.stringify({ schemaVersion: 1, jobId, requestId,
      projectId: 'fsd-code2doc', status: 'completed', stage: 'evidence-publish', updatedAt: stamp, canResume: false,
      owner: { pid: 0, startedAt: stamp }, attempts: [{ requestId, acceptedAt: stamp }], policy: { collectionHash: fingerprint({}) },
      request: { projectId: 'fsd-code2doc', requestId, operation }, requestHash: fingerprint(operation) }));
    await put(join(legacyStateRoot, 'operations', 'events', `${jobId}.jsonl`), JSON.stringify({ seq: 1, jobId, projectId: 'fsd-code2doc', at: stamp, type: 'completed' }) + '\n');
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();
  const archiveInput = { legacyArchiveRoot: join(legacyStateRoot, 'extracted'), paths, libraryId };
  const archivePlan = await createArchiveMigrationPlan(archiveInput);
  const archivePlanFile = join(root, 'archive-plan.json');
  await put(archivePlanFile, canonicalJson(archivePlan));
  await applyArchiveMigration({ ...archiveInput, planFile: archivePlanFile, planSha256: archivePlan.sha256 });
  const input = { legacyStateRoot, legacyPdfRoot, paths, libraryId };
  const planFile = join(root, 'library-plan.json');
  const review = async () => { const plan = await createLibraryStatePlan(input); await put(planFile, canonicalJson(plan)); return { ...input, planFile, planSha256: plan.sha256 }; };
  return { root, input, sourceDb, paths, ids, planFile, review };
}

test('rewrites exactly 128 persisted path cells, all 19 operations, runs and immutable receipts', async () => {
  const f = await fixture();
  try {
    const sourceBefore = await snapshot(f.input.legacyStateRoot);
    const result = await applyLibraryStatePlan(await f.review());
    assert.equal(result.rewrittenDatabaseCells, 128);
    assert.equal(result.oldPathOccurrences, 0);
    assert.equal(result.oldProjectIdOccurrences, 0);
    assert.deepEqual(result.libraryIds, ['fsd']);
    assert.equal(result.integrityCheck, 'ok'); assert.equal(result.foreignKeyViolations, 0);
    assert.equal(result.operations, 19);
    const db = new Database(f.paths.databasePath, { readonly: true });
    try {
      const first = db.query('SELECT * FROM papers ORDER BY base_id LIMIT 1').get() as { pdf_path: string };
      assert.equal(first.pdf_path, join(f.paths.archiveRoot, '2601.00001-v1', 'source.pdf'));
      const parse = db.query('SELECT * FROM parse_attempts WHERE attempt_id=?').get('parse-1') as Record<string, string>;
      assert.equal(parse.markdown_path, join(f.paths.archiveRoot, '2601.00001-v1', 'document.md'));
      assert.equal(parse.page_text_path, join(f.paths.archiveRoot, '2601.00001-v1', 'pages.json'));
      for (const key of ['source_path','output_dir','markdown_path','content_list_path','page_text_path']) await stat(parse[key]!);
      for (const row of db.query('SELECT receipt_path,receipt_sha256 FROM evidence_publications').all() as { receipt_path: string; receipt_sha256: string }[]) {
        assert.equal(hash(await readFile(row.receipt_path)), row.receipt_sha256);
        assert.ok(await readPublicationReceipt(row.receipt_path));
      }
      for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
        assert.doesNotMatch(JSON.stringify(db.query(`SELECT * FROM "${name}"`).all()), /fsd-code2doc|projectId/);
      }
    } finally { db.close(); }
    for (let i = 1; i <= 19; i++) assert.equal(readOperationRecord(f.paths.operationsRoot, `job-${i}`).libraryId, 'fsd');
    const replay = await admitOperation({ operationsRoot: f.paths.operationsRoot, internal: true,
      request: { libraryId: 'fsd', requestId: 'req-1', operation: { kind: 'current', limit: 10 } } });
    assert.equal(replay.replayed, true);
    for (const dir of [f.paths.runsRoot, f.paths.operationsRoot]) {
      for (const rel of await readdir(dir, { recursive: true })) if (/\.jsonl?$/.test(rel)) assert.doesNotMatch(await readFile(join(dir, rel), 'utf8'), /fsd-code2doc|projectId/);
    }
    assert.deepEqual(await snapshot(f.input.legacyStateRoot), sourceBefore);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 60000);

test('dry-run is canonical, deterministic, zero-write and records actual counts (not 128)', async () => {
  const f = await fixture(1, 1);
  try {
    const before = await snapshot(f.root);
    const plan = await createLibraryStatePlan(f.input);
    assert.equal(plan.counts.rewrittenDatabaseCells, 7);
    assert.deepEqual(await createLibraryStatePlan(f.input), plan);
    const { sha256, ...body } = plan;
    assert.equal(sha256, hash(canonicalJson(body)));
    assert.deepEqual(await snapshot(f.root), before);
    assert.equal((await applyLibraryStatePlan(await f.review())).rewrittenDatabaseCells, 7);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('replay verifies database and history bytes and does no writes', async () => {
  const f = await fixture(1, 1);
  try {
    const input = await f.review(); await applyLibraryStatePlan(input);
    const before = await snapshot(f.root);
    assert.equal((await applyLibraryStatePlan(input)).replayed, true);
    assert.deepEqual(await snapshot(f.root), before);
    await put(join(f.paths.operationsRoot, 'job-1.json'), '{}');
    await assert.rejects(applyLibraryStatePlan(input), /MIGRATION_TARGET_CONFLICT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const drift of ['database', 'run', 'new-file', 'plan-count', 'plan-format', 'archive'] as const) test(`apply fails closed for ${drift} drift`, async () => {
  const f = await fixture(1, 1);
  try {
    const input = await f.review();
    if (drift === 'database') { const db = new Database(f.sourceDb); db.exec("UPDATE papers SET title='changed'"); db.close(); }
    if (drift === 'run') await put(join(f.input.legacyStateRoot, 'runs', 'run-1', 'task-downloads.json'), '{}');
    if (drift === 'new-file') await put(join(f.input.legacyStateRoot, 'operations', 'added.json'), '{}');
    if (drift === 'archive') await put(join(f.paths.archiveRoot, '2601.00001-v1', 'document.md'), 'changed');
    if (drift === 'plan-count') {
      const plan = JSON.parse(await readFile(f.planFile, 'utf8')); plan.counts.rewrittenDatabaseCells++;
      const { sha256: _, ...body } = plan; plan.sha256 = hash(canonicalJson(body)); input.planSha256 = plan.sha256;
      await put(f.planFile, canonicalJson(plan));
    }
    if (drift === 'plan-format') await put(f.planFile, JSON.stringify(JSON.parse(await readFile(f.planFile, 'utf8')), null, 2));
    const before = await snapshot(f.root);
    await assert.rejects(applyLibraryStatePlan(input), /MIGRATION_PLAN_DRIFT/);
    assert.deepEqual(await snapshot(f.root), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects WAL, bad foreign keys, malformed JSON and conflicting project identities before writes', async () => {
  const f = await fixture(1, 1);
  try {
    await put(f.sourceDb + '-wal', 'live');
    await assert.rejects(createLibraryStatePlan(f.input), /MIGRATION_STATE_BUSY/);
    await rm(f.sourceDb + '-wal');
    const db = new Database(f.sourceDb); db.exec("PRAGMA foreign_keys=OFF; INSERT INTO paper_versions(base_id,version,arxiv_id) VALUES('orphan',1,'orphanv1')"); db.close();
    await assert.rejects(createLibraryStatePlan(f.input), /foreign.key/i);
    const repair = new Database(f.sourceDb); repair.exec("DELETE FROM paper_versions WHERE base_id='orphan'"); repair.close();
    const path = join(f.input.legacyStateRoot, 'runs', 'run-1', 'task-downloads.json');
    await put(path, '{broken'); await assert.rejects(createLibraryStatePlan(f.input), /MIGRATION_INVALID_SOURCE/);
    await put(path, '{"projectId":"different-library"}'); await assert.rejects(createLibraryStatePlan(f.input), /identity/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('migrates every actual parse path column, including an extended sixth column', async () => {
  const f = await fixture(1, 0);
  try {
    const db = new Database(f.sourceDb); db.exec('ALTER TABLE parse_attempts ADD COLUMN pages_path TEXT');
    db.query('UPDATE parse_attempts SET pages_path=?').run(join(f.input.legacyStateRoot, 'extracted', 'p-2601.00001', 'normalized', 'pages.json')); db.close();
    assert.equal((await applyLibraryStatePlan(await f.review())).rewrittenDatabaseCells, 7);
    const target = new Database(f.paths.databasePath); try {
      assert.deepEqual(target.query('SELECT pages_path FROM parse_attempts').get(), { pages_path: join(f.paths.archiveRoot, '2601.00001-v1', 'pages.json') });
    } finally { target.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('refuses overlapping roots, links and partial targets without touching them', async () => {
  const f = await fixture(1, 1);
  try {
    const bad = archiveContext(join(f.input.legacyStateRoot, 'nested')).libraryPaths;
    await assert.rejects(createLibraryStatePlan({ ...f.input, paths: bad }), /MIGRATION_PATH_UNSAFE/);
    await mkdir(f.paths.runsRoot, { recursive: true });
    const input = await f.review();
    await assert.rejects(applyLibraryStatePlan(input), /MIGRATION_TARGET_CONFLICT/);
    await rm(f.paths.runsRoot, { recursive: true });
    const outside = join(f.root, 'outside'); await mkdir(outside);
    await symlink(outside, join(f.input.legacyStateRoot, 'operations', 'linked'), 'junction');
    await assert.rejects(createLibraryStatePlan(f.input), /link|reparse/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('library-migrate CLI enforces review arguments and bypasses ordinary operations', async () => {
  const f = await fixture(1, 1);
  try {
    const before = await snapshot(f.root); let output: unknown;
    await main(['--library','fsd','library-migrate','--dry-run','--format','json'], { libraryMigration: f.input, output: v => { output = v; },
      execute: async () => { throw new Error('must not launch operations'); } });
    assert.deepEqual(output, await createLibraryStatePlan(f.input));
    assert.deepEqual(await snapshot(f.root), before);
    for (const args of [[], ['--apply'], ['--dry-run'], ['--dry-run','--format','json','--apply'], ['--dry-run','--format','json','--surprise'], ['--dry-run','--dry-run','--format','json']]) {
      await assert.rejects(routeLibraryMigrate(args, { input: f.input }), /LIBRARY_MIGRATION_ARGUMENTS/);
    }
    const input = await f.review();
    const result = await routeLibraryMigrate(['--apply','--plan-file',f.planFile,'--plan-sha256',input.planSha256], { input: f.input });
    assert.ok('replayed' in result); assert.equal(result.replayed, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('historical Evidence inventory uses library.sqlite after cutover and refuses split databases', async () => {
  const f = await fixture(1, 1);
  try {
    await rename(f.sourceDb, join(f.input.legacyStateRoot, 'library.sqlite'));
    // Inventory reports per-source SQL failures; this distinguishes a real
    // library.sqlite read from the missing-database fallback inventory.
    const db = new Database(join(f.input.legacyStateRoot, 'library.sqlite')); db.exec('DROP TABLE parse_attempts'); db.close();
    const inspected = await routeEvidenceMigrate(['--dry-run','--format','json'], { config: {
      stateRoot: f.input.legacyStateRoot, vaultRoot: f.paths.vaultRoot, tempRoot: f.paths.workRoot } });
    assert.match(inspected.inventory.items[0]!.reason!, /parse_attempts/);
    await put(f.sourceDb, 'legacy');
    await assert.rejects(routeEvidenceMigrate(['--dry-run','--format','json'], { config: {
      stateRoot: f.input.legacyStateRoot, vaultRoot: f.paths.vaultRoot, tempRoot: f.paths.workRoot } }), /MIGRATION_DATABASE_CONFLICT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preserves incidental prose and sibling paths while migrating rooted nested values', async () => {
  const f = await fixture(1, 1);
  try {
    const note = `See fsd-code2doc documentation; prefix${f.input.legacyStateRoot}/runs is an example`;
    const path = join(f.input.legacyStateRoot, 'runs', 'run-1', 'details.json');
    await put(path, JSON.stringify({ title: note, sibling: f.input.legacyPdfRoot + '-other/book.pdf',
      nested: [{ projectId: 'fsd-code2doc', pdfPath: join(f.input.legacyPdfRoot, 'AI-FSD', '2601.00001v1.pdf') }] }));
    const db = new Database(f.sourceDb);
    db.query('UPDATE papers SET title=?').run(note); db.close();
    await applyLibraryStatePlan(await f.review());
    const migrated = JSON.parse(await readFile(join(f.paths.runsRoot, 'run-1', 'details.json'), 'utf8'));
    assert.equal(migrated.title, note);
    assert.equal(migrated.sibling, f.input.legacyPdfRoot + '-other/book.pdf');
    assert.deepEqual(migrated.nested, [{ libraryId: 'fsd', pdfPath: join(f.paths.archiveRoot, '2601.00001-v1', 'source.pdf') }]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects rooted traversal and unknown operation identity without destination writes', async () => {
  const f = await fixture(1, 1);
  try {
    const path = join(f.input.legacyStateRoot, 'runs', 'run-1', 'details.json');
    await put(path, JSON.stringify({ pdfPath: f.input.legacyPdfRoot + '/../../escaped.pdf' }));
    await assert.rejects(createLibraryStatePlan(f.input), /MIGRATION_PATH_UNSAFE/);
    await rm(path);
    const opPath = join(f.input.legacyStateRoot, 'operations', 'job-1.json');
    const op = JSON.parse(await readFile(opPath, 'utf8')); op.request.libraryId = 'other';
    await put(opPath, JSON.stringify(op));
    await assert.rejects(createLibraryStatePlan(f.input), /identity/i);
    await assert.rejects(stat(f.paths.databasePath), /ENOENT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects mismatched source request hashes instead of silently repairing operation history', async () => {
  const f = await fixture(1, 1);
  try {
    const path = join(f.input.legacyStateRoot, 'operations', 'job-1.json');
    const op = JSON.parse(await readFile(path, 'utf8')); op.requestHash = hash('wrong operation');
    await put(path, JSON.stringify(op));
    await assert.rejects(createLibraryStatePlan(f.input), /request.*hash/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rolls back installed history when the final database installation fails', async () => {
  const f = await fixture(1, 1);
  try {
    const input = await f.review(), before = await snapshot(f.input.legacyStateRoot);
    await assert.rejects(applyLibraryStatePlan({ ...input, install: async (from, to) => {
      if (to === f.paths.databasePath) throw new Error('injected final install failure');
      await rename(from, to);
    } }), /injected final install failure/);
    for (const path of [f.paths.databasePath, f.paths.runsRoot, f.paths.operationsRoot]) await assert.rejects(stat(path), /ENOENT/);
    assert.deepEqual(await snapshot(f.input.legacyStateRoot), before);
    assert.equal((await applyLibraryStatePlan(input)).replayed, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('does not admit active operations, stale lock files or a mismatched reviewed hash', async () => {
  const f = await fixture(1, 1);
  try {
    const input = await f.review();
    await assert.rejects(applyLibraryStatePlan({ ...input, planSha256: hash('wrong plan') }), /MIGRATION_PLAN_DRIFT/);
    const path = join(f.input.legacyStateRoot, 'operations', 'job-1.json');
    const op = JSON.parse(await readFile(path, 'utf8')); op.status = 'running';
    await put(path, JSON.stringify(op));
    await assert.rejects(createLibraryStatePlan(f.input), /MIGRATION_STATE_BUSY/);
    op.status = 'completed'; await put(path, JSON.stringify(op));
    await put(join(f.input.legacyStateRoot, 'operations', 'locks', 'workflow.lock'), '{}');
    await assert.rejects(createLibraryStatePlan(f.input), /MIGRATION_STATE_BUSY/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('copies unparsed downloads, preserves nullable cells, and verifies copied PDF hash', async () => {
  const f = await fixture(1, 1);
  try {
    const path = join(f.input.legacyPdfRoot, 'unparsed.pdf'), pdf = await archiveTestPdf('unparsed');
    await put(path, pdf);
    const db = new Database(f.sourceDb);
    db.query("INSERT INTO papers(base_id,version,title,pdf_path,sha256,status,created_at,updated_at) VALUES('local-x',1,'Unparsed',?,?,'downloaded',?,?)")
      .run(path, hash(pdf), stamp, stamp); db.close();
    const input = await f.review();
    assert.equal((await applyLibraryStatePlan(input)).rewrittenDatabaseCells, 8);
    assert.equal(hash(await readFile(join(f.paths.workRoot, 'downloads', 'unparsed.pdf'))), hash(pdf));
    assert.equal((await applyLibraryStatePlan(input)).replayed, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('refuses a downloaded PDF whose bytes disagree with SQLite provenance', async () => {
  const f = await fixture(1, 1);
  try {
    const path = join(f.input.legacyPdfRoot, 'bad.pdf');
    await put(path, await archiveTestPdf('wrong content'));
    const db = new Database(f.sourceDb);
    db.query("INSERT INTO papers(base_id,version,title,pdf_path,sha256,status,created_at,updated_at) VALUES('local-x',1,'Unparsed',?,?,'downloaded',?,?)")
      .run(path, hash('expected other PDF'), stamp, stamp); db.close();
    await assert.rejects(createLibraryStatePlan(f.input), /PDF.*hash/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects source drift during installation and rolls back only its own targets', async () => {
  const f = await fixture(1, 1);
  try {
    const input = await f.review();
    const sourcePath = join(f.input.legacyStateRoot, 'runs', 'run-1', 'task-downloads.json');
    await assert.rejects(applyLibraryStatePlan({ ...input, install: async (from, to) => {
      await rename(from, to);
      if (to === f.paths.databasePath) await put(sourcePath, '{}');
    } }), /MIGRATION_PLAN_DRIFT/);
    for (const path of [f.paths.databasePath, f.paths.runsRoot, f.paths.operationsRoot]) await assert.rejects(stat(path), /ENOENT/);
    assert.equal(await readFile(sourcePath, 'utf8'), '{}');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects a missing Windows drive promptly', async () => {
  if (process.platform !== 'win32') return;
  const f = await fixture(1, 1);
  try {
    for (const drive of ['Z:', 'Y:', 'X:']) {
      if (await stat(drive + '/').then(() => true, () => false)) continue;
      const paths = archiveContext(drive + '/library-state-fixture').libraryPaths;
      await assert.rejects(createLibraryStatePlan({ ...f.input, paths }), /MIGRATION_PATH_UNSAFE/);
      break;
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 5000);

test('rewrites historical database filenames in nested run manifests to library.sqlite', async () => {
  const f = await fixture(1, 1);
  try {
    await put(join(f.input.legacyStateRoot, 'runs', 'run-1', 'runtime.json'), JSON.stringify({
      nested: { databasePath: f.sourceDb }, paths: [f.sourceDb.replaceAll('\\', '/')] }));
    await applyLibraryStatePlan(await f.review());
    assert.deepEqual(JSON.parse(await readFile(join(f.paths.runsRoot, 'run-1', 'runtime.json'), 'utf8')), {
      nested: { databasePath: f.paths.databasePath }, paths: [f.paths.databasePath] });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects competing source databases before building a plan', async () => {
  const f = await fixture(1, 1);
  try {
    await put(join(f.input.legacyStateRoot, 'library.sqlite'), await readFile(f.sourceDb));
    const before = await snapshot(f.root);
    await assert.rejects(createLibraryStatePlan(f.input), /MIGRATION_DATABASE_CONFLICT/);
    assert.deepEqual(await snapshot(f.root), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects source trigger side effects through strict database update counts', async () => {
  const f = await fixture(1, 1);
  try {
    const db = new Database(f.sourceDb);
    const oldPath = f.sourceDb.replaceAll("'", "''");
    db.exec(`CREATE TRIGGER legacy_path AFTER UPDATE OF pdf_path ON papers BEGIN
      UPDATE papers SET note_path='${oldPath}' WHERE base_id=NEW.base_id; END`);
    db.close();
    const before = await snapshot(f.root);
    await assert.rejects(createLibraryStatePlan(f.input), /database cell count differs/);
    assert.deepEqual(await snapshot(f.root), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects case-colliding state root directories before ignoring unselected history', async () => {
  const f = await fixture(1, 1);
  try {
    const before = await snapshot(f.root);
    // Windows normally aliases Runs/runs. A child-scoped filesystem listing
    // models a case-sensitive source directory without polluting other tests.
    const script = `import { mock } from 'bun:test';
      import { resolve } from 'node:path';
      const fs = { ...await import('node:fs/promises') };
      const input = JSON.parse(process.argv[1]);
      mock.module('node:fs/promises', () => ({ ...fs, readdir: async (path, options) => {
        const entries = await fs.readdir(path, options);
        if (resolve(path) !== input.legacyStateRoot) return entries;
        if (!options?.withFileTypes) return [...entries, 'Runs'];
        const alias = Object.create(entries.find(e => e.name === 'runs'));
        Object.defineProperty(alias, 'name', { value: 'Runs' });
        return [...entries, alias];
      } }));
      const { createLibraryStatePlan } = await import(${JSON.stringify(new URL('../src/maintenance/library-state-migration.ts', import.meta.url).href)});
      try { await createLibraryStatePlan(input); console.log('unexpected success'); }
      catch (error) { console.error(String(error)); process.exitCode = 1; }`;
    const child = Bun.spawn([process.execPath, '-e', script, JSON.stringify(f.input)], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 3000);
    try {
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      assert.equal(timedOut, false);
      assert.equal(exit, 1);
      assert.match(stderr, /case-colliding/);
      assert.deepEqual(await snapshot(f.root), before);
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const diskOnly of [false, true]) for (const residue of ['path', 'json-path', 'json-identity', 'scalar-identity', 'marker-identity']) {
  test(`rescans after provenance insert triggers: ${residue}, diskOnly=${diskOnly}`, async () => {
    const f = await fixture(1, 1);
    try {
      const oldPath = f.sourceDb.replaceAll('\\', '/').toUpperCase();
      const value = residue === 'path' ? oldPath : residue === 'json-path' ? JSON.stringify({ nested: [{ path: oldPath }] })
        : residue === 'json-identity' ? JSON.stringify({ nested: [{ projectId: 'fsd-code2doc' }] }) : 'fsd-code2doc';
      const db = new Database(f.sourceDb);
      db.exec(await readFile(new URL('../migrations/009-library-layout-v2.sql', import.meta.url), 'utf8'));
      db.exec(`CREATE TRIGGER reintroduce_legacy AFTER INSERT ON library_layout_migrations
        ${diskOnly ? "WHEN (SELECT file FROM pragma_database_list WHERE name='main') <> ''" : ''}
        BEGIN UPDATE ${residue === 'marker-identity' ? 'library_layout_migrations SET library_id' : 'papers SET note_path'}='${value.replaceAll("'", "''")}'; END`);
      db.close();
      const sourceBefore = await snapshot(f.input.legacyStateRoot);
      if (!diskOnly) {
        const before = await snapshot(f.root);
        await assert.rejects(createLibraryStatePlan(f.input), /MIGRATION_DATABASE_RESIDUE/);
        assert.deepEqual(await snapshot(f.root), before);
      } else {
        // The trigger deliberately fires only in the real copied database.
        // Passing a dry-run or comparing its content hash cannot prove rollback.
        const input = await f.review();
        await assert.rejects(applyLibraryStatePlan(input), /MIGRATION_DATABASE_RESIDUE/);
        await assert.rejects(stat(f.paths.databasePath), /ENOENT/);
        const staged = (await readdir(f.paths.workRoot, { recursive: true })).filter(p => p.endsWith('library.sqlite'));
        assert.equal(staged.length, 1);
        const copy = new Database(toNamespacedPath(join(f.paths.workRoot, staged[0]!)), { readonly: true });
        try {
          assert.deepEqual(copy.query('SELECT note_path,pdf_path FROM papers').get(), {
            note_path: null, pdf_path: join(f.input.legacyPdfRoot, 'AI-FSD', '2601.00001v1.pdf') });
          assert.equal((copy.query('SELECT count(*) AS n FROM library_layout_migrations').get() as { n: number }).n, 0);
        } finally { copy.close(); }
      }
      assert.deepEqual(await snapshot(f.input.legacyStateRoot), sourceBefore);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

async function extraDownloads(f: Awaited<ReturnType<typeof fixture>>, names: string[]) {
  const result: { path: string; bytes: Buffer }[] = [];
  const db = new Database(f.sourceDb);
  try {
    for (const [index, name] of names.entries()) {
      const bytes = await archiveTestPdf('extra-' + index), path = join(f.input.legacyPdfRoot, name);
      await put(path, bytes);
      db.query("INSERT INTO papers(base_id,version,title,pdf_path,sha256,status,created_at,updated_at) VALUES(?,1,'Download',?,?,'downloaded',?,?)")
        .run('extra-' + index, path, hash(bytes), stamp, stamp);
      result.push({ path, bytes });
    }
  } finally { db.close(); }
  return result;
}

test('merges Windows directory aliases and binds database and history references to one spelling', async () => {
  const f = await fixture(1, 1);
  try {
    const inputs = await extraDownloads(f, ['Batch/one.pdf', 'batch/two.pdf']);
    await put(join(f.input.legacyStateRoot, 'runs', 'run-1', 'Batch', 'two.json'), '{}');
    const historyAlias = join(f.input.legacyStateRoot, 'runs', 'run-1', 'batch', 'two.json');
    await put(join(f.input.legacyStateRoot, 'runs', 'run-1', 'refs.json'), JSON.stringify({ pdfs: inputs.map(x => x.path), historyAlias }));
    const db = new Database(f.sourceDb); db.query("UPDATE papers SET note_path=? WHERE base_id='extra-1'").run(historyAlias); db.close();
    const before = await snapshot(f.root), plan = await createLibraryStatePlan(f.input);
    assert.equal(new Set(plan.directories.map(p => p.toLowerCase())).size, plan.directories.length);
    assert.deepEqual(plan, await createLibraryStatePlan(f.input));
    assert.deepEqual(await snapshot(f.root), before);
    const input = await f.review(); await applyLibraryStatePlan(input);
    const expected = ['one.pdf', 'two.pdf'].map(name => join(f.paths.workRoot, 'downloads', 'Batch', name));
    const copy = new Database(f.paths.databasePath, { readonly: true });
    try {
      assert.deepEqual(copy.query("SELECT pdf_path FROM papers WHERE base_id LIKE 'extra-%' ORDER BY base_id").all(), expected.map(pdf_path => ({ pdf_path })));
      assert.deepEqual(copy.query("SELECT note_path FROM papers WHERE base_id='extra-1'").get(), { note_path: join(f.paths.runsRoot, 'run-1', 'Batch', 'two.json') });
    } finally { copy.close(); }
    assert.deepEqual(JSON.parse(await readFile(join(f.paths.runsRoot, 'run-1', 'refs.json'), 'utf8')), {
      pdfs: expected, historyAlias: join(f.paths.runsRoot, 'run-1', 'Batch', 'two.json') });
    assert.equal((await applyLibraryStatePlan(input)).replayed, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('coalesces identical case-fold file aliases while retaining every source in the reviewed inventory', async () => {
  const f = await fixture(1, 1);
  try {
    const [download] = await extraDownloads(f, ['Batch/one.pdf']);
    const alias = join(f.input.legacyPdfRoot, 'batch', 'ONE.pdf');
    await put(alias, download!.bytes);
    const db = new Database(f.sourceDb);
    db.query("INSERT INTO parse_attempts(attempt_id,base_id,version,sha256,model,cli_backend,method,status,source_path) VALUES('extra-attempt','extra-0',1,?,'pipeline','pipeline','auto','failed',?)")
      .run(hash(download!.bytes), alias); db.close();
    const plan = await createLibraryStatePlan(f.input);
    const files = plan.files.filter(p => /[\\/]work[\\/]downloads[\\/]/.test(p.targetPath));
    assert.equal(files.length, 2);
    assert.equal(new Set(files.map(p => p.targetPath)).size, 1);
    await applyLibraryStatePlan(await f.review());
    assert.equal((await readdir(join(f.paths.workRoot, 'downloads'), { recursive: true })).filter(p => /\.pdf$/i.test(p)).length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const collision of ['different-content', 'file-directory']) test(`rejects case-fold target collision before writes: ${collision}`, async () => {
  const f = await fixture(1, 1);
  try {
    const inputs = await extraDownloads(f, ['left/one.pdf', 'right/two.pdf']);
    const paths = ['Batch/item.pdf', collision === 'different-content' ? 'batch/ITEM.pdf' : 'batch/item.pdf/two.pdf'];
    const input = { ...f.input, pathRewrites: inputs.map((item, i) => ({ from: item.path, to: join(f.paths.workRoot, 'downloads', paths[i]!) })) };
    const before = await snapshot(f.root);
    await assert.rejects(createLibraryStatePlan(input), /case-fold.*collision/i);
    assert.deepEqual(await snapshot(f.root), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('merges harmless case-sensitive history directory aliases into an applyable plan', async () => {
  const f = await fixture(1, 1);
  try {
    const history = join(f.input.legacyStateRoot, 'runs', 'run-1');
    await put(join(history, 'Batch', 'one.json'), '{}');
    await put(join(history, 'batch', 'two.json'), '[]');
    const script = `import { mock } from 'bun:test'; import { join, resolve } from 'node:path';
      const fs = { ...await import('node:fs/promises') }; const input = JSON.parse(process.argv[1]);
      const history = join(input.legacyStateRoot, 'runs', 'run-1');
      const entries = await fs.readdir(history, { withFileTypes: true });
      if (!entries.some(e => e.name === 'batch')) {
        const alias = Object.create(entries.find(e => e.name === 'Batch')); Object.defineProperty(alias, 'name', {value:'batch'});
        mock.module('node:fs/promises', () => ({ ...fs, readdir: async (path, options) => {
          if (resolve(path) === history) return [...entries, alias];
          const result = await fs.readdir(path, options);
          if (resolve(path) === join(history, 'Batch')) return result.filter(e => e.name === 'one.json');
          if (resolve(path) === join(history, 'batch')) return result.filter(e => e.name === 'two.json');
          return result;
        } }));
      }
      const {createLibraryStatePlan,applyLibraryStatePlan} = await import(${JSON.stringify(new URL('../src/maintenance/library-state-migration.ts', import.meta.url).href)});
      const {canonicalJson} = await import(${JSON.stringify(new URL('../src/shared/manifest.ts', import.meta.url).href)});
      const plan = await createLibraryStatePlan(input); const planFile = process.argv[2];
      await fs.writeFile(planFile, canonicalJson(plan));
      const apply = {...input, planFile, planSha256:plan.sha256};
      await applyLibraryStatePlan(apply); console.log(JSON.stringify(await applyLibraryStatePlan(apply)));`;
    const child = Bun.spawn([process.execPath, '-e', script, JSON.stringify(f.input), f.planFile], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const timer = setTimeout(() => child.kill(), 8000);
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      assert.equal(exit, 0, stderr);
      assert.equal(JSON.parse(stdout).replayed, true);
      assert.deepEqual((await readdir(join(f.paths.runsRoot, 'run-1', 'Batch'))).sort(), ['one.json', 'two.json']);
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('resolves case-fold receipt path aliases before validating the immutable receipt hash', async () => {
  const f = await fixture(1, 1);
  try {
    const db = new Database(f.sourceDb);
    db.query('UPDATE evidence_publications SET receipt_path=?').run(join(f.input.legacyStateRoot, 'runs', 'RUN-1', 'EVIDENCE', 'PUBLICATION.JSON'));
    db.close();
    const original = await readFile(join(f.input.legacyStateRoot, 'runs', 'run-1', 'evidence', 'publication.json'));
    await applyLibraryStatePlan(await f.review());
    const target = new Database(f.paths.databasePath, { readonly: true });
    try {
      const row = target.query('SELECT receipt_path,receipt_sha256 FROM evidence_publications').get() as { receipt_path: string; receipt_sha256: string };
      assert.equal(row.receipt_path, join(f.paths.runsRoot, 'run-1', 'evidence', 'publication.json'));
      assert.equal(row.receipt_sha256, hash(original));
      assert.deepEqual(await readFile(row.receipt_path), original);
    } finally { target.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
