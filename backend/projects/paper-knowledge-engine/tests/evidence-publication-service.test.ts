import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { prepareEvidenceSources } from '../src/evidence/layout-v3.ts';
import { readVerifiedRunSources } from '../src/evidence/archive-reader.ts';
import type { VerifiedArchiveSource } from '../src/evidence/archive-reader.ts';
import { canonicalJson, hashCanonical } from '../src/evidence/contracts.ts';
import { archiveFileManifest } from '../src/shared/manifest.ts';
import { applyEvidencePublication, planEvidencePublication, publishEvidence } from '../src/evidence/publisher.ts';
import { readPublicationReceipt } from '../src/evidence/receipt-store.ts';
import { createStateDatabase } from '../src/runtime/sqlite.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { admitOperation, readOperationRecord } from '../src/library/operations/operation-store.ts';
import { executeOperation } from '../src/library/workflow.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';
import { PDFDocument } from 'pdf-lib';
import { ARCHIVE_ARTIFACTS, verifyArchiveV2 } from '../src/shared/archive-v2.ts';

const serviceModulePath = '../src/evidence/publication-service.ts';
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const testHash = (character: string) => character.repeat(64);
const window = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' };
const nextWindow = { from: '2026-09-02T00:00:00.000Z', to: '2026-09-03T00:00:00.000Z' };
const thirdWindow = { from: '2026-09-03T00:00:00.000Z', to: '2026-09-04T00:00:00.000Z' };

type PublicationServiceModule = {
  publishRunEvidence(input: {
    eligibility?: 'normal' | 'failed-recovery' | 'historical';
    historicalVerifiedSources?: readonly VerifiedArchiveSource[];
    lastSuccess: string;
    onProgress?: (event: unknown) => void;
    runId: string;
    stateRoot: string;
    store: ReturnType<typeof openStateStore>;
    tempRoot: string;
    vaultRoot: string;
  }): Promise<{
    status: 'completed';
    publicationId: string;
    contentSha256: string;
    receiptPath: string;
    receiptSha256: string;
    sourceCount: number;
    reservationReplayed: boolean;
    applyReplayed: boolean;
  }>;
};

const loadService = () => import(serviceModulePath) as Promise<PublicationServiceModule>;

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function validRunSourceFixture(input: {
  runId: string;
  stateRoot: string;
  store: ReturnType<typeof openStateStore>;
  baseId?: string;
  version?: number;
  title?: string;
  authors?: string[];
  legacy?: boolean;
}): Promise<{ job: Record<string, unknown>; archiveRoot: string }> {
  const baseId = input.baseId ?? '2609.10001';
  const version = input.version ?? 1;
  const title = input.title ?? 'Reservation ordering fixture';
  const authors = input.authors ?? ['Ada Reservation'];
  const document = await PDFDocument.create();
  document.addPage(); document.setTitle(`${baseId}v${version} ${title}`);
  document.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  document.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const pdf = await document.save();
  const pdfSha256 = sha256(pdf);
  const pdfPath = join(input.stateRoot, 'pdf', `${baseId}v${version}.pdf`);
  const archiveRoot = input.legacy
    ? join(input.stateRoot, 'extracted', `p-${baseId}-v${version}-${input.runId}`)
    : join(input.stateRoot, 'archive', `${baseId}-v${version}`);
  const runRoot = join(input.stateRoot, 'runs', input.runId);
  await Promise.all([
    mkdir(archiveRoot, { recursive: true }),
    mkdir(join(input.stateRoot, 'pdf'), { recursive: true }),
    mkdir(runRoot, { recursive: true }),
  ]);
  await writeFile(pdfPath, pdf);
  const paper = {
    baseId,
    arxivId: `${baseId}v${version}`,
    version,
    title,
    summary: 'Valid source state before the reservation gate',
    authors,
    categories: ['cs.SE'],
    matchedTracks: ['AI-FSD'],
    primaryTrack: 'AI-FSD',
    published: '2026-09-01T00:00:00Z',
    updated: '2026-09-02T00:00:00Z',
    status: 'discovered',
  };
  input.store.upsertDiscovered(paper);
  input.store.markDownloaded(baseId, pdfPath, paper.primaryTrack, pdfSha256, paper.version);
  const job = {
    ...paper,
    status: 'downloaded',
    sha256: pdfSha256,
    pdfPath,
    fileSource: pdfPath,
    outputDir: archiveRoot,
    pageCount: 1,
    model: 'pipeline',
    cliBackend: 'pipeline',
    method: 'auto',
  };
  await writeFile(join(runRoot, 'mineru-jobs.json'), canonicalJson({ runId: input.runId, window, jobs: [job] }));

  const attempt = input.store.reserveParseAttempt(job);
  if (!attempt) throw new Error('fixture parse attempt was not reserved');
  input.store.startParseAttempt(attempt.attemptId);
  if (input.legacy) {
    await mkdir(join(archiveRoot, 'normalized'));
    await mkdir(join(archiveRoot, 'pdf'));
    await writeFile(join(archiveRoot, 'normalized', 'full.md'), `# ${title}\n`);
    await writeFile(join(archiveRoot, 'normalized', 'page-marked.txt'), `--- PAGE 1 ---\n${title}\n`);
    await writeFile(join(archiveRoot, 'normalized', 'pages.json'), JSON.stringify([{ page: 1, text: title }]));
    await writeFile(join(archiveRoot, 'normalized', 'content-list.json'), '[]');
    await writeFile(join(archiveRoot, 'pdf', `${pdfSha256}.pdf`), await readFile(pdfPath));
    const source = {
      schemaVersion: 1 as const,
      baseId,
      arxivId: job.arxivId,
      version: job.version,
      title: job.title,
      authors: job.authors,
      categories: job.categories,
      matchedTracks: job.matchedTracks,
      published: job.published,
      updated: job.updated,
      pdfPath: `pdf/${pdfSha256}.pdf`,
      pdfSha256,
      parseAttemptId: attempt.attemptId,
      model: job.model,
      cliBackend: job.cliBackend,
      method: job.method,
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
  } else {
    const source = { title, authors, categories: paper.categories, matchedTracks: paper.matchedTracks,
      arxivId: paper.arxivId, published: paper.published, updated: paper.updated, parseAttemptId: attempt.attemptId, pageCount: 1 };
    const payloads = new Map<string, Uint8Array>([
      ['source.pdf', pdf], ['source.json', Buffer.from(canonicalJson(source))],
      ['document.md', Buffer.from(`# ${title}\n`)],
      ['pages.json', Buffer.from(canonicalJson([{ page: 1, text: title }]))],
      ['content-list.json', Buffer.from(canonicalJson([{ type: 'text', text: title }]))],
    ]);
    for (const [path, bytes] of payloads) await writeFile(join(archiveRoot, path), bytes);
    await writeFile(join(archiveRoot, 'manifest.json'), canonicalJson({ schemaVersion: 2, libraryId: 'fsd', sourceKind: 'arxiv',
      baseId, version, pdfSha256, parser: { name: 'MinerU', version: '3.4.5', model: 'pipeline', method: 'auto' },
      artifacts: ARCHIVE_ARTIFACTS, files: [...payloads].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) }));
    await verifyArchiveV2(archiveRoot);
  }
  input.store.finishParseAttempt(attempt.attemptId, {
    outputDir: archiveRoot,
    markdownPath: join(archiveRoot, input.legacy ? 'normalized/full.md' : 'document.md'),
    contentListPath: join(archiveRoot, input.legacy ? 'normalized/content-list.json' : 'content-list.json'),
    pageTextPath: join(archiveRoot, input.legacy ? 'normalized/page-marked.txt' : 'pages.json'),
    pageCount: 1,
    elapsedMs: 1,
    exitCode: 0,
  });
  input.store.markParsedStatus(baseId);
  return { job, archiveRoot };
}

