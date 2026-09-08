import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, win32 } from 'node:path';
import YAML from 'yaml';

import { asLibraryId } from './identity.ts';
import { deriveLibraryPaths } from './paths.ts';
import { EVIDENCE_POLICY_V3 } from './evidence-policy.ts';
import { resolveArxivApiBase, resolveOpenCliProxyMode } from '../discovery/arxiv-transport.ts';

import type { EngineConfig, EngineContext, LibraryCategoryConfig, LibraryConfig, LibraryDateModes, LibraryTrackConfig, LocalImportConfig, MachineConfig, MinerUModel, PaperLibraryConfig, PaperPolicy, PipelineBatchRatio, ResearchDateField, ResearchEvidencePolicy, ResearchLibraryConfig, ResearchSourceKind, ResearchTaskLimits, ResearchTrackConfig, ResearchWeeklySchedule, SourcePolicyConfig, TopicTaxonomyConfig, WeeklySchedule, Weekday } from '../types/config.ts';

const defaultLibraryId = 'fsd';
const libraryIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const researchTrackIds = [
  'harness-control-loop', 'agent-loop', 'runtime-execution', 'tool-mcp', 'context-prompt',
  'memory-state-session', 'guardrails-policy', 'permissions-authorization',
  'identity-tenancy-governance', 'hitl-approval', 'sandbox-isolation', 'testing-evaluation',
  'agent-evaluation-methodology', 'tracing-observability', 'reliability-operations',
] as const;
const researchSourceKinds = [
  'paper', 'technical-report', 'official-doc', 'specification',
  'repository', 'release', 'evaluation-method', 'local-artifact',
] as const;
const researchDateFields = ['published', 'updated', 'released', 'retrieved'] as const;

function configError(code: string, file: string, field: string, detail: string): never {
  throw new Error(`${code} ${file}: ${field} ${detail}`);
}

function object(value: unknown, file: string, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return configError('INVALID_FIELD', file, field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function closed(
  value: Record<string, unknown>,
  allowed: readonly string[],
  file: string,
  field = '',
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      const path = field ? `${field}.${key}` : key;
      configError('UNKNOWN_FIELD', file, path, 'is not allowed');
    }
  }
}

function text(value: unknown, file: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    return configError('INVALID_FIELD', file, field, 'must be a non-empty string');
  }
  return value;
}

function bool(value: unknown, file: string, field: string): boolean {
  if (typeof value !== 'boolean') return configError('INVALID_FIELD', file, field, 'must be boolean');
  return value;
}

function finite(value: unknown, file: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return configError('INVALID_FIELD', file, field, 'must be a finite number');
  }
  return value;
}

function integer(value: unknown, file: string, field: string, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    return configError('INVALID_FIELD', file, field, `must be an integer >= ${minimum}`);
  }
  return value;
}

function strings(value: unknown, file: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    return configError('INVALID_FIELD', file, field, 'must be a string array');
  }
  return [...value];
}

function date(value: unknown, file: string, field: string): string {
  const result = text(value, file, field);
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== result) {
    return configError('INVALID_FIELD', file, field, 'must be a real YYYY-MM-DD date');
  }
  return result;
}

function absolutePath(value: unknown, file: string, field: string): string {
  const result = text(value, file, field);
  if (/[\x00-\x1f\x7f]/.test(result)) return configError('INVALID_FIELD', file, field, 'must not contain control characters');
  if (!win32.isAbsolute(result)) return configError('INVALID_FIELD', file, field, 'must be absolute');
  return result;
}

