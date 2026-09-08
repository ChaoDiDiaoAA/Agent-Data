import { expect, test } from 'bun:test';
import type { ResearchLibraryConfig } from '../src/types/config.ts';
import type { ResearchCandidate } from '../src/types/research-sources.ts';
import { researchFixture } from './fixtures/research-source.ts';
import { selectResearchCandidates } from '../src/research/research-selection.ts';

export function selectionLibrary(): ResearchLibraryConfig {
  const tracks = ['runtime', 'tools', ...Array.from({ length: 13 }, (_, i) => `track-${i}`)];
  return {
    kind: 'research', libraryId: 'test-research', displayName: 'Research', startDate: '2026-01-01',
    currentTask: { maxSources: 10, trackLimits: {}, sourceKindLimits: {} },
    weeklySchedule: { enabled: false, taskName: 'research', dayOfWeek: 'monday', intervalWeeks: 1,
      startDate: '2026-01-01', localTime: '09:00', timezone: 'UTC', maxSources: 5 },
    tracks: tracks.map(id => ({ id, query: 'agent', sourceKinds: ['official-doc', 'specification', 'paper'], arxivCategories: ['cs.AI'],
      domains: ['openai.com', 'arxiv.org'], dateFields: ['published', 'updated', 'released', 'retrieved'] })),
    sourcePolicy: { dateLowerBound: '2026-01-01', sourceKinds: ['official-doc', 'specification', 'paper'],
      allowedDomains: ['openai.com', 'arxiv.org'], identityVersionRules: {} as ResearchLibraryConfig['sourcePolicy']['identityVersionRules'],
      maxResponseBytes: 10000, requestTimeoutMs: 1000, maxAttempts: 1, retainAllVersions: true, contentHash: 'sha256' },
    topicTaxonomy: { tracks, lifecycles: [], controlBoundaries: [], evidenceLevels: [], testingLevels: [],
      evaluationDimensions: { objects: [], units: [], adjudicators: [], metrics: [], replayStrategies: [] } },
  };
}
export function selectionCandidate(revision = 'r1', track = 'runtime'): ResearchCandidate {
  const fetched = researchFixture(revision);
  return { source: { ...fetched.source, primaryTrack: track, secondaryTracks: [] },
    version: { ...fetched.version, updatedAt: '2026-06-01T00:00:00.000Z' },
    matchedTracks: [track], dateMatches: ['updated'], discoveryAdapter: 'docs' };
}
const window = { from: '2026-01-01', to: '2026-09-06' };

test('15 Track hits collapse before quotas and retain stable primary and secondary labels', () => {
  const library = selectionLibrary();
  const hits = library.tracks.map(t => selectionCandidate('r1', t.id));
  const options = { library, window, mode: 'current' as const, limit: 1 };
  const result = selectResearchCandidates(hits, options);
  expect(result.accepted).toHaveLength(1);
  expect(result.selected).toHaveLength(1);
  expect(result.selected[0].source.primaryTrack).toBe('runtime');
  expect(result.selected[0].source.secondaryTracks).toHaveLength(14);
  expect(selectResearchCandidates(hits.reverse(), options)).toEqual(result);
});

test('same source versions stay distinct; Track and kind quotas apply after dedupe', () => {
  const library = selectionLibrary();
  library.currentTask.trackLimits = { runtime: 2 };
  library.currentTask.sourceKindLimits = { 'official-doc': 1 };
  const spec = selectionCandidate('s1'); spec.source.kind = 'specification';
  const hits = [selectionCandidate('r2'), selectionCandidate(), selectionCandidate(), spec];
  const result = selectResearchCandidates(hits, { library, window, mode: 'current', limit: 2 });
  expect(result.accepted.map(c => c.version.versionId)).toEqual(['r1', 'r2', 's1']);
  expect(result.selected.map(c => c.version.versionId)).toEqual(['r1', 's1']);
});

test('policy rejects benchmark kinds, unknown Tracks, old dates and disallowed domains', () => {
  const badKind = selectionCandidate(); badKind.source.kind = 'benchmark-dataset' as never;
  const old = selectionCandidate('old'); old.version.updatedAt = '2025-12-31T00:00:00.000Z';
  const badDomain = selectionCandidate('bad'); badDomain.source.canonicalUrl = 'https://example.com/docs';
  const result = selectResearchCandidates([badKind, old, badDomain, selectionCandidate('unknown', 'unknown'), selectionCandidate()],
    { library: selectionLibrary(), window, mode: 'current' });
  expect(result.accepted.map(c => c.version.versionId)).toEqual(['r1']);
  expect(result.rejected).toBe(4);
});

test('retrieval time cannot admit undated docs except explicit backfill policy', () => {
  const candidate = selectionCandidate(); candidate.version.updatedAt = null;
  const options = { library: selectionLibrary(), window };
  expect(selectResearchCandidates([candidate], { ...options, mode: 'current', allowUndatedBackfill: true }).accepted).toEqual([]);
  expect(selectResearchCandidates([candidate], { ...options, mode: 'backfill' }).accepted).toEqual([]);
  expect(selectResearchCandidates([candidate], { ...options, mode: 'backfill', allowUndatedBackfill: true }).accepted).toHaveLength(1);
});

test('timestamp ordering is descending within Track/kind, with stable version tie breaks', () => {
  const newer = selectionCandidate('r3'); newer.version.updatedAt = '2026-09-06T23:00:00.000Z';
  const result = selectResearchCandidates([selectionCandidate('r2'), newer, selectionCandidate()],
    { library: selectionLibrary(), window, mode: 'current' });
  expect(result.selected.map(c => c.version.versionId)).toEqual(['r3', 'r1', 'r2']);
});
