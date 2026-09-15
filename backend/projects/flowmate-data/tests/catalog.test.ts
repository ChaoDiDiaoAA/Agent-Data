import { afterEach, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FlowmatePaths } from '../src/contracts.ts';
import { applyCatalog, buildCatalog, validateCatalogPlan, type CatalogAsset, type CatalogPlan, type CatalogProgress } from '../src/catalog.ts';
import { sha256File } from '../src/file-store.ts';
import { runCli } from '../src/cli.ts';
import { saveSampleRecord, type SampleRecord } from '../src/task-store.ts';

const roots: string[] = [];
const workbenchPath = join(import.meta.dir, 'fixtures/workbench.json');

async function fixturePaths(): Promise<FlowmatePaths> {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-catalog-'));
  roots.push(root);
  return { projectRoot: root, paperEngineRoot: root, originalRoot: join(root, 'original'), dataRoot: join(root, 'data'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') };
}

function sample(sampleId: string): SampleRecord {
  return {
    schema_version: 1, sample_id: sampleId, dataset_id: 'public-invoices', dataset_revision: 'revision-1', source_record_id: `source-${sampleId}`,
    origin_kind: 'public_redacted', document_kind: 'invoice', language: 'zh-CN', layout_group: 'vat',
    original_ref: { root: 'original', path: `datasets/public-invoices/samples/${sampleId}/original.pdf` }, original_sha256: 'a'.repeat(64),
    annotation_ref: { root: 'original', path: `datasets/public-invoices/samples/${sampleId}/annotation.json` }, annotation_sha256: 'b'.repeat(64), source_observations: ['public sample'],
    label_ref: { root: 'data', path: `datasets/public-invoices/samples/${sampleId}/label.json` }, label_sha256: 'c'.repeat(64), label_kind: 'dataset_annotation', mapping_version: 'voxel51/1',
    derived_ref: { root: 'data', path: `datasets/public-invoices/samples/${sampleId}/parsed/attempt-a/normalized` }, parser_key: 'mineru@1', parse_attempt_id: 'attempt-a', content_sha256: 'd'.repeat(64),
    quality_status: 'usable', processing_status: 'processed', allowed_uses: ['development'], created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z',
  };
}

async function seedLegacySampleFiles(paths: FlowmatePaths, sampleId: string): Promise<void> {
  const originalBase = join(paths.originalRoot, 'datasets/public-invoices/samples', sampleId);
  const parsedBase = join(paths.dataRoot, 'datasets/public-invoices/samples', sampleId, 'parsed/attempt-a/normalized');
  await Bun.write(join(originalBase, 'original.pdf'), Buffer.from('%PDF-1.7\nfixture\n'));
  await Bun.write(join(originalBase, 'annotation.json'), JSON.stringify({ sample_id: sampleId, annotation: true }, null, 2) + '\n');
  await Bun.write(join(paths.dataRoot, 'datasets/public-invoices/samples', sampleId, 'label.json'), JSON.stringify({ sample_id: sampleId, fields: {} }) + '\n');
  await Bun.write(join(parsedBase, 'content.md'), `# ${sampleId}\n`);
  await Bun.write(join(parsedBase, 'content.json'), JSON.stringify({ text: sampleId }) + '\n');
  await Bun.write(join(parsedBase, 'pages.json'), JSON.stringify([{ page: 1 }]) + '\n');
  await Bun.write(join(parsedBase, 'parse.json'), JSON.stringify({ sampleId }) + '\n');
}

async function seed(paths: FlowmatePaths): Promise<void> {
  await saveSampleRecord(paths, sample('sample-b'));
  await seedLegacySampleFiles(paths, 'sample-b');
  await saveSampleRecord(paths, sample('sample-a'));
  await seedLegacySampleFiles(paths, 'sample-a');
  const knowledge = {
    schema_version: 1, source_id: 'chinatax', file_id: 'notice', source_url: 'https://example.test/notice.pdf', version: '20260908T000000000Z--abc', retrieved_at: '2026-09-08T00:00:00.000Z', content_sha256: 'e'.repeat(64),
    document_kind: 'knowledge', label_kind: 'none', parse_status: 'raw_only', applicable_period: '2024-11', license_evidence: 'https://example.test/license',
    original_ref: { root: 'original', path: 'knowledge/chinatax/originals/20260908T000000000Z--abc/notice.pdf' }, original_sha256: 'e'.repeat(64),
  };
  await Bun.write(join(paths.dataRoot, 'datasets/public-invoice-knowledge/chinatax/records/notice/20260908T000000000Z--abc.json'), JSON.stringify(knowledge));
  await Bun.write(join(paths.dataRoot, 'releases/v1/manifest.json'), JSON.stringify({ version: 'v1', entries: [{ id: 'sample-a' }] }));
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('creates only the compact invoice catalog directories for an empty vault', async () => {
  const paths = await fixturePaths();
  await applyCatalog(await buildCatalog(paths));
  for (const directory of ['Evidence/indexes', 'Evidence/invoices']) {
    expect((await lstat(join(paths.vaultRoot, directory))).isDirectory()).toBe(true);
  }
});

test('recovers a legacy catalog lock and removes orphaned staging before rebuilding', async () => {
  const paths = await fixturePaths();
  await mkdir(join(paths.vaultRoot, '.flowmate-catalog.lock'), { recursive: true });
  await mkdir(join(paths.vaultRoot, '.flowmate-catalog-staging-legacy'), { recursive: true });
  await Bun.write(join(paths.vaultRoot, '.flowmate-catalog-staging-legacy', 'partial.tmp'), 'partial');

  await applyCatalog(await buildCatalog(paths));

  expect(await Bun.file(join(paths.vaultRoot, 'Evidence/indexes/overview.md')).exists()).toBe(true);
  expect(await Bun.file(join(paths.vaultRoot, '.flowmate-catalog.lock')).exists()).toBe(false);
  expect(await Bun.file(join(paths.vaultRoot, '.flowmate-catalog-staging-legacy', 'partial.tmp')).exists()).toBe(false);
});

test('reclaims a stale owner catalog lock without blocking a rebuild', async () => {
  const paths = await fixturePaths();
  await mkdir(paths.vaultRoot, { recursive: true });
  await writeFile(join(paths.vaultRoot, '.flowmate-catalog.lock'), JSON.stringify({ pid: process.pid, startedAt: 'stale-process-identity', jobId: 'flowmate-catalog', token: 'stale-token' }));

  await applyCatalog(await buildCatalog(paths));

  expect(await Bun.file(join(paths.vaultRoot, 'Evidence/indexes/overview.md')).exists()).toBe(true);
  expect(await Bun.file(join(paths.vaultRoot, '.flowmate-catalog.lock')).exists()).toBe(false);
});

test('builds deterministic Obsidian cards and a compact overview from machine records', async () => {
  const paths = await fixturePaths();
  await seed(paths);
  const first = await buildCatalog(paths);
  const second = await buildCatalog(paths);
  expect(first).toEqual(second);
  await applyCatalog(first);

  for (const directory of ['Evidence/indexes', 'Evidence/invoices', 'Evidence/knowledge']) {
    expect((await lstat(join(paths.vaultRoot, directory))).isDirectory()).toBe(true);
  }
  const card = await Bun.file(join(paths.vaultRoot, 'Evidence/invoices/public-invoices/sample-a/invoice.md')).text();
  expect(card).toContain('generated_by: flowmate-data');
  expect(card).toContain('schema_version: 1');
  expect(card).toContain('dataset: public-invoices');
  expect(card).toContain('revision: revision-1');
  expect(card).toContain('origin: public_redacted');
  expect(card).toContain('document: invoice');
  expect(card).toContain('language: zh-CN');
  expect(card).toContain('label: dataset_annotation');
  expect(card).toContain('parse: parsed');
  expect(card).toContain('license: development');
  expect(card).toContain('Original');
  expect(card).toContain('Original annotation');
  expect(card).toContain('Unified label');
  expect(card).toContain('Structured mirror');
  expect(card).toContain('Parse result');

  const knowledge = await Bun.file(join(paths.vaultRoot, 'Evidence/knowledge/chinatax/notice--20260908T000000000Z--abc/knowledge.md')).text();
  expect(knowledge).toContain('applicable_period: 2024-11');
  expect(knowledge).toContain('parse: raw_only');
  expect(knowledge).toContain('Structured mirror: unavailable (raw_only)');
  expect(knowledge).not.toContain('Structured mirror](');
  expect(knowledge).toContain('Parse result: unavailable (raw_only)');
  const release = await Bun.file(join(paths.vaultRoot, 'Evidence/indexes/overview.md')).text();
  expect(release).toContain('Release v1');
  expect(release).toContain('manifest.json');
  for (const index of ['Sources', 'Samples', 'Knowledge', 'Releases']) {
    const text = await Bun.file(join(paths.vaultRoot, 'Evidence/indexes/overview.md')).text();
    expect(text).toContain('generated_by: flowmate-data');
    expect(text).not.toMatch(/supplier|PO|business/i);
  }
});

test('reports catalog planning progress for invoice assets and the final plan', async () => {
  const paths = await fixturePaths();
  await seed(paths);
  const progress: CatalogProgress[] = [];

  const plan = await buildCatalog(paths, { onProgress: event => { progress.push(event); } });

  const sampleProgress = progress.filter(event => event.phase === 'sample-assets');
  expect(sampleProgress.map(event => `${event.status}:${event.item}`)).toEqual([
    'started:sample-a', 'completed:sample-a',
    'started:sample-b', 'completed:sample-b',
  ]);
  expect(progress.some(event => event.phase === 'sample-assets' && event.status === 'completed' && event.current === 1 && event.total === 2 && event.item === 'sample-a')).toBe(true);
  expect(progress.some(event => event.phase === 'sample-assets' && event.status === 'completed' && event.current === 2 && event.total === 2)).toBe(true);
  expect(progress.at(-1)).toMatchObject({ phase: 'plan', status: 'completed', current: 1, total: 1, detail: `文件 ${plan.files.length} 个，资产 ${plan.assets.length} 个` });
});

test('scopes sample progress to the current task while retaining all local samples in the plan', async () => {
  const paths = await fixturePaths();
  await seed(paths);
  const progress: CatalogProgress[] = [];

  const plan = await buildCatalog(paths, { progressSampleIds: new Set(['sample-b']), onProgress: event => { progress.push(event); } });

  expect(progress.filter(event => event.phase === 'sample-assets').map(event => `${event.status}:${event.item}`)).toEqual([
    'started:sample-b', 'completed:sample-b',
  ]);
  expect(progress.filter(event => event.phase === 'sample-assets').every(event => event.current === 1 && event.total === 1)).toBe(true);
  expect(plan.files.filter(file => file.path.endsWith('/invoice.md'))).toHaveLength(2);
});

test('reports publish progress while writing the Obsidian catalog', async () => {
  const paths = await fixturePaths();
  await seed(paths);
  const plan = await buildCatalog(paths);
  const progress: CatalogProgress[] = [];

  await applyCatalog(plan, { onProgress: event => { progress.push(event); } });

  expect(progress[0]).toMatchObject({ phase: 'publish', status: 'started', current: 0, total: plan.files.length + plan.assets.length });
  expect(progress.some(event => event.phase === 'publish' && event.status === 'progress' && event.current === 1 && event.item)).toBe(true);
  expect(progress.at(-1)).toMatchObject({ phase: 'publish', status: 'completed', current: plan.files.length + plan.assets.length, total: plan.files.length + plan.assets.length, detail: `文件 ${plan.files.length} 个，资产 ${plan.assets.length} 个` });
});

test('rejects catalog plans that escape the vault or contain conflicting targets', async () => {
  const paths = await fixturePaths();
  const escape: CatalogPlan = { vaultRoot: paths.vaultRoot, directories: [], files: [{ path: '../outside.md', content: '---\ngenerated_by: flowmate-data\n---\n' }], assets: [] };
  await expect(applyCatalog(escape)).rejects.toThrow('CATALOG_PATH_TRAVERSAL');
  const absolute: CatalogPlan = { vaultRoot: paths.vaultRoot, directories: [], files: [{ path: join(paths.vaultRoot, 'outside.md'), content: '---\ngenerated_by: flowmate-data\n---\n' }], assets: [] };
  await expect(applyCatalog(absolute)).rejects.toThrow(/CATALOG_PATH_(ABSOLUTE|TRAVERSAL)/);
  const conflict: CatalogPlan = { vaultRoot: paths.vaultRoot, directories: ['01_Index'], files: [{ path: '01_Index', content: '---\ngenerated_by: flowmate-data\n---\n' }], assets: [] };
  await expect(applyCatalog(conflict)).rejects.toThrow('CATALOG_DUPLICATE_TARGET');
  const ancestorConflict: CatalogPlan = {
    vaultRoot: paths.vaultRoot,
    directories: [],
    files: [
      { path: 'Evidence/invoices', content: '---\ngenerated_by: flowmate-data\n---\n' },
      { path: 'Evidence/invoices/sample/invoice.md', content: '---\ngenerated_by: flowmate-data\n---\n' },
    ],
    assets: [],
  };
  expect(() => validateCatalogPlan(ancestorConflict)).toThrow('CATALOG_TARGET_CONFLICT');
});

test('validates a large catalog plan without quadratic target scanning', async () => {
  const paths = await fixturePaths();
  const files = Array.from({ length: 2_000 }, (_, index) => ({
    path: `Evidence/invoices/voxel51/${String(index).padStart(6, '0')}/invoice.md`,
    content: '---\ngenerated_by: flowmate-data\n---\n',
  }));
  expect(validateCatalogPlan({ vaultRoot: paths.vaultRoot, directories: ['Evidence', 'Evidence/invoices', 'Evidence/invoices/voxel51'], files, assets: [] })).toHaveLength(files.length + 3);
});

test('publishes many assets without quadratic target lookup', async () => {
  const paths = await fixturePaths();
  const sourcePath = join(paths.originalRoot, 'source.bin');
  await Bun.write(sourcePath, Buffer.from([1]));
  const sourceSha256 = await sha256File(sourcePath);
  const count = 256;
  let pathReads = 0;
  const assets: CatalogAsset[] = Array.from({ length: count }, (_, index) => {
    const path = `Evidence/assets/${String(index).padStart(4, '0')}.bin`;
    const asset = { path, sourcePath, sha256: sourceSha256, bytes: 1 } as CatalogAsset;
    Object.defineProperty(asset, 'path', { enumerable: true, get: () => { pathReads += 1; return path; } });
    return asset;
  });

  await applyCatalog({ vaultRoot: paths.vaultRoot, directories: ['Evidence', 'Evidence/assets'], files: [], assets });

  expect(pathReads).toBeLessThan(count * 20);
});

test('catalog bytes are stable when source insertion order changes', async () => {
  const paths = await fixturePaths();
  await saveSampleRecord(paths, sample('sample-b'));
  await seedLegacySampleFiles(paths, 'sample-b');
  await saveSampleRecord(paths, sample('sample-a'));
  await seedLegacySampleFiles(paths, 'sample-a');
  const firstPlan = await buildCatalog(paths);
  await applyCatalog(firstPlan);
  const pathsToCompare = ['Evidence/indexes/overview.md', 'Evidence/indexes/public-invoices.md', 'Evidence/invoices/public-invoices/sample-a/invoice.md', 'Evidence/invoices/public-invoices/sample-b/invoice.md'];
  const firstBytes = await Promise.all(pathsToCompare.map(relativePath => Bun.file(join(paths.vaultRoot, relativePath)).text()));
  await rm(paths.dataRoot, { recursive: true, force: true });
  await saveSampleRecord(paths, sample('sample-a'));
  await seedLegacySampleFiles(paths, 'sample-a');
  await saveSampleRecord(paths, sample('sample-b'));
  await seedLegacySampleFiles(paths, 'sample-b');
  const secondPlan = await buildCatalog(paths);
  await applyCatalog(secondPlan);
  const secondBytes = await Promise.all(pathsToCompare.map(relativePath => Bun.file(join(paths.vaultRoot, relativePath)).text()));
  expect(secondBytes).toEqual(firstBytes);
});

test('rebuilds deleted generated cards while preserving user notes and rejecting hand-written collisions', async () => {
  const paths = await fixturePaths(); await seed(paths);
  const plan = await buildCatalog(paths); await applyCatalog(plan);
  const generated = join(paths.vaultRoot, 'Evidence/invoices/public-invoices/sample-a/invoice.md');
  const obsolete = join(paths.vaultRoot, '02_Sources/jiangsu-digital-invoice-sample.md');
  await Bun.write(obsolete, '---\ngenerated_by: flowmate-data\nschema_version: 1\n---\n# stale\n');
  await rm(generated);
  await writeFile(join(paths.vaultRoot, 'Evidence/invoices/public-invoices/sample-a/user-note.md'), '# keep me\n');
  await applyCatalog(await buildCatalog(paths));
  expect(await Bun.file(generated).exists()).toBe(true);
  expect(await Bun.file(obsolete).exists()).toBe(false);
  expect(await Bun.file(join(paths.vaultRoot, 'Evidence/invoices/public-invoices/sample-a/user-note.md')).text()).toBe('# keep me\n');

  const editedGenerated = '---\ngenerated_by: flowmate-data\nschema_version: 1\n---\n# edited by user\n';
  await writeFile(generated, editedGenerated);
  await applyCatalog(await buildCatalog(paths));
  expect(await readFile(generated, 'utf8')).not.toBe(editedGenerated);

  await writeFile(generated, '# handwritten\n');
  await expect(applyCatalog(await buildCatalog(paths))).rejects.toThrow('CATALOG_USER_FILE_CONFLICT');
  expect(await readFile(generated, 'utf8')).toBe('# handwritten\n');
});

test('removes generated files from the previous Chinese layout during migration', async () => {
  const paths = await fixturePaths();
  await seed(paths);
  const legacy = join(paths.vaultRoot, '03_发票/voxel51/legacy.md');
  await mkdir(dirname(legacy), { recursive: true });
  await writeFile(legacy, '---\ngenerated_by: flowmate-data\nschema_version: 1\n---\n# stale\n');
  await applyCatalog(await buildCatalog(paths));
  expect(await Bun.file(legacy).exists()).toBe(false);
  expect(await Bun.file(join(paths.vaultRoot, 'Evidence/invoices/public-invoices/sample-a/invoice.md')).exists()).toBe(true);
});

test('copies catalog assets into the Vault and rejects changed destinations', async () => {
  const paths = await fixturePaths();
  const source = join(paths.originalRoot, 'voxel51', '000001', 'original.jpg');
  await Bun.write(source, Buffer.from([0xff, 0xd8, 0xff, 1]));
  const plan = {
    vaultRoot: paths.vaultRoot,
    directories: ['Evidence/invoices', 'Evidence/invoices/voxel51', 'Evidence/invoices/voxel51/000001'],
    files: [],
    assets: [{ path: 'Evidence/invoices/voxel51/000001/original.jpg', sourcePath: source, sha256: await sha256File(source), bytes: 4 }],
  };
  await applyCatalog(plan);
  await expect(readFile(join(paths.vaultRoot, 'Evidence/invoices/voxel51/000001/original.jpg'))).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 1]));
  await Bun.write(join(paths.vaultRoot, 'Evidence/invoices/voxel51/000001/original.jpg'), 'changed');
  await expect(applyCatalog(plan)).rejects.toThrow('CATALOG_ASSET_CONFLICT');
});