function port(value: unknown, file: string, field: string): number {
  const result = integer(value, file, field);
  if (result > 65535) return configError('INVALID_FIELD', file, field, 'must be <= 65535');
  return result;
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function safeRelativePath(value: unknown, file: string, field: string): string {
  const result = text(value, file, field);
  const segments = result.split(/[\\/]/);
  if (/[\x00-\x1f\x7f]/.test(result) || win32.isAbsolute(result) || /^[A-Za-z]:/.test(result)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return configError('INVALID_FIELD', file, field, 'must be a safe relative path');
  }
  return result;
}

function httpProxyUrl(value: unknown, file: string, field: string): string {
  const result = text(value, file, field);
  try {
    // Check the original text too: URL parsing normalizes controls and dot paths.
    if (!/^https?:\/\/[^\s\\/@?#\x00-\x1f\x7f]+\/?$/i.test(result)) throw new Error();
    const url = new URL(result);
    if (!url.hostname || url.username || url.password || url.port === '0') throw new Error();
  } catch {
    return configError('INVALID_FIELD', file, field, 'must be an HTTP(S) proxy origin without credentials, path, query, fragment, or controls');
  }
  return result;
}

function httpsUrl(value: unknown, file: string, field: string): string {
  const result = text(value, file, field);
  try {
    if (new URL(result).protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    return configError('INVALID_FIELD', file, field, 'must be a valid HTTPS URL');
  }
  return result;
}

function insidePath(root: string, candidate: string): boolean {
  const relative = win32.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative));
}

function repositoryDirectory(value: unknown, file: string, field: string): string {
  const repository = text(value, file, field);
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    return configError('INVALID_FIELD', file, field, 'must be owner/repository');
  }
  return parts.join('--');
}

function windowsFileName(value: unknown, file: string, field: string): string {
  const result = text(value, file, field);
  if (!/^[A-Za-z0-9_.-]+\.dll$/i.test(result) || /[\x00-\x1f\x7f]/.test(result)) {
    return configError('INVALID_FIELD', file, field, 'must be a safe DLL file name');
  }
  return result;
}

function readYaml(path: string, file: string): Record<string, unknown> {
  return object(YAML.parse(readFileSync(path, 'utf8')) ?? {}, file, '<root>');
}

function loadEngine(path: string): EngineConfig {
  const file = 'config/engine.yaml';
  const raw = readYaml(path, file);
  closed(raw, ['engine_name', 'arxiv', 'runtime', 'server', 'mineru', 'evidence', 'research_evidence'], file);

  const arxiv = object(raw.arxiv, file, 'arxiv');
  closed(arxiv, [
    'page_size', 'request_interval_seconds', 'max_attempts', 'max_backoff_seconds',
    'request_timeout_seconds', 'retry_jitter_ms', 'capacity_cooldown_seconds',
    'candidate_pool_multiplier', 'max_results_per_shard',
  ], file, 'arxiv');

  const runtime = object(raw.runtime, file, 'runtime');
  closed(runtime, ['process_cleanup_timeout_ms', 'diagnostic_timeout_ms', 'max_output_bytes'], file, 'runtime');

  const server = object(raw.server, file, 'server');
  closed(server, ['host', 'port', 'sse_heartbeat_seconds'], file, 'server');

  const mineru = object(raw.mineru, file, 'mineru');
  closed(mineru, [
    'model_source_runtime', 'model', 'allowed_models', 'max_concurrency',
    'processing_window_size', 'pipeline_batch_ratio', 'pipeline_method',
    'pipeline_language', 'formula_enabled', 'table_enabled', 'vlm_lmdeploy_backend',
    'vlm_batch_size', 'vlm_cache_max_entry_count', 'task_timeout_seconds',
    'result_download_timeout_seconds', 'api_host', 'api_port',
    'api_startup_timeout_seconds', 'local_import',
  ], file, 'mineru');
  const batchRatio = integer(mineru.pipeline_batch_ratio, file, 'mineru.pipeline_batch_ratio');
  if (![1, 2, 4, 8, 16].includes(batchRatio)) {
    configError('INVALID_FIELD', file, 'mineru.pipeline_batch_ratio', 'must be 1, 2, 4, 8, or 16');
  }
  const model = text(mineru.model, file, 'mineru.model');
  if (model !== 'pipeline' && model !== 'vlm') {
    configError('INVALID_FIELD', file, 'mineru.model', 'must be pipeline or vlm');
  }
  const allowedModels = strings(mineru.allowed_models, file, 'mineru.allowed_models');
  if (new Set(allowedModels).size !== allowedModels.length
    || allowedModels.some((value) => value !== 'pipeline' && value !== 'vlm')
    || !allowedModels.includes(model)) {
    configError('INVALID_FIELD', file, 'mineru.allowed_models', 'must contain only supported models and include mineru.model');
  }
  const cacheRatio = finite(mineru.vlm_cache_max_entry_count, file, 'mineru.vlm_cache_max_entry_count');
  if (cacheRatio <= 0 || cacheRatio > 1) {
    configError('INVALID_FIELD', file, 'mineru.vlm_cache_max_entry_count', 'must be within (0, 1]');
  }
  const apiHost = text(mineru.api_host, file, 'mineru.api_host');
  if (apiHost !== '127.0.0.1') {
    configError('INVALID_FIELD', file, 'mineru.api_host', 'must be 127.0.0.1');
  }
  const apiPort = port(mineru.api_port, file, 'mineru.api_port');
  if (apiPort < 1024) {
    configError('INVALID_FIELD', file, 'mineru.api_port', 'must be >= 1024');
  }
  if (mineru.model_source_runtime !== 'local') {
    configError('INVALID_FIELD', file, 'mineru.model_source_runtime', 'must be local');
  }
  if (mineru.max_concurrency !== 1) {
    configError('INVALID_FIELD', file, 'mineru.max_concurrency', 'must be 1');
  }
  if (!['auto', 'txt', 'ocr'].includes(String(mineru.pipeline_method))) {
    configError('INVALID_FIELD', file, 'mineru.pipeline_method', 'must be auto, txt, or ocr');
  }
  if (mineru.vlm_lmdeploy_backend !== 'turbomind') {
    configError('INVALID_FIELD', file, 'mineru.vlm_lmdeploy_backend', 'must be turbomind');
  }
  if (JSON.stringify(allowedModels) !== JSON.stringify(['pipeline', 'vlm'])) {
    configError('INVALID_FIELD', file, 'mineru.allowed_models', 'must be pipeline and vlm');
  }

  const localImport = object(mineru.local_import, file, 'mineru.local_import');
  closed(localImport, ['recursive', 'max_files', 'max_pdf_pages', 'max_pdf_size_mb', 'default_track', 'roots'], file, 'mineru.local_import');
  const importRoots = localImport.roots === undefined ? undefined : (() => {
    if (!Array.isArray(localImport.roots)) {
      return configError('INVALID_FIELD', file, 'mineru.local_import.roots', 'must be an array');
    }
    const roots = localImport.roots.map((value, index) => {
      const root = object(value, file, `mineru.local_import.roots.${index}`);
      closed(root, ['id', 'path'], file, `mineru.local_import.roots.${index}`);
      const id = text(root.id, file, `mineru.local_import.roots.${index}.id`);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
        configError('INVALID_FIELD', file, `mineru.local_import.roots.${index}.id`, 'must be a safe identifier');
      }
      return { id, path: absolutePath(root.path, file, `mineru.local_import.roots.${index}.path`) };
    });
    if (new Set(roots.map((root) => root.id)).size !== roots.length) {
      configError('INVALID_FIELD', file, 'mineru.local_import.roots', 'ids must be unique');
    }
    return roots;
  })();
  const normalizedLocalImport: LocalImportConfig = {
    recursive: bool(localImport.recursive, file, 'mineru.local_import.recursive'),
    maxFiles: integer(localImport.max_files, file, 'mineru.local_import.max_files'),
    maxPdfPages: integer(localImport.max_pdf_pages, file, 'mineru.local_import.max_pdf_pages'),
    maxPdfSizeMb: integer(localImport.max_pdf_size_mb, file, 'mineru.local_import.max_pdf_size_mb'),
    defaultTrack: text(localImport.default_track, file, 'mineru.local_import.default_track'),
    ...(importRoots === undefined ? {} : { roots: importRoots }),
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalizedLocalImport.defaultTrack)) {
    configError('INVALID_FIELD', file, 'mineru.local_import.default_track', 'must be a safe identifier');
  }

  const evidence = object(raw.evidence, file, 'evidence');
  closed(evidence, ['schema_version', 'root', 'paper_root', 'index_roots', 'publisher_version'], file, 'evidence');
  const indexRoots = object(evidence.index_roots, file, 'evidence.index_roots');
  closed(indexRoots, ['authors', 'categories', 'tracks', 'years'], file, 'evidence.index_roots');
  if (evidence.schema_version !== EVIDENCE_POLICY_V3.schemaVersion || evidence.root !== EVIDENCE_POLICY_V3.root
    || evidence.paper_root !== EVIDENCE_POLICY_V3.paperRoot || evidence.publisher_version !== EVIDENCE_POLICY_V3.publisherVersion
    || Object.entries(EVIDENCE_POLICY_V3.indexRoots).some(([key, path]) => indexRoots[key] !== path)) {
    configError('INVALID_FIELD', file, 'evidence', 'must match Evidence policy schema 3');
  }
  const researchEvidence = object(raw.research_evidence, file, 'research_evidence');
  closed(researchEvidence, ['schema_version', 'root', 'source_root', 'index_roots', 'publisher_version'], file, 'research_evidence');
  const researchIndexRoots = object(researchEvidence.index_roots, file, 'research_evidence.index_roots');
  const expectedResearchEvidence: ResearchEvidencePolicy = {
    schemaVersion: 1,
    root: 'Evidence',
    sourceRoot: 'sources',
    indexRoots: {
      topics: 'indexes/topics.md', sourceTypes: 'indexes/source-types.md',
      lifecycles: 'indexes/lifecycles.md', concepts: 'indexes/concepts.md',
    },
    publisherVersion: 1,
  };
  closed(researchIndexRoots, ['topics', 'source_types', 'lifecycles', 'concepts'], file, 'research_evidence.index_roots');
  if (researchEvidence.schema_version !== expectedResearchEvidence.schemaVersion
    || researchEvidence.root !== expectedResearchEvidence.root
    || researchEvidence.source_root !== expectedResearchEvidence.sourceRoot
    || researchEvidence.publisher_version !== expectedResearchEvidence.publisherVersion
    || researchIndexRoots.topics !== expectedResearchEvidence.indexRoots.topics
    || researchIndexRoots.source_types !== expectedResearchEvidence.indexRoots.sourceTypes
    || researchIndexRoots.lifecycles !== expectedResearchEvidence.indexRoots.lifecycles
    || researchIndexRoots.concepts !== expectedResearchEvidence.indexRoots.concepts) {
    configError('INVALID_FIELD', file, 'research_evidence', 'must match research Evidence policy schema 1');
  }

  const engineName = text(raw.engine_name, file, 'engine_name');
  if (engineName !== 'paper-knowledge-engine') {
    configError('INVALID_FIELD', file, 'engine_name', 'must be paper-knowledge-engine');
  }
  const arxivConfig = {
    pageSize: integer(arxiv.page_size, file, 'arxiv.page_size'),
    requestIntervalMs: integer(arxiv.request_interval_seconds, file, 'arxiv.request_interval_seconds') * 1000,
    maxAttempts: integer(arxiv.max_attempts, file, 'arxiv.max_attempts'),
    maxBackoffMs: integer(arxiv.max_backoff_seconds, file, 'arxiv.max_backoff_seconds') * 1000,
    requestTimeoutMs: integer(arxiv.request_timeout_seconds, file, 'arxiv.request_timeout_seconds') * 1000,
    retryJitterMs: integer(arxiv.retry_jitter_ms, file, 'arxiv.retry_jitter_ms', 0),
    capacityCooldownMs: integer(arxiv.capacity_cooldown_seconds, file, 'arxiv.capacity_cooldown_seconds') * 1000,
    candidatePoolMultiplier: integer(arxiv.candidate_pool_multiplier, file, 'arxiv.candidate_pool_multiplier'),
    maxResultsPerShard: integer(arxiv.max_results_per_shard, file, 'arxiv.max_results_per_shard'),
  };
  if (arxivConfig.pageSize > 100) configError('INVALID_FIELD', file, 'arxiv.page_size', 'must be <= 100');
  if (arxivConfig.requestIntervalMs < 3000) configError('INVALID_FIELD', file, 'arxiv.request_interval_seconds', 'must be >= 3');
  if (arxivConfig.maxAttempts > 10) configError('INVALID_FIELD', file, 'arxiv.max_attempts', 'must be <= 10');
  if (arxivConfig.maxBackoffMs < arxivConfig.requestIntervalMs) configError('INVALID_FIELD', file, 'arxiv.max_backoff_seconds', 'must cover the request interval');
  if (arxivConfig.requestTimeoutMs < 10000) configError('INVALID_FIELD', file, 'arxiv.request_timeout_seconds', 'must be >= 10');
  if (arxivConfig.retryJitterMs > 5000) configError('INVALID_FIELD', file, 'arxiv.retry_jitter_ms', 'must be <= 5000');
  if (arxivConfig.capacityCooldownMs < 1000) configError('INVALID_FIELD', file, 'arxiv.capacity_cooldown_seconds', 'must be >= 1');
  if (arxivConfig.maxResultsPerShard < arxivConfig.pageSize) configError('INVALID_FIELD', file, 'arxiv.max_results_per_shard', 'must cover one page');

  return {
    engineName,
    arxiv: arxivConfig,
    runtime: {
      processCleanupTimeoutMs: integer(runtime.process_cleanup_timeout_ms, file, 'runtime.process_cleanup_timeout_ms'),
      diagnosticTimeoutMs: integer(runtime.diagnostic_timeout_ms, file, 'runtime.diagnostic_timeout_ms'),
      maxOutputBytes: integer(runtime.max_output_bytes, file, 'runtime.max_output_bytes'),
    },
    server: {
      host: text(server.host, file, 'server.host'),
      port: port(server.port, file, 'server.port'),
      sseHeartbeatMs: integer(server.sse_heartbeat_seconds, file, 'server.sse_heartbeat_seconds') * 1000,
    },
    mineru: {
      modelSourceRuntime: text(mineru.model_source_runtime, file, 'mineru.model_source_runtime'),
      model: model as MinerUModel,
      allowedModels: allowedModels as MinerUModel[],
      maxConcurrency: integer(mineru.max_concurrency, file, 'mineru.max_concurrency'),
      processingWindowSize: integer(mineru.processing_window_size, file, 'mineru.processing_window_size'),
      pipelineBatchRatio: batchRatio as PipelineBatchRatio,
      pipelineMethod: text(mineru.pipeline_method, file, 'mineru.pipeline_method'),
      pipelineLanguage: text(mineru.pipeline_language, file, 'mineru.pipeline_language'),
      formulaEnabled: bool(mineru.formula_enabled, file, 'mineru.formula_enabled'),
      tableEnabled: bool(mineru.table_enabled, file, 'mineru.table_enabled'),
      vlmLmdeployBackend: text(mineru.vlm_lmdeploy_backend, file, 'mineru.vlm_lmdeploy_backend'),
      vlmBatchSize: integer(mineru.vlm_batch_size, file, 'mineru.vlm_batch_size'),
      vlmCacheMaxEntryCount: cacheRatio,
      taskTimeoutMs: integer(mineru.task_timeout_seconds, file, 'mineru.task_timeout_seconds') * 1000,
      resultDownloadTimeoutMs: integer(mineru.result_download_timeout_seconds, file, 'mineru.result_download_timeout_seconds') * 1000,
      apiHost,
      apiPort,
      apiStartupTimeoutMs: integer(mineru.api_startup_timeout_seconds, file, 'mineru.api_startup_timeout_seconds') * 1000,
      localImport: normalizedLocalImport,
    },
    evidence: EVIDENCE_POLICY_V3,
    researchEvidence: expectedResearchEvidence,
  };
}

