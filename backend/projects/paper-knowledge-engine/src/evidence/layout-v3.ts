import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { archivePath, assertRealPath, verifyArchiveV2, type VerifiedArchiveV2 } from '../shared/archive-v2.ts';
import type { VerifiedArchiveSource } from './archive-reader.ts';
import { hashCanonical } from '../shared/manifest.ts';
import { renderPaperEvidenceV3, type RenderedFile } from './render-paper.ts';
import { renderEvidenceIndexesV3 } from './render-indexes.ts';
import { evidencePaperRoot, type BufferedEvidenceSource, type EvidenceInput, type EvidenceFile } from './layout-paths.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function bufferArchiveV2(archive: VerifiedArchiveV2): BufferedEvidenceSource {
  const m = archive.manifest, metadata = archive.source;
  for (const entry of m.files) {
    const bytes = archive.payloads.get(entry.path);
    if (!bytes || bytes.byteLength !== entry.bytes || hash(bytes) !== entry.sha256) {
      throw new Error(`verified Archive payload missing or changed: ${entry.path}`);
    }
  }
  const pdfContents = archive.payloads.get('source.pdf');
  if (!pdfContents || hash(pdfContents) !== m.pdfSha256) throw new Error('verified Archive PDF missing or changed');
  const shared = { schemaVersion: 2 as const, baseId: m.baseId, version: m.version,
    title: metadata.title, authors: metadata.authors, categories: metadata.categories, matchedTracks: metadata.matchedTracks,
    pdfPath: 'source.pdf', pdfSha256: m.pdfSha256, parseAttemptId: metadata.parseAttemptId,
    model: m.parser.model, cliBackend: m.parser.model === 'pipeline' ? 'pipeline' as const : 'vlm-engine' as const,
    method: m.parser.method, pageCount: metadata.pageCount, files: m.files };
  const source = m.sourceKind === 'local_pdf'
    ? { ...shared, sourceKind: 'local_pdf' as const, parserConfigKey: metadata.parserConfigKey! }
    : { ...shared, arxivId: metadata.arxivId!, published: metadata.published!, updated: metadata.updated! };
  return { source, archiveRoot: archive.root, archiveManifestSha256: hashCanonical(m),
    pdfContents: new Uint8Array(pdfContents), fullMarkdown: archive.fullMarkdown, pages: archive.pages, contentList: archive.contentList,
    assets: m.files.filter(file => file.path.startsWith('assets/')).map(file => ({ sourcePath: file.path,
      relativePath: file.path, sha256: file.sha256, bytes: file.bytes, contents: new Uint8Array(archive.payloads.get(file.path)!) })) };
}

/** Buffer inputs before pure planning. Historical Archive reads do not write an old Vault layout. */
export async function prepareEvidenceSources(sources: readonly EvidenceInput[]): Promise<BufferedEvidenceSource[]> {
  return Promise.all(sources.map(async source => {
    if ('manifest' in source) return bufferArchiveV2(source);
    if ('pdfContents' in source) return source;
    if (source.source.schemaVersion === 2) {
      const buffered = bufferArchiveV2(await verifyArchiveV2(source.archiveRoot));
      if (buffered.archiveManifestSha256 !== source.archiveManifestSha256) throw new Error('Archive identity changed before publication');
      return buffered;
    }
    const path = resolve(source.archiveRoot, archivePath(source.source.pdfPath));
    await assertRealPath(path);
    const pdfContents = new Uint8Array(await readFile(path));
    const entry = source.source.files.find(file => file.path === source.source.pdfPath);
    if (!entry || entry.bytes !== pdfContents.byteLength || entry.sha256 !== hash(pdfContents)
      || source.source.pdfSha256 !== hash(pdfContents)) throw new Error('verified Archive PDF missing or changed');
    return { ...source, pdfContents };
  }));
}

export function renderBufferedEvidenceV3(sources: readonly BufferedEvidenceSource[]): EvidenceFile[] {
  const papers = new Map<string, EvidenceFile[]>();
  for (const source of sources) {
    const root = evidencePaperRoot(source.source.baseId, source.source.version);
    const files = renderPaperEvidenceV3(source);
    const key = root.toLowerCase();
    const previous = papers.get(key);
    if (previous && hashCanonical(previous.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes.byteLength })))
      !== hashCanonical(files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes.byteLength })))) {
      throw new Error(`conflicting Evidence paper identity: ${root}`);
    }
    papers.set(key, files);
  }
  return [...papers.values()].flat().concat(renderEvidenceIndexesV3(sources)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Deterministic, filesystem-free v3 projection of verified Archive v2 packages. */
export function renderEvidenceV3(sources: VerifiedArchiveV2[]): EvidenceFile[] {
  return renderBufferedEvidenceV3(sources.map(bufferArchiveV2));
}
