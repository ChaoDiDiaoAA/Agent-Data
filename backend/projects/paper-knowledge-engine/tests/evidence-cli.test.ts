import { test, expect, afterEach } from 'bun:test';
import { main } from '../src/cli.ts';
import { normalizeCliOperation, routeEvidencePublish } from '../src/cli/routes.ts';
import { executeOperation } from '../src/library/workflow.ts';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { join } from 'node:path';
import type { VerifiedArchiveSource } from '../src/evidence/archive-reader.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import { configureLayeredRuntimeFixture } from './fixtures/layered-config.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';

afterEach(() => { process.exitCode = 0; });

async function evidenceFixture() {
  const fixture = await makeRuntimeFixture();
  await configureLayeredRuntimeFixture(fixture);
  return { ...fixture, databasePath: loadEngineContext({ root: fixture.projectRoot }).paths.databasePath };
}

test('evidence-publish normalizes a safe run identity and rejects the retired routes', () => {
  const libraryId = asLibraryId('fsd');
  expect(normalizeCliOperation('evidence-publish', ['--run-id', 'safe-1'], libraryId)).toEqual({ kind: 'evidence-publish', runId: 'safe-1' });
  expect(() => normalizeCliOperation('evidence-publish', ['--run-id', '../private'], libraryId)).toThrow();
  expect(() => normalizeCliOperation('wiki', ['--run-id', 'safe-1'], libraryId)).toThrow();
});

test('CLI runs evidence-publish through admission and the publisher boundary', async () => {
  const f = await makeRuntimeFixture();
  try {
    let output: unknown;
    await main(['--library', 'fsd', 'evidence-publish', '--run-id', 'run-fixture'], { root: f.projectRoot, operationsRoot: f.paths.stateRoot, output: value => { output = value; },
      execute: (input, dependencies) => executeOperation(input, { ...dependencies, publishEvidence: async runId => ({ status: 'completed', runId, publicationId: 'evidence-fixture' }) }),
    });
    expect(output).toMatchObject({ status: 'completed', runId: 'run-fixture' });
  } finally { await f.dispose(); }
});

test('route rejects a failed run before it can create an Evidence reservation', async () => {
  const f = await evidenceFixture();
  const store = openStateStore(f.databasePath);
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    store.failRun(run.id, 'parse failed');
    await expect(routeEvidencePublish(['--run-id', run.id], { root: f.projectRoot })).rejects.toThrow('EVIDENCE_CONFLICT');
    expect(store.findEvidencePublication(run.id)).toBeUndefined();
  } finally { store.close(); await f.dispose(); }
});

for (const [status, eligibility] of [['running', 'normal'], ['failed', 'failed-recovery']] as const) {
  test(`menu Evidence publication selects ${eligibility} for a ${status} run and preserves service identities`, async () => {
    const f = await evidenceFixture();
    const store = openStateStore(f.databasePath);
    const progress: unknown[] = [];
    const calls: unknown[] = [];
    try {
      const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
      if (status === 'failed') store.failRun(run.id, 'parse failed');
      store.close();
      const source = { source: { baseId: '2609.20001', version: 1 } } as VerifiedArchiveSource;

      const result = await routeEvidencePublish(['--run-id', run.id], {
        root: f.projectRoot,
        onProgress: event => progress.push(event),
        readVerifiedRunSources: async () => [source],
        publishRunEvidence: async input => {
          calls.push(input);
          return {
            status: 'completed', publicationId: 'service-menu-publication', contentSha256: 'c'.repeat(64),
            receiptPath: 'service-menu-receipt', receiptSha256: 'd'.repeat(64), sourceCount: 5,
            reservationReplayed: false, applyReplayed: true,
          };
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ runId: run.id, eligibility });
      expect(progress).toEqual([
        { type: 'evidence-publish-start', phase: 'evidence-publish', runId: run.id, sourceCount: 1 },
        { type: 'evidence-publish-complete', phase: 'evidence-publish', runId: run.id, sourceCount: 5,
          publicationId: 'service-menu-publication', replayed: true },
      ]);
      expect(result).toEqual({ status: 'completed', runId: run.id, publicationId: 'service-menu-publication', sourceCount: 5, replayed: true });
    } finally {
      try { store.close(); } catch {}
      await f.dispose();
    }
  });
}

test('menu reservation rejection propagates without creating publication files', async () => {
  const f = await evidenceFixture();
  const store = openStateStore(f.databasePath);
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    store.close();
    await expect(routeEvidencePublish(['--run-id', run.id], {
      root: f.projectRoot,
      readVerifiedRunSources: async () => [],
      publishRunEvidence: async () => { throw new Error('EVIDENCE_CONFLICT: reservation rejected'); },
    })).rejects.toThrow('EVIDENCE_CONFLICT: reservation rejected');
    expect(await Bun.file(join(f.paths.stateRoot, 'runs', run.id, 'evidence', 'publication.json')).exists()).toBe(false);
    expect(await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: f.paths.vaultRoot }))).toEqual([]);
    expect(await Array.fromAsync(new Bun.Glob('evidence-publications/**/*').scan({ cwd: f.paths.tempRoot }))).toEqual([]);
  } finally {
    try { store.close(); } catch {}
    await f.dispose();
  }
});

