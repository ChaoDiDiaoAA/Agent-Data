import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { archiveFileManifest, canonicalJson } from '../src/shared/manifest.ts';
import { verifyArchiveV2 } from '../src/shared/archive-v2.ts';
import { archiveContext, archiveTestPdf } from './fixtures/library-paths.ts';
import { createArchiveMigrationPlan, applyArchiveMigration, type ArchiveMigrationPlan } from '../src/maintenance/archive-migration.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function fixture(count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'archive-migration-'));
  const legacyArchiveRoot = join(root, 'old', 'extracted');
  const { libraryPaths: paths, libraryId } = archiveContext(join(root, 'new'));
  await mkdir(legacyArchiveRoot, { recursive: true });
  const pdf = await archiveTestPdf();
  for (let i = 1; i <= count; i++) {
    const oldRoot = join(legacyArchiveRoot, `run-${i}`);
    const pdfPath = `pdf/${hash(pdf)}.pdf`;
    const payloads = new Map<string, string | Uint8Array>([
      [pdfPath, pdf], ['normalized/full.md', '# Paper\n![one](assets/a.png)\n![copy](assets/b.png)\n'],
      ['normalized/pages.json', '[{"page":1,"text":"paper"}]'],
      ['normalized/content-list.json', '[{"type":"image","img_path":"assets/b.png","page_idx":0}]'],
      ['normalized/page-marked.txt', '--- PAGE 1 ---\npaper'],
      ['assets/a.png', 'same-image'], ['assets/b.png', 'same-image'], ['assets/unused.png', 'unused'],
      ['mineru/raw/origin.pdf', pdf], ['mineru/raw/layout.pdf', pdf], ['mineru/raw/span.pdf', pdf],
      ['mineru/raw/middle.json', '{}'], ['mineru/raw/model.json', '{}'], ['mineru/raw/images/a.png', 'same-image'],
    ]);
    for (const [path, bytes] of payloads) {
      await mkdir(resolve(oldRoot, path, '..'), { recursive: true });
      await writeFile(join(oldRoot, path), bytes);
    }
    await writeFile(join(oldRoot, 'source.json'), canonicalJson({ schemaVersion: 1, baseId: `2601.0000${i}`,
      arxivId: `2601.0000${i}v1`, version: 1, title: 'Paper', authors: ['Ada'], categories: ['cs.SE'],
      matchedTracks: ['AI-FSD'], published: '2026-01-01', updated: '2026-01-01', pdfPath, pdfSha256: hash(pdf),
      parseAttemptId: `old-${i}`, model: 'pipeline', cliBackend: 'pipeline', method: 'auto', pageCount: 1,
      normalized: { fullMarkdown: 'normalized/full.md', pages: 'normalized/pages.json',
        contentList: 'normalized/content-list.json', pageMarkedText: 'normalized/page-marked.txt' },
      files: await archiveFileManifest(oldRoot),
    }));
  }
  const input = { legacyArchiveRoot, paths, libraryId };
  const oldRoot = join(legacyArchiveRoot, 'run-1');
  const target = join(paths.archiveRoot, '2601.00001-v1');
  const planFile = join(root, 'reviewed.json');
  const review = async () => {
    const plan = await createArchiveMigrationPlan(input);
    await writeFile(planFile, canonicalJson(plan));
    return { ...input, planFile, planSha256: plan.sha256 };
  };
  return { root, input, oldRoot, target, planFile, review };
}

async function historicalRelativeAssetFixture() {
  const f = await fixture();
  const markdown = '# Paper\n![one](images/a.png)\n';
  const contentList = '[{"type":"image","img_path":"images/a.png","page_idx":0}]';
  await writeFile(join(f.oldRoot, 'normalized/full.md'), markdown);
  await writeFile(join(f.oldRoot, 'normalized/content-list.json'), contentList);
  await rm(join(f.oldRoot, 'mineru/raw/images'), { recursive: true });
  const rawDocumentRoot = join(f.oldRoot, '2506.08311v3', 'auto');
  await mkdir(join(rawDocumentRoot, 'images'), { recursive: true });
  await writeFile(join(rawDocumentRoot, '2506.08311v3.md'), markdown);
  await writeFile(join(rawDocumentRoot, 'images/a.png'), 'historical-image');
  await updateSource(f.oldRoot);
  return { ...f, rawDocumentRoot };
}

async function snapshot(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const path of (await readdir(root, { recursive: true })).sort()) {
    const info = await lstat(join(root, path));
    result.push([path, info.mtimeMs, info.isDirectory() ? null : hash(await readFile(join(root, path)))]);
  }
  return result;
}