function loadMachine(path: string): MachineConfig {
  const file = 'config/machine.local.yaml';
  const raw = readYaml(path, file);
  closed(raw, ['roots', 'mineru', 'network'], file);
  const network = raw.network === undefined ? undefined : object(raw.network, file, 'network');
  if (network) closed(network, ['http_proxy', 'opencli_proxy_mode', 'arxiv_api_base'], file, 'network');
  const httpProxy = network?.http_proxy === undefined
    ? undefined
    : httpProxyUrl(network.http_proxy, file, 'network.http_proxy');
  let openCliProxyMode;
  if (network) {
    try {
      openCliProxyMode = resolveOpenCliProxyMode(network.opencli_proxy_mode, httpProxy !== undefined);
    } catch {
      return configError('INVALID_FIELD', file, 'network.opencli_proxy_mode', 'must be configured, direct, or inherit');
    }
  }
  let arxivApiBase;
  if (network?.arxiv_api_base !== undefined) {
    try {
      arxivApiBase = resolveArxivApiBase(text(network.arxiv_api_base, file, 'network.arxiv_api_base'));
    } catch {
      return configError('INVALID_FIELD', file, 'network.arxiv_api_base', 'must be a known arXiv API base');
    }
  }

  const roots = object(raw.roots, file, 'roots');
  closed(roots, ['data_libraries_root', 'backup_libraries_root', 'vaults_root', 'pdf_libraries_root'], file, 'roots');

  const mineru = object(raw.mineru, file, 'mineru');
  closed(mineru, [
    'source_root', 'expected_version', 'expected_commit', 'python_version', 'venv_root',
    'model_source_setup', 'modelscope_revision', 'model_download_type', 'models_root',
    'modelscope_cache_root', 'mineru_tools_config', 'pipeline_models_dir', 'vlm_models_dir',
    'pipeline_model_repository', 'pipeline_required_paths', 'vlm_model_repository',
    'expected_gpu_name', 'mineru_install_extras', 'torch_index_url', 'lmdeploy_wheel_url',
    'cuda_runtime_dll', 'cuda_visible_devices', 'pipeline_device_mode', 'vlm_device',
  ], file, 'mineru');
  if (!Array.isArray(mineru.pipeline_required_paths) || mineru.pipeline_required_paths.length < 1) {
    configError('INVALID_FIELD', file, 'mineru.pipeline_required_paths', 'must be a non-empty array');
  }

  const sourceRoot = absolutePath(mineru.source_root, file, 'mineru.source_root');
  const venvRoot = absolutePath(mineru.venv_root, file, 'mineru.venv_root');
  if (sourceRoot === venvRoot || !insidePath(sourceRoot, venvRoot)) {
    configError('INVALID_FIELD', file, 'mineru.venv_root', 'must be inside mineru.source_root');
  }
  const expectedCommit = text(mineru.expected_commit, file, 'mineru.expected_commit').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
    configError('INVALID_FIELD', file, 'mineru.expected_commit', 'must be a 40-character Git SHA');
  }
  const pythonVersion = text(mineru.python_version, file, 'mineru.python_version');
  if (!/^\d+\.\d+$/.test(pythonVersion)) {
    configError('INVALID_FIELD', file, 'mineru.python_version', 'must be major.minor');
  }
  if (mineru.model_source_setup !== 'modelscope') {
    configError('INVALID_FIELD', file, 'mineru.model_source_setup', 'must be modelscope');
  }
  if (mineru.pipeline_device_mode !== 'cuda') {
    configError('INVALID_FIELD', file, 'mineru.pipeline_device_mode', 'must be cuda');
  }
  if (mineru.vlm_device !== 'cuda') {
    configError('INVALID_FIELD', file, 'mineru.vlm_device', 'must be cuda');
  }
  const modelsRoot = absolutePath(mineru.models_root, file, 'mineru.models_root');
  const modelScopeCacheRoot = absolutePath(mineru.modelscope_cache_root, file, 'mineru.modelscope_cache_root');
  if (modelsRoot === modelScopeCacheRoot || !insidePath(modelsRoot, modelScopeCacheRoot)) {
    configError('INVALID_FIELD', file, 'mineru.modelscope_cache_root', 'must be inside mineru.models_root');
  }
  const pipelineRepositoryDirectory = repositoryDirectory(mineru.pipeline_model_repository, file, 'mineru.pipeline_model_repository');
  const vlmRepositoryDirectory = repositoryDirectory(mineru.vlm_model_repository, file, 'mineru.vlm_model_repository');
  const modelCacheDirectory = win32.join(modelScopeCacheRoot, 'models');
  const pipelineModelsDir = absolutePath(mineru.pipeline_models_dir, file, 'mineru.pipeline_models_dir');
  const vlmModelsDir = absolutePath(mineru.vlm_models_dir, file, 'mineru.vlm_models_dir');
  if (!insidePath(modelCacheDirectory, pipelineModelsDir)
    || win32.relative(win32.join(modelCacheDirectory, pipelineRepositoryDirectory), pipelineModelsDir) !== '') {
    configError('INVALID_FIELD', file, 'mineru.pipeline_models_dir', 'must match the configured repository under the ModelScope cache');
  }
  if (!insidePath(modelCacheDirectory, vlmModelsDir)
    || win32.relative(win32.join(modelCacheDirectory, vlmRepositoryDirectory), vlmModelsDir) !== '') {
    configError('INVALID_FIELD', file, 'mineru.vlm_models_dir', 'must match the configured repository under the ModelScope cache');
  }

  return {
    roots: {
      ...(roots.pdf_libraries_root === undefined ? {} : {
        pdfLibrariesRoot: absolutePath(roots.pdf_libraries_root, file, 'roots.pdf_libraries_root'),
      }),
      dataLibrariesRoot: absolutePath(roots.data_libraries_root, file, 'roots.data_libraries_root'),
      backupLibrariesRoot: absolutePath(roots.backup_libraries_root, file, 'roots.backup_libraries_root'),
      vaultsRoot: absolutePath(roots.vaults_root, file, 'roots.vaults_root'),
    },
    ...(network === undefined ? {} : { network: {
      ...(httpProxy === undefined ? {} : { httpProxy }),
      openCliProxyMode,
      ...(arxivApiBase === undefined ? {} : { arxivApiBase }),
    } }),
    mineru: {
      sourceRoot,
      expectedVersion: text(mineru.expected_version, file, 'mineru.expected_version'),
      expectedCommit,
      pythonVersion,
      venvRoot,
      modelSourceSetup: text(mineru.model_source_setup, file, 'mineru.model_source_setup'),
      modelScopeRevision: text(mineru.modelscope_revision, file, 'mineru.modelscope_revision'),
      modelDownloadType: text(mineru.model_download_type, file, 'mineru.model_download_type'),
      modelsRoot,
      modelScopeCacheRoot,
      mineruToolsConfig: absolutePath(mineru.mineru_tools_config, file, 'mineru.mineru_tools_config'),
      pipelineModelsDir,
      vlmModelsDir,
      pipelineModelRepository: text(mineru.pipeline_model_repository, file, 'mineru.pipeline_model_repository'),
      pipelineRequiredPaths: mineru.pipeline_required_paths.map((value, index) => safeRelativePath(value, file, `mineru.pipeline_required_paths.${index}`)),
      vlmModelRepository: text(mineru.vlm_model_repository, file, 'mineru.vlm_model_repository'),
      expectedGpuName: text(mineru.expected_gpu_name, file, 'mineru.expected_gpu_name'),
      mineruInstallExtras: text(mineru.mineru_install_extras, file, 'mineru.mineru_install_extras'),
      torchIndexUrl: httpsUrl(mineru.torch_index_url, file, 'mineru.torch_index_url'),
      lmdeployWheelUrl: httpsUrl(mineru.lmdeploy_wheel_url, file, 'mineru.lmdeploy_wheel_url'),
      cudaRuntimeDll: windowsFileName(mineru.cuda_runtime_dll, file, 'mineru.cuda_runtime_dll'),
      cudaVisibleDevices: text(mineru.cuda_visible_devices, file, 'mineru.cuda_visible_devices'),
      pipelineDeviceMode: text(mineru.pipeline_device_mode, file, 'mineru.pipeline_device_mode'),
      vlmDevice: text(mineru.vlm_device, file, 'mineru.vlm_device'),
    },
  };
}

