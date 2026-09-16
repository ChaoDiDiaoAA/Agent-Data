import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { canonicalJson } from '../src/shared/manifest.ts';
import { hash, snapshot, vaultFixture } from './helpers/vault-fixture.ts';
import { routeVaultRebuild } from '../src/cli/routes.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { validateVault } from '../src/evidence/vault-validator.ts';
import { bootstrapStageOne } from '../src/library/bootstrap.ts';

async function api() {
  const path = '../src/maintenance/vault-rebuild.ts';
  const mod = await import(path).catch(() => null);
  expect(mod?.createVaultRebuildPlan).toBeFunction();
  expect(mod?.applyVaultRebuild).toBeFunction();
  return mod as typeof import('../src/maintenance/vault-rebuild.ts');
}
async function reviewed(f: Awaited<ReturnType<typeof vaultFixture>>) {
  const { createVaultRebuildPlan } = await api();
  const plan = await createVaultRebuildPlan(f.input);
  await writeFile(f.planFile, canonicalJson(plan));
  return { ...f.input, planFile: f.planFile, planSha256: plan.sha256 };
}

test('review round 2: Archive v2 HTML attribute backticks cannot bypass apply validation', async () => {
  const html = '<a title="`" href="#absent-heading" data-note="`">broken</a>';
  const f = await vaultFixture(1, html);
  try {
    const { createVaultRebuildPlan, applyVaultRebuild } = await api();
    assert.equal(f.sources[0]!.manifest.schemaVersion, 2);
    assert.equal(f.sources[0]!.fullMarkdown, html);
    const before = await snapshot(f.root), old = await snapshot(f.input.legacyVaultRoot);
    const plan = await createVaultRebuildPlan(f.input);
    assert.deepEqual(await snapshot(f.root), before);
    await writeFile(f.planFile, canonicalJson(plan));
    await assert.rejects(applyVaultRebuild({ ...f.input, planFile: f.planFile, planSha256: plan.sha256 }),
      /VAULT_REBUILD_VALIDATION_FAILED(?=.*absent-heading)(?=.*missing Markdown anchor)/s);
    await assert.rejects(stat(f.input.vaultRoot), { code: 'ENOENT' });
    assert.deepEqual(await snapshot(f.input.legacyVaultRoot), old);
    const report = await validateVault({ vaultRoot: plan.stagingRoot, sources: f.sources });
    assert.equal(report.valid, false);
    assert.deepEqual(report.issues, [{ kind: 'broken_link', path: 'Evidence/papers/2601.00001-v1/paper.md',
      target: '#absent-heading', detail: 'Error: missing Markdown anchor' }]);
  } finally { await f.close(); }
});

test('dry-run is deterministic and read-only; rebuild preserves only .obsidian and all verified papers', async () => {
  const f = await vaultFixture(2);
  try {
    const { createVaultRebuildPlan, applyVaultRebuild } = await api();
    const before = await snapshot(f.root);
    const plan = await createVaultRebuildPlan(f.input);
    assert.deepEqual(await createVaultRebuildPlan(f.input), plan);
    const { sha256, ...body } = plan;
    assert.equal(sha256, hash(canonicalJson(body)));
    assert.deepEqual(await snapshot(f.root), before);
    assert.equal(plan.stagingRoot, join(dirname(f.input.vaultRoot), `.fsd-rebuild-${plan.publicationId}`));
    const old = await snapshot(f.input.legacyVaultRoot);
    const input = await reviewed(f);
    const result = await applyVaultRebuild(input);
    assert.equal(result.replayed, false);
    assert.equal(result.validation.paperCount, 2);
    assert.equal(result.validation.brokenLinks, 0);
    assert.equal(result.validation.missingAssets, 0);
    assert.deepEqual((await readdir(f.input.vaultRoot)).sort(), ['.obsidian', 'Evidence']);
    assert.equal(await readFile(join(f.input.vaultRoot, '.obsidian/app.json'), 'utf8'), '{"userSetting":true}');
    assert.deepEqual(await snapshot(f.input.legacyVaultRoot), old);
    const installed = await snapshot(f.input.vaultRoot);
    assert.equal((await applyVaultRebuild(input)).replayed, true);
    assert.deepEqual(await snapshot(f.input.vaultRoot), installed);
    await assert.rejects(stat(plan.stagingRoot), { code: 'ENOENT' });
  } finally { await f.close(); }
});

