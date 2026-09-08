import type { MinerUCliConfig } from '../types/config.ts';
import type { MinerUCliJob } from '../types/jobs.ts';
import type { ProcessContext } from '../runtime/process.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runManagedProcess } from '../runtime/process.ts';
import { redactErrorMessage } from '../shared/redaction.ts';
import { mergeProcessEnv } from '../shared/process-env.ts';
import { assertMinerUPathLength } from './mineru-workspace.ts';
import { isSupportedPipelineBatchRatio, pipelineBatchRatioToVirtualVram } from './mineru-local-config.ts';

export interface MinerURunnerOptions {
  config: MinerUCliConfig; processContext: ProcessContext; apiUrl: string; signal?: AbortSignal;
  managedProcess?: typeof runManagedProcess;
  verifySource?: (config: MinerUCliConfig, context: ProcessContext) => unknown;
  verifyRuntime?: (config: MinerUCliConfig) => unknown;
}
export function assertMinerURunnerConfig(input: unknown): asserts input is MinerUCliConfig {
  if (!input || typeof input !== 'object') throw new Error('MinerU configuration is required');
  for (const key of ['model', 'cliBackend', 'sourceRoot', 'venvRoot', 'tempRoot', 'modelSourceRuntime', 'mineruToolsConfig', 'modelScopeCacheRoot', 'cudaVisibleDevices', 'pipelineDeviceMode', 'vlmDevice', 'vlmLmdeployBackend', 'pipelineMethod', 'pipelineLanguage']) {
    const value: unknown = Reflect.get(input, key);
    if (typeof value !== 'string' || !value) throw new Error(`MinerU configuration requires ${key}`);
  }
  for (const key of ['taskTimeoutMs', 'resultDownloadTimeoutMs', 'maxConcurrency', 'processingWindowSize', 'pipelineBatchRatio', 'vlmBatchSize', 'vlmCacheMaxEntryCount']) {
    const value: unknown = Reflect.get(input, key);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`MinerU configuration requires ${key}`);
  }
  if (!isSupportedPipelineBatchRatio(Reflect.get(input, 'pipelineBatchRatio'))) throw new Error('MinerU configuration requires a supported pipelineBatchRatio');
  for (const key of ['formulaEnabled', 'tableEnabled']) if (typeof Reflect.get(input, key) !== 'boolean') throw new Error(`MinerU configuration requires ${key}`);
}

const redact = (value: unknown) => redactErrorMessage(String(value ?? '')).slice(-4000);

function validateMinerUApiUrl(apiUrl: string, config: Pick<MinerUCliConfig, 'apiPort'>): string {
  const expected = `http://127.0.0.1:${config.apiPort}`;
  if (apiUrl !== expected) throw new Error('Invalid MinerU api url');
  return apiUrl;
}

function summarizeMinerUStderr(stderr: unknown, errorCode: string | null) {
  const output = String(stderr ?? '');
  if (!errorCode) return redact(output);
  const code = redactErrorMessage(errorCode);
  const separator = output ? '\n' : '';
  const redactedOutput = redactErrorMessage(`${output}${separator}${code}`);
  if (redactedOutput.length <= 4000) return redactedOutput;
  const reserved = Math.min(4000, code.length + 1);
  const tailBudget = Math.max(0, 4000 - reserved);
  const tail = tailBudget > 0 ? redactedOutput.slice(0, -reserved).slice(-tailBudget) : '';
  return `${tail}${tail && code ? '\n' : ''}${code}`.slice(-4000);
}

function assertRuntimeModelRoots(config: MinerUCliConfig) {
  const runtime: unknown = JSON.parse(readFileSync(config.mineruToolsConfig, 'utf8'));
  const models: unknown = runtime && typeof runtime === 'object' ? Reflect.get(runtime, 'models-dir') : undefined;
  const expected = [
    ['pipeline', config.pipelineModelsDir],
    ['vlm', config.vlmModelsDir],
  ] as const;
  for (const [name, expectedPath] of expected) {
    const modelPath: unknown = models && typeof models === 'object' ? Reflect.get(models, name) : undefined;
    if (typeof modelPath !== 'string' || !modelPath || !expectedPath) throw new Error(`runtime model root missing: ${name}`);
    const actual = realpathSync(modelPath);
    const expectedReal = realpathSync(expectedPath);
    if (actual.toLowerCase() !== expectedReal.toLowerCase()) throw new Error(`runtime model root is not pinned: ${name}`);
  }
}

