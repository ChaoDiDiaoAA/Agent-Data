import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { loadConfig, loadProjectPaths } from '../src/shared/config.ts';
import { downloadAcceptedPdf } from '../src/library/sources/pdf-store.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';
import { archiveTestPdf } from './fixtures/library-paths.ts';
import { removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';

test('configured PDF libraries derive by identity and downloads retain category outside internal work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-root-'));
  try {
    await writeLayeredConfigFixture({ root, additionalLibraryIds: ['other'] });
    for (const libraryId of ['fsd', 'other']) {
      const context = loadEngineContext({ root, libraryId });
      const config = loadConfig({ root, libraryId });
      assert.equal(context.machine.roots.pdfLibrariesRoot, join(root, 'pdf-libraries'));
      assert.equal(context.paths.pdfRoot, join(root, 'pdf-libraries', libraryId));
      assert.equal(config.pdfRoot, join(root, 'pdf-libraries', libraryId));
      assert.equal(loadProjectPaths({ root, libraryId }).pdfRoot, config.pdfRoot);
      assert.equal(context.paths.databasePath, join(root, 'data-libraries', libraryId, 'library.sqlite'));
      assert.equal(context.paths.archiveRoot, join(root, 'data-libraries', libraryId, 'archive'));
      const bytes = await archiveTestPdf();
      const result = await downloadAcceptedPdf({ accepted: true, primaryTrack: 'AI-FSD', paper: {
        baseId: '2609.00001', arxivId: '2609.00001v1', version: 1, title: 'Fixture', pdfUrl: 'https://example.invalid/paper.pdf',
      } }, { ...config, categories: { 'AI-FSD': { pdf: '01-FSD' } },
        stateStore: { findByBaseId: () => null, findBySha256: () => null, markDownloaded() {} },
        fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => bytes }),
      });
      assert.equal(result.pdfPath, join(root, 'pdf-libraries', libraryId, '01-FSD', '2609.00001v1_Fixture.pdf'));
      assert.deepEqual(await readFile(result.pdfPath), bytes);
    }
  } finally { await removeOwnedTestDirectory(root); }
});

test('omitted PDF root preserves downloads compatibility and explicit unsafe roots are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-root-'));
  try {
    await writeLayeredConfigFixture({ root });
    const file = join(root, 'config', 'machine.local.yaml');
    const machine = YAML.parse(await readFile(file, 'utf8'));
    delete machine.roots.pdf_libraries_root;
    await writeFile(file, YAML.stringify(machine));
    assert.equal(loadConfig({ root }).pdfRoot, join(root, 'data-libraries', 'fsd', 'work', 'downloads'));
    for (const value of [null, '', 'relative', 'D:/paper/../escape', 'D:/bad\nroot']) {
      machine.roots.pdf_libraries_root = value;
      await writeFile(file, YAML.stringify(machine));
      assert.throws(() => loadEngineContext({ root }), /pdf_libraries_root|pdfLibrariesRoot/);
    }
  } finally { await removeOwnedTestDirectory(root); }
});
