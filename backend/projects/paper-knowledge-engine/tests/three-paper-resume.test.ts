import test from 'node:test';
import { archiveContext, archiveTestPdf } from './fixtures/library-paths.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { openStateStore, type StateStore } from '../src/library/state/state-store.ts';
import { runTask } from '../src/library/pipeline.ts';
import { loadConfig } from '../src/shared/config.ts';
import { runLocalParse } from '../src/mineru/mineru-local-jobs.ts';
import { archiveFileManifest } from '../src/shared/manifest.ts';
import { canonicalJson } from '../src/evidence/contracts.ts';
import { readVerifiedRunSources } from '../src/evidence/archive-reader.ts';
import { publishEvidence } from '../src/evidence/publisher.ts';
import { admitOperation, resumeOperation } from '../src/library/operations/operation-store.ts';
import { executeOperation } from '../src/library/workflow.ts';
import type { TaskParseJob, TaskParseManifest } from '../src/types/jobs.ts';

const hash = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
const window = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' };

type ResumeJob = TaskParseJob & {
  version: number;
  sha256: string;
  model: string;
  cliBackend: string;
  pdfPath: string;
  fileSource: string;
  outputDir: string;
};

function requireResumeJob(job: TaskParseJob): ResumeJob {
  assert.equal(typeof job.version, 'number');
  for (const value of [job.sha256, job.model, job.cliBackend, job.pdfPath, job.fileSource, job.outputDir]) {
    assert.equal(typeof value, 'string');
  }
  return job as ResumeJob;
}

interface ResumeFixture {
  runtime: Awaited<ReturnType<typeof makeRuntimeFixture>>;
  store: StateStore;
  runId: string;
  jobs: ResumeJob[];
  close(): Promise<void>;
}

async function completeArchive(store: StateStore, stateRoot: string, job: ResumeJob): Promise<string> {
  const attempt = store.reserveParseAttempt(job);
  assert.ok(attempt);
  store.startParseAttempt(attempt.attemptId);
  const archiveRoot = String(job.outputDir);
  await mkdir(join(archiveRoot, 'normalized'), { recursive: true });
  await mkdir(join(archiveRoot, 'pdf'), { recursive: true });
  await writeFile(join(archiveRoot, 'normalized', 'full.md'), `# ${job.title}\n\nArchive ${job.baseId}\n`);
  await writeFile(join(archiveRoot, 'normalized', 'page-marked.txt'), `--- PAGE 1 ---\nArchive ${job.baseId}\n`);
  await writeFile(join(archiveRoot, 'normalized', 'pages.json'), JSON.stringify([{ page: 1, text: `Archive ${job.baseId}` }]));
  await writeFile(join(archiveRoot, 'normalized', 'content-list.json'), '[]');
  await writeFile(join(archiveRoot, 'pdf', `${job.sha256}.pdf`), await readFile(String(job.pdfPath)));
  const source = {
    schemaVersion: 1,
    baseId: job.baseId,
    arxivId: job.arxivId,
    version: job.version,
    title: job.title,
    authors: job.authors,
    categories: job.categories,
    matchedTracks: job.matchedTracks,
    published: job.published,
    updated: job.updated,
    pdfPath: `pdf/${job.sha256}.pdf`,
    pdfSha256: job.sha256,
    parseAttemptId: attempt.attemptId,
    model: job.model,
    cliBackend: job.cliBackend,
    method: job.method ?? 'auto',
    pageCount: 1,
    normalized: {
      fullMarkdown: 'normalized/full.md',
      pageMarkedText: 'normalized/page-marked.txt',
      pages: 'normalized/pages.json',
      contentList: 'normalized/content-list.json',
    },
    files: await archiveFileManifest(archiveRoot),
  };
  await writeFile(join(archiveRoot, 'source.json'), canonicalJson(source));
  store.finishParseAttempt(attempt.attemptId, {
    outputDir: archiveRoot,
    markdownPath: join(archiveRoot, 'normalized', 'full.md'),
    contentListPath: join(archiveRoot, 'normalized', 'content-list.json'),
    pageTextPath: join(archiveRoot, 'normalized', 'page-marked.txt'),
    pageCount: 1,
    elapsedMs: 1,
    exitCode: 0,
  });
  store.markParsedStatus(job.baseId);
  return attempt.attemptId;
}

