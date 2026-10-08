import { normalizeArchivePath } from './manifest.ts';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * MinerU can emit `(trunc)` when a long extracted table/link is truncated.
 * This is a prose placeholder, not a file in the MinerU output directory.
 * Keep this list deliberately narrow so genuine missing Archive resources
 * remain strict failures.
 */
const MINERU_TRUNCATION_PLACEHOLDERS = new Set(['trunc', 'truncate', 'truncated']);

export function isMinerUTruncationPlaceholder(value: string): boolean {
  const trimmed = value.trim().replace(/^<|>$/g, '');
  const destination = trimmed.split(/[?#]/, 1)[0]?.toLowerCase();
  return destination !== undefined && MINERU_TRUNCATION_PLACEHOLDERS.has(destination);
}

/**
 * MinerU can preserve template-driven HTML examples such as
 * `src="{{layer:...}}"`. These are renderer placeholders, not local files;
 * only the namespaced double-brace form is ignored so ordinary brace-bearing
 * paths remain subject to Archive validation.
 */
export function isMinerUTemplateAssetPlaceholder(value: string): boolean {
  const destination = value.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0] ?? '';
  return /^\{\{[A-Za-z][A-Za-z0-9_.-]*:[^{}\r\n]+\}\}$/.test(destination);
}

interface MarkdownCodeRange { start: number; end: number; }

function isEscapedMarkdownCharacter(markdown: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; markdown[cursor] === '\\'; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

function markdownCodeRanges(markdown: string): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  const fences = /^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm;
  let open: { start: number; end: number; marker: string; length: number } | undefined;
  for (const match of markdown.matchAll(fences)) {
    const marker = match[1]!;
    if (!open) {
      open = { start: match.index!, end: match.index! + match[0].length, marker: marker[0]!, length: marker.length };
      continue;
    }
    if (marker[0] === open.marker && marker.length >= open.length) {
      ranges.push({ start: open.start, end: match.index! + match[0].length });
      open = undefined;
    }
  }
  if (open) ranges.push({ start: open.start, end: markdown.length });

  let fenceIndex = 0;
  for (let index = 0; index < markdown.length;) {
    const fence = ranges[fenceIndex];
    if (fence && index >= fence.start) { index = fence.end; fenceIndex++; continue; }
    if (markdown[index] !== '`' || isEscapedMarkdownCharacter(markdown, index)) { index++; continue; }
    let delimiterEnd = index + 1;
    while (markdown[delimiterEnd] === '`') delimiterEnd++;
    const delimiter = markdown.slice(index, delimiterEnd);
    // Backslash escaping applies when recognizing a prose opener only.
    // Inside a code span, CommonMark treats a matching delimiter literally.
    const close = markdown.indexOf(delimiter, delimiterEnd);
    if (close < 0) { index = delimiterEnd; continue; }
    ranges.push({ start: index, end: close + delimiter.length });
    index = close + delimiter.length;
  }
  return ranges.sort((left, right) => left.start - right.start);
}

/** Keep offsets stable while hiding Markdown code from resource scanners. */
export function maskMarkdownCode(markdown: string): string {
  let masked = markdown;
  for (const range of markdownCodeRanges(markdown)) {
    const code = masked.slice(range.start, range.end).replace(/[^\r\n]/g, ' ');
    masked = masked.slice(0, range.start) + code + masked.slice(range.end);
  }
  return masked;
}

/** Apply a resource transform only to Markdown outside code spans/fences. */
export function mapMarkdownOutsideCode(markdown: string, transform: (segment: string) => string): string {
  const ranges = markdownCodeRanges(markdown);
  let output = '', cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    output += transform(markdown.slice(cursor, range.start));
    output += markdown.slice(range.start, range.end);
    cursor = range.end;
  }
  return output + transform(markdown.slice(cursor));
}

