import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOrResumeTaskRun,
  markTaskStageCompleted,
  markTaskStageRunning,
  taskStageKeys,
  withTaskRunLock,
  type TaskRunIdentity,
} from '../src/task-run.ts';
import { canonicalJson, createFlowmateMinerURuntime, deriveParseAttemptId, flowmateParserKey, verifyNormalizedOutput } from '../src/engine-bridge.ts';
import { sampleDirectory } from '../src/layout.ts';
import type { FlowmatePaths } from '../src/contracts.ts';
import { isReusableParsedSample } from '../src/process-samples.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function identity(configHash = 'a'.repeat(64)): TaskRunIdentity {
  return {
    source_id: 'voxel51-invoice-ocr',
    dataset_id: 'voxel51-hq-invoice-ocr',
    selection_id: 'current',
    config_sha256: configHash,
    counts: { with_publisher_annotation: 10, without_publisher_annotation: 5 },
  };
}

test('resumes the same incomplete task and preserves completed stages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-task-run-'));
  temporaryDirectories.push(root);
  const paths = { dataRoot: root } as any;

  const first = await createOrResumeTaskRun(paths, identity());
  expect(first.resumed).toBe(false);
  await markTaskStageRunning(first.run, 'acquire');
  await markTaskStageCompleted(first.run, 'acquire');
  await markTaskStageRunning(first.run, 'parse');

  const resumed = await createOrResumeTaskRun(paths, identity());
  expect(resumed.resumed).toBe(true);
  expect(resumed.run.run_id).toBe(first.run.run_id);
  expect(resumed.run.stages.acquire).toBe('completed');
  expect(resumed.run.stages.parse).toBe('running');
});

test('starts a new task when the configuration identity changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-task-run-'));
  temporaryDirectories.push(root);
  const paths = { dataRoot: root } as any;

  const first = await createOrResumeTaskRun(paths, identity());
  await markTaskStageCompleted(first.run, 'acquire');
  const next = await createOrResumeTaskRun(paths, identity('b'.repeat(64)));

  expect(next.resumed).toBe(false);
  expect(next.run.run_id).not.toBe(first.run.run_id);
  expect(next.run.stages.acquire).toBe('pending');
});

test('normalizes a legacy run that stopped at the removed backup stage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-task-legacy-backup-'));
  temporaryDirectories.push(root);
  const paths = { dataRoot: root } as any;

  const first = await createOrResumeTaskRun(paths, identity());
  for (const stage of taskStageKeys) await markTaskStageCompleted(first.run, stage);
  const legacy = JSON.parse(await readFile(first.run.manifest_path, 'utf8')) as Record<string, any>;
  legacy.status = 'failed';
  legacy.failed_stage = 'backup';
  legacy.stages = { ...legacy.stages, backup: 'failed' };
  await writeFile(first.run.manifest_path, canonicalJson(legacy));

  const resumed = await createOrResumeTaskRun(paths, identity());
  expect(resumed.resumed).toBe(true);
  expect(resumed.run.status).toBe('completed');
  expect(Object.keys(resumed.run.stages).sort()).toEqual([...taskStageKeys].sort());
  const normalized = JSON.parse(await readFile(first.run.manifest_path, 'utf8')) as Record<string, any>;
  expect(normalized.status).toBe('completed');
  expect(normalized.stages).not.toHaveProperty('backup');
  expect(normalized).not.toHaveProperty('failed_stage');
});

test('fails closed when an existing run manifest is malformed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-task-manifest-'));
  temporaryDirectories.push(root);
  const paths = { dataRoot: root } as any;
  await mkdir(join(root, 'tasks', 'voxel51', 'runs', 'run-bad'), { recursive: true });
  await writeFile(join(root, 'tasks', 'voxel51', 'runs', 'run-bad', 'run.json'), '{"schema_version":1}');

  await expect(createOrResumeTaskRun(paths, identity())).rejects.toThrow('TASK_RUN_MANIFEST_INVALID');
});

test('holds one workflow lock for the complete task and rejects a concurrent task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-task-lock-'));
  temporaryDirectories.push(root);
  const paths = { dataRoot: root } as any;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = withTaskRunLock(paths, () => held);
  await new Promise(resolve => setTimeout(resolve, 10));
  await expect(withTaskRunLock(paths, async () => undefined)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  release();
  await first;
});

test('skips a previously parsed invoice when its output and parser identity are still valid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-parse-resume-'));
  temporaryDirectories.push(root);
  const paths: FlowmatePaths = {
    projectRoot: join(import.meta.dir, '..'),
    paperEngineRoot: join(root, 'engine'),
    originalRoot: join(root, 'original'),
    dataRoot: join(root, 'data'),
    vaultRoot: join(root, 'vault'),
    backupRoot: join(root, 'backup'),
  };
  const sampleId = 'sample-a';
  const relative = sampleDirectory('voxel51-hq-invoice-ocr', sampleId);
  const original = Buffer.from([0xff, 0xd8, 0xff, 1]);
  await mkdir(join(paths.originalRoot, relative), { recursive: true });
  await writeFile(join(paths.originalRoot, relative, 'original.jpg'), original);
  const markdown = '# invoice';
  const content = [{ text: 'invoice' }];
  const pages = [{ page: 1 }];
  const normalized = join(paths.dataRoot, relative);
  await mkdir(normalized, { recursive: true });
  await writeFile(join(normalized, 'content.md'), markdown);
  await writeFile(join(normalized, 'content.json'), JSON.stringify(content));
  await writeFile(join(normalized, 'pages.json'), JSON.stringify(pages));
  const contentHash = createHash('sha256').update(markdown).update(JSON.stringify(content)).digest('hex');
  const runtime = createFlowmateMinerURuntime(paths);
  const config = runtime.mineruConfig;
  const parserKey = flowmateParserKey(config);
  const startedAt = '2026-09-11T00:00:00.000Z';
  const attemptId = deriveParseAttemptId({ parserKey, originalSha256: createHash('sha256').update(original).digest('hex'), startedAt });
  const verified = await verifyNormalizedOutput(normalized);
  await writeFile(join(normalized, 'parse.json'), canonicalJson({ sampleId, parserKey, attemptId, originalSha256: createHash('sha256').update(original).digest('hex'), startedAt, outputDir: normalized, normalizedDir: normalized, contentHash, files: verified.files }));
  const record = {
    schema_version: 1, sample_id: sampleId, dataset_id: 'voxel51-hq-invoice-ocr', dataset_revision: 'a'.repeat(40), source_record_id: 'source-a',
    origin_kind: 'public_redacted', document_kind: 'invoice', language: 'en', layout_group: null,
    original_ref: { root: 'original', path: `${relative}/original.jpg` }, original_sha256: createHash('sha256').update(original).digest('hex'),
    publisher_annotation_status: 'unannotated', source_observations: [], label_kind: 'none', quality_status: 'not_checked',
    derived_ref: { root: 'data', path: relative }, parser_key: parserKey, parse_attempt_id: attemptId, content_sha256: contentHash,
    processing_status: 'processed', allowed_uses: ['development'], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  await writeFile(join(normalized, 'record.json'), JSON.stringify(record));
  expect(await isReusableParsedSample(paths, record as any, parserKey)).toBe(true);
});