async function resumeFixture(): Promise<ResumeFixture> {
  const runtime = await makeRuntimeFixture();
  const store = openStateStore(join(runtime.paths.stateRoot, 'papers.sqlite'));
  const run = store.startRun(window, 'current');
  const ids = ['2608.10001', '2608.10002', '2608.10003'];
  const jobs: ResumeJob[] = [];
  for (const [index, baseId] of ids.entries()) {
    const pdf = await archiveTestPdf(baseId);
    const sha256 = hash(pdf);
    const pdfPath = join(runtime.paths.pdfRoot, `${baseId}v1.pdf`);
    await writeFile(pdfPath, pdf);
    const paper = {
      baseId,
      arxivId: `${baseId}v1`,
      version: 1,
      title: `Paper ${index + 1}`,
      summary: `Summary ${index + 1}`,
      authors: [`Author ${index + 1}`],
      categories: ['cs.SE'],
      matchedTracks: ['AI-FSD'],
      primaryTrack: 'AI-FSD',
      published: '2026-08-01T00:00:00Z',
      updated: '2026-08-02T00:00:00Z',
      status: 'discovered',
    };
    store.upsertDiscovered(paper);
    store.markDownloaded(baseId, pdfPath, 'AI-FSD', sha256, 1);
    jobs.push({
      ...archiveContext(runtime.paths.stateRoot),
      ...paper,
      status: 'downloaded',
      sha256,
      pdfPath,
      fileSource: pdfPath,
      outputDir: index === 0 ? join(runtime.paths.stateRoot, 'extracted', `p-${baseId}`) : join(runtime.paths.stateRoot, 'archive', `${baseId}-v1`),
      pageCount: 1,
      model: 'pipeline',
      cliBackend: 'pipeline',
      method: 'auto',
    });
  }

  const runRoot = join(runtime.paths.stateRoot, 'runs', run.id);
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(runRoot, 'selection-manifest.json'), canonicalJson({
    schemaVersion: 1,
    runId: run.id,
    mode: 'current',
    window,
    requestedLimit: 3,
    evaluatedCount: 3,
    acceptedCount: 3,
    existingCount: 0,
    newCandidateCount: 3,
    selected: jobs.map(job => ({ accepted: true, primaryTrack: 'AI-FSD', selectionReason: 'quota', paper: job })),
  }));
  const manifest: TaskParseManifest = { runId: run.id, window, jobs };
  await writeFile(join(runRoot, 'mineru-jobs.json'), canonicalJson(manifest));

  await completeArchive(store, runtime.paths.stateRoot, jobs[0]);
  const failed = store.reserveParseAttempt(jobs[1]);
  assert.ok(failed);
  store.startParseAttempt(failed.attemptId);
  store.failParseAttempt(failed.attemptId, { errorClass: 'process_error', errorMessage: 'interrupted' });
  store.markParseFailed(jobs[1].baseId, 'process_error');
  store.failRun(run.id, 'interrupted during paper B');

  return {
    runtime,
    store,
    runId: run.id,
    jobs,
    async close() {
      store.close();
      await runtime.dispose();
    },
  };
}

function taskDependencies(
  value: ResumeFixture,
  parseOne: Parameters<typeof runTask>[1]['parseOne'],
  publish: Parameters<typeof runTask>[1]['publishEvidence'],
): Parameters<typeof runTask>[1] {
  return {
    config: loadConfig({ root: value.runtime.projectRoot }),
    store: value.store,
    lockPath: join(value.runtime.paths.stateRoot, 'locks', 'paper-sync.lock'),
    runRoot: join(value.runtime.paths.stateRoot, 'runs'),
    bootstrap: async () => {},
    discovery: { harvest: async () => assert.fail('resume with mineru-jobs.json must not rediscover') },
    policy: { evaluate: () => assert.fail('resume with a fixed selection must not re-evaluate policy') },
    pdfStore: { download: async () => assert.fail('resume with mineru-jobs.json must not download') },
    readManifest: undefined,
    writeManifest: async () => assert.fail('resume must not rewrite frozen manifests'),
    buildManifest: async () => assert.fail('resume must not rebuild the parse manifest'),
    parseOne,
    publishEvidence: publish,
  };
}

async function parseThroughProductionBoundary(value: ResumeFixture, job: TaskParseJob, mineruOrder: string[]) {
  return runLocalParse(requireResumeJob(job), {
    store: value.store,
    runner: async (parseJob) => {
      mineruOrder.push(parseJob.baseId);
      await writeFile(join(String(parseJob.outputDir), 'paper.md'), `# ${parseJob.title}\n\nParsed ${parseJob.baseId}\n`);
      await writeFile(join(String(parseJob.outputDir), 'paper_content_list.json'), JSON.stringify([
        { page_idx: 0, type: 'text', text: `Parsed ${parseJob.baseId}` },
      ]));
      return { exitCode: 0, elapsedMs: 1, cleanupConfirmed: true };
    },
    assessExtraction: () => ({ accepted: true }),
  });
}

