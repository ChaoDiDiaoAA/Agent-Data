import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadProjectPaths } from '../src/shared/config.ts';
import { loadMinerULocalConfig, toMinerUCliBackend } from '../src/mineru/mineru-local-config.ts';
import * as localConfig from '../src/mineru/mineru-local-config.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';

test('standalone MinerU config requires explicit absolute output and temp roots and has no library identity', () => {
  const { engine, machine } = loadEngineContext({ root: process.cwd() });
  const paths = { tempRoot: 'D:\\flowmate-data\\work', outputRoot: 'D:\\flowmate-data\\datasets' };
  assert.equal(typeof localConfig.toStandaloneMinerULocalConfig, 'function');
  const config = localConfig.toStandaloneMinerULocalConfig({ engine, machine }, paths);
  assert.equal(config.tempRoot, paths.tempRoot);
  assert.equal(config.outputRoot, paths.outputRoot);
  assert.equal('libraryId' in config, false);
  assert.equal('libraryPaths' in config, false);
  assert.equal(config.expectedVersion, '3.4.5');
  for (const field of ['tempRoot', 'outputRoot']) {
    assert.throws(() => localConfig.toStandaloneMinerULocalConfig({ engine, machine }, { ...paths, [field]: 'relative' }), /absolute/);
    assert.throws(() => localConfig.toStandaloneMinerULocalConfig({ engine, machine }, { ...paths, [field]: '' }), /required/);
  }
});

const expectedPipelineRequiredPaths = [
  'models/Layout/PP-DocLayoutV2',
  'models/MFR/unimernet_hf_small_2503',
  'models/MFR/pp_formulanet_plus_m',
  'models/OCR/paddleocr_torch',
  'models/TabRec/SlanetPlus/slanet-plus.onnx',
  'models/TabRec/UnetStructure/unet.onnx',
  'models/TabCls/paddle_table_cls/PP-LCNet_x1_0_table_cls.onnx',
];

const validRaw = {
  source_root: 'D:\\agent-data\\MinerU',
  expected_version: '3.4.5',
  expected_commit: '4fe4bde114a23ee5dd637eae99b767f4669bf58c',
  python_version: '3.12',
  venv_root: 'D:\\agent-data\\MinerU\\.venv',
  model_source_setup: 'modelscope',
  model_source_runtime: 'local',
  modelscope_revision: 'master',
  model_download_type: 'all',
  models_root: 'D:\\agent-data\\MinerU',
  modelscope_cache_root: 'D:\\agent-data\\MinerU\\modelscope',
  mineru_tools_config: 'D:\\agent-data\\config\\mineru.runtime.json',
  pipeline_models_dir: 'D:\\agent-data\\MinerU\\modelscope\\models\\OpenDataLab--PDF-Extract-Kit-1.0',
  vlm_models_dir: 'D:\\agent-data\\MinerU\\modelscope\\models\\OpenDataLab--MinerU2.5-Pro-2605-1.2B',
  pipeline_model_repository: 'OpenDataLab/PDF-Extract-Kit-1.0',
  pipeline_required_paths: expectedPipelineRequiredPaths,
  vlm_model_repository: 'OpenDataLab/MinerU2.5-Pro-2605-1.2B',
  expected_gpu_name: 'RTX 5060 Laptop GPU',
  mineru_install_extras: 'all',
  torch_index_url: 'https://download.pytorch.org/whl/cu128',
  lmdeploy_wheel_url: 'https://example.com/lmdeploy.whl',
  cuda_runtime_dll: 'cudart64_12.dll',
  model: 'pipeline',
  allowed_models: ['pipeline', 'vlm'],
  max_concurrency: 1,
  processing_window_size: 1,
  pipeline_batch_ratio: 1,
  cuda_visible_devices: '0',
  pipeline_device_mode: 'cuda',
  pipeline_method: 'auto',
  pipeline_language: 'ch',
  formula_enabled: true,
  table_enabled: true,
  vlm_device: 'cuda',
  vlm_lmdeploy_backend: 'turbomind',
  vlm_batch_size: 1,
  vlm_cache_max_entry_count: 0.5,
  task_timeout_seconds: 3600,
  result_download_timeout_seconds: 600,
  api_host: '127.0.0.1',
  api_port: 17860,
  api_startup_timeout_seconds: 120,
};

function rawWith(overrides: Record<string, unknown>) {
  return { ...validRaw, ...overrides };
}