test('migrates generated legacy assets when the Vault has no asset manifest', async () => {
  const paths = await fixturePaths();
  const source = join(paths.originalRoot, 'voxel51', '000001', 'original.jpg');
  const card = join(paths.vaultRoot, 'Evidence/invoices/voxel51/000001/invoice.md');
  const destination = join(paths.vaultRoot, 'Evidence/invoices/voxel51/000001/original.jpg');
  await Bun.write(source, Buffer.from([0xff, 0xd8, 0xff, 1]));
  const plan = {
    vaultRoot: paths.vaultRoot,
    directories: ['Evidence/invoices', 'Evidence/invoices/voxel51', 'Evidence/invoices/voxel51/000001'],
    files: [{ path: 'Evidence/invoices/voxel51/000001/invoice.md', content: '---\ngenerated_by: flowmate-data\nschema_version: 1\n---\n# 000001\n' }],
    assets: [{ path: 'Evidence/invoices/voxel51/000001/original.jpg', sourcePath: source, sha256: await sha256File(source), bytes: 4 }],
  };
  await mkdir(dirname(card), { recursive: true });
  await Bun.write(card, plan.files[0]!.content);
  await Bun.write(destination, Buffer.from('legacy-copy'));

  await applyCatalog(plan);

  await expect(readFile(destination)).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 1]));
  expect(await Bun.file(join(paths.vaultRoot, '.flowmate-assets.json')).exists()).toBe(true);
});

