import { discoverArchiveAssetPaths } from '../shared/archive-references.ts';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { StateStore } from '../library/state/state-store.ts';
import { validateArchiveSource, validateLocalArchiveSource, type ArchiveSourceV1, type LocalArchiveSourceV1 } from './contracts.ts';
import { canonicalJson, hashCanonical, normalizeArchivePath } from '../shared/manifest.ts';
import { verifyArchiveV2 } from '../shared/archive-v2.ts';
import type { LibraryPaths } from '../shared/paths.ts';
import type { LibraryId } from '../shared/identity.ts';
import type { EvidenceSourceV2 } from './contracts.ts';

type ArchiveSource = ArchiveSourceV1 | LocalArchiveSourceV1;
type UnknownRecord = Record<string, unknown>;
type BufferedArchiveFile = {
  absolute: string;
  bytes: Uint8Array;
  path: string;
  sha256: string;
  byteLength: number;
};

export interface VerifiedArchiveSource {
  source: ArchiveSource | EvidenceSourceV2;
  archiveRoot: string;
  archiveManifestSha256: string;
  fullMarkdown: string;
  pages: { page: number; text: string }[];
  contentList: unknown[];
  assets: { sourcePath: string; relativePath: string; sha256: string; bytes: number; contents: Uint8Array }[];
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const isRecord = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be non-empty text`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

async function directory(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a link or reparse point`);
  return await realpath(path);
}

async function realDescendant(root: string, candidate: string, label: string): Promise<string> {
  const lexical = resolve(candidate);
  if (!isInside(root, lexical)) throw new Error(`${label} escapes its root`);
  let current = root;
  for (const segment of relative(root, lexical).split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`${label} must not traverse a link or reparse point`);
  }
  const actual = await realpath(lexical);
  if (!isInside(root, actual)) throw new Error(`${label} escapes its root`);
  return actual;
}

async function descendantDirectory(root: string, candidate: string, label: string): Promise<string> {
  const actual = await realDescendant(root, candidate, label);
  const info = await lstat(actual);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a link or reparse point`);
  return actual;
}

async function file(root: string, path: string, label: string): Promise<{ absolute: string; bytes: Uint8Array }> {
  const safePath = normalizeArchivePath(path);
  const candidate = resolve(root, ...safePath.split('/'));
  const actual = await realDescendant(root, candidate, label);
  const info = await lstat(actual);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real file, not a link or reparse point`);
  return { absolute: actual, bytes: await readFile(actual) };
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error(`${label} must contain valid JSON`); }
}

function parseSource(bytes: Uint8Array): ArchiveSource {
  const input = parseJson(bytes, 'source.json');
  const source = isRecord(input) && input.sourceKind === 'local_pdf'
    ? validateLocalArchiveSource(input)
    : validateArchiveSource(input);
  if (Buffer.from(bytes).toString('utf8') !== canonicalJson(source)) throw new Error('source.json must use canonical frozen JSON bytes');
  return source;
}

function assertManifest(source: ArchiveSource, actual: { path: string; sha256: string; bytes: number }[]): void {
  if (source.files.length !== actual.length) throw new Error('Archive file manifest does not match frozen source.json');
  for (let index = 0; index < source.files.length; index++) {
    const expected = source.files[index], found = actual[index];
    if (!found || expected.path !== found.path || expected.sha256 !== found.sha256 || expected.bytes !== found.bytes) {
      throw new Error(`Archive file manifest hash mismatch at ${expected.path}`);
    }
  }
  const pdf = source.files.find(entry => entry.path === source.pdfPath);
  if (!pdf || pdf.sha256 !== source.pdfSha256) throw new Error('frozen PDF is missing or its hash differs from source.json');
}

async function readArchiveSnapshot(root: string): Promise<Map<string, BufferedArchiveFile>> {
  const snapshot = new Map<string, BufferedArchiveFile>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Archive snapshot refuses links or reparse points');
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) throw new Error('Archive snapshot refuses non-file entries');
    const path = normalizeArchivePath(relative(root, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/'));
    if (path === 'source.json') continue;
    if (snapshot.has(path)) throw new Error(`Archive snapshot contains a duplicate path: ${path}`);
    const captured = await file(root, path, `Archive file ${path}`);
    snapshot.set(path, {
      ...captured,
      path,
      sha256: sha256(captured.bytes),
      byteLength: captured.bytes.byteLength,
    });
  }
  return snapshot;
}

function bufferedFile(snapshot: Map<string, BufferedArchiveFile>, path: string, label: string): BufferedArchiveFile {
  const captured = snapshot.get(path);
  if (!captured) throw new Error(`${label} is missing from the verified Archive snapshot`);
  return captured;
}

function pages(value: unknown, count: number): { page: number; text: string }[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error('normalized pages must contain every page exactly once');
  const result = value.map((item, index) => {
    if (!isRecord(item)) throw new Error('normalized pages must be sequential page/text records');
    const page = item.page ?? item.pageNumber;
    if (page !== index + 1 || typeof item.text !== 'string') throw new Error('normalized pages must be sequential page/text records');
    return { page, text: item.text };
  });
  return result;
}

