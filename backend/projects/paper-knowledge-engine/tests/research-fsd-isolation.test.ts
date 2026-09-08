import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { isPaperLibrary } from '../src/types/config.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { runResearchTask } from '../src/research/research-workflow.ts';
import type { SourceDiscoveryAdapter } from '../src/research/adapters/types.ts';
import { makeResearchFixture, researchFixtureId } from './helpers/research-library-fixture.ts';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test('FSD and Agent Engineering derive independent paper state, Archive, work, PDF and Vault roots', () => {
  const fsd = loadEngineContext({ root: process.cwd(), libraryId: 'fsd' });
  const agent = loadEngineContext({ root: process.cwd(), libraryId: 'agent-engineering' });
  expect(isPaperLibrary(agent.library)).toBe(true);
  expect(fsd.library.libraryId).toBe('fsd');
  expect(agent.library.libraryId).toBe('agent-engineering');

  const keys = ['dataRoot', 'databasePath', 'archiveRoot', 'runsRoot', 'operationsRoot', 'workRoot', 'backupRoot', 'vaultRoot'] as const;
  for (const key of keys) {
    expect(agent.paths[key]).not.toBe(fsd.paths[key]);
    expect(agent.paths[key].toLowerCase()).toContain('agent-engineering');
    expect(fsd.paths[key].toLowerCase()).toContain('fsd');
  }
  expect(agent.paths.pdfRoot).not.toBe(fsd.paths.pdfRoot);
  expect(agent.paths.pdfRoot?.toLowerCase()).toContain('agent-engineering');
  expect(fsd.paths.pdfRoot?.toLowerCase()).toContain('fsd');
});

test('a generic Research run cannot modify FSD paper database, PDF, Evidence or Knowledge surfaces', async () => {
  const configRoot = makeResearchFixture();
  roots.push(configRoot);
  const root = await mkdtemp(join(tmpdir(), 'research-fsd-isolation-')); roots.push(root);
  const fsdRoot = join(root, 'fsd');
  const agentRoot = join(root, researchFixtureId);
  const fsdDb = join(fsdRoot, 'library.sqlite');
  const fsdEvidence = join(fsdRoot, 'vault', 'Evidence', 'papers');
  const fsdKnowledge = join(fsdRoot, 'vault', 'Knowledge');
  const fsdPdf = join(fsdRoot, 'pdf', '01-Track');
  await Promise.all([mkdir(fsdEvidence, { recursive: true }), mkdir(fsdKnowledge, { recursive: true }), mkdir(fsdPdf, { recursive: true })]);
  await Promise.all([
    writeFile(join(fsdEvidence, 'sentinel.md'), 'paper evidence sentinel\n'),
    writeFile(join(fsdKnowledge, 'sentinel.md'), 'human knowledge sentinel\n'),
    writeFile(join(fsdPdf, 'sentinel.pdf'), '%PDF-1.7\nfsd sentinel\n'),
  ]);
  const fsdStore = openStateStore(fsdDb);
  fsdStore.close();
  const beforeDb = await readFile(fsdDb);
  const beforeEvidence = await readFile(join(fsdEvidence, 'sentinel.md'));
  const beforeKnowledge = await readFile(join(fsdKnowledge, 'sentinel.md'));
  const beforePdf = await readFile(join(fsdPdf, 'sentinel.pdf'));

  const engine = loadEngineContext({ root: configRoot, libraryId: researchFixtureId });
  await mkdir(agentRoot, { recursive: true });
  const store = openStateStore(join(agentRoot, 'library.sqlite'));
  const empty: SourceDiscoveryAdapter = {
    id: 'empty-fixture',
    kinds: ['official-doc'],
    async discover() { return []; },
    async fetch() { throw new Error('empty fixture must not fetch'); },
  };
  try {
    const result = await runResearchTask({ mode: 'current' }, {
      library: engine.library as Extract<typeof engine.library, { kind: 'research' }>,
      stateRoot: agentRoot,
      store,
      adapters: [empty],
      now: () => '2026-09-07T12:00:00.000Z',
    });
    expect(result).toMatchObject({ status: 'awaiting_evidence', counters: { candidates: 0, accepted: 0, newVersions: 0, archived: 0, published: 0 } });
  } finally {
    store.close();
  }

  expect(await readFile(fsdDb)).toEqual(beforeDb);
  expect(await readFile(join(fsdEvidence, 'sentinel.md'))).toEqual(beforeEvidence);
  expect(await readFile(join(fsdKnowledge, 'sentinel.md'))).toEqual(beforeKnowledge);
  expect(await readFile(join(fsdPdf, 'sentinel.pdf'))).toEqual(beforePdf);
  await expect(stat(join(agentRoot, 'runs'))).resolves.toBeTruthy();
  await expect(stat(join(agentRoot, 'archive'))).rejects.toThrow();
});
