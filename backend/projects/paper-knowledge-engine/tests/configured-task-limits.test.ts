import type { ProgressEvent } from '../src/types/jobs.ts';
import { makeRuntimeFixture, removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';
import { configureLayeredRuntimeFixture, writeLayeredConfigFixture } from './fixtures/layered-config.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { runConfiguredTask } from '../src/cli/routes.ts';
import { runTask } from '../src/library/pipeline.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { runHarvestShards } from '../src/discovery/opencli-runner.ts';
import { PDFDocument } from 'pdf-lib';
import type { MinerUCliJob } from '../src/types/jobs.ts';
import { createHash } from 'node:crypto';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { asLibraryId } from '../src/shared/identity.ts';

async function createPdf(path: string, title: string) {
  const document = await PDFDocument.create();
  document.setTitle(title);
  document.addPage();
  await writeFile(path, await document.save());
}

test('Agent Engineering uses the shared paper harvest and checkpoint seam', async () => {
  let observedShards = 0;
  let observedCheckpoint = false;
  const expectedContext = loadEngineContext({ root: process.cwd(), libraryId: 'agent-engineering' });
  const expectedNetwork = expectedContext.machine.network;
  const result = await runConfiguredTask(['--mode', 'current', '--limit', '0'], process.cwd(), {
    libraryId: 'agent-engineering' as never,
    openStateStore: () => openStateStore(':memory:'),
    bootstrap: async () => {},
    harvest: async (shards, _window, options) => {
      observedShards = shards.length;
      observedCheckpoint = typeof options.checkpoint.start === 'function';
      assert.deepEqual(options.network, expectedNetwork);
      assert.equal(options.rateLimitPath, join(expectedContext.machine.roots.dataLibrariesRoot, '.arxiv', 'request-rate.lock'));
      return [];
    },
    executeTask: async (options, dependencies) => {
      const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' };
      const run = dependencies.store.startRun(window, options.mode);
      await dependencies.discovery.harvest({ window, run });
      return { status: 'completed', mode: options.mode, runId: run.id, window, selected: [], paperCount: 0 };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(observedShards, 30);
  assert.equal(observedCheckpoint, true);
});

test('Multi-Agent Engineering uses the shared paper harvest and checkpoint seam', async () => {
  let observedShards = 0;
  let observedCheckpoint = false;
  const expectedNetwork = loadEngineContext({ root: process.cwd(), libraryId: 'multi-agent-engineering' }).machine.network;
  const result = await runConfiguredTask(['--mode', 'current', '--limit', '0'], process.cwd(), {
    libraryId: asLibraryId('multi-agent-engineering'),
    openStateStore: () => openStateStore(':memory:'),
    bootstrap: async () => {},
    harvest: async (shards, _window, options) => {
      observedShards = shards.length;
      observedCheckpoint = typeof options.checkpoint.start === 'function';
      assert.deepEqual(options.network, expectedNetwork);
      return [];
    },
    executeTask: async (options, dependencies) => {
      const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' };
      const run = dependencies.store.startRun(window, options.mode);
      await dependencies.discovery.harvest({ window, run });
      return {
        status: 'completed', mode: options.mode, runId: run.id,
        window, selected: [], paperCount: 0,
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(observedShards, 36);
  assert.equal(observedCheckpoint, true);
});

test('shared CLI machine proxy reaches discovery and real PDF download', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pke-network-'));
  const document = await PDFDocument.create(); document.addPage(); const bytes = Buffer.from(await document.save());
  const requests: string[] = [];
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests.push(request.url);
    return new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } });
  } });
  try {
    await writeLayeredConfigFixture({ root });
    const path = join(root, 'config', 'machine.local.yaml');
    const machine = YAML.parse(await readFile(path, 'utf8'));
    const httpProxy = `http://127.0.0.1:${proxy.port}`;
    machine.network = { http_proxy: httpProxy };
    await writeFile(path, YAML.stringify(machine));
    await assert.rejects(runConfiguredTask(['--mode', 'current'], root, {
      openStateStore: () => openStateStore(':memory:'),
      signal: AbortSignal.timeout(3000),
      harvest: async (_shards, _window, options) => {
        assert.deepEqual(options.network, { httpProxy, openCliProxyMode: 'configured' });
        return [];
      },
      executeTask: async (_options, dependencies) => {
        const window = { from: '2026-08-01', to: '2026-08-02' };
        const run = dependencies.store.startRun(window, 'current');
        await dependencies.discovery.harvest({ window, run });
        const paper = {
          baseId: 'proxy', arxivId: 'proxyv1', version: 1, pdfUrl: 'http://paper.invalid/configured.pdf',
          title: 'Proxy fixture', summary: '', authors: ['Fixture Author'], published: '2026-08-01', updated: '2026-08-01', categories: ['cs.SE'],
        };
        dependencies.store.upsertDiscovered(paper);
        const result = await dependencies.pdfStore.download({ accepted: true, primaryTrack: 'AI-TDD', paper });
        assert.deepEqual(await readFile(result.pdfPath), bytes);
        throw new Error('fixture complete before parsing');
      },
    }), /fixture complete before parsing/);
    assert.deepEqual(requests, ['http://paper.invalid/configured.pdf']);
  } finally { await proxy.stop(true); await removeOwnedTestDirectory(root); }
});

async function writeSessionArtifacts(outputDir: string, title = 'Session Task') {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'paper.md'), `# ${title}\ntext`);
  await writeFile(join(outputDir, 'paper_content_list.json'), '[{"page_idx":0,"text":"text"}]');
}

