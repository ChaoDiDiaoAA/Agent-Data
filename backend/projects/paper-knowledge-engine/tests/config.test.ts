import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { loadArxivConfig, loadConfig, loadEvidencePolicy, loadProjectPaths, loadPaperPolicy } from '../src/shared/config.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import * as sharedContext from '../src/shared/engine-context.ts';
import { loadMinerULocalConfig } from '../src/mineru/mineru-local-config.ts';
import { createProcessContext } from '../src/runtime/process.ts';

test('standalone runtime reads engine and machine without requiring any library', () => {
  const root = mkdtempSync(join(tmpdir(), 'standalone-runtime-'));
  try {
    mkdirSync(join(root, 'config'));
    for (const file of ['engine.yaml', 'machine.local.yaml']) {
      writeFileSync(join(root, 'config', file), readFileSync(join(process.cwd(), 'config', file)));
    }
    assert.equal(typeof sharedContext.loadSharedEngineRuntime, 'function');
    const runtime = sharedContext.loadSharedEngineRuntime({ root });
    assert.deepEqual(Object.keys(runtime).sort(), ['engine', 'machine']);
    assert.deepEqual(runtime.engine, loadEngineContext({ root: process.cwd() }).engine);
    assert.equal(existsSync(join(root, 'config', 'fsd')), false);
    const safetyRoot = join(root, 'flowmate', 'work', 'processes');
    assert.deepEqual(createProcessContext(root, safetyRoot, runtime.engine.runtime), { policy: runtime.engine.runtime, safetyRoot });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared machine runtime does not read engine.yaml', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-runtime-'));
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'machine.local.yaml'), readFileSync(join(process.cwd(), 'config', 'machine.local.yaml')));
    assert.equal(typeof sharedContext.loadSharedMachineRuntime, 'function');
    const runtime = sharedContext.loadSharedMachineRuntime({ root });
    assert.deepEqual(runtime.machine.network, sharedContext.loadSharedEngineRuntime({ root: process.cwd() }).machine.network);
    assert.equal(existsSync(join(root, 'config', 'engine.yaml')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const validArxiv = () => ({
  page_size: 100,
  request_interval_seconds: 6,
  max_attempts: 6,
  max_backoff_seconds: 180,
  request_timeout_seconds: 60,
  retry_jitter_ms: 1000,
  capacity_cooldown_seconds: 900,
  candidate_pool_multiplier: 10,
  max_results_per_shard: 200,
});

function writeConfigRoot(pipeline: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'stage1-config-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'pipeline.yaml'), YAML.stringify(pipeline));
  writeFileSync(join(root, 'config', 'paths.example.yaml'), YAML.stringify({
    pdf_root: 'D:\\paper\\fsd-code2doc',
    vault_root: 'D:\\obsidian\\data\\fsd-code2doc',
    state_root: 'state',
    temp_root: 'state/temp',
    backup_root: 'project-backups',
  }));
  writeFileSync(join(root, 'config', 'evidence-policy.yaml'), YAML.stringify({
    schema_version: 1,
    root: '01-Evidence',
    paper_root: 'sources/papers',
    index_roots: {
      authors: 'indexes/authors',
      categories: 'indexes/categories',
      tracks: 'indexes/tracks',
      years: 'indexes/years',
    },
    publisher_version: 1,
  }));
  return root;
}

test('loads only the fixed Evidence publication roots', () => {
  const root = writeConfigRoot({});
  try {
    assert.deepEqual(loadEvidencePolicy(root), {
      schemaVersion: 1,
      root: '01-Evidence',
      paperRoot: 'sources/papers',
      indexRoots: {
        authors: 'indexes/authors', categories: 'indexes/categories', tracks: 'indexes/tracks', years: 'indexes/years',
      },
      publisherVersion: 1,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [name, value] of [
  ['absolute root', { root: 'D:/evidence' }],
  ['parent traversal', { paper_root: '../papers' }],
  ['legacy notes root', { root: '01-Paper-Notes' }],
  ['legacy semantic root', { root: ['10', 'LLM', 'Wiki'].join('-') }],
  ['unknown field', { unexpected: true }],
  ['model setting', { model: 'anything' }],
  ['budget setting', { budget: 1 }],
  ['retired generation setting', { ['auto' + 'Generate']: false }],
] as const) test(`rejects Evidence policy ${name}`, () => {
  const root = writeConfigRoot({});
  try {
    const path = join(root, 'config', 'evidence-policy.yaml');
    const raw = YAML.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, YAML.stringify({ ...raw, ...value }));
    assert.throws(() => loadEvidencePolicy(root), /evidence policy|Evidence policy|root|unknown|forbidden/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('derives the MinerU Archive root from state_root and rejects a conflicting legacy output_root', () => {
  const root = writeConfigRoot({});
  const raw = YAML.parse(readFileSync(join(process.cwd(), 'tests/fixtures/legacy-config', 'mineru-local.yaml'), 'utf8'));
  try {
    const stateRoot = join(root, 'state');
    const config = loadMinerULocalConfig(root, { raw: { ...raw, source_root: 'D:\\agent-data\\tools\\MinerU', output_root: join(stateRoot, 'extracted') }, stateRoot });
    assert.equal(config.outputRoot, join(stateRoot, 'extracted'));
    assert.throws(() => loadMinerULocalConfig(root, { raw: { ...raw, source_root: 'D:\\agent-data\\tools\\MinerU', output_root: join(root, 'other') }, stateRoot }),
      (error: unknown) => error instanceof Error && error.message === 'MINERU_OUTPUT_ROOT_CONFLICT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('project backup paths come from YAML without requiring task settings or creating directories', () => {
  const root = writeConfigRoot({});
  try {
    assert.equal(loadProjectPaths({ root }).backupRoot, resolve(root, 'project-backups'));
    writeFileSync(join(root, 'config', 'paths.local.yaml'), YAML.stringify({
      pdf_root: 'pdf', vault_root: 'vault', state_root: 'state', temp_root: 'tmp', backup_root: 'custom-backups',
    }));
    assert.equal(loadProjectPaths({ root }).backupRoot, resolve(root, 'custom-backups'));
    assert.equal(existsSync(join(root, 'custom-backups')), false);
    writeFileSync(join(root, 'config', 'paths.local.yaml'), YAML.stringify({
      pdf_root: 'pdf', vault_root: 'vault', state_root: 'state', temp_root: 'tmp',
    }));
    assert.throws(() => loadProjectPaths({ root }), /missing path: backup_root/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loads fixed stage-one paths and normalized production schedule', () => {
  const config = loadConfig({ root: process.cwd(), env: {} });
  const context = loadEngineContext({ root: process.cwd(), libraryId: 'fsd' });
  if (context.library.kind !== 'paper') throw new Error('expected paper library fixture');
  assert.equal(config.startDate, '2026-01-01');
  assert.equal(config.overlapHours, 48);
  assert.deepEqual(config.arxiv, {
    pageSize: 100,
    requestIntervalMs: 10000,
    maxAttempts: 6,
    maxBackoffMs: 180000,
    requestTimeoutMs: 60000,
    retryJitterMs: 1000,
    capacityCooldownMs: 0,
    candidatePoolMultiplier: 25,
    maxResultsPerShard: 200,
  });
  assert.deepEqual(config.currentTask, {
    maxPapers: context.library.currentTask.maxPapers,
    trackLimits: context.library.currentTask.trackLimits,
  });
  assert.deepEqual(config.weeklySchedule, {
    enabled: context.library.weeklySchedule.enabled,
    taskName: context.library.weeklySchedule.taskName,
    dayOfWeek: context.library.weeklySchedule.dayOfWeek,
    intervalWeeks: context.library.weeklySchedule.intervalWeeks,
    startDate: context.library.weeklySchedule.startDate,
    localTime: context.library.weeklySchedule.localTime,
    timezone: context.library.weeklySchedule.timezone,
    maxPapers: context.library.weeklySchedule.maxPapers,
  });
  assert.equal(config.downloadAfterHardFilter, true);
  assert.equal(config.pdfRoot, context.paths.pdfRoot);
  assert.equal(config.vaultRoot, context.paths.vaultRoot);
});

test('task and weekly limits come only from pipeline YAML and weekly may be larger', () => {
  const root = writeConfigRoot({
    start_date: '2026-01-01',
    overlap_hours: 48,
    arxiv: validArxiv(),
    download_after_hard_filter: true,
    current_task: { max_papers: 7, track_limits: { A: 4, B: 3 } },
    weekly_schedule: {
      enabled: true,
      task_name: 'alternate-weekly',
      day_of_week: 'tuesday',
      interval_weeks: 3,
      start_date: '2026-09-01',
      local_time: '08:30',
      timezone: 'Asia/Tokyo',
      max_papers: 8,
    },
  });
  try {
    const config = loadConfig({ root });
    assert.deepEqual(config.currentTask, { maxPapers: 7, trackLimits: { A: 4, B: 3 } });
    assert.deepEqual(config.weeklySchedule, {
      enabled: true,
      taskName: 'alternate-weekly',
      dayOfWeek: 'tuesday',
      intervalWeeks: 3,
      startDate: '2026-09-01',
      localTime: '08:30',
      timezone: 'Asia/Tokyo',
      maxPapers: 8,
    });
    assert.equal('weeklyLimit' in config, false);
    assert.equal('mineruUploadBatchSize' in config, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, mutate, message] of [
  ['track sum', (value) => { value.current_task.track_limits.B = 2; }, /track limits must total 7/],
  ['zero current ceiling', (value) => { value.current_task.max_papers = 0; }, /current task max papers must be a positive integer/],
  ['fractional current ceiling', (value) => { value.current_task.max_papers = 1.5; }, /current task max papers must be a positive integer/],
  ['zero weekly ceiling', (value) => { value.weekly_schedule.max_papers = 0; }, /weekly max papers must be a positive integer/],
  ['fractional weekly ceiling', (value) => { value.weekly_schedule.max_papers = 1.5; }, /weekly max papers must be a positive integer/],
  ['task name', (value) => { value.weekly_schedule.task_name = 'bad/name'; }, /invalid weekly task name/],
  ['day', (value) => { value.weekly_schedule.day_of_week = 'funday'; }, /invalid weekly day of week/],
  ['local time', (value) => { value.weekly_schedule.local_time = '8:30'; }, /local time must be HH:mm/],
  ['timezone', (value) => { value.weekly_schedule.timezone = 'Not/AZone'; }, /invalid weekly timezone/],
  ['zero interval', (value) => { value.weekly_schedule.interval_weeks = 0; }, /weekly interval weeks must be/],
  ['fractional interval', (value) => { value.weekly_schedule.interval_weeks = 1.5; }, /weekly interval weeks must be/],
  ['oversized interval', (value) => { value.weekly_schedule.interval_weeks = 53; }, /weekly interval weeks must be/],
  ['missing interval', (value) => { delete value.weekly_schedule.interval_weeks; }, /weekly interval weeks must be/],
  ['missing anchor', (value) => { delete value.weekly_schedule.start_date; }, /weekly start date must be/],
  ['anchor format', (value) => { value.weekly_schedule.start_date = '2026-8-30'; }, /weekly start date must be/],
  ['impossible anchor', (value) => { value.weekly_schedule.start_date = '2026-02-30'; }, /weekly start date must be/],
  ['invalid leap day', (value) => { value.weekly_schedule.start_date = '2026-02-29'; }, /weekly start date must be/],
  ['year zero', (value) => { value.weekly_schedule.start_date = '0000-01-02'; }, /weekly start date must be/],
  ['anchor weekday', (value) => { value.weekly_schedule.start_date = '2026-08-31'; }, /weekly start date must match day of week/],
  ['request spacing', (value) => { value.arxiv.request_interval_seconds = 2; }, /arxiv request interval must be at least 3 seconds/],
] satisfies [string, (value: MutablePipeline) => void, RegExp][]) {
  test(`rejects invalid ${name}`, () => {
    const value: MutablePipeline = {
      start_date: '2026-01-01',
      overlap_hours: 48,
      arxiv: validArxiv(),
      download_after_hard_filter: true,
      current_task: { max_papers: 7, track_limits: { A: 4, B: 3 } },
      weekly_schedule: {
        enabled: true,
        task_name: 'weekly-test',
        day_of_week: 'sunday',
        interval_weeks: 3,
        start_date: '2026-08-30',
        local_time: '07:45',
        timezone: 'Asia/Tokyo',
        max_papers: 4,
      },
    };
    mutate(value);
    const root = writeConfigRoot(value);
    try {
      assert.throws(() => loadConfig({ root }), message);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [name, mutate, message] of [
  ['missing policy', (value) => { Reflect.deleteProperty(value, 'arxiv'); }, /missing arxiv config/],
  ['page size', (value) => { value.arxiv.page_size = 101; }, /arxiv page size must be 1-100/],
  ['max attempts', (value) => { value.arxiv.max_attempts = 11; }, /arxiv max attempts must be 1-10/],
  ['max backoff', (value) => { value.arxiv.max_backoff_seconds = 5; }, /invalid arxiv max backoff/],
  ['request timeout', (value) => { value.arxiv.request_timeout_seconds = 9; }, /arxiv timeout must be at least 10 seconds/],
  ['retry jitter', (value) => { value.arxiv.retry_jitter_ms = 5001; }, /arxiv retry jitter must be 0-5000ms/],
  ['capacity cooldown', (value) => { value.arxiv.capacity_cooldown_seconds = -1; }, /arxiv capacity cooldown must be non-negative/],
  ['candidate pool multiplier', (value) => { value.arxiv.candidate_pool_multiplier = 0; }, /candidate pool multiplier must be positive/],
  ['max results per shard', (value) => { value.arxiv.max_results_per_shard = 99; }, /max results per shard must cover one page/],
] satisfies [string, (value: {arxiv: Record<string, number>}) => void, RegExp][]) {
  test(`rejects invalid arxiv ${name}`, () => {
    const value = { arxiv: validArxiv() };
    mutate(value);
    assert.throws(() => loadArxivConfig(value), message);
  });
}

test('zero capacity cooldown disables only the optional local delay', () => {
  const result = loadArxivConfig({ arxiv: { ...validArxiv(), capacity_cooldown_seconds: 0 } });
  assert.equal(result.capacityCooldownMs, 0);
  assert.ok(result.requestIntervalMs >= 3000);
});

test('loads explicit equivalent term forms from the paper policy', () => {
  const policy = loadPaperPolicy('config/fsd/paper-policy.yaml');
  assert.deepEqual(policy.termVariants?.llm, ['llms']);
  assert.deepEqual(policy.termVariants?.['large language model'], ['large language models']);
});

test('rejects malformed variants and variants for a term outside the inclusion vocabulary', () => {
  const root = mkdtempSync(join(tmpdir(), 'paper-variants-'));
  const path = join(root, 'policy.yaml');
  try {
    for (const variants of [{ llm: 'llms' }, { unknown: ['anything'] }, { llm: [''] }]) {
      writeFileSync(path, YAML.stringify({ ai_technique_terms: ['llm'], term_variants: variants }));
      assert.throws(() => loadPaperPolicy(path), /term_variants/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('configuration boundaries reject malformed YAML shapes with field context', () => {
  const root = writeConfigRoot({});
  const path = join(root, 'config', 'policy.yaml');
  try {
    writeFileSync(path, 'ai_technique_terms: llm\n');
    assert.throws(() => loadPaperPolicy(path), /ai_technique_terms/);
    writeFileSync(join(root, 'config', 'paths.example.yaml'), '[]');
    assert.throws(() => loadProjectPaths({ root }), /paths.example.yaml/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

interface MutablePipeline { arxiv: Record<string, number>; current_task: { max_papers: number; track_limits: Record<string, number> }; weekly_schedule: Record<string, string | number | boolean>; start_date: string; overlap_hours: number; download_after_hard_filter: boolean; }
