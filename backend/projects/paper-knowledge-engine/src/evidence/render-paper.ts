import { createHash } from 'node:crypto';
import { rewriteArchiveAssetReferences } from '../shared/archive-references.ts';
import { type VerifiedArchiveSource } from './archive-reader.ts';
import { canonicalJson, normalizeArchivePath } from '../shared/manifest.ts';
import { authorPageId, categoryPageId, trackPageId, yearPageId } from './render-indexes.ts';
import { archivePath, archiveReferences, rewriteArchiveReferences } from '../shared/archive-v2.ts';
import { evidencePaperRoot, type BufferedEvidenceSource } from './layout-paths.ts';
import { LEGACY_EVIDENCE_ROOT } from '../shared/historical-compatibility.ts';
import paperIndexTemplate from '../../templates/evidence/paper-index.md' with { type: 'text' };

export interface RenderedFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

type Asset = VerifiedArchiveSource['assets'][number];

const encoder = new TextEncoder();
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const normalizeLf = (value: string) => value.replace(/\r\n?/g, '\n');

/** Statically embedded template: rendering remains filesystem-free at runtime. */
export const PAPER_INDEX_TEMPLATE = paperIndexTemplate;
// Read-only legacy projection used to authenticate historical migration inputs.
const LEGACY_PAPER_INDEX_TEMPLATE = "---\ntype: \"paper-evidence\"\nbase_id: {{baseIdYaml}}\narxiv_id: {{arxivIdYaml}}\nversion: {{version}}\ntitle: {{titleYaml}}\nauthors:{{authors}}\ncategories:{{categories}}\nmatched_tracks:{{matchedTracks}}\npublished: {{publishedYaml}}\nupdated: {{updatedYaml}}\npdf_path: {{pdfPathYaml}}\npdf_sha256: {{pdfSha256Yaml}}\narchive_manifest_sha256: {{archiveManifestSha256Yaml}}\nparse_attempt_id: {{parseAttemptIdYaml}}\nparser_model: {{modelYaml}}\ncli_backend: {{cliBackendYaml}}\nparse_method: {{methodYaml}}\npage_count: {{pageCount}}\n---\n\n# {{title}}\n\n- Archive PDF: `{{pdfPath}}`\n- Document: [document.md](document.md)\n- Pages: [pages.md](pages.md)\n- Page records: [pages.json](pages.json)\n- MinerU content list: [content_list.json](content_list.json)\n\n## Relationship indexes\n\n### Authors\n{{authorIndexLinks}}\n\n### Categories\n{{categoryIndexLinks}}\n\n### Tracks\n{{trackIndexLinks}}\n\n### Year\n{{yearIndexLinks}}\n";

function paperRoot(source: VerifiedArchiveSource): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source.source.baseId)) throw new TypeError('verified source baseId is not a safe evidence path segment');
  return `sources/papers/${source.source.baseId}/v${source.source.version}`;
}

function renderFile(path: string, bytes: Uint8Array): RenderedFile {
  return { path, bytes: new Uint8Array(bytes), sha256: hash(bytes) };
}

function textFile(path: string, value: string): RenderedFile {
  return renderFile(path, encoder.encode(normalizeLf(value)));
}

function renderedAssetPath(asset: Asset): string {
  const relativePath = normalizeArchivePath(asset.relativePath);
  return relativePath.startsWith('assets/') ? relativePath : `assets/${relativePath}`;
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: readonly string[]): string {
  return values.length === 0 ? '[]' : `\n${values.map(value => `  - ${yaml(value)}`).join('\n')}`;
}

function linkLabel(value: string): string {
  return value.replace(/[\[\]|]/g, '\\$&');
}

function relationshipLinks(values: readonly { path: string; label: string }[]): string {
  const unique = new Map(values.map(value => [value.path, value]));
  return [...unique.values()].sort((left, right) => compareText(left.path, right.path))
    .map(value => `- [[${LEGACY_EVIDENCE_ROOT}/${value.path}|${linkLabel(value.label)}]]`).join('\n') || '- None';
}

