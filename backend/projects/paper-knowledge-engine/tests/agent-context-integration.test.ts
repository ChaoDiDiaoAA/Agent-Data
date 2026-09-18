import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { asLibraryId } from '../src/shared/identity.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { runConfiguredTask } from '../src/cli/routes.ts';
import { openStateStore } from '../src/library/state/state-store.ts';

const libraryId = asLibraryId('agent-context');

for (const mode of ['current', 'weekly'] as const) {
  test(`agent-context ${mode} task uses shared 36-shard discovery without network`, async () => {
    const context = loadEngineContext({ root: process.cwd(), libraryId });
    const fsd = loadEngineContext({ root: process.cwd(), libraryId: 'fsd' });
    assert.notEqual(context.paths.dataRoot, fsd.paths.dataRoot);
    assert.match(context.paths.dataRoot, /agent-context/i);

    let observedShards = 0;
    const result = await runConfiguredTask(
      ['--mode', mode, ...(mode === 'current' ? ['--limit', '0'] : [])],
      process.cwd(),
      {
        libraryId,
        openStateStore: () => openStateStore(':memory:'),
        bootstrap: async () => {},
        harvest: async (shards, _window, options) => {
          observedShards = shards.length;
          assert.equal(typeof options.checkpoint.start, 'function');
          assert.equal(
            options.rateLimitPath,
            join(context.machine.roots.dataLibrariesRoot, '.arxiv', 'request-rate.lock'),
          );
          return [];
        },
        executeTask: async (options, dependencies) => {
          const window = {
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-09-19T00:00:00.000Z',
          };
          const run = dependencies.store.startRun(window, options.mode);
          await dependencies.discovery.harvest({ window, run });
          return {
            status: 'completed',
            mode: options.mode,
            runId: run.id,
            window,
            selected: [],
            paperCount: 0,
          };
        },
      },
    );

    assert.equal(result.status, 'completed');
    assert.equal(observedShards, 36);
  });
}
