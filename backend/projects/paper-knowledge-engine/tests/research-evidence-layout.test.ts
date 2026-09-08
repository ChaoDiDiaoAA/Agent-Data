import { afterEach, expect, test } from 'bun:test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SOURCE_EVIDENCE_LAYOUT_V1, evidenceSourceRoot } from '../src/shared/research-evidence-policy.ts';
import { bootstrapStageOne } from '../src/library/bootstrap.ts';
import { researchFixture } from './fixtures/research-source.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test('research Evidence layout is fixed and source/version paths are isolated', () => {
  const fetched = researchFixture();
  expect(SOURCE_EVIDENCE_LAYOUT_V1).toEqual({
    schemaVersion: 1, root: 'Evidence', sourcesRoot: 'Evidence/sources',
    indexRoots: {
      topics: 'Evidence/indexes/topics.md', sourceTypes: 'Evidence/indexes/source-types.md',
      lifecycles: 'Evidence/indexes/lifecycles.md', concepts: 'Evidence/indexes/concepts.md',
    },
  });
  expect(evidenceSourceRoot(fetched.source, fetched.version)).toBe(
    `Evidence/sources/official-doc/${fetched.source.sourceId}/r1`,
  );
  expect(evidenceSourceRoot(fetched.source, { ...fetched.version, versionId: 'r2' })).not.toBe(
    evidenceSourceRoot(fetched.source, fetched.version),
  );
  expect(() => evidenceSourceRoot({ ...fetched.source, sourceId: '../escape' }, fetched.version)).toThrow();
  expect(() => evidenceSourceRoot(fetched.source, { ...fetched.version, versionId: '../escape' })).toThrow();
});

test('research bootstrap creates sources and indexes but no paper or Knowledge roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-evidence-layout-')); roots.push(root);
  const vaultRoot = join(root, 'vault');
  await bootstrapStageOne({ libraryKind: 'research', pdfRoot: join(root, 'pdf'), vaultRoot });
  for (const path of ['Evidence', 'Evidence/sources', 'Evidence/indexes']) await access(join(vaultRoot, path));
  await expect(access(join(vaultRoot, 'Evidence/papers'))).rejects.toThrow();
  await expect(access(join(vaultRoot, 'Knowledge'))).rejects.toThrow();
});
