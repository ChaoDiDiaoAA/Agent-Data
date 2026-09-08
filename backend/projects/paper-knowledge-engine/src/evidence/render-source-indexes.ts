import type { ResearchArchiveManifest } from '../research/source-archive.ts';
import type { VerifiedResearchArchive } from './render-source.ts';
import type { RenderedFile } from './render-paper.ts';
import { SOURCE_EVIDENCE_LAYOUT_V1, evidenceSourceRoot } from '../shared/research-evidence-policy.ts';
import { canonicalJson } from '../shared/manifest.ts';
import { createHash } from 'node:crypto';

const encoder = new TextEncoder();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function file(path: string, value: string): RenderedFile {
  const bytes = encoder.encode(value.replace(/\r\n?/g, '\n'));
  return { path, bytes, sha256: hash(bytes) };
}

function entries(sources: readonly VerifiedResearchArchive[]): ResearchArchiveManifest[] {
  return sources.map(source => source.manifest).sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.versionId.localeCompare(b.versionId));
}

function link(manifest: ResearchArchiveManifest): string {
  return `- [${manifest.source.title} — ${manifest.versionId}](${evidenceSourceRoot(manifest.source, manifest.version)}/index.md)`;
}

function indexFor(
  title: string,
  values: readonly { value: string; manifest: ResearchArchiveManifest }[],
): string {
  const grouped = new Map<string, ResearchArchiveManifest[]>();
  for (const item of values) grouped.set(item.value, [...(grouped.get(item.value) ?? []), item.manifest]);
  const lines = [`# ${title}`, '', 'Generated from verified research source metadata.', ''];
  for (const value of [...grouped.keys()].sort(compare)) {
    lines.push(`## ${value}`, '');
    const unique = new Map(grouped.get(value)!.map(manifest => [`${manifest.sourceId}/${manifest.versionId}`, manifest]));
    for (const manifest of [...unique.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.versionId.localeCompare(b.versionId))) lines.push(link(manifest));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function topicIndex(manifests: readonly ResearchArchiveManifest[]): string {
  const grouped = new Map<string, ResearchArchiveManifest[]>();
  for (const manifest of manifests) {
    const tracks = [manifest.source.primaryTrack, ...manifest.source.secondaryTracks].sort(compare);
    const key = tracks.join(', ');
    grouped.set(key, [...(grouped.get(key) ?? []), manifest]);
  }
  const lines = ['# Topics', '', 'Generated from verified research source metadata.', ''];
  for (const key of [...grouped.keys()].sort(compare)) {
    lines.push(`## ${key}`, '');
    for (const manifest of [...grouped.get(key)!].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.versionId.localeCompare(b.versionId))) {
      lines.push(link(manifest));
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export async function renderResearchIndexes(input: { sources: readonly VerifiedResearchArchive[] }): Promise<readonly RenderedFile[]> {
  const manifests = entries(input.sources);
  const lifecycleValues = manifests.flatMap(manifest => (manifest.source.dimensions.lifecycles ?? []).map(value => ({ value, manifest })));
  const conceptValues = manifests.flatMap(manifest => [
    ...(manifest.source.dimensions.controlBoundaries ?? []), ...(manifest.source.dimensions.testingLevels ?? []),
    ...(manifest.source.dimensions.evaluation?.objects ?? []), ...(manifest.source.dimensions.permissions?.capabilities ?? []),
    ...(manifest.source.dimensions.identityTenancy?.tenants ?? []),
  ].map(value => ({ value, manifest })));
  const sourceTypeValues = manifests.map(manifest => ({ value: manifest.source.kind, manifest }));
  return [
    file(SOURCE_EVIDENCE_LAYOUT_V1.indexRoots.topics, topicIndex(manifests)),
    file(SOURCE_EVIDENCE_LAYOUT_V1.indexRoots.sourceTypes, indexFor('Source types', sourceTypeValues)),
    file(SOURCE_EVIDENCE_LAYOUT_V1.indexRoots.lifecycles, indexFor('Lifecycles', lifecycleValues)),
    file(SOURCE_EVIDENCE_LAYOUT_V1.indexRoots.concepts, indexFor('Concepts', conceptValues)),
  ].sort((left, right) => compare(left.path, right.path));
}
