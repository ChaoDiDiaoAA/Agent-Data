import type { LibraryId } from './identity.ts';
import { readFile, lstat, realpath, readdir } from 'node:fs/promises';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { assertLibraryId } from './identity.ts';
import { canonicalJson, normalizeArchivePath } from './manifest.ts';
import { discoverArchiveAssetPaths, isLikelyPythonAttributeNotation, isMinerUTruncationPlaceholder, isMinerUTemplateAssetPlaceholder, mapMarkdownOutsideCode, normalizedArchiveAssetDestination, normalizedArchiveAssetPath, rewriteArchiveAssetReferences } from './archive-references.ts';
import { PDFDocument } from 'pdf-lib';

export function archivePath(path: string): string {
  normalizeArchivePath(path);
  if (path.split('/').some(s => /[<>:"|?*]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) {
    throw new Error('unsafe Archive path');
  }
  return path;
}
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('invalid Archive schema fields');
  return value as Record<string, any>;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid Archive text');
}
function integer(value: unknown, minimum = 1): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error('invalid Archive integer');
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const payloadAllowed = (path: string) => ['source.json', 'source.pdf', 'document.md', 'pages.json', 'content-list.json'].includes(path) ||
  (path.startsWith('assets/') && !/(?:^|\/)(?:origin\.pdf|layout\.pdf|span\.pdf|middle\.json|model\.json|page-marked\.txt)$/i.test(path));

/** Check every component before following it, including Windows junctions. */
export async function assertRealPath(path: string): Promise<void> {
  const absolute = resolve(path);
  const chain: string[] = [];
  for (let p = absolute;; p = dirname(p)) { chain.unshift(p); if (dirname(p) === p) break; }
  for (const p of chain) {
    if ((await lstat(p)).isSymbolicLink()) throw new Error('Archive refuses links or reparse points');
  }
  if (relative(absolute, await realpath(absolute))) throw new Error('Archive real path differs');
}

export async function pathIdentity(path: string): Promise<string> {
  await assertRealPath(path);
  const parts: string[] = [];
  for (let p = resolve(path);; p = dirname(p)) {
    const info = await lstat(p, { bigint: true });
    parts.push(`${p}:${info.dev}:${info.ino}:${info.birthtimeNs}`);
    if (dirname(p) === p) break;
  }
  return parts.join('|');
}

export async function realTree(root: string): Promise<string[]> {
  await assertRealPath(root);
  const paths: string[] = [];
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Archive refuses links or reparse points');
      const path = archivePath(relative(root, absolute).split(sep).join('/'));
      if (entry.isDirectory()) { paths.push(path + '/'); await visit(absolute); }
      else if (entry.isFile()) paths.push(path);
      else throw new Error('Archive refuses non-file entries');
    }
  }
  await visit(root);
  return paths.sort();
}

export function validateArchiveSourceV2(value: unknown): ArchiveSourceV2 {
  const m = object(value, ['schemaVersion', 'libraryId', 'sourceKind', 'baseId', 'version', 'pdfSha256', 'parser', 'artifacts', 'files']);
  if (m.schemaVersion !== 2 || !['arxiv', 'local_pdf'].includes(m.sourceKind)) throw new Error('invalid Archive version/kind');
  assertLibraryId(m.libraryId);
  text(m.baseId); archivePath(m.baseId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.baseId)) throw new Error('invalid Archive baseId');
  integer(m.version);
  if (!/^[0-9a-f]{64}$/.test(m.pdfSha256)) throw new Error('invalid PDF hash');
  const parser = object(m.parser, ['name', 'version', 'model', 'method']); text(parser.version);
  if (parser.name !== 'MinerU' || !['pipeline', 'vlm'].includes(parser.model) || !['auto', 'txt', 'ocr'].includes(parser.method)) throw new Error('invalid parser schema');
  if (canonicalJson(m.artifacts) !== canonicalJson(ARCHIVE_ARTIFACTS)) throw new Error('invalid artifacts schema');
  if (!Array.isArray(m.files)) throw new Error('invalid manifest files');
  const paths = new Set<string>();
  for (const raw of m.files) {
    const entry = object(raw, ['path', 'sha256', 'bytes']);
    text(entry.path); archivePath(entry.path); integer(entry.bytes, 0);
    if (!payloadAllowed(entry.path) || paths.has(entry.path.toLowerCase()) || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('invalid manifest file');
    paths.add(entry.path.toLowerCase());
  }
  for (const path of ['source.json', 'source.pdf', 'document.md', 'pages.json', 'content-list.json']) {
    if (!m.files.some((entry: { path: string }) => entry.path === path)) throw new Error('missing required manifest file');
  }
  return m as unknown as ArchiveSourceV2;
}

