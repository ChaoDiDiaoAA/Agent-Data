import { afterEach, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowmatePaths } from '../src/contracts.ts';
import { loadSourceConfig } from '../src/config.ts';
import { createSourceHttp } from '../src/sources/dataset-records.ts';
import { acquireVoxel51Selection } from '../src/sources/voxel51.ts';
import { loadSampleRecords } from '../src/task-store.ts';
import { parseSelection } from '../src/process-samples.ts';
import { runCli } from '../src/cli.ts';
import { canonicalJson, realTree, type ParseDependencies } from '../src/engine-bridge.ts';
import { publicationPaths, recoverPublications } from '../src/publication.ts';
import fixture from './fixtures/voxel51-samples.json';
const roots: string[] = [];
const datasetId = 'voxel51-hq-invoice-ocr';
const config = loadSourceConfig(join(import.meta.dir, '../config/sources/voxel51-invoice-ocr.json'));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-compact-')); roots.push(root);
  await mkdir(join(root, 'config')); await cp(join(import.meta.dir, 'fixtures/mineru.local.json'), join(root, 'config/mineru.local.json'));
  const paths: FlowmatePaths = { projectRoot: root, paperEngineRoot: root, originalRoot: join(root, 'original'), dataRoot: join(root, 'data'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') };
  await writeFile(join(root, 'paths.json'), JSON.stringify(paths));
  return { root, paths };
}
function transport(revision = 'a'.repeat(40), samples = fixture.samples, image = Buffer.from([0xff,0xd8,0xff,1])) {
  return createSourceHttp(config, { fetch: async url => url === config.revision.url ? Response.json({ sha: revision }) : url.endsWith('/samples.json') ? Response.json({ samples }) : new Response(image, { headers: { 'content-type': 'image/jpeg' } }) });
}
const parser = (date: string): ParseDependencies => ({ now: () => new Date(date), createSession: () => ({ async ensureReady() { return 'fake'; }, async run(job) { await cp(join(import.meta.dir, 'fixtures/mineru-output'), job.outputDir, { recursive: true }); return { exitCode: 0 }; }, async dispose() {} }) });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('numeric acquisition completes CLI map, parse, catalog, release, verify and archive restore', async () => {
  const { root, paths } = await setup();
  const flags = ['--paths', join(root, 'paths.json'), '--config', join(import.meta.dir, 'fixtures/workbench.json')];
  const cli = (args: string[]) => runCli([...args, ...flags], { transport: transport(), print() {}, parseDependencies: parser('2026-01-01') });
  expect(await cli(['acquire', 'voxel51-invoice-ocr'])).toBe(0);
  expect(await cli(['labels', 'map', datasetId, '--publish-snapshot'])).toBe(0);
  expect(await cli(['parse'])).toBe(0);
  expect(await acquireVoxel51Selection({ paths, config, selectionId: 'readable-reuse', limit: 1, transport: transport() })).toMatchObject({ added: 0, reused: 1 });
  expect(await cli(['catalog', 'build'])).toBe(0);
  expect(await cli(['release', 'build'])).toBe(0);
  expect(await cli(['verify'])).toBe(0);
  expect(await cli(['backup', 'create', '--verify', '--restore-smoke'])).toBe(0);
  const [record] = await loadSampleRecords(paths, datasetId);
  expect(record!.sample_id).toBe('000001');
  const names = (await realTree(join(paths.originalRoot, 'voxel51/000001'))).filter(name => !name.endsWith('/'));
  expect(names).toEqual(expect.arrayContaining(['original.jpg', 'annotation.json', 'fields.json', 'content.json', 'pages.json', 'content.md', 'record.json']));
  expect(names.some(name => /datasets|samples|structured|parsed|attempt-|normalized/.test(name))).toBe(false);
  for (const name of (await realTree(join(paths.originalRoot, 'voxel51'))).filter(name => name.endsWith('.json'))) {
    const text = await readFile(join(paths.originalRoot, 'voxel51', name), 'utf8');
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + '\n');
  }
  expect((await readdir(paths.originalRoot)).sort()).toEqual(['voxel51']);
  expect((await readdir(paths.vaultRoot)).sort()).toEqual(['.flowmate-assets.json', 'Evidence']);
  expect(await readFile(join(paths.vaultRoot, 'Evidence/indexes/voxel51.md'), 'utf8')).toContain('[[Evidence/invoices/voxel51/000001/invoice]]');
  expect(await readFile(join(paths.vaultRoot, 'Evidence/invoices/voxel51/000001/invoice.md'), 'utf8')).toContain('generated_by: flowmate-data');
});