test('menu publication ignores a throwing completion observer after the run is completed', async () => {
  const f = await evidenceFixture();
  const store = openStateStore(f.databasePath);
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    store.close();
    const result = await routeEvidencePublish(['--run-id', run.id], {
      root: f.projectRoot,
      readVerifiedRunSources: async () => [],
      publishRunEvidence: async input => {
        input.store.completeEmptyRun(input.runId, input.lastSuccess);
        return {
          status: 'completed', publicationId: 'observer-publication', contentSha256: 'a'.repeat(64),
          receiptPath: 'observer-receipt', receiptSha256: 'b'.repeat(64), sourceCount: 0,
          reservationReplayed: false, applyReplayed: false,
        };
      },
      onProgress: event => {
        if (event.type === 'evidence-publish-complete') throw new Error('observer failed after completion');
      },
    });

    expect(result).toEqual({ status: 'completed', runId: run.id, publicationId: 'observer-publication', sourceCount: 0, replayed: false });
    const reopened = openStateStore(f.databasePath);
    try { expect(reopened.getRun(run.id)?.status).toBe('completed'); }
    finally { reopened.close(); }
  } finally {
    try { store.close(); } catch {}
    await f.dispose();
  }
});

test('explicit or menu publication start observer failure cannot prevent one service completion', async () => {
  const f = await evidenceFixture();
  const store = openStateStore(f.databasePath);
  let serviceCalls = 0;
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    store.close();
    const result = await routeEvidencePublish(['--run-id', run.id], {
      root: f.projectRoot,
      readVerifiedRunSources: async () => [],
      publishRunEvidence: async input => {
        serviceCalls += 1;
        input.store.completeEmptyRun(input.runId, input.lastSuccess);
        return {
          status: 'completed', publicationId: 'start-observer-publication', contentSha256: 'a'.repeat(64),
          receiptPath: 'start-observer-receipt', receiptSha256: 'b'.repeat(64), sourceCount: 0,
          reservationReplayed: false, applyReplayed: false,
        };
      },
      onProgress: event => {
        if (event.type === 'evidence-publish-start') throw new Error('start observer failed');
      },
    });

    expect(serviceCalls).toBe(1);
    expect(result.status).toBe('completed');
    const reopened = openStateStore(f.databasePath);
    try { expect(reopened.getRun(run.id)?.status).toBe('completed'); }
    finally { reopened.close(); }
  } finally {
    try { store.close(); } catch {}
    await f.dispose();
  }
});

test('explicit or menu publication start observer failure does not hide the service error', async () => {
  const f = await evidenceFixture();
  const store = openStateStore(f.databasePath);
  const serviceError = new Error('EVIDENCE_CONFLICT: explicit service failed');
  let serviceCalls = 0;
  try {
    const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
    store.close();
    await expect(routeEvidencePublish(['--run-id', run.id], {
      root: f.projectRoot,
      readVerifiedRunSources: async () => [],
      publishRunEvidence: async () => {
        serviceCalls += 1;
        throw serviceError;
      },
      onProgress: event => {
        if (event.type === 'evidence-publish-start') throw new Error('start observer failed');
      },
    })).rejects.toBe(serviceError);
    expect(serviceCalls).toBe(1);
  } finally {
    try { store.close(); } catch {}
    await f.dispose();
  }
});
