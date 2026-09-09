import { afterEach, expect, test } from 'bun:test';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowmatePaths } from '../src/contracts.ts';
import { applyCatalog, buildCatalog, type CatalogPlan } from '../src/catalog.ts';
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

async function seed(paths: FlowmatePaths): Promise<void> {
  await saveSampleRecord(paths, sample('sample-b'));
  await saveSampleRecord(paths, sample('sample-a'));
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
  for (const directory of ['02_数据集', '03_发票']) {
    expect((await lstat(join(paths.vaultRoot, directory))).isDirectory()).toBe(true);
  }
});

test('builds deterministic Obsidian cards and a compact overview from machine records', async () => {
  const paths = await fixturePaths();
  await seed(paths);
  const first = await buildCatalog(paths);
  const second = await buildCatalog(paths);
  expect(first).toEqual(second);
  await applyCatalog(first);

  for (const directory of ['02_数据集', '03_发票', '04_InvoiceKnowledge']) {
    expect((await lstat(join(paths.vaultRoot, directory))).isDirectory()).toBe(true);
  }
  const card = await Bun.file(join(paths.vaultRoot, '03_发票/public-invoices/sample-a.md')).text();
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

  const knowledge = await Bun.file(join(paths.vaultRoot, '04_InvoiceKnowledge/chinatax/notice--20260908T000000000Z--abc.md')).text();
  expect(knowledge).toContain('applicable_period: 2024-11');
  expect(knowledge).toContain('parse: raw_only');
  expect(knowledge).toContain('Structured mirror: unavailable (raw_only)');
  expect(knowledge).not.toContain('Structured mirror](');
  expect(knowledge).toContain('Parse result: unavailable (raw_only)');
  const release = await Bun.file(join(paths.vaultRoot, '01_总览.md')).text();
  expect(release).toContain('Release v1');
  expect(release).toContain('manifest.json');
  for (const index of ['Sources', 'Samples', 'Knowledge', 'Releases']) {
    const text = await Bun.file(join(paths.vaultRoot, '01_总览.md')).text();
    expect(text).toContain('generated_by: flowmate-data');
    expect(text).not.toMatch(/supplier|PO|business/i);
  }
});

test('rejects catalog plans that escape the vault or contain conflicting targets', async () => {
  const paths = await fixturePaths();
  const escape: CatalogPlan = { vaultRoot: paths.vaultRoot, directories: [], files: [{ path: '../outside.md', content: '---\ngenerated_by: flowmate-data\n---\n' }] };
  await expect(applyCatalog(escape)).rejects.toThrow('CATALOG_PATH_TRAVERSAL');
  const absolute: CatalogPlan = { vaultRoot: paths.vaultRoot, directories: [], files: [{ path: join(paths.vaultRoot, 'outside.md'), content: '---\ngenerated_by: flowmate-data\n---\n' }] };
  await expect(applyCatalog(absolute)).rejects.toThrow(/CATALOG_PATH_(ABSOLUTE|TRAVERSAL)/);
  const conflict: CatalogPlan = { vaultRoot: paths.vaultRoot, directories: ['01_Index'], files: [{ path: '01_Index', content: '---\ngenerated_by: flowmate-data\n---\n' }] };
  await expect(applyCatalog(conflict)).rejects.toThrow('CATALOG_DUPLICATE_TARGET');
});

test('catalog bytes are stable when source insertion order changes', async () => {
  const paths = await fixturePaths();
  await saveSampleRecord(paths, sample('sample-b'));
  await saveSampleRecord(paths, sample('sample-a'));
  await applyCatalog(await buildCatalog(paths));
  const pathsToCompare = ['01_总览.md', '02_数据集/public-invoices.md', '03_发票/public-invoices/sample-a.md', '03_发票/public-invoices/sample-b.md'];
  const firstBytes = await Promise.all(pathsToCompare.map(relativePath => Bun.file(join(paths.vaultRoot, relativePath)).text()));
  await rm(paths.dataRoot, { recursive: true, force: true });
  await saveSampleRecord(paths, sample('sample-a'));
  await saveSampleRecord(paths, sample('sample-b'));
  await applyCatalog(await buildCatalog(paths));
  const secondBytes = await Promise.all(pathsToCompare.map(relativePath => Bun.file(join(paths.vaultRoot, relativePath)).text()));
  expect(secondBytes).toEqual(firstBytes);
});

test('rebuilds deleted generated cards while preserving user notes and rejecting hand-written collisions', async () => {
  const paths = await fixturePaths(); await seed(paths);
  const plan = await buildCatalog(paths); await applyCatalog(plan);
  const generated = join(paths.vaultRoot, '03_发票/public-invoices/sample-a.md');
  const obsolete = join(paths.vaultRoot, '02_Sources/jiangsu-digital-invoice-sample.md');
  await Bun.write(obsolete, '---\ngenerated_by: flowmate-data\nschema_version: 1\n---\n# stale\n');
  await rm(generated);
  await writeFile(join(paths.vaultRoot, '03_发票/public-invoices/user-note.md'), '# keep me\n');
  await applyCatalog(await buildCatalog(paths));
  expect(await Bun.file(generated).exists()).toBe(true);
  expect(await Bun.file(obsolete).exists()).toBe(false);
  expect(await Bun.file(join(paths.vaultRoot, '03_发票/public-invoices/user-note.md')).text()).toBe('# keep me\n');

  const editedGenerated = '---\ngenerated_by: flowmate-data\nschema_version: 1\n---\n# edited by user\n';
  await writeFile(generated, editedGenerated);
  await applyCatalog(await buildCatalog(paths));
  expect(await readFile(generated, 'utf8')).not.toBe(editedGenerated);

  await writeFile(generated, '# handwritten\n');
  await expect(applyCatalog(await buildCatalog(paths))).rejects.toThrow('CATALOG_USER_FILE_CONFLICT');
  expect(await readFile(generated, 'utf8')).toBe('# handwritten\n');
});

test('runs catalog build through the CLI with the configured paths', async () => {
  const paths = await fixturePaths(); await seed(paths);
  const config = join(paths.projectRoot, 'paths.json');
  await writeFile(config, JSON.stringify(paths));
  const output: unknown[] = [];
  expect(await runCli(['catalog', 'build', '--paths', config, '--config', workbenchPath], { print: value => output.push(value) })).toBe(0);
  expect(output).toEqual([{ files: expect.any(Number) }]);
  expect(await Bun.file(join(paths.vaultRoot, '01_总览.md')).exists()).toBe(true);
});
