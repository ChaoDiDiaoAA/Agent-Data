import type { ManagedProcessResult, ManagedProcessSpec, ProcessContext, runManagedProcess } from '../src/runtime/process.ts';
import type { MinerURunnerOptions } from '../src/mineru/mineru-cli-runner.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMinerUArgs, buildMinerUProcessEnv, runMineruCli } from '../src/mineru/mineru-cli-runner.ts';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { after } from 'node:test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { loadMinerULocalConfig } from '../src/mineru/mineru-local-config.ts';
import { openCliPaths } from '../src/runtime/opencli.ts';

const FIXED_API_URL = 'http://127.0.0.1:17860';
type ExpectString<T extends string> = T;
type _MinerURunnerApiUrlMustBeRequired = ExpectString<MinerURunnerOptions['apiUrl']>;

const config = {
  sourceRoot: 'D:\\agent-data\\MinerU',
  venvRoot: 'D:\\agent-data\\MinerU\\.venv',
  model: 'pipeline',
  allowedModels: ['pipeline', 'vlm'],
  cliBackend: 'pipeline',
  modelSourceRuntime: 'local',
  mineruToolsConfig: 'D:\\agent-data\\config\\mineru.runtime.json',
  modelScopeCacheRoot: 'D:\\agent-data\\MinerU\\modelscope',
  taskTimeoutMs: 3600000,
  resultDownloadTimeoutMs: 600000,
  maxConcurrency: 1,
  processingWindowSize: 1,
  pipelineBatchRatio: 1 as const,
  pipelineMethod: 'auto',
  pipelineLanguage: 'ch',
  formulaEnabled: true,
  tableEnabled: true,
  cudaVisibleDevices: '0',
  pipelineDeviceMode: 'cuda',
  vlmDevice: 'cuda',
  vlmLmdeployBackend: 'turbomind',
  vlmBatchSize: 1,
  vlmCacheMaxEntryCount: 0.5,
  apiHost: '127.0.0.1' as const,
  apiPort: 17860,
  apiStartupTimeoutMs: 120000,
};

test('builds explicit pipeline and VLM commands', () => {
  const common = { model: 'pipeline', fileSource: 'D:/paper/p.pdf', outputDir: 'D:/out/pipeline', method: 'auto', language: 'ch', formula: true, table: true };
  assert.deepEqual(buildMinerUArgs(common, config, FIXED_API_URL), [
    '-p','D:/paper/p.pdf','-o','D:/out/pipeline','-b','pipeline','-m','auto','-l','ch','--api-url',FIXED_API_URL,'-f','true','-t','true',
  ]);
  const vlmConfig = { ...config, model: 'vlm', cliBackend: 'vlm-engine' };
  assert.match(buildMinerUArgs({ ...common, model: 'vlm' }, vlmConfig, FIXED_API_URL).join(' '), /-b vlm-engine/);
  assert.match(buildMinerUArgs({ ...common, model: 'vlm' }, vlmConfig, FIXED_API_URL).join(' '), /--batch-size 1 --cache-max-entry-count 0\.5/);
  assert.match(buildMinerUArgs({ ...common, model: 'vlm' }, vlmConfig, FIXED_API_URL).join(' '), /--api-url http:\/\/127\.0\.0\.1:17860/);
});

test('rejects invalid explicit MinerU API URLs', () => {
  const common = { model: 'pipeline', fileSource: 'D:/paper/p.pdf', outputDir: 'D:/out/pipeline', method: 'auto', language: 'ch', formula: true, table: true };
  for (const apiUrl of [
    '',
    'https://127.0.0.1:17860',
    'http://localhost:17860',
    'http://user:pass@127.0.0.1:17860',
    'http://127.0.0.1:17861',
    'http://127.0.0.1:17860/',
    'http://127.0.0.1:17860/custom-path',
    'http://127.0.0.1:17860/custom-path?x=1',
    'http://127.0.0.1:17860/#frag',
  ]) {
    assert.throws(() => buildMinerUArgs(common, config, apiUrl), /api url/i);
  }
});

test('preserves the configured exact loopback origin without normalization', () => {
  const common = { model: 'pipeline', fileSource: 'D:/paper/p.pdf', outputDir: 'D:/out/pipeline', method: 'auto', language: 'ch', formula: true, table: true };
  assert.deepEqual(buildMinerUArgs(common, config, FIXED_API_URL), [
    '-p','D:/paper/p.pdf','-o','D:/out/pipeline','-b','pipeline','-m','auto','-l','ch','--api-url',FIXED_API_URL,'-f','true','-t','true',
  ]);
});

