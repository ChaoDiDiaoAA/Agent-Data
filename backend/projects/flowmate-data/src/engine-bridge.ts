export { canonicalJson, hashCanonical } from '../../paper-knowledge-engine/src/shared/manifest.ts';
export { replaceFileWithRetry } from '../../paper-knowledge-engine/src/evidence/atomic-replace.ts';
import { createHttpClient as createPaperHttpClient, ResearchAdapterError, type HttpFetch, type HttpScope, type ResearchHttpClient } from '../../paper-knowledge-engine/src/research/http-client.ts';

export { ResearchAdapterError };
export type { HttpFetch, HttpScope, ResearchHttpClient };

/** Flowmate's only runtime entry point to the shared, policy-bound HTTP client. */
export function createHttpClient(options: { fetch?: HttpFetch } = {}): ResearchHttpClient {
  return createPaperHttpClient(options);
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadSharedMachineRuntime } from '../../paper-knowledge-engine/src/shared/engine-context.ts';
import { loadMinerULocalConfig, type MinerULocalConfig } from '../../paper-knowledge-engine/src/mineru/mineru-local-config.ts';
import { createMineruApiSession } from '../../paper-knowledge-engine/src/mineru/mineru-api-session.ts';
import { createProcessContext, type ProcessContext } from '../../paper-knowledge-engine/src/runtime/process.ts';
import { withRunLock } from '../../paper-knowledge-engine/src/runtime/run-lock.ts';
import { redactErrorMessage } from '../../paper-knowledge-engine/src/shared/redaction.ts';
import { normalizeLocalMinerUResult } from '../../paper-knowledge-engine/src/mineru/mineru-local-result.ts';
import { archiveReferences, realTree } from '../../paper-knowledge-engine/src/shared/archive-v2.ts';
import { canonicalJson, hashCanonical } from '../../paper-knowledge-engine/src/shared/manifest.ts';
import { resolveOwnedPath } from './config.ts';
import type { FlowmatePaths } from './contracts.ts';

export type { MinerULocalConfig, ProcessContext };
export { realTree };
export { withRunLock };

/** Source downloads may reuse only the shared machine proxy; MinerU settings are Flowmate-owned. */
export function loadSharedEngineNetwork(root: string): HttpScope['network'] {
  return loadSharedMachineRuntime({ root }).machine.network;
}
export interface ParsedFile { path: string; sha256: string; bytes: number }
export interface ParseReceipt {
  sampleId: string;
  parserKey: string;
  attemptId: string;
  originalSha256: string;
  startedAt: string;
  outputDir: string;
  normalizedDir: string;
  contentHash: string;
  files: ParsedFile[];
}
export interface ParseProgress {
  index: number;
  total: number;
  sampleId: string;
  status: 'started' | 'completed' | 'failed';
  elapsedMs: number;
}
export interface ParseInput {
  sampleId: string;
  sourcePath: string;
  /** Parent of immutable attempt directories, within mineruConfig.outputRoot. */
  outputDir: string;
  mineruConfig: MinerULocalConfig;
  processContext: ProcessContext;
  lockPath: string;
}
export interface ParseDependencies {
  createSession?: typeof createMineruApiSession;
  now?: () => Date;
  /** Optional progress notifications for sequential selection parsing. */
  onProgress?: (progress: ParseProgress) => void | Promise<void>;
  /** Internal use: the caller already holds Flowmate's run lock for a larger operation. */
  lockHeld?: boolean;
  /** Runs after cleanup and receipt verification, while the Flowmate run lock is held. */
  onParsed?: (receipt: ParseReceipt) => Promise<void>;
}
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function mineruParseFailure(execution: {
  exitCode: number;
  errorCode?: string | null;
  timedOut?: boolean;
  cleanupConfirmed?: boolean;
  elapsedMs?: number;
  pid?: number | null;
  activePids?: number[];
  stderrSummary?: string;
  clientStderrSummary?: string;
  apiStderrSummary?: string;
}) {
  const failureCode = execution.errorCode ?? (execution.timedOut ? 'ETIMEDOUT' : execution.exitCode || 1);
  const diagnostics = redactErrorMessage(execution.stderrSummary
    || [execution.clientStderrSummary, execution.apiStderrSummary].filter(Boolean).join('\n')).trim().slice(-4_000);
  const message = `MINERU_PARSE_FAILED: ${failureCode}${diagnostics ? `\n${diagnostics}` : ''}`;
  return Object.assign(new Error(message), {
    code: 'MINERU_PARSE_FAILED',
    mineruErrorCode: execution.errorCode ?? null,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut ?? false,
    cleanupConfirmed: execution.cleanupConfirmed,
    elapsedMs: execution.elapsedMs,
    pid: execution.pid ?? null,
    activePids: execution.activePids ?? [],
    stderrSummary: diagnostics,
    clientStderrSummary: execution.clientStderrSummary,
    apiStderrSummary: execution.apiStderrSummary,
  });
}