async function updateSource(root: string, mutate: (source: any) => void = () => {}) {
  const source = JSON.parse(await readFile(join(root, 'source.json'), 'utf8'));
  source.files = await archiveFileManifest(root);
  mutate(source);
  await writeFile(join(root, 'source.json'), canonicalJson(source));
}

// Filesystem fault injection stays in a subprocess so Bun module mocks cannot
// affect other migration tests. The parent watchdog also bounds microtask loops.
async function migrationProbe(input: Awaited<ReturnType<typeof fixture>>['input'], setup: string) {
  const script = `import { mock } from 'bun:test';
    import { dirname, join, resolve } from 'node:path';
    const fs = { ...await import('node:fs/promises') };
    const input = JSON.parse(process.argv[1]);
    ${setup}
    const { createArchiveMigrationPlan } = await import(${JSON.stringify(new URL('../src/maintenance/archive-migration.ts', import.meta.url).href)});
    try { await createArchiveMigrationPlan(input); console.log('unexpected success'); }
    catch (error) { console.error(String(error)); process.exitCode = 1; }`;
  const child = Bun.spawn([process.execPath, '-e', script, JSON.stringify(input)], { stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill(); }, 2000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code, timedOut };
  } finally { clearTimeout(watchdog); child.kill(); await child.exited; }
}

