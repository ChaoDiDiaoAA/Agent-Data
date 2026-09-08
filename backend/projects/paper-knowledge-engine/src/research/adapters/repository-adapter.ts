import type { FetchedSource, ResearchCandidate } from '../../types/research-sources.ts';
import { canonicalJson } from '../../shared/manifest.ts';
import { archivePath } from '../../shared/archive-v2.ts';
import { approvedHttpsUrl, ResearchAdapterError, withRequestLimits } from '../http-client.ts';
import { normalizeResearchCandidate } from '../source-normalizer.ts';
import { sha256, sourceIdentity } from '../source-identity.ts';
import { dateMatches, discoveryScope, fetchScope, type DiscoveryInput, type FetchInput, type SourceDiscoveryAdapter } from './types.ts';

export interface RepositoryReadRequest {
  readonly url: string;
  readonly revision: { readonly kind: 'commit' | 'tag'; readonly value: string };
  readonly maxBytes: number;
  readonly signal: AbortSignal;
  readonly safety: {
    readonly readOnly: true;
    readonly hooks: 'disabled';
    readonly builds: 'disabled';
    readonly repositoryCode: 'never-execute';
  };
}

export interface RepositorySnapshotFile {
  readonly path: string;
  readonly type: 'text' | 'binary' | 'symlink';
  readonly contents: Uint8Array;
}

export interface RepositorySnapshot {
  readonly canonicalUrl: string;
  readonly visibility: 'public' | 'private';
  readonly commit: string;
  readonly tag: string | null;
  readonly defaultBranch: string | null;
  readonly files: readonly RepositorySnapshotFile[];
}

export interface RepositoryReadBoundary {
  read(input: RepositoryReadRequest): Promise<RepositorySnapshot>;
}

type FixedRevision = RepositoryReadRequest['revision'];
interface CapturedRepository { candidate: ResearchCandidate; fetched: FetchedSource }

const fail = (code: string): never => { throw new ResearchAdapterError(code); };
const textBytes = (value: string) => new TextEncoder().encode(value);

function fixedRevision(value: string | undefined): FixedRevision {
  if (typeof value !== 'string') return fail('RESEARCH_REPOSITORY_REVISION_REJECTED');
  if (/^[0-9a-fA-F]{40}$/.test(value)) return { kind: 'commit', value: value.toLowerCase() };
  const tag = /^refs\/tags\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(value)?.[1];
  if (!tag || tag.endsWith('.') || tag.endsWith('.lock') || tag.includes('..')) return fail('RESEARCH_REPOSITORY_REVISION_REJECTED');
  return { kind: 'tag', value: tag };
}

function safeBranch(value: string | null): value is string | null {
  return value === null || (/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)
    && !value.includes('..') && !value.includes('//') && !value.includes('@{')
    && !value.endsWith('/') && !value.endsWith('.') && !value.endsWith('.lock'));
}

function repositoryIdentity(url: string, revision: FixedRevision) {
  return sourceIdentity({ kind: 'repository', canonicalUrl: url, contentSha256: '0'.repeat(64),
    ...(revision.kind === 'commit' ? { commit: revision.value } : { tag: revision.value }) });
}

function snapshotFile(value: unknown): RepositorySnapshotFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('RESEARCH_REPOSITORY_TYPE_REJECTED');
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !['path', 'type', 'contents'].every(key => fields[key] && 'value' in fields[key])) {
    return fail('RESEARCH_REPOSITORY_TYPE_REJECTED');
  }
  const path: unknown = fields.path.value, type: unknown = fields.type.value, contents: unknown = fields.contents.value;
  if (type !== 'text' || typeof path !== 'string' || !(contents instanceof Uint8Array)) return fail('RESEARCH_REPOSITORY_TYPE_REJECTED');
  return { path, type, contents };
}

export class RepositoryAdapter implements SourceDiscoveryAdapter {
  readonly id = 'repository';
  readonly kinds = ['repository'] as const;
  private readonly repository: RepositoryReadBoundary;
  private readonly now: () => string;