test('rejects a catalog asset whose source changes after planning', async () => {
  const paths = await fixturePaths();
  const source = join(paths.originalRoot, 'voxel51', '000002', 'original.jpg');
  await Bun.write(source, Buffer.from([0xff, 0xd8, 0xff, 2]));
  const plan = {
    vaultRoot: paths.vaultRoot,
    directories: ['Evidence/invoices', 'Evidence/invoices/voxel51', 'Evidence/invoices/voxel51/000002'],
    files: [],
    assets: [{ path: 'Evidence/invoices/voxel51/000002/original.jpg', sourcePath: source, sha256: await sha256File(source), bytes: 4 }],
  };
  await Bun.write(source, Buffer.from([0xff, 0xd8, 0xff, 9]));
  await expect(applyCatalog(plan)).rejects.toThrow('CATALOG_ASSET_SOURCE_HASH_MISMATCH');
});

test('rejects a symlink at a catalog asset destination', async () => {
  const paths = await fixturePaths();
  const source = join(paths.originalRoot, 'voxel51', '000003', 'original.jpg');
  const target = join(paths.originalRoot, 'outside.jpg');
  const destination = join(paths.vaultRoot, 'Evidence/invoices/voxel51/000003/original.jpg');
  await Bun.write(source, Buffer.from([0xff, 0xd8, 0xff, 3]));
  await Bun.write(target, Buffer.from([0xff, 0xd8, 0xff, 4]));
  await Bun.write(join(paths.vaultRoot, 'Evidence/invoices/voxel51/000003/.keep'), '');
  try { await symlink(target, destination, 'file'); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) return;
    throw error;
  }
  const plan = {
    vaultRoot: paths.vaultRoot,
    directories: ['Evidence/invoices', 'Evidence/invoices/voxel51', 'Evidence/invoices/voxel51/000003'],
    files: [],
    assets: [{ path: 'Evidence/invoices/voxel51/000003/original.jpg', sourcePath: source, sha256: await sha256File(source), bytes: 4 }],
  };
  await expect(applyCatalog(plan)).rejects.toThrow('CATALOG_PATH_SYMLINK');
});

