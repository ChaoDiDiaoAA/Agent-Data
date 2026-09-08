import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { loadEngineContext, parseLibrarySelection } from '../src/shared/engine-context.ts';
import { loadConfig } from '../src/shared/config.ts';

test('machine HTTP proxy is optional and reaches shared pipeline configuration', () => {
  const root = makeConfigFixture();
  try {
    const path = join(root, 'config', 'machine.local.yaml');
    const raw = YAML.parse(readFileSync(path, 'utf8'));
    delete raw.network;
    writeFileSync(path, YAML.stringify(raw));
    assert.equal(loadConfig({ root }).network, undefined);
    for (const httpProxy of ['http://127.0.0.1:7897', 'https://proxy.example:8443/']) {
      raw.network = { http_proxy: httpProxy };
      writeFileSync(path, YAML.stringify(raw));
      assert.deepEqual(loadConfig({ root }).network, { httpProxy, openCliProxyMode: 'configured' });
      assert.deepEqual(loadEngineContext({ root }).machine.network, { httpProxy, openCliProxyMode: 'configured' });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('machine config separates OpenCLI arXiv routing from the PDF proxy', () => {
  const root = makeConfigFixture();
  try {
    const path = join(root, 'config', 'machine.local.yaml');
    const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    raw.network = {
      http_proxy: 'http://127.0.0.1:7897',
      opencli_proxy_mode: 'direct',
      arxiv_api_base: 'https://arxiv.org/api/query',
    };
    writeFileSync(path, YAML.stringify(raw));
    assert.deepEqual(loadConfig({ root }).network, {
      httpProxy: 'http://127.0.0.1:7897',
      openCliProxyMode: 'direct',
      arxivApiBase: 'https://arxiv.org/api/query',
    });
    assert.deepEqual(loadEngineContext({ root }).machine.network, loadConfig({ root }).network);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('machine config derives configured or inherited OpenCLI mode when omitted', () => {
  const root = makeConfigFixture();
  try {
    const path = join(root, 'config', 'machine.local.yaml');
    const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    raw.network = { http_proxy: 'http://127.0.0.1:7897' };
    writeFileSync(path, YAML.stringify(raw));
    assert.equal(loadConfig({ root }).network?.openCliProxyMode, 'configured');
    raw.network = {};
    writeFileSync(path, YAML.stringify(raw));
    assert.deepEqual(loadConfig({ root }).network, { openCliProxyMode: 'inherit' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function makeConfigFixture() {
  const root = mkdtempSync(join(tmpdir(), 'paper-engine-config-'));
  mkdirSync(join(root, 'config', 'fsd'), { recursive: true });
  cpSync('config/engine.yaml', join(root, 'config', 'engine.yaml'));
  cpSync('config/machine.local.yaml', join(root, 'config', 'machine.local.yaml'));
  cpSync('config/fsd', join(root, 'config', 'fsd'), { recursive: true });
  const machinePath = join(root, 'config', 'machine.local.yaml');
  const machine = YAML.parse(readFileSync(machinePath, 'utf8'));
  machine.roots = {
    data_libraries_root: join(root, 'data-libraries'),
    backup_libraries_root: join(root, 'backup-libraries'),
    pdf_libraries_root: join(root, 'pdf-libraries'),
    vaults_root: join(root, 'vaults'),
  };
  writeFileSync(machinePath, YAML.stringify(machine));
  return root;
}

test('rejects unsafe or malformed machine proxy URLs without exposing their values', () => {
  for (const value of [null, 7897, '', 'socks5://localhost:7897', 'http://user:secret@localhost:7897',
    'http://@localhost:7897', 'http://localhost:7897/path', 'http://localhost:7897/../',
    'http://localhost:7897?secret', 'http://localhost:7897?', 'http://localhost:7897#fragment',
    'http://localhost:7897#', ' http://localhost:7897', 'http://local\nhost:7897',
    'http://localhost:7897/\u0000', 'http://localhost:99999', 'http:localhost', 'http://localhost\\']) {
    mutateFixture('machine.local.yaml', raw => { raw.network = { http_proxy: value }; },
      /INVALID_FIELD config\/machine\.local\.yaml: network\.http_proxy must be/);
  }
  mutateFixture('machine.local.yaml', raw => { raw.network = { port: 7897 }; }, /UNKNOWN_FIELD.*network\.port/);
});

test('rejects invalid OpenCLI arXiv transport settings without exposing values', () => {
  for (const mode of [null, 1, '', 'bogus', 'DIRECT']) {
    mutateFixture('machine.local.yaml', raw => { raw.network = { opencli_proxy_mode: mode }; },
      /INVALID_FIELD config\/machine\.local\.yaml: network\.opencli_proxy_mode/);
  }
  for (const value of [
    null, 1, '', 'http://arxiv.org/api/query', 'https://example.invalid/api/query',
    'https://user:secret@arxiv.org/api/query', 'https://arxiv.org/api/query?x=1',
    'https://arxiv.org/api/query/', 'https://arxiv.org/other',
  ]) {
    mutateFixture('machine.local.yaml', raw => { raw.network = { arxiv_api_base: value }; },
      /INVALID_FIELD config\/machine\.local\.yaml: network\.arxiv_api_base/);
  }
});

function mutateFixture(
  relativePath: string,
  mutate: (raw: Record<string, unknown>) => void,
  error: RegExp,
) {
  const root = makeConfigFixture();
  try {
    const path = join(root, 'config', relativePath);
    const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    mutate(raw);
    writeFileSync(path, YAML.stringify(raw));
    assert.throws(() => loadEngineContext({ root, libraryId: 'fsd' }), error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('loads fsd through exactly the engine, machine, and library documents', () => {
  const root = makeConfigFixture();
  try {
    const context = loadEngineContext({ root, libraryId: 'fsd' });
    assert.equal(context.engine.engineName, 'paper-knowledge-engine');
    assert.equal(context.engine.arxiv.capacityCooldownMs, 900_000);
    assert.equal(context.engine.runtime.maxOutputBytes, 33_554_432);
    assert.equal(context.engine.server.port, 8787);
    assert.deepEqual(context.engine.evidence, {
      schemaVersion: 3, root: 'Evidence', paperRoot: 'papers',
      indexRoots: {
        authors: 'indexes/authors.md', categories: 'indexes/categories.md',
        tracks: 'indexes/tracks.md', years: 'indexes/years.md',
      },
      publisherVersion: 3,
    });
    assert.equal(context.machine.mineru.sourceRoot, 'D:\\agent-data\\tools\\MinerU');
    assert.equal(context.library.libraryId, 'fsd');
    assert.equal(context.library.displayName, 'FSD 论文知识库');
    assert.equal(context.library.startDate, '2026-01-01');
    assert.deepEqual(context.library.currentTask.trackLimits, {
      'AI-FSD': 1,
      'LLM-Wiki': 1,
      'AI-TDD': 1,
      'AI-DDD': 1,
      'AI-Program-Analysis-AST': 3,
      'Code-Translation': 1,
      Verification: 1,
      Evaluation: 1,
    });
    assert.deepEqual(context.paths, {
      dataRoot: join(root, 'data-libraries', 'fsd'),
      databasePath: join(root, 'data-libraries', 'fsd', 'library.sqlite'),
      archiveRoot: join(root, 'data-libraries', 'fsd', 'archive'),
      runsRoot: join(root, 'data-libraries', 'fsd', 'runs'),
      operationsRoot: join(root, 'data-libraries', 'fsd', 'operations'),
      workRoot: join(root, 'data-libraries', 'fsd', 'work'),
      backupRoot: join(root, 'backup-libraries', 'fsd'),
      pdfRoot: join(root, 'pdf-libraries', 'fsd'),
      vaultRoot: join(root, 'vaults', 'fsd'),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extracts explicit library selection and leaves omission unselected', () => {
  assert.deepEqual(parseLibrarySelection(['--library', 'fsd', 'run-task']), {
    libraryId: 'fsd',
    argv: ['run-task'],
  });
  assert.deepEqual(parseLibrarySelection(['run-task', '--mode', 'current']), {
    libraryId: undefined,
    argv: ['run-task', '--mode', 'current'],
  });
});

test('rejects missing, repeated, and malformed library options with stable errors', () => {
  assert.throws(() => parseLibrarySelection(['--library']), /LIBRARY_ID_REQUIRED/);
  assert.throws(
    () => parseLibrarySelection(['--library', 'fsd', '--library', 'other']),
    /DUPLICATE_LIBRARY/,
  );
  for (const libraryId of ['FSD', '../fsd', 'fsd_2', '-fsd', 'fsd-']) {
    assert.throws(() => parseLibrarySelection(['--library', libraryId]), /INVALID_LIBRARY_ID/);
  }
});

test('rejects an unknown library id with a stable error', () => {
  assert.throws(
    () => loadEngineContext({ root: process.cwd(), libraryId: 'missing' }),
    /UNKNOWN_LIBRARY: missing/,
  );
});

test('rejects unknown fields with file and field context', () => {
  for (const [relativePath, mutate, error] of [
    ['engine.yaml', (raw: Record<string, unknown>) => { raw.unexpected = true; }, /UNKNOWN_FIELD.*engine\.yaml.*unexpected/],
    ['machine.local.yaml', (raw: Record<string, unknown>) => { raw.unexpected = true; }, /UNKNOWN_FIELD.*machine\.local\.yaml.*unexpected/],
    [join('fsd', 'library.yaml'), (raw: Record<string, unknown>) => { raw.unexpected = true; }, /UNKNOWN_FIELD.*library\.yaml.*unexpected/],
    [join('fsd', 'library.yaml'), (raw: Record<string, unknown>) => {
      (raw.current_task as Record<string, unknown>).unexpected = true;
    }, /UNKNOWN_FIELD.*library\.yaml.*current_task\.unexpected/],
  ] as const) {
    const root = makeConfigFixture();
    try {
      const path = join(root, 'config', relativePath);
      const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      mutate(raw);
      writeFileSync(path, YAML.stringify(raw));
      assert.throws(() => loadEngineContext({ root, libraryId: 'fsd' }), error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects invalid engine identity and MinerU runtime semantics', () => {
  for (const [name, mutate, error] of [
    ['engine identity', (raw: Record<string, unknown>) => { raw.engine_name = 'other-engine'; }, /engine_name/],
    ['model', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).model = 'unsafe'; }, /mineru\.model/],
    ['allowed model', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).allowed_models = ['pipeline', 'unsafe']; }, /allowed_models/],
    ['selected model absent', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).allowed_models = ['vlm']; }, /allowed_models/],
    ['max concurrency', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).max_concurrency = Number.MAX_SAFE_INTEGER + 1; }, /max_concurrency/],
    ['processing window', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).processing_window_size = 0; }, /processing_window_size/],
    ['batch ratio', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).pipeline_batch_ratio = 3; }, /pipeline_batch_ratio/],
    ['VLM batch size', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).vlm_batch_size = 0; }, /vlm_batch_size/],
    ['VLM cache ratio low', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).vlm_cache_max_entry_count = 0; }, /vlm_cache_max_entry_count/],
    ['VLM cache ratio high', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).vlm_cache_max_entry_count = 1.1; }, /vlm_cache_max_entry_count/],
    ['API host', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).api_host = 'localhost'; }, /api_host/],
    ['API privileged port', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).api_port = 1023; }, /api_port/],
    ['API port', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).api_port = 65536; }, /api_port/],
    ['API startup timeout', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).api_startup_timeout_seconds = 0; }, /api_startup_timeout_seconds/],
    ['task timeout', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).task_timeout_seconds = 0; }, /task_timeout_seconds/],
    ['result timeout', (raw: Record<string, unknown>) => { (raw.mineru as Record<string, unknown>).result_download_timeout_seconds = 0; }, /result_download_timeout_seconds/],
    ['server port', (raw: Record<string, unknown>) => { (raw.server as Record<string, unknown>).port = 65536; }, /server\.port/],
  ] as const) {
    mutateFixture('engine.yaml', mutate, error);
  }
});

