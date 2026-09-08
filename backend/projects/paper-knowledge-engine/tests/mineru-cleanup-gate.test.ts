import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir, writeFile, rename, mkdir, readFile, symlink, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { runLocalParse } from '../src/mineru/mineru-local-jobs.ts';
import { runParseManifest } from '../src/library/pipeline.ts';
import { archiveContext, archiveTestPdf } from './fixtures/library-paths.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { verifyArchiveV2 } from '../src/shared/archive-v2.ts';

for (const blockedDiagnostics of [false, true]) test(`committed parse survives workspace cleanup failure (diagnostics blocked=${blockedDiagnostics})`, async () => {
  const f = await makeRuntimeFixture();
  const store = openStateStore(join(f.paths.stateRoot, 'cleanup.sqlite'));
  let workspace = '', diagnostics = '';
  try {
    const context = archiveContext(f.paths.stateRoot);
    const pdf = await archiveTestPdf(), fileSource = join(f.paths.pdfRoot, 'cleanup.pdf');
    await writeFile(fileSource, pdf);
    const job = { ...context, baseId: 'local-cleanup', version: 1, sourceType: 'local_pdf' as const,
      title: 'Cleanup paper', parserConfigKey: 'pipeline-auto', model: 'pipeline', cliBackend: 'pipeline', method: 'auto',
      sha256: createHash('sha256').update(pdf).digest('hex'), fileSource,
      outputDir: join(context.libraryPaths.archiveRoot, 'local-cleanup-v1') };
    store.upsertDiscovered({ baseId: job.baseId, version: 1, title: job.title });
    store.markDownloaded(job.baseId, fileSource, 'AI-FSD', job.sha256, 1);
    const external = join(f.root, 'untouched'); await mkdir(external);
    await writeFile(join(external, 'marker'), 'untouched');
    const result = await runLocalParse(job, {
      store: { ...store, finishParseAttempt: async (id, artifact) => {
        const committed = store.finishParseAttempt(id, artifact); // Real SQLite COMMIT first.
        workspace = join(context.libraryPaths.workRoot, 'parsing', id);
        diagnostics = join(context.libraryPaths.workRoot, 'diagnostics', id);
        await symlink(external, join(workspace, 'cleanup-link'), 'junction');
        if (blockedDiagnostics) {
          await mkdir(diagnostics, { recursive: true }); await writeFile(join(diagnostics, 'marker'), 'existing diagnostic');
        }
        return committed;
      } },
      runner: async job => {
        await writeFile(join(job.outputDir!, 'paper.md'), '# Committed paper');
        await writeFile(join(job.outputDir!, 'paper_content_list.json'), '[{"type":"text","page_idx":0,"text":"Paper"}]');
        return { exitCode: 0, cleanupConfirmed: true };
      },
      assessExtraction: () => ({ accepted: true }),
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.errorClass, null);
    assert.equal(store.findSuccessfulParse(job)?.status, 'succeeded');
    assert.equal(store.findParseAttempt(job)?.errorClass, null);
    assert.equal((await verifyArchiveV2(job.outputDir)).source.parseAttemptId, result.attemptId);
    assert.deepEqual(result.artifact?.cleanupPending, {
      reason: 'workspace_cleanup_failed', path: blockedDiagnostics ? workspace : diagnostics,
    });
    assert.ok((await lstat(join(blockedDiagnostics ? workspace : diagnostics, 'cleanup-link'))).isSymbolicLink());
    assert.equal(await readFile(join(external, 'marker'), 'utf8'), 'untouched');
    if (blockedDiagnostics) assert.equal(await readFile(join(diagnostics, 'marker'), 'utf8'), 'existing diagnostic');
  } finally {
    for (const root of [workspace, diagnostics]) if (root) {
      const link = join(root, 'cleanup-link');
      if ((await lstat(link).catch(() => null))?.isSymbolicLink()) await unlink(link);
    }
    store.close(); await f.dispose();
  }
});

for (const throws of [false, true]) test(`uncertain cleanup preserves workspace and stops manifest (throw=${throws})`, async () => {
  const f = await makeRuntimeFixture();
  try {
    const pdf = join(f.paths.pdfRoot, 'synthetic.pdf');
    await writeFile(pdf, '%PDF-fixture');
    let calls = 0; let normalized = 0; let failed: unknown;
    const store = {
      reserveParseAttempt: () => ({ attemptId: 'one' }),
      failParseAttempt: (_id: string, value: unknown) => { failed = value; },
      markParseFailed() {},
    };
    const job = { ...archiveContext(f.paths.stateRoot), baseId: 'one', version: 1, model: 'pipeline', cliBackend: 'pipeline', sha256: createHash('sha256').update('%PDF-fixture').digest('hex'), fileSource: pdf, outputDir: join(f.paths.stateRoot, 'archive', 'one-v1'), method: 'auto' };
    const parseOne = (localJob: typeof job) => runLocalParse(localJob, {
      store,
      runner: async () => {
        calls++;
        if (throws) throw Object.assign(new Error('cleanup unknown'), { code: 'PROCESS_CLEANUP_UNCONFIRMED', cleanupConfirmed: false });
        return { exitCode: 0, cleanupConfirmed: false, errorCode: 'PROCESS_CLEANUP_UNCONFIRMED', stderrSummary: 'cleanup unknown' };
      },
      normalize: async () => { normalized++; throw Object.assign(new Error('must not normalize'), { retryWithOcr: true }); },
    });
    await assert.rejects(runParseManifest('run', { runId: 'run', jobs: [job, { ...job, baseId: 'two' }] }, { parseOne }), /cleanup unknown/);
    assert.equal(calls, 1);
    assert.equal(normalized, 0);
    assert.equal((failed as { errorClass: string }).errorClass, 'process_cleanup_unconfirmed');
    assert.deepEqual(await readdir(join(job.libraryPaths.workRoot, 'parsing')), ['one']);
    await access(pdf);
  } finally { await f.dispose(); }
});

test('confirmed process failure retains its workspace only under diagnostics', async () => {
  const f = await makeRuntimeFixture();
  try {
    const pdf = join(f.paths.pdfRoot, 'synthetic.pdf'); await writeFile(pdf, '%PDF-fixture');
    const job = { ...archiveContext(f.paths.stateRoot), baseId: 'one', version: 1, model: 'pipeline', cliBackend: 'pipeline',
      sha256: createHash('sha256').update('%PDF-fixture').digest('hex'), fileSource: pdf,
      outputDir: join(f.paths.stateRoot, 'archive', 'one-v1') };
    const result = await runLocalParse(job, { store: { reserveParseAttempt: () => ({ attemptId: 'failed' }) },
      runner: async () => ({ exitCode: 1, cleanupConfirmed: true, stderrSummary: 'deliberate failure' }) });
    assert.equal(result.status, 'failed');
    await access(join(job.libraryPaths.workRoot, 'diagnostics', 'failed', 'onev1.pdf'));
    assert.deepEqual(await readdir(join(job.libraryPaths.workRoot, 'parsing')), []);
  } finally { await f.dispose(); }
});

test('process failure cannot relocate a workspace replaced during parsing', async () => {
  const f = await makeRuntimeFixture();
  try {
    const pdf = join(f.paths.pdfRoot, 'synthetic.pdf'); await writeFile(pdf, '%PDF-fixture');
    const job = { ...archiveContext(f.paths.stateRoot), baseId: 'one', version: 1, model: 'pipeline', cliBackend: 'pipeline',
      sha256: createHash('sha256').update('%PDF-fixture').digest('hex'), fileSource: pdf,
      outputDir: join(f.paths.stateRoot, 'archive', 'one-v1') };
    const workspace = join(job.libraryPaths.workRoot, 'parsing', 'replaced');
    await assert.rejects(runLocalParse(job, { store: { reserveParseAttempt: () => ({ attemptId: 'replaced' }) },
      runner: async () => {
        await rename(workspace, workspace + '-held'); await mkdir(workspace);
        await writeFile(join(workspace, 'marker'), 'external');
        return { exitCode: 1, cleanupConfirmed: true };
      } }), /identity changed/);
    assert.equal(await readFile(join(workspace, 'marker'), 'utf8'), 'external');
  } finally { await f.dispose(); }
});