test('builds shared MinerU process environment with utf8 and runtime variables', () => {
  const env = buildMinerUProcessEnv({ ...config, tempRoot: fixture.paths.tempRoot, cudaVisibleDevices: '2', maxConcurrency: 3, processingWindowSize: 7 });
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(env.CUDA_VISIBLE_DEVICES, '2');
  assert.equal(env.MINERU_TOOLS_CONFIG_JSON, config.mineruToolsConfig);
  assert.equal(env.MINERU_MODEL_SOURCE, config.modelSourceRuntime);
  assert.equal(env.MODELSCOPE_CACHE, config.modelScopeCacheRoot);
  assert.equal(env.TEMP, fixture.paths.tempRoot);
  assert.equal(env.TMP, fixture.paths.tempRoot);
  assert.equal(env.MINERU_TASK_RESULT_TIMEOUT_SECONDS, '3600');
  assert.equal(env.MINERU_TASK_RESULT_DOWNLOAD_TIMEOUT_SECONDS, '600');
});

const fixture = await makeRuntimeFixture();
after(() => fixture.dispose());
const processContext = { safetyRoot: join(fixture.paths.stateRoot, 'locks', 'processes'), policy: { processCleanupTimeoutMs: 1800, diagnosticTimeoutMs: 5000, maxOutputBytes: 16384 } };
const completed: ManagedProcessResult = { reason: 'exit', exitCode: 0, cleanupConfirmed: true, stdout: '', stderr: '', elapsedMs: 7, pid: 42, activePids: [] };
const job = { arxivId: 'x', model: 'pipeline', fileSource: 'x.pdf', outputDir: 'out' };
const options = { config: { ...config, tempRoot: fixture.paths.tempRoot }, processContext, apiUrl: FIXED_API_URL };

for (const timeoutMs of [undefined, 1234]) test(`timeout result uses loaded configuration or job override (${timeoutMs ?? 'config'})`, async () => {
  const raw = YAML.parse(await readFile(join(fixture.projectRoot, 'config', 'mineru-local.yaml'), 'utf8'));
  const sourceRoot = join(fixture.root, 'fake-python-source');
  const loaded = loadMinerULocalConfig(fixture.projectRoot, { raw: { ...raw, source_root: sourceRoot, venv_root: join(sourceRoot, '.venv'), task_timeout_seconds: 23 } });
  const config = { ...loaded, tempRoot: fixture.paths.tempRoot };
  const job = { arxivId: 'timeoutv1', model: config.model, fileSource: join(fixture.paths.pdfRoot, 'timeout.pdf'), outputDir: join(fixture.paths.tempRoot, 'out'), timeoutMs };
  let captured: ManagedProcessSpec | undefined;
  const result = await runMineruCli(job, { config, processContext,
    apiUrl: FIXED_API_URL,
    verifySource: (_config, context) => assert.equal(context.policy.diagnosticTimeoutMs, 5000), verifyRuntime: () => {},
    managedProcess: async spec => { captured = spec; return { ...completed, reason: 'timeout', exitCode: 0 }; },
  });
  assert.ok(captured);
  assert.equal(captured.timeoutMs, job.timeoutMs ?? config.taskTimeoutMs);
  assert.deepEqual(captured.args, buildMinerUArgs(job, config, FIXED_API_URL));
  assert.equal(result.timedOut, true);
  assert.equal(result.errorCode, 'ETIMEDOUT');
  assert.notEqual(result.exitCode, 0);
  assert.equal(captured.safetyRoot, join(fixture.paths.stateRoot, 'locks', 'processes'));
  const openCliHome = openCliPaths({ projectRoot: fixture.projectRoot, tempRoot: fixture.paths.tempRoot }).homeRoot;
  assert.notEqual(captured.env.HOME, openCliHome); assert.notEqual(captured.env.USERPROFILE, openCliHome);
  assert.equal(captured.executable, join(sourceRoot, '.venv', 'Scripts', 'mineru.exe'));
});

test('rejects a job model that differs from configuration', async () => {
  await assert.rejects(runMineruCli({ ...job, model: 'vlm' }, options), /configured model/);
});