test('rejects case-colliding ancestors across distinct paper roots before writes', async () => {
  const f = await fixture(2);
  try {
    await mkdir(join(f.input.legacyArchiveRoot, 'Batch'));
    await mkdir(join(f.input.legacyArchiveRoot, 'batch'), { recursive: true });
    await rename(f.oldRoot, join(f.input.legacyArchiveRoot, 'Batch', 'run-1'));
    await rename(join(f.input.legacyArchiveRoot, 'run-2'), join(f.input.legacyArchiveRoot, 'batch', 'run-2'));
    const before = await snapshot(f.root);
    const result = await migrationProbe(f.input, `
      // On case-sensitive volumes the real tree is already the regression.
      // On Windows' default volume, emulate its case-sensitive directory listing
      // while keeping both distinct paper payloads on the real temporary disk.
      const entries = await fs.readdir(input.legacyArchiveRoot, { withFileTypes: true });
      if (!entries.some(e => e.name === 'batch')) {
        const batch = entries.find(e => e.name === 'Batch');
        const alias = Object.create(batch);
        Object.defineProperty(alias, 'name', { value: 'batch' });
        mock.module('node:fs/promises', () => ({ ...fs, readdir: async (path, options) => {
          if (resolve(path) === input.legacyArchiveRoot) return [batch, alias];
          const children = await fs.readdir(path, options);
          if (resolve(path) === join(input.legacyArchiveRoot, 'Batch')) return children.filter(e => e.name === 'run-1');
          if (resolve(path) === join(input.legacyArchiveRoot, 'batch')) return children.filter(e => e.name === 'run-2');
          return children;
        } }));
      }
    `);
    assert.equal(result.timedOut, false, 'case-collision probe exceeded watchdog');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /MIGRATION_INVALID_SOURCE.*case-colliding path/);
    assert.deepEqual(await snapshot(f.root), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects a missing filesystem root promptly within an external watchdog', async () => {
  const f = await fixture();
  try {
    const before = await snapshot(f.root);
    const result = await migrationProbe(f.input, `
      const missing = new Set();
      for (let path = input.paths.dataRoot;; path = dirname(path)) {
        missing.add(path); if (dirname(path) === path) break;
      }
      let probing = false;
      mock.module('node:fs/promises', () => ({ ...fs, lstat: async (path, options) => {
        if (resolve(path) === input.paths.dataRoot) probing = true;
        // Simulate an unavailable volume only after the real legacy-root checks.
        // Each ENOENT still uses asynchronous filesystem I/O, as on a missing drive.
        if (probing && missing.has(resolve(path))) return fs.lstat(join(input.paths.dataRoot, 'absent'), options);
        return fs.lstat(path, options);
      } }));
    `);
    assert.equal(result.timedOut, false, 'missing-root resolution did not reject within 2000ms; watchdog killed child');
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /MIGRATION_PATH_UNSAFE/);
    assert.deepEqual(await snapshot(f.root), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('dry-run is canonical, deterministic, complete and does not create new roots or touch source files', async () => {
  const f = await fixture();
  try {
    const before = await snapshot(f.root);
    const plan = await createArchiveMigrationPlan(f.input);
    assert.deepEqual(await createArchiveMigrationPlan(f.input), plan);
    assert.deepEqual(await snapshot(f.root), before);
    const { sha256, ...body } = plan;
    assert.equal(sha256, hash(canonicalJson(body)));
    const paper = plan.papers[0]!;
    assert.equal(paper.oldRoot, f.oldRoot);
    assert.equal(paper.targetRoot, f.target);
    assert.equal(paper.inputs.length, 15);
    for (const entry of paper.inputs) {
      assert.equal(entry.absolutePath, join(f.oldRoot, entry.path));
      const bytes = await readFile(entry.absolutePath);
      assert.equal(entry.sha256, hash(bytes)); assert.equal(entry.bytes, bytes.length);
    }
    assert.ok(paper.targetFiles.some(x => x.path === 'manifest.json'));
    assert.ok(paper.prunedKinds.includes('duplicate-asset'));
    assert.equal(paper.inputBytes, paper.inputs.reduce((n, x) => n + x.bytes, 0));
    assert.equal(paper.targetBytes, paper.targetFiles.reduce((n, x) => n + x.bytes, 0));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('resolves historical MinerU-relative image references from the matching raw document directory', async () => {
  // Production mutation caught: reverting to exact Archive-root lookup for
  // images/a.png must fail instead of silently losing this historical asset.
  const f = await historicalRelativeAssetFixture();
  try {
    const before = await snapshot(f.input.legacyArchiveRoot);
    const review = await f.review();
    const plan = JSON.parse(await readFile(f.planFile, 'utf8')) as ArchiveMigrationPlan;
    const asset = plan.papers[0]!.targetFiles.find(file => file.path === 'assets/images/a.png');
    assert.deepEqual(asset, { path: 'assets/images/a.png', sha256: hash('historical-image'), bytes: 16 });

    await applyArchiveMigration(review);
    const v2 = await verifyArchiveV2(f.target);
    assert.match(v2.fullMarkdown, /\(assets\/images\/a\.png\)/);
    assert.equal(JSON.parse(await readFile(join(f.target, 'content-list.json'), 'utf8'))[0].img_path, 'assets/images/a.png');
    assert.equal(await readFile(join(f.target, 'assets/images/a.png'), 'utf8'), 'historical-image');
    assert.deepEqual(await snapshot(f.input.legacyArchiveRoot), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects historical relative references without a raw MinerU markdown counterpart', async () => {
  // Production mutation caught: falling back to an arbitrary suffix match when
  // no raw document establishes the reference root must remain impossible.
  const f = await fixture();
  try {
    await writeFile(join(f.oldRoot, 'normalized/full.md'), '# Paper\n![one](images/a.png)\n');
    await writeFile(join(f.oldRoot, 'normalized/content-list.json'), '[{"type":"image","img_path":"images/a.png","page_idx":0}]');
    await updateSource(f.oldRoot);
    await assert.rejects(createArchiveMigrationPlan(f.input), /missing raw MinerU markdown counterpart.*images\/a\.png/);
    await assert.rejects(stat(f.input.paths.dataRoot), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects historical relative references with ambiguous raw MinerU markdown counterparts', async () => {
  // Production mutation caught: choosing the first byte-identical raw markdown
  // would make asset resolution depend on traversal order.
  const f = await historicalRelativeAssetFixture();
  try {
    const duplicateRoot = join(f.oldRoot, 'duplicate', 'auto');
    await mkdir(join(duplicateRoot, 'images'), { recursive: true });
    await writeFile(join(duplicateRoot, 'duplicate.md'), await readFile(join(f.oldRoot, 'normalized/full.md')));
    await writeFile(join(duplicateRoot, 'images/a.png'), 'other-image');
    await updateSource(f.oldRoot);
    await assert.rejects(createArchiveMigrationPlan(f.input), /ambiguous raw MinerU markdown counterpart.*images\/a\.png/);
    await assert.rejects(stat(f.input.paths.dataRoot), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects a missing asset relative to the matched raw MinerU document', async () => {
  // Production mutation caught: resolving a missing document-relative asset by
  // a same-suffix file elsewhere in the Archive would accept the wrong bytes.
  const f = await historicalRelativeAssetFixture();
  try {
    await rm(join(f.rawDocumentRoot, 'images/a.png'));
    await updateSource(f.oldRoot);
    await assert.rejects(createArchiveMigrationPlan(f.input), /missing input: 2506\.08311v3\/auto\/images\/a\.png/);
    await assert.rejects(stat(f.input.paths.dataRoot), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects two referenced assets that canonicalize to one destination with different bytes', async () => {
  // Production mutation caught: last-reference-wins output would silently bind
  // both references to one asset while discarding the other referenced bytes.
  const f = await historicalRelativeAssetFixture();
  try {
    const markdown = '# Paper\n![legacy](images/a.png)\n![v2](assets/images/a.png)\n';
    await writeFile(join(f.oldRoot, 'normalized/full.md'), markdown);
    await writeFile(join(f.rawDocumentRoot, '2506.08311v3.md'), markdown);
    await mkdir(join(f.oldRoot, 'assets/images'), { recursive: true });
    await writeFile(join(f.oldRoot, 'assets/images/a.png'), 'different-image');
    await updateSource(f.oldRoot);
    await assert.rejects(createArchiveMigrationPlan(f.input), /ambiguous asset destination: assets\/images\/a\.png/);
    await assert.rejects(stat(f.input.paths.dataRoot), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects canonical destination ownership conflicts before same-byte asset deduplication', async () => {
  // Production mutation caught: assigning ownership only after hash dedup lets
  // a historical asset occupy a modern reference's canonical destination.
  const f = await historicalRelativeAssetFixture();
  try {
    const markdown = '# Paper\n'
      + '![dedup-source](assets/a.jpg)\n'
      + '![canonical-owner](assets/images/hash.jpg)\n'
      + '![historical](images/hash.jpg)\n';
    await writeFile(join(f.oldRoot, 'normalized/full.md'), markdown);
    await writeFile(join(f.oldRoot, 'normalized/content-list.json'), '[]');
    await writeFile(join(f.rawDocumentRoot, '2506.08311v3.md'), markdown);
    await rm(join(f.rawDocumentRoot, 'images/a.png'));
    await writeFile(join(f.oldRoot, 'assets/a.jpg'), 'same-modern-image');
    await mkdir(join(f.oldRoot, 'assets/images'), { recursive: true });
    await writeFile(join(f.oldRoot, 'assets/images/hash.jpg'), 'same-modern-image');
    await writeFile(join(f.rawDocumentRoot, 'images/hash.jpg'), 'different-historical-image');
    await updateSource(f.oldRoot);

    await assert.rejects(createArchiveMigrationPlan(f.input), /ambiguous asset destination: assets\/images\/hash\.jpg/);
    await assert.rejects(stat(f.input.paths.dataRoot), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects case-insensitive file and directory conflicts between asset destinations', async () => {
  // Production mutation caught: validating only exact output-map keys permits
  // both a file and one of its descendants in the planned target tree.
  const f = await historicalRelativeAssetFixture();
  try {
    const markdown = '# Paper\n![file](assets/IMAGES)\n![child](images/hash.jpg)\n';
    await writeFile(join(f.oldRoot, 'normalized/full.md'), markdown);
    await writeFile(join(f.oldRoot, 'normalized/content-list.json'), '[]');
    await writeFile(join(f.rawDocumentRoot, '2506.08311v3.md'), markdown);
    await rm(join(f.rawDocumentRoot, 'images/a.png'));
    await writeFile(join(f.oldRoot, 'assets/IMAGES'), 'modern-file');
    await writeFile(join(f.rawDocumentRoot, 'images/hash.jpg'), 'historical-child');
    await updateSource(f.oldRoot);

    await assert.rejects(createArchiveMigrationPlan(f.input), /conflicting asset destination: assets\/images\/hash\.jpg/);
    await assert.rejects(stat(f.input.paths.dataRoot), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('resolves historical table content references when Markdown assets are already normalized', async () => {
  const f = await historicalRelativeAssetFixture();
  try {
    await mkdir(join(f.oldRoot, 'assets/images'), { recursive: true });
    await writeFile(join(f.oldRoot, 'assets/images/a.png'), 'historical-image');
    await writeFile(join(f.oldRoot, 'normalized/full.md'), '# Paper\n![one](assets/images/a.png)\n');
    await writeFile(join(f.oldRoot, 'normalized/content-list.json'), JSON.stringify([{ type: 'table', table_body: '<img src="images/a.png">', page_idx: 0 }]));
    await writeFile(join(f.oldRoot, 'normalized/pages.json'), JSON.stringify([{ page: 1, text: '<img src="images/a.png">' }]));
    await updateSource(f.oldRoot);
    await applyArchiveMigration(await f.review());
    const v2 = await verifyArchiveV2(f.target);
    assert.equal(v2.manifest.files.filter(file => file.path.startsWith('assets/')).length, 1);
    assert.ok(JSON.stringify(v2.contentList).includes('assets/images/a.png'));
    assert.equal(v2.pages[0]!.text, '<img src="assets/images/a.png">');
    assert.equal(await readFile(join(f.target, 'assets/images/a.png'), 'utf8'), 'historical-image');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('retains assets referenced exclusively in page text through verified migration', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.oldRoot, 'normalized/pages.json'), JSON.stringify([{ page: 1, text: '![page only](assets/unused.png)' }]));
    await updateSource(f.oldRoot);
    await applyArchiveMigration(await f.review());
    const v2 = await verifyArchiveV2(f.target);
    assert.equal(await readFile(join(f.target, 'assets/unused.png'), 'utf8'), 'unused');
    assert.equal(v2.pages[0]!.text, '![page only](assets/unused.png)');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('omits unreferenced raw MinerU images from v2 while preserving the v1 inventory', async () => {
  const f = await historicalRelativeAssetFixture();
  try {
    await writeFile(join(f.rawDocumentRoot, 'images/unused.jpg'), 'unused parser crop');
    await updateSource(f.oldRoot);
    const before = await snapshot(f.input.legacyArchiveRoot);
    const reviewed = await f.review();
    const plan = JSON.parse(await readFile(f.planFile, 'utf8')) as ArchiveMigrationPlan;
    assert.equal(plan.papers[0]!.pruned.find(file => file.path.endsWith('/images/unused.jpg'))?.kind, 'unreferenced-asset');
    await applyArchiveMigration(reviewed);
    assert.equal((await verifyArchiveV2(f.target)).manifest.files.some(file => file.path.endsWith('unused.jpg')), false);
    assert.deepEqual(await snapshot(f.input.legacyArchiveRoot), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('migrates a reserialized MinerU origin PDF as intermediate while preserving authoritative PDF bytes', async () => {
  const f = await fixture();
  try {
    const source = JSON.parse(await readFile(join(f.oldRoot, 'source.json'), 'utf8'));
    const original = await readFile(join(f.oldRoot, source.pdfPath));
    await writeFile(join(f.oldRoot, 'mineru/raw/origin.pdf'), Buffer.concat([original, Buffer.from('\n% rewritten by parser\n')]));
    await updateSource(f.oldRoot);
    const before = await snapshot(f.input.legacyArchiveRoot);
    const reviewed = await f.review();
    const plan = JSON.parse(await readFile(f.planFile, 'utf8')) as ArchiveMigrationPlan;
    assert.equal(plan.papers[0]!.pruned.find(file => file.path === 'mineru/raw/origin.pdf')?.kind, 'mineru-intermediate');
    await applyArchiveMigration(reviewed);
    assert.deepEqual(await readFile(join(f.target, 'source.pdf')), original);
    assert.deepEqual(await snapshot(f.input.legacyArchiveRoot), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects inconsistent case aliases for shared asset destination directories', async () => {
  // Production mutation caught: checking only complete destinations permits
  // Windows to merge assets/IMAGES and assets/images after planning succeeds.
  const f = await historicalRelativeAssetFixture();
  try {
    const markdown = '# Paper\n![modern](assets/IMAGES/a.png)\n![historical](images/b.png)\n';
    await writeFile(join(f.oldRoot, 'normalized/full.md'), markdown);
    await writeFile(join(f.oldRoot, 'normalized/content-list.json'), '[]');
    await writeFile(join(f.rawDocumentRoot, '2506.08311v3.md'), markdown);
    await rm(join(f.rawDocumentRoot, 'images/a.png'));
    await mkdir(join(f.oldRoot, 'assets/IMAGES'), { recursive: true });
    await writeFile(join(f.oldRoot, 'assets/IMAGES/a.png'), 'modern-image');
    await writeFile(join(f.rawDocumentRoot, 'images/b.png'), 'historical-image');
    await updateSource(f.oldRoot);

    await assert.rejects(createArchiveMigrationPlan(f.input), /inconsistent asset destination casing: assets\/images/);
    await assert.rejects(stat(f.input.paths.dataRoot), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const kind of ['pdf', 'metadata', 'pruned', 'extra', 'missing', 'new-paper'] as const) {
  test(`refuses apply before writes when reviewed input drifts: ${kind}`, async () => {
    const f = await fixture();
    try {
      const review = await f.review();
      if (kind === 'pdf') {
        const source = JSON.parse(await readFile(join(f.oldRoot, 'source.json'), 'utf8'));
        await appendFile(join(f.oldRoot, source.pdfPath), 'changed');
      } else if (kind === 'metadata') await appendFile(join(f.oldRoot, 'source.json'), ' ');
      else if (kind === 'pruned') await appendFile(join(f.oldRoot, 'mineru/raw/middle.json'), ' ');
      else if (kind === 'extra') await writeFile(join(f.oldRoot, 'extra.bin'), 'extra');
      else if (kind === 'missing') await rm(join(f.oldRoot, 'assets/b.png'));
      else await cp(f.oldRoot, join(f.input.legacyArchiveRoot, 'new-paper'), { recursive: true });
      await assert.rejects(applyArchiveMigration(review), /MIGRATION_PLAN_DRIFT/);
      await assert.rejects(stat(f.input.paths.dataRoot), { code: 'ENOENT' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const kind of ['wrong-hash', 'body', 'unknown-field', 'escape', 'omitted-input', 'rehashed-forgery', 'noncanonical'] as const) {
  test(`rejects submitted plan drift or forgery: ${kind}`, async () => {
    const f = await fixture();
    try {
      const review = await f.review();
      const plan = JSON.parse(await readFile(f.planFile, 'utf8'));
      if (kind === 'wrong-hash') review.planSha256 = '0'.repeat(64);
      else if (kind === 'body') plan.papers[0].targetBytes++;
      else if (kind === 'unknown-field') plan.ignored = true;
      else if (kind === 'escape') plan.papers[0].targetRoot = join(f.root, 'escape');
      else if (kind === 'omitted-input') plan.papers[0].inputs.pop();
      else if (kind === 'rehashed-forgery') {
        plan.papers[0].targetFiles[0].sha256 = '0'.repeat(64);
        const { sha256: _, ...body } = plan;
        plan.sha256 = review.planSha256 = hash(canonicalJson(body));
      }
      await writeFile(f.planFile, kind === 'noncanonical' ? JSON.stringify(plan, null, 2) : canonicalJson(plan));
      await assert.rejects(applyArchiveMigration(review), /MIGRATION_PLAN_DRIFT/);
      await assert.rejects(stat(f.input.paths.dataRoot), { code: 'ENOENT' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test('migrates to one verified v2 package, prunes copies, rewrites references and verifies replay', async () => {
  const f = await fixture();
  try {
    const before = await snapshot(f.input.legacyArchiveRoot);
    const review = await f.review();
    const plan = JSON.parse(await readFile(f.planFile, 'utf8')) as ArchiveMigrationPlan;
    const result = await applyArchiveMigration(review);
    assert.equal(result.migrated, 1); assert.equal(result.replayed, false);
    assert.ok(result.prunedKinds.includes('mineru-intermediate'));
    const v2 = await verifyArchiveV2(f.target);
    assert.equal(v2.manifest.schemaVersion, 2);
    assert.equal(v2.manifest.libraryId, 'fsd');
    assert.equal(v2.source.parseAttemptId, 'old-1');
    assert.equal(v2.manifest.parser.version, 'unknown-v1');
    assert.deepEqual((await readdir(f.target)).sort(), ['assets', 'content-list.json', 'document.md', 'manifest.json', 'pages.json', 'source.json', 'source.pdf']);
    assert.equal((await readdir(join(f.target, 'assets'))).length, 1);
    assert.ok(!v2.fullMarkdown.includes('assets/b.png'));
    for (const entry of plan.papers[0]!.targetFiles) assert.equal(hash(await readFile(join(f.target, entry.path))), entry.sha256);
    const targetBefore = await snapshot(f.input.paths.archiveRoot);
    const replay = await applyArchiveMigration(review);
    assert.equal(replay.migrated, 0); assert.equal(replay.replayed, true);
    assert.deepEqual(await snapshot(f.input.paths.archiveRoot), targetBefore);
    assert.deepEqual(await snapshot(f.input.legacyArchiveRoot), before);
    assert.deepEqual((await readdir(f.input.paths.dataRoot)).sort(), ['archive', 'work']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const kind of ['empty-existing', 'tamper', 'valid-different', 'extra-target', 'extra-empty-directory', 'missing-target', 'partial-set'] as const) {
  test(`never overwrites or accepts conflicting/partial destinations: ${kind}`, async () => {
    const f = await fixture(kind === 'partial-set' ? 2 : 1);
    try {
      const review = await f.review();
      if (kind === 'empty-existing') await mkdir(f.target, { recursive: true });
      else {
        await applyArchiveMigration(review);
        if (kind === 'tamper') await writeFile(join(f.target, 'document.md'), 'changed');
        if (kind === 'extra-target') await writeFile(join(f.target, 'extra.txt'), 'extra');
        if (kind === 'extra-empty-directory') await mkdir(join(f.target, 'assets', 'unplanned'));
        if (kind === 'missing-target') await rm(join(f.target, 'pages.json'));
        if (kind === 'partial-set') await rm(join(f.input.paths.archiveRoot, '2601.00002-v1'), { recursive: true });
        if (kind === 'valid-different') {
          const manifest = JSON.parse(await readFile(join(f.target, 'manifest.json'), 'utf8'));
          manifest.parser.version = 'different';
          await writeFile(join(f.target, 'manifest.json'), canonicalJson(manifest));
          await verifyArchiveV2(f.target);
        }
      }
      const before = await snapshot(f.input.paths.archiveRoot);
      await assert.rejects(applyArchiveMigration(review), /MIGRATION_TARGET_CONFLICT/);
      assert.deepEqual(await snapshot(f.input.paths.archiveRoot), before);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const kind of ['unknown-file', 'unknown-directory', 'escape-pdf', 'extra-manifest', 'missing-reference', 'metadata', 'duplicate-identity'] as const) {
  test(`dry-run fails closed on unsupported legacy inventory: ${kind}`, async () => {
    const f = await fixture();
    try {
      if (kind === 'unknown-file') { await writeFile(join(f.oldRoot, 'secret.bin'), 'secret'); await updateSource(f.oldRoot); }
      if (kind === 'unknown-directory') await mkdir(join(f.oldRoot, 'unrecognized'));
      if (kind === 'escape-pdf') await updateSource(f.oldRoot, s => { s.pdfPath = '../outside.pdf'; });
      if (kind === 'extra-manifest') await updateSource(f.oldRoot, s => { s.files.push({ path: 'extra.bin', bytes: 0, sha256: hash('') }); });
      if (kind === 'missing-reference') { await writeFile(join(f.oldRoot, 'normalized/full.md'), '![missing](assets/missing.png)'); await updateSource(f.oldRoot); }
      if (kind === 'metadata') await updateSource(f.oldRoot, s => { delete s.authors; });
      if (kind === 'duplicate-identity') await cp(f.oldRoot, join(f.input.legacyArchiveRoot, 'duplicate'), { recursive: true });
      await assert.rejects(createArchiveMigrationPlan(f.input), /MIGRATION_/);
      await assert.rejects(stat(f.input.paths.dataRoot), { code: 'ENOENT' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const kind of ['source-junction', 'input-junction', 'target-junction', 'work-junction', 'plan-junction', 'overlap', 'relative-root', 'root-escape'] as const) {
  test(`rejects unsafe paths without touching external contents: ${kind}`, async () => {
    const f = await fixture();
    try {
      const review = await f.review();
      const outside = join(f.root, 'outside'); await mkdir(outside);
      await writeFile(join(outside, 'sentinel'), 'untouched');
      if (kind === 'source-junction') {
        await rename(f.input.legacyArchiveRoot, join(f.root, 'saved'));
        await symlink(join(f.root, 'saved'), f.input.legacyArchiveRoot, 'junction');
      } else if (kind === 'input-junction') {
        await rename(join(f.oldRoot, 'assets'), join(f.root, 'saved'));
        await symlink(join(f.root, 'saved'), join(f.oldRoot, 'assets'), 'junction');
      } else if (kind === 'target-junction' || kind === 'work-junction') {
        await mkdir(f.input.paths.dataRoot);
        await symlink(outside, kind === 'target-junction' ? f.input.paths.archiveRoot : f.input.paths.workRoot, 'junction');
      } else if (kind === 'plan-junction') {
        await writeFile(join(outside, 'plan.json'), await readFile(f.planFile));
        await symlink(outside, join(f.root, 'plan-link'), 'junction');
        review.planFile = join(f.root, 'plan-link', 'plan.json');
      } else if (kind === 'overlap') review.paths = archiveContext(f.oldRoot).libraryPaths;
      else if (kind === 'relative-root') review.legacyArchiveRoot = './old/extracted';
      else review.paths = { ...review.paths, archiveRoot: outside };
      const before = await snapshot(outside);
      await assert.rejects(applyArchiveMigration(review), /MIGRATION_/);
      assert.deepEqual(await snapshot(outside), before);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test('invalid second paper never exposes that paper as a partial target', async () => {
  const f = await fixture(2);
  try {
    await writeFile(join(f.input.legacyArchiveRoot, 'run-2/normalized/pages.json'), '[{"page":2,"text":"gap"}]');
    await updateSource(join(f.input.legacyArchiveRoot, 'run-2'));
    const review = await f.review();
    await assert.rejects(applyArchiveMigration(review), /MIGRATION_/);
    await assert.rejects(stat(join(f.input.paths.archiveRoot, '2601.00002-v1')), { code: 'ENOENT' });
    assert.equal((await verifyArchiveV2(f.target)).manifest.baseId, '2601.00001');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('an explicitly tagged local v1 source retains its local identity and frozen parser key', async () => {
  const f = await fixture();
  try {
    await updateSource(f.oldRoot, s => {
      for (const key of ['arxivId', 'authors', 'categories', 'matchedTracks', 'published', 'updated']) delete s[key];
      s.sourceKind = 'local_pdf'; s.parserConfigKey = 'frozen-config';
    });
    await applyArchiveMigration(await f.review());
    const v2 = await verifyArchiveV2(f.target);
    assert.equal(v2.manifest.sourceKind, 'local_pdf');
    assert.equal(v2.source.parserConfigKey, 'frozen-config');
    assert.equal(v2.source.arxivId, undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('pure Bun CLI executes reviewed nonempty dry-run/apply/replay and returns nonzero for source drift', async () => {
  const f = await fixture();
  const run = async (args: string[]) => {
    const script = `import { main } from ${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)};
      try { await main(JSON.parse(process.argv[1]), { archiveMigration: JSON.parse(process.argv[2]) }); }
      catch (error) { console.error(String(error)); process.exitCode = 1; }`;
    const child = Bun.spawn([process.execPath, '-e', script, JSON.stringify(['--library', 'fsd', 'archive-migrate', ...args]), JSON.stringify(f.input)], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  try {
    const before = await snapshot(f.input.legacyArchiveRoot);
    const dryRun = await run(['--dry-run', '--format', 'json']);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const plan = JSON.parse(dryRun.stdout);
    assert.equal(dryRun.stdout, canonicalJson(plan));
    await assert.rejects(stat(f.input.paths.dataRoot), { code: 'ENOENT' });
    await writeFile(f.planFile, dryRun.stdout);
    const args = ['--apply', '--plan-file', f.planFile, '--plan-sha256', plan.sha256];
    const apply = await run(args);
    assert.equal(apply.code, 0, apply.stderr); assert.equal(JSON.parse(apply.stdout).migrated, 1);
    const replay = await run(args);
    assert.equal(replay.code, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).replayed, true);
    assert.deepEqual(await snapshot(f.input.legacyArchiveRoot), before);
    await appendFile(join(f.oldRoot, 'mineru/raw/model.json'), 'drift');
    const drift = await run(args);
    assert.notEqual(drift.code, 0); assert.match(drift.stderr, /MIGRATION_PLAN_DRIFT/);
    assert.equal(drift.stdout, '');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('staging failure leaves no target and keeps the legacy source byte-identical', async () => {
  const f = await fixture();
  try {
    const review = await f.review();
    const before = await snapshot(f.input.legacyArchiveRoot);
    await mkdir(f.input.paths.workRoot, { recursive: true });
    await writeFile(join(f.input.paths.workRoot, 'archive-migration'), 'occupied');
    await assert.rejects(applyArchiveMigration(review), /MIGRATION_APPLY_FAILED/);
    await assert.rejects(stat(f.target), { code: 'ENOENT' });
    assert.deepEqual(await snapshot(f.input.legacyArchiveRoot), before);
    assert.deepEqual(await readdir(f.input.paths.workRoot), ['archive-migration']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const failure of ['rename-failure', 'source-drift', 'plan-drift'] as const) {
  test(`installation boundary fails closed with no paper target: ${failure}`, async () => {
    const f = await fixture();
    try {
      const review = await f.review();
      let installs = 0;
      await assert.rejects(applyArchiveMigration({ ...review, install: async (staging: string, target: string) => {
        installs++;
        assert.equal((await verifyArchiveV2(staging)).manifest.baseId, '2601.00001');
        if (failure === 'rename-failure') throw new Error('injected atomic rename failure');
        await rename(staging, target);
        if (failure === 'source-drift') await appendFile(join(f.oldRoot, 'mineru/raw/model.json'), 'changed during install');
        else await appendFile(f.planFile, 'changed during install');
      } }), /MIGRATION_/);
      assert.equal(installs, 1);
      await assert.rejects(stat(f.target), { code: 'ENOENT' });
      const retained = await readdir(join(f.input.paths.workRoot, 'archive-migration'));
      assert.equal(retained.length, 1);
      await verifyArchiveV2(join(f.input.paths.workRoot, 'archive-migration', retained[0]!));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}
