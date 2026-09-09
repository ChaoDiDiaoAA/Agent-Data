import { archiveContext, archiveTestPdf } from './fixtures/library-paths.ts';
import { removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';
import type { LocalParseJob, MinerUCliJob, ParseArtifacts, ParseAttemptInput } from '../src/types/jobs.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { runLocalParse, buildLocalParseJob, buildLocalParseManifest } from '../src/mineru/mineru-local-jobs.ts';
import { runParseManifest } from '../src/library/pipeline.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { downloadAcceptedPdf, hasStoredPaperPdf } from '../src/library/sources/pdf-store.ts';
import { routeParseLocal } from '../src/cli/routes.ts';

async function writeSessionArtifacts(outputDir: string, title = 'Session Output') {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'paper.md'), `# ${title}\ntext`);
  await writeFile(join(outputDir, 'paper_content_list.json'), '[{"page_idx":0,"text":"text"}]');
}

for (const version of [1, 2]) test(`successful Archive install atomically adopts its permanent PDF for paper and attempt (v${version})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-pdf-adoption-'));
  const pdfPath = join(root, 'download.pdf');
  const body = await archiveTestPdf();
  await writeFile(pdfPath, body);
  const config = { ...archiveContext(root), model: 'pipeline', cliBackend: 'pipeline', pipelineMethod: 'auto', outputRoot: join(root, 'archive') };
  const store = openStateStore(':memory:');
  const paper = { baseId: '2601.00009', arxivId: `2601.00009v${version}`, version,
    title: 'Permanent PDF', authors: ['Ada'], categories: ['cs.SE'], matchedTracks: ['AI-FSD'],
    published: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z',
    sha256: createHash('sha256').update(body).digest('hex'), pdfPath, pageCount: 1 };
  try {
    store.upsertDiscovered({ ...paper, arxivId: '2601.00009v1', version: 1 });
    store.markDownloaded(paper.baseId, pdfPath, 'AI-FSD', paper.sha256, 1);
    if (version === 2) store.upsertDiscovered(paper);
    const job = buildLocalParseJob(paper, config);
    const report = await runLocalParse(job, { store,
      runner: async current => { await writeSessionArtifacts(current.outputDir!); return { exitCode: 0 }; },
      assessExtraction: () => ({ accepted: true }),
    });
    assert.equal(report.status, 'succeeded', report.errorMessage ?? '');
    const permanent = join(root, 'archive', `2601.00009-v${version}`, 'source.pdf');
    assert.equal(store.findByBaseId(paper.baseId)?.pdf_path, permanent);
    assert.equal(store.findByBaseId(paper.baseId)?.status, 'parsed');
    assert.equal(store.findByBaseId(paper.baseId)?.downloaded_version, version);
    assert.equal(store.findSuccessfulParse(job)?.sourcePath, permanent);
    await rm(pdfPath);
    assert.deepEqual(await readFile(permanent), Buffer.from(body));
    assert.equal(await hasStoredPaperPdf(paper, store), true);
    const reused = await downloadAcceptedPdf({ accepted: true, paper: { ...paper, pdfUrl: 'https://arxiv.invalid/unused.pdf' } }, {
      stateStore: store, pdfRoot: join(root, 'downloads'), tempRoot: join(root, 'tmp'),
      fetchImpl: async () => { throw Error('permanent PDF must be reused without network'); },
    });
    assert.equal(reused.pdfPath, permanent);
    const replay = await runLocalParse(job, { store, runner: async () => { throw Error('must reuse verified parse'); } });
    assert.equal(replay.status, 'succeeded');
  } finally { store.close(); await removeOwnedTestDirectory(root); }
});
async function validTestArtifact(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), `local-parse-${prefix}-`));
  const paths = { markdownPath: join(root, 'full.md'), contentListPath: join(root, 'content.json'), pageTextPath: join(root, 'page-marked.txt') };
  await writeFile(paths.markdownPath, '# Paper\ntext');
  await writeFile(paths.contentListPath, '[{"page_idx":0,"text":"text"}]');
  await writeFile(paths.pageTextPath, '--- PAGE 1 ---\ntext\n');
  return { root, artifact: { ...paths, pageCount: 1, pages: [{ pageNumber: 1, text: 'text' }] } };
}

test('rejects malformed normalized page identity before finishing a parse', async () => {
  const { root, artifact } = await validTestArtifact('page-boundary');
  let finishes = 0;
  try {
    const result = await runLocalParse({ baseId: '2601.pages', version: 1, sha256: 'a'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', pageCount: 1 }, {
      store: { reserveParseAttempt: () => ({ attemptId: 'bad-pages' }), finishParseAttempt: () => { finishes++; } },
      runner: async () => ({ exitCode: 0 }),
      normalize: async () => ({ ...artifact, pages: [{ pageNumber: 99, text: 'text' }] }),
    });
    assert.equal(result.status, 'failed'); assert.equal(result.errorClass, 'invalid_artifact'); assert.equal(finishes, 0);
  } finally { await removeOwnedTestDirectory(root); }
});

test('rejects a normalized artifact for a different model before publishing', async () => {
  const { root, artifact } = await validTestArtifact('model-boundary');
  let finishes = 0;
  try {
    const result = await runLocalParse({ baseId: '2601.model', version: 1, sha256: 'a'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', pageCount: 1 }, {
      store: { reserveParseAttempt: () => ({ attemptId: 'bad-model' }), finishParseAttempt: () => { finishes++; } },
      runner: async () => ({ exitCode: 0 }), normalize: async () => ({ ...artifact, model: 'vlm' }),
    });
    assert.equal(result.status, 'failed'); assert.equal(result.errorClass, 'invalid_artifact'); assert.equal(finishes, 0);
  } finally { await removeOwnedTestDirectory(root); }
});

test('builds one job from each configured model', () => {
  const paper = { baseId: '2601.1', arxivId: '2601.1v1', version: 1, sha256: 'a'.repeat(64), pdfPath: 'D:/paper/p.pdf', pageCount: 8 };
  const pipeline = buildLocalParseJob(paper, { model: 'pipeline', cliBackend: 'pipeline', outputRoot: 'D:/state/extracted' });
  const vlm = buildLocalParseJob(paper, { model: 'vlm', cliBackend: 'vlm-engine', outputRoot: 'D:/state/extracted' });
  assert.equal(pipeline.model, 'pipeline');
  assert.equal(pipeline.cliBackend, 'pipeline');
  assert.equal(vlm.model, 'vlm');
  assert.equal(vlm.cliBackend, 'vlm-engine');
  assert.equal(pipeline.outputDir, 'D:/state/extracted/2601.1-v1');
});

test('builds Pipeline invocation parameters from MinerU config', () => {
  const paper = { baseId: '2601.2', arxivId: '2601.2v1', version: 1, sha256: 'b'.repeat(64), pdfPath: 'D:/paper/p.pdf' };
  const job = buildLocalParseJob(paper, {
    model: 'pipeline',
    cliBackend: 'pipeline',
    outputRoot: 'D:/state/extracted',
    pipelineMethod: 'txt',
    pipelineLanguage: 'en',
    formulaEnabled: false,
    tableEnabled: false,
  });
  assert.equal(job.method, 'txt');
  assert.equal(job.language, 'en');
  assert.equal(job.formula, false);
  assert.equal(job.table, false);
});
 
test('builds a local task manifest from the configured model without cloud tools', () => {
  const paper = { baseId: '2601.1', arxivId: '2601.1v1', version: 1, sha256: 'a'.repeat(64), pdfPath: 'D:/paper/p.pdf', pageCount: 8, title: 'Paper', authors: ['Ada Archive'], categories: ['cs.SE'], published: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z', primaryTrack: 'AI-FSD', matchedTracks: ['AI-FSD'] };
  const manifest = buildLocalParseManifest('run-1', [paper], {
    model: 'vlm',
    cliBackend: 'vlm-engine',
    outputRoot: 'D:/state/extracted',
    pipelineMethod: 'txt',
    pipelineLanguage: 'en',
    formulaEnabled: false,
    tableEnabled: true,
    expectedVersion: '3.4.5',
    expectedCommit: '4fe4bde114a23ee5dd637eae99b767f4669bf58c',
  });
  assert.equal(manifest.runId, 'run-1');
  assert.equal(manifest.model, 'vlm');
  assert.equal(manifest.cliBackend, 'vlm-engine');
  assert.equal(manifest.jobs.length, 1);
  assert.deepEqual(manifest.jobs[0], {
    baseId: '2601.1',
    arxivId: '2601.1v1',
    version: 1,
    sha256: 'a'.repeat(64),
    pageCount: 8,
    pdfPath: 'D:/paper/p.pdf',
    outputDir: 'D:/state/extracted/2601.1-v1',
    model: 'vlm',
    method: 'txt',
    language: 'en',
    formula: false,
    table: true,
    cliBackend: 'vlm-engine',
    title: 'Paper',
    authors: ['Ada Archive'],
    categories: ['cs.SE'],
    published: '2026-01-01T00:00:00Z',
    updated: '2026-01-02T00:00:00Z',
    primaryTrack: 'AI-FSD',
    matchedTracks: ['AI-FSD'],
    mineruVersion: '3.4.5',
    sourceCommit: '4fe4bde114a23ee5dd637eae99b767f4669bf58c',
  });
});

test('persists the source PDF page count in task manifests', () => {
  const paper = { baseId: '2601.1', arxivId: '2601.1v1', version: 1, sha256: 'a'.repeat(64), pdfPath: 'D:/paper/p.pdf', pageCount: 8 };
  const manifest = buildLocalParseManifest('run-page-count', [paper], {
    model: 'pipeline',
    cliBackend: 'pipeline',
    outputRoot: 'D:/state/extracted',
    pipelineMethod: 'auto',
    expectedVersion: '3.4.5',
    expectedCommit: 'commit',
  });
  assert.equal(manifest.jobs[0].pageCount, 8);
});

test('manifest metadata reaches source.json through the real parse boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-manifest-boundary-'));
  const pdfPath = join(root, 'paper.pdf');
  const body = await archiveTestPdf();
  await writeFile(pdfPath, body);
  const paper = {
    baseId: '2601.00002', arxivId: '2601.00002v1', version: 1,
    sha256: createHash('sha256').update(body).digest('hex'), pdfPath, pageCount: 1,
    title: 'Manifest Source', authors: ['Manifest Author'], categories: ['cs.SE'],
    matchedTracks: ['AI-FSD'], published: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z',
  };
  const outputRoot = join(root, 'archive');
  const manifest = buildLocalParseManifest('run-manifest-source', [paper], { ...archiveContext(root), model: 'pipeline', cliBackend: 'pipeline', outputRoot, pipelineMethod: 'auto' });
  const store = {
    reserveParseAttempt: () => ({ attemptId: 'attempt-manifest-source' }), startParseAttempt: () => {},
    finishParseAttempt: () => {}, markParsed: () => {}, hasSuccessfulParse: () => false,
  };
  try {
    await runParseManifest('run-manifest-source', manifest, {
      parseOne: async (job) => runLocalParse({ ...job, fileSource: job.pdfPath }, {
        store,
        runner: async (parseJob) => {
          await writeFile(join(parseJob.outputDir!, 'paper.md'), '# Manifest Source');
          await writeFile(join(parseJob.outputDir!, 'paper_content_list.json'), JSON.stringify([{ page_idx: 0, type: 'text', text: 'manifest source' }]));
          return { exitCode: 0 };
        },
        assessExtraction: () => ({ accepted: true }),
      }),
    });
    const source = JSON.parse(await readFile(join(outputRoot, '2601.00002-v1', 'source.json'), 'utf8'));
    assert.deepEqual(source.authors, ['Manifest Author']);
    assert.deepEqual(source.categories, ['cs.SE']);
    assert.deepEqual(source.matchedTracks, ['AI-FSD']);
    assert.equal(source.published, '2026-01-01T00:00:00Z');
    assert.equal(source.updated, '2026-01-02T00:00:00Z');
    assert.equal(source.parseAttemptId, 'attempt-manifest-source');
  } finally { await removeOwnedTestDirectory(root); }
});

for (const [label, stderrSummary, expected] of [
  ['timeout', 'process timed out', 'timeout'],
  ['cuda OOM', 'CUDA out of memory', 'cuda_oom'],
  ['dependency', 'ModuleNotFoundError: paddle', 'dependency'],
  ['missing model', 'model file missing', 'model_missing'],
]) {
  test(`classifies ${label} without normalize, note, or fallback`, async () => {
    const store = {
      paperStatus: 'downloaded', failure: { errorClass: '' },
      reserveParseAttempt: () => ({ attemptId: `attempt-${expected}` }),
      failParseAttempt: (_id: string, error: { errorClass: string }) => { store.failure = error; },
      markParseFailed: () => { store.paperStatus = 'parse_failed'; },
    };
    const job = { baseId: '2601.1', version: 1, sha256: 'a'.repeat(64), model: 'vlm', cliBackend: 'vlm-engine' };
    const report = await runLocalParse(job, {
      store,
      runner: async () => ({ exitCode: 1, stderrSummary }),
      normalize: async () => { throw new Error('must not normalize'); },
      writeNote: async () => { throw new Error('must not write note'); },
    });
    assert.equal(report.status, 'failed');
    assert.equal(report.errorClass, expected);
    assert.equal(store.failure.errorClass, expected);
    assert.equal(store.paperStatus, 'parse_failed');
  });
}
test('non-reparse skips any already parsed paper before reserving or running', async () => {
  let reserves = 0;
  let runs = 0;
  const store = {
    paperStatus: 'parsed',
    reserveParseAttempt: () => { reserves += 1; return { attemptId: 'should-not-exist' }; },
    hasSuccessfulParse: () => false,
    findByBaseId: () => ({ status: 'parsed' }),
  };
  const report = await runLocalParse({ baseId: '2601.1', version: 1, sha256: 'a'.repeat(64), model: 'vlm', cliBackend: 'vlm-engine' }, {
    store,
    runner: async () => { runs += 1; return { exitCode: 1 }; },
  });
  assert.equal(report.status, 'skipped');
  assert.equal(reserves, 0);
  assert.equal(runs, 0);
});
test('a concurrent reservation loss skips without invoking the runner', async () => {
  let runnerCalls = 0;
  let markParsedCalls = 0;
  const store = {
    paperStatus: 'downloaded',
    hasSuccessfulParse: () => false,
    findByBaseId: () => ({ status: 'downloaded' }),
    reserveParseAttempt: () => null,
    markParsed: () => { markParsedCalls += 1; },
  };
  const report = await runLocalParse({ baseId: '2601.11', version: 1, sha256: '1'.repeat(64), model: 'pipeline', cliBackend: 'pipeline' }, {
    store,
    runner: async () => { runnerCalls += 1; return { exitCode: 0 }; },
  });
  assert.equal(report.status, 'skipped');
  assert.equal(runnerCalls, 0);
  assert.equal(markParsedCalls, 0);
});

test('redacts returned and persisted CLI failure messages', async () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.secret', version: 1, sha256: 's'.repeat(64), status: 'downloaded' });
  try {
    const raw = 'token=tok-secret password:pw-secret api-key=key-secret Bearer bearer-secret https://secret.example/config.json';
    const report = await runLocalParse({ baseId: '2601.secret', version: 1, sha256: 's'.repeat(64), model: 'pipeline', cliBackend: 'pipeline' }, {
      store,
      runner: async () => ({ exitCode: 1, stderrSummary: raw }),
    });
    const attempt = store.findParseAttempt({ baseId: '2601.secret', version: 1, sha256: 's'.repeat(64), model: 'pipeline', method: 'auto' });
    assert.equal(report.status, 'failed');
    assert.ok(attempt); assert.ok(report.errorMessage); assert.ok(attempt.errorMessage);
    assert.equal(report.errorMessage, attempt.errorMessage);
    for (const secret of ['tok-secret', 'pw-secret', 'key-secret', 'bearer-secret']) {
      assert.doesNotMatch(report.errorMessage, new RegExp(secret));
      assert.doesNotMatch(attempt.errorMessage, new RegExp(secret));
    }
    assert.doesNotMatch(report.errorMessage, /https:\/\/secret\.example/);
  } finally { store.close(); }
});
test('runLocalParse redacts five-backslash escaped config before returning and persisting', async () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.19', version: 1, sha256: 't'.repeat(64), status: 'downloaded' });
  try {
    const raw = String.raw`config=\"{\"message\":\"literal } ends __FIVE__,\"safe_after\":\"job-five-leak\",\"api_key\":\"job-five-secret\"}\" trailing`
      .replace('__FIVE__', `${'\\'.repeat(5)}"`);
    const report = await runLocalParse({ baseId: '2601.19', version: 1, sha256: 't'.repeat(64), model: 'pipeline', cliBackend: 'pipeline' }, {
      store,
      runner: async () => ({ exitCode: 1, stderrSummary: raw }),
    });
    const attempt = store.findParseAttempt({ baseId: '2601.19', version: 1, sha256: 't'.repeat(64), model: 'pipeline', method: 'auto' });
    assert.equal(report.errorMessage, 'config=[redacted] trailing');
    assert.ok(attempt); assert.ok(report.errorMessage);
    assert.equal(attempt.errorMessage, report.errorMessage);
    assert.doesNotMatch(report.errorMessage, /literal \} ends|job-five-leak|job-five-secret/);
  } finally { store.close(); }
});
test('runLocalParse redacts escaped config after ordinary backslash text', async () => {
  const store = openStateStore(':memory:');
  store.upsertDiscovered({ baseId: '2601.21', version: 1, sha256: 'u'.repeat(64), status: 'downloaded' });
  try {
    const raw = String.raw`config=\"{\"message\":\"line\\nnext } still\",\"safe_after\":\"job-newline-leak\",\"api_key\":\"job-newline-secret\"}\" trailing`;
    const report = await runLocalParse({ baseId: '2601.21', version: 1, sha256: 'u'.repeat(64), model: 'pipeline', cliBackend: 'pipeline' }, {
      store,
      runner: async () => ({ exitCode: 1, stderrSummary: raw }),
    });
    const attempt = store.findParseAttempt({ baseId: '2601.21', version: 1, sha256: 'u'.repeat(64), model: 'pipeline', method: 'auto' });
    assert.equal(report.errorMessage, 'config=[redacted] trailing');
    assert.ok(attempt); assert.ok(report.errorMessage);
    assert.equal(attempt.errorMessage, report.errorMessage);
    assert.doesNotMatch(report.errorMessage, /line|job-newline-leak|job-newline-secret/);
  } finally { store.close(); }
});



