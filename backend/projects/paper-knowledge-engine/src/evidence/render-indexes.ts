import { createHash } from 'node:crypto';
import type { VerifiedArchiveSource } from './archive-reader.ts';
import { canonicalJson } from '../shared/manifest.ts';
import type { RenderedFile } from './render-paper.ts';
import { EVIDENCE_LAYOUT_V3, evidencePaperRoot } from './layout-paths.ts';
import { LEGACY_EVIDENCE_ROOT } from '../shared/historical-compatibility.ts';

const encoder = new TextEncoder();
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const normalizeLf = (value: string) => value.replace(/\r\n?/g, '\n');
const SAFE_BASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// arXiv uses both namespaced categories (for example cs.AI) and
// standalone categories (for example quant-ph or hep-th).  The value still
// has to be one safe path segment; it is not restricted to this library's
// configured search categories.
const SAFE_CATEGORY = /^[a-z][a-z0-9-]*(?:\.[A-Za-z0-9-]+)?$/;
const SAFE_TRACK = /^[A-Za-z][A-Za-z0-9-]*$/;
const SAFE_YEAR = /^(?:1[0-9]{3}|2[0-9]{3})$/;

type IndexDimension = 'authors' | 'categories' | 'tracks' | 'years';
type Paper = VerifiedArchiveSource['source'];
type Relationship = { dimension: IndexDimension; id: string; label: string };

// Read-only legacy templates authenticate historical projections.
export const VAULT_INDEX_TEMPLATE = `# FSD Evidence Vault\n\n- [[${LEGACY_EVIDENCE_ROOT}/index]]\n`;
export const VAULT_README_TEMPLATE = `# FSD Evidence Vault\n\nThis vault contains deterministic, source-derived paper evidence under \`${LEGACY_EVIDENCE_ROOT}\`.\n`;

function textFile(path: string, value: string): RenderedFile {
  const bytes = encoder.encode(normalizeLf(value));
  return { path, bytes, sha256: sha256(bytes) };
}

function normalizeAuthorName(displayName: string): string {
  const normalized = displayName.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized) throw new TypeError('author display name must contain text');
  return normalized;
}

