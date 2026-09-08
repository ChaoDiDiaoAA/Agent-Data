import { expect, test } from 'bun:test';
import { createResearchSelectionCheckpoint, assertResearchResume, researchCheckpointHash } from '../src/research/research-checkpoints.ts';
import { researchFixture } from './fixtures/research-source.ts';
import type { ResearchCandidate } from '../src/types/research-sources.ts';

function snapshot() {
  const fetched = researchFixture();
  const candidate: ResearchCandidate = { source: fetched.source, version: fetched.version, matchedTracks: ['runtime', 'tools'],
    dateMatches: ['retrieved'], discoveryAdapter: 'docs' };
  const request = { mode: 'current' as const, window: { from: '2026-01-01', to: '2026-09-06' },
    tracks: ['runtime'], sourceKinds: ['official-doc' as const], limit: 1, configSha256: 'a'.repeat(64) };
  const selection = createResearchSelectionCheckpoint({ candidateCount: 2,
    accepted: [{ sourceId: candidate.source.sourceId, versionId: 'r1', isNewVersion: true }], selected: [candidate] });
  return { request, selection, selectionHash: researchCheckpointHash(selection) };
}

test('frozen selection preserves order, identity and pre-run novelty through JSON recovery', () => {
  const saved = snapshot(); const recovered = JSON.parse(JSON.stringify(saved));
  expect(() => assertResearchResume({ savedRequest: saved.request, request: recovered.request,
    selection: recovered.selection, storedHash: saved.selectionHash, expectedHash: saved.selectionHash })).not.toThrow();
  expect(Object.isFrozen(saved.selection.selected)).toBe(true);
  expect(saved.selection.accepted[0].isNewVersion).toBe(true);
});

test('mode/window/config/limits/selection/hash conflicts cannot rediscover or expand selection', () => {
  const saved = snapshot();
  for (const request of [{ ...saved.request, mode: 'weekly' as const },
    { ...saved.request, window: { ...saved.request.window, to: '2026-09-07' } },
    { ...saved.request, configSha256: 'b'.repeat(64) }, { ...saved.request, limit: 2 }]) {
    expect(() => assertResearchResume({ savedRequest: saved.request, request, selection: saved.selection,
      storedHash: saved.selectionHash })).toThrow('RESEARCH_RESUME_CONFLICT');
  }
  const changed = JSON.parse(JSON.stringify(saved.selection)); changed.selected[0].source.title = 'Changed';
  expect(() => assertResearchResume({ savedRequest: saved.request, request: saved.request,
    selection: changed, storedHash: saved.selectionHash })).toThrow('RESEARCH_RESUME_CONFLICT');
  expect(() => assertResearchResume({ savedRequest: saved.request, request: saved.request,
    selection: saved.selection, storedHash: 'b'.repeat(64) })).toThrow('RESEARCH_RESUME_CONFLICT');
});

test('duplicate selected versions and versions outside accepted set cannot be frozen', () => {
  const saved = snapshot();
  expect(() => createResearchSelectionCheckpoint({ ...saved.selection, selected: [...saved.selection.selected, ...saved.selection.selected] })).toThrow();
  expect(() => createResearchSelectionCheckpoint({ ...saved.selection, accepted: [] })).toThrow();
});
