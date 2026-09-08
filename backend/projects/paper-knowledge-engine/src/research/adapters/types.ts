import type { MachineConfig, ResearchTrackConfig } from '../../types/config.ts';
import type { FetchedSource, ResearchCandidate, ResearchSourceKind, SourcePolicyConfig } from '../../types/research-sources.ts';
import { approvedHttpsUrl, ResearchAdapterError, type HttpScope } from '../http-client.ts';
import { normalizeResearchCandidate, sourceDate } from '../source-normalizer.ts';
import { sha256, sourceIdentity } from '../source-identity.ts';

const localResearchPurposes = ['methodology', 'technical-report', 'specification', 'evaluation-method', 'source-code'] as const;
export type LocalResearchPurpose = typeof localResearchPurposes[number];

export interface DiscoveryInput {
  track: ResearchTrackConfig;
  query: string;
  window: { from: string; to: string };
  allowedSourceKinds: readonly ResearchSourceKind[];
  allowedDomains: readonly string[];
  policy: SourcePolicyConfig;
  network?: MachineConfig['network'];
  signal: AbortSignal;
  targets?: readonly { url: string; kind: ResearchSourceKind; revision?: string }[];
  localPaths?: readonly string[];
  /** Required for local-artifact; explicitly classifies every supplied local target. */
  localPurpose?: LocalResearchPurpose;
  purpose?: 'research' | 'benchmark-dataset' | 'leaderboard' | 'single-result';
}
declare const approved: unique symbol;
export type PolicyApprovedCandidate = ResearchCandidate & { readonly [approved]: true };
export interface FetchInput { candidate: PolicyApprovedCandidate; signal: AbortSignal }
export interface SourceDiscoveryAdapter {
  readonly id: string;
  readonly kinds: readonly ResearchSourceKind[];
  discover(input: DiscoveryInput): Promise<readonly ResearchCandidate[]>;
  fetch(input: FetchInput): Promise<FetchedSource>;
}
const approvals = new WeakMap<ResearchCandidate, Omit<DiscoveryInput, 'signal'>>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function requireLocalPurpose(input: DiscoveryInput, candidate?: ResearchCandidate): LocalResearchPurpose {
  if (input.localPurpose === undefined || !localResearchPurposes.includes(input.localPurpose)) throw new ResearchAdapterError('RESEARCH_LOCAL_PURPOSE_REJECTED');
  if (candidate) {
    const notes = candidate.version.provenance.notes;
    if (!Array.isArray(notes) || notes.some(note => typeof note !== 'string')) throw new ResearchAdapterError('RESEARCH_LOCAL_PURPOSE_REJECTED');
    const purposes = notes.filter(note => note.trimStart().startsWith('local-purpose:'));
    // Check before normalization can collapse duplicate or whitespace-altered declarations.
    if (purposes.length !== 1 || purposes[0] !== `local-purpose:${input.localPurpose}`) throw new ResearchAdapterError('RESEARCH_LOCAL_PURPOSE_REJECTED');
  }
  return input.localPurpose;
}
export function discoveryScope(input: DiscoveryInput, kind: ResearchSourceKind): HttpScope {
  if (input.signal.aborted) throw new ResearchAdapterError('RESEARCH_ABORTED');
  if (input.purpose && input.purpose !== 'research') throw new ResearchAdapterError('RESEARCH_BENCHMARK_REJECTED');
  if (kind === 'local-artifact') requireLocalPurpose(input);
  if (!input.policy.sourceKinds.includes(kind) || !input.allowedSourceKinds.includes(kind) || !input.track.sourceKinds.includes(kind)
    || !input.track.id.trim() || !input.query.trim()) throw new ResearchAdapterError('RESEARCH_POLICY_REJECTED');
  try {
    if (sourceDate(input.window.from) < sourceDate(input.policy.dateLowerBound) || sourceDate(input.window.from) > sourceDate(input.window.to)) throw new Error();
  } catch { throw new ResearchAdapterError('RESEARCH_POLICY_REJECTED'); }
  return { ...input, allowedDomains: input.allowedDomains.filter(domain => input.track.domains.includes(domain)) };
}
export function dateMatches(input: DiscoveryInput, dates: { publishedAt: string | null; updatedAt: string | null; releasedAt: string | null; retrievedAt: string }): string[] {
  const from = sourceDate(input.window.from);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(input.window.to) ? `${input.window.to}T23:59:59.999Z` : sourceDate(input.window.to);
  const values = { published: dates.publishedAt, updated: dates.updatedAt, released: dates.releasedAt, retrieved: dates.retrievedAt };
  return input.track.dateFields.filter(field => values[field] !== null && sourceDate(values[field]!) >= from && sourceDate(values[field]!) <= to).sort();
}
export function approveCandidate(candidate: ResearchCandidate, input: DiscoveryInput): PolicyApprovedCandidate {
  const scope = discoveryScope(input, candidate.source.kind);
  if (candidate.source.kind === 'local-artifact') requireLocalPurpose(input, candidate);
  const normalized = normalizeResearchCandidate(candidate);
  if (!normalized.matchedTracks.includes(input.track.id) || !dateMatches(input, normalized.version).length) throw new ResearchAdapterError('RESEARCH_POLICY_REJECTED');
  if (candidate.source.kind !== 'local-artifact') approvedHttpsUrl(candidate.source.canonicalUrl, scope);
  const { signal: _signal, ...snapshot } = input;
  const approvedCandidate = freeze(structuredClone(normalized)) as PolicyApprovedCandidate;
  approvals.set(approvedCandidate, freeze(structuredClone(snapshot)));
  return approvedCandidate;
}
export function fetchScope(input: FetchInput, adapter: SourceDiscoveryAdapter): DiscoveryInput {
  const snapshot = approvals.get(input.candidate);
  if (!snapshot || input.candidate.discoveryAdapter !== adapter.id || !adapter.kinds.includes(input.candidate.source.kind)) throw new ResearchAdapterError('RESEARCH_APPROVAL_REQUIRED');
  return { ...snapshot, signal: input.signal };
}
export function candidateFromContent(input: DiscoveryInput, data: {
  kind: ResearchSourceKind; url: string; title: string; content: string; retrievedAt: string; adapter: string;
  revision?: string; updatedAt?: string | null; notes?: string[];
}): ResearchCandidate {
  const contentSha256 = sha256(data.content);
  const identity = sourceIdentity({ kind: data.kind, canonicalUrl: data.url, contentSha256, revision: data.revision });
  const source = { sourceId: identity.sourceId, identityKey: identity.identityKey, kind: data.kind, canonicalUrl: identity.canonicalUrl,
    title: data.title, publisher: data.url ? new URL(data.url).hostname : null, authors: [], primaryTrack: input.track.id, secondaryTracks: [], dimensions: {} };
  const version = { sourceId: source.sourceId, versionId: identity.versionId, versionLabel: identity.versionId,
    publishedAt: null, updatedAt: data.updatedAt ?? null, releasedAt: null, retrievedAt: data.retrievedAt,
    contentSha256, archivePath: '', provenance: { adapter: data.adapter, urls: data.url ? [data.url] : [], notes: data.notes ?? [] } };
  return normalizeResearchCandidate({ source, version, matchedTracks: [input.track.id], dateMatches: dateMatches(input, version), discoveryAdapter: data.adapter });
}
