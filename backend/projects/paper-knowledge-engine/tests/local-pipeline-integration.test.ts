import { archiveContext } from './fixtures/library-paths.ts';
import { removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';
import type { LocalParseJob } from '../src/types/jobs.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLocalParse } from '../src/mineru/mineru-local-jobs.ts';
import { routeParseLocal } from '../src/cli/routes.ts';
import { createHash } from 'node:crypto';
import { openStateStore } from '../src/library/state/state-store.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
const testProcessContext = (root: string) => ({ safetyRoot: join(root, 'locks', 'processes'), policy: { processCleanupTimeoutMs: 1800, diagnosticTimeoutMs: 5000, maxOutputBytes: 16384 } });

for (const representation of ['prototype', 'own'] as const) test(`parse route preserves ${representation} store methods and their original receiver`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'parse-store-receiver-'));
  class InjectedStore {
    #lookups = 0;
    #reservations = 0;
    #closed = false;
    async findByBaseId() {
      await Promise.resolve();
      this.#lookups++;
      return { base_id: '2608.1', version: 1, sha256: 'a'.repeat(64), pdf_path: join(root, 'paper.pdf'), page_count: 1 };
    }
    reserveParseAttempt() { this.#reservations++; return null; }
    close() { this.#closed = true; }
    get counts() { return { lookups: this.#lookups, reservations: this.#reservations, closed: this.#closed }; }
  }
  const store = new InjectedStore();
  if (representation === 'own') Object.defineProperty(store, 'reserveParseAttempt', {
    value: store.reserveParseAttempt, enumerable: true,
  });
  try {
    const report = await routeParseLocal(['--base-id', '2608.1'], {
      processContext: testProcessContext(root),
      config: { ...archiveContext(root), outputRoot: join(root, 'archive'), model: 'pipeline', cliBackend: 'pipeline' },
      stateStore: store,
      runner: async () => assert.fail('a declined reservation must not invoke MinerU'),
    });
    assert.equal(report.status, 'skipped');
    assert.equal(report.baseId, '2608.1');
    // Route lookup, unfinished-write recovery lookup, then the existing-success gate.
    assert.deepEqual(store.counts, { lookups: 3, reservations: 1, closed: false });
  } finally { store.close(); await removeOwnedTestDirectory(root); }
});

test('parse route awaits asynchronous store lookup when recovering a finished write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parse-async-store-'));
  let reads = 0;
  try {
    const report = await routeParseLocal(['--base-id', '2608.1'], {
      processContext: testProcessContext(root),
      config: { ...archiveContext(root), outputRoot: join(root, 'archive'), model: 'pipeline', cliBackend: 'pipeline' },
      stateStore: {
        findByBaseId: async () => ({ base_id: '2608.1', version: 1, sha256: 'a'.repeat(64), pdf_path: join(root, 'paper.pdf'), page_count: 1, status: ++reads === 1 ? 'downloaded' : 'parsed' }),
        findParseAttempt: () => ({ attemptId: 'pending', status: 'running', markdownPath: join(root, 'paper.md'), contentListPath: join(root, 'content.json'), pageTextPath: join(root, 'pages.txt'), pageCount: 1 }),
        finishParseAttempt: () => {},
        reserveParseAttempt: () => assert.fail('must recover the completed write without parsing again'),
      },
      runner: async () => assert.fail('must not invoke MinerU during recovery'),
    });
    assert.equal(report.status, 'succeeded');
    assert.equal(report.attemptId, 'pending');
    assert.equal(reads, 2);
  } finally { await removeOwnedTestDirectory(root); }
});