async function seedSelfContainedSample(paths: FlowmatePaths, sampleId: string, annotated: boolean): Promise<SampleRecord> {
  const base = `voxel51/${sampleId}`;
  const originalDir = join(paths.originalRoot, base);
  const dataDir = join(paths.dataRoot, base);
  await Bun.write(join(originalDir, 'original.jpg'), Buffer.from([0xff, 0xd8, 0xff, sampleId === 'sample-a' ? 1 : 2]));
  const originalSha256 = await sha256File(join(originalDir, 'original.jpg'));
  const annotation = { sample_id: sampleId, objects: [{ label: 'invoice' }] };
  const annotationBytes = Buffer.from(JSON.stringify(annotation, null, 2) + '\n');
  if (annotated) await Bun.write(join(originalDir, 'annotation.json'), annotationBytes);
  const fieldsBytes = Buffer.from(JSON.stringify({ invoice_number: { value: sampleId, status: 'provided' } }) + '\n');
  if (annotated) await Bun.write(join(dataDir, 'fields.json'), fieldsBytes);
  const record: SampleRecord = {
    schema_version: 1, sample_id: sampleId, dataset_id: 'voxel51-hq-invoice-ocr', dataset_revision: 'revision-1', source_record_id: `source-${sampleId}`,
    origin_kind: 'public_redacted', document_kind: 'invoice', language: 'zh-CN', layout_group: 'vat',
    original_ref: { root: 'original', path: `${base}/original.jpg` }, original_sha256: originalSha256,
    ...(annotated ? { publisher_annotation_status: 'annotated' as const, annotation_ref: { root: 'original' as const, path: `${base}/annotation.json` }, annotation_sha256: await sha256File(join(originalDir, 'annotation.json')), label_ref: { root: 'data' as const, path: `${base}/fields.json` }, label_sha256: await sha256File(join(dataDir, 'fields.json')), label_kind: 'dataset_annotation' as const, mapping_version: 'voxel51/1' } : { publisher_annotation_status: 'unannotated' as const, label_kind: 'none' as const }),
    source_observations: ['public sample'], derived_ref: { root: 'data', path: base }, parser_key: 'mineru@1', parse_attempt_id: `attempt-${sampleId}`, content_sha256: 'd'.repeat(64),
    quality_status: 'usable', processing_status: 'processed', allowed_uses: ['development'], created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z',
  };
  await saveSampleRecord(paths, record);
  const stored = await readFile(join(dataDir, 'record.json'));
  await Bun.write(join(dataDir, 'receipt.json'), JSON.stringify({ sampleId, parserKey: 'mineru@1', attemptId: `attempt-${sampleId}` }) + '\n');
  await Bun.write(join(dataDir, 'content.md'), `# ${sampleId}\n`);
  await Bun.write(join(dataDir, 'content.json'), JSON.stringify({ text: sampleId }) + '\n');
  await Bun.write(join(dataDir, 'pages.json'), JSON.stringify([{ page: 1 }]) + '\n');
  await Bun.write(join(dataDir, 'parse.json'), JSON.stringify({ sampleId, files: [] }) + '\n');
  await Bun.write(join(dataDir, 'assets/logo.png'), Buffer.from([1, 2, 3]));
  for (const name of ['record.json', 'receipt.json', 'content.md', 'content.json', 'pages.json', 'parse.json']) await Bun.write(join(originalDir, name), await readFile(join(dataDir, name)));
  if (annotated) {
    await Bun.write(join(originalDir, 'fields.json'), fieldsBytes);
    await Bun.write(join(originalDir, 'annotation.json'), annotationBytes);
  }
  await Bun.write(join(originalDir, 'snapshot.json'), JSON.stringify({ sample_id: sampleId, files: [] }) + '\n');
  return JSON.parse(stored.toString('utf8')) as SampleRecord;
}

