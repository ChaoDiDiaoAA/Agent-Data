import type { ResearchLibraryConfig, ResearchSourceKind } from '../types/config.ts';
import type { RunWindow } from '../types/jobs.ts';
import type { ResearchCandidate, ResearchRunMode } from '../types/research-sources.ts';
import { approveCandidate, type DiscoveryInput } from './adapters/types.ts';
import { normalizeResearchCandidate, sourceDate } from './source-normalizer.ts';
import { researchVersionKey } from './research-counters.ts';
import { canonicalJson } from '../shared/manifest.ts';

export interface ResearchSelectionOptions {
  library: ResearchLibraryConfig;
  window: RunWindow;
  mode: ResearchRunMode;
  limit?: number;
  tracks?: readonly string[];
  sourceKinds?: readonly ResearchSourceKind[];
  /** Explicit import/backfill policy. Retrieval time never dates normal discovery. */
  allowUndatedBackfill?: boolean;
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function researchDiscoveryInput(options: ResearchSelectionOptions, trackId: string, signal: AbortSignal): DiscoveryInput {
  const track = options.library.tracks.find(t => t.id === trackId);
  if (!track || (options.tracks && !options.tracks.includes(trackId))) throw new Error('RESEARCH_POLICY_REJECTED');
  const undated = options.mode === 'backfill' && options.allowUndatedBackfill;
  return { track: { ...track, dateFields: undated ? track.dateFields : track.dateFields.filter(field => field !== 'retrieved') },
    query: track.query, window: options.window, allowedSourceKinds: options.sourceKinds ?? options.library.sourcePolicy.sourceKinds,
    allowedDomains: options.library.sourcePolicy.allowedDomains, policy: options.library.sourcePolicy, signal };
}

function timestamp(candidate: ResearchCandidate): string {
  const v = candidate.version;
  const dates = [v.publishedAt, v.updatedAt, v.releasedAt].filter((value): value is string => value !== null).sort();
  return dates.at(-1) ?? v.retrievedAt;
}

/** Policy approval precedes identity dedupe; quotas follow it. Input order is irrelevant. */
export function selectResearchCandidates(candidates: readonly ResearchCandidate[], options: ResearchSelectionOptions) {
  const { library } = options;
  const from = sourceDate(options.window.from), to = sourceDate(options.window.to);
  if (from < sourceDate(library.sourcePolicy.dateLowerBound) || from > to) throw new Error('RESEARCH_POLICY_REJECTED: window');
  if (options.tracks?.some(id => !library.tracks.some(t => t.id === id))
    || options.sourceKinds?.some(kind => !library.sourcePolicy.sourceKinds.includes(kind))) throw new Error('RESEARCH_POLICY_REJECTED: filters');
  const limit = options.limit ?? (options.mode === 'weekly' ? library.weeklySchedule.maxSources : library.currentTask.maxSources);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('invalid research source limit');
  for (const quota of [...Object.values(library.currentTask.trackLimits), ...Object.values(library.currentTask.sourceKindLimits)]) {
    if (!Number.isSafeInteger(quota) || quota < 0) throw new TypeError('invalid research quota');
  }
  const rank = new Map(library.tracks.map((track, index) => [track.id, index]));
  const trackOrder = (a: string, b: string) => rank.get(a)! - rank.get(b)! || compare(a, b);
  const unique = new Map<string, ResearchCandidate>();
  let rejected = 0;
  for (const hit of candidates) {
    let candidate: ResearchCandidate;
    let tracks: string[];
    try {
      candidate = normalizeResearchCandidate(hit, library.topicTaxonomy);
      tracks = candidate.matchedTracks.filter(track => {
        try { approveCandidate(candidate, researchDiscoveryInput(options, track, new AbortController().signal)); return true; }
        catch { return false; }
      }).sort(trackOrder);
      if (!tracks.length) throw new Error('RESEARCH_POLICY_REJECTED');
    } catch { rejected++; continue; }
    const key = researchVersionKey(candidate.version), previous = unique.get(key);
    if (previous) {
      if (previous.source.kind !== candidate.source.kind || previous.version.contentSha256 !== candidate.version.contentSha256)
        throw new Error('SOURCE_VERSION_CONFLICT');
      tracks = [...new Set([...previous.matchedTracks, ...tracks])].sort(trackOrder);
      // Stable metadata choice for duplicate hits from different adapters/Tracks.
      if (compare(canonicalJson(previous), canonicalJson(candidate)) < 0) candidate = previous;
    }
    unique.set(key, { ...candidate, matchedTracks: tracks,
      source: { ...candidate.source, primaryTrack: tracks[0], secondaryTracks: tracks.slice(1) } });
  }
  const accepted = [...unique.values()].sort((a, b) => trackOrder(a.source.primaryTrack, b.source.primaryTrack)
    || compare(a.source.kind, b.source.kind) || compare(timestamp(b), timestamp(a))
    || compare(a.source.sourceId, b.source.sourceId) || compare(a.version.versionId, b.version.versionId));
  const byTrack = new Map<string, number>(), byKind = new Map<ResearchSourceKind, number>();
  const selected = accepted.filter(candidate => {
    const track = candidate.source.primaryTrack, kind = candidate.source.kind;
    if ((byTrack.get(track) ?? 0) >= (library.currentTask.trackLimits[track] ?? Infinity)
      || (byKind.get(kind) ?? 0) >= (library.currentTask.sourceKindLimits[kind] ?? Infinity)) return false;
    if ([...byTrack.values()].reduce((sum, value) => sum + value, 0) >= limit) return false;
    byTrack.set(track, (byTrack.get(track) ?? 0) + 1); byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    return true;
  });
  return { accepted, selected, rejected };
}
