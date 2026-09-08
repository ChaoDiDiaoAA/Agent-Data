import { readFile, lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, parse, posix, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { archivePath, assertRealPath, realTree, verifyArchiveV2, MARKDOWN_INLINE_LINK_PATTERN, type VerifiedArchiveV2 } from '../shared/archive-v2.ts';
import { EVIDENCE_LAYOUT_V3 } from './layout-paths.ts';
import { renderEvidenceV3 } from './layout-v3.ts';
import { hashCanonical } from '../shared/manifest.ts';

export interface VaultValidationInput { vaultRoot: string; sources: readonly VerifiedArchiveV2[] }
export interface VaultValidationIssue { kind: string; path: string; target?: string; detail?: string }
export interface VaultValidationReport {
  valid: boolean;
  paperCount: number;
  expectedPaperCount: number;
  indexCount: number;
  brokenLinks: number;
  missingAssets: number;
  issues: VaultValidationIssue[];
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Share Windows-safe path spelling and case identity with the offline rebuilder. */
export function vaultAbsolutePath(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('absolute path required');
  archivePath(value.slice(parse(value).root.length).replaceAll('\\', '/'));
  return resolve(value);
}
export function assertUniqueVaultPaths(paths: readonly string[]): void {
  const folded = new Set<string>();
  for (const path of paths) {
    const key = path.replace(/\/$/, '').toLowerCase();
    if (folded.has(key)) throw new Error(`case-colliding path: ${path}`);
    folded.add(key);
  }
}

function markdownBlocks(markdown: string): string {
  const lines = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').split(/\r?\n/);
  let fence: { marker: string; length: number } | undefined;
  return lines.map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      return '';
    }
    if (marker && (marker[1]![0] !== '`' || !marker[2]!.includes('`'))) {
      fence = { marker: marker[1]![0]!, length: marker[1]!.length }; return '';
    }
    return line;
  }).join('\n');
}
function prose(markdown: string): string { return markdownBlocks(markdown).replace(/`+[^`\n]*`+/g, ''); }

interface HtmlTag { start: number; end: number; attributes: Map<string, string | null> }
const resourceAttributes = new Set(['src', 'href', 'srcset']);
/** Consume whole tags and whole attribute names. In HTML, backslashes do not escape quotes. */
function htmlTagAt(text: string, start: number): HtmlTag | undefined {
  if (text.startsWith('<!--', start)) {
    const end = text.indexOf('-->', start + 4);
    if (end < 0) throw new Error('unterminated HTML comment');
    return { start, end: end + 3, attributes: new Map() };
  }
  if (/^<https?:\/\//i.test(text.slice(start))) return; // Markdown autolink, not an HTML tag.
  const tag = /^<\/?[A-Za-z][\w:-]*(?=[\s/>])/.exec(text.slice(start));
  if (!tag) return;
  let cursor = start + tag[0].length;
  const attributes = new Map<string, string | null>();
  while (true) {
    const whitespace = /^\s*/.exec(text.slice(cursor))![0]; cursor += whitespace.length;
    if (text[cursor] === '>') { cursor++; break; }
    if (text.slice(cursor, cursor + 2) === '/>') { cursor += 2; break; }
    if (!whitespace) throw new Error('malformed HTML tag or attribute separator');
    const attribute = /^[^\s\x00-\x1f\x7f"'<>/=\x60]+/.exec(text.slice(cursor));
    if (!attribute) throw new Error('malformed HTML attribute');
    const name = attribute[0].toLowerCase(); cursor += attribute[0].length;
    if (resourceAttributes.has(name) && attributes.has(name)) throw new Error('duplicate HTML resource attribute');
    const afterName = cursor;
    cursor += /^\s*/.exec(text.slice(cursor))![0].length;
    if (text[cursor] !== '=') { attributes.set(name, null); cursor = afterName; continue; }
    cursor++; cursor += /^\s*/.exec(text.slice(cursor))![0].length;
    const quote = text[cursor];
    let value: string;
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, cursor + 1);
      if (end < 0) throw new Error('unterminated HTML attribute');
      value = text.slice(cursor + 1, end); cursor = end + 1;
    } else {
      const unquoted = /^[^\s"'=<>\x60]+/.exec(text.slice(cursor));
      if (!unquoted) throw new Error('malformed HTML attribute value');
      value = unquoted[0]; cursor += value.length;
    }
    attributes.set(name, value);
  }
  return { start, end: cursor, attributes };
}
function htmlTags(text: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  for (let start = text.indexOf('<'); start >= 0; start = text.indexOf('<', start + 1)) {
    const tag = htmlTagAt(text, start);
    if (tag) { tags.push(tag); start = tag.end - 1; }
  }
  return tags;
}

/** Lex original text in order: code owns its contents; HTML owns its quoted attributes.
 * Neither state's delimiters can be interpreted by the other after it has been entered.
 * Mask complete tags only in the Markdown view, keeping their original attributes separately.
 */
function linkContent(markdown: string): { text: string; tags: HtmlTag[] } {
  const original = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const chunks: string[] = [], tags: HtmlTag[] = [];
  let cursor = 0, plainStart = 0;
  const maskUntil = (end: number) => {
    chunks.push(original.slice(plainStart, cursor), original.slice(cursor, end).replace(/[^\r\n]/g, ' '));
    plainStart = cursor = end;
  };
  while (cursor < original.length) {
    // Fences are recognized only in Markdown state, never inside multiline HTML attributes.
    const fence = (cursor === 0 || original[cursor - 1] === '\n')
      ? /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/.exec(original.slice(cursor)) : null;
    if (fence && (fence[1]![0] !== '`' || !fence[2]!.includes('`'))) {
      let end = cursor + fence[0].length;
      while (end < original.length) {
        const newline = original.indexOf('\n', end), next = newline < 0 ? original.length : newline + 1;
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(original.slice(end, newline < 0 ? next : newline));
        end = next;
        if (closing && closing[1]![0] === fence[1]![0] && closing[1]!.length >= fence[1]!.length) break;
      }
      maskUntil(end); continue;
    }
    if (original[cursor] === '\\') { cursor += 2; continue; }
    if (original[cursor] === '`') {
      const opening = /^`+/.exec(original.slice(cursor))![0];
      // Inline code may span soft line breaks, but not the next paragraph.
      const remainder = cursor + opening.length;
      const paragraphEnd = /\r?\n[ \t]*\r?\n/.exec(original.slice(remainder));
      const limit = paragraphEnd ? remainder + paragraphEnd.index : original.length;
      let closing = original.indexOf('`', cursor + opening.length), end: number | undefined;
      while (closing >= 0 && closing < limit) {
        const ticks = /^`+/.exec(original.slice(closing))![0];
        if (ticks.length === opening.length) { end = closing + ticks.length; break; }
        closing = original.indexOf('`', closing + ticks.length);
      }
      if (end !== undefined) maskUntil(end);
      else cursor += opening.length; // An unmatched delimiter is literal text, not code.
      continue;
    }
    if (original[cursor] === '<') {
      const tag = htmlTagAt(original, cursor);
      if (tag) { tags.push(tag); maskUntil(tag.end); continue; }
    }
    cursor++;
  }
  chunks.push(original.slice(plainStart));
  return { text: chunks.join(''), tags };
}
interface Link { value: string; wiki: boolean }
interface ReferenceDefinition { start: number; end: number; label: string; value: string }
function normalizeMarkdownReferenceLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
/** A bracket-colon line is a resource definition only when explicit Markdown
 * reference syntax uses its label. Prompt templates commonly use [Role]: prose. */
