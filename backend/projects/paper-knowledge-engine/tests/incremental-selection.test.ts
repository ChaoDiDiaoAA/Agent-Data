import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { openStateStore } from '../src/library/state/state-store.ts';
import { runTask } from '../src/library/pipeline.ts';
import { evaluateCandidate } from '../src/library/selection/paper-policy.ts';
import { loadPaperPolicy } from '../src/shared/config.ts';
import { downloadAcceptedPdf } from '../src/library/sources/pdf-store.ts';
import { writeLocalParseManifest } from '../src/mineru/mineru-local-jobs.ts';
import { validateTaskSelection } from '../src/library/state/task-artifacts.ts';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { createProcessContext } from '../src/runtime/process.ts';
import type { CandidateDecision, PaperMetadata, PaperIdentity } from '../src/types/papers.ts';
import type { ProgressEvent, RunIdentity, TaskMode } from '../src/types/jobs.ts';

type FixturePaper = PaperMetadata & PaperIdentity & { pdfUrl: string };
type DownloadedPaper = FixturePaper & { pdfPath: string };
type FixtureManifest = { runId: string; window: { from: string; to: string }; jobs: (DownloadedPaper & { model: string; cliBackend: string; method: string })[] };

function present<T>(value: T | null | undefined): T { assert.ok(value != null); return value; }

const rules = loadPaperPolicy('config/fsd/paper-policy.yaml');

test('selection checkpoint validates identity and track field types before recovery', () => {
  const run = { id: 'run', from: '2026-01-01', to: '2026-08-01' };
  for (const selected of [
    [{ accepted: true, primaryTrack: 42, paper: { baseId: 'p' } }],
    [{ accepted: true, primaryTrack: 'A', paper: { baseId: 42 } }],
    [{ accepted: true, primaryTrack: 'A', paper: { baseId: 'p', version: '1' } }],
  ]) {
    const checkpoint = { schemaVersion: 1, runId: run.id, mode: 'current', window: { from: run.from, to: run.to }, requestedLimit: 2, selected };
    assert.throws(() => validateTaskSelection(checkpoint, run, 'current'), /invalid task selection checkpoint/);
  }
});
const makePaper = (number: number, version = 1) => ({
  baseId: `2608.1000${number}`, arxivId: `2608.1000${number}v${version}`, version,
  title: 'LLM for test generation', summary: '', published: '2026-08-01', updated: '2026-08-01',
  authors: ['Fixture Author'], categories: ['cs.SE'],
  matchedTracks: ['AI-TDD'], pdfUrl: `https://arxiv.org/pdf/2608.1000${number}v${version}`,
});

async function fixture(t: TestContext) {
  const fx = await makeRuntimeFixture();
  const root = fx.root;
  const database = join(root, 'state.sqlite');
  let store = openStateStore(database);
  t.after(async () => { store.close(); await fx.dispose(); });
  const requests: string[] = [];
  const bodies = new Map<string, Uint8Array>();
  const progress: ProgressEvent[] = [];
  const f: { root: string; requests: string[]; progress: ProgressEvent[]; papers: FixturePaper[]; failDownload: string | null; failParse: boolean } = {
    root, requests, progress, papers: [1, 2, 3, 4, 5].map(n => makePaper(n)), failDownload: null, failParse: false };
  const fetchFixture = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(present(url.split('/').at(-1)));
    if (url.endsWith(f.failDownload ?? '__never__')) throw new Error('fixture download failed');
    if (!bodies.has(url)) {
      const pdf = await PDFDocument.create();
      pdf.setTitle(url); pdf.addPage();
      bodies.set(url, await pdf.save());
    }
    return new Response(new Uint8Array(present(bodies.get(url))), { status: 200, headers: { 'content-type': 'application/pdf' } });
  };
  const pdfOptions = {
    pdfRoot: join(root, 'pdf'), tempRoot: join(root, 'tmp'),
    categories: { 'AI-TDD': { pdf: 'tests' } },
    processContext: createProcessContext(fx.projectRoot), signal: undefined,
    fetchImpl: Object.assign(fetchFixture, { preconnect: () => {} }),
  };
  const dependencies = {
    config: { startDate: '2026-01-01', overlapHours: 48,
      currentTask: { maxPapers: 2, trackLimits: { 'AI-TDD': 2 } }, weeklySchedule: { enabled: true, maxPapers: 2 } },
    store, runRoot: join(root, 'runs'), lockPath: join(root, 'run.lock'), bootstrap: async () => {},
    onProgress: (event: ProgressEvent) => progress.push(event),
    discovery: { harvest: async ({ run }: { run: RunIdentity }) => {
      const shard = { runId: run.id, shardKey: 'fixture', shardIndex: 1, totalShards: 1, track: 'AI-TDD', dateMode: 'submitted', query: 'all:test', categories: ['cs.SE'] };
      if (store.beginHarvestShard(shard)) store.completeHarvestShard(shard, f.papers);
      return f.papers;
    } },
    policy: { evaluate: (paper: FixturePaper) => evaluateCandidate(paper, rules) },
    pdfStore: { download: (decision: CandidateDecision<FixturePaper>) => downloadAcceptedPdf(decision, { ...pdfOptions, stateStore: store }) },
    buildManifest: (runId: string, papers: DownloadedPaper[], run: RunIdentity): FixtureManifest => ({ runId, window: { from: run.from, to: run.to },
      jobs: papers.map(paper => ({ ...paper, model: 'pipeline', cliBackend: 'pipeline', method: 'auto' })) }),
    writeManifest: writeLocalParseManifest,
    parseOne: async () => {
      if (f.failParse) throw new Error('fixture parse failed');
      return { status: 'succeeded' as const };
    },
    publishEvidence: async (runId: string, manifest: FixtureManifest) => {
      const status = present(store.getRun(runId)).status;
      store.completeRun(runId, status, manifest.window.to);
      return { publicationId: `evidence-${runId}`, sourceCount: manifest.jobs.length, replayed: false };
    },
  };
  return Object.assign(f, {
    dependencies,
    getStore: () => store,
    reopen: () => { store.close(); store = openStateStore(database); dependencies.store = store; },
    seed: async (paper: FixturePaper) => {
      store.upsertDiscovered(paper);
      return downloadAcceptedPdf(evaluateCandidate(paper, rules), { ...pdfOptions, stateStore: store });
    },
    run: (mode: TaskMode = 'current') => runTask({ mode, now: '2026-08-30T00:00:00Z' }, dependencies),
  });
}