async function publicationWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'fsd-evidence-publication-service-'));
  const stateRoot = join(root, 'state');
  const tempRoot = join(root, 'temp');
  const vaultRoot = join(root, 'vault');
  await Promise.all([mkdir(stateRoot), mkdir(tempRoot), mkdir(vaultRoot)]);
  const store = openStateStore(join(stateRoot, 'state.sqlite'));
  return { root, stateRoot, tempRoot, vaultRoot, store };
}

async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, relativeRoot: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        snapshot[relative] = 'directory';
        await visit(absolute, relative);
      } else {
        const info = await stat(absolute);
        snapshot[relative] = `${info.size}:${info.mtimeMs}:${sha256(await readFile(absolute))}`;
      }
    }
  };
  await visit(root, '');
  return snapshot;
}

async function completeConveniencePublication(input: {
  run: ReturnType<ReturnType<typeof openStateStore>['startRun']>;
  stateRoot: string;
  tempRoot: string;
  vaultRoot: string;
  store: ReturnType<typeof openStateStore>;
}) {
  const sources = await readVerifiedRunSources({ runId: input.run.id, stateRoot: input.stateRoot, store: input.store });
  const publication = await publishEvidence({
    runId: input.run.id,
    stateRoot: input.stateRoot,
    tempRoot: input.tempRoot,
    vaultRoot: input.vaultRoot,
    sources,
  });
  const receiptPath = join(input.stateRoot, 'runs', input.run.id, 'evidence', 'publication.json');
  const receiptBytes = await readFile(receiptPath);
  input.store.reserveEvidencePublication({
    runId: input.run.id,
    publicationId: publication.receipt.publicationId,
    inputSha256: publication.receipt.contentSha256,
  });
  input.store.completeEvidencePublication({
    runId: input.run.id,
    publicationId: publication.receipt.publicationId,
    receiptPath,
    receiptSha256: sha256(receiptBytes),
    lastSuccess: input.run.to,
  });
  return { ...publication, receiptPath, receiptBytes };
}

function failCompletionOnce(store: ReturnType<typeof openStateStore>, failure: Error): ReturnType<typeof openStateStore> {
  let pending = true;
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'completeEvidencePublication') return (input: Parameters<typeof target.completeEvidencePublication>[0]) => {
        if (pending) {
          pending = false;
          throw failure;
        }
        return target.completeEvidencePublication(input);
      };
      return Reflect.get(target, property, receiver);
    },
  });
}

async function tamperCompletedPublicationIdentity(input: {
  publisherVersion: 1 | 2 | 3;
  receiptPath: string;
  runId: string;
  stateRoot: string;
}): Promise<Buffer> {
  const receipt = await readPublicationReceipt(input.receiptPath);
  if (!receipt || receipt.publisherVersion !== input.publisherVersion) {
    throw new TypeError(`publisher v${input.publisherVersion} receipt is required`);
  }
  const contentSha256 = testHash(input.publisherVersion === 1 ? 'c' : 'd');
  const publicationId = input.publisherVersion === 1
    ? `evidence-${contentSha256.slice(0, 32)}`
    : `evidence-${hashCanonical({ runId: input.runId, contentSha256, publisherVersion: 3 }).slice(0, 32)}`;
  const bytes = Buffer.from(canonicalJson({ ...receipt, contentSha256, publicationId }));
  await writeFile(input.receiptPath, bytes);
  const raw = createStateDatabase(join(input.stateRoot, 'state.sqlite'));
  try {
    raw.prepare(`
      UPDATE evidence_publications
      SET publication_id=?, input_sha256=?, receipt_sha256=?
      WHERE run_id=?
    `).run(publicationId, contentSha256, sha256(bytes), input.runId);
  } finally { raw.close(); }
  return bytes;
}

