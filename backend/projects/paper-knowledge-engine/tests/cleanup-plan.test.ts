import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { applyCleanupPlan, createCleanupPlan, type CleanupPlanInput } from '../src/maintenance/cleanup-plan.ts';
import { routeCleanup } from '../src/cli/routes.ts';
import { libraryCleanupInput } from '../src/library/workflow.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import type { LibraryPaths } from '../src/shared/paths.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';

const NOW = new Date('2026-09-05T12:00:00.000Z');

test('historical cleanup topology resolves the four literal production roots and exact old-data subtargets', async () => {
  const historical = await import('../src/shared/historical-compatibility.ts') as typeof import('../src/shared/historical-compatibility.ts') & {
    resolveHistoricalCleanupTopology?: (roots?: { code: string; data: string; pdf: string; vault: string }) => {
      roots: { code: string; data: string; pdf: string; vault: string };
      oldBunTests: string[];
      oldEvidenceStaging: string;
      emptyValidation: string;
      oldVaultRebuildParent: string;
      oldVaultRebuildPrefix: string;
    };
  };
  assert.equal(typeof historical.resolveHistoricalCleanupTopology, 'function');
  const topology = historical.resolveHistoricalCleanupTopology!();
  assert.deepEqual(topology.roots, {
    code: resolve('D:/agent-data/backend/projects/fsd-code2doc'),
    data: resolve('D:/agent-data/data/fsd-code2doc'),
    pdf: resolve('D:/paper/fsd-code2doc'),
    vault: resolve('D:/obsidian/data/fsd-code2doc'),
  });
  assert.deepEqual(topology.oldBunTests, [
    resolve('D:/agent-data/data/fsd-code2doc/tmp/bun-tests'),
    resolve('D:/agent-data/data/fsd-code2doc/validation/tmp/bun-tests'),
  ]);
  assert.equal(topology.oldEvidenceStaging, resolve('D:/agent-data/data/fsd-code2doc/tmp/evidence-publications'));
  assert.equal(topology.emptyValidation, resolve('D:/agent-data/data/fsd-code2doc/validation'));
  assert.equal(topology.oldVaultRebuildParent, resolve('D:/obsidian/data'));
  assert.equal(topology.oldVaultRebuildPrefix, '.fsd-rebuild-');
});