function localAssetPath(value: string): string | null {
  const trimmed = value.trim().replace(/^<|>$/g, '');
  if (/^(?:[A-Za-z]:|file:|\\\\|\/\/)/i.test(trimmed)) throw new Error('absolute asset path is forbidden');
  if (!trimmed || trimmed.startsWith('#') || /^https?:/i.test(trimmed)
    || isMinerUTruncationPlaceholder(trimmed) || isMinerUTemplateAssetPlaceholder(trimmed)) return null;
  return normalizeArchivePath(trimmed.split(/[?#]/, 1)[0] || trimmed);
}

interface ArchiveAssetPathIndex { has(path: string): boolean; }

/** Resolve a raw MinerU path only when the supplied assets include its normalized Archive path. */
export function normalizedArchiveAssetPath(path: string, assetPaths: ArchiveAssetPathIndex): string | undefined {
  if (assetPaths.has(path)) return path;
  const normalized = `assets/${path}`;
  return !path.startsWith('assets/') && assetPaths.has(normalized) ? normalized : undefined;
}

/** Resolve an Archive resource to the mapped destination of its verified path. */
export function normalizedArchiveAssetDestination(path: string, assetPaths: ReadonlyMap<string, string>): string | undefined {
  const normalized = normalizedArchiveAssetPath(path, assetPaths);
  return normalized ? assetPaths.get(normalized) : undefined;
}

function markdownAssetPaths(markdown: string): string[] {
  const paths: string[] = [];
  const scan = maskMarkdownCode(markdown);
  const inlineRanges: { start: number; end: number }[] = [];
  for (const match of scan.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) {
    const start = match.index;
    inlineRanges.push({ start, end: start + match[0].length });
    const marker = scan.indexOf('](', start);
    if (marker >= 0 && (isLikelyMarkdownImagePlaceholder(scan, marker, match[1] ?? match[2]!)
      || isLikelyExtractedImageExample(scan, marker, match[1] ?? match[2]!))) continue;
    const path = localAssetPath(match[1] ?? match[2]);
    if (path) paths.push(path);
  }

  const definitions = new Map<string, string>();
  for (const match of scan.matchAll(/^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|([^\s\r\n]+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm)) {
    definitions.set(normalizeReferenceLabel(match[1]), match[2] ?? match[3]);
  }
  for (const match of scan.matchAll(/!\[([^\]\r\n]*)\](?:[ \t]*\[([^\]\r\n]*)\])?/g)) {
    const start = match.index;
    if (inlineRanges.some(range => start >= range.start && start < range.end)) continue;
    const label = normalizeReferenceLabel(match[2] || match[1]);
    const destination = definitions.get(label);
    if (!destination) {
      if (isTruncatedExternalImage(scan, start + match[0].length)
        || isSplitExternalImageReference(scan, start + match[0].length)) continue;
      throw new Error(`Markdown image reference has no destination: ${label}`);
    }
    const path = localAssetPath(destination);
    if (path) paths.push(path);
  }

  const htmlImageRanges: { start: number; end: number }[] = [];
  // HTML resource syntax inside fenced or inline code is an example, not an
  // Archive reference. `scan` preserves offsets while masking those ranges,
  // so both discovery and malformed-tag checks must use it consistently.
  for (const match of scan.matchAll(/<(img|source)(?=[\s/>])([^>]*)>/gi)) {
    const start = match.index;
    htmlImageRanges.push({ start, end: start + match[0].length });
    const tag = match[1].toLowerCase();
    const attributes = match[2];
    const src = htmlAttribute(attributes, 'src');
    const srcset = htmlAttribute(attributes, 'srcset');
    // Papers often mention HTML elements in ordinary prose, for example
    // "an <img> tag".  A tag with no attributes is not an asset reference;
    // keep rejecting attribute-bearing image elements without a destination.
    if (src === null && srcset === null && !isBareHtmlImageTag(attributes)) {
      throw new Error(`HTML ${tag} element must have a parseable src or srcset attribute`);
    }
    if (src === null && srcset === null) continue;
    if (src !== null) {
      const path = localAssetPath(src);
      if (path) paths.push(path);
    }
    if (srcset !== null) for (const candidate of srcset.split(',')) {
      const destination = candidate.trim().split(/\s+/, 1)[0];
      if (!destination) throw new Error('HTML image srcset contains an empty destination');
      const path = localAssetPath(destination);
      if (path) paths.push(path);
    }
  }
  for (const match of scan.matchAll(/<(?:img|source)(?=[\s/>])/gi)) {
    if (!htmlImageRanges.some(range => match.index >= range.start && match.index < range.end)) {
      throw new Error('Markdown contains malformed HTML image syntax');
    }
  }
  return paths;
}

function normalizeReferenceLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** CommonMark footnote definitions look like reference definitions, but their
 * first token is prose and must never be treated as an Archive path. */
export function isFootnoteReferenceLabel(value: string): boolean {
  return value.trim().startsWith('^');
}

/** MinerU can flatten a citation followed by an architectural descriptor
 * into Markdown-looking prose such as `[41](Transformer-based)`. */
export function isLikelyCitationParenthesizedProse(text: string, matchIndex: number, destination: string): boolean {
  const open = text.lastIndexOf('[', matchIndex);
  if (open < 0 || text[open - 1] === '!') return false;
  const label = text.slice(open + 1, matchIndex).trim();
  if (!/^\d+(?:\s*[-–,]\s*\d+)*$/.test(label)) return false;
  const value = destination.trim().replace(/^<|>$/g, '');
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(value);
}

/**
 * MinerU may truncate an external image embedded in a table cell before the
 * closing Markdown parenthesis, for example `![shot](https://.../Simulat...</td>`.
 * It is a prose excerpt, not a local Archive asset. Keep malformed local
 * image syntax strict; only this external, ellipsis-terminated form is soft.
 */
function isTruncatedExternalImage(markdown: string, end: number): boolean {
  return /^\s*\(\s*https?:\/\/[^\r\n)]*(?:\.\.\.|…)[^\r\n)]*(?:<\/[^>]+>|$)/i.test(markdown.slice(end));
}

/**
 * MinerU can wrap a long external image URL at a line boundary, for example
 * `![Services Hexagon](https://example.com/\nservices-hexagon.png)`. The
 * inline-image scanner intentionally rejects newlines in destinations, so
 * the later reference scan would otherwise report a false missing destination
 * for the image label. Only an explicitly external URL with a closed image
 * expression is soft; malformed local images remain strict.
 */
function isSplitExternalImageReference(markdown: string, end: number): boolean {
  return /^\s*\(\s*https?:\/\/[^\r\n)]*(?:(?:\r\n|\r|\n)[^\r\n)]*)+\s*\)/i.test(markdown.slice(end));
}

