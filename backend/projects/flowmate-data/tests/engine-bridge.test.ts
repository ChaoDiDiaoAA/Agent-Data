import { afterEach, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as bridge from '../src/engine-bridge.ts';
import type { FlowmatePaths } from '../src/contracts.ts';
import { runCli } from '../src/cli.ts';
import { loadSampleRecords, saveSampleRecord } from '../src/task-store.ts';

const roots: string[] = [];
const fixture = join(import.meta.dir, 'fixtures');
const workbench = join(fixture, 'workbench.json');

test('attempt identity validates every parser-key field and hashes the canonical provenance tuple', () => {
  expect(typeof bridge.deriveParseAttemptId).toBe('function');
  const parserKey = `mineru@3.4.5;sha=${'a'.repeat(40)};model=pipeline;backend=pipeline;method=auto;language=ch;formula=true;table=false`;
  const identity = { parserKey, originalSha256: 'b'.repeat(64), startedAt: '2026-09-08T00:00:00.000Z' };
  expect(bridge.deriveParseAttemptId(identity)).toBe(`attempt-${bridge.hashCanonical(identity)}`);
  const invalidKeys = [
    'mineru@3.4.5', parserKey.replace('3.4.5', ''), parserKey.replace('sha=' + 'a'.repeat(40), 'sha=abc'),
    parserKey.replace('model=pipeline', 'model=unknown'), parserKey.replace('backend=pipeline', 'backend=vlm-engine'),
    parserKey.replace('method=auto', 'method=unknown'), parserKey.replace('language=ch', 'language='),
    parserKey.replace('formula=true', 'formula=1'), parserKey.replace('table=false', 'table=no'), parserKey + ';extra=1', parserKey + '\n',
  ];
  for (const invalid of invalidKeys) expect(() => bridge.deriveParseAttemptId({ ...identity, parserKey: invalid })).toThrow('PARSE_IDENTITY_INVALID');
  for (const startedAt of ['this-is-not-a-date', '2026-02-30T00:00:00.000Z', '2026-09-08']) expect(() => bridge.deriveParseAttemptId({ ...identity, startedAt })).toThrow('PARSE_IDENTITY_INVALID');
  expect(() => bridge.deriveParseAttemptId({ ...identity, originalSha256: 'short' })).toThrow('PARSE_IDENTITY_INVALID');
  expect(() => bridge.deriveParseAttemptId({ ...identity, originalSha256: identity.originalSha256 + '\n' })).toThrow('PARSE_IDENTITY_INVALID');
});
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-parse-')); roots.push(root);
  const paths: FlowmatePaths = { projectRoot: root, paperEngineRoot: join(root, 'engine'), dataRoot: join(root, 'data'), originalRoot: join(root, 'original'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') };
  await mkdir(join(paths.projectRoot, 'config'), { recursive: true });
  await cp(join(import.meta.dir, 'fixtures/mineru.local.json'), join(paths.projectRoot, 'config/mineru.local.json'));
  expect(typeof bridge.createFlowmateMinerURuntime).toBe('function');
  const runtime = bridge.createFlowmateMinerURuntime(paths);
  expect(await Bun.file(join(paths.paperEngineRoot, 'config/engine.yaml')).exists()).toBe(false);
  return { paths, runtime, input: { sampleId: 'invoice-a', sourcePath: join(fixture, 'invoice.png'), outputDir: join(paths.dataRoot, 'datasets', 'test', 'samples', 'invoice-a', 'parsed'), ...runtime } };
}

test('standalone bridge routes only original input, explicit output/config and Flowmate process roots through a disposed session', async () => {
  const { paths, runtime, input } = await setup();
  expect(runtime.lockPath).toBe(join(paths.dataRoot, 'work', 'run.lock'));
  expect(runtime.processContext.safetyRoot).toBe(join(paths.dataRoot, 'work', 'processes'));
  expect(runtime.mineruConfig.tempRoot).toBe(join(paths.dataRoot, 'work'));
  expect(runtime.mineruConfig.libraryId).toBeUndefined();
  let disposed = 0;
  const result = await bridge.parseInvoice(input, { createSession(options) {
    expect(options.config).toBe(input.mineruConfig);
    expect(options.processContext).toBe(input.processContext);
    return { async ensureReady() { return 'fake'; }, async run(job) {
      expect(job.fileSource).toBe(input.sourcePath);
      expect(job.outputDir.startsWith(input.outputDir)).toBe(true);
      expect(Object.keys(job).sort()).toEqual(['fileSource', 'formula', 'language', 'method', 'model', 'outputDir', 'table', 'timeoutMs']);
      expect(await Bun.file(runtime.lockPath).exists()).toBe(true);
      await cp(join(fixture, 'mineru-output'), job.outputDir, { recursive: true });
      return { exitCode: 0, cleanupConfirmed: true };
    }, async dispose() { disposed++; } };
  }, async onParsed(receipt) {
    expect(disposed).toBe(1);
    expect(await Bun.file(runtime.lockPath).exists()).toBe(true);
    expect(await Bun.file(join(receipt.outputDir, 'receipt.json')).exists()).toBe(true);
  } });
  expect(disposed).toBe(1);
  expect(await Bun.file(runtime.lockPath).exists()).toBe(false);
  expect(result.parserKey).toContain('mineru@3.4.5');
  expect(result.parserKey).toContain(input.mineruConfig.expectedCommit);
  for (const key of ['model=', 'backend=', 'method=', 'language=', 'formula=', 'table=']) expect(result.parserKey).toContain(key);
  expect(result.attemptId).toMatch(/^attempt-[0-9a-f]{64}$/);
  expect(await bridge.verifyNormalizedOutput(result.normalizedDir)).toMatchObject({ contentHash: result.contentHash });
  expect(await readFile(join(result.normalizedDir, 'assets', 'images', 'invoice.png'))).toEqual(await readFile(join(fixture, 'invoice.png')));
});

test('Flowmate MinerU runtime requires its own config and never falls back to engine.yaml', async () => {
  const { paths } = await setup();
  await unlink(join(paths.projectRoot, 'config/mineru.local.json'));
  await mkdir(join(paths.paperEngineRoot, 'config'), { recursive: true });
  await cp(join(import.meta.dir, '../../paper-knowledge-engine/config/engine.yaml'), join(paths.paperEngineRoot, 'config/engine.yaml'));
  expect(() => bridge.createFlowmateMinerURuntime(paths)).toThrow('FLOWMATE_MINERU_CONFIG_INVALID');
});

for (const mode of ['missing', 'failed', 'throw', 'dispose-failed'] as const) test(`parse rejects ${mode} and disposes the session`, async () => {
  const { input } = await setup(); let disposed = 0;
  await expect(bridge.parseInvoice(input, { createSession() { return {
    async ensureReady() { return 'fake'; }, async run(job) {
      if (mode === 'throw') throw new Error('client failed');
      if (mode === 'dispose-failed') await cp(join(fixture, 'mineru-output'), job.outputDir, { recursive: true });
      return { exitCode: mode === 'failed' ? 1 : 0 };
    }, async dispose() { disposed++; if (mode === 'dispose-failed') throw new Error('cleanup failed'); },
  }; } })).rejects.toThrow({ missing: 'structured content list required', failed: 'MINERU_PARSE_FAILED', throw: 'client failed', 'dispose-failed': 'cleanup failed' }[mode]);
  expect(disposed).toBe(1);
  expect(await Bun.file(input.lockPath).exists()).toBe(false);
});

test('attempts never overwrite old output and changed parser settings produce a different key', async () => {
  const { input } = await setup();
  const dependencies: bridge.ParseDependencies = { now: () => new Date('2026-01-01'), createSession: () => ({ async ensureReady() { return 'fake'; }, async run(job) { await cp(join(fixture, 'mineru-output'), job.outputDir, { recursive: true }); return { exitCode: 0 }; }, async dispose() {} }) };
  const first = await bridge.parseInvoice(input, dependencies);
  const bytes = await readFile(join(first.normalizedDir, 'full.md'));
  await expect(bridge.parseInvoice(input, dependencies)).rejects.toThrow('ATTEMPT_EXISTS');
  expect(await readFile(join(first.normalizedDir, 'full.md'))).toEqual(bytes);
  const second = await bridge.parseInvoice({ ...input, mineruConfig: { ...input.mineruConfig, formulaEnabled: !input.mineruConfig.formulaEnabled } }, dependencies);
  expect(first.parserKey).not.toBe(second.parserKey);
  expect(first.attemptId).not.toBe(second.attemptId);
});

test('rejects roots outside Flowmate work/data, unsupported sources and concurrent run lock', async () => {
  const { input, paths } = await setup();
  await expect(bridge.parseInvoice({ ...input, outputDir: paths.originalRoot })).rejects.toThrow('PATH');
  await expect(bridge.parseInvoice({ ...input, processContext: { ...input.processContext, safetyRoot: paths.originalRoot } })).rejects.toThrow('PATH');
  await expect(bridge.parseInvoice({ ...input, sourcePath: join(fixture, 'invoice.txt') })).rejects.toThrow('SOURCE');
  await mkdir(join(paths.dataRoot, 'work'), { recursive: true }); await writeFile(input.lockPath, '{}');
  await expect(bridge.parseInvoice(input)).rejects.toThrow('PROJECT_BUSY');
});

test('parse CLI selects the first image in the committed selection and saves only a verified receipt', async () => {
  const { paths } = await setup();
  const datasetId = 'voxel51-hq-invoice-ocr';
  const originalPath = 'datasets/voxel51-hq-invoice-ocr/samples/invoice-a/original.png';
  await mkdir(join(paths.originalRoot, 'datasets', datasetId, 'samples', 'invoice-a'), { recursive: true });
  await cp(join(fixture, 'invoice.png'), join(paths.originalRoot, originalPath));
  const { sha256File } = await import('../src/file-store.ts');
  await saveSampleRecord(paths, { schema_version: 1, sample_id: 'invoice-a', dataset_id: datasetId, dataset_revision: 'a'.repeat(40), source_record_id: 'source-a', origin_kind: 'synthetic', document_kind: 'invoice', language: 'en', layout_group: null,
    original_ref: { root: 'original', path: originalPath }, original_sha256: await sha256File(join(paths.originalRoot, originalPath)), annotation_sha256: 'b'.repeat(64), source_observations: [], label_kind: 'none', quality_status: 'not_checked', processing_status: 'downloaded', allowed_uses: ['development'], created_at: '', updated_at: '' });
  const selection = { schema_version: 1, source_id: 'voxel51-invoice-ocr', dataset_id: datasetId, selection_id: 'initial-20', revision: 'a'.repeat(40), index_url: `https://huggingface.co/datasets/Voxel51/high-quality-invoice-images-for-ocr/resolve/${'a'.repeat(40)}/samples.json`, index_sha256: 'c'.repeat(64), records: [{ sample_id: 'invoice-a', source_record_id: 'source-a', image_path: 'original.png', annotation_locator: '/samples/0', annotation_sha256: 'b'.repeat(64) }] };
  const selectionPath = join(paths.dataRoot, 'datasets', datasetId, 'selections', 'initial-20.json');
  await Bun.write(selectionPath, bridge.canonicalJson({ ...selection, selection_hash: bridge.hashCanonical(selection) }));
  const pathsFile = join(paths.projectRoot, 'paths.json'); await writeFile(pathsFile, JSON.stringify(paths));
  let runs = 0; let output: unknown;
  expect(await runCli(['parse', '--selection', 'initial-20', '--limit', '1', '--paths', pathsFile, '--config', workbench], { print: value => { output = value; }, parseDependencies: {
    createSession: () => ({ async ensureReady() { return 'fake'; }, async run(job) { runs++; expect(job.fileSource).toBe(join(paths.originalRoot, originalPath)); await cp(join(fixture, 'mineru-output'), job.outputDir, { recursive: true }); return { exitCode: 0 }; }, async dispose() {} }),
  } })).toBe(0);
  expect(runs).toBe(1); expect(output).toMatchObject({ parsed: 1 });
  const [record] = await loadSampleRecords(paths, datasetId);
  expect(record).toMatchObject({ processing_status: 'processed', parser_key: expect.stringContaining('mineru@3.4.5'), parse_attempt_id: expect.stringMatching(/^attempt-/) });
  expect(await Bun.file(join(paths.originalRoot, 'datasets', datasetId, 'samples', 'invoice-a', 'structured', 'snapshot.json')).exists()).toBe(true);
  await writeFile(selectionPath, bridge.canonicalJson({ ...selection, selection_hash: 'd'.repeat(64) }));
  await expect(runCli(['parse', '--selection', 'initial-20', '--limit', '1', '--paths', pathsFile, '--config', workbench])).rejects.toThrow('SELECTION');
});
