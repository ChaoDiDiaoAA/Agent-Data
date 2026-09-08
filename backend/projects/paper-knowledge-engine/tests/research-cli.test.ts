import { expect, test } from 'bun:test';
import { loadEngineContext, listLibraries, parseLibrarySelection } from '../src/shared/engine-context.ts';
import { normalizeCliOperation, routeHarvestPlan, routeScheduleConfig } from '../src/cli/routes.ts';
import { asLibraryId } from '../src/shared/identity.ts';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\');

test('direction selection preserves the explicit Agent Engineering paper library', () => {
  const selection = parseLibrarySelection(['--library', 'agent-engineering', 'run-task', '--mode', 'current']);
  expect(selection.libraryId).toBe('agent-engineering');
  expect(selection.argv).toEqual(['run-task', '--mode', 'current']);
  expect(loadEngineContext({ root, libraryId: 'agent-engineering' }).library.displayName).toBe('Agent Engineering（Agent 工程知识库）');
  expect(loadEngineContext({ root, libraryId: 'agent-engineering' }).library.kind).toBe('paper');
  expect(listLibraries(root).some(library => library.libraryId === 'agent-engineering')).toBe(true);
});

test('paper-only Agent Engineering rejects Research backfill while preserving paper task modes', () => {
  expect(normalizeCliOperation('run-task', ['--mode', 'current'], asLibraryId('agent-engineering'))).toMatchObject({ kind: 'current' });
  expect(() => normalizeCliOperation('run-task', ['--mode', 'backfill', '--from', '2026-01-01', '--to', '2026-09-07'], asLibraryId('agent-engineering')))
    .toThrow('UNSUPPORTED_LIBRARY_KIND');
  expect(() => normalizeCliOperation('run-task', ['--mode', 'backfill', '--from', '2026-01-01', '--to', '2026-09-07'], asLibraryId('fsd')))
    .toThrow('UNSUPPORTED_LIBRARY_KIND');
});

test('Agent Engineering exposes the same paper schedule and harvest-plan contract as FSD', () => {
  const library = loadEngineContext({ root, libraryId: 'agent-engineering' }).library;
  const schedule = routeScheduleConfig(['--format', 'json'], { root, libraryId: asLibraryId('agent-engineering') });
  expect(schedule).toMatchObject({ maxPapers: 15, command: ['--library', 'agent-engineering', 'run-task', '--mode', 'weekly'] });
  expect(schedule).not.toHaveProperty('maxSources');
  expect(library.kind).toBe('paper');
  expect(routeHarvestPlan(['--mode', 'current', '--format', 'json'], { root, libraryId: asLibraryId('agent-engineering') }))
    .toMatchObject({ trackCount: 15, totalShards: 30, maxPapers: 150 });
});