function assertJob(job: unknown): { baseId: string; version: number; sha256: string; model: string; method: 'auto' | 'txt' | 'ocr'; outputDir: string } {
  if (!isRecord(job)) throw new Error('run manifest job must be an object');
  const method = 'method' in job ? job.method : 'auto';
  if (method !== 'auto' && method !== 'txt' && method !== 'ocr') throw new Error('run manifest method is invalid');
  return {
    baseId: requireText(job.baseId, 'run manifest baseId'),
    version: requirePositiveInteger(job.version, 'run manifest version'),
    sha256: requireText(job.sha256, 'run manifest SHA-256'),
    model: requireText(job.model, 'run manifest model'),
    method,
    outputDir: requireText(job.outputDir, 'run manifest outputDir'),
  };
}

function assertSourceMatchesParse(source: ArchiveSource | EvidenceSourceV2, job: ReturnType<typeof assertJob>, parse: UnknownRecord): void {
  for (const [name, sourceValue, jobValue] of [
    ['baseId', source.baseId, job.baseId], ['version', source.version, job.version], ['pdfSha256', source.pdfSha256, job.sha256],
    ['model', source.model, job.model], ['method', source.method, job.method],
  ] as const) if (sourceValue !== jobValue) throw new Error(`frozen source ${name} differs from run manifest`);
  for (const [name, expected] of [
    ['attemptId', source.parseAttemptId], ['baseId', source.baseId], ['version', source.version], ['sha256', source.pdfSha256],
    ['model', source.model], ['method', source.method], ['cliBackend', source.cliBackend], ['pageCount', source.pageCount],
  ] as const) if (parse[name] !== expected) throw new Error(`selected parse ${name} differs from frozen source.json`);
}

function assertFrozenMetadata(source: Pick<ArchiveSourceV1, 'baseId' | 'arxivId' | 'version' | 'title' | 'published' | 'updated' | 'authors' | 'categories'>, metadata: unknown): void {
  if (!isRecord(metadata)) throw new Error('frozen source metadata is missing');
  for (const key of ['baseId', 'arxivId', 'version', 'title', 'published', 'updated'] as const) {
    if (metadata[key] !== source[key]) throw new Error(`frozen source metadata ${key} differs from source.json`);
  }
  for (const key of ['authors', 'categories'] as const) {
    if (!Array.isArray(metadata[key]) || JSON.stringify(metadata[key]) !== JSON.stringify(source[key])) {
      throw new Error(`frozen source metadata ${key} differs from source.json`);
    }
  }
}