test('a failed explicit reparse preserves an existing parsed paper', async () => {
  const store = {
    paperStatus: 'parsed',
    reserveParseAttempt: () => ({ attemptId: 'attempt-2' }),
    hasSuccessfulParse: () => true,
    failParseAttempt: () => {},
    markParseFailed: () => { store.paperStatus = 'parse_failed'; },
  };
  const report = await runLocalParse({ baseId: '2601.1', version: 1, sha256: 'a'.repeat(64), model: 'vlm', cliBackend: 'vlm-engine', reparse: true }, {
    store,
    runner: async () => ({ exitCode: 1, stderrSummary: 'CUDA out of memory' }),
    normalize: async () => { throw new Error('must not normalize'); },
    writeNote: async () => { throw new Error('must not write note'); },
  });
  assert.equal(report.status, 'failed');
  assert.equal(store.paperStatus, 'parsed');
});
test('a failed reparse preserves a parsed paper even without a parse-attempt record', async () => {
  const store = {
    paperStatus: 'parsed',
    reserveParseAttempt: () => ({ attemptId: 'attempt-legacy' }),
    failParseAttempt: () => {},
    markParseFailed: () => { store.paperStatus = 'parse_failed'; },
  };
  const report = await runLocalParse({ baseId: '2601.1', version: 1, sha256: 'a'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', reparse: true }, {
    store,
    runner: async () => ({ exitCode: 1, stderrSummary: 'timed out' }),
  });
  assert.equal(report.status, 'failed');
  assert.equal(store.paperStatus, 'parsed');
});

