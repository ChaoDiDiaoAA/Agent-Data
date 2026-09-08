import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { loadMinerULocalConfig } from '../src/mineru/mineru-local-config.ts';

test('local import policy is read from YAML, independently of the arXiv quota', () => {
  const raw = YAML.parse(readFileSync(new URL('./fixtures/legacy-config/mineru-local.yaml', import.meta.url), 'utf8'));
  raw.local_import = { recursive: false, max_files: 3, max_pdf_pages: 20, max_pdf_size_mb: 5, default_track: 'My-Papers', roots: [{ id: 'papers', path: 'D:\\papers' }] };
  assert.deepEqual(loadMinerULocalConfig(process.cwd(), { raw }).localImport, { recursive: false, maxFiles: 3, maxPdfPages: 20, maxPdfSizeMb: 5, defaultTrack: 'My-Papers', roots: [{ id: 'papers', path: 'D:\\papers' }] });
  for (const [key, value] of [['max_files', 0], ['recursive', 'yes'], ['default_track', '../outside']]) {
    assert.throws(() => loadMinerULocalConfig(process.cwd(), { raw: { ...raw, local_import: { ...raw.local_import, [key]: value } } }), /local_import/);
  }
});
