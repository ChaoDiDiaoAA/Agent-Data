import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseResearchImportArguments, routeSourceConfig } from '../src/cli/routes.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { routeCommand } from '../src/cli/routes.ts';
import { makeResearchFixture, researchFixtureId } from './helpers/research-library-fixture.ts';

test('import-source requires an absolute path and explicit local-artifact classification', () => {
  expect(parseResearchImportArguments([
    '--path', 'D:\\research\\agent-notes', '--kind', 'local-artifact', '--track', 'agent-loop',
  ])).toEqual({ path: 'D:\\research\\agent-notes', kind: 'local-artifact', track: 'agent-loop' });
  expect(() => parseResearchImportArguments(['--path', 'relative\\notes', '--kind', 'local-artifact', '--track', 'agent-loop']))
    .toThrow('ABSOLUTE_PATH_REQUIRED');
  expect(() => parseResearchImportArguments(['--path', 'D:\\research\\notes', '--kind', 'official-doc', '--track', 'agent-loop']))
    .toThrow('LOCAL_ARTIFACT_KIND_REQUIRED');
});

test('import-source rejects duplicates, unknown arguments, and unsafe track values', () => {
  const valid = ['--path', 'D:\\research\\notes', '--kind', 'local-artifact', '--track', 'agent-loop'];
  expect(() => parseResearchImportArguments([...valid, '--path', 'D:\\other'])).toThrow('DUPLICATE_ARGUMENT');
  expect(() => parseResearchImportArguments([...valid, '--unknown', 'x'])).toThrow('UNKNOWN_ARGUMENT');
  expect(() => parseResearchImportArguments(['--path', 'D:\\research\\notes', '--kind', 'local-artifact', '--track', '../agent-loop']))
    .toThrow('INVALID_TRACK');
});

test('research JSON-only routes reject human formats explicitly', () => {
  expect(() => routeSourceConfig(['--format', 'text'], { libraryId: asLibraryId(researchFixtureId) })).toThrow('--format json');
});

test('research run route injects the generic workflow and does not create MinerU', async () => {
  const root = makeResearchFixture();
  const operationsRoot = await mkdtemp(join(root, '.tmp-research-route-'));
  try {
    let createdMineru = false;
    let sawResearch = false;
    const libraryId = asLibraryId(researchFixtureId);
    const engine = () => loadEngineContext({ root, libraryId });
    const result = await routeCommand(['run-task', '--mode', 'current'], engine, {
      root, libraryId, operationsRoot, dataRoot: operationsRoot,
      createMineruSession: () => { createdMineru = true; throw new Error('research must not create MinerU'); },
      execute: async (_input, dependencies) => {
        sawResearch = Boolean(dependencies?.research);
        return { jobId: 'research-job', libraryId, requestId: 'cli', status: 'completed', stage: 'acquire', updatedAt: new Date().toISOString(), canResume: false };
      },
      output: () => undefined,
    });
    expect(result).toBeUndefined();
    expect(sawResearch).toBe(true);
    expect(createdMineru).toBe(false);
    expect((await readdir(operationsRoot)).some(name => name.endsWith('.json'))).toBe(true);
  } finally {
    await rm(operationsRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('paper-only routes fail before admission when a Research library is selected', async () => {
  const root = makeResearchFixture();
  const operationsRoot = await mkdtemp(join(root, '.tmp-research-unsupported-'));
  try {
    const libraryId = asLibraryId(researchFixtureId);
    const engine = () => loadEngineContext({ root, libraryId });
    await expect(routeCommand(['import-local', '--path', 'D:\\papers', '--preview'], engine, {
      root, libraryId, operationsRoot, dataRoot: operationsRoot, output: () => undefined,
    })).rejects.toThrow('UNSUPPORTED_LIBRARY_KIND');
    expect(await readdir(operationsRoot)).toEqual([]);
  } finally {
    await rm(operationsRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