const mineruConfigFields = [
  'source_root', 'expected_version', 'expected_commit', 'python_version', 'venv_root',
  'model_source_setup', 'model_source_runtime', 'modelscope_revision', 'model_download_type', 'models_root',
  'modelscope_cache_root', 'mineru_tools_config', 'pipeline_models_dir', 'vlm_models_dir',
  'pipeline_model_repository', 'pipeline_required_paths', 'vlm_model_repository', 'expected_gpu_name',
  'mineru_install_extras', 'torch_index_url', 'lmdeploy_wheel_url', 'cuda_runtime_dll', 'model',
  'allowed_models', 'max_concurrency', 'processing_window_size', 'pipeline_batch_ratio', 'cuda_visible_devices',
  'pipeline_device_mode', 'pipeline_method', 'pipeline_language', 'formula_enabled', 'table_enabled',
  'vlm_device', 'vlm_lmdeploy_backend', 'vlm_batch_size', 'vlm_cache_max_entry_count', 'task_timeout_seconds',
  'result_download_timeout_seconds', 'api_host', 'api_port', 'api_startup_timeout_seconds', 'local_import',
] as const;

interface FlowmateMineruConfigFile {
  schema_version: 1;
  mineru: Record<string, unknown>;
  runtime: { process_cleanup_timeout_ms: number; diagnostic_timeout_ms: number; max_output_bytes: number };
}

function configObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function closedConfigObject(value: unknown, fields: readonly string[], code: string): Record<string, unknown> {
  const object = configObject(value, code);
  if (Object.keys(object).some(field => !fields.includes(field))) throw new Error(code);
  return object;
}

function positiveConfigInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`FLOWMATE_MINERU_CONFIG_INVALID: ${field}`);
  return Number(value);
}

function loadFlowmateMineruConfig(path: string, projectRoot: string, stateRoot: string): { mineru: MinerULocalConfig; runtime: FlowmateMineruConfigFile['runtime'] } {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`FLOWMATE_MINERU_CONFIG_INVALID: ${path}`); }
  const file = closedConfigObject(parsed, ['schema_version', 'mineru', 'runtime'], 'FLOWMATE_MINERU_CONFIG_INVALID');
  if (file.schema_version !== 1) throw new Error('FLOWMATE_MINERU_CONFIG_INVALID: schema_version');
  const mineru = closedConfigObject(file.mineru, mineruConfigFields, 'FLOWMATE_MINERU_CONFIG_INVALID: mineru');
  const runtime = closedConfigObject(file.runtime, ['process_cleanup_timeout_ms', 'diagnostic_timeout_ms', 'max_output_bytes'], 'FLOWMATE_MINERU_CONFIG_INVALID: runtime');
  return {
    // The raw branch performs the complete schema/path validation. Its
    // inferred return type also covers the legacy no-local-import shape, while
    // Flowmate's owned config always supplies local_import.
    mineru: loadMinerULocalConfig(projectRoot, { raw: mineru, stateRoot }) as MinerULocalConfig,
    runtime: {
      process_cleanup_timeout_ms: positiveConfigInteger(runtime.process_cleanup_timeout_ms, 'runtime.process_cleanup_timeout_ms'),
      diagnostic_timeout_ms: positiveConfigInteger(runtime.diagnostic_timeout_ms, 'runtime.diagnostic_timeout_ms'),
      max_output_bytes: positiveConfigInteger(runtime.max_output_bytes, 'runtime.max_output_bytes'),
    },
  };
}

/** The single identity contract used when creating and verifying parse attempts. */
export function deriveParseAttemptId(input: Pick<ParseReceipt, 'parserKey' | 'originalSha256' | 'startedAt'>): string {
  const { parserKey, originalSha256, startedAt } = input;
  const key = typeof parserKey === 'string' ? /^mineru@(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?);sha=([0-9a-f]{40});model=(pipeline|vlm);backend=(pipeline|vlm-engine);method=(auto|txt|ocr);language=([A-Za-z][A-Za-z0-9_-]*);formula=(true|false);table=(true|false)$/.exec(parserKey) : null;
  const timestamp = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  if (!key || key[0] !== parserKey || key[4] !== (key[3] === 'pipeline' ? 'pipeline' : 'vlm-engine')
    || typeof originalSha256 !== 'string' || originalSha256.length !== 64 || !/^[0-9a-f]{64}$/.test(originalSha256)
    || !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== startedAt) throw new Error('PARSE_IDENTITY_INVALID');
  return `attempt-${hashCanonical({ parserKey, originalSha256, startedAt })}`;
}