export interface ArchiveSourceV2 {
  schemaVersion: 2;
  libraryId: LibraryId;
  sourceKind: 'arxiv' | 'local_pdf';
  baseId: string;
  version: number;
  pdfSha256: string;
  parser: { name: 'MinerU'; version: string; model: 'pipeline' | 'vlm'; method: 'auto' | 'txt' | 'ocr' };
  artifacts: { pdf: 'source.pdf'; document: 'document.md'; pages: 'pages.json'; contentList: 'content-list.json'; assetsRoot: 'assets' };
  files: { path: string; sha256: string; bytes: number }[];
}

export interface FrozenSourceMetadata {
  title: string;
  authors: string[];
  categories: string[];
  matchedTracks: string[];
  arxivId?: string;
  published?: string;
  updated?: string;
  parserConfigKey?: string;
  parseAttemptId: string;
  pageCount: number;
}

export const ARCHIVE_ARTIFACTS = { pdf: 'source.pdf', document: 'document.md', pages: 'pages.json',
  contentList: 'content-list.json', assetsRoot: 'assets' } as const;
export interface ArchiveCleanupPending {
  reason: 'workspace_cleanup_failed';
  /** Retained path is diagnostic information, not authorization to delete it. */
  path: string;
}
export interface VerifiedArchiveV2 {
  cleanupPending?: ArchiveCleanupPending;
  root: string;
  manifest: ArchiveSourceV2;
  source: FrozenSourceMetadata;
  payloads: ReadonlyMap<string, Uint8Array>;
  fullMarkdown: string;
  pages: { page: number; text: string }[];
  contentList: unknown[];
}

export function validateFrozenSource(value: unknown, kind: ArchiveSourceV2['sourceKind']): FrozenSourceMetadata {
  const shared = ['title', 'authors', 'categories', 'matchedTracks', 'parseAttemptId', 'pageCount'];
  const s = object(value, [...shared, ...(kind === 'arxiv' ? ['arxivId', 'published', 'updated'] : ['parserConfigKey'])]);
  text(s.title); text(s.parseAttemptId); integer(s.pageCount);
  for (const key of ['authors', 'categories', 'matchedTracks']) {
    if (!Array.isArray(s[key])) throw new Error('invalid metadata array');
    for (const item of s[key]) text(item);
    if (new Set(s[key]).size !== s[key].length) throw new Error('duplicate metadata');
  }
  if (kind === 'arxiv') { text(s.arxivId); text(s.published); text(s.updated); if (!s.authors.length) throw new Error('missing authors'); }
  else text(s.parserConfigKey);
  return s as FrozenSourceMetadata;
}

/** Parse attributes on every HTML-like tag, not just img/source. Reject
 * ambiguous resource syntax rather than letting a browser interpret a
 * different local target. Non-resource prose that merely resembles a tag is
 * left untouched so mathematical comparisons cannot abort parsing. */