test('each CLI invocation reloads YAML limits through selection, download and parsing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fsd-config-limits-'));
  try {
    const paths = await writeLayeredConfigFixture({ root });
    const configPath = join(root, 'config', 'fsd', 'library.yaml');
    const raw = YAML.parse(await readFile(configPath, 'utf8'));
    for (const [currentLimit, weeklyLimit] of [[2, 5], [4, 3]] as const) {
      raw.current_task.max_papers = currentLimit;
      raw.current_task.track_limits = Object.fromEntries(Object.keys(raw.current_task.track_limits)
        .map(track => [track, track === 'AI-Program-Analysis-AST' ? currentLimit : 0]));
      raw.weekly_schedule.max_papers = weeklyLimit;
      raw.weekly_schedule.enabled = true;
      await writeFile(configPath, YAML.stringify(raw));
      for (const [mode, expected] of [['current', currentLimit], ['weekly', weeklyLimit]] as const) {
        const downloaded: string[] = [];
        const parsed: string[] = [];
        const progress: ProgressEvent[] = [];
        const papers = Array.from({ length: 8 }, (_, i) => ({
          baseId: `2608.${90000 + i}`, arxivId: `2608.${90000 + i}v1`, version: 1,
          title: 'Control flow graph for test generation', summary: '', authors: ['Fixture Author'],
          published: '2026-08-01', updated: '2026-08-01', categories: ['cs.SE'],
          matchedTracks: ['AI-Program-Analysis-AST'],
        }));
        const result = await runConfiguredTask(['--mode', mode], root, {
          openStateStore: () => openStateStore(':memory:'),
          bootstrap: async () => {},
          harvest: async (_shards, _window, options) => {
            assert.equal(options.tempRoot, paths.workRoot);
            return papers;
          },
          executeTask: (options, deps) => runTask(options, {
            ...deps, withLock: async (_path, operation) => operation(),
            readManifest: async () => null, writeManifest: async () => {},
            onProgress: event => progress.push(event),
            pdfStore: { download: async decision => {
              downloaded.push(decision.paper.baseId);
              return { ...decision.paper, pdfPath: join(root, `${decision.paper.arxivId}.pdf`) };
            } },
            buildManifest: (runId, jobs) => ({ runId, jobs }),
            parseOne: async job => { parsed.push(job.baseId); return { status: 'succeeded' }; },
            publishEvidence: async (runId, manifest) => ({ publicationId: `evidence-${runId}`, sourceCount: manifest.jobs.length, replayed: false }),
          }),
        });
        assert.equal(result.selected.length, expected);
        assert.equal(result.paperCount, expected);
        assert.equal(downloaded.length, expected);
        assert.deepEqual(parsed, downloaded);
        const start = progress.find(event => event.type === 'task-start');
        assert.ok(start);
        assert.equal(start.configuredLimit, expected);
        assert.equal(start.requestedLimit, expected);
        assert.equal(start.configPath, configPath);
      }
    }
  } finally {
    // Remove only this test's own temporary fixture, never production paths.
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await removeOwnedTestDirectory(root);
  }
});

