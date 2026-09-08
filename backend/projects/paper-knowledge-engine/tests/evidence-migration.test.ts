import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson } from '../src/evidence/contracts.ts';
import { archiveFileManifest } from '../src/shared/manifest.ts';
import { applyEvidenceMigration, createEvidenceMigrationInventory, refreshEvidenceMigrationMetadata } from '../src/maintenance/evidence-migration.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { routeEvidenceMigrate } from '../src/cli/routes.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const paperRoot = 'Evidence/papers/2601.00001-v1';
const expectedProjection = [
  'Evidence/indexes/authors.md', 'Evidence/indexes/categories.md',
  'Evidence/indexes/tracks.md', 'Evidence/indexes/years.md',
  `${paperRoot}/assets/figure.png`, `${paperRoot}/pages.md`, `${paperRoot}/paper.md`, `${paperRoot}/source.pdf`,
].sort();

async function relativeFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await relativeFiles(join(root, entry.name), path));
    else files.push(path);
  }
  return files.sort();
}

async function snapshotFiles(root: string) {
  return Promise.all((await relativeFiles(root)).map(async path => ({
    path, bytes: (await readFile(join(root, path))).toString('hex'), mtimeMs: (await stat(join(root, path))).mtimeMs,
  })));
}

async function fixture(options: { legacy?: boolean; authors?: string[]; pageGap?: boolean; missingAsset?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'evidence-migration-'));
  const stateRoot = join(root, 'state');
  const vaultRoot = join(root, 'vault');
  const tempRoot = join(root, 'tmp');
  const archiveRoot = join(stateRoot, 'extracted', 'p-2601.00001');
  await mkdir(join(archiveRoot, 'normalized'), { recursive: true });
  await mkdir(join(archiveRoot, 'pdf'), { recursive: true });
  await mkdir(join(archiveRoot, 'assets'), { recursive: true });
  await mkdir(vaultRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  const pdf = 'frozen pdf'; const pdfSha256 = sha256(pdf);
  await writeFile(join(archiveRoot, 'pdf', `${pdfSha256}.pdf`), pdf);
  await writeFile(join(archiveRoot, 'normalized', 'full.md'), options.missingAsset ? '![missing](assets/nope.png)\n' : '![figure](assets/figure.png)\n');
  await writeFile(join(archiveRoot, 'normalized', 'page-marked.txt'), '--- PAGE 1 ---\ntext\n');
  await writeFile(join(archiveRoot, 'normalized', 'pages.json'), JSON.stringify(options.pageGap ? [{ page: 2, text: 'text' }] : [{ page: 1, text: 'text' }]));
  await writeFile(join(archiveRoot, 'normalized', 'content-list.json'), JSON.stringify([]));
  await writeFile(join(archiveRoot, 'assets', 'figure.png'), 'figure');
  const files = await archiveFileManifest(archiveRoot);
  const store = openStateStore(join(stateRoot, 'papers.sqlite'));
  store.upsertDiscovered({ baseId: '2601.00001', arxivId: '2601.00001v1', version: 1, title: options.legacy ? 'Legacy source' : 'Current source',
    authors: options.authors ?? ['Ada Evidence'], categories: ['cs.SE'], matchedTracks: ['AI-FSD'], published: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' });
  const pending = store.reserveParseAttempt({ baseId: '2601.00001', version: 1, sha256: pdfSha256, model: 'pipeline', cliBackend: 'pipeline', method: 'auto', outputDir: archiveRoot });
  assert.ok(pending);
  store.startParseAttempt(pending.attemptId);
  store.finishParseAttempt(pending.attemptId, { outputDir: archiveRoot, pageCount: 1 });
  const source = options.legacy ? {
    baseId: '2601.00001', version: 1, title: 'Legacy source', pdfPath: `pdf/${pdfSha256}.pdf`, pdfSha256,
    parseAttemptId: pending.attemptId, model: 'pipeline', cliBackend: 'pipeline', method: 'auto', pageCount: 1,
    normalized: { fullMarkdown: 'normalized/full.md', pageMarkedText: 'normalized/page-marked.txt', pages: 'normalized/pages.json', contentList: 'normalized/content-list.json' }, files,
  } : {
    schemaVersion: 1, baseId: '2601.00001', arxivId: '2601.00001v1', version: 1, title: 'Current source',
    authors: options.authors ?? ['Ada Evidence'], categories: ['cs.SE'], matchedTracks: ['AI-FSD'],
    published: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', pdfPath: `pdf/${pdfSha256}.pdf`, pdfSha256,
    parseAttemptId: pending.attemptId, model: 'pipeline', cliBackend: 'pipeline', method: 'auto', pageCount: 1,
    normalized: { fullMarkdown: 'normalized/full.md', pageMarkedText: 'normalized/page-marked.txt', pages: 'normalized/pages.json', contentList: 'normalized/content-list.json' }, files,
  };
  await writeFile(join(archiveRoot, 'source.json'), canonicalJson(source));
  if (options.legacy) store.upsertSourceMetadata({ schemaVersion: 1, baseId: '2601.00001', arxivId: '2601.00001v1', version: 1, title: 'Legacy source', authors: ['Ada Evidence'], categories: ['cs.SE'], published: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' });
  return { root, stateRoot, vaultRoot, tempRoot, store, archiveRoot };
}

async function rewriteFrozenSourceManifest(archiveRoot: string, mutate: (source: Record<string, unknown>) => void = () => {}): Promise<void> {
  const source = JSON.parse(await readFile(join(archiveRoot, 'source.json'), 'utf8')) as Record<string, unknown>;
  mutate(source);
  source.files = await archiveFileManifest(archiveRoot);
  await writeFile(join(archiveRoot, 'source.json'), canonicalJson(source));
}

test('inventory is deterministic and read-only for a current validated Archive', async () => {
  const f = await fixture();
  try {
    const first = await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store });
    const second = await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store });
    assert.deepEqual(first, second);
    assert.equal(first.items[0]?.status, 'migratable');
    assert.equal(first.items[0]?.baseId, '2601.00001');
    assert.equal(first.inventorySha256.length, 64);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('inventory adapts a legacy source only with explicit versioned metadata', async () => {
  const f = await fixture({ legacy: true });
  try {
    const inventory = await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store });
    assert.equal(inventory.items[0]?.status, 'migratable');
    assert.equal(inventory.items[0]?.legacy, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('inventory reports metadata, page and asset blockers without inference', async () => {
  const metadata = await fixture({ authors: [] });
  const pages = await fixture({ pageGap: true });
  const assets = await fixture({ missingAsset: true });
  try {
    assert.equal((await createEvidenceMigrationInventory({ stateRoot: metadata.stateRoot, vaultRoot: metadata.vaultRoot, store: metadata.store })).items[0]?.status, 'metadata_missing');
    assert.equal((await createEvidenceMigrationInventory({ stateRoot: pages.stateRoot, vaultRoot: pages.vaultRoot, store: pages.store })).items[0]?.status, 'blocked');
    assert.equal((await createEvidenceMigrationInventory({ stateRoot: assets.stateRoot, vaultRoot: assets.vaultRoot, store: assets.store })).items[0]?.status, 'blocked');
  } finally {
    metadata.store.close(); pages.store.close(); assets.store.close();
    await Promise.all([rm(metadata.root, { recursive: true, force: true }), rm(pages.root, { recursive: true, force: true }), rm(assets.root, { recursive: true, force: true })]);
  }
});

test('inventory requires the exact selected successful SQLite parse attempt and archived output identity', async () => {
  const f = await fixture();
  try {
    await rewriteFrozenSourceManifest(f.archiveRoot, source => { source.parseAttemptId = 'different-attempt'; });
    assert.equal((await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store })).items[0]?.status, 'blocked');
    await rewriteFrozenSourceManifest(f.archiveRoot, source => { source.parseAttemptId = f.store.findSuccessfulParse({ baseId: '2601.00001', version: 1, sha256: String(source.pdfSha256), model: 'pipeline', method: 'auto' })?.attemptId; });
    const original = f.store.findSuccessfulParse;
    (f.store as unknown as { findSuccessfulParse: () => undefined }).findSuccessfulParse = () => undefined;
    assert.equal((await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store })).items[0]?.status, 'missing');
    (f.store as unknown as { findSuccessfulParse: typeof original }).findSuccessfulParse = original;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('migration reuses production asset discovery for reference Markdown, HTML source/srcset, and content-list fields', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.archiveRoot, 'normalized', 'full.md'), [
      '![reference][figure]', '[figure]: assets/reference.png',
      '<img src="assets/html.png">', '<source srcset="assets/src-1.png 1x, assets/src-2.png 2x">', '',
    ].join('\n'));
    await writeFile(join(f.archiveRoot, 'normalized', 'content-list.json'), JSON.stringify([{ image_path: 'assets/content-list.png' }]));
    await Promise.all(['reference.png', 'html.png', 'src-1.png', 'src-2.png', 'content-list.png'].map(name => writeFile(join(f.archiveRoot, 'assets', name), name)));
    await rewriteFrozenSourceManifest(f.archiveRoot);
    assert.equal((await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store })).items[0]?.status, 'migratable');
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('empty first-run inventory is a valid no-op', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-migration-empty-'));
  const stateRoot = join(root, 'state'); await mkdir(stateRoot, { recursive: true });
  const store = openStateStore(join(stateRoot, 'papers.sqlite'));
  try {
    const inventory = await createEvidenceMigrationInventory({ stateRoot, vaultRoot: join(root, 'vault'), store });
    assert.deepEqual(inventory.items, []);
    assert.equal(inventory.counts.migratable, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('migration route accepts only an explicit JSON dry-run on an empty first run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-migration-route-'));
  const stateRoot = join(root, 'state'); await mkdir(stateRoot, { recursive: true });
  const store = openStateStore(join(stateRoot, 'papers.sqlite'));
  try {
    const result = await routeEvidenceMigrate(['--dry-run', '--format', 'json'], {
      config: { stateRoot, vaultRoot: join(root, 'vault'), tempRoot: join(root, 'tmp') }, store,
    });
    assert.equal(result.inventory.counts.migratable, 0);
    await assert.rejects(routeEvidenceMigrate(['--apply'], { config: { stateRoot, vaultRoot: join(root, 'vault'), tempRoot: join(root, 'tmp') }, store }), /inventory-sha256/i);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('route dry-run opens an existing SQLite database read-only and never creates an absent one', async () => {
  const f = await fixture();
  const databasePath = join(f.stateRoot, 'papers.sqlite');
  try {
    f.store.close();
    const beforeBytes = await readFile(databasePath);
    const beforeStat = await stat(databasePath);
    const beforeEntries = await readdir(f.stateRoot);
    const result = await routeEvidenceMigrate(['--dry-run', '--format', 'json'], {
      config: { stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, tempRoot: f.tempRoot },
    });
    assert.equal(result.inventory.items[0]?.status, 'migratable');
    assert.deepEqual(await readFile(databasePath), beforeBytes);
    assert.equal((await stat(databasePath)).mtimeMs, beforeStat.mtimeMs);
    assert.deepEqual(await readdir(f.stateRoot), beforeEntries);
    const emptyRoot = join(f.root, 'no-database-state'); await mkdir(emptyRoot);
    await routeEvidenceMigrate(['--dry-run', '--format', 'json'], { config: { stateRoot: emptyRoot, vaultRoot: f.vaultRoot, tempRoot: f.tempRoot } });
    assert.deepEqual(await readdir(emptyRoot), []);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('apply is bound to the reviewed inventory hash and publishes only a validated item', async () => {
  const f = await fixture();
  try {
    const inventory = await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store });
    await assert.rejects(applyEvidenceMigration({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, tempRoot: f.tempRoot, store: f.store, inventorySha256: '0'.repeat(64) }), /inventory SHA-256/i);
    const result = await applyEvidenceMigration({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, tempRoot: f.tempRoot, store: f.store, inventorySha256: inventory.inventorySha256 });
    assert.equal(result.published, 1);
    assert.deepEqual(await relativeFiles(f.vaultRoot), expectedProjection);
    assert.equal(await readFile(join(f.vaultRoot, paperRoot, 'source.pdf'), 'utf8'), 'frozen pdf');
    assert.match(await readFile(join(f.vaultRoot, paperRoot, 'paper.md'), 'utf8'), /Ada Evidence/);
    const after = await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store });
    assert.equal(after.items[0]?.status, 'already_published');
    const beforeReplay = await snapshotFiles(f.vaultRoot);
    const replay = await applyEvidenceMigration({ ...f, inventorySha256: after.inventorySha256 });
    assert.equal(replay.published, 0);
    assert.equal(replay.replayed, 1);
    assert.deepEqual(await snapshotFiles(f.vaultRoot), beforeReplay);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('synthetic inventory migration delegates verified pending Archives to the historical service', async () => {
  const f = await fixture();
  const calls: unknown[] = [];
  try {
    const inventory = await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store });
    const result = await applyEvidenceMigration({
      stateRoot: f.stateRoot,
      vaultRoot: f.vaultRoot,
      tempRoot: f.tempRoot,
      store: f.store,
      inventorySha256: inventory.inventorySha256,
      publishRunEvidence: async input => {
        calls.push(input);
        return {
          status: 'completed', publicationId: 'migration-service', contentSha256: 'e'.repeat(64),
          receiptPath: 'migration-receipt', receiptSha256: 'f'.repeat(64), sourceCount: 1,
          reservationReplayed: false, applyReplayed: false,
        };
      },
    });

    assert.equal(result.published, 1);
    assert.equal(result.replayed, 0);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { eligibility: string }).eligibility, 'historical');
    assert.equal((calls[0] as { historicalVerifiedSources: unknown[] }).historicalVerifiedSources.length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('synthetic inventory migration reservation rejection leaves Vault, receipt, and staging untouched', async () => {
  const f = await fixture();
  let runId: string | undefined;
  try {
    const inventory = await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store });
    await assert.rejects(applyEvidenceMigration({
      stateRoot: f.stateRoot,
      vaultRoot: f.vaultRoot,
      tempRoot: f.tempRoot,
      store: f.store,
      inventorySha256: inventory.inventorySha256,
      publishRunEvidence: async input => {
        runId = input.runId;
        throw new Error('EVIDENCE_CONFLICT: reservation rejected');
      },
    }), /EVIDENCE_CONFLICT: reservation rejected/);

    assert.ok(runId);
    assert.equal(f.store.getRun(runId)?.status, 'failed');
    await assert.rejects(readFile(join(f.stateRoot, 'runs', runId, 'evidence', 'publication.json')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(f.vaultRoot), []);
    assert.deepEqual(await readdir(f.tempRoot), []);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('synthetic migration failure handling never overwrites a run already completed by the service', async () => {
  const f = await fixture();
  let runId: string | undefined;
  try {
    const inventory = await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store });
    await assert.rejects(applyEvidenceMigration({
      stateRoot: f.stateRoot,
      vaultRoot: f.vaultRoot,
      tempRoot: f.tempRoot,
      store: f.store,
      inventorySha256: inventory.inventorySha256,
      publishRunEvidence: async input => {
        runId = input.runId;
        input.store.completeEmptyRun(input.runId, input.lastSuccess);
        throw new Error('observer failed after completion');
      },
    }), /observer failed after completion/);

    assert.ok(runId);
    assert.equal(f.store.getRun(runId)?.status, 'completed');
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('migration replay counts stay in paper units while historicalRuns stays in run units', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-migration-counts-'));
  const stateRoot = join(root, 'state'); const vaultRoot = join(root, 'vault'); const tempRoot = join(root, 'tmp');
  await Promise.all([mkdir(stateRoot), mkdir(vaultRoot), mkdir(tempRoot)]);
  const store = {
    listRunsByStatus: () => [{ run_id: 'retired-replayed', to_utc: '2026-09-02T00:00:00.000Z' }],
  } as unknown as ReturnType<typeof openStateStore>;
  try {
    const inventory = await createEvidenceMigrationInventory({ stateRoot, vaultRoot, store });
    const result = await applyEvidenceMigration({
      stateRoot,
      vaultRoot,
      tempRoot,
      store,
      inventorySha256: inventory.inventorySha256,
      publishRunEvidence: async () => ({
        status: 'completed', publicationId: 'historical-replay', contentSha256: 'c'.repeat(64),
        receiptPath: 'historical-receipt', receiptSha256: 'd'.repeat(64), sourceCount: 3,
        reservationReplayed: true, applyReplayed: true,
      }),
    });

    assert.deepEqual(result, { inventory, published: 0, replayed: 0, historicalRuns: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retired waiting-run migration delegates to the historical service and propagates reservation rejection without writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-migration-waiting-'));
  const stateRoot = join(root, 'state'); const vaultRoot = join(root, 'vault'); const tempRoot = join(root, 'tmp');
  await Promise.all([mkdir(stateRoot), mkdir(vaultRoot), mkdir(tempRoot)]);
  const calls: unknown[] = [];
  const store = {
    listRunsByStatus: () => [{ run_id: 'retired-run', to_utc: '2026-09-02T00:00:00.000Z' }],
  } as unknown as ReturnType<typeof openStateStore>;
  try {
    const inventory = await createEvidenceMigrationInventory({ stateRoot, vaultRoot, store });
    await assert.rejects(applyEvidenceMigration({
      stateRoot,
      vaultRoot,
      tempRoot,
      store,
      inventorySha256: inventory.inventorySha256,
      publishRunEvidence: async input => {
        calls.push(input);
        throw new Error('EVIDENCE_CONFLICT: reservation rejected');
      },
    }), /EVIDENCE_CONFLICT: reservation rejected/);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      runId: 'retired-run', stateRoot, tempRoot, vaultRoot, store,
      lastSuccess: '2026-09-02T00:00:00.000Z', eligibility: 'historical',
    });
    await assert.rejects(readFile(join(stateRoot, 'runs', 'retired-run', 'evidence', 'publication.json')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(vaultRoot), []);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('already_published requires every v3 paper, PDF, asset and aggregate index byte', async () => {
  const f = await fixture();
  try {
    const inventory = await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store });
    await applyEvidenceMigration({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, tempRoot: f.tempRoot, store: f.store, inventorySha256: inventory.inventorySha256 });
    for (const path of expectedProjection) {
      const absolute = join(f.vaultRoot, path), original = await readFile(absolute);
      await writeFile(absolute, 'tampered');
      assert.equal((await createEvidenceMigrationInventory(f)).items[0]?.status, 'conflict', `tampered ${path}`);
      await writeFile(absolute, original);
      assert.equal((await createEvidenceMigrationInventory(f)).items[0]?.status, 'already_published', `restored ${path}`);
      await rm(absolute);
      assert.equal((await createEvidenceMigrationInventory(f)).items[0]?.status, 'conflict', `missing ${path}`);
      await writeFile(absolute, original);
    }
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('migration ignores manual files and links outside exactly Evidence/', async () => {
  const f = await fixture();
  const manualLink = join(f.vaultRoot, 'Evidence-extra');
  try {
    const before = await createEvidenceMigrationInventory(f);
    await mkdir(join(f.vaultRoot, 'README.md'));
    await writeFile(join(f.vaultRoot, 'index.md'), 'manual index');
    await mkdir(join(f.vaultRoot, '01-Evidence'));
    await writeFile(join(f.vaultRoot, '01-Evidence', 'manual.md'), 'old layout is manual');
    const outside = join(f.root, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'note.md'), 'manual note');
    await symlink(outside, manualLink, 'junction');
    assert.deepEqual(await createEvidenceMigrationInventory(f), before);
    await applyEvidenceMigration({ ...f, inventorySha256: before.inventorySha256 });
    assert.equal((await createEvidenceMigrationInventory(f)).items[0]?.status, 'already_published');
    assert.equal(await readFile(join(f.vaultRoot, 'index.md'), 'utf8'), 'manual index');
    assert.equal(await readFile(join(f.vaultRoot, '01-Evidence', 'manual.md'), 'utf8'), 'old layout is manual');
    assert.equal(await readFile(join(outside, 'note.md'), 'utf8'), 'manual note');
    assert.ok((await stat(join(f.vaultRoot, 'README.md'))).isDirectory());
  } finally {
    f.store.close();
    await rm(manualLink, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
  }
});

test('legacy Archive bytes and timestamps remain frozen through v3 inventory, apply and replay', async () => {
  const f = await fixture({ legacy: true });
  try {
    const frozen = await snapshotFiles(f.archiveRoot);
    const inventory = await createEvidenceMigrationInventory(f);
    assert.equal(inventory.items[0]?.legacy, true);
    await applyEvidenceMigration({ ...f, inventorySha256: inventory.inventorySha256 });
    const published = await createEvidenceMigrationInventory(f);
    assert.equal(published.items[0]?.status, 'already_published');
    assert.deepEqual(published, await createEvidenceMigrationInventory(f));
    assert.equal((await applyEvidenceMigration({ ...f, inventorySha256: published.inventorySha256 })).replayed, 1);
    assert.deepEqual(await snapshotFiles(f.archiveRoot), frozen);
    assert.deepEqual(await relativeFiles(f.vaultRoot), expectedProjection);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('migration rejects unexpected managed files and empty directories', async () => {
  const f = await fixture();
  try {
    const inventory = await createEvidenceMigrationInventory(f);
    await applyEvidenceMigration({ ...f, inventorySha256: inventory.inventorySha256 });
    for (const path of ['Evidence/manual.md', `${paperRoot}/source.json`]) {
      await writeFile(join(f.vaultRoot, path), 'manual');
      assert.equal((await createEvidenceMigrationInventory(f)).items[0]?.status, 'conflict');
      await rm(join(f.vaultRoot, path));
    }
    await mkdir(join(f.vaultRoot, 'Evidence', 'unexpected'));
    assert.equal((await createEvidenceMigrationInventory(f)).items[0]?.status, 'conflict');
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('migration accepts empty v3 bootstrap directories but rejects case-alias roots', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.vaultRoot, 'evidence'));
    assert.equal((await createEvidenceMigrationInventory(f)).items[0]?.status, 'conflict');
    await rm(join(f.vaultRoot, 'evidence'), { recursive: true });
    await mkdir(join(f.vaultRoot, 'Evidence', 'papers'), { recursive: true });
    await mkdir(join(f.vaultRoot, 'Evidence', 'indexes'));
    assert.equal((await createEvidenceMigrationInventory(f)).items[0]?.status, 'migratable');
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('migration refuses an Evidence root junction without inspecting its destination', async () => {
  const f = await fixture();
  const evidenceRoot = join(f.vaultRoot, 'Evidence');
  try {
    const outside = join(f.root, 'outside'); await mkdir(outside);
    await symlink(outside, evidenceRoot, 'junction');
    assert.equal((await createEvidenceMigrationInventory(f)).items[0]?.status, 'conflict');
    assert.deepEqual(await readdir(outside), []);
  } finally {
    f.store.close();
    await rm(evidenceRoot, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
  }
});

test('metadata refresh accepts only the exact arXiv identity and never infers authors', async () => {
  const f = await fixture({ legacy: true });
  f.store.upsertSourceMetadata({ schemaVersion: 1, baseId: '2601.00001', arxivId: '2601.00001v1', version: 1, title: 'Legacy source', authors: [], categories: ['cs.SE'], published: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' });
  try {
    const before = await createEvidenceMigrationInventory({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store });
    assert.equal(before.items[0]?.status, 'metadata_missing');
    await assert.rejects(refreshEvidenceMigrationMetadata({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store, inventorySha256: before.inventorySha256,
      refreshMetadata: async () => ({ schemaVersion: 1, baseId: '2601.00001', arxivId: '2601.00001v2', version: 2, title: 'wrong', authors: ['Wrong'], categories: [], published: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' }),
    }), /identity/i);
    const after = await refreshEvidenceMigrationMetadata({ stateRoot: f.stateRoot, vaultRoot: f.vaultRoot, store: f.store, inventorySha256: before.inventorySha256,
      refreshMetadata: async request => ({ schemaVersion: 1, baseId: request.baseId, arxivId: request.arxivId, version: request.version, title: 'Legacy source', authors: ['Refreshed Author'], categories: ['cs.SE'], published: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' }),
    });
    assert.equal(after.items[0]?.status, 'migratable');
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
import { main } from '../src/cli.ts';
import { routeArchiveMigrate } from '../src/cli/routes.ts';
import { archiveContext } from './fixtures/library-paths.ts';

test('archive-migrate CLI dry-run is a read-only canonical plan and apply requires the submitted file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-migration-cli-'));
  try {
    const legacyArchiveRoot = join(root, 'old'); await mkdir(legacyArchiveRoot);
    const { libraryPaths: paths, libraryId } = archiveContext(join(root, 'new'));
    const migration = { legacyArchiveRoot, paths, libraryId };
    let output: unknown;
    await main(['--library', 'fsd', 'archive-migrate', '--dry-run', '--format', 'json'], { archiveMigration: migration, output: v => { output = v; } });
    const plan = output as { sha256: string; papers: unknown[] };
    assert.deepEqual(plan.papers, []); assert.equal(plan.sha256.length, 64);
    assert.deepEqual(await readdir(root), ['old']);
    const planFile = join(root, 'reviewed.json'); await writeFile(planFile, canonicalJson(plan));
    const result = await routeArchiveMigrate(['--apply', '--plan-file', planFile, '--plan-sha256', plan.sha256], { input: migration });
    assert.equal('replayed' in result && result.replayed, true);
    assert.deepEqual((await readdir(root)).sort(), ['old', 'reviewed.json']);
    await assert.rejects(routeArchiveMigrate(['--apply', '--plan-file', join(root, 'absent.json'), '--plan-sha256', plan.sha256], { input: migration }), /MIGRATION_/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const args of [[], ['--dry-run'], ['--dry-run', '--format', 'text'], ['--apply'],
  ['--dry-run', '--apply', '--format', 'json'], ['--dry-run', '--format', 'json', '--unknown'],
  ['--dry-run', '--dry-run', '--format', 'json'], ['--dry-run', '--format', 'json', 'extra'],
  ['--dry-run', '--format', 'json', '--plan-file', 'x'], ['--apply', '--plan-file', '--plan-sha256', 'a'.repeat(64)],
  ['--apply', '--plan-file', 'x', '--plan-sha256', 'bad'], ['--apply', '--plan-file', 'x', '--plan-sha256', 'a'.repeat(64), '--format', 'json'],
]) {
  test(`archive-migrate CLI rejects invalid arguments before configuration: ${args.join(' ')}`, async () => {
    await assert.rejects(main(['--library', 'fsd', 'archive-migrate', ...args], { root: 'missing-config', interactive: false }), /ARCHIVE_MIGRATION_ARGUMENTS/);
  });
}

test('pure Bun archive-migrate reports errors with a nonzero process status', async () => {
  const child = Bun.spawn([process.execPath, 'src/cli.ts', '--library', 'fsd', 'archive-migrate', '--apply'], { stdout: 'pipe', stderr: 'pipe' });
  const stderr = await new Response(child.stderr).text();
  assert.notEqual(await child.exited, 0);
  assert.match(stderr, /ARCHIVE_MIGRATION_ARGUMENTS/);
});