for (const mode of ['current', 'weekly'] as const) test(`${mode} skips a library PDF before quotas and fills with new papers`, async t => {
  const f = await fixture(t);
  await f.seed(makePaper(5));
  f.getStore().markParsedStatus('2608.10005');
  f.requests.length = 0;
  const result = await f.run(mode);
  assert.deepEqual(result.selected.map((item: CandidateDecision) => item.paper.baseId), ['2608.10004', '2608.10003']);
  assert.deepEqual(f.requests, ['2608.10004v1', '2608.10003v1']);
  assert.equal(present(f.getStore().findByBaseId('2608.10005')).status, 'parsed');
  const selection = present(f.progress.find(event => event.type === 'selection-complete'));
  assert.equal(selection.acceptedCount, 5);
  assert.equal(selection.existingCount, 1);
  assert.equal(selection.newCandidateCount, 4);
});

test('an entirely existing library creates an empty run without downloading or parsing', async t => {
  const f = await fixture(t);
  for (const paper of f.papers) await f.seed(paper);
  f.requests.length = 0;
  f.dependencies.parseOne = async () => { throw new Error('existing library must not be parsed'); };
  const result = await f.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.paperCount, 0);
  assert.deepEqual(f.requests, []);
  assert.equal(f.getStore().getLastSuccess(), result.window.to);
});

test('missing or corrupt PDFs are repair candidates instead of false duplicates', async t => {
  const f = await fixture(t);
  const missing = await f.seed(makePaper(5));
  const corrupt = await f.seed(makePaper(4));
  await rm(missing.pdfPath);
  await writeFile(corrupt.pdfPath, '%PDF-damaged');
  f.requests.length = 0;
  const result = await f.run();
  assert.deepEqual(result.selected.map((item: CandidateDecision) => item.paper.baseId), ['2608.10005', '2608.10004']);
  assert.deepEqual(f.requests, ['2608.10005v1', '2608.10004v1']);
  assert.equal((await PDFDocument.load(await readFile(missing.pdfPath))).getPageCount(), 1);
  assert.equal((await PDFDocument.load(await readFile(corrupt.pdfPath))).getPageCount(), 1);
});

test('a verified newer library version also removes an older candidate from quotas', async t => {
  const f = await fixture(t);
  await f.seed(makePaper(5, 2));
  const result = await f.run();
  assert.deepEqual(result.selected.map((item: CandidateDecision) => item.paper.baseId), ['2608.10004', '2608.10003']);
  assert.equal(present(f.getStore().findByBaseId('2608.10005')).downloaded_version, 2);
});

test('a newly discovered version remains eligible even when an older PDF is present', async t => {
  const f = await fixture(t);
  await f.seed(makePaper(5));
  f.papers[4] = makePaper(5, 2);
  f.requests.length = 0;
  const result = await f.run();
  assert.equal(result.selected[0].paper.arxivId, '2608.10005v2');
  assert.equal(present(f.getStore().findByBaseId('2608.10005')).downloaded_version, 2);
  assert.deepEqual(f.requests, ['2608.10005v2', '2608.10004v1']);
});