  constructor(options: { repository: RepositoryReadBoundary; now?: () => string }) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async capture(input: DiscoveryInput, target: NonNullable<DiscoveryInput['targets']>[number]): Promise<CapturedRepository> {
    if (target.kind !== 'repository') fail('RESEARCH_POLICY_REJECTED');
    const scope = discoveryScope(input, 'repository');
    const url = approvedHttpsUrl(target.url, scope);
    const revision = fixedRevision(target.revision);
    const requested = repositoryIdentity(url, revision);
    let snapshot: RepositorySnapshot;
    try {
      snapshot = await withRequestLimits(scope, signal => this.repository.read({
        url,
        revision,
        maxBytes: scope.policy.maxResponseBytes,
        signal,
        safety: { readOnly: true, hooks: 'disabled', builds: 'disabled', repositoryCode: 'never-execute' },
      }));
    } catch (error) {
      if (error instanceof ResearchAdapterError) throw error;
      return fail('RESEARCH_REPOSITORY_READ_FAILED');
    }
    if (input.signal.aborted) fail('RESEARCH_ABORTED');
    if (!snapshot || typeof snapshot !== 'object' || snapshot.visibility === 'private') {
      if (snapshot?.visibility === 'private') fail('RESEARCH_REPOSITORY_PRIVATE');
      fail('RESEARCH_REPOSITORY_METADATA_REJECTED');
    }
    if (snapshot.visibility !== 'public' || !/^[0-9a-fA-F]{40}$/.test(snapshot.commit)
      || !safeBranch(snapshot.defaultBranch)) fail('RESEARCH_REPOSITORY_METADATA_REJECTED');
    const resolvedCommit = snapshot.commit.toLowerCase();
    approvedHttpsUrl(snapshot.canonicalUrl, scope);
    const resolved = repositoryIdentity(snapshot.canonicalUrl, { kind: 'commit', value: resolvedCommit });
    if (resolved.canonicalUrl !== requested.canonicalUrl
      || (revision.kind === 'commit' && (resolvedCommit !== revision.value || snapshot.tag !== null))
      || (revision.kind === 'tag' && snapshot.tag !== revision.value)) fail('RESEARCH_REPOSITORY_METADATA_REJECTED');

    const paths = new Set<string>();
    const files: { path: string; content: string; sha256: string }[] = [];
    let totalBytes = 0;
    if (!Array.isArray(snapshot.files)) fail('RESEARCH_REPOSITORY_METADATA_REJECTED');
    for (const entry of snapshot.files) {
      const file = snapshotFile(entry);
      let path: string;
      try { path = archivePath(file.path); } catch { return fail('RESEARCH_REPOSITORY_PATH_REJECTED'); }
      const key = path.toLowerCase();
      if (paths.has(key)) fail('RESEARCH_REPOSITORY_PATH_REJECTED');
      paths.add(key);
      totalBytes += file.contents.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > scope.policy.maxResponseBytes) fail('RESEARCH_RESPONSE_TOO_LARGE');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.contents); }
      catch { return fail('RESEARCH_REPOSITORY_TYPE_REJECTED'); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) fail('RESEARCH_REPOSITORY_TYPE_REJECTED');
      files.push({ path, content, sha256: sha256(file.contents) });
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const repository = { url: requested.canonicalUrl, commit: resolvedCommit, tag: snapshot.tag, defaultBranch: snapshot.defaultBranch };
    const content = canonicalJson({ schemaVersion: 1, repository, files });
    if (Buffer.byteLength(content) > scope.policy.maxResponseBytes) fail('RESEARCH_RESPONSE_TOO_LARGE');
    const contentSha256 = sha256(content);
    const identity = sourceIdentity({ kind: 'repository', canonicalUrl: requested.canonicalUrl, contentSha256,
      ...(revision.kind === 'commit' ? { commit: revision.value } : { tag: revision.value }) });
    const retrievedAt = this.now();
    const source = {
      sourceId: identity.sourceId, identityKey: identity.identityKey, kind: 'repository' as const, canonicalUrl: identity.canonicalUrl,
      title: new URL(identity.canonicalUrl).pathname.replace(/^\//, '') || 'Repository', publisher: new URL(identity.canonicalUrl).hostname,
      authors: [], primaryTrack: input.track.id, secondaryTracks: [], dimensions: {},
    };
    const notes = [`default-branch:${snapshot.defaultBranch ?? 'unknown'}`];
    if (snapshot.tag !== null) notes.push(`tag:${snapshot.tag}`);
    const version = {
      sourceId: source.sourceId, versionId: identity.versionId, versionLabel: identity.versionId,
      publishedAt: null, updatedAt: null, releasedAt: null, retrievedAt, contentSha256, archivePath: '',
      provenance: { adapter: this.id, urls: [identity.canonicalUrl], revision: resolvedCommit, notes },
    };
    const candidate = normalizeResearchCandidate({ source, version, matchedTracks: [input.track.id],
      dateMatches: dateMatches(input, version), discoveryAdapter: this.id });
    const fetched: FetchedSource = {
      source: candidate.source, version: candidate.version,
      files: [{ path: 'content.txt', contents: textBytes(content) }],
      locators: files.map((file, index) => ({ artifactPath: 'content.txt', section: file.path, fragment: `/files/${index}` })),
    };
    return { candidate, fetched };
  }

  async discover(input: DiscoveryInput): Promise<readonly ResearchCandidate[]> {
    discoveryScope(input, 'repository');
    const candidates: ResearchCandidate[] = [];
    for (const target of input.targets ?? []) {
      const { candidate } = await this.capture(input, target);
      if (candidate.dateMatches.length) candidates.push(candidate);
    }
    return candidates;
  }

  async fetch(input: FetchInput): Promise<FetchedSource> {
    const scope = fetchScope(input, this);
    const approvedScope = discoveryScope(scope, 'repository');
    const matching = (scope.targets ?? []).filter(target => {
      if (target.kind !== 'repository') return false;
      try {
        const revision = fixedRevision(target.revision);
        const identity = repositoryIdentity(approvedHttpsUrl(target.url, approvedScope), revision);
        return identity.canonicalUrl === input.candidate.source.canonicalUrl && identity.versionId === input.candidate.version.versionId;
      } catch { return false; }
    });
    if (matching.length !== 1) fail('RESEARCH_APPROVAL_REQUIRED');
    const { candidate, fetched } = await this.capture(scope, matching[0]);
    // Retrieval time belongs to this observation, not the serialized candidate. Every
    // stable version field (including provenance arrays) and the full source must match.
    const { retrievedAt: _approvedTime, ...approvedVersion } = input.candidate.version;
    const { retrievedAt: _currentTime, ...currentVersion } = candidate.version;
    if (canonicalJson(candidate.source) !== canonicalJson(input.candidate.source)
      || canonicalJson(currentVersion) !== canonicalJson(approvedVersion)) fail('RESEARCH_SOURCE_CHANGED');
    if (!candidate.dateMatches.length) fail('RESEARCH_POLICY_REJECTED');
    return fetched;
  }
}