/**
 * Papers sometimes quote the output of other OCR/extraction systems, whose
 * Markdown contains names such as `fileoutpart42.png` or `placeholder`.
 * Those names are prose examples unless they occur in the current MinerU
 * asset tree. Keep the exception tied to an OCR/extraction section so ordinary
 * local files with similar names remain strict.
 */
export function isLikelyExtractedImageExample(text: string, matchIndex: number, destination: string): boolean {
  const open = text.lastIndexOf('[', matchIndex);
  if (open < 0) return false;
  const value = destination.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0] ?? '';
  const isNamedExtractorOutput = /^(?:fileoutpart\d+|img-\d+)\.(?:png|jpe?g|gif|webp)$/i.test(value);
  const isPlaceholder = value.toLowerCase() === 'placeholder';
  if (!isNamedExtractorOutput && !isPlaceholder) return false;
  const context = text.slice(Math.max(0, open - 2000), open);
  if (isPlaceholder) return /\b(?:mistral|ocr|extract|placeholder)\b/i.test(context);
  if (text[open - 1] !== '!') return false;
  return /\b(?:adobe|mistral|ocr|extract|easyocr)\b/i.test(context);
}

/**
 * MinerU can preserve prompt examples such as `Images are rendered as
 * ![](url)`. The empty-alt image and generic `url` token are documentation
 * syntax, not a file emitted by MinerU. Keep real images strict by requiring
 * the empty alt form, the exact placeholder token, and an explanatory line.
 */