test('a failed download resumes its persisted selection after reopening without replacing its own PDFs', async t => {
  const f = await fixture(t);
  f.failDownload = '2608.10004v1';
  await assert.rejects(f.run(), /download failed/);
  const run = f.getStore().listRunsByStatus('failed')[0];
  assert.equal(f.getStore().getLastSuccess(), null);
  assert.equal(present(f.getStore().findByBaseId('2608.10005')).downloaded_version, 1);
  f.reopen();
  f.failDownload = null;
  f.requests.length = 0;
  f.dependencies.discovery.harvest = async () => { throw new Error('persisted selection must not harvest again'); };
  const result = await f.run();
  assert.equal(result.runId, run.run_id);
  assert.deepEqual(result.selected.map((item: CandidateDecision) => item.paper.baseId), ['2608.10005', '2608.10004']);
  assert.deepEqual(f.requests, ['2608.10004v1']);
  const manifest: FixtureManifest = JSON.parse(await readFile(join(f.root, 'runs', run.run_id, 'mineru-jobs.json'), 'utf8'));
  assert.deepEqual(manifest.jobs.map(paper => paper.baseId), ['2608.10005', '2608.10004']);
});

test('a failed parse resumes its existing manifest without discovery or PDF selection', async t => {
  const f = await fixture(t);
  f.failParse = true;
  await assert.rejects(f.run(), /parse failed/);
  const run = f.getStore().listRunsByStatus('failed')[0];
  f.reopen();
  f.failParse = false;
  f.dependencies.discovery.harvest = async () => { throw new Error('parse recovery must not harvest'); };
  f.dependencies.pdfStore.download = async () => { throw new Error('parse recovery must not download'); };
  const result = await f.run();
  assert.equal(result.runId, run.run_id);
  assert.equal(result.paperCount, 2);
  assert.equal(result.status, 'completed');
});

test('a legacy parse manifest with no selection snapshot remains resumable', async t => {
  const f = await fixture(t);
  const run = f.getStore().startRun({ from: '2026-01-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' }, 'current');
  await f.dependencies.discovery.harvest({ run });
  const pdf = await f.seed(makePaper(5));
  const manifest = f.dependencies.buildManifest(run.id, [pdf], run);
  await writeLocalParseManifest(join(f.root, 'runs', run.id, 'mineru-jobs.json'), manifest);
  f.getStore().recordLocalParseManifest(run.id, manifest);
  f.dependencies.discovery.harvest = async () => { throw new Error('legacy parse recovery must not harvest'); };
  f.dependencies.pdfStore.download = async () => { throw new Error('legacy parse recovery must not download'); };
  const result = await f.run();
  assert.equal(result.runId, run.id);
  assert.equal(result.paperCount, 1);
  assert.equal(result.status, 'completed');
});

test('a later new run cannot select the PDFs downloaded by an earlier run', async t => {
  const f = await fixture(t);
  const first = await f.run();
  const second = await runTask({ mode: 'current', now: '2026-08-31T00:00:00Z' }, f.dependencies);
  assert.notEqual(first.runId, second.runId);
  assert.deepEqual(first.selected.map((item: CandidateDecision) => item.paper.baseId), ['2608.10005', '2608.10004']);
  assert.deepEqual(second.selected.map((item: CandidateDecision) => item.paper.baseId), ['2608.10003', '2608.10002']);
});

test('a null selection file cannot silently turn recovery into a new selection', async t => {
  const f = await fixture(t);
  f.failDownload = '2608.10004v1';
  await assert.rejects(f.run(), /download failed/);
  const run = f.getStore().listRunsByStatus('failed')[0];
  await writeFile(join(f.root, 'runs', run.run_id, 'selection-manifest.json'), 'null');
  f.failDownload = null;
  f.requests.length = 0;
  await assert.rejects(f.run(), /invalid.*artifact/i);
  assert.deepEqual(f.requests, []);
  assert.equal(f.getStore().getLastSuccess(), null);
});

test('a parse job outside the saved selection cannot replace a batch member during recovery', async t => {
  const f = await fixture(t);
  f.failParse = true;
  await assert.rejects(f.run(), /parse failed/);
  const run = f.getStore().listRunsByStatus('failed')[0];
  const path = join(f.root, 'runs', run.run_id, 'mineru-jobs.json');
  const manifest: FixtureManifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.jobs[0].baseId = '2608.99999';
  await writeLocalParseManifest(path, manifest);
  f.failParse = false;
  await assert.rejects(f.run(), /parse.*selection/i);
  assert.equal(f.getStore().getLastSuccess(), null);
});