test('requires markdown, structured content, page count, and page-marked text before finishing attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-parse-invalid-'));
  const calls: (string | unknown[])[] = [];
  const store = {
    reserveParseAttempt: () => ({ attemptId: 'attempt-invalid' }),
    failParseAttempt: (_id: string, error: { errorClass: string }) => { calls.push(['fail', error]); },
    markParseFailed: () => calls.push(['paper-failed']),
    hasSuccessfulParse: () => false,
  };
  try {
    const report = await runLocalParse({ baseId: '2601.1', version: 1, sha256: 'a'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', pageCount: 1 }, {
      store,
      runner: async () => ({ exitCode: 0, elapsedMs: 5 }),
      normalize: async () => ({ markdownPath: join(root, 'missing.md'), contentListPath: join(root, 'missing.json'), pageTextPath: join(root, 'missing.txt'), pageCount: 1 }),
      writeNote: async () => calls.push(['note']),
    });
    assert.equal(report.errorClass, 'invalid_artifact');
    assert.deepEqual(calls.map(([name]) => name), ['fail', 'paper-failed']);
  } finally { await removeOwnedTestDirectory(root); }
});

test('validates extraction before finishing the parse attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-parse-valid-'));
  const calls: (string | unknown[])[] = [];
  try {
    const paths = { markdownPath: join(root, 'full.md'), contentListPath: join(root, 'content-list.json'), pageTextPath: join(root, 'page-marked.txt') };
    await writeFile(paths.markdownPath, '# Paper\ntext');
    await writeFile(paths.contentListPath, '[{"page_idx":0,"text":"text"}]');
    await writeFile(paths.pageTextPath, '--- PAGE 1 ---\ntext\n');
    const store = {
      reserveParseAttempt: () => { calls.push('reserve'); return { attemptId: 'attempt-ok' }; },
      markParsed: (...args: unknown[]) => calls.push(['markParsed', ...args]),
      finishParseAttempt: (...args: unknown[]) => calls.push(['finish', ...args]),
      hasSuccessfulParse: () => false,
    };
    const artifact = { ...paths, pageCount: 1, pages: [{ pageNumber: 1, text: 'text' }] };
    const report = await runLocalParse({ baseId: '2601.1', version: 1, sha256: 'a'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', pageCount: 1, reparse: true }, {
      store,
      runner: async () => { calls.push('run'); return { exitCode: 0, elapsedMs: 5 }; },
      normalize: async () => { calls.push('normalize'); return artifact; },
      assessExtraction: (pages, metadata) => { calls.push(['assess', pages, metadata]); return { accepted: true, reasons: [] }; },
      writeNote: async () => { calls.push('note'); return join(root, 'note.md'); },
    });
    assert.equal(report.status, 'succeeded');
    assert.deepEqual(calls.slice(0, 5), ['reserve', 'run', 'normalize', ['assess', artifact.pages, { pageCount: 1 }], ['finish', 'attempt-ok', calls[4][2]]]);
  } finally { await removeOwnedTestDirectory(root); }
});
test('retries one rejected extraction with the same model using OCR', async () => {
  const methods: (string | undefined)[] = [];
  const attempts: (string | undefined)[] = [];
  const { root, artifact } = await validTestArtifact('ocr');
  const store = {
    reserveParseAttempt: (job: ParseAttemptInput) => { attempts.push(job.method); return { attemptId: `attempt-${attempts.length}` }; },
    failParseAttempt: () => {},
    finishParseAttempt: () => {},
    markParsed: () => {},
    hasSuccessfulParse: () => false,
  };
  try {
    const report = await runLocalParse({ baseId: '2601.ocr', version: 1, sha256: 'a'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', pageCount: 1, method: 'auto' }, {
      store,
      runner: async (job) => { methods.push(job.method); return { exitCode: 0, elapsedMs: 1 }; },
      normalize: async () => artifact,
      assessExtraction: (_pages, _meta, options) => options.isOcrAttempt ? { accepted: true } : { accepted: false, retryWithOcr: true, reasons: ['low text'] },
      writeNote: async () => 'note.md',
    });
    assert.equal(report.status, 'succeeded');
    assert.deepEqual(methods, ['auto', 'ocr']);
    assert.deepEqual(attempts, ['auto', 'ocr']);
  } finally { await removeOwnedTestDirectory(root); }
});