test('preserves the bounded arXiv semantic contract in layered config', () => {
  for (const [field, value] of [
    ['page_size', 101],
    ['request_interval_seconds', 2],
    ['max_attempts', 11],
    ['max_backoff_seconds', 5],
    ['request_timeout_seconds', 9],
    ['retry_jitter_ms', 5001],
    ['capacity_cooldown_seconds', 0],
    ['candidate_pool_multiplier', 0],
    ['max_results_per_shard', 99],
  ] as const) {
    mutateFixture('engine.yaml', (raw) => {
      (raw.arxiv as Record<string, unknown>)[field] = value;
    }, new RegExp(`arxiv\\.${field}`));
  }
});

test('preserves the pinned local MinerU machine contract in layered config', () => {
  for (const [field, value] of [
    ['expected_commit', 'not-a-sha'],
    ['python_version', '3'],
    ['venv_root', 'D:\\outside\\venv'],
    ['model_source_setup', 'other'],
    ['modelscope_cache_root', 'D:\\outside\\cache'],
    ['pipeline_models_dir', 'D:\\outside\\pipeline'],
    ['vlm_models_dir', 'D:\\outside\\vlm'],
    ['torch_index_url', 'http://example.invalid/torch'],
    ['lmdeploy_wheel_url', 'file:///tmp/wheel'],
    ['cuda_runtime_dll', '../cudart64_12.dll'],
    ['pipeline_device_mode', 'cpu'],
    ['vlm_device', 'cpu'],
  ] as const) {
    mutateFixture('machine.local.yaml', (raw) => {
      (raw.mineru as Record<string, unknown>)[field] = value;
    }, new RegExp(`mineru\\.${field}`));
  }
  for (const [field, value] of [
    ['model_source_runtime', 'remote'],
    ['max_concurrency', 2],
    ['pipeline_method', 'invalid'],
    ['vlm_lmdeploy_backend', 'invalid'],
  ] as const) {
    mutateFixture('engine.yaml', (raw) => {
      (raw.mineru as Record<string, unknown>)[field] = value;
    }, new RegExp(`mineru\\.${field}`));
  }
});