export function createFlowmateMinerURuntime(paths: FlowmatePaths) {
  const workRoot = resolveOwnedPath(paths.dataRoot, 'work');
  const datasetsRoot = paths.dataRoot;
  const mineruConfigPath = resolveOwnedPath(paths.projectRoot, 'config/mineru.local.json');
  const configured = loadFlowmateMineruConfig(mineruConfigPath, paths.projectRoot, paths.dataRoot);
  const mineruConfig = { ...configured.mineru, tempRoot: workRoot, outputRoot: datasetsRoot };
  const processPolicy = {
    processCleanupTimeoutMs: configured.runtime.process_cleanup_timeout_ms,
    diagnosticTimeoutMs: configured.runtime.diagnostic_timeout_ms,
    maxOutputBytes: configured.runtime.max_output_bytes,
  };
  return {
    mineruConfig,
    processContext: createProcessContext(paths.projectRoot, resolveOwnedPath(paths.dataRoot, 'work/processes'), processPolicy),
    lockPath: resolveOwnedPath(paths.dataRoot, 'work/run.lock'),
  };
}

/** Verify real files, required structured artifacts and every local reference. */
export async function verifyNormalizedOutput(normalizedDir: string): Promise<{ contentHash: string; files: ParsedFile[] }> {
  const compact = await Bun.file(join(normalizedDir, 'content.md')).exists();
  const names = (await realTree(normalizedDir)).filter(name => !compact || ['content.md', 'content.json', 'pages.json'].includes(name) || name.startsWith('assets/'));
  const files: ParsedFile[] = [];
  for (const name of names.filter(name => !name.endsWith('/'))) {
    const path = resolveOwnedPath(normalizedDir, name);
    const body = await readFile(path);
    files.push({ path: name, sha256: digest(body), bytes: body.byteLength });
  }
  for (const required of compact ? ['content.md', 'content.json', 'pages.json'] : ['full.md', 'content-list.json', 'pages.json', 'page-marked.txt']) {
    if (!files.some(file => file.path === required && file.bytes > 0)) throw new Error('NORMALIZED_ARTIFACT_MISSING');
  }
  const markdown = await readFile(join(normalizedDir, compact ? 'content.md' : 'full.md'), 'utf8');
  const content: unknown = JSON.parse(await readFile(join(normalizedDir, compact ? 'content.json' : 'content-list.json'), 'utf8'));
  const pages: unknown = JSON.parse(await readFile(join(normalizedDir, 'pages.json'), 'utf8'));
  if (!Array.isArray(content) || !Array.isArray(pages) || pages.length === 0) throw new Error('NORMALIZED_ARTIFACT_INVALID');
  const references = archiveReferences(markdown, content);
  for (const asset of references) {
    const path = resolveOwnedPath(normalizedDir, asset);
    if (!(await lstat(path)).isFile()) throw new Error('NORMALIZED_ASSET_MISSING');
  }
  return { contentHash: createHash('sha256').update(markdown).update(JSON.stringify(content)).digest('hex'), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function parseInvoice(input: ParseInput, dependencies: ParseDependencies = {}): Promise<ParseReceipt> {
  const { mineruConfig: config, processContext, lockPath } = input;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.sampleId)) throw new Error('INVALID_SAMPLE_ID');
  if (!isAbsolute(input.sourcePath) || !['.jpg', '.jpeg', '.png', '.pdf'].includes(extname(input.sourcePath).toLowerCase())) throw new Error('PARSE_SOURCE_INVALID');
  if (![config.tempRoot, config.outputRoot, input.outputDir, lockPath, processContext.safetyRoot].every(value => typeof value === 'string' && isAbsolute(value))) throw new Error('PARSE_PATH_INVALID');
  if (resolve(lockPath) !== resolve(config.tempRoot, 'run.lock') || resolve(processContext.safetyRoot) !== resolve(config.tempRoot, 'processes')
    || (resolve(config.tempRoot) !== resolve(config.outputRoot, 'work') && resolve(config.tempRoot) !== resolve(dirname(config.outputRoot), 'work')) || config.libraryId || config.libraryPaths) throw new Error('PARSE_PATH_INVALID');
  const outputParent = resolveOwnedPath(config.outputRoot, relative(config.outputRoot, input.outputDir));
  if (outputParent === resolve(config.outputRoot)) throw new Error('PARSE_PATH_INVALID');
  if (!/^[0-9a-f]{40}$/i.test(config.expectedCommit)) throw new Error('PARSER_SOURCE_SHA_INVALID');
  const parserKey = `mineru@${config.expectedVersion};sha=${config.expectedCommit.toLowerCase()};model=${config.model};backend=${config.cliBackend};method=${config.pipelineMethod};language=${config.pipelineLanguage};formula=${config.formulaEnabled};table=${config.tableEnabled}`;
  const operation = async () => {
    const originalSha256 = digest(await readFile(input.sourcePath));
    const startedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    const attemptId = deriveParseAttemptId({ parserKey, originalSha256, startedAt });
    const outputDir = resolveOwnedPath(outputParent, attemptId.slice(8, 24));
    await mkdir(outputParent, { recursive: true });
    try { await mkdir(outputDir); } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new Error('ATTEMPT_EXISTS');
      throw error;
    }
    // MinerU's client extracts API results into paths that include the
    // generated asset names.  The final Flowmate attempt path contains the
    // dataset/sample identity and can exceed Windows' legacy path limit even
    // though the input path and the configured output directory pass the
    // runner's shallow path check.  Keep the external extraction workspace
    // short, then publish only the normalized, self-contained artifacts to
    // the immutable attempt directory.
    const mineruOutputDir = resolveOwnedPath(config.tempRoot, `m/${crypto.randomUUID().slice(0, 8)}`);
    await mkdir(dirname(mineruOutputDir), { recursive: true });
    await mkdir(mineruOutputDir, { recursive: false });
    let session: ReturnType<typeof createMineruApiSession> | undefined;
    let receipt: ParseReceipt;
    try {
      session = (dependencies.createSession ?? createMineruApiSession)({ config, processContext });
      const execution = await session.run({ model: config.model, fileSource: input.sourcePath, outputDir: mineruOutputDir,
        method: config.pipelineMethod, language: config.pipelineLanguage, formula: config.formulaEnabled, table: config.tableEnabled, timeoutMs: config.taskTimeoutMs });
      if (execution.exitCode !== 0 || execution.timedOut || execution.cleanupConfirmed === false || execution.errorCode) throw mineruParseFailure(execution);
      // A newly created attempt cannot contain stale artifacts. ZIP extraction
      // may retain timestamps older than this attempt, so do not filter by mtime.
      const normalized = await normalizeLocalMinerUResult({ model: config.model, cliBackend: config.cliBackend, outputDir: mineruOutputDir });
      // The shared archive normalizer uses attempt-relative assets. Make the
      // standalone normalized directory self-contained without changing its text.
      const assets = join(mineruOutputDir, 'assets');
      try { await lstat(assets); await cp(assets, join(normalized.normalizedDir, 'assets'), { recursive: true, errorOnExist: true, force: false }); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
      const normalizedDir = join(outputDir, 'normalized');
      await rename(normalized.normalizedDir, normalizedDir);
      for (const name of ['content-list.json', 'pages.json']) {
        const path = join(normalizedDir, name);
        await writeFile(path, JSON.stringify(JSON.parse(await readFile(path, 'utf8')), null, 2) + '\n');
      }
      const verified = await verifyNormalizedOutput(normalizedDir);
      if (verified.contentHash !== normalized.contentHash || digest(await readFile(input.sourcePath)) !== originalSha256) throw new Error('PARSE_HASH_MISMATCH');
      receipt = { sampleId: input.sampleId, parserKey, attemptId, originalSha256, startedAt, outputDir, normalizedDir, ...verified };
    } finally {
      try { await session?.dispose(); }
      finally {
        // The final attempt keeps only normalized artifacts and its receipt. A
        // failed API extraction may leave partial files in the short staging
        // directory; remove them without masking the original parse/cleanup
        // error.
        await rm(mineruOutputDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    await writeFile(join(outputDir, 'receipt.json'), canonicalJson(receipt), { flag: 'wx' });
    await dependencies.onParsed?.(receipt);
    return receipt;
  };
  return dependencies.lockHeld ? operation() : withRunLock(lockPath, operation, { jobId: `flowmate-parse-${input.sampleId}` });
}
