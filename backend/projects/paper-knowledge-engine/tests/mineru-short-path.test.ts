import { archiveContext, archiveTestPdf } from './fixtures/library-paths.ts';
import { normalizeLocalMinerUResult } from '../src/mineru/mineru-local-result.ts';
import { removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';
import type { LocalParseJob, ProgressEvent } from '../src/types/jobs.ts';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { configureLayeredRuntimeFixture } from './fixtures/layered-config.ts';
import { loadMinerULocalConfig } from '../src/mineru/mineru-local-config.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildLocalParseJob, runLocalParse } from '../src/mineru/mineru-local-jobs.ts';
import { runMineruCli } from '../src/mineru/mineru-cli-runner.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { runParseManifest } from '../src/library/pipeline.ts';
import { formatProgressEvent } from '../src/cli/progress.ts';
import { createParseWorkspace, publishParseWorkspace } from '../src/mineru/mineru-workspace.ts';

const FIXED_API_URL = 'http://127.0.0.1:17860';

for (const scenario of ['denied', 'commit-rollback', 'destination-appeared', 'workspace-replaced', 'workspace-reparse'] as const) {
  test(`v2 publication fails closed: ${scenario}`, async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), 'mu-publish-'));
    const context = archiveContext(fixture);
    const source = join(fixture, 'input.pdf');
    let reparse: string | undefined;
    t.after(async () => { if (reparse) await rm(reparse); await removeOwnedTestDirectory(fixture); });
    const pdfBytes = await archiveTestPdf();
    await writeFile(source, pdfBytes);
    const job: LocalParseJob = { ...context, baseId: 'fixture', version: 1, model: 'pipeline', cliBackend: 'pipeline',
      sha256: createHash('sha256').update(pdfBytes).digest('hex'), parseAttemptId: 'attempt-fixture',
      fileSource: source, outputDir: join(context.libraryPaths.archiveRoot, 'fixture-v1'), pageCount: 1,
      arxivId: 'fixturev1', title: 'Synthetic fixture', authors: ['Fixture Author'], categories: ['cs.SE'],
      published: '2026-01-01', updated: '2026-01-01' };
    const workspace = await createParseWorkspace(job);
    await writeFile(join(workspace.root, 'paper.md'), 'new content');
    await writeFile(join(workspace.root, 'paper_content_list.json'), '[{"page_idx":0,"text":"fixture"}]');
    const artifact = await normalizeLocalMinerUResult({ ...job, outputDir: workspace.root });
    let attempts = 0, commits = 0;
    await assert.rejects(publishParseWorkspace(workspace, artifact, job, async () => {
      commits++; if (scenario === 'commit-rollback') throw new Error('commit rejected');
    }, async (from, to) => {
      attempts++;
      if (scenario === 'commit-rollback') { await rename(from, to); return; }
      if (scenario === 'destination-appeared') { await mkdir(to); await writeFile(join(to, 'marker'), 'external'); }
      if (scenario === 'workspace-replaced' || scenario === 'workspace-reparse') {
        const held = workspace.root + '-held'; await rename(workspace.root, held);
        if (scenario === 'workspace-reparse') { await symlink(held, workspace.root, 'junction'); reparse = workspace.root; }
        else { await mkdir(workspace.root); await writeFile(join(workspace.root, 'marker'), 'external'); }
      }
      throw Object.assign(new Error('install denied'), { code: 'EPERM' });
    }));
    assert.equal(attempts, 1);
    assert.equal(commits, scenario === 'commit-rollback' ? 1 : 0);
    if (scenario === 'destination-appeared') assert.equal(await readFile(join(workspace.destination, 'marker'), 'utf8'), 'external');
    else await assert.rejects(readFile(join(workspace.destination, 'manifest.json')), /ENOENT/);
    if (scenario === 'workspace-replaced') assert.equal(await readFile(join(workspace.root, 'marker'), 'utf8'), 'external');
  });
}

test('builds one flat per-paper result directory using the configured root', () => {
  const paper = { baseId: '2512.20660', arxivId: '2512.20660v2', sha256: 'a'.repeat(64), version: 2, pdfPath: 'paper.pdf' };
  for (const model of ['pipeline', 'vlm']) {
    const job = buildLocalParseJob(paper, { outputRoot: 'D:/custom/extracted', model, cliBackend: model === 'pipeline' ? 'pipeline' : 'vlm-engine' });
    assert.equal(job.outputDir, 'D:/custom/extracted/2512.20660-v2');
  }
});