function loadWeeklySchedule(value: unknown, file: string): WeeklySchedule {
  const raw = object(value, file, 'weekly_schedule');
  closed(raw, ['enabled', 'task_name', 'day_of_week', 'interval_weeks', 'start_date', 'local_time', 'timezone', 'max_papers'], file, 'weekly_schedule');
  const dayOfWeek = text(raw.day_of_week, file, 'weekly_schedule.day_of_week');
  const weekdays = new Set<Weekday>(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
  if (!weekdays.has(dayOfWeek as Weekday)) {
    configError('INVALID_FIELD', file, 'weekly_schedule.day_of_week', 'must be a weekday');
  }
  const localTime = text(raw.local_time, file, 'weekly_schedule.local_time');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    configError('INVALID_FIELD', file, 'weekly_schedule.local_time', 'must be HH:mm');
  }
  const taskName = text(raw.task_name, file, 'weekly_schedule.task_name');
  if (/[\\/:*?"<>|]/.test(taskName)) {
    configError('INVALID_FIELD', file, 'weekly_schedule.task_name', 'contains forbidden characters');
  }
  const timezone = text(raw.timezone, file, 'weekly_schedule.timezone');
  if (!validTimeZone(timezone)) {
    configError('INVALID_FIELD', file, 'weekly_schedule.timezone', 'must be an IANA timezone');
  }
  const intervalWeeks = integer(raw.interval_weeks, file, 'weekly_schedule.interval_weeks');
  if (intervalWeeks > 52) {
    configError('INVALID_FIELD', file, 'weekly_schedule.interval_weeks', 'must be <= 52');
  }
  const startDate = date(raw.start_date, file, 'weekly_schedule.start_date');
  const parsedStart = new Date(`${startDate}T00:00:00.000Z`);
  if (parsedStart.getUTCFullYear() < 1) {
    configError('INVALID_FIELD', file, 'weekly_schedule.start_date', 'year must be >= 1');
  }
  const startWeekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][parsedStart.getUTCDay()];
  if (startWeekday !== dayOfWeek) {
    configError('INVALID_FIELD', file, 'weekly_schedule.start_date', 'must match weekly_schedule.day_of_week');
  }
  return {
    enabled: bool(raw.enabled, file, 'weekly_schedule.enabled'),
    taskName,
    dayOfWeek: dayOfWeek as Weekday,
    intervalWeeks,
    startDate,
    localTime,
    timezone,
    maxPapers: integer(raw.max_papers, file, 'weekly_schedule.max_papers'),
  };
}