test('recovers a successful attempt after a result writer crash', async () => {
  let runnerCalls = 0;
  const store = {
    findSuccessfulParse: () => ({ attemptId: 'attempt-done', status: 'succeeded', markdownPath: 'full.md', contentListPath: 'content.json', pageTextPath: 'pages.txt', pageCount: 1 }),
    findByBaseId: () => ({ status: 'downloaded' }),
    reserveParseAttempt: () => { throw new Error('must not reserve'); },
  };
  const report = await runLocalParse({ baseId: '2601.recover', version: 1, sha256: 'a'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', method: 'auto' }, {
    store,
    runner: async () => { runnerCalls += 1; return { exitCode: 0 }; },
  });
  assert.equal(report.status, 'succeeded');
  assert.equal(report.attemptId, 'attempt-done');
  assert.equal(runnerCalls, 0);
});
test('distinguishes system memory from CUDA out of memory', async () => {
  const { classifyProcessFailure } = await import('../src/mineru/mineru-local-jobs.ts');
  assert.equal(classifyProcessFailure({ stderrSummary: 'MemoryError: cannot allocate host memory' }), 'system_memory');
  assert.equal(classifyProcessFailure({ stderrSummary: 'CUDA out of memory' }), 'cuda_oom');
});
for (const [code, expected] of [
  ['MINERU_API_UNAVAILABLE', 'mineru_api_unavailable'],
  ['MINERU_API_STARTUP_TIMEOUT', 'mineru_api_startup_timeout'],
  ['MINERU_API_PORT_IN_USE', 'mineru_api_port_in_use'],
] as const) {
  test(`classifies session error code ${code}`, async () => {
    const { classifyProcessFailure } = await import('../src/mineru/mineru-local-jobs.ts');
    assert.equal(classifyProcessFailure({ errorCode: code }), expected);
  });
}
test('classifies CUDA OutOfMemoryError before generic MemoryError', async () => {
  const { classifyProcessFailure } = await import('../src/mineru/mineru-local-jobs.ts');
  assert.equal(classifyProcessFailure({ stderrSummary: 'torch.cuda.OutOfMemoryError: CUDA out of memory' }), 'cuda_oom');
});
test('classifies a bare torch CUDA OutOfMemoryError as cuda_oom', async () => {
  const { classifyProcessFailure } = await import('../src/mineru/mineru-local-jobs.ts');
  assert.equal(classifyProcessFailure({ stderrSummary: 'torch.cuda.OutOfMemoryError' }), 'cuda_oom');
});

