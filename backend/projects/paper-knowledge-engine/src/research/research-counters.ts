import { requireVersionId } from './source-identity.ts';

export interface ResearchVersionKey { sourceId: string; versionId: string }
export interface ResearchCounters { candidates: number; accepted: number; newVersions: number; archived: number; published: number }

export function researchVersionKey(value: ResearchVersionKey): string {
  if (!/^[0-9a-f]{32}$/.test(value.sourceId)) throw new TypeError('invalid research source ID');
  return `${value.sourceId}/${requireVersionId(value.versionId)}`;
}

/** Each stage is a set of source/version units; adapter hits alone are raw counts. */
export function calculateResearchCounters(input: {
  candidateCount: number;
  accepted: readonly ResearchVersionKey[];
  newVersions: readonly ResearchVersionKey[];
  archived: readonly ResearchVersionKey[];
  published: readonly ResearchVersionKey[];
}): ResearchCounters {
  if (!Number.isSafeInteger(input.candidateCount) || input.candidateCount < 0) throw new TypeError('invalid candidate count');
  const accepted = new Set(input.accepted.map(researchVersionKey));
  const newVersions = new Set(input.newVersions.map(researchVersionKey));
  const archived = new Set(input.archived.map(researchVersionKey));
  const published = new Set(input.published.map(researchVersionKey));
  if (accepted.size > input.candidateCount || [...newVersions, ...archived].some(key => !accepted.has(key))
    || [...published].some(key => !archived.has(key))) throw new TypeError('invalid research counter stage membership');
  return { candidates: input.candidateCount, accepted: accepted.size, newVersions: newVersions.size, archived: archived.size, published: published.size };
}

export function formatResearchCounters(value: ResearchCounters): string {
  return `候选 ${value.candidates}，接受 ${value.accepted}，新版本 ${value.newVersions}，归档 ${value.archived}，发布 ${value.published}`;
}