function loadPaperPolicy(value: unknown, file: string): PaperPolicy {
  const raw = object(value, file, 'paper_policy');
  closed(raw, [
    'start_date', 'excluded_domains', 'ai_technique_terms', 'program_structure_terms',
    'engineering_task_terms', 'term_variants', 'track_priority',
  ], file, 'paper_policy');
  const variants = object(raw.term_variants, file, 'paper_policy.term_variants');
  const termVariants: Record<string, string[]> = {};
  for (const [term, forms] of Object.entries(variants)) {
    termVariants[term] = strings(forms, file, `paper_policy.term_variants.${term}`);
  }
  return {
    startDate: date(raw.start_date, file, 'paper_policy.start_date'),
    excludedDomains: strings(raw.excluded_domains, file, 'paper_policy.excluded_domains'),
    aiTechniqueTerms: strings(raw.ai_technique_terms, file, 'paper_policy.ai_technique_terms'),
    programStructureTerms: strings(raw.program_structure_terms, file, 'paper_policy.program_structure_terms'),
    engineeringTaskTerms: strings(raw.engineering_task_terms, file, 'paper_policy.engineering_task_terms'),
    termVariants,
    trackPriority: strings(raw.track_priority, file, 'paper_policy.track_priority'),
  };
}

function loadCategories(value: unknown, file: string): LibraryCategoryConfig {
  const raw = object(value, file, 'categories');
  closed(raw, ['tracks', 'fallback_pdf'], file, 'categories');
  const tracks = object(raw.tracks, file, 'categories.tracks');
  const result: Record<string, { pdf: string }> = {};
  for (const [track, config] of Object.entries(tracks)) {
    const entry = object(config, file, `categories.tracks.${track}`);
    closed(entry, ['pdf'], file, `categories.tracks.${track}`);
    result[track] = { pdf: text(entry.pdf, file, `categories.tracks.${track}.pdf`) };
  }
  return {
    tracks: result,
    fallbackPdf: text(raw.fallback_pdf, file, 'categories.fallback_pdf'),
  };
}

function libraryYaml(directory: string, selectedLibraryId: string, name: string): Record<string, unknown> {
  const path = join(directory, name);
  const file = `config/${selectedLibraryId}/${name}`;
  if (!existsSync(path)) configError('MISSING_CONFIG', file, '<root>', 'is required');
  return readYaml(path, file);
}

function assertLibraryIdentity(raw: Record<string, unknown>, file: string, selectedLibraryId: string): string {
  const libraryId = text(raw.library_id, file, 'library_id');
  if (libraryId !== selectedLibraryId) {
    throw new Error(`LIBRARY_ID_MISMATCH: expected ${selectedLibraryId}, received ${libraryId}`);
  }
  return libraryId;
}