test('repairs and completes a parsed paper with an unfinished successful attempt', async () => {
  const calls: (string | unknown[])[] = [];
  const attempt = {
    attemptId: 'attempt-pending',
    status: 'pending',
    markdownPath: 'full.md',
    contentListPath: 'content.json',
    pageTextPath: 'pages.txt',
    pageCount: 1,
    outputDir: 'attempt-pending',
  };
  const store = {
    findSuccessfulParse: () => undefined,
    findParseAttempt: () => attempt,
    findByBaseId: () => ({ status: 'parsed', note_path: 'note.md' }),
    finishParseAttempt: (id: string, artifacts: ParseArtifacts) => { calls.push(['finish', id, artifacts]); return { ...attempt, status: 'succeeded' }; },
  };
  const report = await runLocalParse({
    baseId: '2601.pending', version: 1, sha256: 'p'.repeat(64), model: 'pipeline', cliBackend: 'pipeline',
  }, { store, runner: async () => { throw new Error('must not run'); } });
  assert.equal(report.status, 'succeeded');
  assert.equal(report.attemptId, 'attempt-pending');
  assert.deepEqual(calls.map(([name]) => name), ['finish']);
});

test('marks a reserved attempt running before invoking MinerU', async () => {
  const calls: (string | unknown[])[] = [];
  const store = {
    reserveParseAttempt: () => { calls.push('reserve'); return { attemptId: 'attempt-running' }; },
    startParseAttempt: (id: string) => { calls.push(['start', id]); return { attemptId: id, status: 'running' }; },
    failParseAttempt: () => {},
    markParseFailed: () => {},
    hasSuccessfulParse: () => false,
  };
  const report = await runLocalParse({
    baseId: '2601.running', version: 1, sha256: 'r'.repeat(64), model: 'pipeline', cliBackend: 'pipeline',
  }, { store, runner: async () => { calls.push('run'); return { exitCode: 1, stderrSummary: 'failed' }; } });
  assert.equal(report.status, 'failed');
  assert.deepEqual(calls.slice(0, 3), ['reserve', ['start', 'attempt-running'], 'run']);
});

