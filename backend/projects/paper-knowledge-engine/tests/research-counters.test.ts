import { expect, test } from 'bun:test';
import { calculateResearchCounters, formatResearchCounters } from '../src/research/research-counters.ts';

const v1 = { sourceId: 'a'.repeat(32), versionId: 'v1' };
const v2 = { ...v1, versionId: 'v2' };

test('raw hits and unique accepted/new/archive/publication versions have distinct counts', () => {
  const counters = calculateResearchCounters({ candidateCount: 4, accepted: [v1, v1, v1, v2],
    newVersions: [v2, v2], archived: [v1, v1, v2], published: [v1, v1] });
  expect(counters).toEqual({ candidates: 4, accepted: 2, newVersions: 1, archived: 2, published: 1 });
  expect(formatResearchCounters(counters)).toBe('候选 4，接受 2，新版本 1，归档 2，发布 1');
  expect(JSON.parse(JSON.stringify(counters))).toEqual(counters);
});

test('archive/publication replay never adds another source version', () => {
  const input = { candidateCount: 3, accepted: [v1], newVersions: [], archived: [v1], published: [v1] };
  expect(calculateResearchCounters(input)).toEqual(calculateResearchCounters({ ...input, archived: [v1, v1], published: [v1, v1] }));
});

test('invalid counts or stage membership fail closed', () => {
  const input = { candidateCount: 1, accepted: [v1], newVersions: [], archived: [], published: [] };
  expect(() => calculateResearchCounters({ ...input, candidateCount: -1 })).toThrow();
  expect(() => calculateResearchCounters({ ...input, candidateCount: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  expect(() => calculateResearchCounters({ ...input, newVersions: [v2] })).toThrow();
  expect(() => calculateResearchCounters({ ...input, published: [v1] })).toThrow();
});