for (const mode of ['current', 'weekly'] as const) test(`configured ${mode} replay preserves run/checkpoints and performs no download or parse`, async () => {
  const fixture = await makeRuntimeFixture();
  await configureLayeredRuntimeFixture(fixture);
  const downloaded: string[] = [];
  const parsed: string[] = [];
  const args = ['--mode', mode, '--from', '2026-08-01', '--to', '2026-08-02'];
  const signal = new AbortController().signal;
  const dbPath = loadEngineContext({ root: fixture.projectRoot }).paths.databasePath;
  const context: NonNullable<Parameters<typeof runConfiguredTask>[2]> = {
    signal,
    bootstrap: async () => {},
    harvest: (shards, window, options) => runHarvestShards(shards, window, {
      ...options, projectRoot: process.cwd(), onProgress: () => {}, sleep: async () => {},
      execFile: async (_file, args) => { assert.equal(options.signal, signal); return { stdout: JSON.stringify({
        schemaVersion: 1, dateMode: args[args.indexOf('--date-mode') + 1],
        papers: [{ baseId: '2608.90001', arxivId: '2608.90001v1', version: 1,
          title: 'Control flow graph for test generation', summary: '', authors: ['Fixture Author'], categories: ['cs.SE'],
          published: '2026-08-01', updated: '2026-08-01' }],
      }) }; },
    }),
    executeTask: (options, dependencies) => runTask(options, {
      ...dependencies, onProgress: () => {},
      policy: { evaluate: paper => ({ accepted: true, primaryTrack: 'AI-Program-Analysis-AST', paper }) },
      pdfStore: { download: async decision => {
        downloaded.push(decision.paper.baseId);
        return { ...decision.paper, pdfPath: join(fixture.paths.pdfRoot, 'fixture.pdf') };
      } },
      buildManifest: (runId, jobs, run) => ({ runId, jobs, window: { from: run.from, to: run.to } }),
      parseOne: async job => { parsed.push(job.baseId); return { status: 'succeeded' }; },
      publishEvidence: async (runId, manifest) => {
        // Use the real completion transition; only file publication is injected.
        const store = openStateStore(dbPath);
        try { store.completeRun(runId, 'running', manifest.window?.to ?? ''); } finally { store.close(); }
        return { publicationId: `evidence-${runId}`, sourceCount: manifest.jobs.length, replayed: false };
      },
    }),
  };
  try {
    const first = await runConfiguredTask(args, fixture.projectRoot, context);
    assert.equal(first.status, 'completed');
    assert.ok(first.runId);
    assert.deepEqual(downloaded, ['2608.90001']);
    assert.deepEqual(parsed, downloaded);
    const store = openStateStore(dbPath);
    let checkpoint;
    try {
      checkpoint = { keys: store.listCompletedHarvestShardKeys(first.runId), observations: store.listHarvestObservations(first.runId) };
      assert.ok(checkpoint.keys.length > 0);
      assert.ok(checkpoint.observations.length > 0);
    } finally { store.close(); }
    const manifestPath = join(fixture.paths.stateRoot, 'runs', first.runId, 'mineru-jobs.json');
    const manifestBytes = await readFile(manifestPath);
    const before = { downloads: downloaded.length, parses: parsed.length };
    const replay = await runConfiguredTask(args, fixture.projectRoot, context);
    assert.equal(replay.runId, first.runId);
    assert.equal(replay.status, 'completed');
    assert.equal(replay.replayed, true);
    assert.equal(downloaded.length, before.downloads);
    assert.equal(parsed.length, before.parses);
    assert.deepEqual(await readFile(manifestPath), manifestBytes);
    const reopened = openStateStore(dbPath);
    try {
      assert.deepEqual({ keys: reopened.listCompletedHarvestShardKeys(first.runId), observations: reopened.listHarvestObservations(first.runId) }, checkpoint);
    } finally { reopened.close(); }
  } finally { await fixture.dispose(); }
});

