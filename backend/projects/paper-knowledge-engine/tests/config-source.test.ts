import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, globSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';
import { routeHarvestPlan } from '../src/cli/routes.ts';
import { loadConfig, loadEvidencePolicy, loadProjectPaths, loadRuntimeConfig } from '../src/shared/config.ts';
import { buildHarvestPlan } from '../src/discovery/harvest-plan.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { captureOperationPolicy } from '../src/library/operations/operation-store.ts';
import { asLibraryId } from '../src/shared/identity.ts';

test('the compatibility loader needs only the three-layer configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'paper-engine-source-'));
  mkdirSync(join(root, 'config', 'libraries'), { recursive: true });
  try {
    await writeLayeredConfigFixture({ root });

    const context = loadEngineContext({ root });
    if (context.library.kind !== 'paper') throw new Error('expected paper library fixture');
    const compatibility = loadConfig({ root });
    assert.equal(context.library.libraryId, 'fsd');
    assert.equal(compatibility.startDate, context.library.startDate);
    assert.equal(compatibility.overlapHours, context.library.overlapHours);
    assert.deepEqual(compatibility.currentTask, context.library.currentTask);
    assert.deepEqual(compatibility.weeklySchedule, context.library.weeklySchedule);
    assert.equal(compatibility.downloadAfterHardFilter, context.library.downloadAfterHardFilter);
    assert.deepEqual(compatibility.arxiv, context.engine.arxiv);
    assert.deepEqual(compatibility.evidencePolicy, context.engine.evidence);
    assert.equal(compatibility.stateRoot, context.paths.dataRoot);
    assert.equal(compatibility.tempRoot, context.paths.workRoot);
    assert.equal(compatibility.backupRoot, context.paths.backupRoot);
    assert.equal(compatibility.vaultRoot, context.paths.vaultRoot);
    assert.equal(compatibility.pdfRoot, context.paths.pdfRoot);
    assert.deepEqual(loadProjectPaths({ root }), {
      stateRoot: context.paths.dataRoot,
      tempRoot: context.paths.workRoot,
      backupRoot: context.paths.backupRoot,
      vaultRoot: context.paths.vaultRoot,
      pdfRoot: context.paths.pdfRoot,
    });
    assert.deepEqual(loadRuntimeConfig(root), context.engine.runtime);
    assert.deepEqual(loadEvidencePolicy(root), context.engine.evidence);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one layered document fails closed and names both missing documents', () => {
  const root = mkdtempSync(join(tmpdir(), 'paper-engine-partial-one-'));
  mkdirSync(join(root, 'config', 'libraries'), { recursive: true });
  try {
    cpSync('config/engine.yaml', join(root, 'config', 'engine.yaml'));
    assert.throws(
      () => loadConfig({ root }),
      (error: unknown) => error instanceof Error
        && error.message.startsWith('INCOMPLETE_LAYERED_CONFIG')
        && error.message.includes(join(root, 'config', 'machine.local.yaml'))
        && error.message.includes(join(root, 'config', 'fsd', 'library.yaml')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two layered documents fail closed and name the missing library document', () => {
  const root = mkdtempSync(join(tmpdir(), 'paper-engine-partial-two-'));
  mkdirSync(join(root, 'config', 'libraries'), { recursive: true });
  try {
    cpSync('config/engine.yaml', join(root, 'config', 'engine.yaml'));
    cpSync('config/machine.local.yaml', join(root, 'config', 'machine.local.yaml'));
    assert.throws(
      () => loadConfig({ root }),
      (error: unknown) => error instanceof Error
        && error.message.startsWith('INCOMPLETE_LAYERED_CONFIG')
        && error.message.includes(join(root, 'config', 'fsd', 'library.yaml')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('operation policy digest refuses an incomplete layered configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'paper-engine-policy-partial-'));
  mkdirSync(join(root, 'config', 'libraries'), { recursive: true });
  try {
    cpSync('config/engine.yaml', join(root, 'config', 'engine.yaml'));
    cpSync('config/machine.local.yaml', join(root, 'config', 'machine.local.yaml'));
    assert.throws(
      () => captureOperationPolicy(root, asLibraryId('fsd')),
      (error: unknown) => error instanceof Error
        && error.message.startsWith('INCOMPLETE_LAYERED_CONFIG')
        && error.message.includes(join(root, 'config', 'fsd', 'library.yaml')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production harvest uses explicit tracks and normalized arxiv policy', () => {
  const tracks = loadEngineContext({ root: process.cwd() }).library.tracks;
  assert.ok(Array.isArray(tracks));

  const retiredKeys = ['technology_groups', 'task_groups', 'category_groups'];
  for (const path of globSync('src/**/*.{js,ts}')) {
    const source = readFileSync(path, 'utf8');
    for (const key of retiredKeys) {
      assert.doesNotMatch(source, new RegExp(`\\b${key}\\b`), `${path} must not reference retired matrix key ${key}`);
    }
  }

  const planner = readFileSync('src/discovery/harvest-plan.ts', 'utf8');
  const cli = readFileSync('src/cli/routes.ts', 'utf8');
  assert.match(planner, /matrix\?\.tracks/);
  assert.match(cli, /config\.arxiv/);
  assert.doesNotMatch(cli, /config\.pageSize|config\.requestIntervalMs/);
});

test('normal production modules never reference retired configuration documents', () => {
  const retired = [
    'mineru-local.yaml',
    'runtime.yaml',
    'server.yaml',
    'pipeline.yaml',
    'paths.local.yaml',
  ];
  for (const path of globSync('src/**/*.ts')) {
    if (path.replaceAll('\\', '/') === 'src/shared/legacy-config.ts') continue;
    const source = readFileSync(path, 'utf8');
    for (const name of retired) {
      assert.doesNotMatch(source, new RegExp(name.replace('.', '\\.')), `${path} must use layered config instead of ${name}`);
    }
  }
});

test('harvest-plan describes the bounded production plan without a state store', () => {
  const config = loadConfig({ root: process.cwd() });
  const matrix = { tracks: loadEngineContext({ root: process.cwd() }).library.tracks };
  const plan = buildHarvestPlan({ matrix, trackLimits: config.currentTask.trackLimits, arxiv: config.arxiv });
  assert.deepEqual(routeHarvestPlan(['--mode', 'current', '--format', 'json'], { root: process.cwd() }), {
    trackCount: 8,
    totalShards: 16,
    submittedShards: 8,
    updatedShards: 8,
    maximumCandidateObservations: plan.maximumCandidateObservations,
    maxPapers: config.currentTask.maxPapers,
  });
});

test('harvest-plan requires JSON output', () => {
  assert.throws(() => routeHarvestPlan(['--mode', 'current']), /harvest-plan requires --format json/);
  assert.throws(() => routeHarvestPlan(['--mode', 'current', '--format', 'text']), /harvest-plan requires --format json/);
});

test('harvest-plan reports the selected mode limit and rejects unknown modes', () => {
  const config = loadConfig({ root: process.cwd() });
  config.currentTask.maxPapers = 7;
  config.weeklySchedule.maxPapers = 19;
  assert.equal(routeHarvestPlan(['--mode', 'current', '--format', 'json'], { config }).maxPapers, 7);
  assert.equal(routeHarvestPlan(['--mode', 'weekly', '--format', 'json'], { config }).maxPapers, 19);
  assert.throws(() => routeHarvestPlan(['--mode', 'invalid', '--format', 'json'], { config }), /mode current\|weekly/);
});