function mapHtmlResources(html: string, visit: (value: string) => string, markdownDestinations: { start: number; end: number }[] = []): string {
  const tags = /<[A-Za-z][\w:-]*(?=[\s/>])/g;
  let output = '', copied = 0, tag: RegExpExecArray | null;
  while ((tag = tags.exec(html))) {
    const tagStart = tag.index;
    if (markdownDestinations.some(range => tag!.index >= range.start && tag!.index < range.end)) continue;
    let cursor = tags.lastIndex;
    const seen = new Set<string>();
    let resourceSeen = false;
    let ignoreCandidate = false;
    while (true) {
      const whitespace = /^\s*/.exec(html.slice(cursor))![0]; cursor += whitespace.length;
      if (html[cursor] === '>') { cursor++; break; }
      if (html.slice(cursor, cursor + 2) === '/>') { cursor += 2; break; }
      // A prose comparison such as "i<len must hold" matches the opening
      // shape above, but it is not an HTML tag.  Only fail closed when a
      // real resource attribute has already been entered; otherwise leave
      // the text untouched and let the next genuine tag be scanned.
      if (!whitespace) {
        if (resourceSeen) throw new Error('unparseable HTML attributes');
        ignoreCandidate = true;
        break;
      }
      const attribute = /^[^\s\x00-\x1f\x7f"'<>/=\x60]+/.exec(html.slice(cursor));
      if (!attribute) {
        if (resourceSeen) throw new Error('unparseable HTML attribute');
        ignoreCandidate = true;
        break;
      }
      const name = attribute[0].toLowerCase(); cursor += attribute[0].length;
      const resource = ['src', 'href', 'srcset'].includes(name);
      if (resource && seen.has(name)) throw new Error('duplicate HTML resource attribute');
      seen.add(name);
      const afterName = cursor;
      cursor += /^\s*/.exec(html.slice(cursor))![0].length;
      if (html[cursor] !== '=') {
        if (resource) throw new Error('HTML resource attribute has no value');
        cursor = afterName; continue;
      }
      if (resource) resourceSeen = true;
      cursor++; cursor += /^\s*/.exec(html.slice(cursor))![0].length;
      const start = cursor, quote = html[cursor];
      let value: string;
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, cursor + 1);
        if (end < 0) throw new Error('unterminated HTML attribute');
        value = html.slice(cursor + 1, end); cursor = end + 1;
      } else {
        const token = /^[^\s"'=<>\x60]+/.exec(html.slice(cursor));
        if (!token) {
          if (resourceSeen) throw new Error('unparseable HTML attribute value');
          ignoreCandidate = true;
          break;
        }
        value = token[0]; cursor += value.length;
      }
      if (resource) {
        // Entity-encoded URLs are not part of the accepted local URL grammar.
        // Reject instead of treating an encoded traversal as a literal filename.
        if (!value.trim() || /[&<>\x00-\x1f\x7f]/.test(value)) throw new Error('ambiguous HTML resource value');
        const rewritten = name === 'srcset' ? mapSrcset(value, visit) : visit(value.trim());
        output += html.slice(copied, start) + `"${rewritten.replaceAll('"', '&quot;')}"`;
        copied = cursor;
      }
    }
    if (ignoreCandidate) {
      tags.lastIndex = tagStart + 1;
      continue;
    }
    tags.lastIndex = cursor;
  }
  return output + html.slice(copied);
}

function mapSrcset(value: string, visit: (value: string) => string): string {
  return value.split(',').map(candidate => {
    const [destination, ...descriptor] = candidate.trim().split(/\s+/);
    if (!destination) throw new Error('empty HTML srcset destination');
    return [visit(destination), ...descriptor].join(' ');
  }).join(', ');
}

function isResourceField(key?: string): boolean {
  return key !== undefined && /^(?:src|href|srcset|.*(?:img|image|asset).*path)$/i.test(key);
}