test('runConfiguredTask routes a two-paper parse manifest through the injected MinerU session', async () => {
  const fixture = await makeRuntimeFixture();
  await configureLayeredRuntimeFixture(fixture);
  const calls: string[] = [];
  const pdfA = join(fixture.root, '2608.91001v1.pdf');
  const pdfB = join(fixture.root, '2608.91002v1.pdf');
  const shaByBaseId = new Map<string, string>();
  const pdfByBaseId = new Map([
    ['2608.91001', pdfA],
    ['2608.91002', pdfB],
  ]);
  const mineruSession = {
    ensureReady: async () => 'http://127.0.0.1:17860',
    run: async (job: MinerUCliJob) => {
      calls.push(job.fileSource);
      await writeSessionArtifacts(job.outputDir, 'Configured Session');
      return {
        arxivId: job.arxivId,
        model: job.model,
        cliBackend: 'pipeline',
        exitCode: 0,
        errorCode: null,
        timedOut: false,
        timeoutMs: 1,
        signal: null,
        cleanupConfirmed: true,
        pid: null,
        activePids: [],
        outputDir: job.outputDir,
        elapsedMs: 1,
        stdoutSummary: '',
        stderrSummary: '',
        source: null,
      };
    },
    dispose: async () => {},
  };
  try {
    await createPdf(pdfA, 'Session One');
    await createPdf(pdfB, 'Session Two');
    shaByBaseId.set('2608.91001', createHash('sha256').update(await readFile(pdfA)).digest('hex'));
    shaByBaseId.set('2608.91002', createHash('sha256').update(await readFile(pdfB)).digest('hex'));
    assert.notEqual(shaByBaseId.get('2608.91001'), shaByBaseId.get('2608.91002'), 'two distinct papers need distinct PDF fixture bytes');
    const result = await runConfiguredTask(['--mode', 'current', '--limit', '2', '--from', '2026-08-01', '--to', '2026-08-02'], fixture.projectRoot, {
      mineruSession,
      bootstrap: async () => {},
      harvest: async () => [
        {
          baseId: '2608.91001', arxivId: '2608.91001v1', version: 1,
          title: 'Session One', summary: '', authors: ['Fixture Author'],
          published: '2026-08-01', updated: '2026-08-01', categories: ['cs.SE'],
          matchedTracks: ['AI-Program-Analysis-AST'],
        },
        {
          baseId: '2608.91002', arxivId: '2608.91002v1', version: 1,
          title: 'Session Two', summary: '', authors: ['Fixture Author'],
          published: '2026-08-01', updated: '2026-08-01', categories: ['cs.SE'],
          matchedTracks: ['AI-Program-Analysis-AST'],
        },
      ],
      executeTask: (options, dependencies) => runTask(options, {
        ...dependencies,
        onProgress: () => {},
        policy: { evaluate: paper => ({ accepted: true, primaryTrack: 'AI-Program-Analysis-AST', paper }) },
        pdfStore: {
          download: async (decision) => ({
            ...decision.paper,
            pdfPath: pdfByBaseId.get(decision.paper.baseId)!,
            sha256: shaByBaseId.get(decision.paper.baseId)!,
          }),
        },
        publishEvidence: async (runId, manifest) => {
          const store = openStateStore(loadEngineContext({ root: fixture.projectRoot }).paths.databasePath);
          try {
            store.completeRun(runId, 'running', manifest.window?.to ?? '');
          } finally {
            store.close();
          }
          return { publicationId: `evidence-${runId}`, sourceCount: manifest.jobs.length, replayed: false };
        },
      }),
    });
    assert.equal(result.status, 'completed');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(Boolean));
  } finally {
    await fixture.dispose();
  }
});