function loadPaperLibrary(directory: string, selectedLibraryId: string, raw: Record<string, unknown>): PaperLibraryConfig {
  const file = `config/${selectedLibraryId}/library.yaml`;
  closed(raw, [
    'library_kind', 'library_id', 'display_name', 'start_date', 'overlap_hours',
    'download_after_hard_filter', 'current_task', 'weekly_schedule',
  ], file);
  if (raw.library_kind !== 'paper') configError('INVALID_FIELD', file, 'library_kind', 'must be paper');
  const libraryId = assertLibraryIdentity(raw, file, selectedLibraryId);
  const currentTask = object(raw.current_task, file, 'current_task');
  closed(currentTask, ['max_papers', 'track_limits'], file, 'current_task');
  const limits = object(currentTask.track_limits, file, 'current_task.track_limits');
  const trackLimits: Record<string, number> = {};
  for (const [track, limit] of Object.entries(limits)) {
    trackLimits[track] = integer(limit, file, `current_task.track_limits.${track}`, 0);
  }
  const maxPapers = integer(currentTask.max_papers, file, 'current_task.max_papers');
  if (Object.values(trackLimits).reduce((sum, limit) => sum + limit, 0) !== maxPapers) {
    configError('INVALID_FIELD', file, 'current_task.track_limits', `must total ${maxPapers}`);
  }
  const queryFile = `config/${selectedLibraryId}/query-matrix.yaml`;
  const query = libraryYaml(directory, selectedLibraryId, 'query-matrix.yaml');
  closed(query, ['tracks'], queryFile);
  if (!Array.isArray(query.tracks)) configError('INVALID_FIELD', queryFile, 'tracks', 'must be an array');
  const tracks: LibraryTrackConfig[] = query.tracks.map((value, index) => {
    const track = object(value, queryFile, `tracks.${index}`);
    closed(track, ['id', 'query', 'categories', 'date_modes'], queryFile, `tracks.${index}`);
    const dateModes = strings(track.date_modes, queryFile, `tracks.${index}.date_modes`);
    if (dateModes.length !== 2 || !dateModes.includes('submitted') || !dateModes.includes('updated')) {
      configError('INVALID_FIELD', queryFile, `tracks.${index}.date_modes`, 'must contain submitted and updated exactly once');
    }
    return {
      id: text(track.id, queryFile, `tracks.${index}.id`),
      query: text(track.query, queryFile, `tracks.${index}.query`),
      categories: strings(track.categories, queryFile, `tracks.${index}.categories`),
      dateModes: dateModes as LibraryDateModes,
    };
  });
  return {
    kind: 'paper', libraryId, displayName: text(raw.display_name, file, 'display_name'),
    startDate: date(raw.start_date, file, 'start_date'),
    overlapHours: integer(raw.overlap_hours, file, 'overlap_hours', 0),
    currentTask: { maxPapers, trackLimits }, weeklySchedule: loadWeeklySchedule(raw.weekly_schedule, file),
    downloadAfterHardFilter: bool(raw.download_after_hard_filter, file, 'download_after_hard_filter'), tracks,
    paperPolicy: loadPaperPolicy(libraryYaml(directory, selectedLibraryId, 'paper-policy.yaml'), `config/${selectedLibraryId}/paper-policy.yaml`),
    categories: loadCategories(libraryYaml(directory, selectedLibraryId, 'categories.yaml'), `config/${selectedLibraryId}/categories.yaml`),
  };
}

function researchSourceKind(value: unknown, file: string, field: string): ResearchSourceKind {
  const result = text(value, file, field);
  if (!(researchSourceKinds as readonly string[]).includes(result)) configError('INVALID_FIELD', file, field, 'must be a supported research source kind');
  return result as ResearchSourceKind;
}

function domain(value: unknown, file: string, field: string): string {
  const result = text(value, file, field).toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(result)) {
    configError('INVALID_FIELD', file, field, 'must be a public domain name');
  }
  return result;
}

function arxivCategory(value: unknown, file: string, field: string): string {
  const result = text(value, file, field);
  if (!/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)?$/.test(result)) {
    configError('INVALID_FIELD', file, field, 'must be a valid arXiv category');
  }
  return result;
}

function unique<T>(values: T[], file: string, field: string): T[] {
  if (!values.length || new Set(values).size !== values.length) configError('INVALID_FIELD', file, field, 'must be a non-empty array with unique values');
  return values;
}