test('three-paper real-state resume reuses A and parses only B/C before publishing all sources', async () => {
  const value = await resumeFixture();
  try {
    const mineruOrder: string[] = [];
    let publications = 0;
    const result = await runTask({ mode: 'current', now: '2026-09-04T00:00:00Z', limit: 3, resumeRunId: value.runId }, taskDependencies(
      value,
      async (job: TaskParseJob) => parseThroughProductionBoundary(value, job, mineruOrder),
      async (runId: string, manifest: TaskParseManifest) => {
        publications++;
        const sources = await readVerifiedRunSources({ runId, stateRoot: value.runtime.paths.stateRoot, store: value.store });
        assert.deepEqual(sources.map(source => source.source.baseId), value.jobs.map(job => job.baseId));
        const publication = await publishEvidence({
          runId,
          stateRoot: value.runtime.paths.stateRoot,
          tempRoot: value.runtime.paths.tempRoot,
          vaultRoot: value.runtime.paths.vaultRoot,
          sources,
        });
        const receiptPath = join(value.runtime.paths.stateRoot, 'runs', runId, 'evidence', 'publication.json');
        value.store.reserveEvidencePublication({ runId, publicationId: publication.receipt.publicationId, inputSha256: publication.receipt.contentSha256 });
        value.store.completeEvidencePublication({
          runId,
          publicationId: publication.receipt.publicationId,
          receiptPath,
          receiptSha256: hash(await readFile(receiptPath)),
          lastSuccess: String(manifest.window?.to),
        });
        return { publicationId: publication.receipt.publicationId, sourceCount: sources.length, replayed: false };
      },
    ));

    assert.equal(result.status, 'completed');
    assert.equal(result.runId, value.runId);
    assert.deepEqual(mineruOrder, [value.jobs[1].baseId, value.jobs[2].baseId]);
    assert.equal(publications, 1);
    assert.equal(value.store.getRun(value.runId)?.status, 'completed');
    for (const job of value.jobs) {
      assert.equal(await Bun.file(join(value.runtime.paths.vaultRoot, 'Evidence', 'papers', `${job.baseId}-v${job.version}`, 'paper.md')).exists(), true);
    }
  } finally {
    await value.close();
  }
});

test('a repeated B failure publishes nothing and leaves the operation resumable', async () => {
  const value = await resumeFixture();
  try {
    const mineruOrder: string[] = [];
    let publications = 0;
    const { job } = await admitOperation({
      operationsRoot: value.runtime.paths.stateRoot,
      root: value.runtime.projectRoot,
      request: { libraryId: 'fsd', requestId: randomUUID(), operation: { kind: 'current', limit: 3 } },
    });
    const initial = await executeOperation({ root: value.runtime.projectRoot, jobId: job.jobId }, {
      operationsRoot: value.runtime.paths.stateRoot,
      dataRoot: value.runtime.paths.stateRoot,
      mineruSession: { async ensureReady() { return 'http://127.0.0.1:17860'; }, async run() { return {} as any; }, async dispose() {} },
      runTask: async (_operation, context) => {
        context.onProgress({ type: 'task-start', runId: value.runId });
        return { status: 'failed', runId: value.runId, errorClass: 'process_error' };
      },
    });
    assert.equal(initial.status, 'failed');
    assert.equal(initial.runId, value.runId);
    await resumeOperation({
      operationsRoot: value.runtime.paths.stateRoot,
      root: value.runtime.projectRoot,
      jobId: job.jobId,
      requestId: randomUUID(),
    });
    const result = await executeOperation({ root: value.runtime.projectRoot, jobId: job.jobId }, {
      operationsRoot: value.runtime.paths.stateRoot,
      dataRoot: value.runtime.paths.stateRoot,
      mineruSession: { async ensureReady() { return 'http://127.0.0.1:17860'; }, async run() { return {} as any; }, async dispose() {} },
      runTask: async (operation, context) => {
        assert.equal(context.resumeRunId, value.runId);
        return runTask({
          mode: operation.kind,
          now: '2026-09-04T00:00:00Z',
          limit: operation.kind === 'current' ? operation.limit : undefined,
          resumeRunId: context.resumeRunId,
          jobId: context.jobId,
        }, {
          ...taskDependencies(value, async (parseJob: TaskParseJob) => runLocalParse(requireResumeJob(parseJob), {
            store: value.store,
            runner: async (job) => {
              mineruOrder.push(job.baseId);
              return { exitCode: 1, stderrSummary: 'failed again', cleanupConfirmed: true };
            },
          }), async () => {
            publications++;
            throw new Error('failed resume must not publish');
          }),
          onProgress: context.onProgress,
        });
      },
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.canResume, true);
    assert.deepEqual(mineruOrder, [value.jobs[1].baseId]);
    assert.equal(publications, 0);
    assert.equal(value.store.getRun(value.runId)?.status, 'failed');
  } finally {
    await value.close();
  }
});