test('reparse failure retains both latest snapshots; successful reparse replaces the same short paths', async () => {
  const { paths } = await setup();
  await acquireVoxel51Selection({ paths, config, selectionId: 'test', limit: 1, transport: transport() });
  await parseSelection({ paths, selectionId: 'test', limit: 1 }, parser('2026-01-01'));
  const machine = join(paths.dataRoot, 'voxel51/000001'); const mirror = join(paths.originalRoot, 'voxel51/000001');
  const prior = await readFile(join(machine, 'snapshot.json')); const mirrored = await readFile(join(mirror, 'snapshot.json'));
  await expect(parseSelection({ paths, selectionId: 'test', limit: 1 }, { ...parser('2026-01-02'), createSession: () => ({ async ensureReady() { return 'fake'; }, async run() { throw new Error('parser failed'); }, async dispose() {} }) })).rejects.toThrow('parser failed');
  expect(await readFile(join(machine, 'snapshot.json'))).toEqual(prior); expect(await readFile(join(mirror, 'snapshot.json'))).toEqual(mirrored);
  await parseSelection({ paths, selectionId: 'test', limit: 1 }, parser('2026-01-03'));
  expect(await readFile(join(machine, 'snapshot.json'))).not.toEqual(prior);
  expect(JSON.parse(await readFile(join(machine, 'parse.json'), 'utf8')).startedAt).toBe('2026-01-03T00:00:00.000Z');
  expect((await realTree(machine)).some(name => name.includes('attempt-'))).toBe(false);
});

test('resumed selection skips verified parsed invoices and continues with the first incomplete invoice', async () => {
  const { paths } = await setup();
  await acquireVoxel51Selection({ paths, config, selectionId: 'resume', limit: 2, transport: transport() });
  let calls = 0;
  await expect(parseSelection({ paths, selectionId: 'resume', limit: 2 }, {
    ...parser('2026-01-01'),
    createSession: () => ({
      async ensureReady() { return 'fake'; },
      async run(job) {
        calls += 1;
        if (calls === 2) throw new Error('interrupted');
        await cp(join(import.meta.dir, 'fixtures/mineru-output'), job.outputDir, { recursive: true });
        return { exitCode: 0 };
      },
      async dispose() {},
    }),
  })).rejects.toThrow('interrupted');
  const resumed: string[] = [];
  const progress: string[] = [];
  const result = await parseSelection({ paths, selectionId: 'resume', limit: 2, resume: true }, {
    ...parser('2026-01-02'),
    createSession: () => ({
      async ensureReady() { return 'fake'; },
      async run(job) {
        resumed.push(job.fileSource);
        await cp(join(import.meta.dir, 'fixtures/mineru-output'), job.outputDir, { recursive: true });
        return { exitCode: 0 };
      },
      async dispose() {},
    }),
    onProgress: value => { if (value.status === 'skipped') progress.push(value.sampleId); },
  });
  expect(result).toMatchObject({ parsed: 1, skipped: 1, total: 2 });
  expect(progress).toEqual(['000001']);
  expect(resumed).toHaveLength(1);
});

test('parsing a selection reuses one MinerU session for the whole batch', async () => {
  const { paths } = await setup();
  await acquireVoxel51Selection({ paths, config, selectionId: 'session-reuse', limit: 2, transport: transport() });
  let created = 0;
  let runs = 0;
  let disposed = 0;
  await parseSelection({ paths, selectionId: 'session-reuse', limit: 2 }, {
    ...parser('2026-01-01'),
    createSession: () => {
      created += 1;
      return {
        async ensureReady() { return 'fake'; },
        async run(job) {
          runs += 1;
          await cp(join(import.meta.dir, 'fixtures/mineru-output'), job.outputDir, { recursive: true });
          return { exitCode: 0 };
        },
        async dispose() { disposed += 1; },
      };
    },
  });
  expect({ created, runs, disposed }).toEqual({ created: 1, runs: 2, disposed: 1 });
});

