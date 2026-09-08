import type { RunWindow } from '../types/jobs.ts';
import type { ResearchCandidate, ResearchRunMode, ResearchSourceKind } from '../types/research-sources.ts';
import { canonicalJson } from '../shared/manifest.ts';
import { sha256, requireSourceHash } from './source-identity.ts';
import { normalizeResearchCandidate } from './source-normalizer.ts';
import { calculateResearchCounters, researchVersionKey, type ResearchVersionKey } from './research-counters.ts';

export interface ResearchRequestCheckpoint {
  mode: ResearchRunMode;
  window: RunWindow;
  tracks: readonly string[];
  sourceKinds: readonly ResearchSourceKind[];
  limit: number;
  configSha256: string;
}
export interface ResearchSelectionCheckpoint {
  schemaVersion: 1;
  candidateCount: number;
  accepted: readonly (ResearchVersionKey & { isNewVersion: boolean })[];
  selected: readonly ResearchCandidate[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function researchCheckpointHash(value: unknown): string { return sha256(canonicalJson(value)); }

export function createResearchSelectionCheckpoint(input: Omit<ResearchSelectionCheckpoint, 'schemaVersion'>): ResearchSelectionCheckpoint {
  const acceptedKeys = input.accepted.map(researchVersionKey), selectedKeys = input.selected.map(c => researchVersionKey(c.version));
  if (new Set(acceptedKeys).size !== acceptedKeys.length || new Set(selectedKeys).size !== selectedKeys.length
    || selectedKeys.some(key => !acceptedKeys.includes(key)) || input.accepted.some(v => typeof v.isNewVersion !== 'boolean'))
    throw new Error('RESEARCH_RESUME_CONFLICT: invalid selection membership');
  input.selected.forEach(candidate => normalizeResearchCandidate(candidate));
  calculateResearchCounters({ candidateCount: input.candidateCount, accepted: input.accepted,
    newVersions: input.accepted.filter(v => v.isNewVersion), archived: [], published: [] });
  return freeze(structuredClone({ schemaVersion: 1 as const, candidateCount: input.candidateCount, accepted: input.accepted, selected: input.selected }));
}

/** Validate before any resume mutation or adapter call. Never reconstruct selection from discovery. */
export function assertResearchResume(input: {
  savedRequest: ResearchRequestCheckpoint;
  request: ResearchRequestCheckpoint;
  selection: ResearchSelectionCheckpoint;
  storedHash: string;
  expectedHash?: string;
}): void {
  try {
    requireSourceHash(input.savedRequest.configSha256); requireSourceHash(input.storedHash);
    if (input.selection.schemaVersion !== 1 || canonicalJson(input.savedRequest) !== canonicalJson(input.request)
      || researchCheckpointHash(input.selection) !== input.storedHash
      || (input.expectedHash !== undefined && input.expectedHash !== input.storedHash)) throw new Error();
    createResearchSelectionCheckpoint(input.selection);
  } catch { throw new Error('RESEARCH_RESUME_CONFLICT'); }
}