test('a rejected database reservation produces zero publication filesystem writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fsd-evidence-publication-service-'));
  const stateRoot = join(root, 'state');
  const tempRoot = join(root, 'temp');
  const vaultRoot = join(root, 'vault');
  await Promise.all([mkdir(stateRoot), mkdir(tempRoot), mkdir(vaultRoot)]);
  const store = openStateStore(join(stateRoot, 'state.sqlite'));
  try {
    const run = store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: run.id, stateRoot, store });
    const verified = await readVerifiedRunSources({ runId: run.id, stateRoot, store });
    expect(verified.map(source => source.source.baseId)).toEqual(['2609.10001']);
    store.reserveEvidencePublication({
      runId: run.id,
      publicationId: 'preexisting-conflicting-publication',
      inputSha256: testHash('a'),
    });
    expect(() => store.reserveEvidencePublication({
      runId: run.id,
      publicationId: 'different-publication-probe',
      inputSha256: testHash('b'),
    })).toThrow('EVIDENCE_CONFLICT: run already has a different publication');
    const vaultBefore = await readdir(vaultRoot);
    const tempBefore = await readdir(tempRoot);
    const evidenceStateRoot = join(stateRoot, 'runs', run.id, 'evidence');
    expect(await pathExists(evidenceStateRoot)).toBe(false);
    const service = await loadService();

    await expect(service.publishRunEvidence({
      runId: run.id,
      stateRoot,
      tempRoot,
      vaultRoot,
      store,
      lastSuccess: run.to,
      onProgress: () => {},
    })).rejects.toThrow('EVIDENCE_CONFLICT: persisted publication identity matched 0 historical prefixes');

    expect(await readdir(vaultRoot)).toEqual(vaultBefore);
    expect(await readdir(tempRoot)).toEqual(tempBefore);
    for (const path of [
      evidenceStateRoot,
      join(evidenceStateRoot, 'publication.json'),
      join(evidenceStateRoot, 'publication-journal.json'),
      join(evidenceStateRoot, 'publication-journal.json.new'),
      join(tempRoot, 'evidence-publications'),
    ]) expect(await pathExists(path)).toBe(false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('normal publication rejects Archive v1 without completing the job or writing publication state', async () => {
  const paths = await publicationWorkspace();
  try {
    await writeLayeredConfigFixture({ root: paths.root });
    const run = paths.store.startRun(window, 'current', { autoResume: false });
    const source = await validRunSourceFixture({ ...paths, runId: run.id, legacy: true });
    expect((await readVerifiedRunSources({ ...paths, runId: run.id }))[0]!.source.schemaVersion).toBe(1);
    const frozen = await treeSnapshot(source.archiveRoot);
    const { job } = await admitOperation({ root: paths.root, operationsRoot: paths.stateRoot, request: {
      libraryId: 'fsd', requestId: 'normal-legacy', operation: { kind: 'evidence-publish', runId: run.id },
    } });
    const service = await loadService();
    const result = await executeOperation({ root: paths.root, jobId: job.jobId }, {
      operationsRoot: paths.stateRoot,
      publishEvidence: async runId => service.publishRunEvidence({ ...paths, runId, lastSuccess: run.to, eligibility: 'normal' }),
    });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('EVIDENCE_CONFLICT');
    expect(readOperationRecord(paths.stateRoot, job.jobId).status).toBe('failed');
    expect(paths.store.getRun(run.id)?.status).not.toBe('completed');
    expect(paths.store.findEvidencePublication(run.id)).toBeUndefined();
    expect(await pathExists(join(paths.stateRoot, 'runs', run.id, 'evidence'))).toBe(false);
    expect(await readdir(paths.vaultRoot)).toEqual([]);
    expect(await readdir(paths.tempRoot)).toEqual([]);
    expect(await treeSnapshot(source.archiveRoot)).toEqual(frozen);
  } finally { paths.store.close(); await rm(paths.root, { recursive: true, force: true }); }
});

test('the verified-source override is historical-only and reconstructs the completed migration run on replay', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const run = paths.store.startRun(window, 'evidence_migration', { autoResume: false });
    await validRunSourceFixture({ runId: run.id, stateRoot: paths.stateRoot, store: paths.store, legacy: true });
    const verified = await readVerifiedRunSources({ runId: run.id, stateRoot: paths.stateRoot, store: paths.store });
    await rm(join(paths.stateRoot, 'runs', run.id, 'mineru-jobs.json'));

    await expect(service.publishRunEvidence({
      ...paths,
      runId: run.id,
      lastSuccess: run.to,
      eligibility: 'normal',
      historicalVerifiedSources: verified,
    })).rejects.toThrow('historical verified sources require historical eligibility');
    expect(paths.store.findEvidencePublication(run.id)).toBeUndefined();

    const completed = await service.publishRunEvidence({
      ...paths,
      runId: run.id,
      lastSuccess: run.to,
      eligibility: 'historical',
      historicalVerifiedSources: verified,
    });
    const replayed = await service.publishRunEvidence({
      ...paths,
      runId: run.id,
      lastSuccess: run.to,
      eligibility: 'historical',
      historicalVerifiedSources: verified,
    });

    expect(completed).toMatchObject({ status: 'completed', sourceCount: 1, reservationReplayed: false, applyReplayed: false });
    expect(replayed).toMatchObject({
      status: 'completed',
      publicationId: completed.publicationId,
      sourceCount: 1,
      reservationReplayed: true,
      applyReplayed: true,
    });
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('the service creates missing publication roots only after reserving the run', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const run = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: run.id, stateRoot: paths.stateRoot, store: paths.store });
    await Promise.all([
      rm(paths.tempRoot, { recursive: true }),
      rm(paths.vaultRoot, { recursive: true }),
    ]);

    const result = await service.publishRunEvidence({ ...paths, runId: run.id, lastSuccess: run.to });

    expect(result.status).toBe('completed');
    expect(paths.store.getRun(run.id)?.status).toBe('completed');
    expect(await pathExists(paths.tempRoot)).toBe(true);
    expect(await pathExists(paths.vaultRoot)).toBe(true);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

for (const throwingStage of ['verified', 'reserved', 'applied', 'completed'] as const) {
  test(`the service treats a throwing ${throwingStage} observer as best-effort and remains idempotently completed`, async () => {
    const paths = await publicationWorkspace();
    try {
      const service = await loadService();
      const run = paths.store.startRun(window, 'current', { autoResume: false });
      await validRunSourceFixture({ runId: run.id, stateRoot: paths.stateRoot, store: paths.store });
      const input = {
        ...paths,
        runId: run.id,
        lastSuccess: run.to,
        onProgress: (event: unknown) => {
          if ((event as { stage?: string }).stage === throwingStage) throw new Error(`observer failed at ${throwingStage}`);
        },
      };

      const first = await service.publishRunEvidence(input);
      const replay = await service.publishRunEvidence(input);

      expect(first).toMatchObject({ status: 'completed', sourceCount: 1, applyReplayed: false });
      expect(replay).toMatchObject({
        status: 'completed',
        publicationId: first.publicationId,
        receiptSha256: first.receiptSha256,
        sourceCount: 1,
        reservationReplayed: true,
        applyReplayed: true,
      });
      expect(paths.store.getRun(run.id)?.status).toBe('completed');
      expect(paths.store.findEvidencePublication(run.id)?.status).toBe('completed');
    } finally {
      paths.store.close();
      await rm(paths.root, { recursive: true, force: true });
    }
  });
}

test('run B publishes cumulative A+B without changing A immutable version files', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({
      runId: runA.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.10001',
      title: 'Cumulative service source A',
      authors: ['Ada Archive'],
    });
    const resultA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });
    const immutableA = join(paths.vaultRoot, 'Evidence', 'papers', '2609.10001-v1');
    const immutableBefore = await treeSnapshot(immutableA);

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({
      runId: runB.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.10002',
      title: 'Cumulative service source B',
      authors: ['Bea Builder'],
    });
    const resultB = await service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to });

    expect(resultA).toMatchObject({ status: 'completed', sourceCount: 1, reservationReplayed: false, applyReplayed: false });
    expect(resultB).toMatchObject({ status: 'completed', sourceCount: 2, reservationReplayed: false, applyReplayed: false });
    expect(await treeSnapshot(immutableA)).toEqual(immutableBefore);
    const receiptB = await readPublicationReceipt(resultB.receiptPath);
    expect(receiptB?.publisherVersion).toBe(3);
    expect(receiptB?.sources.map(source => source.baseId)).toEqual(['2609.10001', '2609.10002']);
    const index = await readFile(join(paths.vaultRoot, 'Evidence', 'indexes', 'authors.md'), 'utf8');
    expect(index).toContain('Ada Archive');
    expect(index).toContain('Bea Builder');
    const categoryIndex = await readFile(join(paths.vaultRoot, 'Evidence', 'indexes', 'categories.md'), 'utf8');
    expect(categoryIndex).toContain('Cumulative service source A');
    expect(categoryIndex).toContain('Cumulative service source B');
    expect(paths.store.findEvidencePublication(runA.id)?.status).toBe('completed');
    expect(paths.store.findEvidencePublication(runB.id)?.status).toBe('completed');
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('a completed convenience publication remains an unchanged predecessor for cumulative v3', async () => {
  const paths = await publicationWorkspace();
  try {
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({
      runId: runA.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.11001',
      title: 'Legacy predecessor A',
    });
    const legacy = await completeConveniencePublication({ ...paths, run: runA });
    expect(legacy.receipt.publisherVersion).toBe(3);

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({
      runId: runB.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.11002',
      title: 'Current v2 source B',
    });
    const service = await loadService();
    const result = await service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to });

    expect(result).toMatchObject({ status: 'completed', sourceCount: 2 });
    expect(await readFile(legacy.receiptPath)).toEqual(legacy.receiptBytes);
    expect((await readPublicationReceipt(legacy.receiptPath))?.publisherVersion).toBe(3);
    expect((await readPublicationReceipt(result.receiptPath))?.publisherVersion).toBe(3);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('a historical Archive remains publishable after arXiv metadata is refreshed for the same version', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({
      runId: runA.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.11501',
      title: 'Metadata refresh predecessor',
    });
    await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });

    // A later arXiv response may add a category to the mutable observation row
    // without changing the already-frozen Archive source.json.
    paths.store.upsertSourceMetadata({
      schemaVersion: 1,
      baseId: '2609.11501',
      arxivId: '2609.11501v1',
      version: 1,
      title: 'Metadata refresh predecessor',
      authors: ['Ada Reservation'],
      categories: ['cs.SE', 'cs.CY'],
      published: '2026-09-01T00:00:00Z',
      updated: '2026-09-02T00:00:00Z',
    });

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({
      runId: runB.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.11502',
      title: 'Metadata refresh successor',
    });

    const result = await service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to });
    expect(result).toMatchObject({ status: 'completed', sourceCount: 2 });
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('an interrupted apply is failed after reservation and explicit recovery completes the same publication once', async () => {
  const paths = await publicationWorkspace();
  try {
    const run = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: run.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.12001' });
    const service = await loadService();
    process.env.FSD_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL = '1';
    try {
      await expect(service.publishRunEvidence({ ...paths, runId: run.id, lastSuccess: run.to })).rejects.toThrow('EVIDENCE_INTERRUPTED');
    } finally {
      delete process.env.FSD_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL;
    }
    const failed = paths.store.findEvidencePublication(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error_code).toBe('EVIDENCE_INTERRUPTED');
    paths.store.failRun(run.id, 'worker interrupted during Evidence publication');

    const recovered = await service.publishRunEvidence({
      ...paths,
      runId: run.id,
      lastSuccess: run.to,
      eligibility: 'failed-recovery',
    });
    expect(recovered).toMatchObject({
      status: 'completed',
      publicationId: failed?.publication_id,
      sourceCount: 1,
      reservationReplayed: false,
      applyReplayed: false,
    });
    const completedAt = paths.store.listCompletedEvidencePublications()[0]?.completedAt;
    const replayed = await service.publishRunEvidence({
      ...paths,
      runId: run.id,
      lastSuccess: run.to,
      eligibility: 'failed-recovery',
    });
    expect(replayed).toMatchObject({
      publicationId: recovered.publicationId,
      receiptSha256: recovered.receiptSha256,
      reservationReplayed: true,
      applyReplayed: true,
    });
    const history = paths.store.listCompletedEvidencePublications();
    expect(history).toHaveLength(1);
    expect(history[0]?.completedAt).toBe(completedAt);
    expect(history[0]?.sources).toHaveLength(1);
  } finally {
    delete process.env.FSD_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL;
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('a completed-history Archive identity conflict fails before reservation and filesystem writes', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runA.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.13001' });
    const completedA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });

    const receipt = JSON.parse(await readFile(completedA.receiptPath, 'utf8')) as {
      sources: Array<{ archiveManifestSha256: string }>;
      [key: string]: unknown;
    };
    receipt.sources[0]!.archiveManifestSha256 = testHash('f');
    const receiptBytes = canonicalJson(receipt);
    await writeFile(completedA.receiptPath, receiptBytes);

    const raw = createStateDatabase(join(paths.stateRoot, 'state.sqlite'));
    try {
      raw.prepare('UPDATE evidence_publication_sources SET archive_manifest_sha256=? WHERE run_id=?').run(testHash('f'), runA.id);
      raw.prepare('UPDATE evidence_publications SET receipt_sha256=? WHERE run_id=?').run(sha256(receiptBytes), runA.id);
    } finally { raw.close(); }

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runB.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.13002' });
    const before = {
      vault: await treeSnapshot(paths.vaultRoot),
      temp: await treeSnapshot(paths.tempRoot),
      runEvidenceExists: await pathExists(join(paths.stateRoot, 'runs', runB.id, 'evidence')),
    };
    await expect(service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to })).rejects.toThrow('EVIDENCE_CONFLICT');

    expect(paths.store.findEvidencePublication(runB.id)).toBeUndefined();
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(before.vault);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(before.temp);
    expect(await pathExists(join(paths.stateRoot, 'runs', runB.id, 'evidence'))).toBe(before.runEvidenceExists);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('the same cumulative content under another run gets a distinct row without Vault content changes', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runOne = paths.store.startRun(window, 'current', { autoResume: false });
    const fixture = await validRunSourceFixture({
      runId: runOne.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.14001',
      title: 'Stable cumulative content',
    });
    const first = await service.publishRunEvidence({ ...paths, runId: runOne.id, lastSuccess: runOne.to });
    const vaultBefore = await treeSnapshot(paths.vaultRoot);

    const runTwo = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    const runTwoRoot = join(paths.stateRoot, 'runs', runTwo.id);
    await mkdir(runTwoRoot, { recursive: true });
    await writeFile(join(runTwoRoot, 'mineru-jobs.json'), canonicalJson({ runId: runTwo.id, window, jobs: [fixture.job] }));
    const second = await service.publishRunEvidence({ ...paths, runId: runTwo.id, lastSuccess: runTwo.to });

    expect(second.contentSha256).toBe(first.contentSha256);
    expect(second.publicationId).not.toBe(first.publicationId);
    expect(second).toMatchObject({ status: 'completed', sourceCount: 1, reservationReplayed: false, applyReplayed: false });
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    const history = paths.store.listCompletedEvidencePublications();
    expect(history.map(publication => publication.runId).sort()).toEqual([runOne.id, runTwo.id].sort());
    expect(new Set(history.map(publication => publication.publicationId)).size).toBe(2);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('replaying completed A after cumulative B preserves A original identity and every installed byte', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({
      runId: runA.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.15001',
      title: 'Stable replay source A',
    });
    const firstA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });
    const rowA = paths.store.findEvidencePublication(runA.id);
    const receiptA = await readFile(firstA.receiptPath);

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({
      runId: runB.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.15002',
      title: 'Later cumulative source B',
    });
    await service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to });
    const vaultBefore = await treeSnapshot(paths.vaultRoot);
    const tempBefore = await treeSnapshot(paths.tempRoot);

    const replayedA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });

    expect(replayedA).toMatchObject({
      publicationId: firstA.publicationId,
      contentSha256: firstA.contentSha256,
      receiptSha256: firstA.receiptSha256,
      sourceCount: 1,
      reservationReplayed: true,
      applyReplayed: true,
    });
    expect(paths.store.findEvidencePublication(runA.id)).toEqual(rowA);
    expect(await readFile(firstA.receiptPath)).toEqual(receiptA);
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(tempBefore);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('failed A with a durable receipt recovers its original plan after later cumulative B completes', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    const fixtureA = await validRunSourceFixture({
      runId: runA.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.16001',
      title: 'Recoverable original source A',
    });
    const sourcesA = await readVerifiedRunSources({ runId: runA.id, stateRoot: paths.stateRoot, store: paths.store });
    const completionFailure = new Error('injected completion failure for identity drift');
    await expect(service.publishRunEvidence({
      ...paths,
      store: failCompletionOnce(paths.store, completionFailure),
      runId: runA.id,
      lastSuccess: runA.to,
    })).rejects.toBe(completionFailure);
    const failedA = paths.store.findEvidencePublication(runA.id);
    expect(failedA?.status).toBe('failed');
    const receiptPathA = join(paths.stateRoot, 'runs', runA.id, 'evidence', 'publication.json');
    const receiptA = await readFile(receiptPathA);

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    const fixtureB = await validRunSourceFixture({
      runId: runB.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.16002',
      title: 'Later cumulative source B',
    });
    await writeFile(
      join(paths.stateRoot, 'runs', runB.id, 'mineru-jobs.json'),
      canonicalJson({ runId: runB.id, window: nextWindow, jobs: [fixtureA.job, fixtureB.job] }),
    );
    const sourcesB = await readVerifiedRunSources({ runId: runB.id, stateRoot: paths.stateRoot, store: paths.store });
    const predecessorA = planEvidencePublication({ runId: runA.id, sources: await prepareEvidenceSources(sourcesA) });
    const planB = planEvidencePublication({ runId: runB.id, sources: await prepareEvidenceSources(sourcesB), predecessor: predecessorA });
    await applyEvidencePublication({ ...paths, plan: planB });
    const receiptPathB = join(paths.stateRoot, 'runs', runB.id, 'evidence', 'publication.json');
    const receiptB = await readFile(receiptPathB);
    paths.store.reserveEvidencePublication({
      runId: runB.id,
      publicationId: planB.publicationId,
      inputSha256: planB.contentSha256,
    });
    paths.store.completeEvidencePublication({
      runId: runB.id,
      publicationId: planB.publicationId,
      receiptPath: receiptPathB,
      receiptSha256: sha256(receiptB),
      lastSuccess: runB.to,
    });
    const vaultBefore = await treeSnapshot(paths.vaultRoot);
    const tempBefore = await treeSnapshot(paths.tempRoot);

    const recoveredA = await service.publishRunEvidence({
      ...paths,
      runId: runA.id,
      lastSuccess: runA.to,
      eligibility: 'failed-recovery',
    });

    expect(recoveredA).toMatchObject({
      publicationId: failedA?.publication_id,
      contentSha256: failedA?.input_sha256,
      receiptSha256: sha256(receiptA),
      sourceCount: 1,
      reservationReplayed: false,
      applyReplayed: true,
    });
    expect(await readFile(receiptPathA)).toEqual(receiptA);
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(tempBefore);
    expect(paths.store.findEvidencePublication(runA.id)?.status).toBe('completed');
    expect(paths.store.findEvidencePublication(runB.id)?.status).toBe('completed');
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('superseded failed A does not complete when the latest installed Vault projection is stale', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    const fixtureA = await validRunSourceFixture({
      runId: runA.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.16101',
      title: 'Superseded recoverable A',
    });
    const sourcesA = await readVerifiedRunSources({ runId: runA.id, stateRoot: paths.stateRoot, store: paths.store });
    const completionFailure = new Error('injected completion failure before superseding history');
    await expect(service.publishRunEvidence({
      ...paths,
      store: failCompletionOnce(paths.store, completionFailure),
      runId: runA.id,
      lastSuccess: runA.to,
    })).rejects.toBe(completionFailure);
    const failedA = paths.store.findEvidencePublication(runA.id);
    expect(failedA?.status).toBe('failed');

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    const fixtureB = await validRunSourceFixture({
      runId: runB.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.16102',
      title: 'Latest cumulative B',
    });
    await writeFile(
      join(paths.stateRoot, 'runs', runB.id, 'mineru-jobs.json'),
      canonicalJson({ runId: runB.id, window: nextWindow, jobs: [fixtureA.job, fixtureB.job] }),
    );
    const sourcesB = await readVerifiedRunSources({ runId: runB.id, stateRoot: paths.stateRoot, store: paths.store });
    const predecessorA = planEvidencePublication({ runId: runA.id, sources: await prepareEvidenceSources(sourcesA) });
    const planB = planEvidencePublication({ runId: runB.id, sources: await prepareEvidenceSources(sourcesB), predecessor: predecessorA });
    await applyEvidencePublication({ ...paths, plan: planB });
    const receiptPathB = join(paths.stateRoot, 'runs', runB.id, 'evidence', 'publication.json');
    const receiptB = await readFile(receiptPathB);
    paths.store.reserveEvidencePublication({
      runId: runB.id,
      publicationId: planB.publicationId,
      inputSha256: planB.contentSha256,
    });
    paths.store.completeEvidencePublication({
      runId: runB.id,
      publicationId: planB.publicationId,
      receiptPath: receiptPathB,
      receiptSha256: sha256(receiptB),
      lastSuccess: runB.to,
    });

    const installedB = join(paths.vaultRoot, 'Evidence', 'papers', '2609.16102-v1', 'paper.md');
    await writeFile(installedB, '# stale latest projection\n');
    const vaultBefore = await treeSnapshot(paths.vaultRoot);
    const tempBefore = await treeSnapshot(paths.tempRoot);

    await expect(service.publishRunEvidence({
      ...paths,
      runId: runA.id,
      lastSuccess: runA.to,
      eligibility: 'failed-recovery',
    })).rejects.toThrow('EVIDENCE_CONFLICT');

    expect(paths.store.findEvidencePublication(runA.id)).toEqual(failedA);
    expect(paths.store.findEvidencePublication(runB.id)?.status).toBe('completed');
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(tempBefore);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('failed A recovers across multiple equivalent no-op completed prefixes', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    const fixtureA = await validRunSourceFixture({
      runId: runA.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.17001',
      title: 'Equivalent prefix source',
    });
    const sourcesA = await readVerifiedRunSources({ runId: runA.id, stateRoot: paths.stateRoot, store: paths.store });
    const planA = planEvidencePublication({ runId: runA.id, sources: await prepareEvidenceSources(sourcesA) });
    paths.store.reserveEvidencePublication({ runId: runA.id, publicationId: planA.publicationId, inputSha256: planA.contentSha256 });
    paths.store.failEvidencePublication({ runId: runA.id, publicationId: planA.publicationId, errorCode: 'EVIDENCE_INTERRUPTED' });

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    const runBRoot = join(paths.stateRoot, 'runs', runB.id);
    await mkdir(runBRoot, { recursive: true });
    await writeFile(join(runBRoot, 'mineru-jobs.json'), canonicalJson({ runId: runB.id, window: nextWindow, jobs: [fixtureA.job] }));
    await service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to });

    const runC = paths.store.startRun(thirdWindow, 'current', { autoResume: false });
    const runCRoot = join(paths.stateRoot, 'runs', runC.id);
    await mkdir(runCRoot, { recursive: true });
    await writeFile(join(runCRoot, 'mineru-jobs.json'), canonicalJson({ runId: runC.id, window: thirdWindow, jobs: [fixtureA.job] }));
    await service.publishRunEvidence({ ...paths, runId: runC.id, lastSuccess: runC.to });
    const vaultBefore = await treeSnapshot(paths.vaultRoot);
    const tempBefore = await treeSnapshot(paths.tempRoot);

    const recoveredA = await service.publishRunEvidence({
      ...paths,
      runId: runA.id,
      lastSuccess: runA.to,
      eligibility: 'failed-recovery',
    });

    expect(recoveredA).toMatchObject({
      publicationId: planA.publicationId,
      contentSha256: planA.contentSha256,
      reservationReplayed: false,
      applyReplayed: false,
    });
    expect(paths.store.findEvidencePublication(runA.id)?.status).toBe('completed');
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(tempBefore);
    expect(await pathExists(join(paths.stateRoot, 'runs', runA.id, 'evidence', 'publication.json'))).toBe(true);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('completed A replays across multiple equivalent no-op completed prefixes', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    const fixtureA = await validRunSourceFixture({
      runId: runA.id,
      stateRoot: paths.stateRoot,
      store: paths.store,
      baseId: '2609.17101',
      title: 'Completed equivalent prefix source',
    });
    const completedA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });
    for (const [historyWindow, label] of [[nextWindow, 'B'], [thirdWindow, 'C']] as const) {
      const run = paths.store.startRun(historyWindow, 'current', { autoResume: false });
      const runRoot = join(paths.stateRoot, 'runs', run.id);
      await mkdir(runRoot, { recursive: true });
      await writeFile(join(runRoot, 'mineru-jobs.json'), canonicalJson({ runId: run.id, window: historyWindow, jobs: [fixtureA.job], label }));
      await service.publishRunEvidence({ ...paths, runId: run.id, lastSuccess: run.to });
    }
    const vaultBefore = await treeSnapshot(paths.vaultRoot);
    const tempBefore = await treeSnapshot(paths.tempRoot);
    const receiptBefore = await readFile(completedA.receiptPath);

    const replayedA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });

    expect(replayedA).toMatchObject({
      publicationId: completedA.publicationId,
      contentSha256: completedA.contentSha256,
      reservationReplayed: true,
      applyReplayed: true,
    });
    expect(await readFile(completedA.receiptPath)).toEqual(receiptBefore);
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(tempBefore);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('tampered completed receipt bytes fail before the next run reservation or filesystem writes', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runA.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18001' });
    const completedA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });
    const receiptA = await readFile(completedA.receiptPath);
    await writeFile(completedA.receiptPath, Buffer.concat([receiptA, Buffer.from(' ')]));

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runB.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18002' });
    const vaultBefore = await treeSnapshot(paths.vaultRoot);
    const tempBefore = await treeSnapshot(paths.tempRoot);
    const tamperedReceipt = await readFile(completedA.receiptPath);

    await expect(service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to })).rejects.toThrow('EVIDENCE_RECEIPT_CONFLICT');

    expect(paths.store.findEvidencePublication(runB.id)).toBeUndefined();
    expect(sha256(await readFile(completedA.receiptPath))).toBe(sha256(tamperedReceipt));
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(tempBefore);
    expect(await pathExists(join(paths.stateRoot, 'runs', runB.id, 'evidence'))).toBe(false);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('tampered completed receipt hash fails before the next run reservation or filesystem writes', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runA.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18101' });
    const completedA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });
    const raw = createStateDatabase(join(paths.stateRoot, 'state.sqlite'));
    try { raw.prepare('UPDATE evidence_publications SET receipt_sha256=? WHERE run_id=?').run(testHash('f'), runA.id); }
    finally { raw.close(); }

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runB.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18102' });
    const vaultBefore = await treeSnapshot(paths.vaultRoot);
    const tempBefore = await treeSnapshot(paths.tempRoot);
    const receiptA = await readFile(completedA.receiptPath);

    await expect(service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to })).rejects.toThrow('EVIDENCE_RECEIPT_CONFLICT');

    expect(paths.store.findEvidencePublication(runB.id)).toBeUndefined();
    expect(await readFile(completedA.receiptPath)).toEqual(receiptA);
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(tempBefore);
    expect(await pathExists(join(paths.stateRoot, 'runs', runB.id, 'evidence'))).toBe(false);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('coordinated completed evidence-manifest receipt, hash, and source-row tamper fails before reservation or writes', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runA.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18201' });
    const completedA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });
    const receipt = await readPublicationReceipt(completedA.receiptPath);
    if (!receipt) throw new TypeError('completed receipt is required');
    const tamperedReceipt = {
      ...receipt,
      sources: receipt.sources.map(source => ({ ...source, evidenceManifestSha256: testHash('f') })),
    };
    const tamperedReceiptBytes = canonicalJson(tamperedReceipt);
    await writeFile(completedA.receiptPath, tamperedReceiptBytes);
    const raw = createStateDatabase(join(paths.stateRoot, 'state.sqlite'));
    try {
      raw.prepare('UPDATE evidence_publication_sources SET evidence_manifest_sha256=? WHERE run_id=?').run(testHash('f'), runA.id);
      raw.prepare('UPDATE evidence_publications SET receipt_sha256=? WHERE run_id=?').run(sha256(tamperedReceiptBytes), runA.id);
    }
    finally { raw.close(); }

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runB.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18202' });
    const vaultBefore = await treeSnapshot(paths.vaultRoot);
    const tempBefore = await treeSnapshot(paths.tempRoot);
    const receiptA = await readFile(completedA.receiptPath);

    await expect(service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to })).rejects.toThrow('EVIDENCE_RECEIPT_CONFLICT');

    expect(paths.store.findEvidencePublication(runB.id)).toBeUndefined();
    expect(await readFile(completedA.receiptPath)).toEqual(receiptA);
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(tempBefore);
    expect(await pathExists(join(paths.stateRoot, 'runs', runB.id, 'evidence'))).toBe(false);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('coordinated convenience-publication content and publication identity tamper fails before reservation or filesystem writes', async () => {
  const paths = await publicationWorkspace();
  try {
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runA.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18211' });
    const completedA = await completeConveniencePublication({ ...paths, run: runA });
    const tamperedReceipt = await tamperCompletedPublicationIdentity({
      publisherVersion: 3,
      receiptPath: completedA.receiptPath,
      runId: runA.id,
      stateRoot: paths.stateRoot,
    });

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runB.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18212' });
    const vaultBefore = await treeSnapshot(paths.vaultRoot);
    const tempBefore = await treeSnapshot(paths.tempRoot);

    const service = await loadService();
    await expect(service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to })).rejects.toThrow(
      'EVIDENCE_RECEIPT_CONFLICT',
    );

    expect(paths.store.findEvidencePublication(runB.id)).toBeUndefined();
    expect(sha256(await readFile(completedA.receiptPath))).toBe(sha256(tamperedReceipt));
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(tempBefore);
    expect(await pathExists(join(paths.stateRoot, 'runs', runB.id, 'evidence'))).toBe(false);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('coordinated cumulative-publication content and publication identity tamper fails before reservation or filesystem writes', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runA.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18221' });
    const completedA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });
    const tamperedReceipt = await tamperCompletedPublicationIdentity({
      publisherVersion: 3,
      receiptPath: completedA.receiptPath,
      runId: runA.id,
      stateRoot: paths.stateRoot,
    });

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runB.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18222' });
    const vaultBefore = await treeSnapshot(paths.vaultRoot);
    const tempBefore = await treeSnapshot(paths.tempRoot);

    await expect(service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to })).rejects.toThrow(
      'EVIDENCE_RECEIPT_CONFLICT',
    );

    expect(paths.store.findEvidencePublication(runB.id)).toBeUndefined();
    expect(sha256(await readFile(completedA.receiptPath))).toBe(sha256(tamperedReceipt));
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(tempBefore);
    expect(await pathExists(join(paths.stateRoot, 'runs', runB.id, 'evidence'))).toBe(false);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('escaped historical receipt path fails before reservation or filesystem writes', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runA.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18301' });
    const completedA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });
    const escapedReceipt = join(paths.root, 'escaped-publication.json');
    await writeFile(escapedReceipt, await readFile(completedA.receiptPath));
    const raw = createStateDatabase(join(paths.stateRoot, 'state.sqlite'));
    try { raw.prepare('UPDATE evidence_publications SET receipt_path=? WHERE run_id=?').run(escapedReceipt, runA.id); }
    finally { raw.close(); }

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runB.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18302' });
    const before = await Promise.all([treeSnapshot(paths.vaultRoot), treeSnapshot(paths.tempRoot), readFile(escapedReceipt)]);

    await expect(service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to })).rejects.toThrow(
      'EVIDENCE_RECEIPT_CONFLICT',
    );

    expect(paths.store.findEvidencePublication(runB.id)).toBeUndefined();
    expect(await Promise.all([treeSnapshot(paths.vaultRoot), treeSnapshot(paths.tempRoot), readFile(escapedReceipt)])).toEqual(before);
    expect(await pathExists(join(paths.stateRoot, 'runs', runB.id, 'evidence'))).toBe(false);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('linked historical receipt fails before reservation or filesystem writes', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const runA = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runA.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18401' });
    const completedA = await service.publishRunEvidence({ ...paths, runId: runA.id, lastSuccess: runA.to });
    const originalReceipt = `${completedA.receiptPath}.original`;
    await rename(completedA.receiptPath, originalReceipt);
    const linkedDirectory = join(paths.root, 'linked-receipt-directory');
    await mkdir(linkedDirectory);
    await symlink(linkedDirectory, completedA.receiptPath, 'junction');

    const runB = paths.store.startRun(nextWindow, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: runB.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.18402' });
    const vaultBefore = await treeSnapshot(paths.vaultRoot);
    const tempBefore = await treeSnapshot(paths.tempRoot);

    await expect(service.publishRunEvidence({ ...paths, runId: runB.id, lastSuccess: runB.to })).rejects.toThrow(
      'EVIDENCE_RECEIPT_CONFLICT',
    );

    expect(paths.store.findEvidencePublication(runB.id)).toBeUndefined();
    expect(await readFile(originalReceipt)).toBeDefined();
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(vaultBefore);
    expect(await treeSnapshot(paths.tempRoot)).toEqual(tempBefore);
    expect(await pathExists(join(paths.stateRoot, 'runs', runB.id, 'evidence'))).toBe(false);
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('a one-shot completion failure preserves the durable receipt and recovery completes sources exactly once', async () => {
  const paths = await publicationWorkspace();
  try {
    const service = await loadService();
    const run = paths.store.startRun(window, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: run.id, stateRoot: paths.stateRoot, store: paths.store, baseId: '2609.19001' });
    const completionFailure = new Error('injected one-shot SQLite completion failure');
    let caught: unknown;
    try {
      await service.publishRunEvidence({
        ...paths,
        store: failCompletionOnce(paths.store, completionFailure),
        runId: run.id,
        lastSuccess: run.to,
      });
    } catch (error) { caught = error; }
    expect(caught).toBe(completionFailure);
    const failed = paths.store.findEvidencePublication(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error_code).toBe('EVIDENCE_PUBLICATION_FAILED');
    const receiptPath = join(paths.stateRoot, 'runs', run.id, 'evidence', 'publication.json');
    const receiptBytes = await readFile(receiptPath);
    const receipt = await readPublicationReceipt(receiptPath);
    expect(receipt).toMatchObject({
      publisherVersion: 3,
      runId: run.id,
      publicationId: failed?.publication_id,
      contentSha256: failed?.input_sha256,
    });

    const recovered = await service.publishRunEvidence({
      ...paths,
      runId: run.id,
      lastSuccess: run.to,
      eligibility: 'failed-recovery',
    });
    expect(recovered).toMatchObject({
      publicationId: failed?.publication_id,
      receiptSha256: sha256(receiptBytes),
      reservationReplayed: false,
      applyReplayed: true,
    });
    expect(await readFile(receiptPath)).toEqual(receiptBytes);
    const replayed = await service.publishRunEvidence({ ...paths, runId: run.id, lastSuccess: run.to });
    expect(replayed).toMatchObject({
      publicationId: recovered.publicationId,
      receiptSha256: recovered.receiptSha256,
      reservationReplayed: true,
      applyReplayed: true,
    });

    const history = paths.store.listCompletedEvidencePublications();
    expect(history).toHaveLength(1);
    expect(history[0]?.sources).toHaveLength(1);
    const raw = createStateDatabase(join(paths.stateRoot, 'state.sqlite'));
    try {
      expect(raw.prepare('SELECT count(*) AS count FROM evidence_publications WHERE run_id=?').get(run.id)?.count).toBe(1);
      expect(raw.prepare('SELECT count(*) AS count FROM evidence_publication_sources WHERE run_id=?').get(run.id)?.count).toBe(1);
    } finally { raw.close(); }
  } finally {
    paths.store.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});