function loadResearchSchedule(value: unknown, file: string): ResearchWeeklySchedule {
  const raw = object(value, file, 'weekly_schedule');
  closed(raw, ['enabled', 'task_name', 'day_of_week', 'interval_weeks', 'start_date', 'local_time', 'timezone', 'max_sources'], file, 'weekly_schedule');
  const dayOfWeek = text(raw.day_of_week, file, 'weekly_schedule.day_of_week');
  const weekdays = new Set<Weekday>(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
  if (!weekdays.has(dayOfWeek as Weekday)) configError('INVALID_FIELD', file, 'weekly_schedule.day_of_week', 'must be a weekday');
  const localTime = text(raw.local_time, file, 'weekly_schedule.local_time');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) configError('INVALID_FIELD', file, 'weekly_schedule.local_time', 'must be HH:mm');
  const taskName = text(raw.task_name, file, 'weekly_schedule.task_name');
  if (/[\\/:*?"<>|]/.test(taskName)) configError('INVALID_FIELD', file, 'weekly_schedule.task_name', 'contains forbidden characters');
  const timezone = text(raw.timezone, file, 'weekly_schedule.timezone');
  if (!validTimeZone(timezone)) configError('INVALID_FIELD', file, 'weekly_schedule.timezone', 'must be an IANA timezone');
  const intervalWeeks = integer(raw.interval_weeks, file, 'weekly_schedule.interval_weeks');
  if (intervalWeeks > 52) configError('INVALID_FIELD', file, 'weekly_schedule.interval_weeks', 'must be <= 52');
  const startDate = date(raw.start_date, file, 'weekly_schedule.start_date');
  const startWeekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${startDate}T00:00:00.000Z`).getUTCDay()];
  if (startWeekday !== dayOfWeek) configError('INVALID_FIELD', file, 'weekly_schedule.start_date', 'must match weekly_schedule.day_of_week');
  return { enabled: bool(raw.enabled, file, 'weekly_schedule.enabled'), taskName, dayOfWeek: dayOfWeek as Weekday, intervalWeeks, startDate, localTime, timezone, maxSources: integer(raw.max_sources, file, 'weekly_schedule.max_sources') };
}

function loadResearchPolicy(directory: string, selectedLibraryId: string): SourcePolicyConfig {
  const file = `config/${selectedLibraryId}/source-policy.yaml`;
  const raw = libraryYaml(directory, selectedLibraryId, 'source-policy.yaml');
  closed(raw, ['date_lower_bound', 'source_kinds', 'allowed_domains', 'identity_version_rules', 'max_response_bytes', 'request_timeout_seconds', 'max_attempts', 'retain_all_versions', 'content_hash'], file);
  const sourceKinds = unique(strings(raw.source_kinds, file, 'source_kinds').map((value, index) => researchSourceKind(value, file, `source_kinds.${index}`)), file, 'source_kinds');
  if (sourceKinds.length !== researchSourceKinds.length || researchSourceKinds.some(kind => !sourceKinds.includes(kind))) {
    configError('INVALID_FIELD', file, 'source_kinds', 'must declare every supported research source kind exactly once');
  }
  const identityRules = object(raw.identity_version_rules, file, 'identity_version_rules');
  closed(identityRules, researchSourceKinds, file, 'identity_version_rules');
  const identityVersionRules = Object.fromEntries(researchSourceKinds.map(kind => [kind, text(identityRules[kind], file, `identity_version_rules.${kind}`)])) as Record<ResearchSourceKind, string>;
  if (raw.retain_all_versions !== true) configError('INVALID_FIELD', file, 'retain_all_versions', 'must be true');
  if (raw.content_hash !== 'sha256') configError('INVALID_FIELD', file, 'content_hash', 'must be sha256');
  return {
    dateLowerBound: date(raw.date_lower_bound, file, 'date_lower_bound'), sourceKinds,
    allowedDomains: unique(strings(raw.allowed_domains, file, 'allowed_domains').map((value, index) => domain(value, file, `allowed_domains.${index}`)), file, 'allowed_domains'),
    identityVersionRules, maxResponseBytes: integer(raw.max_response_bytes, file, 'max_response_bytes'),
    requestTimeoutMs: integer(raw.request_timeout_seconds, file, 'request_timeout_seconds') * 1000,
    maxAttempts: integer(raw.max_attempts, file, 'max_attempts'), retainAllVersions: true, contentHash: 'sha256',
  };
}

function taxonomyStrings(value: unknown, file: string, field: string): string[] {
  return unique(strings(value, file, field), file, field);
}

function loadTopicTaxonomy(directory: string, selectedLibraryId: string): TopicTaxonomyConfig {
  const file = `config/${selectedLibraryId}/topic-taxonomy.yaml`;
  const raw = libraryYaml(directory, selectedLibraryId, 'topic-taxonomy.yaml');
  closed(raw, ['tracks', 'lifecycles', 'control_boundaries', 'evidence_levels', 'testing_levels', 'evaluation_dimensions'], file);
  const tracks = taxonomyStrings(raw.tracks, file, 'tracks');
  if (tracks.length !== researchTrackIds.length || researchTrackIds.some(track => !tracks.includes(track))) configError('INVALID_FIELD', file, 'tracks', 'must declare the 15 supported research tracks exactly once');
  const dimensions = object(raw.evaluation_dimensions, file, 'evaluation_dimensions');
  closed(dimensions, ['objects', 'units', 'adjudicators', 'metrics', 'replay_strategies'], file, 'evaluation_dimensions');
  return {
    tracks, lifecycles: taxonomyStrings(raw.lifecycles, file, 'lifecycles'),
    controlBoundaries: taxonomyStrings(raw.control_boundaries, file, 'control_boundaries'),
    evidenceLevels: taxonomyStrings(raw.evidence_levels, file, 'evidence_levels'),
    testingLevels: taxonomyStrings(raw.testing_levels, file, 'testing_levels'),
    evaluationDimensions: {
      objects: taxonomyStrings(dimensions.objects, file, 'evaluation_dimensions.objects'),
      units: taxonomyStrings(dimensions.units, file, 'evaluation_dimensions.units'),
      adjudicators: taxonomyStrings(dimensions.adjudicators, file, 'evaluation_dimensions.adjudicators'),
      metrics: taxonomyStrings(dimensions.metrics, file, 'evaluation_dimensions.metrics'),
      replayStrategies: taxonomyStrings(dimensions.replay_strategies, file, 'evaluation_dimensions.replay_strategies'),
    },
  };
}

function loadResearchLibrary(directory: string, selectedLibraryId: string, raw: Record<string, unknown>): ResearchLibraryConfig {
  const file = `config/${selectedLibraryId}/library.yaml`;
  closed(raw, ['library_kind', 'library_id', 'display_name', 'start_date', 'current_task', 'weekly_schedule'], file);
  if (raw.library_kind !== 'research') configError('INVALID_FIELD', file, 'library_kind', 'must be research');
  for (const name of readdirSync(directory)) {
    if (!['library.yaml', 'query-matrix.yaml', 'source-policy.yaml', 'topic-taxonomy.yaml'].includes(name)) {
      configError('UNKNOWN_FIELD', `config/${selectedLibraryId}/${name}`, '<root>', 'is not allowed for research libraries');
    }
  }
  const libraryId = assertLibraryIdentity(raw, file, selectedLibraryId);
  const currentTask = object(raw.current_task, file, 'current_task');
  closed(currentTask, ['max_sources', 'track_limits', 'source_kind_limits'], file, 'current_task');
  const maxSources = integer(currentTask.max_sources, file, 'current_task.max_sources');
  const trackLimitsRaw = object(currentTask.track_limits, file, 'current_task.track_limits');
  const trackLimits = Object.fromEntries(Object.entries(trackLimitsRaw).map(([track, value]) => {
    if (!(researchTrackIds as readonly string[]).includes(track)) configError('INVALID_FIELD', file, `current_task.track_limits.${track}`, 'must name a supported research track');
    return [track, integer(value, file, `current_task.track_limits.${track}`, 0)];
  }));
  if (Object.keys(trackLimits).length !== researchTrackIds.length || researchTrackIds.some(track => !Object.hasOwn(trackLimits, track))) configError('INVALID_FIELD', file, 'current_task.track_limits', 'must declare every supported research track');
  if (Object.values(trackLimits).reduce((sum, limit) => sum + limit, 0) !== maxSources) configError('INVALID_FIELD', file, 'current_task.track_limits', `must total ${maxSources}`);
  const sourceKindLimitsRaw = object(currentTask.source_kind_limits, file, 'current_task.source_kind_limits');
  const sourceKindLimits: Partial<Record<ResearchSourceKind, number>> = {};
  for (const [kind, value] of Object.entries(sourceKindLimitsRaw)) sourceKindLimits[researchSourceKind(kind, file, `current_task.source_kind_limits.${kind}`)] = integer(value, file, `current_task.source_kind_limits.${kind}`, 0);
  const queryFile = `config/${selectedLibraryId}/query-matrix.yaml`;
  const query = libraryYaml(directory, selectedLibraryId, 'query-matrix.yaml');
  closed(query, ['tracks'], queryFile);
  if (!Array.isArray(query.tracks)) configError('INVALID_FIELD', queryFile, 'tracks', 'must be an array');
  const tracks: ResearchTrackConfig[] = query.tracks.map((value, index) => {
    const track = object(value, queryFile, `tracks.${index}`);
    closed(track, ['id', 'query', 'source_kinds', 'arxiv_categories', 'domains', 'date_fields'], queryFile, `tracks.${index}`);
    const id = text(track.id, queryFile, `tracks.${index}.id`);
    if (!(researchTrackIds as readonly string[]).includes(id)) configError('INVALID_FIELD', queryFile, `tracks.${index}.id`, 'must be a supported research track');
    const sourceKinds = unique(strings(track.source_kinds, queryFile, `tracks.${index}.source_kinds`).map((item, itemIndex) => researchSourceKind(item, queryFile, `tracks.${index}.source_kinds.${itemIndex}`)), queryFile, `tracks.${index}.source_kinds`);
    const arxivCategories = track.arxiv_categories === undefined ? [] : unique(
      strings(track.arxiv_categories, queryFile, `tracks.${index}.arxiv_categories`)
        .map((item, itemIndex) => arxivCategory(item, queryFile, `tracks.${index}.arxiv_categories.${itemIndex}`)),
      queryFile, `tracks.${index}.arxiv_categories`,
    );
    if (sourceKinds.some(kind => kind === 'paper' || kind === 'technical-report') && !arxivCategories.length) {
      configError('INVALID_FIELD', queryFile, `tracks.${index}.arxiv_categories`, 'must be a non-empty array for paper/technical-report discovery');
    }
    const dateFields = unique(strings(track.date_fields, queryFile, `tracks.${index}.date_fields`).map((item, itemIndex) => {
      if (!(researchDateFields as readonly string[]).includes(item)) configError('INVALID_FIELD', queryFile, `tracks.${index}.date_fields.${itemIndex}`, 'must be a supported research date field');
      return item as ResearchDateField;
    }), queryFile, `tracks.${index}.date_fields`);
    return { id, query: text(track.query, queryFile, `tracks.${index}.query`), sourceKinds, arxivCategories,
      domains: unique(strings(track.domains, queryFile, `tracks.${index}.domains`).map((item, itemIndex) => domain(item, queryFile, `tracks.${index}.domains.${itemIndex}`)), queryFile, `tracks.${index}.domains`), dateFields };
  });
  if (tracks.length !== researchTrackIds.length || new Set(tracks.map(track => track.id)).size !== tracks.length || researchTrackIds.some(id => !tracks.some(track => track.id === id))) configError('INVALID_FIELD', queryFile, 'tracks', 'must declare the 15 supported research tracks exactly once');
  const sourcePolicy = loadResearchPolicy(directory, selectedLibraryId);
  for (const [trackIndex, track] of tracks.entries()) {
    for (const [domainIndex, trackDomain] of track.domains.entries()) {
      if (!sourcePolicy.allowedDomains.includes(trackDomain)) {
        configError('INVALID_FIELD', queryFile, `tracks.${trackIndex}.domains.${domainIndex}`, 'must be listed in source_policy.allowed_domains');
      }
    }
  }
  const topicTaxonomy = loadTopicTaxonomy(directory, selectedLibraryId);
  if (sourcePolicy.dateLowerBound !== '2026-01-01') configError('INVALID_FIELD', `config/${selectedLibraryId}/source-policy.yaml`, 'date_lower_bound', 'must be 2026-01-01');
  if (date(raw.start_date, file, 'start_date') < sourcePolicy.dateLowerBound) configError('INVALID_FIELD', file, 'start_date', 'must not predate source_policy.date_lower_bound');
  return { kind: 'research', libraryId, displayName: text(raw.display_name, file, 'display_name'), startDate: date(raw.start_date, file, 'start_date'), currentTask: { maxSources, trackLimits, sourceKindLimits } as ResearchTaskLimits, weeklySchedule: loadResearchSchedule(raw.weekly_schedule, file), tracks, sourcePolicy, topicTaxonomy };
}

function loadLibrary(directory: string, selectedLibraryId: string): LibraryConfig {
  const file = `config/${selectedLibraryId}/library.yaml`;
  const raw = libraryYaml(directory, selectedLibraryId, 'library.yaml');
  const kind = text(raw.library_kind, file, 'library_kind');
  if (kind === 'paper') return loadPaperLibrary(directory, selectedLibraryId, raw);
  if (kind === 'research') return loadResearchLibrary(directory, selectedLibraryId, raw);
  return configError('INVALID_FIELD', file, 'library_kind', 'must be paper or research');
}

function validateResearchArxivNetwork(library: ResearchLibraryConfig, machine: MachineConfig): void {
  const apiBase = resolveArxivApiBase(machine.network?.arxivApiBase);
  const apiHost = new URL(apiBase).hostname;
  if (!library.sourcePolicy.allowedDomains.includes(apiHost)) {
    configError('INVALID_FIELD', 'config/machine.local.yaml', 'network.arxiv_api_base',
      `host ${apiHost} must be listed in config/${library.libraryId}/source-policy.yaml allowed_domains`);
  }
  const queryFile = `config/${library.libraryId}/query-matrix.yaml`;
  library.tracks.forEach((track, index) => {
    if (track.sourceKinds.some(kind => kind === 'paper' || kind === 'technical-report') && !track.domains.includes(apiHost)) {
      configError('INVALID_FIELD', queryFile, `tracks.${index}.domains`,
        `must include arXiv API host ${apiHost} for paper/technical-report discovery`);
    }
  });
}

function validateLibraryId(libraryId: string): void {
  if (!libraryIdPattern.test(libraryId)) throw new Error(`INVALID_LIBRARY_ID: ${libraryId}`);
}

export function parseLibrarySelection(argv: string[]): { libraryId?: string; argv: string[] } {
  let libraryId: string | undefined;
  let selected = false;
  const remaining: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--') {
      remaining.push(...argv.slice(index + 1));
      break;
    }
    if (argv[index] !== '--library') {
      remaining.push(argv[index]);
      continue;
    }
    if (selected) throw new Error('DUPLICATE_LIBRARY');
    selected = true;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('LIBRARY_ID_REQUIRED');
    validateLibraryId(value);
    libraryId = value;
    index += 1;
  }
  return { libraryId, argv: remaining };
}

/** Shared read-only runtime: never selects or opens a library. */
export function loadSharedEngineRuntime(options: { root: string }): Pick<EngineContext, 'engine' | 'machine'> {
  return {
    engine: loadEngine(join(options.root, 'config', 'engine.yaml')),
    machine: loadMachine(join(options.root, 'config', 'machine.local.yaml')),
  };
}

export function loadEngineContext(options: { root: string; libraryId?: string }): EngineContext {
  const libraryId = asLibraryId(options.libraryId ?? defaultLibraryId);
  const libraryPath = join(options.root, 'config', libraryId);
  if (!existsSync(join(libraryPath, 'library.yaml'))) throw new Error(`UNKNOWN_LIBRARY: ${libraryId}`);

  const { engine, machine } = loadSharedEngineRuntime(options);
  const library = loadLibrary(libraryPath, libraryId);
  if (library.kind === 'research') validateResearchArxivNetwork(library, machine);
  const paths = deriveLibraryPaths(machine, libraryId);
  return { engine, machine, library, paths };
}

/** Read-only discovery: no machine configuration, database or output directory is opened. */
export function listLibraries(root: string): Pick<LibraryConfig, 'libraryId' | 'displayName'>[] {
  const directory = join(root, 'config');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(directory, entry.name, 'library.yaml')))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(entry => {
      const libraryId = asLibraryId(entry.name);
      const library = loadLibrary(join(directory, libraryId), libraryId);
      return { libraryId, displayName: library.displayName };
    });
}