test('successful MinerU parse records artifacts without writing semantic notes', async () => {
  const { root, artifact } = await validTestArtifact('knowledge-handoff');
  const events: string[] = [];
  const store = {
    hasSuccessfulParse: () => false,
    findSuccessfulParse: () => null,
    findParseAttempt: () => null,
    findByBaseId: () => ({ status: 'downloaded' }),
    reserveParseAttempt: () => ({ attemptId: 'attempt-1' }),
    startParseAttempt: () => events.push('start'),
    finishParseAttempt: () => events.push('finish'),
    markParsed: () => events.push('parsed'),
  };
  try {
    const result = await runLocalParse({
      baseId: '2608.1', arxivId: '2608.1v1', version: 1,
      sha256: 'a'.repeat(64), model: 'pipeline', cliBackend: 'pipeline',
    }, {
      store,
      runner: async () => ({ exitCode: 0, elapsedMs: 10 }),
      normalize: async () => artifact,
      assessExtraction: () => ({ accepted: true, retryWithOcr: false, reasons: [] }),
      writeNote: async () => events.push('note'),
    });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(events, ['start', 'finish']);
    assert.ok(result.artifact);
    assert.equal(result.artifact.notePath, undefined);
  } finally { await removeOwnedTestDirectory(root); }
});

