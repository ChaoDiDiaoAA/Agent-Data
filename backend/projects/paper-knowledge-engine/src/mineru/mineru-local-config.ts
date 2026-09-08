import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { normalizeLocalImportConfig } from '../shared/local-import-config.ts';
import { loadProjectPaths } from '../shared/config.ts';
import { loadEngineContext } from '../shared/engine-context.ts';
import { asLibraryId } from '../shared/identity.ts';
import type { EngineContext, MinerUCliConfig, MinerUModel, PipelineBatchRatio } from '../types/config.ts';

const supportedPipelineBatchRatios: readonly PipelineBatchRatio[] = [1, 2, 4, 8, 16];

export function isSupportedPipelineBatchRatio(value: unknown): value is PipelineBatchRatio {
  return typeof value === 'number' && supportedPipelineBatchRatios.includes(value as PipelineBatchRatio);
}

/**
 * MinerU 3.4.5 exposes virtual VRAM as the supported way to control the
 * pipeline batch heuristic. These thresholds produce the requested ratios.
 */
export function pipelineBatchRatioToVirtualVram(value: PipelineBatchRatio) {
  return value === 1 ? 5 : value === 2 ? 6 : value === 4 ? 8 : value === 8 ? 16 : 32;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function absolutePath(value: unknown, name: string) {
  const path = requiredString(value, name);
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  return path;
}

function isInside(root: string, candidate: string) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..\\`) && !pathFromRoot.startsWith('../') && !isAbsolute(pathFromRoot));
}

function repositoryDirectory(repository: unknown) {
  const parts = requiredString(repository, 'model repository').split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) throw new Error(`invalid model repository: ${repository}`);
  return parts.join('--');
}

function httpsUrl(value: unknown, name: string) {
  const text = requiredString(value, name);
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error(`${name} must be a valid URL`); }
  if (parsed.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
  return text;
}

export function toMinerUCliBackend(model: unknown) {
  if (model === 'pipeline') return 'pipeline';
  if (model === 'vlm') return 'vlm-engine';
  throw new Error(`model must be pipeline or vlm: ${model}`);
}

export type MinerULocalConfig = MinerUCliConfig & EngineContext['machine']['mineru'] & {
  model: MinerUModel;
  allowedModels: MinerUModel[];
  modelSourceSetup: string;
  modelDownloadType: string;
  modelScopeRevision: string;
  pipelineModelRepository: string;
  pipelineRequiredPaths: string[];
  vlmModelRepository: string;
  expectedGpuName: string;
  mineruInstallExtras: string;
  torchIndexUrl: string;
  lmdeployWheelUrl: string;
  cudaRuntimeDll: string;
  outputRoot: string;
  libraryPaths?: EngineContext['paths'];
  libraryId?: import('../shared/identity.ts').LibraryId;
  localImport: EngineContext['engine']['mineru']['localImport'];
};

/** Merge the normalized engine and machine layers into the existing CLI contract. */
export function toMinerULocalConfig(context: EngineContext): MinerULocalConfig {
  return {
    ...toStandaloneMinerULocalConfig(context, { tempRoot: context.paths.workRoot, outputRoot: context.paths.archiveRoot }),
    libraryPaths: context.paths,
    libraryId: asLibraryId(context.library.libraryId),
  };
}

/** Callers own both writable roots; no synthetic library or fallback paths. */
export function toStandaloneMinerULocalConfig(
  context: Pick<EngineContext, 'engine' | 'machine'>,
  paths: { tempRoot: string; outputRoot: string },
): MinerULocalConfig {
  const engine = context.engine.mineru;
  const machine = context.machine.mineru;
  return {
    ...machine,
    ...engine,
    apiHost: '127.0.0.1',
    cliBackend: toMinerUCliBackend(engine.model),
    tempRoot: absolutePath(paths.tempRoot, 'temp root'),
    outputRoot: absolutePath(paths.outputRoot, 'output root'),
    enforceSourcePin: true,
    enforceRuntimePolicy: true,
    allowDirtySource: false,
  };
}

export function loadMinerULocalConfig(root: string, options: { raw?: unknown; stateRoot?: string; libraryId?: string } = {}) {
  if (options.raw === undefined) {
    const result = toMinerULocalConfig(loadEngineContext({ root, libraryId: options.libraryId }));
    if (!existsSync(result.sourceRoot)) throw new Error('local MinerU source checkout is missing');
    return result;
  }
  const input: unknown = options.raw;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MinerU config must be an object');
  const raw = input as Record<string, unknown>;
  const sourceRoot = absolutePath(raw.source_root, 'source root');
  const venvRoot = absolutePath(raw.venv_root, 'venv root');
  if (!isInside(sourceRoot, venvRoot) || sourceRoot === venvRoot) throw new Error('venv root must be inside source root');
  const expectedVersion = requiredString(raw.expected_version, 'expected version');
  const expectedCommit = requiredString(raw.expected_commit, 'expected commit').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error('expected commit must be a 40-character Git SHA');
  const pythonVersion = requiredString(raw.python_version, 'Python version');
  if (!/^\d+\.\d+$/.test(pythonVersion)) throw new Error('Python version must be major.minor');
  if (raw.model_source_setup !== 'modelscope') throw new Error('model source setup must be modelscope');
  if (raw.model_source_runtime !== 'local') throw new Error('model source runtime must be local');

  const allowedModels = raw.allowed_models;
  if (JSON.stringify(allowedModels) !== JSON.stringify(['pipeline', 'vlm'])) {
    throw new Error('allowed models must be pipeline and vlm');
  }
  if (raw.model !== 'pipeline' && raw.model !== 'vlm') throw new Error('model must be pipeline or vlm');
  if (raw.max_concurrency !== 1) throw new Error('max concurrency must be 1');
  if (typeof raw.processing_window_size !== 'number' || !Number.isInteger(raw.processing_window_size) || raw.processing_window_size < 1) throw new Error('processing window size must be a positive integer');
  if (!isSupportedPipelineBatchRatio(raw.pipeline_batch_ratio)) throw new Error('pipeline batch ratio must be one of 1, 2, 4, 8, or 16');
  const modelsRoot = absolutePath(raw.models_root, 'models root');
  const modelScopeCacheRoot = absolutePath(raw.modelscope_cache_root, 'ModelScope cache root');
  if (!isInside(modelsRoot, modelScopeCacheRoot) || modelsRoot === modelScopeCacheRoot) throw new Error('ModelScope cache root must be inside models root');
  const mineruToolsConfig = absolutePath(raw.mineru_tools_config, 'MinerU tools config');
  const pipelineModelRepository = requiredString(raw.pipeline_model_repository, 'pipeline model repository');
  const vlmModelRepository = requiredString(raw.vlm_model_repository, 'VLM model repository');
  const pipelineModelsDir = absolutePath(raw.pipeline_models_dir, 'pipeline model directory');
  const vlmModelsDir = absolutePath(raw.vlm_models_dir, 'VLM model directory');
  const modelCacheDirectory = join(modelScopeCacheRoot, 'models');
  if (!isInside(modelCacheDirectory, pipelineModelsDir) || !isInside(modelCacheDirectory, vlmModelsDir)) {
    throw new Error('model directory must be inside configured ModelScope cache root');
  }
  if (relative(join(modelCacheDirectory, repositoryDirectory(pipelineModelRepository)), pipelineModelsDir) !== '') {
    throw new Error('pipeline model directory must match configured repository');
  }
  if (relative(join(modelCacheDirectory, repositoryDirectory(vlmModelRepository)), vlmModelsDir) !== '') {
    throw new Error('VLM model directory must match configured repository');
  }
  const pipelineRequiredPaths = raw.pipeline_required_paths;
  if (!Array.isArray(pipelineRequiredPaths) || pipelineRequiredPaths.length < 1
    || pipelineRequiredPaths.some((path) => typeof path !== 'string' || !path.trim() || isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\'))) {
    throw new Error('pipeline required path must be a safe relative path');
  }
  const cudaVisibleDevices = requiredString(raw.cuda_visible_devices, 'CUDA visible devices');
  if (raw.pipeline_device_mode !== 'cuda') throw new Error('pipeline device mode must be cuda');
  if (raw.pipeline_method !== 'auto' && raw.pipeline_method !== 'txt' && raw.pipeline_method !== 'ocr') throw new Error('pipeline method must be auto, txt, or ocr');
  const pipelineLanguage = requiredString(raw.pipeline_language, 'pipeline language');
  if (typeof raw.formula_enabled !== 'boolean' || typeof raw.table_enabled !== 'boolean') throw new Error('formula and table flags must be boolean');
  if (raw.vlm_device !== 'cuda' || raw.vlm_lmdeploy_backend !== 'turbomind') throw new Error('VLM must use CUDA Turbomind');
  if (typeof raw.vlm_batch_size !== 'number' || !Number.isInteger(raw.vlm_batch_size) || raw.vlm_batch_size < 1) throw new Error('VLM batch size must be a positive integer');
  if (typeof raw.vlm_cache_max_entry_count !== 'number' || !Number.isFinite(raw.vlm_cache_max_entry_count) || raw.vlm_cache_max_entry_count <= 0 || raw.vlm_cache_max_entry_count > 1) throw new Error('VLM cache max entry count must be within (0, 1]');
  if (typeof raw.task_timeout_seconds !== 'number' || !Number.isInteger(raw.task_timeout_seconds) || raw.task_timeout_seconds < 1) throw new Error('task timeout seconds must be a positive integer');
  if (typeof raw.result_download_timeout_seconds !== 'number' || !Number.isInteger(raw.result_download_timeout_seconds) || raw.result_download_timeout_seconds < 1) throw new Error('result download timeout seconds must be a positive integer');
  const stateRoot = options.stateRoot ?? loadProjectPaths({ root }).stateRoot;
  const outputRoot = resolve(stateRoot, 'extracted');
  if (raw.output_root !== undefined && resolve(absolutePath(raw.output_root, 'output root')) !== outputRoot) {
    throw new Error('MINERU_OUTPUT_ROOT_CONFLICT');
  }
  const modelScopeRevision = requiredString(raw.modelscope_revision, 'ModelScope revision');
  const modelDownloadType = requiredString(raw.model_download_type, 'model download type');
  const expectedGpuName = requiredString(raw.expected_gpu_name, 'expected GPU name');
  const mineruInstallExtras = requiredString(raw.mineru_install_extras, 'MinerU install extras');
  const torchIndexUrl = httpsUrl(raw.torch_index_url, 'Torch index URL');
  const lmdeployWheelUrl = httpsUrl(raw.lmdeploy_wheel_url, 'LMDeploy wheel URL');
  const cudaRuntimeDll = requiredString(raw.cuda_runtime_dll, 'CUDA runtime DLL');
  if (raw.api_host !== '127.0.0.1') throw new Error('api host must be 127.0.0.1');
  if (typeof raw.api_port !== 'number' || !Number.isInteger(raw.api_port) || raw.api_port < 1024 || raw.api_port > 65535) {
    throw new Error('api port must be an integer from 1024 through 65535');
  }
  if (typeof raw.api_startup_timeout_seconds !== 'number' || !Number.isInteger(raw.api_startup_timeout_seconds) || raw.api_startup_timeout_seconds < 1) {
    throw new Error('api startup timeout seconds must be a positive integer');
  }
  return {
    sourceRoot,
    expectedVersion,
    expectedCommit,
    pythonVersion,
    venvRoot,
    modelSourceSetup: raw.model_source_setup,
    modelSourceRuntime: raw.model_source_runtime,
    modelScopeRevision,
    modelDownloadType,
    modelsRoot,
    modelScopeCacheRoot,
    mineruToolsConfig,
    pipelineModelsDir,
    vlmModelsDir,
    pipelineModelRepository,
    pipelineRequiredPaths: pipelineRequiredPaths.map((path: unknown) => {
      if (typeof path !== 'string') throw new Error('pipeline required path must be text');
      return path;
    }),
    vlmModelRepository,
    expectedGpuName,
    mineruInstallExtras,
    torchIndexUrl,
    lmdeployWheelUrl,
    cudaRuntimeDll,
    model: raw.model,
    allowedModels: ['pipeline', 'vlm'],
    cliBackend: toMinerUCliBackend(raw.model),
    maxConcurrency: raw.max_concurrency,
    processingWindowSize: raw.processing_window_size,
    pipelineBatchRatio: raw.pipeline_batch_ratio,
    cudaVisibleDevices,
    pipelineDeviceMode: raw.pipeline_device_mode,
    pipelineMethod: raw.pipeline_method,
    pipelineLanguage,
    formulaEnabled: raw.formula_enabled,
    tableEnabled: raw.table_enabled,
    vlmDevice: raw.vlm_device,
    vlmLmdeployBackend: raw.vlm_lmdeploy_backend,
    vlmBatchSize: raw.vlm_batch_size,
    vlmCacheMaxEntryCount: raw.vlm_cache_max_entry_count,
    taskTimeoutMs: raw.task_timeout_seconds * 1000,
    resultDownloadTimeoutMs: raw.result_download_timeout_seconds * 1000,
    apiHost: '127.0.0.1' as const,
    apiPort: raw.api_port,
    apiStartupTimeoutMs: raw.api_startup_timeout_seconds * 1000,
    enforceSourcePin: true,
    enforceRuntimePolicy: true,
    allowDirtySource: false,
    tempRoot: resolve(stateRoot, 'work'),
    outputRoot,
    localImport: raw.local_import ? normalizeLocalImportConfig(raw.local_import) : null,
  };
}
