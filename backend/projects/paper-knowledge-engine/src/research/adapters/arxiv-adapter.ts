import { runHarvestShards } from '../../discovery/opencli-runner.ts';
import { buildOpenCliEnvironment, resolveArxivApiBase, resolveOpenCliProxyMode } from '../../discovery/arxiv-transport.ts';
import type { ArxivConfig } from '../../types/config.ts';
import type { PaperMetadata } from '../../types/papers.ts';
import type { FetchedSource, ResearchCandidate } from '../../types/research-sources.ts';
import { canonicalJson } from '../../shared/manifest.ts';
import { approvedHttpsUrl, createHttpClient, ResearchAdapterError, withRequestLimits, type ResearchHttpClient } from '../http-client.ts';
import { sha256, sourceIdentity } from '../source-identity.ts';
import { normalizeResearchCandidate, sourceDate, sourceText } from '../source-normalizer.ts';
import { dateMatches, discoveryScope, fetchScope, type DiscoveryInput, type FetchInput, type SourceDiscoveryAdapter } from './types.ts';

type ArxivKind = 'paper' | 'technical-report';
const metadataPrefix = 'arxiv-metadata:';
const fail = (code: string): never => { throw new ResearchAdapterError(code); };
const sorted = (values: string[]) => [...new Set(values.map(sourceText))].sort();

function metadata(paper: PaperMetadata) {
  try {
    const id = paper.arxivId ?? paper.id ?? `${paper.baseId}v${paper.version}`;
    const match = id.match(/^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})v([1-9]\d*)$/);
    if (!match || (paper.baseId !== undefined && paper.baseId !== match[1])
      || (paper.version !== undefined && paper.version !== Number(match[2]))
      || !Number.isSafeInteger(Number(match[2])) || !Array.isArray(paper.authors) || !paper.authors.length
      || !Array.isArray(paper.categories) || typeof paper.summary !== 'string' || !paper.summary.trim()
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(paper.summary)) throw new Error();
    return { baseId: match[1], arxivId: id, version: Number(match[2]), title: sourceText(paper.title!),
      abstract: paper.summary, authors: sorted(paper.authors), categories: sorted(paper.categories),
      submittedAt: sourceDate(paper.submittedAt ?? paper.published!), updatedAt: sourceDate(paper.updatedAt ?? paper.updated!) };
  } catch { return fail('RESEARCH_ARXIV_METADATA_INVALID'); }
}

function candidateFor(input: DiscoveryInput, kind: ArxivKind, data: ReturnType<typeof metadata>, retrievedAt: string): ResearchCandidate {
  const scope = discoveryScope(input, kind);
  const url = approvedHttpsUrl(`https://arxiv.org/abs/${data.arxivId}`, scope);
  const pdf = approvedHttpsUrl(`https://arxiv.org/pdf/${data.arxivId}`, scope);
  const content = canonicalJson(data);
  if (Buffer.byteLength(content) > input.policy.maxResponseBytes) fail('RESEARCH_RESPONSE_TOO_LARGE');
  const contentSha256 = sha256(content);
  const identity = sourceIdentity({ kind, canonicalUrl: url, arxivId: data.arxivId, contentSha256 });
  const version = { sourceId: identity.sourceId, versionId: identity.versionId, versionLabel: data.arxivId,
    publishedAt: data.submittedAt, updatedAt: data.updatedAt, releasedAt: null, retrievedAt, contentSha256, archivePath: '',
    provenance: { adapter: 'arxiv', urls: [url, pdf], revision: data.arxivId,
      // Lossless portable discovery metadata; fetch never reruns a query or consults paper state.
      notes: [metadataPrefix + encodeURIComponent(content)] } };
  return normalizeResearchCandidate({ source: { sourceId: identity.sourceId, identityKey: identity.identityKey,
    kind, canonicalUrl: identity.canonicalUrl, title: data.title, authors: data.authors, publisher: 'arXiv',
    primaryTrack: input.track.id, secondaryTracks: [], dimensions: {} }, version,
    matchedTracks: [input.track.id], dateMatches: dateMatches(input, version), discoveryAdapter: 'arxiv' });
}

/** Explicit cross-discovery reduction: adapter instances never retain Track or workflow state. */
export function mergeArxivCandidates(candidates: readonly ResearchCandidate[]): ResearchCandidate[] {
  const merged = new Map<string, ResearchCandidate>();
  for (const input of candidates) {
    const candidate = normalizeResearchCandidate(input);
    if (candidate.discoveryAdapter !== 'arxiv' || !candidate.source.identityKey.startsWith('arxiv:')) fail('RESEARCH_ARXIV_METADATA_INVALID');
    const key = `${candidate.source.sourceId}:${candidate.version.versionId}`;
    const previous = merged.get(key);
    if (previous && (previous.version.contentSha256 !== candidate.version.contentSha256 || previous.source.kind !== candidate.source.kind)) fail('RESEARCH_SOURCE_CHANGED');
    const tracks = sorted([...(previous?.matchedTracks ?? []), ...candidate.matchedTracks]);
    // Deterministic observation selection also keeps the first retrieval time across Track ordering.
    const selected = previous && canonicalJson(previous.version) < canonicalJson(candidate.version) ? previous : candidate;
    merged.set(key, normalizeResearchCandidate({ ...selected,
      source: { ...selected.source, primaryTrack: tracks[0], secondaryTracks: tracks.slice(1) }, matchedTracks: tracks,
      dateMatches: sorted([...(previous?.dateMatches ?? []), ...candidate.dateMatches]) }));
  }
  return [...merged.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, candidate]) => candidate);
}

