import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { openStateStore } from '../../src/library/state/state-store.ts';
import { canonicalJson, archiveFileManifest } from '../../src/shared/manifest.ts';
import { ARCHIVE_ARTIFACTS, verifyArchiveV2 } from '../../src/shared/archive-v2.ts';
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const window = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' };
export async function validRunSourceFixture(input: {
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
    await writeFile(join(archiveRoot, 'normalized', 'content-list.json'), JSON.stringify([{ type: 'text', text: title }]));
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
