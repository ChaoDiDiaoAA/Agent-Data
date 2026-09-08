import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { candidateFromContent, discoveryScope, fetchScope, type DiscoveryInput, type FetchInput, type SourceDiscoveryAdapter } from './types.ts';
import type { CitationLocator, FetchedSource, ResearchCandidate } from '../../types/research-sources.ts';
import { createHttpClient, ResearchAdapterError, type ResearchHttpClient } from '../http-client.ts';
import { sha256 } from '../source-identity.ts';
import { canonicalJson } from '../../shared/manifest.ts';

const voidTags = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];
const textBytes = (text: string) => new TextEncoder().encode(text);
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
const escapeMarkdown = (text: string) => text.replace(/([\\`*_[\]<>])/g, '\\$1');

/** Strict subset of HTML: malformed or implicitly closed markup fails closed. No DOM code executes. */
export async function normalizeHtml(bytes: Uint8Array, url: string) {
  let html: string;
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ResearchAdapterError('RESEARCH_HTML_INVALID'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(html) || !/<html(?:\s|>)/i.test(html) || !/<body(?:\s|>)/i.test(html)
    || /<!ENTITY/i.test(html) || XMLValidator.validate(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ''), { allowBooleanAttributes: true, unpairedTags: voidTags }) !== true) {
    throw new ResearchAdapterError('RESEARCH_HTML_INVALID');
  }
  let title = ''; let output = ''; let hidden = 0; let inTitle = false;
  const locators: CitationLocator[] = [];
  const headings: { marker: string; text: string; fragment?: string }[] = [];
  let heading: typeof headings[number] | undefined;
  const anchors: string[] = [];
  const namedAnchors: string[] = [];
  const seenNamedAnchors = new Set<string>();
  let pendingText = '';
  const entityParser = new XMLParser({ htmlEntities: true, parseTagValue: false, trimValues: false });
  const rewriter = new HTMLRewriter().on('*', {
    element(element) {
      const tag = element.tagName;
      if (['script', 'style', 'template', 'noscript'].includes(tag)) {
        hidden++; element.onEndTag(() => { hidden--; }); return;
      }
      if (hidden) return;
      if (tag === 'title') { inTitle = true; element.onEndTag(() => { inTitle = false; }); }
      if (/^h[1-6]$/.test(tag)) {
        const item = { marker: `HEADING${headings.length}TOKEN`, text: '', fragment: element.getAttribute('id') ?? undefined };
        headings.push(item); heading = item; output += `\n\n${item.marker}${'#'.repeat(Number(tag[1]))} `;
        element.onEndTag(() => { heading = undefined; output += '\n\n'; });
      } else if (['p', 'div', 'section', 'article', 'pre', 'ul', 'ol', 'table', 'tr'].includes(tag)) {
        output += '\n\n'; element.onEndTag(() => { output += '\n\n'; });
      } else if (tag === 'br') output += '\n';
      else if (tag === 'li') { output += '\n- '; element.onEndTag(() => { output += '\n'; }); }
      if (tag === 'a') {
        for (const attribute of ['id', 'name']) {
          const fragment = element.getAttribute(attribute)?.trim();
          if (fragment && !/[\x00-\x20\x7f]/.test(fragment) && !seenNamedAnchors.has(fragment)) {
            seenNamedAnchors.add(fragment);
            namedAnchors.push(fragment);
          }
        }
        const href = element.getAttribute('href');
        let link = '';
        try { const resolved = new URL(href ?? '', url); if (href && ['https:', 'http:'].includes(resolved.protocol) && !resolved.username && !resolved.password) link = resolved.href; } catch {}
        anchors.push(link);
        if (link) output += '[';
        element.onEndTag(() => { const target = anchors.pop(); if (target) {
          output += `](${target.replace(/[()]/g, ch => ch === '(' ? '%28' : '%29')})`;
          locators.push({ artifactPath: 'content.html', section: target, ...(new URL(target).hash ? { fragment: new URL(target).hash.slice(1) } : {}) });
        } });
      }
    },
    text(chunk) {
      if (hidden) return;
      pendingText += chunk.text;
      if (!chunk.lastInTextNode) return;
      const text: string = entityParser.parse(`<text>${pendingText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text>`).text;
      pendingText = '';
      if (inTitle) { title += text; return; }
      if (heading) heading.text += text;
      output += escapeMarkdown(text.replace(/\s+/g, ' '));
    },
  });
  try { await rewriter.transform(new Response(html)).text(); } catch { throw new ResearchAdapterError('RESEARCH_HTML_INVALID'); }
  title = compact(title || headings[0]?.text || 'Document');
  output = `# ${escapeMarkdown(title)}\n\n${output.trim()}`;
  output = output.split('\n').map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  for (const item of headings) {
    const line = output.slice(0, output.indexOf(item.marker)).split('\n').length;
    locators.push({ artifactPath: 'content.md', section: compact(item.text), ...(item.fragment ? { fragment: item.fragment } : {}), startLine: line, endLine: line });
    output = output.replace(item.marker, '');
  }
  for (const fragment of namedAnchors) {
    locators.push({ artifactPath: 'content.html', section: fragment, fragment });
    locators.push({ artifactPath: 'content.md', section: fragment, fragment });
  }
  locators.unshift({ artifactPath: 'content.md', section: title, startLine: 1, endLine: 1 });
  return { title, markdown: output, locators };
}

export class OfficialDocAdapter implements SourceDiscoveryAdapter {
  readonly id = 'official-doc';
  readonly kinds = ['official-doc', 'specification', 'evaluation-method'] as const;
  private readonly http: ResearchHttpClient;
  private readonly now: () => string;
  constructor(options: { http?: ResearchHttpClient; now?: () => string } = {}) { this.http = options.http ?? createHttpClient(); this.now = options.now ?? (() => new Date().toISOString()); }
  private async capture(input: DiscoveryInput, target: NonNullable<DiscoveryInput['targets']>[number]) {
    if (!this.kinds.some(kind => kind === target.kind)) throw new ResearchAdapterError('RESEARCH_POLICY_REJECTED');
    const scope = discoveryScope(input, target.kind);
    const response = await this.http.get(target.url, scope);
    const type = response.headers.get('content-type') ?? '';
    if (!/^text\/html(?:\s*;|$)/i.test(type) || (/charset=/i.test(type) && !/charset\s*=\s*"?utf-8"?(?:\s*;|$)/i.test(type))) throw new ResearchAdapterError('RESEARCH_HTML_INVALID');
    const normalized = await normalizeHtml(response.bytes, response.url);
    const retrievedAt = this.now();
    const metadata = { url: response.url, status: response.status, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), retrievedAt, rawSha256: sha256(response.bytes) };
    const updatedAt = metadata.lastModified && Number.isFinite(Date.parse(metadata.lastModified)) ? new Date(metadata.lastModified).toISOString() : null;
    const candidate = candidateFromContent(input, { kind: target.kind, url: target.url, title: normalized.title, content: normalized.markdown,
      retrievedAt, adapter: this.id, revision: target.revision, updatedAt, notes: [`raw-sha256:${metadata.rawSha256}`, `final-url:${response.url}`] });
    const fetched: FetchedSource = { source: candidate.source, version: candidate.version,
      files: [{ path: 'content.html', contents: response.bytes }, { path: 'content.md', contents: textBytes(normalized.markdown) }, { path: 'metadata/http.json', contents: textBytes(canonicalJson(metadata)) }], locators: normalized.locators };
    return { candidate, fetched };
  }
  async discover(input: DiscoveryInput): Promise<readonly ResearchCandidate[]> {
    const result: ResearchCandidate[] = [];
    for (const target of input.targets ?? []) { const { candidate } = await this.capture(input, target); if (candidate.dateMatches.length) result.push(candidate); }
    return result;
  }
  async fetch(input: FetchInput): Promise<FetchedSource> {
    const scope = fetchScope(input, this);
    const candidate = input.candidate;
    const { fetched } = await this.capture(scope, { kind: candidate.source.kind, url: candidate.source.canonicalUrl,
      ...(candidate.version.versionId.startsWith('content-') ? {} : { revision: candidate.version.versionId }) });
    const stableCapture = (value: Pick<FetchedSource, 'source' | 'version'>) => {
      const { retrievedAt: _retrievedAt, ...version } = value.version;
      return canonicalJson({ source: value.source, version });
    };
    if (stableCapture(fetched) !== stableCapture(candidate)) throw new ResearchAdapterError('RESEARCH_SOURCE_CHANGED');
    return { ...fetched, source: candidate.source, version: candidate.version };
  }
}
