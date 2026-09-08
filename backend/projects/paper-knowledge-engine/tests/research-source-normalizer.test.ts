import { test, expect } from 'bun:test';
import { normalizeResearchCandidate } from '../src/research/source-normalizer.ts';
import { sourceIdentity } from '../src/research/source-identity.ts';

test('validates structured dimensions, taxonomy, dates, identity binding and benchmark exclusion', () => {
  const invalid = (edit: (value: ReturnType<typeof candidate>) => void) => { const value = candidate(); edit(value); expect(() => normalizeResearchCandidate(value)).toThrow(); };
  invalid(v => { v.source.kind = 'benchmark' as never; });
  invalid(v => { v.source.primaryTrack = ' '; });
  invalid(v => { v.source.dimensions = { unexpected: [] } as never; });
  invalid(v => { v.source.dimensions = { loop: { maxIterations: -1 } } as never; });
  invalid(v => { v.source.dimensions = { permissions: { subjects: 'user' } } as never; });
  invalid(v => { v.version.publishedAt = '2026-02-30T00:00:00Z' as never; });
  invalid(v => { v.version.retrievedAt = 'yesterday'; });
  invalid(v => { v.version.contentSha256 = 'A'.repeat(64); });
  invalid(v => { v.version.sourceId = 'b'.repeat(32); });
  invalid(v => { v.source.identityKey = 'doc:https://openai.com/other'; });
  invalid(v => { v.version.versionId = '../r1'; });
  const taxonomy = { tracks: ['runtime', 'tools', 'context'], lifecycles: ['tool-execution', 'context-construction'], controlBoundaries: [], evidenceLevels: [], testingLevels: ['unit'], evaluationDimensions: { objects: [], units: [], adjudicators: [], metrics: [], replayStrategies: [] } };
  expect(() => normalizeResearchCandidate(candidate(), { ...taxonomy, testingLevels: ['integration'] })).toThrow();
  const valid = candidate();
  valid.source.dimensions = { ...valid.source.dimensions, permissions: { subjects: [' user ', 'user'] }, loop: { maxIterations: 3 } } as never;
  expect(normalizeResearchCandidate(valid, taxonomy).source.dimensions.permissions?.subjects).toEqual(['user']);
});

export function candidate() {
  const id = sourceIdentity({ kind: 'official-doc', canonicalUrl: 'https://openai.com/docs', contentSha256: 'a'.repeat(64), revision: 'r1' });
  return {
    source: { sourceId: id.sourceId, identityKey: id.identityKey, kind: 'official-doc' as const, canonicalUrl: id.canonicalUrl, title: '  Agent   Guide ', publisher: null, authors: [' Bob ', 'Alice', 'Bob'], primaryTrack: 'runtime', secondaryTracks: ['tools', 'context', 'tools', 'runtime'], dimensions: { lifecycles: ['tool-execution', 'context-construction'], testingLevels: ['unit'] } },
    version: { sourceId: id.sourceId, versionId: 'r1', versionLabel: 'Revision 1', publishedAt: null, updatedAt: null, releasedAt: null, retrievedAt: '2026-09-06T00:00:00Z', contentSha256: 'a'.repeat(64), archivePath: '', provenance: { adapter: ' docs ', urls: ['https://openai.com/docs#x', 'https://openai.com/docs'] } },
    matchedTracks: ['tools', 'runtime', 'tools'], dateMatches: ['retrieved'], discoveryAdapter: ' docs ',
  };
}

test('normalizes ordering, authors, multiple Tracks and provenance deterministically', () => {
  const result = normalizeResearchCandidate(candidate());
  expect(result.source.title).toBe('Agent Guide');
  expect(result.source.authors).toEqual(['Alice', 'Bob']);
  expect(result.source.secondaryTracks).toEqual(['context', 'tools']);
  expect(result.matchedTracks).toEqual(['runtime', 'tools']);
  expect(result.version.provenance).toEqual({ adapter: 'docs', urls: ['https://openai.com/docs'] });
  expect(result.version.retrievedAt).toBe('2026-09-06T00:00:00.000Z');
  expect(normalizeResearchCandidate(result)).toEqual(result);
  expect(result.version.versionId).toBe('r1');
  expect(result.version.contentSha256).toBe('a'.repeat(64));
});