test('stages a short input name, publishes validated artifacts and preserves them after a failed reparse', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mu-path-'));
  const store = openStateStore(':memory:');
  t.after(async () => { store.close(); await removeOwnedTestDirectory(root); });
  const source = join(root, `2512.20660v2_${'Long-Title-'.repeat(10)}.pdf`);
  const body = await archiveTestPdf();
  await writeFile(source, body);
  const paper = { baseId: '2512.20660', arxivId: '2512.20660v2', version: 2, pdfPath: source, pageCount: 1, sha256: createHash('sha256').update(body).digest('hex'),
    title: 'Synthetic short-path fixture', authors: ['Fixture Author'], categories: ['cs.SE'], published: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };
  store.upsertDiscovered(paper); store.markDownloaded(paper.baseId, source, 'AI-FSD', paper.sha256);
  const config = { ...archiveContext(root), outputRoot: join(root, 'archive'), model: 'pipeline', cliBackend: 'pipeline' };
  const job = buildLocalParseJob(paper, config);
  let stagedPath: string | undefined;
  const runner = async (staged: LocalParseJob) => {
    assert.ok(staged.fileSource); assert.ok(staged.outputDir);
    stagedPath = staged.fileSource;
    assert.equal(basename(staged.fileSource), '2512.20660v2.pdf');
    assert.deepEqual(await readFile(staged.fileSource), body);
    const dir = join(staged.outputDir, '2512.20660v2', 'auto');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '2512.20660v2.md'), '# Paper\ntext');
    await writeFile(join(dir, '2512.20660v2_content_list.json'), '[{"page_idx":0,"text":"text"}]');
    return { exitCode: 0, elapsedMs: 10 };
  };
  const result = await runLocalParse(job, { store, config, runner });
  assert.equal(result.status, 'succeeded', result.errorMessage ?? 'expected success');
  assert.ok(result.artifact?.markdownPath);
  assert.equal(result.artifact.markdownPath, join(root, 'archive', '2512.20660-v2', 'document.md'));
  assert.equal(await readFile(result.artifact.markdownPath, 'utf8'), '# Paper\ntext');
  assert.ok(stagedPath); await assert.rejects(readFile(stagedPath), /ENOENT/);
  assert.deepEqual(await readdir(join(config.outputRoot)), ['2512.20660-v2']);
  const failed = await runLocalParse({ ...job, reparse: true }, { store, config, runner: async () => ({ exitCode: 1, stderrSummary: 'deliberate failure' }) });
  assert.equal(failed.status, 'failed');
  assert.equal(await readFile(result.artifact.markdownPath, 'utf8'), '# Paper\ntext');
  assert.deepEqual(await readdir(join(config.outputRoot)), ['2512.20660-v2']);
  const replaced = await runLocalParse({ ...job, reparse: true }, { store, config, runner });
  assert.equal(replaced.status, 'failed');
  assert.match(replaced.errorMessage!, /conflict/i);
  assert.equal(replaced.artifact, null);
  const earlier = store.findSuccessfulParse({ baseId: paper.baseId, version: paper.version, sha256: paper.sha256, model: 'pipeline', method: 'auto' });
  assert.ok(earlier); assert.equal(earlier.attemptId, result.attemptId);
  const failedCommit = await runLocalParse({ ...job, reparse: true }, {
    store: { ...store, finishParseAttempt: () => { throw new Error('database unavailable'); } }, config, runner,
  });
  assert.equal(failedCommit.status, 'failed');
  assert.equal(await readFile(result.artifact.markdownPath, 'utf8'), '# Paper\ntext');
  const superseded = await runLocalParse({ ...job, reparse: true }, {
    store, config, runner: async (staged: LocalParseJob) => {
    assert.ok(staged.fileSource); assert.ok(staged.outputDir);
      const result = await runner(staged);
      store.upsertDiscovered({ ...paper, version: 3, arxivId: '2512.20660v3' });
      return result;
    },
  });
  assert.equal(superseded.status, 'failed');
  assert.ok(superseded.errorMessage); assert.match(superseded.errorMessage, /旧版本|superseded|stale/i);
  assert.equal(await readFile(result.artifact.markdownPath, 'utf8'), '# Paper\ntext');
});

test('a reclaimed attempt cannot commit a successful parse', () => {
  const store = openStateStore(':memory:');
  try {
    store.upsertDiscovered({ baseId: '2512.20660', version: 2, sha256: 'a' });
    const attempt = store.reserveParseAttempt({ baseId: '2512.20660', version: 2, sha256: 'a', model: 'pipeline', cliBackend: 'pipeline' });
    assert.ok(attempt); store.failParseAttempt(attempt.attemptId, { errorClass: 'stale_reclaimed', errorMessage: 'reclaimed' });
    assert.throws(() => store.finishParseAttempt(attempt.attemptId, {}), /stale|inactive|失效/i);
  } finally { store.close(); }
});

test('rejects a too-long output path before starting MinerU', async (t) => {
  const fixture = await makeRuntimeFixture(); t.after(() => fixture.dispose());
  await configureLayeredRuntimeFixture(fixture);
  const config = { ...loadMinerULocalConfig(fixture.projectRoot), tempRoot: fixture.paths.tempRoot };
  let started = false;
  await assert.rejects(runMineruCli({ model: 'pipeline', fileSource: 'D:/paper/2512.20660v2.pdf', outputDir: `D:/${'x'.repeat(235)}` }, {
    apiUrl: FIXED_API_URL,
    config, processContext: { safetyRoot: join(fixture.paths.stateRoot, 'locks', 'processes'), policy: { processCleanupTimeoutMs: 1800, diagnosticTimeoutMs: 5000, maxOutputBytes: 16384 } },
    managedProcess: async () => { started = true; throw new Error('must not launch'); },
  }), /路径过长|path too long/i);
  assert.equal(started, false);
});

test('failed parse reports expose the cause and attempt id in terminal output', async () => {
  const events: ProgressEvent[] = [];
  await assert.rejects(runParseManifest('r', { runId: 'r', jobs: [{ baseId: '2512.20660', model: 'pipeline' }] }, {
    onProgress: (event: ProgressEvent) => events.push(event),
    parseOne: async () => ({ status: 'failed', errorClass: 'path_too_long', errorMessage: '输出路径过长', attemptId: 'attempt-123' }),
  }), /输出路径过长/);
  const lines = events.map(formatProgressEvent).join('\n');
  assert.match(lines, /path_too_long/);
  assert.match(lines, /输出路径过长/);
  assert.match(lines, /attempt-123/);
});
