import { sourceIdentity, sha256 } from '../../src/research/source-identity.ts';
import type { ResearchSource, SourceVersion } from '../../src/types/research-sources.ts';

export function researchFixture(revision = 'r1', content = 'Agent guide\n') {
  const identity = sourceIdentity({ kind: 'official-doc', canonicalUrl: 'https://openai.com/docs', revision, contentSha256: sha256(content) });
  const source: ResearchSource = { sourceId: identity.sourceId, identityKey: identity.identityKey, kind: 'official-doc', canonicalUrl: identity.canonicalUrl, title: 'Agent guide', publisher: 'OpenAI', authors: [], primaryTrack: 'runtime', secondaryTracks: ['tools'], dimensions: {} };
  const version: SourceVersion = { sourceId: source.sourceId, versionId: identity.versionId, versionLabel: revision, publishedAt: null, updatedAt: null, releasedAt: null, retrievedAt: '2026-09-06T00:00:00.000Z', contentSha256: sha256(content), archivePath: '', provenance: { adapter: 'docs', urls: [source.canonicalUrl] } };
  return { source, version, files: [{ path: 'content.md', contents: Buffer.from(content) }], locators: [] };
}