/** Stable path identity for a source-provided author display name. */
export function authorPageId(displayName: string): string {
  const normalized = normalizeAuthorName(displayName);
  const hashInput = normalized.toLowerCase();
  const slug = hashInput.normalize('NFKD').replace(/\p{Mark}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'author';
  const suffix = createHash('sha256').update(hashInput, 'utf8').digest('hex').slice(0, 8);
  return `${slug}--${suffix}`;
}

/** Validate a source category before it can influence a rendered filesystem path. */
export function categoryPageId(category: string): string {
  if (!SAFE_CATEGORY.test(category)) throw new TypeError(`unsafe category index value: ${category}`);
  return category;
}

/** Validate an FSD track before it can influence a rendered filesystem path. */
export function trackPageId(track: string): string {
  if (!SAFE_TRACK.test(track)) throw new TypeError(`unsafe track index value: ${track}`);
  return track;
}

/** Derive and validate the paper publication year before it can influence a rendered filesystem path. */
export function yearPageId(published: string): string {
  const year = published.slice(0, 4);
  if (!SAFE_YEAR.test(year) || !/^\d{4}-\d{2}-\d{2}T/.test(published)) throw new TypeError(`unsafe year index value: ${published}`);
  return year;
}

function sourceIdentity(source: Paper): string {
  if (!SAFE_BASE_ID.test(source.baseId) || !Number.isSafeInteger(source.version) || source.version < 1) {
    throw new TypeError('verified source identity is not safe for an evidence path');
  }
  return `${source.baseId}\u0000${source.version}`;
}

function paperLink(source: Paper): string {
  return `[[${LEGACY_EVIDENCE_ROOT}/sources/papers/${source.baseId}/v${source.version}/index|${linkLabel(source.title)}]]`;
}

function linkLabel(value: string): string {
  return value.replace(/[\[\]|]/g, '\\$&');
}

function sourceRelationships(source: Paper): Relationship[] {
  const values: Relationship[] = [];
  if ('authors' in source) {
    const year = yearPageId(source.published);
    values.push({ dimension: 'years', id: year, label: year });
    for (const author of source.authors) values.push({ dimension: 'authors', id: authorPageId(author), label: normalizeAuthorName(author) });
    for (const category of source.categories) values.push({ dimension: 'categories', id: categoryPageId(category), label: category });
    for (const track of source.matchedTracks) values.push({ dimension: 'tracks', id: trackPageId(track), label: track });
  }
  return values.sort((left, right) => compareText(left.dimension, right.dimension) || compareText(left.id, right.id));
}

function uniqueSources(sources: readonly VerifiedArchiveSource[]): VerifiedArchiveSource[] {
  const byIdentity = new Map<string, VerifiedArchiveSource>();
  for (const source of sources) {
    const identity = sourceIdentity(source.source);
    const existing = byIdentity.get(identity);
    if (existing && canonicalJson(existing.source) !== canonicalJson(source.source)) {
      throw new TypeError(`conflicting verified sources for ${source.source.baseId}v${source.source.version}`);
    }
    byIdentity.set(identity, source);
  }
  return [...byIdentity.values()].sort((left, right) => compareText(left.source.baseId, right.source.baseId) || left.source.version - right.source.version);
}

function indexPath(dimension: IndexDimension, id: string): string {
  return `indexes/${dimension}/${id}.md`;
}

function indexLink(dimension: IndexDimension, id: string, label: string): string {
  return `[[${LEGACY_EVIDENCE_ROOT}/indexes/${dimension}/${id}|${linkLabel(label)}]]`;
}

function renderRelationshipPage(relationship: Relationship, papers: readonly Paper[]): string {
  const type = relationship.dimension.slice(0, -1);
  return [
    '---',
    `type: "evidence-${type}-index"`,
    `${type}: ${JSON.stringify(relationship.label)}`,
    '---',
    '',
    `# ${relationship.label}`,
    '',
    '## Papers',
    '',
    ...papers.map(source => `- ${paperLink(source)}`),
    '',
  ].join('\n');
}

function renderEvidenceHome(groups: ReadonlyMap<string, { relationship: Relationship; papers: Paper[] }>): string {
  const dimensions: IndexDimension[] = ['authors', 'categories', 'tracks', 'years'];
  const lines = ['# Evidence', ''];
  for (const dimension of dimensions) {
    lines.push(`## ${dimension[0].toUpperCase()}${dimension.slice(1)}`, '');
    const entries = [...groups.values()].filter(group => group.relationship.dimension === dimension)
      .sort((left, right) => compareText(left.relationship.id, right.relationship.id));
    lines.push(...(entries.length === 0 ? ['- None'] : entries.map(group => `- ${indexLink(dimension, group.relationship.id, group.relationship.label)}`)), '');
  }
  return lines.join('\n');
}

/** Render deterministic relationship indexes from verified source metadata only. */
export function renderEvidenceIndexes(sources: readonly VerifiedArchiveSource[]): RenderedFile[] {
  const groups = new Map<string, { relationship: Relationship; papers: Paper[] }>();
  for (const verified of uniqueSources(sources)) {
    for (const relationship of sourceRelationships(verified.source)) {
      const key = `${relationship.dimension}\u0000${relationship.id}`;
      const group = groups.get(key) ?? { relationship, papers: [] };
      if (!groups.has(key)) groups.set(key, group);
      if (!group.papers.some(candidate => candidate.baseId === verified.source.baseId && candidate.version === verified.source.version)) {
        group.papers.push(verified.source);
      }
    }
  }

  const files: RenderedFile[] = [];
  for (const group of groups.values()) {
    group.papers.sort((left, right) => compareText(left.baseId, right.baseId) || left.version - right.version);
    files.push(textFile(indexPath(group.relationship.dimension, group.relationship.id), renderRelationshipPage(group.relationship, group.papers)));
  }
  files.push(
    textFile(`${LEGACY_EVIDENCE_ROOT}/index.md`, renderEvidenceHome(groups)),
    textFile('index.md', VAULT_INDEX_TEMPLATE),
    textFile('README.md', VAULT_README_TEMPLATE),
  );
  return files.sort((left, right) => compareText(left.path, right.path));
}

/** Exactly four aggregate files; source-provided labels never create filesystem paths. */
export function renderEvidenceIndexesV3(sources: readonly VerifiedArchiveSource[]): RenderedFile[] {
  const groups = new Map<string, { relationship: Relationship; papers: Paper[] }>();
  for (const verified of uniqueSources(sources)) {
    const source = verified.source;
    const relationships: Relationship[] = [];
    if ('authors' in source) for (const author of source.authors) relationships.push({ dimension: 'authors', id: authorPageId(author), label: normalizeAuthorName(author) });
    if ('categories' in source) for (const category of source.categories) relationships.push({ dimension: 'categories', id: categoryPageId(category), label: category });
    if ('matchedTracks' in source) for (const track of source.matchedTracks) relationships.push({ dimension: 'tracks', id: trackPageId(track), label: track });
    if ('published' in source) { const year = yearPageId(source.published); relationships.push({ dimension: 'years', id: year, label: year }); }
    for (const relationship of relationships) {
      const key = `${relationship.dimension}\u0000${relationship.id}`;
      const group = groups.get(key) ?? { relationship, papers: [] };
      // Equivalent names may differ only in display casing; choose a stable label.
      if (compareText(relationship.label, group.relationship.label) < 0) group.relationship = relationship;
      if (!group.papers.some(paper => paper.baseId === source.baseId && paper.version === source.version)) group.papers.push(source);
      groups.set(key, group);
    }
  }
  return (Object.keys(EVIDENCE_LAYOUT_V3.indexes) as IndexDimension[]).map(dimension => {
    const entries = [...groups.values()].filter(group => group.relationship.dimension === dimension)
      .sort((a, b) => compareText(a.relationship.id, b.relationship.id));
    const lines = [`# ${dimension[0]!.toUpperCase()}${dimension.slice(1)}`, ''];
    if (!entries.length) lines.push('- None', '');
    for (const group of entries) {
      lines.push(`## ${group.relationship.label}`, '');
      for (const paper of group.papers.sort((a, b) => compareText(a.baseId, b.baseId) || a.version - b.version)) {
        lines.push(`- [[${evidencePaperRoot(paper.baseId, paper.version)}/paper|${linkLabel(paper.title)}]]`);
      }
      lines.push('');
    }
    return textFile(EVIDENCE_LAYOUT_V3.indexes[dimension], lines.join('\n'));
  });
}
