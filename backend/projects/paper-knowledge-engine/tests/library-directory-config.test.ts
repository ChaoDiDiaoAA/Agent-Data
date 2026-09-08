import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { captureOperationPolicy } from '../src/library/operations/operation-store.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import { routeMineruConfig } from '../src/cli/routes.ts';

test('direction-owned documents load independently and each affects operation policy identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'library-directory-'));
  try {
    const old = YAML.parse(await readFile('tests/fixtures/legacy-config/libraries/fsd.yaml', 'utf8'));
    const { tracks, paper_policy, categories, ...library } = old;
    for (const id of ['fsd', 'other']) {
      await mkdir(join(root, 'config', id), { recursive: true });
      for (const [name, value] of Object.entries({ 'library.yaml': { ...library, library_id: id },
        'query-matrix.yaml': { tracks }, 'paper-policy.yaml': paper_policy, 'categories.yaml': categories })) {
        await writeFile(join(root, 'config', id, name), YAML.stringify(value));
      }
    }
    for (const name of ['engine.yaml', 'machine.local.yaml']) {
      await writeFile(join(root, 'config', name), await readFile(join('config', name)));
    }
    const context = loadEngineContext({ root });
    expect(context.library.tracks.map(t => t.id)).toEqual(['AI-FSD', 'LLM-Wiki', 'AI-TDD', 'AI-DDD',
      'AI-Program-Analysis-AST', 'Code-Translation', 'Verification', 'Evaluation']);
    const before = captureOperationPolicy(root, asLibraryId('fsd'));
    const other = captureOperationPolicy(root, asLibraryId('other'));
    const otherContext = loadEngineContext({ root, libraryId: 'other' });
    expect(routeMineruConfig([], { root, libraryId: asLibraryId('other') }).outputRoot).toBe(otherContext.paths.archiveRoot);
    for (const name of ['library.yaml', 'query-matrix.yaml', 'paper-policy.yaml', 'categories.yaml']) {
      const path = join(root, 'config/fsd', name), original = await readFile(path, 'utf8');
      await writeFile(path, original + '\n# policy edit\n');
      expect(captureOperationPolicy(root, asLibraryId('fsd'))).not.toEqual(before);
      expect(captureOperationPolicy(root, asLibraryId('other'))).toEqual(other);
      await rm(path);
      expect(() => loadEngineContext({ root })).toThrow();
      expect(() => captureOperationPolicy(root, asLibraryId('fsd'))).toThrow(/INCOMPLETE_LAYERED_CONFIG/);
      await writeFile(path, original);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