function referencePath(value: string): string | null {
  if (!value || value.startsWith('#') || /^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return null;
  const destination = decodeURIComponent(value.split(/[?#]/)[0]);
  if (isMinerUTruncationPlaceholder(destination) || isMinerUTemplateAssetPlaceholder(destination)) return null;
  return archivePath(destination);
}

/** Shared complete-link grammar: citation-followed-by-prose is not a partial destination. */
export const MARKDOWN_INLINE_LINK_PATTERN = /(\]\(\s*)(?:<([^>]+)>|([^\s)]+))((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\))/g;

// MinerU sometimes emits atom-mapped or chiral SMILES in ordinary text.  The
// `](` sequence in `[C:4](=[O:23])` is syntactically close to a Markdown link,
// but its destination is a chemical bond/atom rather than an Archive path.
const SMILES_ATOM_LABEL_PATTERN = /^(?:\d{1,3})?(?:[A-Z][a-z]?|[bcnops])(?:@@?|@)?H?\d*(?:[+-]\d*)?(?::\d+)?$/;
function isSmilesAtomLabel(value: string): boolean {
  return SMILES_ATOM_LABEL_PATTERN.test(value);
}
function isSmilesAtomDestination(value: string): boolean {
  const destination = value.trim();
  // MinerU/OCR can render the oxygen atom `O` as the digit `0` in a mapped
  // SMILES bond such as `[N+:17](=0)`. Accept that token only in the
  // chemical-notation recognizer; ordinary resource paths remain strict.
  if (destination === '0') return true;
  if (isSmilesAtomLabel(destination)) return true;
  return /^\[[^\]\r\n]+\]$/.test(destination) && isSmilesAtomLabel(destination.slice(1, -1));
}
function isSmilesBondDestination(value: string): boolean {
  const match = /^([=#\\-])(.+)$/.exec(value.trim());
  return match !== null && isSmilesAtomDestination(match[2]!);
}

/** Return true for a Markdown-looking sequence that is actually SMILES text. */
export function isLikelyChemicalNotation(text: string, matchIndex: number, destination: string): boolean {
  const open = text.lastIndexOf('[', matchIndex);
  const value = destination.trim();
  // Structured MinerU text can split one mapped atom across adjacent records,
  // leaving a continuation such as `:4](=[O:23])` with no opening bracket.
  // Only suppress that split form when both sides still look chemical.
  if (open < 0) {
    const token = text.slice(0, matchIndex).trim().split(/\s+/).pop()?.replace(/^\[/, '') ?? '';
    return isSmilesBondDestination(value) && (isSmilesAtomLabel(token) || /^:?\d+$/.test(token));
  }
  const label = text.slice(open + 1, matchIndex);
  const normalizedLabel = label.replace(/\s+/g, '');
  if (label.includes(']') || !isSmilesAtomLabel(normalizedLabel)) return false;
  if (isSmilesBondDestination(value)) return true;
  if (!isSmilesAtomDestination(value)) return false;
  // Atom maps, isotope/hydrogen counts, and chirality are strong chemistry
  // signals.  For a bare atom label, require an adjacent SMILES atom/bond so
  // a legitimate Markdown link such as `[C](assets/file.pdf)` stays intact.
  if (/[:@H\d]/.test(normalizedLabel)) return true;
  const previous = text[open - 1] ?? '';
  const destinationStart = text.indexOf(value, matchIndex + 1);
  const close = destinationStart < 0 ? -1 : text.indexOf(')', destinationStart + value.length);
  const after = close < 0 ? '' : text[close + 1] ?? '';
  return /[A-Za-z0-9)\]=#-]/.test(previous) || /[A-Za-z0-9[\]=#-]/.test(after);
}

/** Return true for bracketed mathematical expressions followed by a numeric
 * parenthesis, such as `[40 -5c_x/7](0)`.  MinerU emits this syntax for
 * ordinary prose/math, but the Markdown link scanner would otherwise resolve
 * the number as a file in the output directory. */
function isLikelyMathematicalNotation(text: string, matchIndex: number, destination: string): boolean {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(destination.trim())) return false;
  const open = text.lastIndexOf('[', matchIndex);
  if (open < 0) return false;
  const label = text.slice(open + 1, matchIndex);
  return /[\\_=+\-*/^]|(?:\d\s*[A-Za-z])|(?:[A-Za-z]\s*\d)/.test(label);
}

// MinerU can preserve NER examples in code blocks as prose such as
// `[ Cupertino ]( LOC)` or `[ ENTITY ]( TYPE)`.  These resemble Markdown
// links, but the destination is an entity label rather than an Archive path.
// Keep this list explicit and require the padded label form emitted by the
// parser so a real local link such as `[Logo](assets/logo.svg)` remains strict.
const ENTITY_ANNOTATION_LABELS = new Set([
  'CARDINAL', 'DATE', 'EVENT', 'FAC', 'GPE', 'LANGUAGE', 'LAW', 'LOC', 'MONEY',
  'NORP', 'ORDINAL', 'ORG', 'PERCENT', 'PER', 'PERSON', 'PRODUCT', 'QUANTITY',
  'TIME', 'TYPE', 'WORK_OF_ART', 'MISC',
]);

function isLikelyEntityAnnotation(text: string, matchIndex: number, destination: string): boolean {
  const open = text.lastIndexOf('[', matchIndex);
  if (open < 0 || !ENTITY_ANNOTATION_LABELS.has(destination.trim().toUpperCase())) return false;
  const label = text.slice(open + 1, matchIndex);
  const trimmed = label.trim();
  return trimmed.length > 0 && (trimmed !== label || /\s/.test(trimmed));
}

// Papers also explain repository conventions with placeholder links such as
// `[X](refs/x.md)`.  MinerU preserves that sentence as ordinary prose, while
// the target is illustrative and is not part of the parser output tree.  Keep
// the exception limited to a one-letter reference placeholder so real links
// such as `[Guide](refs/guide.md)` remain required resources.
function isLikelyReferencePlaceholder(text: string, matchIndex: number, destination: string): boolean {
  const open = text.lastIndexOf('[', matchIndex);
  if (open < 0 || !/^refs\/[a-z]\.md$/i.test(destination.trim().split(/[?#]/, 1)[0] ?? '')) return false;
  return /^[A-Za-z]$/.test(text.slice(open + 1, matchIndex).trim());
}

// Tool schemas often render parameter metadata as `[{type}](required/optional)`.
// It is explanatory notation, not a file under the MinerU output directory.
// Require the brace-delimited field label and exact status pair so a real
// resource named `required/optional` remains subject to normal validation.
function isLikelyParameterStatusNotation(text: string, matchIndex: number, destination: string): boolean {
  const open = text.lastIndexOf('[', matchIndex);
  if (open < 0 || !/^required\/optional$/i.test(destination.trim())) return false;
  return /^\{[^{}\r\n]+\}$/.test(text.slice(open + 1, matchIndex).trim());
}

function isLikelyNonResourceNotation(text: string, matchIndex: number, destination: string): boolean {
  return isLikelyChemicalNotation(text, matchIndex, destination)
    || isLikelyMathematicalNotation(text, matchIndex, destination)
    || isLikelyEntityAnnotation(text, matchIndex, destination)
    || isLikelyReferencePlaceholder(text, matchIndex, destination)
    || isLikelyParameterStatusNotation(text, matchIndex, destination)
    || isLikelyPythonAttributeNotation(text, matchIndex, destination);
}

function normalizeMarkdownReferenceLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function mapTextResources(text: string, visit: (value: string) => string): string {
  return mapMarkdownOutsideCode(text, segment => mapTextResourcesSegment(segment, visit));
}

function mapTextResourcesSegment(text: string, visit: (value: string) => string): string {
  const inlinePattern = MARKDOWN_INLINE_LINK_PATTERN;
  const definitionPattern = /^([ \t]*\[([^\]\r\n]+)\]:\s*)(?:<([^>\r\n]+)>|([^\s\r\n]+))/gm;
  const definitions = [...text.matchAll(definitionPattern)].map(match => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    label: normalizeMarkdownReferenceLabel(match[2]!),
  }));
  // A definition is only a resource when a reference-style link actually
  // uses it.  Papers commonly contain prose such as "[m]: Usefulness.";
  // treating every colon after brackets as a link definition turns the final
  // sentence punctuation into an unsafe Windows path.
  let referenceScan = text;
  for (const definition of definitions) {
    referenceScan = referenceScan.slice(0, definition.start)
      + ' '.repeat(definition.end - definition.start)
      + referenceScan.slice(definition.end);
  }
  const usedLabels = new Set<string>();
  // Shortcut references such as [variable-name] are intentionally excluded:
  // papers and prompt examples use that notation as ordinary placeholders.
  // The explicit second bracket in [text][label] is unambiguous.
  for (const match of referenceScan.matchAll(/!?\[([^\]\r\n]*)\]\[([^\]\r\n]*)\]/g)) {
    const label = normalizeMarkdownReferenceLabel(match[2] || match[1]!);
    if (label) usedLabels.add(label);
  }
  const activeLabels = new Set(definitions.filter(definition => usedLabels.has(definition.label)).map(definition => definition.label));
  const destinations: { start: number; end: number }[] = [];
  for (const pattern of [inlinePattern, definitionPattern]) for (const match of text.matchAll(pattern)) {
    const isActiveDefinition = pattern === definitionPattern && !activeLabels.has(normalizeMarkdownReferenceLabel(match[2]!));
    const destination = match[2] ?? match[3];
    if (match[2] !== undefined && !isActiveDefinition && destination !== undefined
      && !isLikelyNonResourceNotation(text, match.index, destination)) {
      destinations.push({ start: match.index + match[1].length, end: match.index + match[0].length });
    }
  }
  const html = mapHtmlResources(text, visit, destinations);
  const inline = html.replace(inlinePattern,
    (all: string, prefix: string, bracketed: string | undefined, bare: string, suffix: string, offset: number) => {
      const destination = bracketed ?? bare;
      if (isLikelyNonResourceNotation(html, offset, destination)) return all;
      return prefix + (bracketed !== undefined ? `<${visit(bracketed)}>` : visit(bare)) + suffix;
    });
  return inline.replace(definitionPattern,
    (all: string, prefix: string, label: string, bracketed: string | undefined, bare: string) => {
      if (!activeLabels.has(normalizeMarkdownReferenceLabel(label))) return all;
      return prefix + (bracketed !== undefined ? `<${visit(bracketed)}>` : visit(bare));
    });
}

/** Local links must resolve to the package, including ordinary Markdown links. */
export function archiveReferences(markdown: string, content: unknown): string[] {
  const paths = new Set<string>();
  function add(value: string) {
    const path = referencePath(value);
    if (path) paths.add(path);
  }
  for (const path of discoverArchiveAssetPaths(markdown, content)) add(path);
  mapTextResources(markdown, value => { add(value); return value; });
  // Catch absolute drive paths that the legacy reference reader treats as URLs.
  const inspect = (v: unknown, key?: string): void => {
    const resource = isResourceField(key);
    if (typeof v === 'string') {
      if (key?.toLowerCase() === 'srcset') mapSrcset(v, value => { add(value); return value; });
      else if (resource) add(v);
      else mapTextResources(v, value => { add(value); return value; });
    }
    if (Array.isArray(v)) v.forEach(child => inspect(child, key));
    else if (v && typeof v === 'object') for (const [childKey, child] of Object.entries(v)) {
      inspect(child, resource ? key : childKey);
    }
  };
  inspect(content);
  return [...paths].sort();
}

/** Normalization and verification share destination parsing, including strings
 * nested in MinerU table bodies. Legacy structured asset fields keep support. */
export function rewriteArchiveReferences(markdown: string, content: unknown, paths: ReadonlyMap<string, string>) {
  const rewrite = (value: string): string => {
    const path = referencePath(value);
    const destination = path && normalizedArchiveAssetDestination(path, paths);
    return destination ? destination + (value.match(/[?#].*$/)?.[0] ?? '') : value;
  };
  const legacy = rewriteArchiveAssetReferences(markdown, content, paths);
  const structured = (value: unknown, key?: string): unknown => {
    const resource = isResourceField(key);
    if (typeof value === 'string') return key?.toLowerCase() === 'srcset' ? mapSrcset(value, rewrite)
      : resource ? rewrite(value) : mapTextResources(value, rewrite);
    if (Array.isArray(value)) return value.map(item => structured(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, structured(child, resource ? key : childKey)]));
    return value;
  };
  return { fullMarkdown: mapTextResources(legacy.fullMarkdown, rewrite), contentList: structured(legacy.contentList) };
}

export async function verifyArchiveV2(root: string): Promise<VerifiedArchiveV2> {
  const actual = await realTree(root);
  const manifestBytes = await readFile(join(root, 'manifest.json'), 'utf8');
  const manifest = validateArchiveSourceV2(JSON.parse(manifestBytes));
  if (manifestBytes !== canonicalJson(manifest)) throw new Error('manifest must be canonical JSON');
  const expected = new Set(['manifest.json', ...manifest.files.map(x => x.path)]);
  for (const path of actual) {
    if (path.endsWith('/')) {
      if (path !== 'assets/' && !path.startsWith('assets/')) throw new Error('unexpected Archive directory');
    } else if (!expected.has(path)) throw new Error('unexpected Archive payload');
  }
  if (actual.filter(x => !x.endsWith('/')).length !== expected.size) throw new Error('missing Archive payload');
  const payloads = new Map<string, Uint8Array>();
  const assetHashes = new Set<string>();
  for (const entry of manifest.files) {
    const bytes = await readFile(join(root, entry.path));
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) {
      throw new Error('Archive payload hash/bytes mismatch');
    }
    payloads.set(entry.path, bytes);
    if (entry.path.startsWith('assets/')) {
      if (assetHashes.has(entry.sha256)) throw new Error('duplicate asset payload');
      assetHashes.add(entry.sha256);
    }
  }
  const body = (path: string) => Buffer.from(payloads.get(path)!).toString('utf8');
  const source = validateFrozenSource(JSON.parse(body('source.json')), manifest.sourceKind);
  if (body('source.json') !== canonicalJson(source)) throw new Error('source metadata must be canonical');
  if (manifest.sourceKind === 'arxiv' && source.arxivId !== `${manifest.baseId}v${manifest.version}`) throw new Error('source identity mismatch');
  if (!body('source.pdf').startsWith('%PDF-') || hash(payloads.get('source.pdf')!) !== manifest.pdfSha256) throw new Error('invalid PDF identity');
  const pdf = await PDFDocument.load(payloads.get('source.pdf')!, { throwOnInvalidObject: true });
  if (pdf.getPageCount() !== source.pageCount) throw new Error('PDF page count mismatch');
  const fullMarkdown = body('document.md');
  if (!fullMarkdown.trim()) throw new Error('empty Markdown');
  const rawPages: unknown = JSON.parse(body('pages.json'));
  if (!Array.isArray(rawPages) || rawPages.length !== source.pageCount) throw new Error('invalid pages schema');
  const pages = rawPages.map((page, index) => {
    if (!page || typeof page !== 'object' || (page.pageNumber ?? page.page) !== index + 1 ||
      typeof page.text !== 'string' || Object.keys(page).some(k => !['pageNumber', 'page', 'text', 'blockCount'].includes(k)) ||
      ('page' in page && 'pageNumber' in page) || ('blockCount' in page && (!Number.isSafeInteger(page.blockCount) || page.blockCount < 0))) throw new Error('invalid page schema');
    return { page: index + 1, text: page.text as string };
  });
  const contentList: unknown = JSON.parse(body('content-list.json'));
  const blocks = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(blocks);
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    if (!['type', 'text', 'content'].some(key => key in record)) return false;
    if ('type' in record && (typeof record.type !== 'string' || !record.type)) return false;
    if ('text' in record && typeof record.text !== 'string') return false;
    if ('page_idx' in record && (!Number.isSafeInteger(record.page_idx) || Number(record.page_idx) < 0 || Number(record.page_idx) >= source.pageCount)) return false;
    return true;
  };
  if (!Array.isArray(contentList) || !contentList.length || !blocks(contentList)) throw new Error('invalid content-list schema');
  const refs = [...new Set([...archiveReferences(fullMarkdown, contentList), ...archiveReferences('', rawPages)])];
  const resolvedRefs = refs.map(path => normalizedArchiveAssetPath(path, payloads) ?? path);
  for (const path of resolvedRefs) if (!payloads.has(path)) throw new Error('missing referenced resource: ' + path);
  for (const path of payloads.keys()) if (path.startsWith('assets/') && !resolvedRefs.includes(path)) throw new Error('unreferenced Archive asset');
  return { root, manifest, source, payloads, fullMarkdown, pages, contentList };
}