export async function readVerifiedRunSources(input: {
  runId: string;
  stateRoot: string;
  paths?: LibraryPaths;
  libraryId?: LibraryId;
  /**
   * `state` authenticates against the mutable discovery metadata row and is
   * appropriate for an active run. `archive` trusts the already-frozen
   * Archive source.json for historical runs; the row may have been refreshed
   * by a later arXiv observation for the same version.
   */
  sourceMetadata?: 'state' | 'archive';
  store: Pick<StateStore, 'findSuccessfulParse' | 'findSourceMetadata'>;
}): Promise<VerifiedArchiveSource[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.runId)) throw new Error('run manifest path must be a safe run ID');
  const stateRoot = await directory(input.stateRoot, 'stateRoot');
  const runRoot = await descendantDirectory(stateRoot, join(stateRoot, 'runs', input.runId), 'run manifest root');
  const manifestFile = await file(runRoot, 'mineru-jobs.json', 'run manifest');
  const manifest = parseJson(manifestFile.bytes, 'run manifest');
  if (!isRecord(manifest) || manifest.runId !== input.runId || !Array.isArray(manifest.jobs)) throw new Error('run manifest must contain its frozen run ID and jobs');

  const verified: VerifiedArchiveSource[] = [];
  for (const rawJob of manifest.jobs) {
    const job = assertJob(rawJob);
    const configuredArchive = resolve(job.outputDir);
    if (isInside(resolve(stateRoot, 'archive'), configuredArchive)) {
      const expected = resolve(stateRoot, 'archive', `${job.baseId}-v${job.version}`);
      if (configuredArchive !== expected || (input.paths && resolve(input.paths.dataRoot) !== stateRoot)) throw new Error('Archive v2 path identity mismatch');
      const v2 = await verifyArchiveV2(configuredArchive);
      if (input.libraryId && v2.manifest.libraryId !== input.libraryId) throw new Error('Archive libraryId mismatch');
      const { manifest: m, source: metadata } = v2;
      const shared = { schemaVersion: 2 as const, baseId: m.baseId, version: m.version, title: metadata.title,
        pdfPath: 'source.pdf', pdfSha256: m.pdfSha256, parseAttemptId: metadata.parseAttemptId,
        model: m.parser.model, cliBackend: m.parser.model === 'pipeline' ? 'pipeline' as const : 'vlm-engine' as const,
        method: m.parser.method, pageCount: metadata.pageCount, files: m.files };
      const source: EvidenceSourceV2 = m.sourceKind === 'local_pdf'
        ? { ...shared, sourceKind: 'local_pdf', parserConfigKey: metadata.parserConfigKey! }
        : { ...shared, arxivId: metadata.arxivId!, authors: metadata.authors, categories: metadata.categories,
          matchedTracks: metadata.matchedTracks, published: metadata.published!, updated: metadata.updated! };
      const parse = await input.store.findSuccessfulParse({ baseId: job.baseId, version: job.version, sha256: job.sha256, model: job.model, method: job.method }) as unknown;
      if (!isRecord(parse) || typeof parse.outputDir !== 'string' || resolve(parse.outputDir) !== expected) throw new Error('selected successful parse root differs');
      assertSourceMatchesParse(source, job, parse);
      if (input.sourceMetadata !== 'archive' && !('sourceKind' in source)) {
        assertFrozenMetadata(source, await input.store.findSourceMetadata(source.baseId, source.version));
      }
      const assets = m.files.filter(entry => entry.path.startsWith('assets/')).map(entry => ({
        sourcePath: join(v2.root, entry.path), relativePath: entry.path, sha256: entry.sha256, bytes: entry.bytes,
        contents: new Uint8Array(v2.payloads.get(entry.path)!),
      }));
      verified.push({ source, archiveRoot: v2.root, archiveManifestSha256: hashCanonical(m),
        fullMarkdown: v2.fullMarkdown, pages: v2.pages, contentList: v2.contentList, assets });
      continue;
    }
    const extractedRoot = await descendantDirectory(stateRoot, join(stateRoot, 'extracted'), 'stateRoot/extracted');
    const archiveRoot = await descendantDirectory(extractedRoot, configuredArchive, 'run manifest Archive root');
    const parse = await input.store.findSuccessfulParse({ baseId: job.baseId, version: job.version, sha256: job.sha256, model: job.model, method: job.method }) as unknown;
    if (!isRecord(parse)) throw new Error('selected successful parse is missing');
    if (typeof parse.outputDir !== 'string' || await realDescendant(extractedRoot, parse.outputDir, 'selected parse Archive root') !== archiveRoot) throw new Error('selected parse Archive root differs from run manifest');

    const sourceFile = await file(archiveRoot, 'source.json', 'source.json');
    const source = parseSource(sourceFile.bytes);
    assertSourceMatchesParse(source, job, parse);
    if (input.sourceMetadata !== 'archive' && !('sourceKind' in source)) {
      assertFrozenMetadata(source, await input.store.findSourceMetadata(source.baseId, source.version));
    }

    const snapshot = await readArchiveSnapshot(archiveRoot);
    const actualManifest = [...snapshot.values()]
      .map(entry => ({ path: entry.path, sha256: entry.sha256, bytes: entry.byteLength }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    assertManifest(source, actualManifest);
    const normalized = [
      bufferedFile(snapshot, source.normalized.fullMarkdown, 'normalized Markdown'),
      bufferedFile(snapshot, source.normalized.pages, 'normalized pages'),
      bufferedFile(snapshot, source.normalized.contentList, 'normalized content list'),
    ];
    const fullMarkdown = Buffer.from(normalized[0].bytes).toString('utf8');
    const pageRecords = pages(parseJson(normalized[1].bytes, 'normalized pages'), source.pageCount);
    const contentList = parseJson(normalized[2].bytes, 'normalized content list');
    if (!Array.isArray(contentList)) throw new Error('normalized content list must be an array');
    const requiredAssets = new Set(discoverArchiveAssetPaths(fullMarkdown, contentList));
    const entries = new Map(source.files.map(entry => [entry.path, entry]));
    const assets = await Promise.all([...requiredAssets].sort().map(async relativePath => {
      const legacyPath = 'sourceKind' in source ? undefined : `${source.arxivId}/${source.method}/${relativePath}`;
      const entry = entries.get(relativePath) ?? (legacyPath ? entries.get(legacyPath) : undefined);
      if (!entry) throw new Error(`referenced asset is absent from Archive manifest: ${relativePath}`);
      const asset = bufferedFile(snapshot, entry.path, 'referenced asset');
      if (asset.byteLength !== entry.bytes || asset.sha256 !== entry.sha256) throw new Error(`referenced asset hash mismatch: ${relativePath}`);
      return {
        sourcePath: asset.absolute,
        relativePath,
        sha256: entry.sha256,
        bytes: entry.bytes,
        contents: new Uint8Array(asset.bytes),
      };
    }));
    verified.push({ source, archiveRoot, archiveManifestSha256: hashCanonical(source.files), fullMarkdown, pages: pageRecords, contentList, assets });
  }
  return verified;
}