test('loads one configured MinerU model and maps it to the CLI backend', () => {
  const config = loadMinerULocalConfig(process.cwd());
  const stateRoot = loadProjectPaths({ root: process.cwd() }).stateRoot;
  assert.equal(config.sourceRoot, 'D:\\agent-data\\tools\\MinerU');
  assert.equal(config.expectedVersion, '3.4.5');
  assert.equal(config.expectedCommit, '4fe4bde114a23ee5dd637eae99b767f4669bf58c');
  assert.equal(config.pythonVersion, '3.12');
  assert.equal(config.venvRoot, 'D:\\agent-data\\tools\\MinerU\\.venv');
  assert.equal(config.modelSourceSetup, 'modelscope');
  assert.equal(config.modelSourceRuntime, 'local');
  assert.equal(config.modelScopeRevision, 'master');
  assert.equal(config.modelDownloadType, 'all');
  assert.equal(config.modelsRoot, 'D:\\agent-data\\tools\\MinerU');
  assert.equal(config.modelScopeCacheRoot, 'D:\\agent-data\\tools\\MinerU\\modelscope');
  assert.equal(config.mineruToolsConfig, 'D:\\agent-data\\config\\mineru.runtime.json');
  assert.equal(config.pipelineModelsDir, 'D:\\agent-data\\tools\\MinerU\\modelscope\\models\\OpenDataLab--PDF-Extract-Kit-1.0');
  assert.equal(config.vlmModelsDir, 'D:\\agent-data\\tools\\MinerU\\modelscope\\models\\OpenDataLab--MinerU2.5-Pro-2605-1.2B');
  assert.equal(config.pipelineModelRepository, 'OpenDataLab/PDF-Extract-Kit-1.0');
  assert.deepEqual(config.pipelineRequiredPaths, expectedPipelineRequiredPaths);
  assert.equal(config.vlmModelRepository, 'OpenDataLab/MinerU2.5-Pro-2605-1.2B');
  assert.equal(config.expectedGpuName, 'RTX 5060 Laptop GPU');
  assert.equal(config.mineruInstallExtras, 'all');
  assert.equal(config.torchIndexUrl, 'https://download.pytorch.org/whl/cu128');
  assert.match(config.lmdeployWheelUrl, /^https:/);
  assert.equal(config.cudaRuntimeDll, 'cudart64_12.dll');
  assert.deepEqual(config.allowedModels, ['pipeline', 'vlm']);
  assert.equal(config.model, 'pipeline');
  assert.equal(config.cliBackend, 'pipeline');
  assert.equal(config.maxConcurrency, 1);
  assert.equal(config.processingWindowSize, 1);
  assert.equal(config.pipelineBatchRatio, 1);
  assert.equal(config.cudaVisibleDevices, '0');
  assert.equal(config.pipelineDeviceMode, 'cuda');
  assert.equal(config.pipelineMethod, 'auto');
  assert.equal(config.pipelineLanguage, 'ch');
  assert.equal(config.formulaEnabled, true);
  assert.equal(config.tableEnabled, true);
  assert.equal(config.vlmDevice, 'cuda');
  assert.equal(config.vlmLmdeployBackend, 'turbomind');
  assert.equal(config.vlmBatchSize, 1);
  assert.equal(config.vlmCacheMaxEntryCount, 0.5);
  assert.equal(config.taskTimeoutMs, 3600000);
  assert.equal(config.resultDownloadTimeoutMs, 600000);
  assert.equal(config.apiHost, '127.0.0.1');
  assert.equal(config.apiPort, 17860);
  assert.equal(config.apiStartupTimeoutMs, 120000);
  assert.equal(config.outputRoot, join(stateRoot, 'archive'));
});


test('rejects malformed source and revision settings', () => {
  const cases: [string, unknown, RegExp][] = [
    ['source_root', 'relative\\MinerU', /source root/],
    ['venv_root', 'E:\\outside-venv', /venv root/],
    ['expected_version', '', /version/],
    ['expected_commit', 'not-a-commit', /commit/],
  ];
  for (const [field, value, error] of cases) {
    assert.throws(() => loadMinerULocalConfig(process.cwd(), { raw: rawWith({ [field]: value }) }), error);
  }
});

test('requires local MinerU model runtime source', () => {
  assert.throws(() => loadMinerULocalConfig(process.cwd(), {
    raw: rawWith({ model_source_runtime: 'modelscope' }),
  }), /model source runtime/);
});

test('rejects model directories outside the configured cache root', () => {
  assert.throws(() => loadMinerULocalConfig(process.cwd(), {
    raw: rawWith({
      pipeline_models_dir: 'D:\\agent-data\\MinerU\\modelscope\\models-evil\\OpenDataLab--PDF-Extract-Kit-1.0',
    }),
  }), /model directory|cache root/);
  assert.throws(() => loadMinerULocalConfig(process.cwd(), {
    raw: rawWith({
      vlm_models_dir: 'D:\\agent-data\\MinerU\\modelscope\\models\\OpenDataLab--MinerU2.5-Pro-2605-1.2B\\..\\other',
    }),
  }), /model directory|cache root/);
});

test('requires safe relative pipeline model paths', () => {
  assert.throws(() => loadMinerULocalConfig(process.cwd(), {
    raw: rawWith({
      pipeline_required_paths: ['..\\outside'],
    }),
  }), /pipeline required path/);
});


test('rejects an unsafe model', () => {
  assert.throws(() => loadMinerULocalConfig(process.cwd(), {
    raw: rawWith({ model: 'hybrid' }),
  }), /model must be pipeline or vlm/);
});