test('preserves MinerU args, environment, configured timeout and cancellation at managed boundary', async () => {
  let captured: ManagedProcessSpec | undefined; let controls: Parameters<typeof runManagedProcess>[1];
  const controller = new AbortController();
  await runMineruCli(job, { ...options, signal: controller.signal,
    config: { ...options.config, cudaVisibleDevices: '2', maxConcurrency: 3, processingWindowSize: 7 },
    managedProcess: async (spec, opts) => { captured = spec; controls = opts; return completed; } });
  assert.ok(captured); assert.ok(controls);
  assert.deepEqual(captured.args, buildMinerUArgs(job, config, FIXED_API_URL));
  assert.equal(captured.cwd, config.sourceRoot);
  assert.equal(captured.timeoutMs, config.taskTimeoutMs);
  assert.equal(controls.signal, controller.signal);
  assert.equal(captured.env.CUDA_VISIBLE_DEVICES, '2');
  assert.equal(captured.env.MINERU_API_MAX_CONCURRENT_REQUESTS, '3');
  assert.equal(captured.env.MINERU_PROCESSING_WINDOW_SIZE, '7');
  assert.equal(captured.env.MINERU_VIRTUAL_VRAM_SIZE, '5');
  assert.equal(captured.env.MINERU_DEVICE_MODE, 'cuda');
  assert.equal(captured.env.MINERU_TOOLS_CONFIG_JSON, config.mineruToolsConfig);
  assert.equal(captured.env.MODELSCOPE_CACHE, config.modelScopeCacheRoot);
  assert.equal(captured.env.TEMP, options.config.tempRoot);
  assert.equal(captured.env.PYTHONUTF8, '1');
  assert.equal(captured.env.PYTHONIOENCODING, 'utf-8');
  assert.deepEqual(captured.policy, processContext.policy);
  const vlmConfig = { ...options.config, model: 'vlm', cliBackend: 'vlm-engine' };
  await runMineruCli({ ...job, model: 'vlm', timeoutMs: 1234 }, { ...options, config: vlmConfig, managedProcess: async (spec) => { captured = spec; return completed; } });
  assert.ok(captured);
  assert.equal(captured.env.MINERU_LMDEPLOY_DEVICE, 'cuda');
  assert.equal(captured.env.MINERU_LMDEPLOY_BACKEND, 'turbomind');
  assert.equal(captured.env.MINERU_VIRTUAL_VRAM_SIZE, undefined);
  assert.equal(captured.timeoutMs, 1234);
});

test('passes an explicit api url through to pipeline and vlm jobs', async () => {
  let captured: ManagedProcessSpec | undefined;
  await runMineruCli(job, {
    ...options,
    managedProcess: async spec => { captured = spec; return completed; },
  });
  assert.ok(captured);
  assert.match(captured.args.join(' '), /--api-url http:\/\/127\.0\.0\.1:17860/);

  const vlmConfig = { ...options.config, model: 'vlm', cliBackend: 'vlm-engine' };
  await runMineruCli({ ...job, model: 'vlm' }, {
    ...options,
    config: vlmConfig,
    managedProcess: async spec => { captured = spec; return completed; },
  });
  assert.ok(captured);
  assert.match(captured.args.join(' '), /--api-url http:\/\/127\.0\.0\.1:17860/);
});

for (const [reason, clean, code, exitCode] of [
  ['exit', true, null, 7], ['timeout', true, 'ETIMEDOUT', 1], ['cancelled', true, 'ABORT_ERR', 1],
  ['output-limit', true, 'PROCESS_OUTPUT_LIMIT', 1], ['supervisor-error', true, 'PROCESS_SUPERVISOR_FAILED', 1],
  ['exit', false, 'PROCESS_CLEANUP_UNCONFIRMED', 1],
] as const) test(`maps ${reason}, cleanup=${clean} without false success`, async () => {
  const result = await runMineruCli(job, { ...options, managedProcess: async () => ({ ...completed, reason, cleanupConfirmed: clean, exitCode: reason === 'exit' && clean ? 7 : 0,
    stdout: 'token=secret-token', stderr: 'password=secret-pass api_key=secret-key Bearer secret https://example.test/upload' }) });
  assert.equal(result.exitCode, exitCode); assert.equal(result.errorCode, code);
  assert.equal(result.timedOut, reason === 'timeout'); assert.equal(result.cleanupConfirmed, clean);
  assert.doesNotMatch(result.stdoutSummary + result.stderrSummary, /secret-token|secret-pass|secret-key|example\.test/);
});

test('includes structured supervisor errors in the bounded redacted stderr summary', async () => {
  const result = await runMineruCli(job, {
    ...options,
    managedProcess: async () => ({
      ...completed,
      reason: 'supervisor-error',
      exitCode: 0,
      stderr: `${'x'.repeat(3900)} Layout Predict password=secret-pass\n`,
    }),
  });
  assert.equal(result.errorCode, 'PROCESS_SUPERVISOR_FAILED');
  assert.match(result.stderrSummary ?? '', /Layout Predict/);
  assert.match(result.stderrSummary ?? '', /PROCESS_SUPERVISOR_FAILED/);
  assert.doesNotMatch(result.stderrSummary ?? '', /secret-pass/);
  assert.ok((result.stderrSummary?.length ?? 0) <= 4000);
});

test('passes finite diagnostic policy to source pin verification', async () => {
  let received: ProcessContext | undefined;
  await runMineruCli(job, { ...options, config: { ...options.config, enforceSourcePin: true },
    verifySource: (_config, context) => { received = context; }, managedProcess: async () => completed });
  assert.ok(received);
  assert.equal(received.policy.diagnosticTimeoutMs, 5000);
});