export function isLikelyMarkdownImagePlaceholder(text: string, matchIndex: number, destination: string): boolean {
  const open = text.lastIndexOf('[', matchIndex);
  if (open <= 0 || text[open - 1] !== '!' || text.slice(open + 1, matchIndex).trim()) return false;
  const value = destination.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0]?.toLowerCase();
  if (value !== 'url') return false;
  const lineStart = text.lastIndexOf('\n', open - 1) + 1;
  return /\b(?:image|images|render|rendered|markdown|figure|display|shown|output)\b/i.test(text.slice(lineStart, open));
}

// MinerU may escape underscores inconsistently while flattening Python code
// into Markdown. A dotted attribute such as
// `[self.\_criteria[...]](self.\_state)` (or its unescaped VLM equivalent)
// is code notation, not a local Archive resource. Keep the exception narrow:
// require an identifier-shaped destination and a matching dotted/subscripted
// label. A malformed path without that code shape still fails strict Archive
// path validation.
const PYTHON_ATTRIBUTE_DESTINATION = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_\\][A-Za-z0-9_\\]*)+$/;
const PYTHON_ATTRIBUTE_CONTEXT = /(?:^|[\s(])[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_\\][A-Za-z0-9_\\]*$/;
export function isLikelyPythonAttributeNotation(text: string, matchIndex: number, destination: string): boolean {
  const open = text.lastIndexOf('[', matchIndex);
  if (open < 0) return false;
  const label = text.slice(open + 1, matchIndex);
  const value = destination.trim();
  if (!PYTHON_ATTRIBUTE_DESTINATION.test(value) || !value.includes('_')) return false;
  const objectName = value.split('.', 1)[0]!;
  const trimmedLabel = label.trim();
  const outerOpen = text.lastIndexOf('[', open - 1);
  const contextStart = outerOpen >= 0 ? outerOpen + 1 : text.lastIndexOf('\n', open - 1) + 1;
  const attributeContext = text.slice(contextStart, open).trim();
  return trimmedLabel.startsWith(`${objectName}.`) && PYTHON_ATTRIBUTE_CONTEXT.test(attributeContext);
}

// MinerU also preserves Python argument unpacking as a Markdown-looking link,
// for example `registry[tc.name](\*\*tc.args)`. The destination is Python
// syntax, not an Archive path; require the same dotted object on both sides so
// ordinary starred filenames and real resources remain strict.
const PYTHON_UNPACK_DESTINATION = /^(?:(?:\\?\*){1,2})([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/;
const PYTHON_DOTTED_LABEL = /^([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*$/;
export function isLikelyPythonArgumentUnpackingNotation(text: string, matchIndex: number, destination: string): boolean {
  const open = text.lastIndexOf('[', matchIndex);
  if (open < 0) return false;
  const destinationMatch = PYTHON_UNPACK_DESTINATION.exec(destination.trim());
  const labelMatch = PYTHON_DOTTED_LABEL.exec(text.slice(open + 1, matchIndex).trim());
  return destinationMatch !== null && labelMatch !== null && destinationMatch[1]!.split('.', 1)[0] === labelMatch[1];
}

function htmlAttribute(attributes: string, name: 'src' | 'srcset'): string | null {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`, 'i');
  const match = pattern.exec(attributes);
  if (!match) return null;
  const value = match[1] ?? match[2] ?? match[3];
  if (!value) throw new Error(`HTML image ${name} attribute must not be empty`);
  return value;
}

function isContentListAssetKey(key: string): boolean {
  return /^src$/i.test(key) || /(?:^|_)(?:image|img|asset)(?:s|_path|_url)?$/i.test(key);
}

function collectContentListAssetValue(value: unknown, paths: string[], key: string): void {
  if (typeof value === 'string') {
    const path = localAssetPath(value);
    if (path) paths.push(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectContentListAssetValue(item, paths, key);
    return;
  }
  throw new Error(`content-list asset field ${key} must contain a path or path array`);
}

function contentListAssetPaths(value: unknown, paths: string[] = [], key?: string): string[] {
  if (key && isContentListAssetKey(key)) {
    collectContentListAssetValue(value, paths, key);
    return paths;
  }
  if (Array.isArray(value)) { for (const item of value) contentListAssetPaths(item, paths); return paths; }
  if (isRecord(value)) for (const [childKey, child] of Object.entries(value)) contentListAssetPaths(child, paths, childKey);
  return paths;
}

/**
 * Discover every local asset that the deterministic Evidence renderer can
 * publish.  Archive migration deliberately uses this same parser instead of
 * maintaining a weaker Markdown-only interpretation of old Archives.
 */
export function discoverArchiveAssetPaths(fullMarkdown: string, contentList: unknown): string[] {
  return [...new Set([...markdownAssetPaths(fullMarkdown), ...contentListAssetPaths(contentList)])].sort();
}

function rewriteDestination(value: string, assetPaths: ReadonlyMap<string, string>): string {
  const trimmed = value.trim();
  const bracketed = trimmed.startsWith('<') && trimmed.endsWith('>');
  const bare = bracketed ? trimmed.slice(1, -1) : trimmed;
  const suffixIndex = bare.search(/[?#]/);
  const suffix = suffixIndex >= 0 ? bare.slice(suffixIndex) : '';
  const local = localAssetPath(bare);
  if (!local) return value;
  const replacement = normalizedArchiveAssetDestination(local, assetPaths);
  if (!replacement) return value;
  const rewritten = `${replacement}${suffix}`;
  return bracketed ? `<${rewritten}>` : rewritten;
}

function rewriteHtmlAttribute(attributes: string, name: 'src' | 'srcset', assetPaths: ReadonlyMap<string, string>): string {
  const pattern = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s"'=<>\\x60]+)`, 'gi');
  return attributes.replace(pattern, (_all, prefix: string, token: string) => {
    const quoted = token.startsWith('"') || token.startsWith("'");
    const quote = quoted ? token[0] : '';
    const value = quoted ? token.slice(1, -1) : token;
    const rewritten = name === 'src'
      ? rewriteDestination(value, assetPaths)
      : value.split(',').map(candidate => {
        const trimmed = candidate.trim();
        const [destination, ...descriptor] = trimmed.split(/\s+/);
        return [rewriteDestination(destination, assetPaths), ...descriptor].join(' ');
      }).join(', ');
    return `${prefix}${quote}${rewritten}${quote}`;
  });
}

function isBareHtmlImageTag(attributes: string): boolean {
  return attributes.trim().replace(/\/\s*$/, '').trim() === '';
}

function escapeLiteralHtmlImageTag(tag: string, attributes: string): string {
  return `&lt;${tag}${attributes}&gt;`;
}

function rewriteMarkdownAssetPaths(markdown: string, assetPaths: ReadonlyMap<string, string>): string {
  return mapMarkdownOutsideCode(markdown, segment => {
    const inline = segment.replace(/((?:!?\[[^\]\r\n]*\])\(\s*)(<[^>\r\n]+>|[^\s)]+)((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\))/g,
      (_all, prefix: string, destination: string, suffix: string, offset: number) =>
        (isLikelyCitationParenthesizedProse(segment, offset + prefix.length - 2, destination)
          || isLikelyPythonAttributeNotation(segment, offset + prefix.length - 2, destination)
          || isLikelyPythonArgumentUnpackingNotation(segment, offset + prefix.length - 2, destination))
          ? _all
          : `${prefix}${rewriteDestination(destination, assetPaths)}${suffix}`);
    const definitionPattern = /^([ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*)(<[^>\r\n]+>|[^\s\r\n]+)((?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*)$/gm;
    const definitions = [...inline.matchAll(definitionPattern)].map(match => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      label: normalizeReferenceLabel(match[2]!),
    }));
    // A bracket-colon line is only a resource definition when an explicit
    // reference (or an image shortcut) uses its label. Prompt templates and
    // extracted prose commonly contain `[Role]: escaped_text`, which must
    // remain text even when the destination is not a valid POSIX path.
    let referenceScan = inline;
    for (const definition of definitions) {
      referenceScan = referenceScan.slice(0, definition.start)
        + ' '.repeat(definition.end - definition.start)
        + referenceScan.slice(definition.end);
    }
    const usedLabels = new Set<string>();
    for (const match of referenceScan.matchAll(/!?(?:\[([^\]\r\n]*)\])\[([^\]\r\n]*)\]/g)) {
      const label = normalizeReferenceLabel(match[2] || match[1]!);
      if (label) usedLabels.add(label);
    }
    for (const match of referenceScan.matchAll(/!\[([^\]\r\n]*)\](?![ \t]*\[)/g)) {
      const label = normalizeReferenceLabel(match[1]!);
      if (label) usedLabels.add(label);
    }
    const activeLabels = new Set(definitions
      .filter(definition => !isFootnoteReferenceLabel(definition.label) && usedLabels.has(definition.label))
      .map(definition => definition.label));
    const rewrittenDefinitions = inline.replace(definitionPattern,
      (_all, prefix: string, label: string, destination: string, suffix: string) =>
        activeLabels.has(normalizeReferenceLabel(label))
          ? `${prefix}${rewriteDestination(destination, assetPaths)}${suffix}`
          : _all);
    return rewrittenDefinitions.replace(/<(img|source)\b([^>]*)>/gi, (_all, tag: string, attributes: string) => {
      if (isBareHtmlImageTag(attributes)) return escapeLiteralHtmlImageTag(tag, attributes);
      return `<${tag}${rewriteHtmlAttribute(rewriteHtmlAttribute(attributes, 'src', assetPaths), 'srcset', assetPaths)}>`;
    });
  });
}

function rewriteContentListAssetValue(value: unknown, assetPaths: ReadonlyMap<string, string>, key: string): unknown {
  if (typeof value === 'string') return rewriteDestination(value, assetPaths);
  if (Array.isArray(value)) return value.map(item => rewriteContentListAssetValue(item, assetPaths, key));
  throw new Error(`content-list asset field ${key} must contain a path or path array`);
}

function rewriteContentListAssetPaths(value: unknown, assetPaths: ReadonlyMap<string, string>, key?: string): unknown {
  if (key && isContentListAssetKey(key)) return rewriteContentListAssetValue(value, assetPaths, key);
  if (Array.isArray(value)) return value.map(item => rewriteContentListAssetPaths(item, assetPaths));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([childKey, child]) =>
    [childKey, rewriteContentListAssetPaths(child, assetPaths, childKey)]));
  return value;
}

export function rewriteArchiveAssetReferences(fullMarkdown: string, contentList: unknown, assetPaths: ReadonlyMap<string, string>, ignoredPaths: ReadonlySet<string> = new Set()) {
  for (const path of discoverArchiveAssetPaths(fullMarkdown, contentList)) {
    if (ignoredPaths.has(path)) continue;
    if (!normalizedArchiveAssetDestination(path, assetPaths)) throw new Error(`referenced asset has no normalized destination: ${path}`);
  }
  return {
    fullMarkdown: rewriteMarkdownAssetPaths(fullMarkdown, assetPaths),
    contentList: rewriteContentListAssetPaths(contentList, assetPaths),
  };
}
