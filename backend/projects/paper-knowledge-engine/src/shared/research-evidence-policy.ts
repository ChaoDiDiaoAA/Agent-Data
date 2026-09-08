import type { ResearchSource, SourceVersion } from '../types/research-sources.ts';
import { requireSourceKind, requireVersionId } from '../research/source-identity.ts';
import { normalizeArchivePath } from './manifest.ts';

/** Fixed generic Evidence projection. It is deliberately separate from the FSD paper layout. */
export const SOURCE_EVIDENCE_LAYOUT_V1 = Object.freeze({
  schemaVersion: 1,
  root: 'Evidence',
  sourcesRoot: 'Evidence/sources',
  indexRoots: Object.freeze({
    topics: 'Evidence/indexes/topics.md',
    sourceTypes: 'Evidence/indexes/source-types.md',
    lifecycles: 'Evidence/indexes/lifecycles.md',
    concepts: 'Evidence/indexes/concepts.md',
  }),
} as const);

const safeId = /^[0-9a-f]{32}$/;

/** Return the only permitted Evidence directory for one source version. */
export function evidenceSourceRoot(source: ResearchSource, version: SourceVersion): string {
  const kind = requireSourceKind(source.kind);
  if (!safeId.test(source.sourceId) || version.sourceId !== source.sourceId) throw new TypeError('unsafe research Evidence source identity');
  const versionId = requireVersionId(version.versionId);
  return `${SOURCE_EVIDENCE_LAYOUT_V1.sourcesRoot}/${kind}/${source.sourceId}/${versionId}`;
}

export function researchEvidencePath(value: string): string {
  const normalized = normalizeArchivePath(value);
  const allowed = normalized === SOURCE_EVIDENCE_LAYOUT_V1.root
    || normalized === SOURCE_EVIDENCE_LAYOUT_V1.sourcesRoot
    || normalized.startsWith(`${SOURCE_EVIDENCE_LAYOUT_V1.sourcesRoot}/`)
    || normalized === 'Evidence/indexes'
    || Object.values(SOURCE_EVIDENCE_LAYOUT_V1.indexRoots).includes(normalized as never);
  if (!allowed) throw new TypeError('path is outside research Evidence layout');
  return normalized;
}

export const SOURCE_EVIDENCE_INDEX_PATHS = Object.freeze(Object.values(SOURCE_EVIDENCE_LAYOUT_V1.indexRoots));