test('routeParseLocal uses the injected MinerU session runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parse-session-route-'));
  const pdfPath = join(root, 'paper.pdf');
  const document = await PDFDocument.create();
  document.addPage();
  const body = Buffer.from(await document.save());
  await writeFile(pdfPath, body);
  const store = openStateStore(':memory:');
  const calls: string[] = [];
  const baseId = 'local-session';
  const mineruSession = {
    ensureReady: async () => 'http://127.0.0.1:17860',
    run: async (job: MinerUCliJob) => {
      calls.push(job.fileSource);
      await writeSessionArtifacts(job.outputDir, 'Parse Session');
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
    store.upsertDiscovered({ baseId, version: 1, title: 'Local session', authors: [], categories: [], published: '2026-09-03', updated: '2026-09-03' });
    store.markDownloaded(baseId, pdfPath, 'AI-FSD', createHash('sha256').update(body).digest('hex'));
    const report = await routeParseLocal(['--base-id', baseId], {
      root,
      mineruSession,
      stateStore: store,
      config: { ...archiveContext(root), stateRoot: root, outputRoot: join(root, 'archive'), model: 'pipeline', cliBackend: 'pipeline' },
    });
    assert.equal(report.status, 'succeeded');
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0], 'string');
    assert.ok(calls[0]);
  } finally {
    store.close();
    await removeOwnedTestDirectory(root);
  }
});