function renderIndex(source: VerifiedArchiveSource): string {
  const value = source.source;
  const authorLinks = 'authors' in value ? value.authors.map(author => ({ path: `indexes/authors/${authorPageId(author)}`, label: author })) : [];
  const categoryLinks = 'categories' in value ? value.categories.map(category => ({ path: `indexes/categories/${categoryPageId(category)}`, label: category })) : [];
  const trackLinks = 'matchedTracks' in value ? value.matchedTracks.map(track => ({ path: `indexes/tracks/${trackPageId(track)}`, label: track })) : [];
  const replacements: Record<string, string> = {
    baseIdYaml: yaml(value.baseId),
    arxivIdYaml: yaml('arxivId' in value ? value.arxivId : `${value.baseId}v${value.version}`),
    version: String(value.version),
    titleYaml: yaml(value.title),
    authors: 'authors' in value ? yamlList(value.authors) : '[]',
    categories: 'categories' in value ? yamlList(value.categories) : '[]',
    matchedTracks: 'matchedTracks' in value ? yamlList(value.matchedTracks) : '[]',
    publishedYaml: yaml('published' in value ? value.published : ''),
    updatedYaml: yaml('updated' in value ? value.updated : ''),
    pdfPathYaml: yaml(value.pdfPath),
    pdfPath: value.pdfPath,
    pdfSha256Yaml: yaml(value.pdfSha256),
    archiveManifestSha256Yaml: yaml(source.archiveManifestSha256),
    parseAttemptIdYaml: yaml(value.parseAttemptId),
    modelYaml: yaml(value.model),
    cliBackendYaml: yaml(value.cliBackend),
    methodYaml: yaml(value.method),
    pageCount: String(value.pageCount),
    title: value.title,
    authorIndexLinks: relationshipLinks(authorLinks),
    categoryIndexLinks: relationshipLinks(categoryLinks),
    trackIndexLinks: relationshipLinks(trackLinks),
    yearIndexLinks: 'published' in value
      ? relationshipLinks([{ path: `indexes/years/${yearPageId(value.published)}`, label: yearPageId(value.published) }])
      : '- None',
  };
  return LEGACY_PAPER_INDEX_TEMPLATE.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_token: string, name: string) => {
    const replacement = replacements[name];
    if (replacement === undefined) throw new TypeError(`paper index template contains unknown placeholder: ${name}`);
    return replacement;
  });
}

function renderPages(pages: readonly { page: number; text: string }[]): string {
  return `${pages.map(page => `# PAGE ${page.page}\n\n${normalizeLf(page.text)}\n\n^page-${page.page}`).join('\n\n')}\n`;
}

/** Render one fully verified Archive source without reading or writing any external state. */
export function renderPaperEvidence(source: VerifiedArchiveSource): RenderedFile[] {
  const root = paperRoot(source);
  const assetPaths = new Map<string, string>();
  const files: RenderedFile[] = [];

  for (const asset of source.assets) {
    const destination = renderedAssetPath(asset);
    if (assetPaths.has(asset.relativePath) || [...assetPaths.values()].includes(destination)) throw new TypeError(`duplicate verified asset path: ${asset.relativePath}`);
    if (asset.contents.byteLength !== asset.bytes || hash(asset.contents) !== asset.sha256) throw new TypeError(`verified asset bytes do not match its manifest: ${asset.relativePath}`);
    assetPaths.set(asset.relativePath, destination);
    files.push(renderFile(`${root}/${destination}`, asset.contents));
  }
  const rewritten = rewriteArchiveAssetReferences(source.fullMarkdown, source.contentList, assetPaths);

  files.push(
    textFile(`${root}/document.md`, rewritten.fullMarkdown),
    textFile(`${root}/pages.md`, renderPages(source.pages)),
    textFile(`${root}/pages.json`, canonicalJson(source.pages)),
    textFile(`${root}/content_list.json`, canonicalJson(rewritten.contentList)),
    textFile(`${root}/index.md`, renderIndex(source)),
  );

  files.sort((left, right) => compareText(left.path, right.path));
  const manifestSource = {
    baseId: source.source.baseId,
    version: source.source.version,
    pdfPath: source.source.pdfPath,
    pdfSha256: source.source.pdfSha256,
    archiveManifestSha256: source.archiveManifestSha256,
    parseAttemptId: source.source.parseAttemptId,
    ...('arxivId' in source.source ? { arxivId: source.source.arxivId } : {}),
  };
  const manifest = {
    schemaVersion: 1,
    generatorVersion: 1,
    source: manifestSource,
    files: files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes.byteLength })),
  };
  files.push(textFile(`${root}/manifest.json`, canonicalJson(manifest)));
  return files.sort((left, right) => compareText(left.path, right.path));
}

