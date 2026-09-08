import type { FetchedSource } from '../types/research-sources.ts';
import { canonicalJson } from '../shared/manifest.ts';
import { sha256 } from './source-identity.ts';
import { normalizeSourceVersion } from './source-normalizer.ts';

/** Generic MinerU seam. The caller owns the existing MinerU session and its lifecycle. */
export interface ResearchMineruBoundary {
  parse(input: { pdf: Uint8Array; pdfSha256: string; sourceId: string; versionId: string; signal?: AbortSignal }): Promise<{
    markdown: string;
    pages: readonly { page: number; startLine: number; endLine: number }[];
  }>;
}

export async function parseResearchSource(fetched: FetchedSource, options: {
  requireFullText: boolean; mineru?: ResearchMineruBoundary; signal?: AbortSignal;
}): Promise<FetchedSource> {
  if (!['paper', 'technical-report'].includes(fetched.source.kind) || !options.requireFullText) return fetched;
  options.signal?.throwIfAborted();
  if (!options.mineru) throw new Error('RESEARCH_MINERU_REQUIRED');
  normalizeSourceVersion(fetched.source, fetched.version);
  const pdfs = fetched.files.filter(file => file.path === 'source.pdf');
  if (pdfs.length !== 1 || Buffer.from(pdfs[0].contents.subarray(0, 5)).toString() !== '%PDF-') throw new Error('RESEARCH_PDF_INVALID');
  const pdf = new Uint8Array(pdfs[0].contents), pdfSha256 = sha256(pdf);
  const parsed = await options.mineru.parse({ pdf: new Uint8Array(pdf), pdfSha256,
    sourceId: fetched.source.sourceId, versionId: fetched.version.versionId, signal: options.signal });
  options.signal?.throwIfAborted();
  if (typeof parsed.markdown !== 'string' || !parsed.markdown.trim() || !Array.isArray(parsed.pages) || !parsed.pages.length)
    throw new Error('RESEARCH_PARSE_INVALID');
  const markdown = parsed.markdown.replace(/\r\n?/g, '\n'), lines = markdown.split('\n').length;
  const pages = [...parsed.pages].sort((a, b) => a.page - b.page);
  if (pages.some((p, index) => !Number.isSafeInteger(p.page) || p.page < 1 || pages[index - 1]?.page === p.page
    || !Number.isSafeInteger(p.startLine) || !Number.isSafeInteger(p.endLine)
    || p.startLine < 1 || p.endLine < p.startLine || p.endLine > lines)) throw new Error('RESEARCH_PARSE_INVALID');
  const content = fetched.files.filter(file => /^content\.(md|txt)$/.test(file.path));
  if (content.length !== 1 || sha256(content[0].contents) !== fetched.version.contentSha256) throw new Error('RESEARCH_SOURCE_CHANGED');
  const version = { ...fetched.version, contentSha256: sha256(markdown) };
  normalizeSourceVersion(fetched.source, version);
  return { source: fetched.source, version,
    files: [
      ...fetched.files.filter(file => !/^content\.(md|txt)$/.test(file.path) && file.path !== 'source.pdf'
        && !['metadata/pdf.json', 'metadata/discovery.json'].includes(file.path)),
      { path: 'source.pdf', contents: pdf }, { path: 'content.md', contents: Buffer.from(markdown) },
      { path: 'metadata/pdf.json', contents: Buffer.from(canonicalJson({ pdfSha256, pages })) },
      { path: 'metadata/discovery.json', contents: Buffer.from(canonicalJson({ contentSha256: fetched.version.contentSha256,
        artifactPath: content[0].path, content: Buffer.from(content[0].contents).toString('utf8') })) },
    ],
    locators: pages.flatMap(page => [{ artifactPath: 'source.pdf', page: page.page },
      { artifactPath: 'content.md', page: page.page, startLine: page.startLine, endLine: page.endLine }]),
  };
}
