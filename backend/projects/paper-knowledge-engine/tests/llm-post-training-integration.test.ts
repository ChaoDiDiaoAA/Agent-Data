import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { main } from '../src/cli.ts';
import { normalizeCliOperation, runConfiguredTask } from '../src/cli/routes.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import { paperLibraryIds, withPostTrainingFixture } from './helpers/llm-post-training-fixture.ts';

const libraryId = asLibraryId('llm-post-training');

test('all six paper libraries have separate paths and opening a menu creates no state', () =>
  withPostTrainingFixture(async root => {
    const contexts = paperLibraryIds.map(id => loadEngineContext({ root, libraryId: id }));
    for (const key of ['dataRoot', 'databasePath', 'archiveRoot', 'runsRoot',
      'operationsRoot', 'workRoot', 'backupRoot', 'pdfRoot', 'vaultRoot'] as const) {
      const paths = contexts.map(context => context.paths[key]);
      assert.ok(paths.every(path => typeof path === 'string'));
      assert.equal(new Set(paths).size, 6, key);
    }

    const lines: string[] = [];
    await main(['--library', libraryId], {
      root,
      interactive: true,
      readLine: async () => '0',
      writeLine: line => { lines.push(line); },
    });
    assert.ok(lines.some(line => line.includes('LLM Post-Training')));
    assert.ok(lines.includes('11. 切换方向库'));
    for (const { paths } of contexts) {
      for (const path of [paths.dataRoot, paths.vaultRoot, paths.pdfRoot]) {
        assert.ok(path && !existsSync(path));
      }
    }

    assert.throws(
      () => normalizeCliOperation('run-task', ['--mode', 'backfill'], libraryId, 'paper'),
      /UNSUPPORTED_LIBRARY_KIND/,
    );
    assert.deepEqual(
      normalizeCliOperation('run-task', ['--mode', 'weekly'], libraryId, 'paper'),
      { kind: 'weekly' },
    );
  }));

test('post-training current and weekly use shared discovery with checkpoints', () =>
  withPostTrainingFixture(async root => {
    const expected = loadEngineContext({ root, libraryId });
    for (const mode of ['current', 'weekly'] as const) {
      let calls = 0;
      const result = await runConfiguredTask(['--mode', mode], root, {
        libraryId,
        openStateStore: () => openStateStore(':memory:'),
        bootstrap: async () => {},
        harvest: async (shards, _window, options) => {
          calls++;
          assert.equal(shards.length, 36);
          assert.equal(typeof options.checkpoint.start, 'function');
          assert.deepEqual(options.network, expected.machine.network);
          return [];
        },
        executeTask: async (options, dependencies) => {
          assert.equal(dependencies.config.weeklySchedule.enabled, true);
          assert.equal(dependencies.config.libraryId, libraryId);
          assert.equal(dependencies.runRoot, expected.paths.runsRoot);
          const window = { from: '2026-01-01T00:00:00Z', to: '2026-09-08T00:00:00Z' };
          const run = dependencies.store.startRun(window, options.mode);
          await dependencies.discovery.harvest({ window, run });
          return { status: 'completed', mode: options.mode, runId: run.id, window, selected: [], paperCount: 0 };
        },
      });
      assert.equal(result.status, 'completed');
      assert.equal(calls, 1);
    }

    await assert.rejects(
      runConfiguredTask(['--mode', 'weekly', '--limit', '5'], root, { libraryId }),
      /weekly run-task does not accept --limit/,
    );
  }));