export class ArxivAdapter implements SourceDiscoveryAdapter {
  readonly id = 'arxiv';
  readonly kinds = ['paper', 'technical-report'] as const;
  private readonly runner: typeof runHarvestShards;
  private readonly http: ResearchHttpClient;
  private readonly now: () => string;
  private readonly arxiv: ArxivConfig;
  constructor(options: { arxiv: ArxivConfig; runner?: typeof runHarvestShards; http?: ResearchHttpClient; now?: () => string }) {
    this.arxiv = { ...options.arxiv }; this.runner = options.runner ?? runHarvestShards;
    this.http = options.http ?? createHttpClient(); this.now = options.now ?? (() => new Date().toISOString());
  }

  async discover(input: DiscoveryInput): Promise<readonly ResearchCandidate[]> {
    // Explicit source-kind policy is the classification, never a title/abstract heuristic.
    const kind = this.kinds.find(k => input.allowedSourceKinds.includes(k) && input.policy.sourceKinds.includes(k) && input.track.sourceKinds.includes(k));
    if (!kind) return fail('RESEARCH_POLICY_REJECTED');
    const scope = discoveryScope(input, kind);
    approvedHttpsUrl('https://arxiv.org/abs/', scope);
    const apiBase = resolveArxivApiBase(input.network?.arxivApiBase);
    approvedHttpsUrl(apiBase, scope);
    const proxyMode = resolveOpenCliProxyMode(input.network?.openCliProxyMode, input.network?.httpProxy !== undefined);
    // Validate configured routing before any OpenCLI work; this helper creates a fresh environment.
    buildOpenCliEnvironment({}, { mode: proxyMode, httpProxy: input.network?.httpProxy });
    if (!Array.isArray(input.track.arxivCategories) || !input.track.arxivCategories.length) return fail('RESEARCH_POLICY_REJECTED');
    const dateModes = [...new Set(input.track.dateFields.flatMap(field => field === 'published' ? ['submitted' as const] : field === 'updated' ? ['updated' as const] : []))];
    if (!dateModes.length) return fail('RESEARCH_POLICY_REJECTED');
    const categories = [...input.track.arxivCategories].sort();
    const shards = dateModes.map(dateMode => ({ track: input.track.id, query: input.query, dateMode, categories, maxResults: this.arxiv.maxResultsPerShard }));
    const papers = await withRequestLimits(scope, signal => this.runner(shards, { ...input.window }, {
      arxiv: { ...this.arxiv, requestTimeoutMs: Math.min(this.arxiv.requestTimeoutMs, input.policy.requestTimeoutMs), maxAttempts: Math.min(this.arxiv.maxAttempts, input.policy.maxAttempts) },
      network: { ...input.network, openCliProxyMode: proxyMode, arxivApiBase: apiBase }, signal,
    }));
    if (input.signal.aborted) return fail('RESEARCH_ABORTED');
    if (Buffer.byteLength(canonicalJson(papers)) > input.policy.maxResponseBytes) return fail('RESEARCH_RESPONSE_TOO_LARGE');
    const retrievedAt = this.now();
    return mergeArxivCandidates(papers.map(paper => candidateFor(input, kind, metadata(paper), retrievedAt)).filter(candidate => candidate.dateMatches.length));
  }

  async fetch(input: FetchInput): Promise<FetchedSource> {
    const scope = fetchScope(input, this);
    const candidate = input.candidate;
    discoveryScope(scope, candidate.source.kind);
    const notes = candidate.version.provenance.notes?.filter(note => note.startsWith(metadataPrefix)) ?? [];
    if (notes.length !== 1) return fail('RESEARCH_ARXIV_METADATA_INVALID');
    let data: ReturnType<typeof metadata>;
    try {
      const parsed = JSON.parse(decodeURIComponent(notes[0].slice(metadataPrefix.length)));
      data = metadata({ ...parsed, summary: parsed.abstract });
    } catch { return fail('RESEARCH_ARXIV_METADATA_INVALID'); }
    const verified = candidateFor(scope, candidate.source.kind as ArxivKind, data, candidate.version.retrievedAt);
    const sourceFacts = (value: ResearchCandidate) => {
      const { primaryTrack: _primary, secondaryTracks: _secondary, dimensions: _dimensions, ...facts } = value.source;
      return facts;
    };
    if (canonicalJson(sourceFacts(verified)) !== canonicalJson(sourceFacts(candidate))
      || canonicalJson({ ...verified.version, archivePath: '' }) !== canonicalJson({ ...candidate.version, archivePath: '' })) return fail('RESEARCH_SOURCE_CHANGED');
    const content = Buffer.from(canonicalJson(data));
    const remaining = scope.policy.maxResponseBytes - content.byteLength;
    if (remaining <= 0) return fail('RESEARCH_RESPONSE_TOO_LARGE');
    const pdfUrl = `https://arxiv.org/pdf/${data.arxivId}`;
    const response = await this.http.get(pdfUrl, { ...discoveryScope(scope, candidate.source.kind), policy: { ...scope.policy, maxResponseBytes: remaining } });
    if (response.url !== pdfUrl) return fail('RESEARCH_SOURCE_CHANGED');
    if (!Buffer.from(response.bytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))) return fail('RESEARCH_PDF_INVALID');
    return { source: candidate.source, version: candidate.version,
      files: [{ path: 'content.txt', contents: content }, { path: 'source.pdf', contents: response.bytes }],
      locators: [{ artifactPath: 'content.txt', section: 'Abstract', fragment: '/abstract' },
        { artifactPath: 'content.txt', section: 'Authors', fragment: '/authors' },
        { artifactPath: 'content.txt', section: 'Categories', fragment: '/categories' },
        { artifactPath: 'source.pdf', section: data.arxivId }] };
  }
}
