import test from 'node:test';
import assert from 'node:assert/strict';
import { routeBootstrap, runConfiguredTask } from '../src/cli/routes.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { configureLayeredRuntimeFixture } from './fixtures/layered-config.ts';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('bootstrap route passes normalized config and category mapping', async () => {
  const calls: { config: unknown; categories: NonNullable<Parameters<typeof routeBootstrap>[1]>['categories'] }[] = [];
  const result = await routeBootstrap([], {
    root: 'D:/builder',
    config: { root: 'D:/builder', pdfRoot: 'D:/paper', vaultRoot: 'D:/vault', currentTask: { trackLimits: { A: 1 } } },
    plan: { tracks: ['A'] },
    rules: { trackPriority: ['A'] },
    categories: { tracks: { A: { pdf: '01-A' } }, fallback_pdf: '99-Unclassified' },
    bootstrap: async (config, categories) => { calls.push({ config, categories }); return { pdfDirectories: 2 }; },
  });
  assert.ok(result);
  assert.equal(result.pdfDirectories, 2);
  assert.equal(calls[0].categories!.tracks.A.pdf, '01-A');
});

for (const fails of [false, true]) test(`configured route owns the store until asynchronous completion (fails=${fails})`, async () => {
  const fixture = await makeRuntimeFixture();
  await configureLayeredRuntimeFixture(fixture);
  const store = openStateStore(':memory:');
  try {
    const operation = runConfiguredTask(['--mode', 'current'], fixture.projectRoot, {
      openStateStore: () => store,
      executeTask: async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(store.getLastSuccess(), null);
        if (fails) throw new Error('asynchronous task failed');
        return { status: 'disabled', mode: 'current', selected: [] };
      },
    });
    if (fails) await assert.rejects(operation, /asynchronous task failed/);
    else assert.equal((await operation).status, 'disabled');
    assert.throws(() => store.getLastSuccess(), /closed|finalized/);
  } finally { store.close(); await fixture.dispose(); }
});

test('direct TypeScript CLI preserves help, JSON descriptors and failure stderr/exit status', async () => {
  const fixture = await makeRuntimeFixture();
  const cliPath = resolve('src/cli.ts');
  const invoke = (args: string[]) => spawnSync(process.execPath, [cliPath, ...args], {
    cwd: fixture.projectRoot, encoding: 'utf8', timeout: 10000,
  });
  try {
    const help = invoke(['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /run-task --mode current/);
    assert.match(help.stdout, /论文知识引擎（Bun CLI）/);
    assert.match(help.stdout, /bun src\/cli\.ts \[--library LIBRARY_ID\]/);
    assert.match(help.stdout, /不默认选择方向库/);
    assert.equal(help.stderr, '');
    for (const args of [['harvest-plan', '--mode', 'current'], ['schedule-config'], ['mineru-config']]) {
      const result = invoke(['--library', 'fsd', ...args, '--format', 'json']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const descriptor: unknown = JSON.parse(result.stdout);
      assert.ok(descriptor && typeof descriptor === 'object');
      assert.ok(Object.keys(descriptor).length > 0);
    }
    const failure = invoke(['--library', 'fsd', 'unknown-fixture-command']);
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /Unknown command: unknown-fixture-command/);
  } finally { await fixture.dispose(); }
});

test('bootstrap route validates track reachability before bootstrap side effects', async () => {
  const calls: string[] = [];
  await assert.rejects(() => routeBootstrap([], {
    root: 'D:/builder',
    config: { root: 'D:/builder', pdfRoot: 'D:/paper', vaultRoot: 'D:/vault', currentTask: { trackLimits: { A: 1, B: 1 } } },
    plan: { tracks: ['A', 'B'] },
    rules: { trackPriority: ['A', 'B'] },
    categories: { tracks: { A: { pdf: '01-A' } }, fallback_pdf: '99-Unclassified' },
    bootstrap: async () => { calls.push('bootstrap'); },
  }), /categories must contain every active track: B/);
  assert.deepEqual(calls, []);
});
