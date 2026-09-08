import { createHash } from 'node:crypto';
import type { ResearchArchiveManifest } from '../research/source-archive.ts';
import { readVerifiedResearchArchive } from '../research/source-archive.ts';
import { canonicalJson, normalizeArchivePath } from '../shared/manifest.ts';
import { evidenceSourceRoot } from '../shared/research-evidence-policy.ts';
import { sha256 as sourceSha256 } from '../research/source-identity.ts';
import type { CitationLocator } from '../types/research-sources.ts';
import type { RenderedFile } from './render-paper.ts';
import { renderResearchIndexes } from './render-source-indexes.ts';

export type VerifiedResearchArchive = Awaited<ReturnType<typeof readVerifiedResearchArchive>>;

const encoder = new TextEncoder();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (value: string) => value.replace(/\r\n?/g, '\n');
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function rendered(path: string, body: string | Uint8Array): RenderedFile {
  const bytes = typeof body === 'string' ? encoder.encode(text(body)) : new Uint8Array(body);
  return { path: normalizeArchivePath(path), bytes, sha256: hash(bytes) };
}

function metadata(archive: VerifiedResearchArchive): { locators: CitationLocator[] } {
  const bytes = archive.files.get('metadata.json');
  if (!bytes) throw new Error('RESEARCH_EVIDENCE_ARCHIVE_METADATA_MISSING');
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as { locators?: unknown };
  if (!Array.isArray(value.locators)) throw new Error('RESEARCH_EVIDENCE_ARCHIVE_LOCATORS_MISSING');
  return { locators: value.locators as CitationLocator[] };
}

function archiveHash(manifest: ResearchArchiveManifest): string {
  return sourceSha256(canonicalJson(manifest));
}

function facts(source: ResearchArchiveManifest['source']): string {
  const dimensions = source.dimensions ?? {};
  return [
    '## Structured facts',
    '',
    'These fields are copied from the verified source metadata; this page does not infer conclusions.',
    '',
    '```json',
    canonicalJson(dimensions).trimEnd(),
    '```',
    '',
  ].join('\n');
}

function renderSourcePage(manifest: ResearchArchiveManifest, archiveManifestSha256: string): string {
  const source = manifest.source, version = manifest.version;
  return [
    '---',
    `schema_version: 1`,
    `source_id: ${JSON.stringify(source.sourceId)}`,
    `version_id: ${JSON.stringify(version.versionId)}`,
    `source_kind: ${JSON.stringify(source.kind)}`,
    `identity_key: ${JSON.stringify(source.identityKey)}`,
    `canonical_url: ${JSON.stringify(source.canonicalUrl)}`,
    `publisher: ${JSON.stringify(source.publisher)}`,
    `authors: ${JSON.stringify(source.authors)}`,
    `primary_track: ${JSON.stringify(source.primaryTrack)}`,
    `secondary_tracks: ${JSON.stringify(source.secondaryTracks)}`,
    `published_at: ${JSON.stringify(version.publishedAt)}`,
    `updated_at: ${JSON.stringify(version.updatedAt)}`,
    `released_at: ${JSON.stringify(version.releasedAt)}`,
    `retrieved_at: ${JSON.stringify(version.retrievedAt)}`,
    `content_sha256: ${JSON.stringify(version.contentSha256)}`,
    `archive_manifest_sha256: ${JSON.stringify(archiveManifestSha256)}`,
    '---',
    '',
    `# ${source.title}`,
    '',
    `- Source kind: \`${source.kind}\``,
    `- Version: \`${version.versionId}\``,
    `- Canonical URL: ${source.canonicalUrl || '(local artifact)'}`,
    `- Archive: \`${version.archivePath}\``,
    '',
    facts(source),
  ].join('\n');
}

function renderCitations(manifest: ResearchArchiveManifest, locators: readonly CitationLocator[]): string {
  const rows = [...locators].map(locator => `- ${canonicalJson(locator).trim()}`).sort(compare);
  return [`# Citations`, '', `Source: ${manifest.source.title} (${manifest.version.versionId})`, '', ...(rows.length ? rows : ['- None']), ''].join('\n');
}

/** Render one verified generic research Archive without filesystem writes. */
export async function renderResearchSourceEvidence(input: {
  archive: VerifiedResearchArchive;
  evidenceRoot: string;
}): Promise<readonly RenderedFile[]> {
  void input.evidenceRoot;
  const manifest = input.archive.manifest;
  const root = evidenceSourceRoot(manifest.source, manifest.version);
  const archiveManifestSha256 = archiveHash(manifest);
  const locators = metadata(input.archive).locators;
  const content = input.archive.files.get('content.md') ?? input.archive.files.get('content.txt');
  if (!content) throw new Error('RESEARCH_EVIDENCE_CONTENT_MISSING');
  const files: RenderedFile[] = [
    rendered(`${root}/index.md`, renderSourcePage(manifest, archiveManifestSha256)),
    rendered(`${root}/source.md`, renderSourcePage(manifest, archiveManifestSha256)),
    rendered(`${root}/content.md`, content),
    rendered(`${root}/citations.md`, renderCitations(manifest, locators)),
  ];
  const inventory = files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes.byteLength }));
  files.push(rendered(`${root}/manifest.json`, canonicalJson({
    schemaVersion: 1, generatorVersion: 1, sourceId: manifest.sourceId, versionId: manifest.versionId,
    sourceKind: manifest.sourceKind, archiveManifestSha256, files: inventory,
  })));
  return files.sort((left, right) => compare(left.path, right.path));
}

export { renderResearchIndexes } from './render-source-indexes.ts';
