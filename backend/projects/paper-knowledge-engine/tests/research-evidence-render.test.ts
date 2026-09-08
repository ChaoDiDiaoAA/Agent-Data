import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderResearchIndexes, renderResearchSourceEvidence } from '../src/evidence/render-source.ts';
import { readVerifiedResearchArchive, writeResearchArchive } from '../src/research/source-archive.ts';
import { researchFixture } from './fixtures/research-source.ts';
import { canonicalJson } from '../src/shared/manifest.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function archive(root: string, revision = 'r1') {
  const fetched = researchFixture(revision);
  fetched.source.dimensions = {
    lifecycles: ['tool-execution'], controlBoundaries: ['execution'], evidenceLevel: 'official-specification-or-source',
    loop: { actions: ['tool-call'], termination: ['approval'] },
    permissions: { capabilities: ['filesystem'], grants: ['explicit'] },
    identityTenancy: { tenants: ['workspace'], roles: ['operator'] },
    testingLevels: ['integration'], evaluation: { objects: ['agent-loop'], metrics: ['safety'] },
  };
  const written = await writeResearchArchive({ root, libraryId: 'research-fixture', fetched });
  return readVerifiedResearchArchive(written.archivePath);
}

test('source renderer is deterministic and preserves archive facts and locators', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-evidence-render-')); roots.push(root);
  const verified = await archive(root);
  const first = await renderResearchSourceEvidence({ archive: verified, evidenceRoot: join(root, 'Evidence') });
  const second = await renderResearchSourceEvidence({ archive: verified, evidenceRoot: join(root, 'Evidence') });
  expect(first.map(file => ({ path: file.path, bytes: Buffer.from(file.bytes).toString('utf8'), sha256: file.sha256 })))
    .toEqual(second.map(file => ({ path: file.path, bytes: Buffer.from(file.bytes).toString('utf8'), sha256: file.sha256 })));
  const paths = first.map(file => file.path);
  expect(paths).toEqual(expect.arrayContaining([
    `Evidence/sources/official-doc/${verified.manifest.sourceId}/r1/index.md`,
    `Evidence/sources/official-doc/${verified.manifest.sourceId}/r1/source.md`,
    `Evidence/sources/official-doc/${verified.manifest.sourceId}/r1/content.md`,
    `Evidence/sources/official-doc/${verified.manifest.sourceId}/r1/citations.md`,
    `Evidence/sources/official-doc/${verified.manifest.sourceId}/r1/manifest.json`,
  ]));
  const text = first.map(file => Buffer.from(file.bytes).toString('utf8')).join('\n');
  expect(text).toContain('tool-execution'); expect(text).toContain('filesystem'); expect(text).toContain('workspace');
  expect(text).not.toContain('therefore');
  const manifest = JSON.parse(Buffer.from(first.find(file => file.path.endsWith('/manifest.json'))!.bytes).toString());
  expect(manifest.archiveManifestSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(canonicalJson(manifest)).toBe(Buffer.from(first.find(file => file.path.endsWith('/manifest.json'))!.bytes).toString());
});

test('research indexes are fixed, stable, and link a multi-Track source once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-evidence-index-')); roots.push(root);
  const first = await archive(root, 'r1'); const second = await archive(root, 'r2');
  const files = await renderResearchIndexes({ sources: [second, first] });
  expect(files.map(file => file.path)).toEqual([
    'Evidence/indexes/concepts.md', 'Evidence/indexes/lifecycles.md',
    'Evidence/indexes/source-types.md', 'Evidence/indexes/topics.md',
  ]);
  const topics = Buffer.from(files.find(file => file.path.endsWith('/topics.md'))!.bytes).toString();
  expect(topics.match(new RegExp(first.manifest.sourceId, 'g'))?.length).toBe(2);
  expect(topics.indexOf('/r1/')).toBeLessThan(topics.indexOf('/r2/'));
});
