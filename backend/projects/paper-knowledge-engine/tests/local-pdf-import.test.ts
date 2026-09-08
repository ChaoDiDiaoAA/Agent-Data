import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { routeImportLocal } from '../src/cli/routes.ts';
import { importLocalPdfs } from '../src/library/sources/local-pdf-import.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { verifyArchiveV2 } from '../src/shared/archive-v2.ts';
import { archiveContext } from './fixtures/library-paths.ts';
import type { MinerUCliJob } from '../src/types/jobs.ts';
import type { LibraryPaths } from '../src/shared/paths.ts';

async function writeSessionArtifacts(outputDir: string, title = 'Local evidence') {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'paper.md'), `# ${title}`);
  await writeFile(join(outputDir, 'paper_content_list.json'), '[{"page_idx":0,"text":"Local evidence"}]');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'local-import-'));
  const stateRoot = join(root, 'state'); const vaultRoot = join(root, 'vault'); const input = join(root, 'input');
  await Promise.all([mkdir(stateRoot), mkdir(vaultRoot), mkdir(input)]);
  const store = openStateStore(join(stateRoot, 'papers.sqlite'));
  const config = { ...archiveContext(stateRoot), stateRoot, vaultRoot, tempRoot: join(stateRoot, 'work'), outputRoot: join(stateRoot, 'archive'), model: 'pipeline', cliBackend: 'pipeline',
    maxConcurrency: 1, pipelineMethod: 'auto', pipelineLanguage: 'ch', formulaEnabled: true, tableEnabled: true,
    expectedVersion: '3.4.5', expectedCommit: '4fe4bde114a23ee5dd637eae99b767f4669bf58c',
    localImport: { recursive: true, maxFiles: 10, maxPdfPages: 20, maxPdfSizeMb: 20, defaultTrack: 'Local-PDF' } };
  const paths: LibraryPaths = {
    dataRoot: stateRoot,
    databasePath: join(stateRoot, 'library.sqlite'),
    archiveRoot: config.outputRoot,
    runsRoot: join(stateRoot, 'runs'),
    operationsRoot: join(stateRoot, 'operations'),
    workRoot: config.tempRoot,
    backupRoot: join(root, 'backups'),
    vaultRoot,
  };
  const pdf = join(input, 'paper.pdf'); const document = await PDFDocument.create(); document.setTitle('Local paper'); document.addPage();
  await writeFile(pdf, await document.save());
  const runner = async (job: { outputDir?: string }) => {
    assert.ok(job.outputDir); const raw = join(job.outputDir, 'raw'); await mkdir(raw, { recursive: true });
    await writeFile(join(raw, 'paper.md'), '# Local evidence');
    await writeFile(join(raw, 'paper_content_list.json'), '[{"page_idx":0,"text":"Local evidence"}]');
    return { exitCode: 0 };
  };
  return { root, stateRoot, vaultRoot, paths, store, config, pdf, runner };
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