test('historical cleanup topology supports a synthetic mapping without reusing implementation constants', async () => {
  const historical = await import('../src/shared/historical-compatibility.ts') as typeof import('../src/shared/historical-compatibility.ts') & {
    resolveHistoricalCleanupTopology?: (roots?: { code: string; data: string; pdf: string; vault: string }) => {
      oldBunTests: string[]; oldEvidenceStaging: string; emptyValidation: string;
      oldVaultRebuildParent: string; oldVaultRebuildPrefix: string;
    };
  };
  assert.equal(typeof historical.resolveHistoricalCleanupTopology, 'function');
  const root = resolve('D:/synthetic-history');
  const topology = historical.resolveHistoricalCleanupTopology!({
    code: join(root, 'old-code'), data: join(root, 'old-data'),
    pdf: join(root, 'old-pdf'), vault: join(root, 'old-vault-parent', 'old-vault'),
  });
  assert.deepEqual(topology.oldBunTests, [
    join(root, 'old-data', 'tmp', 'bun-tests'),
    join(root, 'old-data', 'validation', 'tmp', 'bun-tests'),
  ]);
  assert.equal(topology.oldEvidenceStaging, join(root, 'old-data', 'tmp', 'evidence-publications'));
  assert.equal(topology.emptyValidation, join(root, 'old-data', 'validation'));
  assert.equal(topology.oldVaultRebuildParent, join(root, 'old-vault-parent'));
  assert.equal(topology.oldVaultRebuildPrefix, '.fsd-rebuild-');
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cleanup-plan-'));
  const dataRoot = join(root, 'data', 'paper-libraries', 'fsd');
  const workRoot = join(dataRoot, 'work');
  const vaultRoot = join(root, 'vaults', 'fsd');
  const paths: LibraryPaths = {
    dataRoot,
    databasePath: join(dataRoot, 'library.sqlite'),
    archiveRoot: join(dataRoot, 'archive'),
    runsRoot: join(dataRoot, 'runs'),
    operationsRoot: join(dataRoot, 'operations'),
    workRoot,
    backupRoot: join(root, 'backups', 'fsd'),
    vaultRoot,
  };
  const projectRoot = join(root, 'backend', 'projects', 'paper-knowledge-engine');
  const trellisRoot = join(projectRoot, '.trellis');
  const currentVaultRebuildStagingRoot = join(dirname(vaultRoot), '.fsd-rebuild-old');
  const currentEvidencePublicationsRoot = join(workRoot, 'evidence-publications');
  const workTestsRoot = join(workRoot, 'tests');
  const workPublishingRoot = join(workRoot, 'publishing');
  for (const path of [paths.archiveRoot, paths.runsRoot, paths.operationsRoot, workRoot, vaultRoot,
    join(vaultRoot, '.obsidian'), join(dataRoot, 'receipts'), projectRoot,
    currentVaultRebuildStagingRoot, currentEvidencePublicationsRoot, workTestsRoot, workPublishingRoot,
    join(trellisRoot, 'scripts', '__pycache__'), join(trellisRoot, 'tasks', '__pycache__')]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(paths.databasePath, 'sqlite');
  await writeFile(join(paths.archiveRoot, 'manifest.json'), 'archive');
  await writeFile(join(paths.runsRoot, 'run.json'), 'run');
  await writeFile(join(paths.operationsRoot, 'operation.json'), 'operation');
  await writeFile(join(dataRoot, 'receipts', 'receipt.json'), 'receipt');
  await writeFile(join(vaultRoot, '.obsidian', 'app.json'), '{}');
  await writeFile(join(currentVaultRebuildStagingRoot, 'paper.md'), 'staging');
  await writeFile(join(currentEvidencePublicationsRoot, 'paper.md'), 'publication-staging');
  await writeFile(join(workTestsRoot, 'test.txt'), 'work-test');
  await writeFile(join(workPublishingRoot, 'publication.txt'), 'work-publication');
  await writeFile(join(trellisRoot, 'scripts', '__pycache__', 'cache.pyc'), 'cache');
  await writeFile(join(trellisRoot, 'tasks', '__pycache__', 'keep.pyc'), 'keep');
  const input: CleanupPlanInput = {
    libraryPaths: paths,
    projectRoot,
    now: NOW,
  };
  return { root, paths, projectRoot, trellisRoot,
    currentVaultRebuildStagingRoot, currentEvidencePublicationsRoot,
    workTestsRoot, workPublishingRoot, input };
}

test('configured PDF root is protected even when nested in an eligible cleanup directory', async () => {
  const f = await fixture();
  try {
    f.paths.pdfRoot = join(f.workTestsRoot, 'retained-pdfs');
    await mkdir(f.paths.pdfRoot);
    const original = join(f.paths.pdfRoot, 'original.pdf');
    await writeFile(original, 'retained original');
    const plan = await createCleanupPlan(f.input);
    assert.equal(plan.entries.some(entry => entry.path === f.workTestsRoot), false);
    await applyCleanupPlan({ ...f.input, planSha256: plan.planSha256, confirm: true });
    assert.equal(await readFile(original, 'utf8'), 'retained original');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('plans only fixed identities with an exact reason, size, type, and hash', async () => {
  const f = await fixture();
  try {
    const plan = await createCleanupPlan(f.input);
    const expected = [f.workTestsRoot, f.workPublishingRoot, join(f.trellisRoot, 'scripts', '__pycache__')].sort();
    assert.deepEqual(plan.entries.map(entry => entry.path), expected);
    assert.ok(plan.entries.every(entry => entry.reason.length > 0));
    assert.ok(plan.entries.every(entry => entry.type === 'directory'));
    assert.ok(plan.entries.every(entry => Number.isSafeInteger(entry.bytes) && entry.bytes >= 0));
    assert.ok(plan.entries.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256)));
    assert.match(plan.planSha256, /^[0-9a-f]{64}$/);

    const serialized = JSON.stringify(plan);
    for (const protectedPath of [f.paths.archiveRoot, f.paths.databasePath, f.paths.runsRoot,
      f.paths.operationsRoot, join(f.paths.dataRoot, 'receipts'), join(f.paths.vaultRoot, '.obsidian'),
      join(f.trellisRoot, 'tasks')]) {
      assert.equal(serialized.includes(protectedPath), false, protectedPath);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('does not classify current work or current Vault rebuild staging as historical', async () => {
  const f = await fixture();
  try {
    const plan = await createCleanupPlan(f.input);
    assert.equal(plan.entries.some(entry => entry.path === f.currentEvidencePublicationsRoot && entry.reason === 'old Evidence staging'), false);
    assert.equal(plan.entries.some(entry => entry.path === f.currentVaultRebuildStagingRoot && entry.reason === 'old Evidence staging'), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('ordinary workflow cleanup defaults do not opt into historical identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleanup-workflow-default-'));
  try {
    await writeLayeredConfigFixture({ root });
    const input = libraryCleanupInput(root, asLibraryId('fsd'));
    assert.equal(input.historical, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('caller-supplied paths cannot bless arbitrary roots under any legacy candidate class', async () => {
  const f = await fixture();
  try {
    const arbitrary = {
      knownOldRoot: join(f.root, 'critical-records'),
      bunTests: join(f.root, 'arbitrary', 'bun-tests'),
      evidence: join(f.root, 'arbitrary', '.fsd-rebuild-critical'),
      validation: join(f.root, 'arbitrary', 'validation'),
      vault: join(f.root, 'arbitrary-vault'),
    };
    for (const path of Object.values(arbitrary)) {
      await mkdir(path, { recursive: true });
      if (!path.endsWith('validation')) await writeFile(join(path, 'keep.txt'), 'keep');
    }
    const bypass = {
      ...f.input,
      knownOldRoots: [arbitrary.knownOldRoot],
      oldBunTestsRoots: [arbitrary.bunTests],
      oldEvidenceStagingRoots: [arbitrary.evidence],
      emptyValidationRoots: [arbitrary.validation],
      acceptedOldVaultProjection: arbitrary.vault,
    } as unknown as CleanupPlanInput;
    const plan = await createCleanupPlan(bypass);
    assert.equal(plan.entries.some(entry => Object.values(arbitrary).includes(entry.path)), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('fails closed when protected Archive is a physical alias of an otherwise eligible target', async () => {
  const f = await fixture();
  try {
    await rm(f.paths.archiveRoot, { recursive: true });
    try {
      await symlink(f.workTestsRoot, f.paths.archiveRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await assert.rejects(createCleanupPlan(f.input), /protected.*(?:link|reparse)|(?:link|reparse).*protected/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('fails closed when an exact work candidate is a physical alias of Archive', async () => {
  const f = await fixture();
  try {
    await rm(f.workPublishingRoot, { recursive: true });
    try {
      await symlink(f.paths.archiveRoot, f.workPublishingRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await assert.rejects(createCleanupPlan(f.input), /link|reparse/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('apply quarantines exact targets with a hash-bound recovery manifest', async () => {
  const f = await fixture();
  try {
    const input = { ...f.input, operationId: 'successful-transaction' };
    const plan = await createCleanupPlan(input);
    await assert.rejects(applyCleanupPlan({ ...input, planSha256: plan.planSha256, confirm: false as true }), /CONFIRMATION_REQUIRED/);
    await assert.rejects(applyCleanupPlan({ ...input, planSha256: '0'.repeat(64), confirm: true }), /PLAN_CHANGED|CONFLICT/);
    await access(join(f.workTestsRoot, 'test.txt'));

    const result = await applyCleanupPlan({ ...input, planSha256: plan.planSha256, confirm: true });
    assert.equal(result.planSha256, plan.planSha256);
    assert.deepEqual(result.moved.map(entry => entry.path), plan.entries.map(entry => entry.path));
    assert.match(result.recoveryManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal((await readFile(result.recoveryManifestPath, 'utf8')).includes(plan.planSha256), true);
    assert.equal((await readFile(join(result.quarantineRoot, 'commit.json'), 'utf8')).includes(result.recoveryManifestSha256), true);
    for (const entry of result.moved) {
      await assert.rejects(access(entry.path), { code: 'ENOENT' });
      await access(entry.quarantinePath);
    }
    await access(join(f.paths.archiveRoot, 'manifest.json'));
    await access(f.paths.databasePath);
    await access(join(f.paths.runsRoot, 'run.json'));
    await access(join(f.paths.operationsRoot, 'operation.json'));
    await access(join(f.paths.dataRoot, 'receipts', 'receipt.json'));
    await access(join(f.paths.vaultRoot, '.obsidian', 'app.json'));
    await access(join(f.trellisRoot, 'tasks', '__pycache__', 'keep.pyc'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('apply aborts before any recovery move when contents drift or a target becomes a link', async () => {
  for (const mutation of ['contents', 'link'] as const) {
    const f = await fixture();
    try {
      const input = { ...f.input, operationId: `drift-${mutation}` };
      const plan = await createCleanupPlan(input);
      if (mutation === 'contents') await writeFile(join(f.workPublishingRoot, 'unknown.txt'), 'new');
      else {
        await rm(f.workPublishingRoot, { recursive: true });
        try {
          await symlink(f.currentEvidencePublicationsRoot, f.workPublishingRoot, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EPERM') continue;
          throw error;
        }
      }
      await assert.rejects(applyCleanupPlan({ ...input, planSha256: plan.planSha256, confirm: true }), /PLAN_CHANGED|link|reparse/i);
      await access(join(f.workTestsRoot, 'test.txt'));
      await assert.rejects(access(f.paths.backupRoot), { code: 'ENOENT' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('rolls back every prior recovery move when a later move fails', async () => {
  const f = await fixture();
  try {
    const input = { ...f.input, operationId: 'rollback-transaction' };
    const plan = await createCleanupPlan(input);
    let moves = 0;
    await assert.rejects(applyCleanupPlan(
      { ...input, planSha256: plan.planSha256, confirm: true },
      { move: async (source, destination) => {
        moves += 1;
        if (moves === 2) throw new Error('INJECTED_SECOND_MOVE_FAILURE');
        await rename(source, destination);
      } },
    ), /INJECTED_SECOND_MOVE_FAILURE/);
    assert.equal(moves, 2);
    for (const entry of plan.entries) await access(entry.path);
    const rollbackRecord = join(f.paths.backupRoot, 'cleanup-quarantine', input.operationId, 'rollback.json');
    assert.equal((await readFile(rollbackRecord, 'utf8')).includes('INJECTED_SECOND_MOVE_FAILURE'), true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('automatic work candidates containing protected members never enter the plan', async () => {
  const f = await fixture();
  try {
    const candidates = [f.workTestsRoot, f.workPublishingRoot, join(f.paths.workRoot, 'diagnostics', 'old-attempt')];
    for (const candidate of candidates) {
      await mkdir(join(candidate, 'archive'), { recursive: true });
      const protectedMember = join(candidate, 'archive', 'manifest.json');
      await writeFile(protectedMember, 'must stay');
      const timestamp = new Date('2026-07-01T00:00:00.000Z');
      await utimes(protectedMember, timestamp, timestamp);
      await utimes(join(candidate, 'archive'), timestamp, timestamp);
      await utimes(candidate, timestamp, timestamp);
    }
    const plan = await createCleanupPlan(f.input);
    assert.equal(plan.entries.some(entry => candidates.includes(entry.path)), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('CLI cleanup is JSON dry-run by default and apply requires both hash and confirm', async () => {
  const f = await fixture();
  try {
    const dryRun = await routeCleanup(['--format', 'json'], { input: f.input });
    assert.equal(dryRun.mode, 'dry-run');
    await access(join(f.workTestsRoot, 'test.txt'));
    await assert.rejects(routeCleanup(['--apply', '--format', 'json', '--plan-sha256', dryRun.plan.planSha256], { input: f.input }), /CONFIRMATION_REQUIRED/);
    await assert.rejects(routeCleanup(['--apply', '--format', 'json', '--confirm'], { input: f.input }), /plan-sha256/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