test('rejects unsafe concurrency', () => {
  assert.throws(() => loadMinerULocalConfig(process.cwd(), {
    raw: rawWith({ max_concurrency: 2 }),
  }), /max concurrency/);
});

test('rejects unsupported pipeline batch ratios', () => {
  for (const value of [0, 3, 32, 1.5, '1']) {
    assert.throws(() => loadMinerULocalConfig(process.cwd(), {
      raw: rawWith({ pipeline_batch_ratio: value }),
    }), /pipeline batch ratio/);
  }
});

test('rejects unsupported MinerU API host, port, and startup timeout values', () => {
  for (const value of ['0.0.0.0', 'localhost', '::1']) {
    assert.throws(() => loadMinerULocalConfig(process.cwd(), {
      raw: rawWith({ api_host: value }),
    }), /api host must be 127\.0\.0\.1/);
  }
  for (const value of [1023, 65536, 17860.5, '17860']) {
    assert.throws(() => loadMinerULocalConfig(process.cwd(), {
      raw: rawWith({ api_port: value }),
    }), /api port must be an integer from 1024 through 65535/);
  }
  for (const value of [0, -1, 1.5, '120']) {
    assert.throws(() => loadMinerULocalConfig(process.cwd(), {
      raw: rawWith({ api_startup_timeout_seconds: value }),
    }), /api startup timeout seconds must be a positive integer/);
  }
  for (const value of [0, -1, 1.5, '600']) {
    assert.throws(() => loadMinerULocalConfig(process.cwd(), {
      raw: rawWith({ result_download_timeout_seconds: value }),
    }), /result download timeout seconds must be a positive integer/);
  }
});

test('maps the vlm config value to the official vlm-engine CLI backend', () => {
  assert.equal(toMinerUCliBackend('vlm'), 'vlm-engine');
  assert.equal(toMinerUCliBackend('pipeline'), 'pipeline');
});

test('uses correlated MinerU values from YAML instead of repository constants', () => {
  const root = 'E:\\custom-mineru';
  const cache = `${root}\\modelscope`;
  const configured = loadMinerULocalConfig(process.cwd(), {
    raw: rawWith({
      source_root: root,
      expected_version: '9.8.7',
      expected_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      venv_root: `${root}\\.venv`,
      models_root: root,
      modelscope_cache_root: cache,
      mineru_tools_config: 'E:\\config\\mineru.runtime.json',
      pipeline_models_dir: `${cache}\\models\\Example--Pipeline`,
      vlm_models_dir: `${cache}\\models\\Example--VLM`,
      pipeline_model_repository: 'Example/Pipeline',
      pipeline_required_paths: ['models/layout'],
      vlm_model_repository: 'Example/VLM',
      expected_gpu_name: 'Example GPU',
      torch_index_url: 'https://example.com/torch',
      lmdeploy_wheel_url: 'https://example.com/lmdeploy.whl',
      model: 'vlm',
      cuda_visible_devices: '1',
      processing_window_size: 3,
      pipeline_batch_ratio: 2,
      pipeline_method: 'txt',
      pipeline_language: 'en',
      formula_enabled: false,
      table_enabled: false,
      vlm_batch_size: 2,
      vlm_cache_max_entry_count: 0.4,
      task_timeout_seconds: 42,
      result_download_timeout_seconds: 21,
      api_host: '127.0.0.1',
      api_port: 17860,
      api_startup_timeout_seconds: 120,
    }),
  });

  assert.equal(configured.sourceRoot, root);
  assert.equal(configured.expectedVersion, '9.8.7');
  assert.equal(configured.expectedCommit, 'a'.repeat(40));
  assert.equal(configured.pipelineModelsDir, `${cache}\\models\\Example--Pipeline`);
  assert.equal(configured.vlmModelsDir, `${cache}\\models\\Example--VLM`);
  assert.equal(configured.pipelineModelRepository, 'Example/Pipeline');
  assert.deepEqual(configured.pipelineRequiredPaths, ['models/layout']);
  assert.equal(configured.vlmModelRepository, 'Example/VLM');
  assert.equal(configured.expectedGpuName, 'Example GPU');
  assert.equal(configured.model, 'vlm');
  assert.equal(configured.cliBackend, 'vlm-engine');
  assert.equal(configured.cudaVisibleDevices, '1');
  assert.equal(configured.processingWindowSize, 3);
  assert.equal(configured.pipelineBatchRatio, 2);
  assert.equal(configured.pipelineMethod, 'txt');
  assert.equal(configured.pipelineLanguage, 'en');
  assert.equal(configured.formulaEnabled, false);
  assert.equal(configured.tableEnabled, false);
  assert.equal(configured.vlmBatchSize, 2);
  assert.equal(configured.vlmCacheMaxEntryCount, 0.4);
  assert.equal(configured.taskTimeoutMs, 42000);
  assert.equal(configured.resultDownloadTimeoutMs, 21000);
  assert.equal(configured.outputRoot, join(loadProjectPaths({ root: process.cwd() }).stateRoot, 'extracted'));
});