test('rejects weekly schedules that violate the legacy semantic contract', () => {
  for (const [name, mutate, error] of [
    ['task name', (schedule: Record<string, unknown>) => { schedule.task_name = 'bad/name'; }, /weekly_schedule\.task_name/],
    ['local time', (schedule: Record<string, unknown>) => { schedule.local_time = '8:30'; }, /weekly_schedule\.local_time/],
    ['timezone', (schedule: Record<string, unknown>) => { schedule.timezone = 'Not/AZone'; }, /weekly_schedule\.timezone/],
    ['interval', (schedule: Record<string, unknown>) => { schedule.interval_weeks = 53; }, /weekly_schedule\.interval_weeks/],
    ['impossible date', (schedule: Record<string, unknown>) => { schedule.start_date = '2026-02-30'; }, /weekly_schedule\.start_date/],
    ['year zero', (schedule: Record<string, unknown>) => { schedule.start_date = '0000-01-03'; }, /weekly_schedule\.start_date/],
    ['weekday mismatch', (schedule: Record<string, unknown>) => { schedule.day_of_week = 'tuesday'; }, /weekly_schedule\.start_date/],
  ] as const) {
    mutateFixture(join('fsd', 'library.yaml'), (raw) => {
      mutate(raw.weekly_schedule as Record<string, unknown>);
    }, error);
  }
});

