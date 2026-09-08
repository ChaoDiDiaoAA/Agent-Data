import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';

import { routeEvidencePublish, routeParseLocal, routeReconcile, runConfiguredTask } from '../src/cli/routes.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';

async function seededLibrary() {
  const root = await mkdtemp(join(tmpdir(), 'cli-library-database-'));
  await writeLayeredConfigFixture({ root });
  const paths = loadEngineContext({ root }).paths;
  await mkdir(paths.dataRoot, { recursive: true });
  await mkdir(join(paths.workRoot, 'downloads'), { recursive: true });
  const document = await PDFDocument.create();
  document.addPage();
  const bytes = await document.save();
  const pdfPath = join(root, 'paper.pdf');
  await writeFile(pdfPath, bytes);
  const store = openStateStore(paths.databasePath);
  const baseId = '2609.00001';
  store.upsertDiscovered({ baseId, arxivId: `${baseId}v1`, version: 1, title: 'Shared database paper' });
  store.markDownloaded(baseId, pdfPath, 'AI-FSD', createHash('sha256').update(bytes).digest('hex'));
  const run = store.startRun({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, 'current');
  store.close();
  return { root, paths, baseId, runId: run.id };
}

test('configured collection reads the same library database as other entries', async () => {
  const fixture = await seededLibrary();
  try {
    await runConfiguredTask(['--mode', 'current'], fixture.root, {
      executeTask: async (_options, dependencies) => {
        const findByBaseId = dependencies.store.findByBaseId;
        assert.ok(findByBaseId);
        assert.equal(findByBaseId(fixture.baseId)?.base_id, fixture.baseId);
        return { status: 'completed', mode: 'current', runId: fixture.runId } as never;
      },
    });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('parse-local reads a downloaded paper from the shared library database', async () => {
  const fixture = await seededLibrary();
  try {
    const result = await routeParseLocal(['--base-id', fixture.baseId], {
      root: fixture.root,
      runner: async () => ({ exitCode: 1, stderrSummary: 'expected parser failure' }),
    });
    assert.equal(result.baseId, fixture.baseId);
    assert.equal(result.status, 'failed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('reconcile reads downloaded papers from the shared library database', async () => {
  const fixture = await seededLibrary();
  try {
    const result = await routeReconcile([], { root: fixture.root });
    assert.ok('retryParse' in result);
    assert.deepEqual(result.retryParse, [fixture.baseId]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('evidence-publish reads its run from the shared library database', async () => {
  const fixture = await seededLibrary();
  try {
    const result = await routeEvidencePublish(['--run-id', fixture.runId], {
      root: fixture.root,
      readVerifiedRunSources: async () => [],
      publishRunEvidence: async () => ({
        status: 'completed', publicationId: 'shared-database-publication', contentSha256: 'a'.repeat(64),
        receiptPath: 'receipt.json', receiptSha256: 'b'.repeat(64), sourceCount: 0,
        reservationReplayed: false, applyReplayed: false,
      }),
    });
    assert.equal(result.publicationId, 'shared-database-publication');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
