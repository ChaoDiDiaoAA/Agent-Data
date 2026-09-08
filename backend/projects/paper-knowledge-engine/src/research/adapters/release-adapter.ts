import type { FetchedSource, ResearchCandidate } from '../../types/research-sources.ts';
import { canonicalJson } from '../../shared/manifest.ts';
import { approvedHttpsUrl, ResearchAdapterError, type HttpScope, type ResearchHttpClient } from '../http-client.ts';
import { normalizeResearchCandidate, sourceDate, sourceText } from '../source-normalizer.ts';
import { sha256, sourceIdentity } from '../source-identity.ts';
import { dateMatches, discoveryScope, fetchScope, type DiscoveryInput, type FetchInput, type SourceDiscoveryAdapter } from './types.ts';

interface ReleaseAssetMetadata {
  name: string;
  url: string;
  mediaType: string;
  size: number;
}

interface ReleaseMetadata {
  projectUrl: string;
  releaseUrl: string;
  visibility: 'public';
  tag: string;
  name: string;
  notes: string;
  publishedAt: string;
  updatedAt: string | null;
  assets: ReleaseAssetMetadata[];
  provider: { name: 'github'; repositoryUrl: string; releaseUrl: string; releaseId: number };
}

interface CapturedRelease { candidate: ResearchCandidate; fetched: FetchedSource }

const fail = (code: string): never => { throw new ResearchAdapterError(code); };
const textBytes = (value: string) => new TextEncoder().encode(value);

function fixedTag(value: string | undefined): string {
  if (typeof value !== 'string') return fail('RESEARCH_RELEASE_TAG_REJECTED');
  const tag = /^refs\/tags\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(value)?.[1];
  if (!tag || tag.endsWith('.') || tag.endsWith('.lock') || tag.includes('..')) return fail('RESEARCH_RELEASE_TAG_REJECTED');
  return tag;
}