test('rejects track date modes unless each track has submitted and updated exactly once', () => {
  for (const dateModes of [
    ['submitted'],
    ['submitted', 'submitted'],
    ['submitted', 'updated', 'updated'],
    ['submitted', 'other'],
  ]) {
    mutateFixture(join('fsd', 'query-matrix.yaml'), (raw) => {
      ((raw.tracks as Record<string, unknown>[])[0]).date_modes = dateModes;
    }, /tracks\.0\.date_modes/);
  }
});

test('rejects unsafe MinerU required paths and control characters in machine paths', () => {
  mutateFixture('machine.local.yaml', (raw) => {
    (raw.mineru as Record<string, unknown>).pipeline_required_paths = [];
  }, /pipeline_required_paths/);
  for (const requiredPath of ['../outside', 'models/../outside', '.', 'models//layout', 'D:\\outside', 'C:escape', 'models/lay\u0000out']) {
    mutateFixture('machine.local.yaml', (raw) => {
      (raw.mineru as Record<string, unknown>).pipeline_required_paths = [requiredPath];
    }, /pipeline_required_paths/);
  }
  for (const [field, value] of [
    ['data_libraries_root', 'D:\\agent-data\\bad\nroot'],
    ['source_root', 'D:\\agent-data\\bad\u0000root'],
  ] as const) {
    mutateFixture('machine.local.yaml', (raw) => {
      const target = field === 'data_libraries_root'
        ? raw.roots as Record<string, unknown>
        : raw.mineru as Record<string, unknown>;
      target[field] = value;
    }, new RegExp(field));
  }
});
