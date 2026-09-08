import test from 'node:test';
import { archiveContext, archiveTestPdf } from './fixtures/library-paths.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTask } from '../src/library/pipeline.ts';
import { runLocalParse } from '../src/mineru/mineru-local-jobs.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { readVerifiedRunSources } from '../src/evidence/archive-reader.ts';
import { publishEvidence } from '../src/evidence/publisher.ts';
import { removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';
import type { LocalParseJob, TaskParseManifest, TaskPaper } from '../src/types/jobs.ts';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

test('synthetic arXiv → PDF → MinerU Archive → Evidence completes without model calls', { timeout: 30000 }, async () => {
  const testRoot = process.env.FSD_TEST_ROOT;
  assert.ok(testRoot, 'tests/preload.ts must set FSD_TEST_ROOT');
  const root = await mkdtemp(join(testRoot, 'deterministic-evidence-flow-'));
  const stateRoot = join(root, 'state');
  const pdfRoot = join(root, 'pdf');
  const tempRoot = join(root, 'tmp');
  const vaultRoot = join(root, 'vault');
  await Promise.all([stateRoot, pdfRoot, tempRoot, vaultRoot].map(path => mkdir(path, { recursive: true })));

  const paper: TaskPaper = {
    baseId: '2601.00001',
    arxivId: '2601.00001v1',
    id: '2601.00001v1',
    version: 1,
    title: 'Synthetic Evidence Flow',
    summary: 'A deterministic fixture paper.',
    published: '2026-01-01T00:00:00Z',
    updated: '2026-01-02T00:00:00Z',
    submittedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    authors: ['Nafiseh Soveizi'],
    categories: ['cs.SE'],
    matchedTracks: ['AI-FSD'],
    eligibleTracks: ['AI-FSD'],
    dateModes: ['updated'],
    primaryTrack: 'AI-FSD',
  };
  const pdfBytes = await archiveTestPdf();
  const pdfSha256 = sha256(pdfBytes);
  const outputDir = join(stateRoot, 'archive', `${paper.baseId}-v${paper.version}`);
  const store = openStateStore(join(stateRoot, 'papers.sqlite'));
  let downloadCalls = 0;
  let mineruCalls = 0;
  let evidenceCalls = 0;
  let modelCalls = 0;
  let observedRunId = '';
  const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z' };
  const config = {
    root,
    startDate: '2026-01-01',
    overlapHours: 48,
    currentTask: { maxPapers: 1, trackLimits: { 'AI-FSD': 1 } },
    weeklySchedule: { enabled: true, maxPapers: 1 },
  };

  try {
    const forbiddenModel = {
      generate: () => {
        modelCalls += 1;
        throw new Error('the deterministic FSD path must not invoke a model');
      },
    };
    const dependencies: Parameters<typeof runTask>[1] & { model: { generate: () => never } } = {
      config,
      store,
      model: forbiddenModel,
      lockPath: join(stateRoot, 'locks', 'paper-sync.lock'),
      runRoot: join(stateRoot, 'runs'),
      bootstrap: async () => undefined,
      discovery: { harvest: async () => [paper] },
      policy: { evaluate: value => ({ accepted: true, primaryTrack: 'AI-FSD', paper: value }) },
      pdfStore: { download: async decision => {
        downloadCalls += 1;
        const pdfPath = join(pdfRoot, `${paper.baseId}v${paper.version}.pdf`);
        await writeFile(pdfPath, pdfBytes, { flag: 'wx' });
        store.markDownloaded(paper.baseId, pdfPath, decision.primaryTrack ?? null, pdfSha256, paper.version);
        return { ...paper, sha256: pdfSha256, pdfPath, bytes: pdfBytes.byteLength };
      } },
      buildManifest: (runId, papers, run): TaskParseManifest => ({
        runId,
        window: { from: run.from, to: run.to },
        jobs: papers.map(value => ({
          ...value,
          baseId: value.baseId,
          version: value.version,
          sha256: value.sha256,
          pdfPath: value.pdfPath,
          outputDir,
          model: 'pipeline',
          cliBackend: 'pipeline',
          method: 'auto',
        })),
      }),
      writeManifest: async (path, value) => {
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      },
      parseOne: async job => {
        const localJob = { ...job, ...archiveContext(stateRoot), fileSource: job.pdfPath, outputDir } as LocalParseJob;
        return runLocalParse(localJob, {
          store,
          runner: async attemptJob => {
            mineruCalls += 1;
            const normalizedDir = join(attemptJob.outputDir!, 'normalized');
            await mkdir(normalizedDir, { recursive: true });
            await writeFile(join(normalizedDir, 'full.md'), '# Synthetic Evidence Flow\n\nMinerU fixture output.\n', 'utf8');
            await writeFile(join(normalizedDir, 'content-list.json'), JSON.stringify([{ type: 'text', text: 'MinerU fixture output.' }]), 'utf8');
            await writeFile(join(normalizedDir, 'pages.json'), JSON.stringify([{ pageNumber: 1, text: 'MinerU fixture output.' }]), 'utf8');
            await writeFile(join(normalizedDir, 'page-marked.txt'), '--- PAGE 1 ---\nMinerU fixture output.\n', 'utf8');
            return { exitCode: 0, elapsedMs: 1 };
          },
          normalize: async attemptJob => {
            const normalizedDir = join(attemptJob.outputDir!, 'normalized');
            return {
              outputDir: attemptJob.outputDir,
              normalizedDir,
              markdownPath: join(normalizedDir, 'full.md'),
              contentListPath: join(normalizedDir, 'content-list.json'),
              pageTextPath: join(normalizedDir, 'page-marked.txt'),
              pageCount: 1,
              pages: [{ pageNumber: 1, text: 'MinerU fixture output.' }],
            };
          },
          assessExtraction: async () => ({ accepted: true }),
        });
      },
      publishEvidence: async (runId, manifest) => {
        evidenceCalls += 1;
        observedRunId = runId;
        const sources = await readVerifiedRunSources({ runId, stateRoot, store });
        const publication = await publishEvidence({ runId, stateRoot, tempRoot, vaultRoot, sources });
        const receiptPath = join(stateRoot, 'runs', runId, 'evidence', 'publication.json');
        const receiptBytes = await readFile(receiptPath);
        store.reserveEvidencePublication({ runId, publicationId: publication.receipt.publicationId, inputSha256: publication.receipt.contentSha256 });
        store.completeEvidencePublication({
          runId,
          publicationId: publication.receipt.publicationId,
          receiptPath,
          receiptSha256: sha256(receiptBytes),
          lastSuccess: manifest.window?.to ?? window.to,
        });
        return { publicationId: publication.receipt.publicationId, sourceCount: sources.length, replayed: publication.status === 'replayed' };
      },
    };
    const result = await runTask({ mode: 'current', now: window.to, windowOverride: window }, dependencies);

    assert.equal(result.status, 'completed');
    assert.equal(result.paperCount, 1);
    assert.equal(downloadCalls, 1);
    assert.equal(mineruCalls, 1);
    assert.equal(evidenceCalls, 1);
    assert.equal(modelCalls, 0);
    assert.equal(store.getRun(result.runId)?.status, 'completed');
    assert.ok(await readFile(join(outputDir, 'source.json'), 'utf8'));
    assert.ok(await readFile(join(outputDir, 'source.pdf')));
    assert.ok(await readFile(join(vaultRoot, 'Evidence', 'papers', `${paper.baseId}-v1`, 'paper.md'), 'utf8'));
    assert.deepEqual(await readFile(join(vaultRoot, 'Evidence', 'papers', `${paper.baseId}-v1`, 'source.pdf')), Buffer.from(pdfBytes));
    assert.ok(await readFile(join(vaultRoot, 'Evidence', 'indexes', 'authors.md'), 'utf8'));
    const documentPath = join(vaultRoot, 'Evidence', 'papers', `${paper.baseId}-v1`, 'paper.md');
    const beforeReplay = await readFile(documentPath);

    const replay = await runTask({ mode: 'current', now: window.to, windowOverride: window }, {
      config,
      store,
      lockPath: join(stateRoot, 'locks', 'paper-sync.lock'),
      runRoot: join(stateRoot, 'runs'),
      bootstrap: async () => undefined,
      discovery: { harvest: async () => { throw new Error('replay must not harvest'); } },
      policy: { evaluate: value => ({ accepted: true, primaryTrack: 'AI-FSD', paper: value }) },
      pdfStore: { download: async () => { throw new Error('replay must not download'); } },
      parseOne: async () => { throw new Error('replay must not parse'); },
      writeManifest: async () => undefined,
      buildManifest: () => ({ runId: observedRunId, jobs: [] }),
      publishEvidence: async () => { throw new Error('replay must not publish'); },
    });
    assert.equal(replay.status, 'completed');
    assert.equal(replay.replayed, true);
    assert.equal(downloadCalls, 1);
    assert.equal(mineruCalls, 1);
    assert.equal(evidenceCalls, 1);
    assert.deepEqual(await readFile(documentPath), beforeReplay);
  } finally {
    store.close();
    await removeOwnedTestDirectory(root);
  }
});