function githubEndpoints(projectUrl: string, tag: string) {
  const url = new URL(projectUrl);
  if (url.origin !== 'https://github.com' || url.search) return fail('RESEARCH_RELEASE_PROVIDER_REJECTED');
  url.pathname = url.pathname.replace(/\.git\/?$/i, '').replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(url.pathname)) return fail('RESEARCH_RELEASE_PROVIDER_REJECTED');
  const repositoryApiUrl = `https://api.github.com/repos${url.pathname}`;
  return { repositoryApiUrl, releaseApiUrl: `${repositoryApiUrl}/releases/tags/${encodeURIComponent(tag)}`,
    releaseUrl: `${url.href}/releases/tag/${encodeURIComponent(tag)}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizedNotes(value: unknown): string {
  if (typeof value !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return fail('RESEARCH_RELEASE_METADATA_REJECTED');
  // Normalize CRLF/CR to LF and remove only final whitespace. Leading blank lines,
  // code indentation and internal Markdown hard-break spaces remain meaningful.
  return value.replace(/\r\n?/g, '\n').replace(/[ \t\n]+$/, '');
}

export class ReleaseAdapter implements SourceDiscoveryAdapter {
  readonly id = 'release';
  readonly kinds = ['release'] as const;
  private readonly http: ResearchHttpClient;
  private readonly now: () => string;

  constructor(options: { http: ResearchHttpClient; now?: () => string }) {
    this.http = options.http;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async json(url: string, scope: HttpScope) {
    const response = await this.http.get(url, scope);
    const contentType = response.headers.get('content-type') ?? '';
    if (response.url !== url || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)
      || (/charset=/i.test(contentType) && !/charset\s*=\s*"?utf-8"?(?:\s*;|$)/i.test(contentType))) {
      return fail('RESEARCH_RELEASE_METADATA_REJECTED');
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)); }
    catch { return fail('RESEARCH_RELEASE_METADATA_REJECTED'); }
    return { value, response };
  }

  private publicRepository(value: unknown, scope: HttpScope, expectedProjectUrl: string, repositoryApiUrl: string, tag: string) {
    if (!isRecord(value)) return fail('RESEARCH_RELEASE_METADATA_REJECTED');
    if (value.private === true || value.visibility === 'private') return fail('RESEARCH_RELEASE_PRIVATE');
    try {
      if (value.private !== false || value.visibility !== 'public' || typeof value.html_url !== 'string'
        || typeof value.url !== 'string' || approvedHttpsUrl(value.url, scope) !== repositoryApiUrl) throw new Error();
      const project = sourceIdentity({ kind: 'repository', canonicalUrl: approvedHttpsUrl(value.html_url, scope),
        contentSha256: '0'.repeat(64), tag });
      if (project.canonicalUrl !== expectedProjectUrl) throw new Error();
    } catch { return fail('RESEARCH_RELEASE_METADATA_REJECTED'); }
  }

  // GitHub REST GET /repos/{owner}/{repo}/releases/tags/{tag}; the HTML
  // release URL is provenance only. Provider URLs never become arbitrary fetch targets.
  private metadata(value: unknown, input: DiscoveryInput, expectedProjectUrl: string,
    endpoints: ReturnType<typeof githubEndpoints>, expectedTag: string): ReleaseMetadata {
    if (!isRecord(value)) return fail('RESEARCH_RELEASE_METADATA_REJECTED');
    if (value.draft === true) return fail('RESEARCH_RELEASE_PRIVATE');
    try {
      if (value.draft !== false || typeof value.html_url !== 'string' || typeof value.url !== 'string'
        || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1
        || typeof value.tag_name !== 'string' || typeof value.published_at !== 'string'
        || !Array.isArray(value.assets)) throw new Error();
      const scope = discoveryScope(input, 'release');
      const finalReleaseUrl = approvedHttpsUrl(value.html_url, scope);
      const providerReleaseUrl = approvedHttpsUrl(value.url, scope);
      if (finalReleaseUrl !== endpoints.releaseUrl || value.tag_name !== expectedTag
        || providerReleaseUrl !== `${endpoints.repositoryApiUrl}/releases/${value.id}`) throw new Error();
      const name = sourceText((value.name === null || value.name === '') ? expectedTag : value.name as string);
      const notes = normalizedNotes(value.body ?? '');
      const publishedAt = sourceDate(value.published_at);
      // created_at is not an update timestamp. GitHub responses may omit updated_at.
      const updatedAt = value.updated_at == null ? null : sourceDate(value.updated_at as string);
      const assets = value.assets.map(item => {
        if (!isRecord(item) || typeof item.name !== 'string' || typeof item.browser_download_url !== 'string' || typeof item.content_type !== 'string'
          || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error();
        const asset = { name: sourceText(item.name), url: approvedHttpsUrl(item.browser_download_url, scope),
          mediaType: sourceText(item.content_type), size: item.size };
        if (new URL(asset.url).origin !== new URL(endpoints.releaseUrl).origin) throw new Error();
        return asset;
      }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.url < right.url ? -1 : left.url > right.url ? 1 : 0);
      return { projectUrl: expectedProjectUrl, releaseUrl: finalReleaseUrl, visibility: 'public', tag: expectedTag,
        name, notes, publishedAt, updatedAt, assets,
        provider: { name: 'github', repositoryUrl: endpoints.repositoryApiUrl, releaseUrl: providerReleaseUrl, releaseId: value.id } };
    } catch (error) {
      if (error instanceof ResearchAdapterError && error.code === 'RESEARCH_RELEASE_PRIVATE') throw error;
      return fail('RESEARCH_RELEASE_METADATA_REJECTED');
    }
  }

  private async capture(input: DiscoveryInput, target: NonNullable<DiscoveryInput['targets']>[number]): Promise<CapturedRelease> {
    if (target.kind !== 'release') fail('RESEARCH_POLICY_REJECTED');
    const scope = discoveryScope(input, 'release');
    const approvedProjectUrl = approvedHttpsUrl(target.url, scope);
    const tag = fixedTag(target.revision);
    const endpoints = githubEndpoints(approvedProjectUrl, tag);
    // Both hosts must be explicitly approved by policy, request and Track before I/O.
    for (const url of Object.values(endpoints)) approvedHttpsUrl(url, scope);
    const projectUrl = sourceIdentity({ kind: 'release', canonicalUrl: approvedProjectUrl,
      contentSha256: '0'.repeat(64), tag }).canonicalUrl;
    const repository = await this.json(endpoints.repositoryApiUrl, scope);
    this.publicRepository(repository.value, scope, projectUrl, endpoints.repositoryApiUrl, tag);
    const { value, response } = await this.json(endpoints.releaseApiUrl, scope);
    const release = this.metadata(value, input, projectUrl, endpoints, tag);
    const markdown = `# ${release.name}\n${release.notes ? `\n${release.notes}\n` : ''}`;
    const metadata = {
      schemaVersion: 1, projectUrl: release.projectUrl, releaseUrl: release.releaseUrl, visibility: release.visibility,
      tag: release.tag, name: release.name, publishedAt: release.publishedAt, updatedAt: release.updatedAt, assets: release.assets,
      provider: release.provider,
    };
    const metadataJson = canonicalJson(metadata);
    if (Buffer.byteLength(markdown) + Buffer.byteLength(metadataJson) > scope.policy.maxResponseBytes) fail('RESEARCH_RESPONSE_TOO_LARGE');
    const contentSha256 = sha256(canonicalJson({ metadata, markdown }));
    const identity = sourceIdentity({ kind: 'release', canonicalUrl: release.projectUrl, contentSha256, tag });
    const parent = sourceIdentity({ kind: 'repository', canonicalUrl: release.projectUrl, contentSha256, tag });
    const retrievedAt = this.now();
    const source = {
      sourceId: identity.sourceId, identityKey: identity.identityKey, kind: 'release' as const, canonicalUrl: identity.canonicalUrl,
      title: release.name, publisher: new URL(identity.canonicalUrl).hostname, authors: [], primaryTrack: input.track.id,
      secondaryTracks: [], dimensions: {},
    };
    const notes = [`asset-count:${release.assets.length}`];
    const etag = response.headers.get('etag');
    if (etag) notes.push(`etag:${etag}`);
    const version = {
      sourceId: source.sourceId, versionId: identity.versionId, versionLabel: release.name,
      publishedAt: null, updatedAt: release.updatedAt, releasedAt: release.publishedAt, retrievedAt, contentSha256, archivePath: '',
      provenance: { adapter: this.id, urls: [release.projectUrl, release.releaseUrl, endpoints.repositoryApiUrl, endpoints.releaseApiUrl],
        parentSourceId: parent.sourceId, revision: tag, notes },
    };
    const candidate = normalizeResearchCandidate({ source, version, matchedTracks: [input.track.id],
      dateMatches: dateMatches(input, version), discoveryAdapter: this.id });
    return {
      candidate,
      fetched: {
        source: candidate.source, version: candidate.version,
        files: [{ path: 'content.md', contents: textBytes(markdown) }, { path: 'metadata/release.json', contents: textBytes(metadataJson) }],
        locators: [{ artifactPath: 'content.md', section: release.name, startLine: 1, endLine: 1 }],
      },
    };
  }

  async discover(input: DiscoveryInput): Promise<readonly ResearchCandidate[]> {
    discoveryScope(input, 'release');
    const candidates: ResearchCandidate[] = [];
    for (const target of input.targets ?? []) {
      const { candidate } = await this.capture(input, target);
      if (candidate.dateMatches.length) candidates.push(candidate);
    }
    return candidates;
  }

  async fetch(input: FetchInput): Promise<FetchedSource> {
    const scope = fetchScope(input, this);
    const approvedScope = discoveryScope(scope, 'release');
    const matching = (scope.targets ?? []).filter(target => {
      if (target.kind !== 'release') return false;
      try {
        const tag = fixedTag(target.revision);
        const identity = sourceIdentity({ kind: 'release', canonicalUrl: approvedHttpsUrl(target.url, approvedScope),
          contentSha256: input.candidate.version.contentSha256, tag });
        return identity.canonicalUrl === input.candidate.source.canonicalUrl && identity.versionId === input.candidate.version.versionId;
      } catch { return false; }
    });
    if (matching.length !== 1) fail('RESEARCH_APPROVAL_REQUIRED');
    const { candidate, fetched } = await this.capture(scope, matching[0]);
    // Retrieval time is refreshed by capture; it is never restored from replay.
    const { retrievedAt: _approvedTime, ...approvedVersion } = input.candidate.version;
    const { retrievedAt: _currentTime, ...currentVersion } = candidate.version;
    if (canonicalJson(candidate.source) !== canonicalJson(input.candidate.source)
      || canonicalJson(currentVersion) !== canonicalJson(approvedVersion)) fail('RESEARCH_SOURCE_CHANGED');
    if (!candidate.dateMatches.length) fail('RESEARCH_POLICY_REJECTED');
    return fetched;
  }
}