for (const kind of ['settings', 'new-settings', 'archive', 'new-paper', 'wrong-hash', 'forged-plan', 'noncanonical'] as const) {
  test(`reviewed rebuild fails before writes on drift: ${kind}`, async () => {
    const f = await vaultFixture();
    try {
      const { applyVaultRebuild } = await api();
      const input = await reviewed(f);
      if (kind === 'settings') await appendFile(join(f.input.legacyVaultRoot, '.obsidian/app.json'), ' ');
      if (kind === 'new-settings') await writeFile(join(f.input.legacyVaultRoot, '.obsidian/new.json'), '{}');
      if (kind === 'archive') await appendFile(join(f.sources[0]!.root, 'source.pdf'), 'changed');
      if (kind === 'new-paper') await mkdir(join(f.input.archiveRoot, 'unknown-v1'));
      if (kind === 'wrong-hash') input.planSha256 = '0'.repeat(64);
      if (kind === 'noncanonical') await appendFile(f.planFile, ' ');
      if (kind === 'forged-plan') {
        const { sha256: _, ...body } = JSON.parse(await readFile(f.planFile, 'utf8'));
        body.files.pop(); input.planSha256 = hash(canonicalJson(body));
        await writeFile(f.planFile, canonicalJson({ ...body, sha256: input.planSha256 }));
      }
      const before = await snapshot(f.root);
      await assert.rejects(applyVaultRebuild(input), /VAULT_REBUILD_PLAN_DRIFT/);
      assert.deepEqual(await snapshot(f.root), before);
    } finally { await f.close(); }
  });
}

