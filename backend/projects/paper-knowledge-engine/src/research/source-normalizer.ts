import type { ResearchCandidate, ResearchSource, SourceVersion, SourceDimensions, SourceProvenance, TopicTaxonomyConfig } from '../types/research-sources.ts';
import { canonicalJson } from '../shared/manifest.ts';
import { normalizeSourceUrl, requireSourceKind, requireSourceHash, requireVersionId, sha256, sourceIdentity } from './source-identity.ts';
import { archivePath } from '../shared/archive-v2.ts';

export function sourceText(value: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('invalid source text');
  return value.trim().replace(/\s+/g, ' ');
}
const texts = (values: string[]): string[] => [...new Set(values.map(sourceText))].sort();
const canonical = <T>(value: T): T => JSON.parse(canonicalJson(value));
export function sourceDate(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new TypeError('invalid source date');
  return new Date(value).toISOString();
}
const dimensionGroups: Record<string, string[]> = {
  evaluation: ['objects', 'units', 'adjudicators', 'metrics', 'replayStrategies'],
  permissions: ['subjects', 'capabilities', 'resourceScopes', 'grants', 'denies', 'approvals', 'audits'],
  identityTenancy: ['subjects', 'tenants', 'organizations', 'teams', 'memberships', 'roles', 'ownership', 'visibility', 'quotas', 'costs', 'audits'],
  loop: ['iterationInputs', 'actions', 'observations', 'termination', 'retry', 'maxIterations'],
};
function dimensions(input: SourceDimensions, taxonomy?: TopicTaxonomyConfig): SourceDimensions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid source dimensions');
  const normalize = (value: unknown, keys: string[], group?: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid dimension group');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (!keys.includes(key)) throw new TypeError('unknown source dimension');
      if (!group && dimensionGroups[key]) return [key, normalize(item, dimensionGroups[key], key)];
      if (key === 'maxIterations') {
        if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1) throw new TypeError('maxIterations must be a positive safe integer');
        return [key, item];
      }
      const values = key === 'evidenceLevel' ? [sourceText(item as string)] : texts(item as string[]);
      const allowed = group === 'evaluation' ? taxonomy?.evaluationDimensions[key as keyof TopicTaxonomyConfig['evaluationDimensions']]
        : !group ? (taxonomy as unknown as Record<string, string[]> | undefined)?.[key === 'evidenceLevel' ? 'evidenceLevels' : key] : undefined;
      if (allowed && values.some(v => !allowed.includes(v))) throw new TypeError('dimension is outside taxonomy');
      return [key, key === 'evidenceLevel' ? values[0] : values];
    }));
  };
  return normalize(input, ['lifecycles', 'controlBoundaries', 'evidenceLevel', 'testingLevels', ...Object.keys(dimensionGroups)]) as SourceDimensions;
}
export function normalizeSource(source: ResearchSource, taxonomy?: TopicTaxonomyConfig): ResearchSource {
  requireSourceKind(source.kind);
  if (!/^[0-9a-f]{32}$/.test(source.sourceId) || source.sourceId !== sha256(sourceText(source.identityKey)).slice(0, 32)) throw new TypeError('source identity mismatch');
  const primaryTrack = sourceText(source.primaryTrack);
  const secondaryTracks = texts(source.secondaryTracks).filter(t => t !== primaryTrack);
  if (taxonomy && [primaryTrack, ...secondaryTracks].some(t => !taxonomy.tracks.includes(t))) throw new TypeError('Track is outside taxonomy');
  return canonical({ ...source, canonicalUrl: source.kind === 'local-artifact' && source.canonicalUrl === '' ? '' : normalizeSourceUrl(source.canonicalUrl), title: sourceText(source.title),
    publisher: source.publisher === null ? null : sourceText(source.publisher), authors: texts(source.authors),
    primaryTrack, secondaryTracks, dimensions: dimensions(source.dimensions, taxonomy) });
}
export function normalizeVersion(version: SourceVersion): SourceVersion {
  requireVersionId(version.versionId); requireSourceHash(version.contentSha256);
  if (!/^[0-9a-f]{32}$/.test(version.sourceId)) throw new TypeError('invalid source ID');
  if (typeof version.archivePath !== 'string') throw new TypeError('invalid archive path');
  if (version.archivePath) archivePath(version.archivePath);
  const provenance: SourceProvenance = { ...version.provenance, adapter: sourceText(version.provenance.adapter), urls: [...new Set(version.provenance.urls.map(normalizeSourceUrl))].sort() };
  if (provenance.notes) provenance.notes = texts(provenance.notes);
  if (provenance.revision !== undefined) provenance.revision = sourceText(provenance.revision);
  if (provenance.parentSourceId !== undefined && !/^[0-9a-f]{32}$/.test(provenance.parentSourceId)) throw new TypeError('invalid provenance source ID');
  return canonical({ ...version, versionLabel: sourceText(version.versionLabel), publishedAt: version.publishedAt === null ? null : sourceDate(version.publishedAt), updatedAt: version.updatedAt === null ? null : sourceDate(version.updatedAt), releasedAt: version.releasedAt === null ? null : sourceDate(version.releasedAt), retrievedAt: sourceDate(version.retrievedAt), provenance });
}
export function normalizeSourceVersion(source: ResearchSource, version: SourceVersion) {
  const normalizedSource = normalizeSource(source), normalizedVersion = normalizeVersion(version);
  const arxivId = source.identityKey.startsWith('arxiv:') ? source.identityKey.slice(6) + version.versionId : undefined;
  const identity = sourceIdentity({ kind: source.kind, canonicalUrl: source.canonicalUrl, contentSha256: version.contentSha256,
    revision: version.versionId.startsWith('content-') ? undefined : version.versionId,
    arxivId, ...(source.kind === 'repository' || source.kind === 'release' ? { tag: version.versionId } : {}) });
  if (identity.sourceId !== source.sourceId || identity.identityKey !== source.identityKey || identity.canonicalUrl !== normalizedSource.canonicalUrl || identity.versionId !== version.versionId || version.sourceId !== source.sourceId) throw new TypeError('source/version identity mismatch');
  return { source: normalizedSource, version: normalizedVersion };
}
export function normalizeResearchCandidate(input: ResearchCandidate, taxonomy?: TopicTaxonomyConfig): ResearchCandidate {
  normalizeSourceVersion(input.source, input.version);
  if (input.dateMatches.some(v => !['published', 'updated', 'released', 'retrieved'].includes(v))) throw new TypeError('invalid date match');
  return canonical({ source: normalizeSource(input.source, taxonomy), version: normalizeVersion(input.version),
    matchedTracks: texts(input.matchedTracks), dateMatches: texts(input.dateMatches), discoveryAdapter: sourceText(input.discoveryAdapter) });
}
