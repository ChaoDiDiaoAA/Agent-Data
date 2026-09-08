import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';

const preloadUrl = new URL('./preload.ts', import.meta.url).href;

interface PreloadResult {
  osTemp: string;
  testRoot: string;
  temp: string;
  tmp: string;
  offline: string;
  created: boolean;
}

async function runPreload(projectRoot: string, osTemp: string, override?: string, offline?: string): Promise<PreloadResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: osTemp, TEMP: osTemp, TMP: osTemp };
  delete env.FSD_TEST_ROOT;
  delete env.FSD_OFFLINE_TESTS;
  if (override !== undefined) env.FSD_TEST_ROOT = override;
  if (offline !== undefined) env.FSD_OFFLINE_TESTS = offline;
  const child = Bun.spawn({
    cmd: [process.execPath, '--eval', `
      import { tmpdir } from 'node:os';
      import { existsSync } from 'node:fs';
      const osTemp = tmpdir();
      await import(${JSON.stringify(preloadUrl)});
      console.log(JSON.stringify({
        osTemp, testRoot: process.env.FSD_TEST_ROOT,
        temp: process.env.TEMP, tmp: process.env.TMP,
        offline: process.env.FSD_OFFLINE_TESTS,
        created: existsSync(process.env.FSD_TEST_ROOT),
      }));
    `],
    cwd: projectRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  assert.equal(exitCode, 0, `preload failed: ${stderr}`);
  return JSON.parse(stdout);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

async function fixture(fn: (root: string, osTemp: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'preload-isolation-'));
  try {
    const osTemp = join(root, 'os-temp');
    await mkdir(osTemp);
    await fn(root, osTemp);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('default preload root uses OS temp, never configured data, backup, work or Vault roots', () => fixture(async (root, osTemp) => {
  const projectRoot = join(root, 'project');
  const configured = await writeLayeredConfigFixture({ root: projectRoot });
  const result = await runPreload(projectRoot, osTemp);

  assert.equal(result.osTemp, osTemp);
  assert.ok(isWithin(osTemp, result.testRoot), `expected OS temp descendant, received ${result.testRoot}`);
  assert.notEqual(result.testRoot, osTemp);
  for (const [name, path] of Object.entries(configured)) {
    assert.equal(isWithin(path, result.testRoot), false, `test root must not be under ${name}`);
    assert.equal(existsSync(path), false, `preload must not create ${name}`);
  }
  assert.equal(result.temp, result.testRoot);
  assert.equal(result.tmp, result.testRoot);
  assert.equal(result.offline, '1');
  assert.equal(result.created, true);
}));

test('default preload works without production configuration or project-path loading', () => fixture(async (root, osTemp) => {
  const projectRoot = join(root, 'no-config-project');
  await mkdir(projectRoot);
  const result = await runPreload(projectRoot, osTemp);
  assert.ok(isWithin(osTemp, result.testRoot));
  assert.equal(existsSync(join(projectRoot, 'config')), false);
}));

test('default preload reuses a stable resolved project namespace and separates same-named worktrees', () => fixture(async (root, osTemp) => {
  const first = join(root, 'worktree-a', 'project');
  const second = join(root, 'worktree-b', 'project');
  await writeLayeredConfigFixture({ root: first });
  await writeLayeredConfigFixture({ root: second });

  const initial = await runPreload(first, osTemp);
  const repeated = await runPreload(join(first, '..', 'project'), osTemp);
  const other = await runPreload(second, osTemp);
  assert.equal(initial.testRoot, repeated.testRoot);
  assert.notEqual(initial.testRoot, other.testRoot);
  assert.ok(isWithin(osTemp, initial.testRoot));
  assert.ok(isWithin(osTemp, other.testRoot));
  assert.ok(relative(osTemp, initial.testRoot).length < 40, 'namespace must leave room for nested Windows fixture paths');
}));

test('explicit FSD_TEST_ROOT remains the root across child runs and preserves offline override', () => fixture(async (root, osTemp) => {
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const override = join(root, 'explicit-tests');
  const initial = await runPreload(projectRoot, osTemp, override, '0');
  assert.equal(initial.testRoot, override);
  assert.equal(initial.temp, override);
  assert.equal(initial.tmp, override);
  assert.equal(initial.offline, '0');
  assert.equal(initial.created, true);

  const inherited = await runPreload(projectRoot, initial.temp, initial.testRoot);
  assert.equal(inherited.testRoot, override, 'inherited test root must not acquire nested suffixes');
}));