test('direct local parse carries identity through artifact validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-parse-'));
  try {
    const paths = { markdownPath: join(root, 'full.md'), contentListPath: join(root, 'content.json'), pageTextPath: join(root, 'pages.txt') };
    await writeFile(paths.markdownPath, '# paper');
    await writeFile(paths.contentListPath, '[{"page_idx":0,"text":"paper"}]');
    await writeFile(paths.pageTextPath, '--- PAGE 1 ---\npaper');
    const job = { baseId: '2601.5', version: 2, sha256: 'c'.repeat(64), model: 'pipeline', cliBackend: 'pipeline', pageCount: 1 };
    const store = {
      reserveParseAttempt: () => ({ attemptId: 'attempt-flow' }),
      startParseAttempt: () => ({ attemptId: 'attempt-flow', status: 'running' }),
      hasSuccessfulParse: () => false,
      finishParseAttempt: () => {},
    };
    const parsed = await runLocalParse(job, {
      store,
      runner: async () => ({ exitCode: 0 }),
      normalize: async () => ({ ...paths, pageCount: 1, pages: [{ pageNumber: 1, text: 'paper' }] }),
      assessExtraction: () => ({ accepted: true }),
    });
    assert.equal(parsed.status, 'succeeded');
    assert.deepEqual(
      Object.fromEntries((['baseId', 'version', 'sha256', 'model', 'cliBackend'] as const).map((key) => [key, parsed[key]])),
      Object.fromEntries((['baseId', 'version', 'sha256', 'model', 'cliBackend'] as const).map((key) => [key, job[key]])),
    );
  } finally {
    await removeOwnedTestDirectory(root);
  }
});
test('CLI parse-local route requires base id and passes only explicit reparse', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'parse-route-'));
  t.after(() => removeOwnedTestDirectory(root));
  const pdfPath = join(root, 'paper.pdf');
  const body = Buffer.from('%PDF-test'); await writeFile(pdfPath, body);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const calls: LocalParseJob[] = [];
  const store = { reserveParseAttempt: () => ({ attemptId: 'attempt-route' }), failParseAttempt() {}, markParseFailed() {}, findByBaseId: (id: string) => ({ base_id: id, baseId: id, arxiv_id: `${id}v1`, arxivId: `${id}v1`, version: 1, sha256, pdf_path: pdfPath, page_count: 4 }) };
  await assert.rejects(routeParseLocal([], { root: 'D:/agent-data', config: { model: 'pipeline', cliBackend: 'pipeline', outputRoot: 'D:/state/extracted' }, stateStore: store, runner: async (job: LocalParseJob) => { calls.push(job); return { exitCode: 1, stderrSummary: 'expected test failure' }; } }), /--base-id/);
  const report = await routeParseLocal(['--base-id', '2601.1', '--reparse'], { root, processContext: testProcessContext(root), config: { ...archiveContext(root), model: 'pipeline', cliBackend: 'pipeline', outputRoot: join(root, 'archive') }, stateStore: store, runner: async (job: LocalParseJob) => { calls.push(job); return { exitCode: 1, stderrSummary: 'expected test failure' }; } });
  assert.equal(calls[0].reparse, true);
});
test('CLI report serialization contains no raw credentials or trailing config from a failed run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'parse-redact-'));
  t.after(() => removeOwnedTestDirectory(root));
  const pdfPath = join(root, 'paper.pdf');
  const body = Buffer.from('%PDF-test'); await writeFile(pdfPath, body);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const store = {
    reserveParseAttempt: () => ({ attemptId: 'attempt-redaction' }),
    failParseAttempt() {},
    markParseFailed() {},
    findByBaseId: () => ({ base_id: '2601.10', arxiv_id: '2601.10v1', version: 1, sha256, pdf_path: pdfPath, page_count: 1 }),
  };
  const report = await routeParseLocal(['--base-id', '2601.10'], {
    processContext: testProcessContext(root),
    config: { ...archiveContext(root), model: 'pipeline', cliBackend: 'pipeline', outputRoot: join(root, 'archive') },
    stateStore: store,
    runner: async () => ({
      exitCode: 1,
      stderrSummary: String.raw`config=\"{\"message\":\"escaped quote: \\\" and literal } brace\",\"safe_after\":\"cli-leak-marker\",\"api_key\":\"cli-secret\"}\" trailing`,
    }),
  });
  const stdout = JSON.stringify(report);
  assert.equal(report.status, 'failed');
  assert.ok(report.errorMessage); assert.match(report.errorMessage, /trailing/);
  assert.doesNotMatch(stdout, /escaped quote|literal \} brace|cli-leak-marker|cli-secret/);
});

test('parse-local keeps its owned SQLite connection open until the async parse finishes', async (t) => {
  const { PDFDocument } = await import('pdf-lib');
  const root = await mkdtemp(join(tmpdir(), 'parse-owned-'));
  t.after(() => removeOwnedTestDirectory(root));
  const doc = await PDFDocument.create(); doc.addPage();
  const body = Buffer.from(await doc.save());
  const pdfPath = join(root, '2601.12v1.pdf'); await writeFile(pdfPath, body);
  await writeLayeredConfigFixture({ root });
  const paths = loadEngineContext({ root }).paths;
  await mkdir(paths.dataRoot, { recursive: true });
  const store = openStateStore(paths.databasePath);
  store.upsertDiscovered({ baseId: '2601.12', version: 1 });
  store.markDownloaded('2601.12', pdfPath, 'AI-FSD', createHash('sha256').update(body).digest('hex'));
  store.close();
  const result = await routeParseLocal(['--base-id', '2601.12'], {
    root,
    processContext: testProcessContext(root),
    config: { ...archiveContext(root), stateRoot: root, outputRoot: join(root, 'archive'), model: 'pipeline', cliBackend: 'pipeline' },
    runner: async () => ({ exitCode: 1, stderrSummary: 'controlled runner failure' }),
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.errorMessage); assert.match(result.errorMessage, /controlled runner failure/);
});