test('builds a self-contained Vault sample with annotation and Release assets', async () => {
  const paths = await fixturePaths();
  await seedSelfContainedSample(paths, 'sample-a', true);
  await seedSelfContainedSample(paths, 'sample-b', false);
  await Bun.write(join(paths.originalRoot, 'voxel51/sample-a/record.json'), '{"mirror_only":true}\n');
  await Bun.write(join(paths.originalRoot, 'voxel51/sample-a/receipt.json'), '{"mirror_only":true}\n');
  await Bun.write(join(paths.dataRoot, 'releases/v1/manifest.json'), JSON.stringify({ version: 'v1', entries: [] }) + '\n');
  await Bun.write(join(paths.dataRoot, 'releases/v1/checksums.json'), JSON.stringify({ schema: 'v1', files: [] }) + '\n');
  const plan = await buildCatalog(paths);
  expect(plan.assets.some(asset => asset.path === 'Evidence/invoices/voxel51/sample-a/original.jpg')).toBe(true);
  await applyCatalog(plan);
  expect(await Bun.file(join(paths.vaultRoot, 'Evidence/invoices/voxel51/sample-a/original.jpg')).exists()).toBe(true);
  expect(await Bun.file(join(paths.vaultRoot, 'Evidence/invoices/voxel51/sample-a/annotation.json')).exists()).toBe(true);
  expect(await Bun.file(join(paths.vaultRoot, 'Evidence/invoices/voxel51/sample-a/fields.json')).exists()).toBe(true);
  expect(await Bun.file(join(paths.vaultRoot, 'Evidence/invoices/voxel51/sample-b/annotation.json')).exists()).toBe(false);
  expect(await Bun.file(join(paths.vaultRoot, 'Evidence/invoices/voxel51/sample-b/content.md')).exists()).toBe(true);
  expect(await readFile(join(paths.vaultRoot, 'Evidence/invoices/voxel51/sample-a/record.json'))).toEqual(await readFile(join(paths.dataRoot, 'voxel51/sample-a/record.json')));
  expect(await readFile(join(paths.vaultRoot, 'Evidence/invoices/voxel51/sample-a/receipt.json'))).toEqual(await readFile(join(paths.dataRoot, 'voxel51/sample-a/receipt.json')));
  expect(await Bun.file(join(paths.vaultRoot, 'Evidence/releases/v1/manifest.json')).exists()).toBe(true);
  const markdown = await Bun.file(join(paths.vaultRoot, 'Evidence/invoices/voxel51/sample-a/invoice.md')).text();
  expect(markdown).not.toContain('file:///');
  expect(markdown).not.toContain(paths.originalRoot);
  expect(markdown).not.toContain(paths.dataRoot);
});

