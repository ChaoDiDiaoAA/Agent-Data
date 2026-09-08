import { readFile, writeFile, rename, mkdtemp, rm, lstat } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import type { FetchedSource, ResearchSource, ResearchSourceKind, SourceVersion } from '../types/research-sources.ts';
import { archiveFileManifest, canonicalJson, type ArchiveManifestEntry } from '../shared/manifest.ts';
import { safeMkdir } from '../mineru/archive-writer.ts';
import { normalizeSourceVersion, sourceDate } from './source-normalizer.ts';
import { archivePath as safeArchivePath, assertRealPath, realTree, pathIdentity } from '../shared/archive-v2.ts';
import { sha256 } from './source-identity.ts';
import { assertLibraryId } from '../shared/identity.ts';

export interface ResearchArchiveManifest {
  schemaVersion: 1; libraryId: string; sourceId: string; sourceKind: ResearchSourceKind;
  versionId: string; identityKey: string; canonicalUrl: string; contentSha256: string;
  source: ResearchSource; version: SourceVersion; files: ArchiveManifestEntry[]; createdAt: string;
}
export interface ResearchArchiveExpected { libraryId?: string; sourceId?: string; versionId?: string }
function payloadPath(path: string): string {
  safeArchivePath(path);
  if (!['content.md', 'content.txt', 'content.html', 'source.pdf'].includes(path) && !/^metadata\/[A-Za-z0-9._-]+\.json$/.test(path)) throw new Error('RESEARCH_ARCHIVE_INVALID: unsupported payload path');
  return path;
}
function normalizeContent(contents: Uint8Array): Uint8Array {
  return Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(contents).replace(/\r\n?/g, '\n'));
}
async function readMatchingResearchArchive(archivePath: string, manifest: ResearchArchiveManifest): Promise<{ archivePath: string; manifest: ResearchArchiveManifest }> {
  const existing = await readVerifiedResearchArchive(archivePath);
  if (canonicalJson(existing.manifest) !== canonicalJson(manifest)) throw new Error('RESEARCH_ARCHIVE_CONFLICT: existing version differs');
  return { archivePath, manifest: existing.manifest };
}
export async function writeResearchArchive(input: { root: string; libraryId: string; fetched: FetchedSource }): Promise<{ archivePath: string; manifest: ResearchArchiveManifest }> {
  assertLibraryId(input.libraryId);
  const { source, version } = normalizeSourceVersion(input.fetched.source, input.fetched.version);
  const seen = new Set<string>();
  const payloads = input.fetched.files.map(file => {
    const path = payloadPath(file.path);
    if (seen.has(path.toLowerCase())) throw new Error('RESEARCH_ARCHIVE_INVALID: duplicate payload');
    seen.add(path.toLowerCase());
    return { path, contents: /^content\.(md|txt)$/.test(path) ? normalizeContent(file.contents) : file.contents };
  });
  const content = payloads.filter(f => /^content\.(md|txt)$/.test(f.path));
  if (content.length !== 1 || !content[0].contents.byteLength || sha256(content[0].contents) !== version.contentSha256) throw new Error('RESEARCH_ARCHIVE_INVALID: missing content or content hash mismatch');
  const archivePath = resolve(input.root, 'archive', 'sources', source.kind, source.sourceId, version.versionId);
  version.archivePath = relative(resolve(input.root), archivePath).replaceAll('\\', '/');
  await safeMkdir(dirname(archivePath));
  const staging = await mkdtemp(join(dirname(archivePath), '.staging-'));
  try {
    for (const file of payloads) {
      await safeMkdir(dirname(join(staging, file.path)));
      await writeFile(join(staging, file.path), file.contents);
    }
    await writeFile(join(staging, 'metadata.json'), canonicalJson({ source, version, locators: input.fetched.locators }));
    const manifest: ResearchArchiveManifest = { schemaVersion: 1, libraryId: input.libraryId, sourceId: source.sourceId, sourceKind: source.kind,
      versionId: version.versionId, identityKey: source.identityKey, canonicalUrl: source.canonicalUrl, contentSha256: version.contentSha256,
      source, version, files: await archiveFileManifest(staging), createdAt: version.retrievedAt };
    await writeFile(join(staging, 'source.json'), canonicalJson(manifest));
    if (await lstat(archivePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
      return readMatchingResearchArchive(archivePath, manifest);
    }
    try { await rename(staging, archivePath); }
    catch (renameError) {
      const installed = await lstat(archivePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!installed) throw renameError;
      return readMatchingResearchArchive(archivePath, manifest);
    }
    return { archivePath, manifest };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export async function readVerifiedResearchArchive(path: string, _expected?: ResearchArchiveExpected): Promise<{ manifest: ResearchArchiveManifest; files: Map<string, Uint8Array> }> {
  const initialIdentity = await pathIdentity(path);
  await realTree(path);
  await assertRealPath(join(path, 'source.json'));
  const raw = await readFile(join(path, 'source.json'), 'utf8');
  const manifest: ResearchArchiveManifest = JSON.parse(raw);
  if (!manifest || manifest.schemaVersion !== 1 || raw !== canonicalJson(manifest) || Object.keys(manifest).sort().join() !== ['schemaVersion', 'libraryId', 'sourceId', 'sourceKind', 'versionId', 'identityKey', 'canonicalUrl', 'contentSha256', 'source', 'version', 'files', 'createdAt'].sort().join()) throw new Error('RESEARCH_ARCHIVE_INVALID: manifest schema or canonical bytes');
  assertLibraryId(manifest.libraryId); sourceDate(manifest.createdAt);
  const normalized = normalizeSourceVersion(manifest.source, manifest.version);
  if (canonicalJson(normalized) !== canonicalJson({ source: manifest.source, version: manifest.version })) throw new Error('RESEARCH_ARCHIVE_INVALID: non-normalized metadata');
  const { source, version } = normalized;
  const packagePath = `archive/sources/${source.kind}/${source.sourceId}/${version.versionId}`;
  if (manifest.sourceId !== source.sourceId || manifest.sourceKind !== source.kind || manifest.versionId !== version.versionId || manifest.identityKey !== source.identityKey || manifest.canonicalUrl !== source.canonicalUrl || manifest.contentSha256 !== version.contentSha256 || version.archivePath !== packagePath || !resolve(path).replaceAll('\\', '/').endsWith('/' + packagePath)) throw new Error('RESEARCH_ARCHIVE_INVALID: cross-identity manifest');
  for (const key of ['libraryId', 'sourceId', 'versionId'] as const) if (_expected?.[key] !== undefined && _expected[key] !== manifest[key]) throw new Error('RESEARCH_ARCHIVE_INVALID: expected identity mismatch');
  if (!Array.isArray(manifest.files)) throw new Error('RESEARCH_ARCHIVE_INVALID: missing files');
  const inventory = await archiveFileManifest(path);
  if (canonicalJson(inventory) !== canonicalJson(manifest.files)) throw new Error('RESEARCH_ARCHIVE_INVALID: file manifest hash mismatch');
  const files = new Map<string, Uint8Array>();
  for (const entry of inventory) {
    if (entry.path !== 'metadata.json') payloadPath(entry.path);
    await assertRealPath(join(path, entry.path));
    const bytes = await readFile(join(path, entry.path));
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error('RESEARCH_ARCHIVE_INVALID: file changed during read');
    files.set(entry.path, bytes);
  }
  const contents = [...files].filter(([name]) => /^content\.(md|txt)$/.test(name));
  if (contents.length !== 1 || !contents[0][1].length || sha256(contents[0][1]) !== version.contentSha256 || sha256(normalizeContent(contents[0][1])) !== version.contentSha256) throw new Error('RESEARCH_ARCHIVE_INVALID: missing content or hash mismatch');
  const metadataBytes = files.get('metadata.json');
  if (!metadataBytes) throw new Error('RESEARCH_ARCHIVE_INVALID: missing metadata');
  const metadata = JSON.parse(Buffer.from(metadataBytes).toString('utf8'));
  if (canonicalJson(metadata) !== Buffer.from(metadataBytes).toString('utf8') || canonicalJson({ source: metadata.source, version: metadata.version }) !== canonicalJson(normalized) || !Array.isArray(metadata.locators)) throw new Error('RESEARCH_ARCHIVE_INVALID: metadata binding mismatch');
  if (await pathIdentity(path) !== initialIdentity || await readFile(join(path, 'source.json'), 'utf8') !== raw) throw new Error('RESEARCH_ARCHIVE_INVALID: archive changed during verification');
  return { manifest, files };
}