function assertMinerUSource(config: MinerUCliConfig, processContext: ProcessContext) {
  const versionPath = join(config.sourceRoot, 'mineru', 'version.py');
  const versionText = readFileSync(versionPath, 'utf8');
  const version = versionText.match(/__version__\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (version !== config.expectedVersion) throw new Error(`unexpected MinerU version: ${version ?? 'missing'}`);
  const diagnosticOptions = { encoding: 'utf8' as const, timeout: processContext.policy.diagnosticTimeoutMs, windowsHide: true };
  const commit = execFileSync('git', ['-C', config.sourceRoot, 'rev-parse', 'HEAD'], diagnosticOptions).trim();
  if (commit !== config.expectedCommit) throw new Error(`unexpected MinerU commit: ${commit}`);
  const dirty = execFileSync('git', ['-C', config.sourceRoot, 'status', '--porcelain'], diagnosticOptions).trim();
  if (dirty && config.allowDirtySource !== true) throw new Error('MinerU source checkout is dirty');
  return { version, commit, dirty: Boolean(dirty) };
}

export function buildMinerUArgs(job: MinerUCliJob, config: Pick<MinerUCliConfig, 'model' | 'cliBackend' | 'pipelineMethod' | 'pipelineLanguage' | 'vlmBatchSize' | 'vlmCacheMaxEntryCount' | 'formulaEnabled' | 'tableEnabled' | 'apiPort'>, apiUrl: string) {
  if (job.model !== config.model) throw new Error(`job model differs from configured model: ${job.model}`);
  const args = ['-p', job.fileSource, '-o', job.outputDir, '-b', config.cliBackend];
  if (job.model === 'pipeline') {
    args.push('-m', job.method ?? config.pipelineMethod, '-l', job.language ?? config.pipelineLanguage);
    args.push('--api-url', validateMinerUApiUrl(apiUrl, config));
  }
  if (job.model === 'vlm') {
    args.push('--batch-size', String(config.vlmBatchSize), '--cache-max-entry-count', String(config.vlmCacheMaxEntryCount));
    args.push('--api-url', validateMinerUApiUrl(apiUrl, config));
  }
  args.push('-f', String(job.formula ?? config.formulaEnabled), '-t', String(job.table ?? config.tableEnabled));
  return args;
}

export function buildMinerUProcessEnv(config: MinerUCliConfig): Record<string, string> {
  const noProxy = [...new Set([
    ...Object.entries(process.env).filter(([key]) => key.toUpperCase() === 'NO_PROXY').flatMap(([, value]) => (value ?? '').split(',')),
    'localhost', '127.0.0.1', '::1',
  ].map(value => value.trim()).filter(Boolean))].join(',');
  return mergeProcessEnv(process.env, {
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    TEMP: config.tempRoot,
    TMP: config.tempRoot,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    MINERU_MODEL_SOURCE: config.modelSourceRuntime,
    MINERU_TOOLS_CONFIG_JSON: config.mineruToolsConfig,
    CUDA_PATH: config.cudaPath ?? join(config.venvRoot, 'cuda'),
    MODELSCOPE_CACHE: config.modelScopeCacheRoot,
    CUDA_VISIBLE_DEVICES: config.cudaVisibleDevices,
    MINERU_DEVICE_MODE: config.pipelineDeviceMode,
    MINERU_LMDEPLOY_DEVICE: config.vlmDevice,
    MINERU_LMDEPLOY_BACKEND: config.vlmLmdeployBackend,
    MINERU_API_MAX_CONCURRENT_REQUESTS: String(config.maxConcurrency),
    MINERU_PROCESSING_WINDOW_SIZE: String(config.processingWindowSize),
    MINERU_TASK_RESULT_TIMEOUT_SECONDS: String(config.taskTimeoutMs / 1000),
    MINERU_TASK_RESULT_DOWNLOAD_TIMEOUT_SECONDS: String(config.resultDownloadTimeoutMs / 1000),
  });
}

export async function runMineruCli(job: MinerUCliJob, { config, processContext, apiUrl, signal, managedProcess = runManagedProcess, verifySource = assertMinerUSource, verifyRuntime = assertRuntimeModelRoots }: MinerURunnerOptions) {
  assertMinerUPathLength(job);
  if (!apiUrl) throw new Error('MinerU api url is required');
  const args = buildMinerUArgs(job, config, apiUrl);
  if (!processContext) throw new Error('MinerU requires an explicit ProcessContext');
  if (!config.tempRoot) throw new Error('MinerU requires configured tempRoot');
  await mkdir(config.tempRoot, { recursive: true });
  if (config.enforceSourcePin === true) await verifySource(config, processContext);
  if (config.enforceRuntimePolicy === true) await verifyRuntime(config);
  const executable = join(config.venvRoot, 'Scripts', 'mineru.exe');
  const timeoutMs = job.timeoutMs ?? config.taskTimeoutMs;
  const result = await managedProcess({
    executable, args, cwd: config.sourceRoot, timeoutMs, ...processContext,
      env: {
        ...buildMinerUProcessEnv(config),
        ...(job.model === 'pipeline' ? { MINERU_VIRTUAL_VRAM_SIZE: String(pipelineBatchRatioToVirtualVram(config.pipelineBatchRatio)) } : {}),
      },
  }, { signal });
  const timedOut = result.reason === 'timeout';
  const errorCode = !result.cleanupConfirmed ? 'PROCESS_CLEANUP_UNCONFIRMED'
    : timedOut ? 'ETIMEDOUT' : result.reason === 'cancelled' ? 'ABORT_ERR'
    : result.reason === 'output-limit' ? 'PROCESS_OUTPUT_LIMIT'
    : result.reason === 'supervisor-error' ? 'PROCESS_SUPERVISOR_FAILED' : null;
  const clientStderrSummary = summarizeMinerUStderr(result.stderr, errorCode);
  return {
    arxivId: job.arxivId, model: job.model, cliBackend: config.cliBackend,
    exitCode: result.reason === 'exit' && result.cleanupConfirmed ? (result.exitCode ?? 1) : 1,
    errorCode, timedOut, timeoutMs, signal: result.reason === 'cancelled' ? 'SIGTERM' : null,
    cleanupConfirmed: result.cleanupConfirmed, pid: result.pid, activePids: result.activePids,
    outputDir: job.outputDir, elapsedMs: result.elapsedMs,
    stdoutSummary: redact(result.stdout), stderrSummary: clientStderrSummary,
    clientStderrSummary, apiStderrSummary: '',
    source: config.sourceProvenance ?? null,
  };
}
export async function validateMineruConfig(config: MinerUCliConfig, processContext: ProcessContext) {
  if (config.enforceSourcePin === true) await assertMinerUSource(config, processContext);
  if (config.enforceRuntimePolicy === true) await assertRuntimeModelRoots(config);
  return true;
}