for (const kind of ['empty', 'manual-file', 'settings', 'asset', 'extra-directory', 'extra-evidence-directory'] as const) {
  test(`existing target mismatch is never overwritten: ${kind}`, async () => {
    const f = await vaultFixture();
    try {
      const { applyVaultRebuild } = await api(); const input = await reviewed(f);
      if (kind === 'empty') await mkdir(f.input.vaultRoot, { recursive: true });
      else {
        await applyVaultRebuild(input);
        if (kind === 'manual-file') await writeFile(join(f.input.vaultRoot, 'my-note.md'), '# Mine');
        if (kind === 'settings') await appendFile(join(f.input.vaultRoot, '.obsidian/app.json'), ' ');
        if (kind === 'asset') await rm(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/assets/figure.png'));
        if (kind === 'extra-directory') await mkdir(join(f.input.vaultRoot, 'extra'));
        if (kind === 'extra-evidence-directory') await mkdir(join(f.input.vaultRoot, 'Evidence/manual'));
      }
      const before = await snapshot(f.input.vaultRoot);
      await assert.rejects(applyVaultRebuild(input), kind === 'asset'
        ? /VAULT_REBUILD_TARGET_CONFLICT.*Evidence\/papers\/2601\.00001-v1\/assets\/figure\.png/s : /VAULT_REBUILD_TARGET_CONFLICT/);
      assert.deepEqual(await snapshot(f.input.vaultRoot), before);
    } finally { await f.close(); }
  });
}

test('zero-paper rebuild validates four indexes without copying root manual content', async () => {
  const f = await vaultFixture(0);
  try {
    const { applyVaultRebuild } = await api();
    const input = await reviewed(f);
    const result = await applyVaultRebuild(input);
    assert.equal(result.validation.valid, true);
    assert.equal(result.validation.paperCount, 0);
    assert.equal(result.validation.indexCount, 4);
    assert.deepEqual((await readdir(join(f.input.vaultRoot, 'Evidence'))).sort(), ['indexes', 'papers']);
    const installed = await snapshot(f.input.vaultRoot);
    await bootstrapStageOne({ vaultRoot: f.input.vaultRoot, pdfRoot: join(f.root, 'pdf') });
    assert.deepEqual(await snapshot(f.input.vaultRoot), installed);
    assert.equal((await applyVaultRebuild(input)).replayed, true);
    assert.deepEqual(await snapshot(f.input.vaultRoot), installed);
  } finally { await f.close(); }
});

for (const kind of ['overlap', 'parent-overlap', 'case-overlap', 'relative', 'traversal', 'reserved', 'junction', 'settings-junction', 'target-junction'] as const) {
  test(`rejects unsafe/disjoint root violations: ${kind}`, async () => {
    const f = await vaultFixture();
    try {
      const { createVaultRebuildPlan } = await api(); const input = { ...f.input };
      if (kind === 'overlap') input.vaultRoot = join(input.archiveRoot, 'target');
      if (kind === 'parent-overlap') input.vaultRoot = f.root;
      if (kind === 'case-overlap') input.vaultRoot = input.legacyVaultRoot.toUpperCase();
      if (kind === 'relative') input.vaultRoot = './fsd';
      if (kind === 'traversal') input.vaultRoot = input.vaultRoot + '/../escape';
      if (kind === 'reserved') input.vaultRoot = join(f.root, 'NUL');
      if (kind === 'junction') { await rename(input.archiveRoot, join(f.root, 'saved')); await symlink(join(f.root, 'saved'), input.archiveRoot, 'junction'); }
      if (kind === 'settings-junction') await symlink(input.archiveRoot, join(input.legacyVaultRoot, '.obsidian/escape'), 'junction');
      if (kind === 'target-junction') { await mkdir(dirname(input.vaultRoot), { recursive: true }); await symlink(input.legacyVaultRoot, input.vaultRoot, 'junction'); }
      await assert.rejects(createVaultRebuildPlan(input), /VAULT_REBUILD_PATH_UNSAFE/);
    } finally { await f.close(); }
  });
}

for (const failure of ['rename', 'damaged-stage', 'source-drift', 'plan-drift'] as const) {
  test(`installation failure never leaves a partial installed target: ${failure}`, async () => {
    const f = await vaultFixture();
    try {
      const { applyVaultRebuild } = await api(); const input = await reviewed(f);
      const old = await snapshot(f.input.legacyVaultRoot);
      await assert.rejects(applyVaultRebuild({ ...input, install: async (stage, target) => {
        if (failure === 'rename') throw new Error('injected rename failure');
        if (failure === 'damaged-stage') await rm(join(stage, 'Evidence/papers/2601.00001-v1/assets/figure.png'));
        await rename(stage, target);
        if (failure === 'source-drift') await appendFile(join(f.sources[0]!.root, 'source.pdf'), 'drift');
        if (failure === 'plan-drift') await appendFile(f.planFile, 'drift');
      } }), /VAULT_REBUILD_/);
      await assert.rejects(stat(f.input.vaultRoot), { code: 'ENOENT' });
      assert.deepEqual(await snapshot(f.input.legacyVaultRoot), old);
    } finally { await f.close(); }
  });
}

test('pure Bun CLI emits canonical dry-run and executes only hash-bound fixture apply/replay', async () => {
  const f = await vaultFixture();
  const run = async (args: string[]) => {
    const script = `import { main } from ${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)};
      try { await main(JSON.parse(process.argv[1]), { vaultRebuild: JSON.parse(process.argv[2]) }); }
      catch (error) { console.error(String(error)); process.exitCode = 1; }`;
    const child = Bun.spawn([process.execPath, '-e', script, JSON.stringify(['--library', 'fsd', 'vault-rebuild', ...args]), JSON.stringify(f.input)], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  try {
    const before = await snapshot(f.root);
    const dryRun = await run(['--dry-run', '--format', 'json']);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.ok(dryRun.stdout.startsWith('{'), 'CLI must route to rebuild, not print generic usage');
    const plan = JSON.parse(dryRun.stdout);
    assert.equal(plan.paperCount, 1); assert.equal(dryRun.stdout, canonicalJson(plan));
    assert.deepEqual(await snapshot(f.root), before);
    await writeFile(f.planFile, dryRun.stdout);
    const args = ['--apply', '--plan-file', f.planFile, '--plan-sha256', plan.sha256];
    const applied = await run(args); assert.equal(applied.code, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).validation.valid, true);
    const replay = await run(args); assert.equal(replay.code, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).replayed, true);
    for (const invalid of [[], ['--dry-run'], ['--apply'], ['--dry-run', '--apply', '--format', 'json'],
      ['--dry-run', '--format', 'json', '--format', 'json'], ['--dry-run', '--format', 'json', '--unknown']]) {
      const rejected = await run(invalid); assert.notEqual(rejected.code, 0); assert.match(rejected.stderr, /VAULT_REBUILD_ARGUMENTS/);
    }
  } finally { await f.close(); }
});

test('pre-existing staging is never overwritten or copied into the target', async () => {
  const f = await vaultFixture();
  try {
    const { applyVaultRebuild, createVaultRebuildPlan } = await api(); const input = await reviewed(f);
    const plan = await createVaultRebuildPlan(f.input);
    await mkdir(plan.stagingRoot, { recursive: true }); await writeFile(join(plan.stagingRoot, 'manual.md'), 'sentinel');
    await assert.rejects(applyVaultRebuild(input), /STAGING_CONFLICT/);
    assert.equal(await readFile(join(plan.stagingRoot, 'manual.md'), 'utf8'), 'sentinel');
    await assert.rejects(stat(f.input.vaultRoot), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('unknown Archive payloads, different library and old Archive schemas fail closed before staging', async () => {
  const f = await vaultFixture();
  try {
    const { createVaultRebuildPlan } = await api();
    const manifestPath = join(f.sources[0]!.root, 'manifest.json');
    const original = await readFile(manifestPath, 'utf8');
    for (const mutation of [{ libraryId: 'other' }, { schemaVersion: 1 }]) {
      await writeFile(manifestPath, canonicalJson({ ...JSON.parse(original), ...mutation }));
      await assert.rejects(createVaultRebuildPlan(f.input), /INVALID_ARCHIVE/);
    }
    await writeFile(manifestPath, original);
    await writeFile(join(f.input.archiveRoot, 'unowned.txt'), 'manual');
    await assert.rejects(createVaultRebuildPlan(f.input), /INVALID_ARCHIVE/);
    await assert.rejects(stat(f.input.vaultRoot), { code: 'ENOENT' });
  } finally { await f.close(); }
});

for (const rootName of ['dataRoot', 'workRoot', 'runsRoot', 'operationsRoot', 'backupRoot'] as const) {
  for (const overlap of ['target-inside', 'target-contains', 'stage-inside', 'stage-contains'] as const) {
    test(`review R1: direct plan rejects ${overlap} ${rootName} without writes`, async () => {
      const f = await vaultFixture();
      try {
        const { createVaultRebuildPlan } = await api();
        const plan = await createVaultRebuildPlan(f.input);
        const input = { ...f.input, runtimeRoots: { ...f.input.runtimeRoots } };
        const target = overlap.startsWith('stage') ? plan.stagingRoot : f.input.vaultRoot;
        input.runtimeRoots[rootName] = overlap.endsWith('inside') ? target : join(target, 'runtime-child');
        const before = await snapshot(f.root);
        await assert.rejects(createVaultRebuildPlan(input), /VAULT_REBUILD_PATH_UNSAFE/);
        assert.deepEqual(await snapshot(f.root), before);
      } finally { await f.close(); }
    });
  }
}

test('reports an actionable error when the legacy Vault source is inside a runtime root', async () => {
  const f = await vaultFixture();
  try {
    const { createVaultRebuildPlan } = await api();
    const input = {
      ...f.input,
      legacyVaultRoot: join(f.input.runtimeRoots.backupRoot, 'legacy-vault'),
    };
    await assert.rejects(createVaultRebuildPlan(input), error => {
      const message = String(error);
      assert.match(message, /legacy Vault source must be outside runtime root backupRoot/);
      assert.doesNotMatch(message, /VAULT_REBUILD_PATH_UNSAFE: Error: VAULT_REBUILD_PATH_UNSAFE/);
      return true;
    });
  } finally { await f.close(); }
});

test('review R1: runtime roots are canonical, required and bound to the reviewed plan hash', async () => {
  const f = await vaultFixture();
  try {
    const { createVaultRebuildPlan, applyVaultRebuild } = await api();
    const plan = await createVaultRebuildPlan(f.input);
    assert.deepEqual(plan.runtimeRoots, f.input.runtimeRoots);
    const spelling = { ...f.input, runtimeRoots: Object.fromEntries(Object.entries(f.input.runtimeRoots).map(([name, path]) => [name, path.replaceAll('\\', '/')])) };
    assert.deepEqual(await createVaultRebuildPlan(spelling as typeof f.input), plan);
    const bound = await reviewed(f), before = await snapshot(f.root);
    const changed = { ...bound, runtimeRoots: { ...bound.runtimeRoots, workRoot: join(f.root, 'different-work') } };
    await assert.rejects(applyVaultRebuild(changed), /PLAN_DRIFT/);
    await assert.rejects(applyVaultRebuild({ ...bound, runtimeRoots: { ...bound.runtimeRoots, workRoot: bound.vaultRoot } }), /PLAN_DRIFT|PATH_UNSAFE/);
    for (const runtimeRoots of [undefined, {}, { ...f.input.runtimeRoots, dataRoot: '../escape' }]) {
      await assert.rejects(createVaultRebuildPlan({ ...f.input, runtimeRoots } as typeof f.input), /PATH_UNSAFE/);
    }
    assert.deepEqual(await snapshot(f.root), before);
  } finally { await f.close(); }
});

// Exercise actual EngineContext -> CLI configuration, rather than only the injected input seam.
async function configuredVaultFixture() {
  const f = await vaultFixture();
  const configRoot = join(f.root, 'engine');
  await mkdir(join(configRoot, 'config/fsd'), { recursive: true });
  for (const path of ['engine.yaml', 'machine.local.yaml', 'fsd']) await cp(join(process.cwd(), 'config', path), join(configRoot, 'config', path), { recursive: true });
  const machineFile = join(configRoot, 'config/machine.local.yaml');
  const machine = YAML.parse(await readFile(machineFile, 'utf8'));
  machine.roots = { data_libraries_root: join(f.root, 'libraries'), backup_libraries_root: join(f.root, 'backup-libraries'), vaults_root: join(f.root, 'vaults') };
  await writeFile(machineFile, YAML.stringify(machine));
  const paths = loadEngineContext({ root: configRoot }).paths;
  await mkdir(paths.dataRoot, { recursive: true });
  await rename(f.input.archiveRoot, paths.archiveRoot);
  return { ...f, configRoot, machine, machineFile, paths };
}

for (const location of ['data', 'work', 'state-runs', 'runtime-operations', 'staging-backup'] as const) {
  test(`review R1: CLI protects selected library ${location} before dry-run/apply writes`, async () => {
    const f = await configuredVaultFixture();
    try {
      const args = ['--dry-run', '--format', 'json', '--source-root', f.input.legacyVaultRoot];
      const safe = await routeVaultRebuild(args, { root: f.configRoot });
      assert.ok('sha256' in safe);
      await writeFile(f.planFile, canonicalJson(safe));
      if (location === 'staging-backup') f.machine.roots.backup_libraries_root = safe.stagingRoot;
      else {
        const root = { data: f.paths.dataRoot, work: f.paths.workRoot, 'state-runs': f.paths.runsRoot, 'runtime-operations': f.paths.operationsRoot }[location];
        f.machine.roots.vaults_root = root;
      }
      await writeFile(f.machineFile, YAML.stringify(f.machine));
      const before = await snapshot(f.root);
      await assert.rejects(routeVaultRebuild(args, { root: f.configRoot }), /VAULT_REBUILD_PATH_UNSAFE/);
      await assert.rejects(routeVaultRebuild(['--apply', '--plan-file', f.planFile, '--plan-sha256', safe.sha256,
        '--source-root', f.input.legacyVaultRoot], { root: f.configRoot }), /PLAN_DRIFT|PATH_UNSAFE/);
      assert.deepEqual(await snapshot(f.root), before);
    } finally { await f.close(); }
  });
}

test('review R1: CLI binds every selected runtime root and accepts the normal nested library layout', async () => {
  const f = await configuredVaultFixture();
  try {
    const plan = await routeVaultRebuild(['--dry-run', '--format', 'json', '--source-root', f.input.legacyVaultRoot], { root: f.configRoot });
    assert.ok('sha256' in plan);
    assert.deepEqual(plan.runtimeRoots, { dataRoot: resolve(f.paths.dataRoot), workRoot: resolve(f.paths.workRoot),
      runsRoot: resolve(f.paths.runsRoot), operationsRoot: resolve(f.paths.operationsRoot), backupRoot: resolve(f.paths.backupRoot), pdfRoot: resolve(f.paths.pdfRoot!) });
    await writeFile(f.planFile, canonicalJson(plan));
    const result = await routeVaultRebuild(['--apply', '--plan-file', f.planFile, '--plan-sha256', plan.sha256,
      '--source-root', f.input.legacyVaultRoot], { root: f.configRoot });
    assert.ok('validation' in result && result.validation.valid);
  } finally { await f.close(); }
});

test('external PDF originals are bound to rebuild plans and protected from target and staging writes', async () => {
  const f = await vaultFixture();
  try {
    const { createVaultRebuildPlan, applyVaultRebuild } = await api();
    const input = { ...f.input, runtimeRoots: { ...f.input.runtimeRoots, pdfRoot: join(f.root, 'pdf-originals') } };
    const before = await snapshot(f.root);
    const plan = await createVaultRebuildPlan(input);
    assert.equal(plan.runtimeRoots.pdfRoot, input.runtimeRoots.pdfRoot);
    for (const target of [input.vaultRoot, plan.stagingRoot]) {
      for (const pdfRoot of [target, join(target, 'originals'), dirname(target)]) {
        await assert.rejects(createVaultRebuildPlan({ ...input, runtimeRoots: { ...input.runtimeRoots, pdfRoot } }), /PATH_UNSAFE/);
      }
    }
    assert.deepEqual(await snapshot(f.root), before);
    await writeFile(f.planFile, canonicalJson(plan));
    await assert.rejects(applyVaultRebuild({ ...input, runtimeRoots: { ...input.runtimeRoots, pdfRoot: join(f.root, 'other-pdfs') },
      planFile: f.planFile, planSha256: plan.sha256 }), /PLAN_DRIFT/);
  } finally { await f.close(); }
});