function activeReferenceDefinitions(text: string): Link[] {
  const definitions: ReferenceDefinition[] = [];
  for (const match of text.matchAll(/^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|([^\s\r\n]+))/gm)) {
    definitions.push({ start: match.index!, end: match.index! + match[0].length,
      label: normalizeMarkdownReferenceLabel(match[1]!), value: match[2] ?? match[3]! });
  }
  let referenceScan = text;
  for (const definition of definitions) {
    referenceScan = referenceScan.slice(0, definition.start)
      + ' '.repeat(definition.end - definition.start) + referenceScan.slice(definition.end);
  }
  const usedLabels = new Set<string>();
  for (const match of referenceScan.matchAll(/!?\[([^\]\r\n]*)\]\[([^\]\r\n]*)\]/g)) {
    const label = normalizeMarkdownReferenceLabel(match[2] || match[1]!);
    if (label) usedLabels.add(label);
  }
  return definitions.filter(definition => usedLabels.has(definition.label)).map(definition => ({ value: definition.value, wiki: false }));
}
function links(markdown: string): Link[] {
  const { text, tags } = linkContent(markdown), result: Link[] = [];
  for (const match of text.matchAll(/!?\[\[([^\]|]+)(?:\|(?:\\.|[^\]])*)?\]\]/g)) result.push({ value: match[1]!, wiki: true });
  for (const match of text.matchAll(MARKDOWN_INLINE_LINK_PATTERN)) result.push({ value: match[2] ?? match[3]!, wiki: false });
  result.push(...activeReferenceDefinitions(text));
  for (const tag of tags) {
    for (const [name, value] of tag.attributes) {
      if (!resourceAttributes.has(name)) continue;
      if (value === null || !value.trim() || /[<>\x00-\x1f\x7f]/.test(value)) throw new Error('malformed HTML resource value');
      const destinations = name === 'srcset' ? value.split(',').map(s => s.trim().split(/\s+/)[0]!) : [value.trim()];
      for (const value of destinations) result.push({ value, wiki: false });
    }
  }
  return result;
}
function headingText(value: string): string {
  const code: string[] = [];
  let text = value.replace(/(`+)([\s\S]*?)\1(?!`)/g, (_all, _ticks, body: string) => {
    code.push(body.replace(/\s+/g, ' ').trim()); return `\u0000${code.length - 1}\u0000`;
  });
  for (const tag of htmlTags(text).reverse()) text = text.slice(0, tag.start) + text.slice(tag.end);
  text = text.replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*{1,3}|_{1,3}|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
  return text.replace(/\u0000(\d+)\u0000/g, (_all, index: string) => code[Number(index)]!).trim();
}
function headingAnchors(markdown: string): Set<string> {
  const headings: string[] = [], paragraph: string[] = [];
  for (const line of markdownBlocks(markdown).split('\n')) {
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*)|$)/.exec(line);
    if (atx) { headings.push(headingText((atx[1] ?? '').replace(/[ \t]+#+[ \t]*$/, ''))); paragraph.length = 0; }
    else if (paragraph.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) { headings.push(headingText(paragraph.join(' '))); paragraph.length = 0; }
    else if (!line.trim() || /^(?: {4}|\t| {0,3}(?:>|[-+*] |\d+[.)] ))/.test(line)) paragraph.length = 0;
    else paragraph.push(line.trim());
  }
  const anchors = new Set<string>(), usedSlugs = new Set<string>();
  for (const heading of headings) {
    const text = heading.toLowerCase(), base = text.replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    let slug = base, suffix = 0;
    while (usedSlugs.has(slug)) slug = `${base}-${++suffix}`;
    usedSlugs.add(slug); anchors.add(slug); anchors.add(text);
  }
  return anchors;
}
function hasAnchor(markdown: string, fragment: string): boolean {
  if (fragment.startsWith('^')) return new RegExp(`(?:^|\\s)\\^${fragment.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(prose(markdown));
  return headingAnchors(markdown).has(fragment.toLowerCase());
}
function linkTarget(file: string, link: Link, installed: ReadonlyMap<string, Uint8Array>): string | null {
  if (/^(?:https?:\/\/|mailto:)/i.test(link.value)) return null;
  const value = decodeURIComponent(link.value);
  if (!value || /[\\\x00-\x1f\x7f<>]/.test(value) || value.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) throw new Error('unsafe local destination');
  const [rawPath, fragment] = value.split('#', 2);
  const path = rawPath!.split('?')[0]!;
  let target = path ? posix.normalize(link.wiki ? path : posix.join(posix.dirname(file), path)) : file;
  archivePath(target);
  if (!target.startsWith('Evidence/')) throw new Error('link leaves managed Evidence');
  if (link.wiki && !installed.has(target) && installed.has(target + '.md')) target += '.md';
  const bytes = installed.get(target);
  if (!bytes) throw new Error('missing local destination');
  if (fragment && target.endsWith('.md') && !hasAnchor(Buffer.from(bytes).toString('utf8'), fragment)) throw new Error('missing Markdown anchor');
  return target;
}

/** Read-only audit of publisher-owned Evidence. Root manual content and .obsidian are not scanned. */
export async function validateVault(input: VaultValidationInput): Promise<VaultValidationReport> {
  const issues: VaultValidationIssue[] = [];
  const add = (kind: string, path: string, extra: Partial<VaultValidationIssue> = {}) => issues.push({ kind, path, ...extra });
  const expectedPaperCount = new Set(input.sources.map(s => `${s.manifest.baseId}-v${s.manifest.version}`)).size;
  let paperCount = 0, indexCount = 0;
  const report = (): VaultValidationReport => ({ valid: !issues.length, paperCount, expectedPaperCount, indexCount,
    brokenLinks: issues.filter(i => i.kind === 'broken_link').length,
    missingAssets: issues.filter(i => i.kind === 'missing_asset').length, issues });
  let root: string, tree: string[];
  try {
    root = vaultAbsolutePath(input.vaultRoot); await assertRealPath(root);
    const aliases = (await readdir(root)).filter(name => name.toLowerCase() === 'evidence');
    if (aliases.some(name => name !== EVIDENCE_LAYOUT_V3.root)) throw new Error('case alias for Evidence');
    const evidence = join(root, EVIDENCE_LAYOUT_V3.root);
    tree = (await realTree(evidence)).map(p => 'Evidence/' + p);
    assertUniqueVaultPaths(tree);
  } catch (error) { add(absent(error) ? 'missing_file' : 'unsafe_path', 'Evidence', { detail: String(error) }); return report(); }
  // Recheck disk Archives: an in-memory "verified" value is not a durable trust boundary.
  const sources: VerifiedArchiveV2[] = [];
  for (const source of input.sources) {
    try {
      const current = await verifyArchiveV2(source.root);
      if (hashCanonical(current.manifest) !== hashCanonical(source.manifest)) throw new Error('Archive changed since verification');
      sources.push(current);
    }
    catch (error) { add('invalid_archive', `${source.manifest.baseId}-v${source.manifest.version}`, { detail: String(error) }); }
  }
  if (issues.length) return report();
  let expected;
  try { expected = renderEvidenceV3(sources); }
  catch (error) { add('invalid_projection', 'Evidence', { detail: String(error) }); return report(); }
  const expectedByPath = new Map(expected.map(file => [file.path, file]));
  const installed = new Map<string, Uint8Array>();
  const allowedDirectories = new Set(['Evidence/papers/', 'Evidence/indexes/']);
  for (const file of expected) for (let p = posix.dirname(file.path); p !== '.'; p = posix.dirname(p)) allowedDirectories.add(p + '/');
  for (const path of tree) {
    if (path.endsWith('/')) { if (!allowedDirectories.has(path)) add('unexpected_directory', path); continue; }
    if (!expectedByPath.has(path)) add('unexpected_file', path);
    try {
      const absolute = join(root, path); await assertRealPath(absolute);
      if (!(await lstat(absolute)).isFile()) throw new Error('expected regular file');
      installed.set(path, await readFile(absolute));
    } catch (error) { add('unsafe_path', path, { detail: String(error) }); }
  }
  paperCount = [...installed.keys()].filter(p => /^Evidence\/papers\/[^/]+\/paper\.md$/.test(p)).length;
  indexCount = [...installed.keys()].filter(p => p.startsWith('Evidence/indexes/')).length;
  if (paperCount !== expectedPaperCount) add('paper_count_mismatch', 'Evidence/papers');
  if (indexCount !== 4) add('index_count_mismatch', 'Evidence/indexes');
  for (const file of expected) {
    const bytes = installed.get(file.path);
    const asset = file.path.includes('/assets/'), pdf = !asset && file.path.endsWith('/source.pdf');
    if (!bytes) add(asset ? 'missing_asset' : file.path.startsWith('Evidence/indexes/') ? 'missing_index' : 'missing_file', file.path);
    else if (hash(bytes) !== file.sha256 || bytes.byteLength !== file.bytes.byteLength) {
      add(asset ? 'asset_hash_mismatch' : pdf ? 'pdf_hash_mismatch' : 'content_hash_mismatch', file.path);
    }
  }
  for (const [path, bytes] of installed) {
    if (!path.endsWith('.md')) continue;
    let references: Link[];
    try { references = links(Buffer.from(bytes).toString('utf8')); }
    catch (error) { add('broken_link', path, { detail: String(error) }); continue; }
    for (const link of references) {
      try { linkTarget(path, link, installed); }
      catch (error) { add('broken_link', path, { target: link.value, detail: String(error) }); }
    }
  }
  return report();
}
