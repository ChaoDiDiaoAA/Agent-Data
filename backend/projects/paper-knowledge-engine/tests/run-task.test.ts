import { openStateStore } from '../src/library/state/state-store.ts';
import type { TaskParseManifest } from '../src/types/jobs.ts';
type Dependencies = Parameters<typeof runTask>[1];
import type { ProgressEvent } from '../src/types/jobs.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runConfiguredTask } from '../src/cli/routes.ts';
import { loadPaperPolicy } from '../src/shared/config.ts';
import { runTask } from '../src/library/pipeline.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { configureLayeredRuntimeFixture } from './fixtures/layered-config.ts';

function fakeConfig() {
  return {
    startDate: '2026-01-01', overlapHours: 48,
    currentTask: { maxPapers: 3, trackLimits: { A: 2, B: 1 } },
    weeklySchedule: { enabled: true, maxPapers: 2 },
  };
}

test('specified older resume validates kind/window/selection before start and leaves another pending batch unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'specified-run-'));
  const store = openStateStore(join(root, 'papers.sqlite'));
  try {
    const older = store.startRun({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T23:59:59.999Z' }, 'current');
    store.failRun(older.id, 'interrupted');
    const newer = store.startRun({ from: '2026-02-01T00:00:00.000Z', to: '2026-02-02T23:59:59.999Z' }, 'current');
    const before = store.getRun(newer.id);
    const dependencies = fakeDependencies([], { empty: true });
    dependencies.store = { ...store, get status() { return store.getRun(older.id)?.status ?? ''; } };
    dependencies.runRoot = join(root, 'runs');
    dependencies.discovery.harvest = async ({ run, window }) => { assert.equal(run.id, older.id); assert.equal(window.from, older.from); return []; };
    const result = await runTask({ mode: 'current', now: '2026-09-01T00:00:00Z', resumeRunId: older.id }, dependencies);
    assert.equal(result.runId, older.id); assert.deepEqual(store.getRun(newer.id), before);
    await assert.rejects(runTask({ mode: 'weekly', now: '2026-09-01T00:00:00Z', resumeRunId: older.id }, dependencies), /resume/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

function fakeDependencies(events: unknown[][], options: { disabled?: boolean; empty?: boolean; downloadFailure?: boolean; parseFailure?: boolean } = {}): Dependencies & { store: Dependencies['store'] & { status: string } } {
  let runStatus = 'running';
  const store: Dependencies['store'] & { status: string; listCompletedHarvestShardKeys(): string[] } = {
    getLastSuccess: () => null,
    findResumableHarvestRun: () => undefined,
    listCompletedHarvestShardKeys: () => [],
    startRun: (window, kind) => { events.push(['start', kind]); return { id: 'run-1', kind, status: runStatus, ...window }; },
    upsertDiscovered: (paper) => events.push(['discover', paper.baseId, paper.primaryTrack]),
    findByBaseId: () => undefined,
    markExcluded: (baseId) => events.push(['exclude', baseId]),
    completeEmptyRun: () => { runStatus = 'completed'; },
    failRun: () => { runStatus = 'failed'; events.push(['fail']); },
    get status() { return runStatus; },
  };
  const papers = [
    { baseId: '1', arxivId: '1v1', primaryTrack: 'A' },
    { baseId: '2', arxivId: '2v1', primaryTrack: 'B' },
    { baseId: '3', arxivId: '3v1', primaryTrack: 'A' },
    { baseId: '4', arxivId: '4v1', primaryTrack: 'A' },
  ];
  const config = fakeConfig();
  if (options.disabled) config.weeklySchedule.enabled = false;
  return {
    config, store, lockPath: 'state/test.lock', runRoot: 'state/runs',
    withLock: async (_path, operation) => operation(),
    bootstrap: async () => { events.push(['bootstrap']); },
    discovery: { harvest: async ({ window, run }) => {
      assert.equal(run.id, 'run-1');
      assert.equal(window.from, '2026-01-01T00:00:00.000Z');
      return options.empty ? [] : papers;
    } },
    policy: { evaluate: (paper) => ({ accepted: true, primaryTrack: paper.primaryTrack, paper, reasons: {} }) },
    pdfStore: {
      download: async (decision) => {
        if (options.downloadFailure) throw new Error('download failed');
        return { ...decision.paper, version: 1, sha256: decision.paper.baseId.repeat(64).slice(0, 64), pdfPath: `D:/paper/${decision.paper.baseId}.pdf` };
      },
    },
    buildManifest: (runId, stored, run) => ({ runId, window: { from: run.from, to: run.to }, jobs: stored.map((paper) => ({ ...paper, model: 'pipeline', cliBackend: 'pipeline', method: 'auto' })) }),
    writeManifest: async () => undefined,
    readManifest: async () => null,
    parseOne: async (job) => options.parseFailure
      ? { ...job, status: 'failed', errorMessage: 'parse failed' }
      : { ...job, status: 'succeeded', attemptId: `attempt-${job.baseId}` },
    publishEvidence: async (runId, manifest) => {
      assert.equal(runStatus, 'running');
      events.push(['publish', runId, manifest.jobs.length]);
      runStatus = 'completed';
      return { publicationId: `evidence-${runId}`, sourceCount: manifest.jobs.length, replayed: false };
    },
  };
}

test('configured task rejects track drift before state, bootstrap, run creation, or discovery', async () => {
  const events: string[] = [];
  const productionRules = loadPaperPolicy(join(process.cwd(), 'config', 'fsd', 'paper-policy.yaml'));
  const mismatchedRules = {
    ...productionRules,
    trackPriority: [...productionRules.trackPriority.slice(0, -1), 'Unreachable-Track'],
  };
  await assert.rejects(() => runConfiguredTask(['--mode', 'current'], process.cwd(), {
    rules: mismatchedRules,
    openStateStore: () => { events.push('state-open'); throw new Error('preflight must not open a store'); },
    bootstrap: async () => { events.push('bootstrap'); },
    harvest: async () => { events.push('discovery'); return []; },
    executeTask: async (_options, dependencies) => {
      const window = { from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z' };
      const run = dependencies.store.startRun(window, 'current');
      await dependencies.bootstrap();
      await dependencies.discovery.harvest({ window, run });
      throw new Error('unreachable execution');
    },
  }), /plan, policy priority, and quota tracks must exactly match/);

  assert.deepEqual(events, []);
});

test('current mode publishes selected Evidence and completes without model calls', async () => {
  const events: unknown[][] = [];
  const dependencies = fakeDependencies(events);
  const result = await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies);
  assert.equal(result.selected.length, 3);
  assert.equal(result.status, 'completed');
  assert.equal(dependencies.store.status, 'completed');
  assert.equal(result.paperCount, 3);
  assert.deepEqual(events.filter(event => event[0] === 'publish'), [['publish', 'run-1', 3]]);
});

test('permanently unavailable PDFs are excluded and replaced from the saved fallback pool', async () => {
  const events: unknown[][] = [];
  const dependencies = fakeDependencies(events);
  const downloads: string[] = [];
  const excluded: string[] = [];
  const checkpoints: any[] = [];
  dependencies.store.markExcluded = (baseId) => { excluded.push(baseId); };
  dependencies.pdfStore.download = async decision => {
    downloads.push(decision.paper.baseId);
    if (decision.paper.baseId === '4') {
      throw Object.assign(new Error('PDF download HTTP 404'), {
        code: 'PDF_NOT_FOUND', status: 404, baseId: '4', permanent: true,
      });
    }
    return { ...decision.paper, version: 1, sha256: decision.paper.baseId.repeat(64).slice(0, 64), pdfPath: `D:/paper/${decision.paper.baseId}.pdf` };
  };
  dependencies.writeManifest = async (_path, manifest) => { checkpoints.push(manifest); };

  const result = await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z', limit: 3 }, dependencies);

  assert.equal(result.status, 'completed');
  assert.deepEqual(downloads, ['4', '1', '2', '3']);
  assert.deepEqual(excluded, ['4']);
  const finalSelection = checkpoints.filter(manifest => Array.isArray(manifest.selected)).at(-1);
  assert.deepEqual(finalSelection.selected.map((item: any) => item.paper.baseId), ['1', '2', '3']);
  assert.deepEqual(finalSelection.fallbacks, []);
});

test('legacy selection without fallbacks replenishes from its persisted discovery observations', async () => {
  const events: unknown[][] = [];
  const dependencies = fakeDependencies(events);
  const downloads: string[] = [];
  const checkpoints: any[] = [];
  dependencies.discovery.harvest = async () => [
    { baseId: '4', arxivId: '4v1', primaryTrack: 'A' },
    { baseId: '2', arxivId: '2v1', primaryTrack: 'B' },
    { baseId: '3', arxivId: '3v1', primaryTrack: 'A' },
  ];
  dependencies.store.listHarvestObservations = () => [{ paper: { baseId: '5', arxivId: '5v1', primaryTrack: 'A' } }];
  dependencies.pdfStore.download = async decision => {
    downloads.push(decision.paper.baseId);
    if (decision.paper.baseId === '4') {
      throw Object.assign(new Error('PDF download HTTP 404'), {
        code: 'PDF_NOT_FOUND', status: 404, baseId: '4', permanent: true,
      });
    }
    return { ...decision.paper, version: 1, sha256: decision.paper.baseId.repeat(64).slice(0, 64), pdfPath: `D:/paper/${decision.paper.baseId}.pdf` };
  };
  dependencies.writeManifest = async (_path, manifest) => { checkpoints.push(manifest); };

  const result = await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z', limit: 3 }, dependencies);

  assert.equal(result.status, 'completed');
  assert.deepEqual(downloads, ['4', '5', '2', '3']);
  const finalSelection = checkpoints.filter(manifest => Array.isArray(manifest.selected)).at(-1);
  assert.deepEqual(finalSelection.selected.map((item: any) => item.paper.baseId), ['5', '2', '3']);
});

test('configured publication start observer failure cannot prevent the service from completing once', async () => {
  const dependencies = fakeDependencies([]);
  const publish = dependencies.publishEvidence;
  let serviceCalls = 0;
  dependencies.publishEvidence = async (runId, manifest) => {
    serviceCalls += 1;
    return publish(runId, manifest);
  };
  dependencies.onProgress = event => {
    if (event.type === 'evidence-publish-start') throw new Error('start observer failed');
  };

  const result = await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies);

  assert.equal(serviceCalls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(dependencies.store.status, 'completed');
});

test('configured publication start observer failure does not hide the service error', async () => {
  const dependencies = fakeDependencies([]);
  const serviceError = new Error('EVIDENCE_CONFLICT: configured service failed');
  let serviceCalls = 0;
  dependencies.publishEvidence = async () => {
    serviceCalls += 1;
    throw serviceError;
  };
  dependencies.onProgress = event => {
    if (event.type === 'evidence-publish-start') throw new Error('start observer failed');
  };

  await assert.rejects(
    () => runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies),
    error => error === serviceError,
  );
  assert.equal(serviceCalls, 1);
  assert.equal(dependencies.store.status, 'failed');
});

test('configured task delegates Evidence publication once to the normal reserve-first service', async () => {
  const fixture = await makeRuntimeFixture();
  await configureLayeredRuntimeFixture(fixture);
  const calls: unknown[] = [];
  let publicationResult: Awaited<ReturnType<Dependencies['publishEvidence']>> | undefined;
  const store = openStateStore(':memory:');
  const guardedStore = new Proxy(store, {
    get(target, property, receiver) {
      if (['reserveEvidencePublication', 'completeEvidencePublication', 'reserveHistoricalEvidencePublication'].includes(String(property))) {
        return () => assert.fail(`configured task must not call ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    const result = await runConfiguredTask(['--mode', 'current'], fixture.projectRoot, {
      openStateStore: () => guardedStore,
      publishRunEvidence: async input => {
        calls.push(input);
        return {
          status: 'completed', publicationId: 'service-publication', contentSha256: 'a'.repeat(64),
          receiptPath: 'service-receipt', receiptSha256: 'b'.repeat(64), sourceCount: 7,
          reservationReplayed: false, applyReplayed: true,
        };
      },
      executeTask: async (_options, dependencies) => {
        const window = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' };
        publicationResult = await dependencies.publishEvidence('configured-run', {
          runId: 'configured-run', window, jobs: [],
        });
        return { status: 'completed' as const, mode: 'current' as const, runId: 'configured-run', window, selected: [], replayed: publicationResult.replayed };
      },
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(publicationResult, { publicationId: 'service-publication', sourceCount: 7, replayed: true });
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { eligibility: string }).eligibility, 'normal');
    assert.equal((calls[0] as { runId: string }).runId, 'configured-run');
  } finally {
    await fixture.dispose();
  }
});

test('configured task propagates service reservation rejection without publication writes', async () => {
  const fixture = await makeRuntimeFixture();
  await configureLayeredRuntimeFixture(fixture);
  const store = openStateStore(':memory:');
  try {
    await assert.rejects(runConfiguredTask(['--mode', 'current'], fixture.projectRoot, {
      openStateStore: () => store,
      publishRunEvidence: async () => { throw new Error('EVIDENCE_CONFLICT: reservation rejected'); },
      executeTask: async (_options, dependencies) => {
        await dependencies.publishEvidence('configured-rejected', {
          runId: 'configured-rejected',
          window: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
          jobs: [],
        });
        throw new Error('unreachable');
      },
    }), /EVIDENCE_CONFLICT: reservation rejected/);
    assert.equal(await Bun.file(join(fixture.paths.stateRoot, 'runs', 'configured-rejected', 'evidence', 'publication.json')).exists(), false);
    assert.deepEqual(await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: fixture.paths.vaultRoot })), []);
    assert.deepEqual(await Array.fromAsync(new Bun.Glob('evidence-publications/**/*').scan({ cwd: fixture.paths.tempRoot })), []);
  } finally {
    await fixture.dispose();
  }
});

test('a resumed parse manifest cannot silently exceed a lowered configured limit', async () => {
  const dependencies = fakeDependencies([]);
  dependencies.config.currentTask = { maxPapers: 1, trackLimits: { A: 1, B: 0 } };
  const manifest = { runId: 'run-1', jobs: [{ baseId: '1', primaryTrack: 'A' }, { baseId: '2', primaryTrack: 'A' }] };
  dependencies.readManifest = async path => path.endsWith('mineru-jobs.json') ? manifest : null;
  dependencies.discovery.harvest = async () => assert.fail('must not rediscover');
  dependencies.pdfStore.download = async () => assert.fail('must not download');
  dependencies.parseOne = async () => assert.fail('must not parse beyond config');
  dependencies.writeManifest = async () => assert.fail('must preserve original checkpoint');
  await assert.rejects(() => runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies), /固定清单有 2 篇.*配置上限 1 篇/);
  assert.equal(manifest.jobs.length, 2);
  assert.equal(dependencies.store.status, 'failed');
});

test('automatically rejected candidates are excluded and an empty selection completes', async () => {
  const events: unknown[][] = [];
  const dependencies = fakeDependencies(events);
  dependencies.policy.evaluate = paper => ({ accepted: false, status: 'rejected', paper, reasons: { technologyAccepted: false } });
  dependencies.pdfStore.download = async () => { throw new Error('rejected candidates must not download'); };
  const result = await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.selected, []);
  assert.equal(dependencies.store.status, 'completed');
  assert.deepEqual(events.filter(event => event[0] === 'exclude').map(event => event[1]), ['1', '2', '3', '4']);
});

test('duplicate-content candidates are not parsed or published', async () => {
  const dependencies = fakeDependencies([]);
  dependencies.pdfStore.download = async () => ({ skipped: 'duplicate-content', duplicateOf: 'existing', pdfPath: 'D:/paper/existing.pdf' });
  dependencies.parseOne = async () => { throw new Error('duplicate must not be parsed'); };
  dependencies.publishEvidence = async () => { throw new Error('duplicate must not publish'); };
  const result = await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(result.paperCount, 0);
});

test('reports task, discovery, selection, download, MinerU, and completion progress', async () => {
  const events: unknown[][] = [];
  const progress: ProgressEvent[] = [];
  let tick = 0;
  const dependencies = fakeDependencies(events);
  dependencies.clock = () => { tick += 100; return tick; };
  dependencies.onProgress = (event) => progress.push(event);

  await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z', limit: 1 }, dependencies);

  assert.deepEqual(progress.map((event) => event.type), [
    'task-start',
    'discovery-complete',
    'selection-complete',
    'download-start',
    'download-complete',
    'parse-start',
    'parse-complete',
    'archive-complete',
    'evidence-publish-start',
    'evidence-publish-complete',
    'task-complete',
  ]);
  assert.deepEqual(progress.find((event) => event.type === 'download-complete'), {
    type: 'download-complete', phase: 'download', current: 1, total: 1,
    baseId: '4', arxivId: '4v1', status: 'downloaded', bytes: null,
    elapsedMs: 100, totalElapsedMs: 400,
  });
  assert.equal(progress.find((event) => event.type === 'selection-complete')!.selectedCount, 1);
  assert.equal(progress.find((event) => event.type === 'task-complete')!.status, 'completed');
});

test('reports the active download and failed phase before rejecting the task', async () => {
  const events: unknown[][] = [];
  const progress: ProgressEvent[] = [];
  let tick = 0;
  const dependencies = fakeDependencies(events, { downloadFailure: true });
  dependencies.clock = () => { tick += 100; return tick; };
  dependencies.onProgress = (event) => progress.push(event);

  await assert.rejects(() => runTask({ mode: 'current', now: '2026-08-02T00:00:00Z', limit: 1 }, dependencies), /download failed/);

  assert.deepEqual(progress.slice(-2).map((event) => event.type), ['download-failed', 'task-failed']);
  assert.equal(progress.at(-2)!.baseId, '4');
  assert.equal(progress.at(-1)!.failedPhase, 'download');
  assert.match(progress.at(-1)!.error!, /download failed/);
});

test('selection progress explains accepted, quota and spillover counts by category', async () => {
  const dependencies = fakeDependencies([]);
  const progress: ProgressEvent[] = [];
  dependencies.onProgress = event => progress.push(event);
  dependencies.discovery.harvest = async () => [1, 2, 3, 4].map(id => ({ baseId: String(id), primaryTrack: 'A' }));
  dependencies.policy.evaluate = paper => ({ accepted: paper.baseId !== '1', primaryTrack: 'A', paper, reasons: {} });
  await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies);
  const selection = progress.find(event => event.type === 'selection-complete');
  assert.ok(selection);
  assert.equal(selection.evaluatedCount, 4);
  assert.equal(selection.acceptedCount, 3);
  assert.equal(selection.selectedCount, 3);
  assert.equal(selection.quotaCount, 2);
  assert.equal(selection.spilloverCount, 1);
  assert.deepEqual(selection.selectedByTrack, { A: 3, B: 0 });
});

test('weekly mode selects its smaller ceiling', async () => {
  const events: unknown[][] = [];
  const result = await runTask({ mode: 'weekly', now: '2026-08-02T00:00:00Z' }, fakeDependencies(events));
  assert.equal(result.selected.length, 2);
});

test('accepted rediscovery uses the reused PDF track in the manifest', async () => {
  const events: unknown[][] = [];
  const dependencies = fakeDependencies(events);
  dependencies.discovery.harvest = async () => [{ baseId: '1', arxivId: '1v1', title: 'Paper' }];
  dependencies.policy.evaluate = (paper) => ({ accepted: true, primaryTrack: 'B', paper, reasons: {} });
  dependencies.pdfStore.download = async (decision) => ({
    ...decision.paper,
    primaryTrack: 'A',
    version: 1,
    sha256: '1'.repeat(64),
    pdfPath: 'D:/paper/1.pdf',
    skipped: 'existing-version',
  });

  let manifest: TaskParseManifest | undefined;
  dependencies.buildManifest = (runId, stored, run) => {
    manifest = { runId, window: { from: run.from, to: run.to }, jobs: stored };
    return manifest;
  };

  await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z', limit: 1 }, dependencies);

  assert.ok(manifest);
  assert.equal(manifest.jobs[0].primaryTrack, 'A');
});

test('disabled weekly mode does not bootstrap or create a run', async () => {
  const events: unknown[][] = [];
  const result = await runTask({ mode: 'weekly', now: '2026-08-02T00:00:00Z' }, fakeDependencies(events, { disabled: true }));
  assert.equal(result.status, 'disabled');
  assert.deepEqual(events, []);
});

test('empty weekly mode completes and advances without a manifest', async () => {
  const events: unknown[][] = [];
  const dependencies = fakeDependencies(events, { empty: true });
  const result = await runTask({ mode: 'weekly', now: '2026-08-02T00:00:00Z' }, dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(dependencies.store.status, 'completed');
});

test('reports completed progress for an empty run', async () => {
  const events: unknown[][] = [];
  const progress: ProgressEvent[] = [];
  let tick = 0;
  const dependencies = fakeDependencies(events, { empty: true });
  dependencies.clock = () => { tick += 100; return tick; };
  dependencies.onProgress = (event) => progress.push(event);

  await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies);

  assert.deepEqual(progress.at(-1), {
    type: 'task-complete', phase: 'task', status: 'completed', paperCount: 0, totalElapsedMs: 200,
  });
});

test('zero-candidate completion ignores a throwing task-complete observer after completing the run', async () => {
  const dependencies = fakeDependencies([], { empty: true });
  dependencies.onProgress = event => {
    if (event.type === 'task-complete') throw new Error('empty observer failed after completion');
  };

  const result = await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies);

  assert.equal(result.status, 'completed');
  assert.equal(result.paperCount, 0);
  assert.equal(dependencies.store.status, 'completed');
});

test('all-duplicate completion ignores a throwing task-complete observer after completing the run', async () => {
  const dependencies = fakeDependencies([]);
  dependencies.pdfStore.download = async () => ({ skipped: 'duplicate-content', duplicateOf: 'existing', pdfPath: 'D:/paper/existing.pdf' });
  dependencies.onProgress = event => {
    if (event.type === 'task-complete') throw new Error('duplicate observer failed after completion');
  };

  const result = await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies);

  assert.equal(result.status, 'completed');
  assert.equal(result.paperCount, 0);
  assert.equal(dependencies.store.status, 'completed');
});

for (const eventType of ['evidence-publish-complete', 'task-complete'] as const) {
  test(`normal task ignores ${eventType} observer errors after Evidence atomically completed the run`, async () => {
    const dependencies = fakeDependencies([]);
    dependencies.onProgress = event => {
      if (event.type === eventType) throw new Error('observer failed after completion');
    };

    const result = await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies);

    assert.equal(result.status, 'completed');
    assert.equal(dependencies.store.status, 'completed');
  });
}

test('fresh current mode starts at the configured pipeline date instead of the incremental watermark', async () => {
  const dependencies = fakeDependencies([], { empty: true });
  dependencies.store.getLastSuccess = () => { throw new Error('current mode must not read the incremental watermark'); };
  dependencies.store.findResumableHarvestRun = () => undefined;
  dependencies.store.startRun = (window, kind) => {
    assert.equal(kind, 'current');
    assert.deepEqual(window, {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-09-04T12:34:56.000Z',
    });
    return { id: 'run-1', kind, ...window, status: 'running' };
  };

  const result = await runTask({ mode: 'current', now: '2026-09-04T12:34:56.000Z' }, dependencies);

  assert.ok(result.window);
  assert.equal(result.window.from, '2026-01-01T00:00:00.000Z');
});

test('fresh current mode ignores an automatic failed harvest whose start does not match the configured contract', async () => {
  const dependencies = fakeDependencies([], { empty: true });
  const staleWindow = { from: '2026-09-01T08:49:02.461Z', to: '2026-09-04T23:59:59.999Z' };
  dependencies.store.findResumableHarvestRun = () => ({
    run_id: 'stale-run', kind: 'current', status: 'failed',
    from_utc: staleWindow.from, to_utc: staleWindow.to,
  });
  dependencies.store.startRun = (window, kind) => {
    assert.deepEqual(window, {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-09-04T12:34:56.000Z',
    });
    return { id: 'run-config', kind, ...window, status: 'running' };
  };
  dependencies.discovery.harvest = async ({ window, run }) => {
    assert.equal(run.id, 'run-config');
    assert.equal(window.from, '2026-01-01T00:00:00.000Z');
    return [];
  };

  const result = await runTask({ mode: 'current', now: '2026-09-04T12:34:56.000Z' }, dependencies);

  assert.equal(result.runId, 'run-config');
});

test('weekly mode retains the incremental overlap window from the last successful publication', async () => {
  const dependencies = fakeDependencies([], { empty: true });
  dependencies.store.getLastSuccess = () => '2026-02-10T00:00:00.000Z';
  dependencies.store.findResumableHarvestRun = () => undefined;
  dependencies.store.startRun = (window, kind) => {
    assert.equal(kind, 'weekly');
    assert.deepEqual(window, {
      from: '2026-02-08T00:00:00.000Z',
      to: '2026-02-17T01:00:00.000Z',
    });
    return { id: 'weekly-run', kind, ...window, status: 'running' };
  };
  dependencies.discovery.harvest = async ({ window, run }) => {
    assert.equal(run.id, 'weekly-run');
    assert.equal(window.from, '2026-02-08T00:00:00.000Z');
    return [];
  };

  const result = await runTask({ mode: 'weekly', now: '2026-02-17T01:00:00.000Z' }, dependencies);

  assert.ok(result.window);
  assert.equal(result.window.from, '2026-02-08T00:00:00.000Z');
});

test('reuses a failed current harvest whose window starts at the configured pipeline date', async () => {
  const events: unknown[][] = [];
  const dependencies = fakeDependencies(events, { empty: true });
  const failedWindow = { from: '2026-01-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' };
  dependencies.store.findResumableHarvestRun = () => ({
    run_id: 'run-1', kind: 'current', status: 'failed',
    from_utc: failedWindow.from, to_utc: failedWindow.to,
  });
  dependencies.store.startRun = (window, kind) => {
    assert.deepEqual(window, failedWindow);
    return { id: 'run-1', kind, ...window, status: 'running', resumed: true };
  };
  dependencies.discovery.harvest = async ({ window, run }) => {
    assert.deepEqual(window, failedWindow);
    assert.equal(run.id, 'run-1');
    assert.equal(run.resumed, true);
    return [];
  };

  const result = await runTask({ mode: 'current', now: '2026-09-15T00:00:00.000Z' }, dependencies);

  assert.deepEqual(result.window, failedWindow);
  assert.equal(result.runId, 'run-1');
});

test('an explicit window override does not resume a failed harvest window', async () => {
  const events: unknown[][] = [];
  const dependencies = fakeDependencies(events, { empty: true });
  const override = { from: '2026-08-05T00:00:00.000Z', to: '2026-08-06T00:00:00.000Z' };
  dependencies.store.findResumableHarvestRun = () => {
    throw new Error('resume lookup must not run for explicit windows');
  };
  let autoResume: boolean | undefined;
  dependencies.store.startRun = (window, kind, options) => {
    autoResume = options?.autoResume;
    return { id: 'run-override', kind, ...window, status: 'running' };
  };
  dependencies.discovery.harvest = async ({ window, run }) => {
    assert.deepEqual(window, override);
    assert.equal(run.id, 'run-override');
    return [];
  };

  const result = await runTask({ mode: 'current', now: '2026-09-15T00:00:00.000Z', windowOverride: override }, dependencies);
  assert.deepEqual(result.window, override);
  assert.equal(autoResume, false);
});

test('a saved parse manifest resumes parsing without discovery or download', async () => {
  const events: unknown[][] = [];
  const dependencies = fakeDependencies(events);
  const manifest = { runId: 'run-1', jobs: [{ baseId: '1', version: 1, sha256: '1'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto' }] };
  dependencies.readManifest = async path => path.endsWith('mineru-jobs.json') ? manifest : null;
  dependencies.discovery.harvest = async () => assert.fail('saved manifest must not rediscover');
  dependencies.pdfStore.download = async () => assert.fail('saved manifest must not download');
  const parsed: string[] = [];
  dependencies.parseOne = async job => { parsed.push(job.baseId); return { ...job, status: 'succeeded', attemptId: `attempt-${job.baseId}` }; };

  const result = await runTask({ mode: 'current', now: '2026-08-02T00:00:00Z' }, dependencies);

  assert.equal(result.status, 'completed');
  assert.deepEqual(parsed, ['1']);
  assert.deepEqual(events.filter(event => event[0] === 'publish'), [['publish', 'run-1', 1]]);
});

for (const failure of ['downloadFailure', 'parseFailure']) {
  test(`${failure} fails the run without publishing or advancing`, async () => {
    const events: unknown[][] = [];
    const dependencies = fakeDependencies(events, { [failure]: true });
    await assert.rejects(() => runTask({ mode: 'weekly', now: '2026-08-02T00:00:00Z' }, dependencies), /failed/);
    assert.equal(dependencies.store.status, 'failed');
    assert.equal(events.some(([name]) => name === 'publish'), false);
  });
}
