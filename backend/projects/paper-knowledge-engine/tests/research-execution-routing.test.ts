import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { runConfiguredTask, type ConfiguredContext, type ConfiguredResearchContext } from '../src/library/execution.ts';
import type { ResearchRunResult } from '../src/research/research-workflow.ts';
import type { ResearchSourceKind } from '../src/types/config.ts';
import type { ResearchWorkflowDependencies } from '../src/research/research-workflow.ts';
import { makeResearchFixture, researchFixtureId } from './helpers/research-library-fixture.ts';

const opened: Array<{ close(): void }> = [];
afterEach(() => { opened.splice(0); });

function fakeStore() {
  const store = { close() {} };
  opened.push(store);
  return store;
}

function result(mode: 'current' | 'weekly' | 'backfill', runId = 'research-run') : ResearchRunResult {
  return { runId, mode, window: { from: '2026-01-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' },
    counters: { candidates: 0, accepted: 0, newVersions: 0, archived: 0, published: 0 }, resumed: false, status: 'awaiting_evidence' };
}

test('runConfiguredTask routes a research library through injected workflow dependencies', async () => {
  const root = makeResearchFixture();
  const calls: unknown[] = [];
  const dependencies = { adapters: [] } as unknown as Omit<ResearchWorkflowDependencies, 'library' | 'stateRoot' | 'store'>;
  const context = {
    libraryId: researchFixtureId,
    openStateStore: (() => fakeStore()) as unknown as ConfiguredContext['openStateStore'],
    research: {
      dependencies,
      run: async (request: unknown, deps: ResearchWorkflowDependencies) => {
        calls.push({ request, library: deps.library, stateRoot: deps.stateRoot, store: deps.store });
        return result('current');
      },
    },
  } as unknown as ConfiguredResearchContext;

  try {
    const value = await runConfiguredTask({ mode: 'current', limit: 7,
      window: { from: '2026-06-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' },
      tracks: ['agent-loop'], sourceKinds: ['official-doc'] as ResearchSourceKind[] }, root, context);

    expect(value.status).toBe('awaiting_evidence');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      request: { mode: 'current', limit: 7, from: '2026-06-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z', tracks: ['agent-loop'], sourceKinds: ['official-doc'] },
      library: { kind: 'research', libraryId: researchFixtureId },
      stateRoot: expect.stringContaining(researchFixtureId),
      store: opened[0],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('research resume uses the injected resume runner and closes its store', async () => {
  const root = makeResearchFixture();
  const calls: string[] = [];
  const store = { close() {} };
  const context = {
    libraryId: researchFixtureId,
    openStateStore: (() => { opened.push(store); return store; }) as unknown as ConfiguredContext['openStateStore'],
    resumeRunId: 'research-run-1',
    research: {
      dependencies: { adapters: [] },
      run: async () => { calls.push('run'); return result('backfill'); },
      resume: async (runId: string, request: unknown, deps: ResearchWorkflowDependencies) => {
        calls.push(`${runId}:${String((request as { mode: string }).mode)}:${deps.library.libraryId}`);
        return { ...result('backfill', runId), resumed: true };
      },
    },
  } as unknown as ConfiguredResearchContext;

  try {
    const value = await runConfiguredTask({ mode: 'backfill', limit: 2,
      window: { from: '2026-01-01T00:00:00.000Z', to: '2026-06-30T23:59:59.999Z' } }, root, context);

    expect(value).toMatchObject({ runId: 'research-run-1', mode: 'backfill', resumed: true });
    expect(calls).toEqual([`research-run-1:backfill:${researchFixtureId}`]);
    expect(opened).toEqual([store]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('research routing fails explicitly when the workflow injection is absent', async () => {
  const root = makeResearchFixture();
  try {
    await expect(runConfiguredTask({ mode: 'current' }, root, { libraryId: researchFixtureId as never }))
      .rejects.toThrow('RESEARCH_WORKFLOW_UNCONFIGURED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