test('keeps the machine awake for the active MinerU batch and releases it after completion', async () => {
  const { paths } = await setup();
  await acquireVoxel51Selection({ paths, config, selectionId: 'keep-awake', limit: 2, transport: transport() });
  let acquired = 0;
  let released = 0;
  const dependencies = {
    ...parser('2026-01-01'),
    acquireKeepAwake: () => {
      acquired += 1;
      return { release: () => { released += 1; } };
    },
  } as ParseDependencies & { acquireKeepAwake: () => { release: () => void } | undefined };
  await parseSelection({ paths, selectionId: 'keep-awake' }, dependencies);
  expect({ acquired, released }).toEqual({ acquired: 1, released: 1 });
});

test('releases the keep-awake lease when a MinerU batch fails', async () => {
  const { paths } = await setup();
  await acquireVoxel51Selection({ paths, config, selectionId: 'keep-awake-failure', limit: 1, transport: transport() });
  let acquired = 0;
  let released = 0;
  const dependencies = {
    ...parser('2026-01-01'),
    createSession: () => ({
      async ensureReady() { return 'fake'; },
      async run() { throw new Error('parse failed'); },
      async dispose() {},
    }),
    acquireKeepAwake: () => {
      acquired += 1;
      return { release: () => { released += 1; } };
    },
  } as ParseDependencies & { acquireKeepAwake: () => { release: () => void } | undefined };
  await expect(parseSelection({ paths, selectionId: 'keep-awake-failure' }, dependencies)).rejects.toThrow('parse failed');
  expect({ acquired, released }).toEqual({ acquired: 1, released: 1 });
});

test('persisted IDs survive revised ordering, new source IDs and changed source bytes', async () => {
  const { paths } = await setup();
  await acquireVoxel51Selection({ paths, config, selectionId: 'first', limit: 1, transport: transport() });
  const prior = (await loadSampleRecords(paths, datasetId))[0]!;
  const newRecord = { ...fixture.samples[0]!, _id: { $oid: '000000000000000000000001' } };
  const changed = { ...fixture.samples[0]!, json_annotation: JSON.stringify({ invoice: { invoice_number: 'new-value' } }) };
  await acquireVoxel51Selection({ paths, config, selectionId: 'second', limit: 2, transport: transport('b'.repeat(40), [newRecord, changed], Buffer.from([0xff,0xd8,0xff,9])) });
  const records = await loadSampleRecords(paths, datasetId);
  expect(records.find(record => record.source_record_id === prior.source_record_id)!.sample_id).toBe('000001');
  expect(records.find(record => record.source_record_id === newRecord._id.$oid)!.sample_id).toBe('000002');
  expect(records[0]!.original_sha256).not.toBe(prior.original_sha256);
  expect(records[0]!.annotation_sha256).not.toBe(prior.annotation_sha256);
  expect(await readFile(join(paths.originalRoot, 'voxel51/000001/annotation.json'), 'utf8')).toContain('new-value');
});

for (const interruptedAt of ['data-renamed', 'data-installed', 'original-renamed', 'original-installed', 'rollback-restored'] as const) {
  test(`publication recovers idempotently after ${interruptedAt}`, async () => {
    const { paths } = await setup();
    const plan = await publicationPaths(paths, datasetId, '000001');
    for (const swap of plan.swaps) { await mkdir(swap.stage, { recursive: true }); await mkdir(swap.target, { recursive: true }); await writeFile(join(swap.stage, 'value'), 'new'); await writeFile(join(swap.target, 'value'), 'old'); }
    await writeFile(plan.journal, canonicalJson({ schema_version: 1, dataset_id: datasetId, sample_id: '000001', existed: [true, true] }));
    await rename(plan.swaps[0]!.target, plan.swaps[0]!.backup);
    if (interruptedAt !== 'data-renamed') await rename(plan.swaps[0]!.stage, plan.swaps[0]!.target);
    if (['original-renamed', 'original-installed', 'rollback-restored'].includes(interruptedAt)) await rename(plan.swaps[1]!.target, plan.swaps[1]!.backup);
    if (['original-installed', 'rollback-restored'].includes(interruptedAt)) await rename(plan.swaps[1]!.stage, plan.swaps[1]!.target);
    if (interruptedAt === 'rollback-restored') { await rm(plan.swaps[1]!.target, { recursive: true }); await rename(plan.swaps[1]!.backup, plan.swaps[1]!.target); }
    await recoverPublications(paths); await recoverPublications(paths);
    for (const swap of plan.swaps) expect(await readFile(join(swap.target, 'value'), 'utf8')).toBe('old');
  });
}