/** Render the active compact paper package. All bytes are already buffered and verified. */
export function renderPaperEvidenceV3(source: BufferedEvidenceSource): RenderedFile[] {
  const value = source.source;
  const root = evidencePaperRoot(value.baseId, value.version);
  if (hash(source.pdfContents) !== value.pdfSha256) throw new Error('verified PDF bytes do not match its manifest');
  const paths = new Map<string, string>();
  const destinations = new Set<string>();
  const directories = new Map<string, string>();
  const files: RenderedFile[] = [];
  const pageReferences = new Set(source.pages.flatMap(page => archiveReferences(page.text, [])));
  const references = new Set([...archiveReferences(source.fullMarkdown, source.contentList), ...pageReferences]);
  const publishedAssets = new Set<Asset>();
  for (const path of references) {
    // This exact output is emitted below from the hash-checked PDF bytes.
    // Other Archive payloads are not attachments or implicit output aliases.
    if (path === 'source.pdf') { paths.set(path, 'source.pdf'); continue; }
    // MinerU Markdown can retain a pre-normalization attachment path. Resolve
    // only to the checked assets inventory, never to arbitrary Archive files.
    const asset = source.assets.find(asset => asset.relativePath === path)
      ?? (!path.startsWith('assets/')
        ? source.assets.find(asset => asset.relativePath === `assets/${path}`) : undefined);
    if (!asset) throw new Error(`referenced asset is absent from Archive manifest: ${path}`);
    const destination = archivePath(renderedAssetPath(asset));
    paths.set(path, destination);
    if (publishedAssets.has(asset)) continue;
    const parts = destination.split('/');
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const key = prefix.toLowerCase();
      if (destinations.has(key) || (directories.has(key) && directories.get(key) !== prefix)) throw new Error('Evidence asset path collision');
      directories.set(key, prefix);
    }
    if (destinations.has(destination.toLowerCase()) || directories.has(destination.toLowerCase())) throw new Error('Evidence asset path collision');
    if (asset.bytes !== asset.contents.byteLength || hash(asset.contents) !== asset.sha256) throw new Error(`verified asset bytes do not match its manifest: ${path}`);
    publishedAssets.add(asset); destinations.add(destination.toLowerCase());
    files.push(renderFile(`${root}/${destination}`, asset.contents));
  }
  // Archive v2 closes HTML and structured references as well as Markdown links.
  const rewritten = rewriteArchiveReferences(source.fullMarkdown, source.contentList, paths);
  const replacements: Record<string, string> = {
    baseIdYaml: yaml(value.baseId), arxivIdYaml: yaml('arxivId' in value ? value.arxivId : `${value.baseId}v${value.version}`),
    version: String(value.version), titleYaml: yaml(value.title), title: value.title,
    authors: 'authors' in value ? yamlList(value.authors) : '[]',
    categories: 'categories' in value ? yamlList(value.categories) : '[]',
    matchedTracks: 'matchedTracks' in value ? yamlList(value.matchedTracks) : '[]',
    publishedYaml: yaml('published' in value ? value.published : ''), updatedYaml: yaml('updated' in value ? value.updated : ''),
    pdfSha256Yaml: yaml(value.pdfSha256), archiveManifestSha256Yaml: yaml(source.archiveManifestSha256),
    parseAttemptIdYaml: yaml(value.parseAttemptId), modelYaml: yaml(value.model), methodYaml: yaml(value.method),
    pageCount: String(value.pageCount), markdown: rewritten.fullMarkdown,
  };
  const paper = PAPER_INDEX_TEMPLATE.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_token, name: string) => {
    if (!(name in replacements)) throw new TypeError(`unknown paper template placeholder: ${name}`);
    return replacements[name]!;
  });
  const pages = [...source.pages].sort((a, b) => a.page - b.page);
  if (pages.length !== value.pageCount || pages.some((page, i) => page.page !== i + 1 || typeof page.text !== 'string')) throw new Error('invalid page sequence');
  const rewrittenPages = pages.map(page => ({ ...page, text: rewriteArchiveReferences(page.text, [], paths).fullMarkdown }));
  files.push(textFile(`${root}/paper.md`, paper), textFile(`${root}/pages.md`, renderPages(rewrittenPages)), renderFile(`${root}/source.pdf`, source.pdfContents));
  return files.sort((a, b) => compareText(a.path, b.path));
}