test('regenerates the Vault invoice snapshot from the exact retained asset bytes', async () => {
  const paths = await fixturePaths();
  await seedSelfContainedSample(paths, 'sample-a', true);
  const originalDir = join(paths.originalRoot, 'voxel51/sample-a');
  const dataDir = join(paths.dataRoot, 'voxel51/sample-a');
  for (const name of ['fields.json', 'record.json', 'receipt.json', 'parse.json']) {
    const value = JSON.parse(await readFile(join(dataDir, name), 'utf8'));
    await writeFile(join(originalDir, name), JSON.stringify(value, null, 2) + '\n');
  }
  await mkdir(join(originalDir, 'assets'), { recursive: true });
  await writeFile(join(originalDir, 'assets/logo.png'), await readFile(join(dataDir, 'assets/logo.png')));
  const retained = ['annotation.json', 'assets/logo.png', 'content.json', 'content.md', 'fields.json', 'original.jpg', 'pages.json', 'parse.json', 'receipt.json', 'record.json'];
  const sourceFiles = await Promise.all(retained.map(async path => {
    const sourcePath = join(originalDir, path);
    const bytes = await readFile(sourcePath);
    return { path, sha256: await sha256File(sourcePath), bytes: bytes.byteLength };
  }));
  const oldSnapshot = JSON.stringify({ schema_version: 1, json_format: 'pretty-2', record_sha256: await sha256File(join(dataDir, 'record.json')), files: sourceFiles }, null, 2) + '\n';
  await writeFile(join(originalDir, 'snapshot.json'), oldSnapshot);

  await applyCatalog(await buildCatalog(paths));

  const vaultDir = join(paths.vaultRoot, 'Evidence/invoices/voxel51/sample-a');
  const snapshotBytes = await readFile(join(vaultDir, 'snapshot.json'), 'utf8');
  const snapshot = JSON.parse(snapshotBytes) as { files: Array<{ path: string; sha256: string; bytes: number }> };
  expect(snapshotBytes).not.toBe(oldSnapshot);
  expect(snapshot.files.map(file => file.path)).toEqual(retained);
  for (const file of snapshot.files) {
    const body = await readFile(join(vaultDir, file.path));
    expect(file.bytes).toBe(body.byteLength);
    expect(file.sha256).toBe(await sha256File(join(vaultDir, file.path)));
  }
});

test('rejects conflicting extra assets instead of silently choosing a source', async () => {
  const paths = await fixturePaths();
  await seedSelfContainedSample(paths, 'sample-a', true);
  await Bun.write(join(paths.originalRoot, 'voxel51/sample-a/source-note.txt'), 'original\n');
  await Bun.write(join(paths.dataRoot, 'voxel51/sample-a/source-note.txt'), 'processed\n');
  await expect(buildCatalog(paths)).rejects.toThrow('CATALOG_ASSET_SOURCE_CONFLICT');
});

test('runs catalog build through the CLI with the configured paths', async () => {
  const paths = await fixturePaths(); await seed(paths);
  const config = join(paths.projectRoot, 'paths.json');
  await writeFile(config, JSON.stringify(paths));
  const output: unknown[] = [];
  expect(await runCli(['catalog', 'build', '--paths', config, '--config', workbenchPath], { print: value => output.push(value) })).toBe(0);
  expect(output).toEqual([{ files: expect.any(Number), samples: 2 }]);
  expect(await Bun.file(join(paths.vaultRoot, 'Evidence/indexes/overview.md')).exists()).toBe(true);
});