test('local import verifies an Archive, publishes Evidence, and is idempotently completed', async () => {
  const f = await fixture();
  try {
    const context = { root: f.root, config: f.config, paths: f.paths, stateStore: f.store, runner: f.runner,
      processContext: { safetyRoot: join(f.stateRoot, 'locks', 'processes'), policy: { processCleanupTimeoutMs: 1800, diagnosticTimeoutMs: 5000, maxOutputBytes: 16384 } } };
    const first = await routeImportLocal(['--path', f.pdf], context);
    assert.equal(first.status, 'completed'); assert.ok('runId' in first);
    const firstRunId = first.runId; assert.ok(firstRunId);
    assert.equal(f.store.getRun(firstRunId)?.status, 'completed');
    const [paper] = f.store.exportManifest(); const attempt = f.store.findSuccessfulParse(paper.base_id, 'pipeline');
    assert.ok(attempt?.outputDir);
    const archive = await verifyArchiveV2(attempt.outputDir);
    assert.equal(archive.manifest.sourceKind, 'local_pdf');
    assert.ok(await readFile(join(f.stateRoot, 'runs', firstRunId, 'evidence', 'publication.json')));
    const paperId = `${paper.base_id}-v${archive.manifest.version}`;
    const paperRoot = join(f.vaultRoot, 'Evidence', 'papers', paperId);
    assert.deepEqual(await readdir(f.vaultRoot), ['Evidence']);
    assert.deepEqual((await readdir(join(f.vaultRoot, 'Evidence'))).sort(), ['indexes', 'papers']);
    assert.deepEqual(await readdir(join(f.vaultRoot, 'Evidence', 'papers')), [paperId]);
    assert.deepEqual((await readdir(paperRoot)).sort(), ['pages.md', 'paper.md', 'source.pdf']);
    assert.match(await readFile(join(paperRoot, 'paper.md'), 'utf8'), /# Local evidence/);
    assert.match(await readFile(join(paperRoot, 'pages.md'), 'utf8'), /Local evidence/);
    assert.deepEqual(await readFile(join(paperRoot, 'source.pdf')), await readFile(f.pdf));
    const indexesRoot = join(f.vaultRoot, 'Evidence', 'indexes');
    assert.deepEqual((await readdir(indexesRoot)).sort(), ['authors.md', 'categories.md', 'tracks.md', 'years.md']);
    assert.match(await readFile(join(indexesRoot, 'tracks.md'), 'utf8'), new RegExp(`Evidence/papers/${paperId}/paper`));
    const second = await routeImportLocal(['--path', f.pdf], context);
    assert.equal(second.status, 'completed'); assert.ok('runId' in second); assert.equal(second.runId, firstRunId); assert.equal(second.replayed, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('local import delegates publication to the service and leaves publication files untouched on reservation rejection', async () => {
  const f = await fixture();
  let rejectedRunId: string | undefined;
  let reservationCalls = 0;
  const rejectingStore = new Proxy(f.store, {
    get(target, property, receiver) {
      if (property === 'reserveEvidencePublication') return (input: { runId: string }) => {
        reservationCalls += 1;
        rejectedRunId = input.runId;
        throw new Error('EVIDENCE_CONFLICT: reservation rejected');
      };
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await rm(f.vaultRoot, { recursive: true });
    assert.equal(await pathExists(join(f.config.tempRoot, 'evidence-publications')), false);
    const context = {
      root: f.root,
      config: f.config,
      paths: f.paths,
      stateStore: rejectingStore,
      runner: f.runner,
      processContext: { safetyRoot: join(f.stateRoot, 'locks', 'processes'), policy: { processCleanupTimeoutMs: 1800, diagnosticTimeoutMs: 5000, maxOutputBytes: 16384 } },
    };

    await assert.rejects(routeImportLocal(['--path', f.pdf], context), /EVIDENCE_CONFLICT: reservation rejected/);
    assert.equal(reservationCalls, 1);
    assert.ok(rejectedRunId);
    assert.equal(f.store.getRun(rejectedRunId)?.status, 'failed');
    await assert.rejects(readFile(join(f.stateRoot, 'runs', rejectedRunId, 'evidence', 'publication.json')), { code: 'ENOENT' });
    assert.equal(await pathExists(f.vaultRoot), false);
    assert.equal(await pathExists(join(f.config.tempRoot, 'evidence-publications')), false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('a completed local publication ignores a throwing completion observer and stays completed', async () => {
  const f = await fixture();
  try {
    const result = await routeImportLocal(['--path', f.pdf], {
      root: f.root,
      config: f.config,
      paths: f.paths,
      stateStore: f.store,
      runner: f.runner,
      processContext: { safetyRoot: join(f.stateRoot, 'locks', 'processes'), policy: { processCleanupTimeoutMs: 1800, diagnosticTimeoutMs: 5000, maxOutputBytes: 16384 } },
      onProgress: event => {
        if (event.type === 'evidence-publish-complete') throw new Error('observer failed after completion');
      },
    });

    assert.equal(result.status, 'completed');
    assert.ok('runId' in result && result.runId);
    assert.equal(f.store.getRun(result.runId)?.status, 'completed');
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('local publication start observer failure cannot prevent the real service from completing', async () => {
  const f = await fixture();
  try {
    const result = await routeImportLocal(['--path', f.pdf], {
      root: f.root,
      config: f.config,
      paths: f.paths,
      stateStore: f.store,
      runner: f.runner,
      processContext: { safetyRoot: join(f.stateRoot, 'locks', 'processes'), policy: { processCleanupTimeoutMs: 1800, diagnosticTimeoutMs: 5000, maxOutputBytes: 16384 } },
      onProgress: event => {
        if (event.type === 'evidence-publish-start') throw new Error('start observer failed');
      },
    });

    assert.equal(result.status, 'completed');
    assert.ok('runId' in result && result.runId);
    assert.equal(f.store.getRun(result.runId)?.status, 'completed');
    assert.ok(await readFile(join(f.stateRoot, 'runs', result.runId, 'evidence', 'publication.json')));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('local publication start observer failure does not hide the service error', async () => {
  const f = await fixture();
  const serviceError = new Error('EVIDENCE_CONFLICT: local service failed');
  let reservationCalls = 0;
  let runId: string | undefined;
  const rejectingStore = new Proxy(f.store, {
    get(target, property, receiver) {
      if (property === 'reserveEvidencePublication') return (input: { runId: string }) => {
        reservationCalls += 1;
        runId = input.runId;
        throw serviceError;
      };
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await assert.rejects(() => routeImportLocal(['--path', f.pdf], {
      root: f.root,
      config: f.config,
      paths: f.paths,
      stateStore: rejectingStore,
      runner: f.runner,
      processContext: { safetyRoot: join(f.stateRoot, 'locks', 'processes'), policy: { processCleanupTimeoutMs: 1800, diagnosticTimeoutMs: 5000, maxOutputBytes: 16384 } },
      onProgress: event => {
        if (event.type === 'evidence-publish-start') throw new Error('start observer failed');
      },
    }), error => error === serviceError);

    assert.equal(reservationCalls, 1);
    assert.ok(runId);
    assert.equal(f.store.getRun(runId)?.status, 'failed');
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('local import retains a failed parse for safe retry', async () => {
  const f = await fixture();
  try {
    const context = { root: f.root, config: f.config, paths: f.paths, stateStore: f.store,
      processContext: { safetyRoot: join(f.stateRoot, 'locks', 'processes'), policy: { processCleanupTimeoutMs: 1800, diagnosticTimeoutMs: 5000, maxOutputBytes: 16384 } } };
    const failed = await routeImportLocal(['--path', f.pdf], { ...context, runner: async () => ({ exitCode: 1, stderrSummary: 'retry' }) });
    assert.equal(failed.status, 'failed'); assert.ok('runId' in failed);
    const failedRunId = failed.runId; assert.ok(failedRunId);
    const recovered = await routeImportLocal(['--path', f.pdf], { ...context, runner: f.runner });
    assert.equal(recovered.status, 'completed'); assert.ok('runId' in recovered); assert.equal(recovered.runId, failedRunId);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('persisting a local parse manifest keeps the new import run running', async () => {
  const f = await fixture();
  try {
    const run = f.store.startLocalImportRun('manifest-status');
    f.store.recordLocalParseManifest(run.id, { jobs: [] });
    assert.equal(f.store.getRun(run.id)?.status, 'running');
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('routeImportLocal uses the injected MinerU session runner', async () => {
  const f = await fixture();
  const calls: string[] = [];
  const mineruSession = {
    ensureReady: async () => 'http://127.0.0.1:17860',
    run: async (job: MinerUCliJob) => {
      calls.push(job.fileSource);
      await writeSessionArtifacts(job.outputDir, 'Import Session');
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
    const result = await routeImportLocal(['--path', f.pdf], {
      root: f.root,
      paths: f.paths,
      config: {
        stateRoot: f.stateRoot,
        vaultRoot: f.vaultRoot,
        ...archiveContext(f.stateRoot), outputRoot: join(f.stateRoot, 'archive'),
        model: 'pipeline',
        cliBackend: 'pipeline',
        localImport: f.config.localImport,
      },
      stateStore: f.store,
      mineruSession,
    });
    assert.equal(result.status, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0], 'string');
    assert.ok(calls[0]);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('local import writes task artifacts only under the explicit library runs root', async () => {
  const f = await fixture();
  const dataRoot = join(f.root, 'library');
  const paths: LibraryPaths = {
    dataRoot,
    databasePath: join(dataRoot, 'library.sqlite'),
    archiveRoot: f.config.outputRoot,
    runsRoot: join(dataRoot, 'runs'),
    operationsRoot: join(dataRoot, 'operations'),
    workRoot: join(dataRoot, 'work'),
    backupRoot: join(f.root, 'backups'),
    vaultRoot: f.vaultRoot,
  };
  try {
    const result = await importLocalPdfs({ files: [f.pdf] }, {
      config: f.config,
      paths,
      store: f.store,
      runner: async () => ({ exitCode: 1, stderrSummary: 'expected failure' }),
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.runId);
    assert.ok(await readFile(join(paths.runsRoot, result.runId, 'mineru-jobs.json')));
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
