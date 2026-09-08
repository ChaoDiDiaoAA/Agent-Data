import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, cp, lstat, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { runHarvestShards } from '../src/discovery/opencli-runner.ts';
import { createProcessContext, runManagedProcess } from '../src/runtime/process.ts';
import type { ManagedProcessResult, ManagedProcessSpec } from '../src/runtime/process.ts';
import { assertPlainPath, openCliPaths, resolveOpenCliPackage } from '../src/runtime/opencli.ts';
import { main } from '../src/cli.ts';

async function fixture() {
  const fx = await makeRuntimeFixture();
  const dependency = join(fx.projectRoot, 'node_modules', '@jackwener', 'opencli');
  await mkdir(join(fx.projectRoot, 'node_modules', '@jackwener'), { recursive: true });
  await symlink(await realpath('node_modules/@jackwener/opencli'), dependency, 'junction');
  await symlink(await realpath('node_modules/fast-xml-parser'), join(fx.projectRoot, 'node_modules/fast-xml-parser'), 'junction');
  await mkdir(join(fx.projectRoot, 'opencli', 'arxiv'), { recursive: true });
  await mkdir(join(fx.projectRoot, 'scripts'), { recursive: true });
  for (const name of ['harvest', 'retry']) {
    await cp(join('opencli', 'arxiv', `${name}.ts`), join(fx.projectRoot, 'opencli', 'arxiv', `${name}.ts`));
  }
  await cp('scripts/build-opencli-adapter.ts', join(fx.projectRoot, 'scripts', 'build-opencli-adapter.ts'));
  await writeFile(join(fx.projectRoot, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@jackwener/opencli': '1.8.6' } }));
  await cp('bun.lock', join(fx.projectRoot, 'bun.lock'));
  return { ...fx, input: { projectRoot: fx.projectRoot, tempRoot: fx.paths.tempRoot }, async dispose() {
    const managed = openCliPaths({ projectRoot: fx.projectRoot, tempRoot: fx.paths.tempRoot }).link;
    try { if ((await lstat(managed)).isSymbolicLink()) await unlink(managed); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await unlink(dependency);
    await unlink(join(fx.projectRoot, 'node_modules/fast-xml-parser'));
    await fx.dispose();
  } };
}

// Extract the real-test launch/teardown boundary so its failure paths can be
// exercised with harmless callbacks rather than unknown live child processes.
function realCliBoundary(fx: Awaited<ReturnType<typeof fixture>>) {
  let launchAttempted = false;
  let cleanupConfirmed = false;
  return {
    async run(spec: ManagedProcessSpec, launch: (spec: ManagedProcessSpec) => Promise<ManagedProcessResult>) {
      try {
        assert.ok(process.versions.bun && process.versions.bun === Bun.version);
        assert.equal(spec.executable, process.execPath);
        const pkg = resolveOpenCliPackage(fx.projectRoot);
        assert.equal(pkg.packageRoot, await realpath('node_modules/@jackwener/opencli'));
        assert.equal(spec.args[0], pkg.entrypoint);
        assert.equal(await realpath(spec.args[0]), pkg.entrypoint);
        assert.equal(spec.cwd, fx.projectRoot);
        const testRoot = process.env.FSD_TEST_ROOT;
        assert.ok(testRoot, 'fixture test root must be explicit');
        const actualRoot = await realpath(fx.root);
        const child = relative(await realpath(testRoot), actualRoot);
        assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
        assert.equal(actualRoot, resolve(fx.root));
        for (const path of [fx.projectRoot, fx.paths.stateRoot, fx.paths.tempRoot]) {
          assert.ok(relative(fx.root, path) && !relative(fx.root, path).startsWith('..') && !isAbsolute(relative(fx.root, path)));
          await assertPlainPath(path);
          assert.equal(await realpath(path), resolve(path));
        }
        assert.equal(spec.safetyRoot, join(fx.paths.stateRoot, 'operations', 'locks', 'processes'));
        await assertPlainPath(spec.safetyRoot);
        const home = openCliPaths(fx.input).homeRoot;
        await assertPlainPath(home);
        assert.equal(spec.env.HOME, home);
        assert.equal(spec.env.USERPROFILE, home);
        assert.equal(spec.env.TEMP, fx.paths.tempRoot);
        assert.equal(spec.env.TMP, fx.paths.tempRoot);
        assert.equal(spec.env.CI, '1');
        const api = new URL(spec.env.FSD_ARXIV_API_BASE);
        assert.equal(api.protocol, 'http:');
        assert.equal(api.hostname, '127.0.0.1');
        assert.ok(Number(api.port) > 0 && !api.username && !api.password);
      } catch (cause) { throw new Error('OpenCLI test preflight refused unsafe launch', { cause }); }
      launchAttempted = true;
      cleanupConfirmed = false;
      const result = await launch(spec);
      cleanupConfirmed = result.cleanupConfirmed === true && result.activePids.length === 0;
      return result;
    },
    async dispose(reportRetained: (root: string) => void = root => console.error(`Retained unconfirmed OpenCLI fixture: ${root}`)) {
      if (!launchAttempted || cleanupConfirmed) await fx.dispose();
      else reportRetained(fx.root);
    },
  };
}

async function syntheticSpec(fx: Awaited<ReturnType<typeof fixture>>): Promise<ManagedProcessSpec> {
  const { buildOpenCliAdapter } = await import('../scripts/build-opencli-adapter.ts');
  const { loadOpenCliRuntime } = await import('../src/runtime/opencli.ts');
  await buildOpenCliAdapter(fx.input);
  const runtime = await loadOpenCliRuntime(fx.input);
  return { ...createProcessContext(fx.projectRoot), executable: runtime.executable, cwd: runtime.cwd,
    args: [...runtime.prefixArgs, 'arxiv', 'harvest'], timeoutMs: null,
    env: { ...runtime.env, FSD_ARXIV_API_BASE: 'http://127.0.0.1:1/query' } };
}

for (const failure of ['unconfirmed', 'thrown'] as const) {
  test(`real CLI boundary retains fixture and marker after synthetic ${failure} launch`, async () => {
    const fx = await fixture();
    let disposals = 0;
    const retained: string[] = [];
    const boundary = realCliBoundary({ ...fx, dispose: async () => { disposals++; await fx.dispose(); } });
    const marker = join(fx.paths.stateRoot, 'operations/locks/processes/active.json');
    try {
      const spec = await syntheticSpec(fx);
      const result = boundary.run(spec, async () => {
        await mkdir(spec.safetyRoot, { recursive: true });
        await writeFile(marker, '{synthetic-unconfirmed');
        if (failure === 'thrown') throw new Error('synthetic transport failure');
        return { reason: 'supervisor-error', exitCode: null, stdout: '', stderr: '', cleanupConfirmed: false, pid: null, elapsedMs: 0, activePids: [] };
      });
      if (failure === 'thrown') await assert.rejects(result, /synthetic transport failure/);
      else assert.equal((await result).cleanupConfirmed, false);
      await boundary.dispose(root => retained.push(root));
      assert.equal(disposals, 0);
      assert.equal(await readFile(marker, 'utf8'), '{synthetic-unconfirmed');
      assert.deepEqual(retained, [fx.root]);
    } finally {
      // This callback never starts an OS child. Only this synthetic test may
      // remove its deliberately fabricated marker after proving retention.
      if (await Bun.file(join(fx.projectRoot, 'package.json')).exists()) await fx.dispose();
    }
  });
}

for (const mismatch of ['HOME', 'USERPROFILE', 'entry', 'executable', 'cwd', 'safetyRoot', 'URL'] as const) {
  test(`real CLI preflight rejects ${mismatch} before reaching a launch callback`, async () => {
    const fx = await fixture();
    const boundary = realCliBoundary(fx);
    let launches = 0;
    try {
      const spec = await syntheticSpec(fx);
      if (mismatch === 'HOME' || mismatch === 'USERPROFILE') spec.env[mismatch] = fx.root;
      if (mismatch === 'entry') spec.args[0] = process.execPath;
      if (mismatch === 'executable') spec.executable = spec.args[0];
      if (mismatch === 'cwd') spec.cwd = fx.root;
      if (mismatch === 'safetyRoot') spec.safetyRoot = fx.paths.tempRoot;
      if (mismatch === 'URL') spec.env.FSD_ARXIV_API_BASE = 'https://example.invalid/query';
      await assert.rejects(boundary.run(spec, async () => {
        launches++;
        return { reason: 'exit', exitCode: 0, stdout: '', stderr: '', cleanupConfirmed: true, pid: null, elapsedMs: 0, activePids: [] };
      }), /OpenCLI test preflight/);
      assert.equal(launches, 0);
    } finally { await boundary.dispose(); }
  });
}

test('installer boundary exists; TS-only copy and missing manifest cannot load', async () => {
  const fx = await fixture();
  try {
    const { loadOpenCliRuntime } = await import('../src/runtime/opencli.ts');
    const adapter = openCliPaths(fx.input).adapterRoot;
    await mkdir(adapter, { recursive: true });
    await cp(join(fx.projectRoot, 'opencli/arxiv/harvest.ts'), join(adapter, 'harvest.ts'));
    await assert.rejects(loadOpenCliRuntime(fx.input), /manifest|installation/i);
  } finally { await fx.dispose(); }
});

test('shared temp root keeps verified OpenCLI installations for distinct project roots isolated', async () => {
  const first = await fixture();
  const projectRoot = join(first.root, 'second-project');
  const input = { projectRoot, tempRoot: first.paths.tempRoot };
  const dependency = join(projectRoot, 'node_modules', '@jackwener', 'opencli');
  const parser = join(projectRoot, 'node_modules', 'fast-xml-parser');
  try {
    await mkdir(join(projectRoot, 'node_modules', '@jackwener'), { recursive: true });
    await mkdir(join(projectRoot, 'opencli', 'arxiv'), { recursive: true });
    await mkdir(join(projectRoot, 'scripts'), { recursive: true });
    await cp(join(first.input.projectRoot, 'config'), join(projectRoot, 'config'), { recursive: true });
    await symlink(await realpath('node_modules/@jackwener/opencli'), dependency, 'junction');
    await symlink(await realpath('node_modules/fast-xml-parser'), parser, 'junction');
    for (const name of ['harvest', 'retry']) {
      await cp(join('opencli', 'arxiv', `${name}.ts`), join(projectRoot, 'opencli', 'arxiv', `${name}.ts`));
    }
    await cp('scripts/build-opencli-adapter.ts', join(projectRoot, 'scripts', 'build-opencli-adapter.ts'));
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@jackwener/opencli': '1.8.6' } }));
    await cp('bun.lock', join(projectRoot, 'bun.lock'));

    const firstPaths = openCliPaths(first.input);
    const secondPaths = openCliPaths(input);
    assert.notEqual(firstPaths.homeRoot, secondPaths.homeRoot);

    const { buildOpenCliAdapter } = await import('../scripts/build-opencli-adapter.ts');
    const { loadOpenCliRuntime } = await import('../src/runtime/opencli.ts');
    const firstInstallation = await buildOpenCliAdapter(first.input);
    const secondInstallation = await buildOpenCliAdapter(input);
    const firstRuntime = await loadOpenCliRuntime(first.input);
    const secondRuntime = await loadOpenCliRuntime(input);
    assert.equal(firstInstallation.homeRoot, firstPaths.homeRoot);
    assert.equal(secondInstallation.homeRoot, secondPaths.homeRoot);
    assert.equal(firstRuntime.installation.projectRoot, first.input.projectRoot);
    assert.equal(secondRuntime.installation.projectRoot, input.projectRoot);
  } finally {
    await unlink(openCliPaths(input).link).catch(() => undefined);
    await unlink(dependency).catch(() => undefined);
    await unlink(parser).catch(() => undefined);
    await first.dispose();
  }
});

test('build produces verified JS and isolated Bun runtime; changed inputs or outputs fail closed', async () => {
  const fx = await fixture();
  try {
    const { buildOpenCliAdapter } = await import('../scripts/build-opencli-adapter.ts');
    const { loadOpenCliRuntime } = await import('../src/runtime/opencli.ts');
    const parent = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const installed = await buildOpenCliAdapter(fx.input);
    const runtime = await loadOpenCliRuntime(fx.input);
    assert.equal(runtime.installation.version, '1.8.6');
    assert.equal(runtime.executable, process.execPath);
    assert.deepEqual(runtime.prefixArgs, [installed.entrypoint]);
    assert.equal(runtime.env.HOME, installed.homeRoot);
    assert.equal(runtime.env.USERPROFILE, installed.homeRoot);
    assert.equal(runtime.env.CI, '1');
    assert.deepEqual({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }, parent);
    assert.ok((await readFile(join(installed.adapterRoot, 'harvest.js'), 'utf8')).length > 0);
    for (const path of [join(fx.projectRoot, 'opencli/arxiv/harvest.ts'), join(fx.projectRoot, 'scripts/build-opencli-adapter.ts'), join(fx.projectRoot, 'bun.lock'), join(installed.adapterRoot, 'harvest.js')]) {
      const original = await readFile(path);
      await appendFile(path, '\n// changed\n');
      await assert.rejects(loadOpenCliRuntime(fx.input), /stale|hash/i);
      await writeFile(path, original);
    }
    await writeFile(join(fx.projectRoot, 'package.json'), JSON.stringify({ dependencies: { '@jackwener/opencli': '1.8.7' } }));
    await assert.rejects(loadOpenCliRuntime(fx.input), /1.8.6|version/i);
  } finally { await fx.dispose(); }
});

test('prepare and runtime use share an exclusive lease including the validation-to-start interval', async () => {
  const fx = await fixture();
  try {
    const { buildOpenCliAdapter } = await import('../scripts/build-opencli-adapter.ts');
    const { withOpenCliRuntime, loadOpenCliRuntime } = await import('../src/runtime/opencli.ts');
    await buildOpenCliAdapter(fx.input);
    await withOpenCliRuntime(fx.input, async runtime => {
      const before = await readFile(join(runtime.installation.adapterRoot, 'manifest.json'));
      await assert.rejects(buildOpenCliAdapter(fx.input), /lease|busy/i);
      await assert.rejects(loadOpenCliRuntime(fx.input), /lease|busy/i);
      assert.deepEqual(await readFile(join(runtime.installation.adapterRoot, 'manifest.json')), before);
    });
    const results = await Promise.allSettled([buildOpenCliAdapter(fx.input), buildOpenCliAdapter(fx.input)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    await writeFile(join(openCliPaths(fx.input).homeRoot, '.lease.json'), '{interrupted');
    await assert.rejects(loadOpenCliRuntime(fx.input), /lease|busy/i);
    await assert.rejects(buildOpenCliAdapter(fx.input), /lease|busy/i);
  } finally { await fx.dispose(); }
});

test('runtime reclaims an interrupted lease only after proving its owner is dead and process safety is clear', { timeout: 30000 }, async () => {
  const fx = await fixture();
  try {
    const { buildOpenCliAdapter } = await import('../scripts/build-opencli-adapter.ts');
    const { loadOpenCliRuntime, openCliPaths } = await import('../src/runtime/opencli.ts');
    const installation = await buildOpenCliAdapter(fx.input);
    const paths = openCliPaths(fx.input);
    await writeFile(join(paths.homeRoot, '.lease.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'interrupted',
      projectRoot: fx.projectRoot,
      owner: { pid: 2147483647, startedAt: 'windows:never-alive' },
    }));
    const runtime = await loadOpenCliRuntime(fx.input);
    assert.equal(runtime.installation.entrypoint, installation.entrypoint);
    assert.equal(await Bun.file(join(paths.homeRoot, '.lease.json')).exists(), false);
    await loadOpenCliRuntime(fx.input);
  } finally { await fx.dispose(); }
});

test('a failed rebuild retains the old complete installation and missing output cannot load', async () => {
  const fx = await fixture();
  try {
    const { buildOpenCliAdapter } = await import('../scripts/build-opencli-adapter.ts');
    const { loadOpenCliRuntime } = await import('../src/runtime/opencli.ts');
    const installed = await buildOpenCliAdapter(fx.input);
    const manifest = await readFile(join(installed.adapterRoot, 'manifest.json'));
    const output = await readFile(join(installed.adapterRoot, 'harvest.js'));
    const source = join(fx.projectRoot, 'opencli/arxiv/harvest.ts');
    const original = await readFile(source);
    await writeFile(source, 'export const broken = ;');
    await assert.rejects(buildOpenCliAdapter(fx.input), /build failed/i);
    assert.deepEqual(await readFile(join(installed.adapterRoot, 'manifest.json')), manifest);
    assert.deepEqual(await readFile(join(installed.adapterRoot, 'harvest.js')), output);
    await assert.rejects(loadOpenCliRuntime(fx.input), /stale/i);
    await writeFile(source, original);
    await loadOpenCliRuntime(fx.input);
    await unlink(join(installed.adapterRoot, 'retry.js'));
    await assert.rejects(loadOpenCliRuntime(fx.input), /ENOENT/);
  } finally { await fx.dispose(); }
});

test('missing local dependency never resolves an ancestor; unknown junction is never reused', async () => {
  const fx = await fixture();
  try {
    const { buildOpenCliAdapter } = await import('../scripts/build-opencli-adapter.ts');
    const { resolveOpenCliPackage, loadOpenCliRuntime } = await import('../src/runtime/opencli.ts');
    await buildOpenCliAdapter(fx.input);
    const link = openCliPaths(fx.input).link;
    await unlink(link);
    await symlink(fx.projectRoot, link, 'junction');
    await assert.rejects(loadOpenCliRuntime(fx.input), /link|package/i);
    await assert.rejects(buildOpenCliAdapter(fx.input), /link|package/i);
    await unlink(join(fx.projectRoot, 'node_modules/@jackwener/opencli'));
    assert.throws(() => resolveOpenCliPackage(fx.projectRoot), /dependency|package/i);
    await symlink(await realpath(resolve('node_modules/@jackwener/opencli')), join(fx.projectRoot, 'node_modules/@jackwener/opencli'), 'junction');
  } finally { await fx.dispose(); }
});

const arxiv = { pageSize: 1, requestIntervalMs: 3000, maxAttempts: 2, maxBackoffMs: 3000, requestTimeoutMs: 5000, retryJitterMs: 0, capacityCooldownMs: 900000 };
const shard = { key: 'local', track: 'fixture', dateMode: 'submitted' as const, query: 'all:test', categories: ['cs.SE'], maxResults: 2 };
test('runner prepares a missing OpenCLI installation before the first discovery shard', async () => {
  const fx = await fixture();
  try {
    let launches = 0;
    const results = await runHarvestShards([shard], { from: '2026-01-01', to: '2026-08-31' }, {
      projectRoot: fx.projectRoot,
      tempRoot: fx.paths.tempRoot,
      arxiv,
      managedProcess: async spec => {
        launches++;
        assert.equal(spec.executable, process.execPath);
        assert.equal(spec.args[1], 'arxiv');
        return { reason: 'exit', exitCode: 0, stdout: '[]', stderr: '', cleanupConfirmed: true, pid: null, elapsedMs: 0, activePids: [] };
      },
    });
    assert.equal(launches, 1);
    assert.deepEqual(results, []);
    assert.equal(await Bun.file(join(openCliPaths(fx.input).adapterRoot, 'manifest.json')).exists(), true);
  } finally { await fx.dispose(); }
});
test('harvest temp isolation honors an explicit root without preparing the configured root', async () => {
  const fx = await fixture();
  const tempRoot = join(fx.root, 'isolated-harvest');
  const isolated = openCliPaths({ projectRoot: fx.projectRoot, tempRoot });
  try {
    const options = {
      projectRoot: fx.projectRoot, tempRoot, arxiv,
      managedProcess: async (spec: ManagedProcessSpec): Promise<ManagedProcessResult> => {
        assert.equal(spec.env.TEMP, tempRoot);
        assert.equal(spec.env.TMP, tempRoot);
        assert.ok(spec.env.HOME.startsWith(tempRoot + sep));
        return { reason: 'exit', exitCode: 0, stdout: '[]', stderr: '', cleanupConfirmed: true, pid: null, elapsedMs: 0, activePids: [] };
      },
    };
    assert.deepEqual(await runHarvestShards([shard], { from: '2026-01-01', to: '2026-08-31' }, options), []);
    assert.equal(await Bun.file(join(isolated.adapterRoot, 'manifest.json')).exists(), true);
    await assert.rejects(lstat(join(fx.paths.tempRoot, 'opencli-home')), { code: 'ENOENT' });
  } finally {
    try { if ((await lstat(isolated.link)).isSymbolicLink()) await unlink(isolated.link); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fx.dispose();
  }
});

test('harvest temp isolation requires an explicit root for an injected managed process before preparation', async () => {
  const fx = await fixture();
  try {
    let launched = false;
    await assert.rejects(runHarvestShards([shard], { from: '2026-01-01', to: '2026-08-31' }, {
      projectRoot: fx.projectRoot, arxiv,
      managedProcess: async () => {
        launched = true;
        return { reason: 'exit', exitCode: 0, stdout: '[]', stderr: '', cleanupConfirmed: true, pid: null, elapsedMs: 0, activePids: [] };
      },
    }), /tempRoot.*required.*managedProcess/);
    assert.equal(launched, false);
    await assert.rejects(lstat(join(fx.paths.tempRoot, 'opencli-home')), { code: 'ENOENT' });
  } finally { await fx.dispose(); }
});

test('harvest temp isolation retains configured production fallback for a direct caller', async () => {
  const fx = await fixture();
  const dependency = join(fx.projectRoot, 'node_modules', '@jackwener', 'opencli');
  const dependencyTarget = await realpath(dependency);
  try {
    // Stop at dependency verification, before any subprocess/network access.
    await unlink(dependency);
    await assert.rejects(runHarvestShards([shard], { from: '2026-01-01', to: '2026-08-31' }, {
      projectRoot: fx.projectRoot, arxiv,
    }), /dependency|package/i);
    assert.equal((await lstat(openCliPaths(fx.input).homeRoot)).isDirectory(), true);
  } finally {
    await symlink(dependencyTarget, dependency, 'junction');
    await fx.dispose();
  }
});

test('harvest temp isolation rejects a relative override before installation', async () => {
  const fx = await fixture();
  try {
    const options = {
      projectRoot: fx.projectRoot, tempRoot: 'relative-temp', arxiv,
      managedProcess: async (): Promise<ManagedProcessResult> => ({
        reason: 'exit', exitCode: 0, stdout: '[]', stderr: '', cleanupConfirmed: true, pid: null, elapsedMs: 0, activePids: [],
      }),
    };
    await assert.rejects(runHarvestShards([shard], { from: '2026-01-01', to: '2026-08-31' }, options), /paths must be absolute/);
    await assert.rejects(lstat(join(fx.paths.tempRoot, 'opencli-home')), { code: 'ENOENT' });
  } finally { await fx.dispose(); }
});

test('runner exposes preparation failure without invoking a managed or legacy fallback', async () => {
  const fx = await fixture();
  const dependency = join(fx.projectRoot, 'node_modules', '@jackwener', 'opencli');
  const dependencyTarget = await realpath(dependency);
  try {
    await unlink(dependency);
    let managedLaunches = 0;
    let legacyLaunches = 0;
    await assert.rejects(runHarvestShards([shard], { from: '2026-01-01', to: '2026-08-31' }, {
      projectRoot: fx.projectRoot,
      tempRoot: fx.paths.tempRoot,
      arxiv,
      managedProcess: async () => {
        managedLaunches++;
        throw new Error('managed execution must not start after preparation failure');
      },
      execFile: async () => {
        legacyLaunches++;
        return { stdout: '[]' };
      },
    }), /dependency|package/i);
    assert.equal(managedLaunches, 0);
    assert.equal(legacyLaunches, 0);
  } finally {
    await symlink(dependencyTarget, dependency, 'junction');
    await fx.dispose();
  }
});
test('direct CLI OpenCLI preparation creates the isolated installation', async () => {
  const fx = await fixture();
  try {
    const output: unknown[] = [];
    await main(['--library', 'fsd', 'opencli-prepare'], { root: fx.projectRoot, output: value => output.push(value) });
    assert.equal(output.length, 1);
    assert.equal((output[0] as { version: string }).version, '1.8.6');
    assert.equal(await Bun.file(join(openCliPaths(fx.input).adapterRoot, 'manifest.json')).exists(), true);
  } finally { await fx.dispose(); }
});
test('runner uses the leased Bun entry, configured output budget, cancellation and cleanup gate', async () => {
  const fx = await fixture();
  try {
    const { buildOpenCliAdapter } = await import('../scripts/build-opencli-adapter.ts');
    await buildOpenCliAdapter(fx.input);
    const signal = new AbortController().signal;
    let calls = 0;
    await assert.rejects(runHarvestShards([shard], { from: '2026-01-01', to: '2026-08-31' }, {
      projectRoot: fx.projectRoot, tempRoot: fx.paths.tempRoot, arxiv, signal,
      execFile: async () => { throw new Error('LEGACY_EXECUTION_REFUSED'); },
      managedProcess: async (spec, options) => {
        calls++;
        assert.equal(spec.executable, process.execPath);
        assert.equal(spec.timeoutMs, null);
        assert.equal(spec.env.FSD_PROCESS_MAX_OUTPUT_BYTES, String(spec.policy.maxOutputBytes));
        assert.ok(options); assert.equal(options.signal, signal);
        assert.equal(spec.args[1], 'arxiv');
        assert.equal(spec.args[2], 'harvest');
        await assert.rejects(buildOpenCliAdapter(fx.input), /lease|busy/i);
        return { reason: 'exit', exitCode: 0, stdout: '[]', stderr: '', cleanupConfirmed: false, pid: null, elapsedMs: 0, activePids: [] };
      },
    }), /PROCESS_CLEANUP_UNCONFIRMED/);
    assert.equal(calls, 1);
    const context = createProcessContext(fx.projectRoot);
    await mkdir(context.safetyRoot, { recursive: true });
    await writeFile(join(context.safetyRoot, 'active.json'), '{unconfirmed');
    await assert.rejects(buildOpenCliAdapter(fx.input), /PROCESS_CLEANUP_UNCONFIRMED/);
  } finally { await fx.dispose(); }
});

for (const scenario of ['paging', 'retry', 'capacity', 'budget', 'invalid'] as const) {
  test(`real project OpenCLI discovers generated arxiv harvest: ${scenario}`, async () => {
    const fx = await fixture();
    const boundary = realCliBoundary(fx);
    const requests: URL[] = [];
    let refusedPrepare = false;
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 26000);
    const xml = await readFile(new URL('./fixtures/arxiv-page.xml', import.meta.url), 'utf8');
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(match => match[0]);
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url); requests.push(url);
      if (requests.length === 1) {
        const { buildOpenCliAdapter } = await import('../scripts/build-opencli-adapter.ts');
        await assert.rejects(buildOpenCliAdapter(fx.input), /lease|busy/i);
        refusedPrepare = true;
      }
      if (scenario === 'retry' && requests.length === 1) return new Response('temporarily unavailable', { status: 503 });
      if (scenario === 'capacity') return new Response('Rate exceeded.', { status: 429, headers: { 'Retry-After': '1', Server: 'fixture' } });
      if (scenario === 'invalid') return new Response('<feed><entry></feed>');
      return new Response(`<feed xmlns="http://www.w3.org/2005/Atom">${scenario === 'retry' ? entries.join('') : entries[Number(url.searchParams.get('start'))] ?? ''}</feed>`, { headers: { 'Content-Type': 'application/atom+xml' } });
    } });
    try {
      const { buildOpenCliAdapter } = await import('../scripts/build-opencli-adapter.ts');
      const { withOpenCliRuntime } = await import('../src/runtime/opencli.ts');
      const installation = await buildOpenCliAdapter(fx.input);
      const context = createProcessContext(fx.projectRoot);
      const result = await withOpenCliRuntime(fx.input, runtime => {
        const spec: ManagedProcessSpec = {
        ...context, executable: runtime.executable, cwd: runtime.cwd, timeoutMs: null,
        env: { ...runtime.env, FSD_ARXIV_API_BASE: `http://127.0.0.1:${server.port}/query`, FSD_PROCESS_MAX_OUTPUT_BYTES: String(context.policy.maxOutputBytes) },
        args: [...runtime.prefixArgs, 'arxiv', 'harvest', '--from', '2026-01-01', '--to', '2026-08-31', '--date-mode', scenario === 'budget' ? 'updated' : 'submitted', '--track', 'fixture', '--query', 'all:test', '--categories', 'cs.SE', '--page-size', scenario === 'retry' ? '2' : '1', '--max-results', scenario === 'budget' ? '1' : '2', '--request-interval-ms', '3000', '--max-attempts', '2', '--max-backoff-ms', '3000', '--request-timeout-ms', '5000', '--retry-jitter-ms', '0', '--capacity-cooldown-ms', '900000', '--output', '-', '-f', 'json'],
        };
        return boundary.run(spec, checkedSpec => runManagedProcess(checkedSpec, { signal: controller.signal }));
      });
      assert.equal(result.cleanupConfirmed, true, JSON.stringify(result));
      assert.deepEqual(result.activePids, []);
      assert.equal(refusedPrepare, true);
      if (scenario === 'paging' || scenario === 'retry') {
        assert.equal(result.exitCode, 0, result.stderr);
        const papers = JSON.parse(result.stdout);
        assert.equal(papers.length, 2);
        assert.equal(papers[0].arxivId, '2608.23146v1');
        assert.equal(papers[1].arxivId, '2601.00001v2');
        assert.deepEqual(requests.map(url => url.searchParams.get('start')), scenario === 'retry' ? ['0', '0'] : ['0', '1']);
        assert.doesNotMatch(result.stdout, /__ARXIV_PROGRESS__/);
        if (scenario === 'retry') assert.match(result.stderr, /__ARXIV_PROGRESS__=.*"httpStatus":503/);
      } else if (scenario === 'capacity') {
        assert.notEqual(result.exitCode, 0);
        assert.equal(requests.length, 1);
        assert.match(result.stderr, /__ARXIV_PROGRESS__=.*"type":"discovery-deferred"/);
        assert.match(result.stderr, /"retryNotBefore":"[^"]+"/);
        assert.match(result.stderr, /body=Rate exceeded\./);
        assert.match(result.stderr, /server=fixture/);
      } else {
        assert.notEqual(result.exitCode, 0);
        assert.match(result.stderr + result.stdout, scenario === 'budget' ? /budget exhausted/i : /invalid.*Atom/i);
        assert.equal(requests.length, 1);
      }
      assert.equal(await realpath(join(installation.homeRoot, '.opencli/node_modules/@jackwener/opencli')), await realpath('node_modules/@jackwener/opencli'));
    } finally { clearTimeout(guard); controller.abort(); await server.stop(true); await boundary.dispose(); }
  });
}
