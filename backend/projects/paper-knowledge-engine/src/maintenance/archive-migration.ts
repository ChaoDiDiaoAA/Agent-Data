import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '../shared/manifest.ts';
import { rewriteArchiveAssetReferences } from '../shared/archive-references.ts';
import { validateArchiveSource, validateLocalArchiveSource } from '../evidence/contracts.ts';
import { ARCHIVE_ARTIFACTS, archivePath, archiveReferences, assertRealPath, pathIdentity, realTree, rewriteArchiveReferences, validateArchiveSourceV2, validateFrozenSource, verifyArchiveV2, type ArchiveSourceV2, type FrozenSourceMetadata } from '../shared/archive-v2.ts';
import { safeMkdir } from '../mineru/archive-writer.ts';
import { assertLibraryId, type LibraryId } from '../shared/identity.ts';
import type { LibraryPaths } from '../shared/paths.ts';

export interface ArchiveMigrationInput {
  legacyArchiveRoot: string;
  paths: Pick<LibraryPaths, 'dataRoot' | 'archiveRoot' | 'workRoot'>;
  libraryId: LibraryId;
}
type FileEntry = { path: string; sha256: string; bytes: number };
type PrunedKind = 'mineru-intermediate' | 'duplicate-pdf' | 'duplicate-asset' | 'unreferenced-asset' | 'page-marked-text';
interface MigrationPaper {
  baseId: string;
  version: number;
  oldRoot: string;
  targetRoot: string;
  inputs: (FileEntry & { absolutePath: string })[];
  directories: string[];
  targetFiles: FileEntry[];
  pruned: { path: string; kind: PrunedKind; bytes: number }[];
  prunedKinds: PrunedKind[];
  inputBytes: number;
  targetBytes: number;
}
export interface ArchiveMigrationPlan extends ArchiveMigrationInput {
  schemaVersion: 1;
  /** SHA-256 of canonicalJson(all other fields); never a self-hash. */
  sha256: string;
  directories: string[];
  papers: MigrationPaper[];
}
export interface ArchiveMigrationResult {
  planSha256: string;
  migrated: number;
  replayed: boolean;
  prunedKinds: PrunedKind[];
}
interface ArchiveMigrationApplyInput extends ArchiveMigrationInput {
  planFile: string;
  planSha256: string;
  /** Same filesystem seam as ArchiveWriteInput: must perform an atomic rename. */
  install?: (staging: string, destination: string) => Promise<void>;
}
type PreparedPaper = { paper: MigrationPaper; payloads: Map<string, Uint8Array> };
const hash = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
const entry = (path: string, body: Uint8Array): FileEntry => ({ path, sha256: hash(body), bytes: body.length });
const fail = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };
const absent = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const info = (path: string) => lstat(path).catch(error => { if (absent(error)) return null; throw error; });

function absolute(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('MIGRATION_PATH_UNSAFE', 'absolute path required');
  archivePath(value.slice(parse(value).root.length).replaceAll('\\', '/'));
  return resolve(value);
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
/** Prospective paths are checked without creating their missing components. */
async function prospective(path: string): Promise<void> {
  const existing = await info(path);
  if (!existing) {
    const parent = dirname(path);
    if (parent === path) fail('MIGRATION_PATH_UNSAFE', 'missing filesystem root: ' + path);
    await prospective(parent); return;
  }
  await assertRealPath(path);
  if (!existing.isDirectory()) fail('MIGRATION_PATH_UNSAFE', 'expected directory: ' + path);
}
async function roots(input: ArchiveMigrationInput): Promise<ArchiveMigrationInput> {
  assertLibraryId(input.libraryId);
  const legacyArchiveRoot = absolute(input.legacyArchiveRoot);
  const paths = { dataRoot: absolute(input.paths.dataRoot), archiveRoot: absolute(input.paths.archiveRoot), workRoot: absolute(input.paths.workRoot) };
  if (paths.archiveRoot !== join(paths.dataRoot, 'archive') || paths.workRoot !== join(paths.dataRoot, 'work')) {
    fail('MIGRATION_PATH_UNSAFE', 'target roots must be derived LibraryPaths');
  }
  if (inside(legacyArchiveRoot, paths.dataRoot) || inside(paths.dataRoot, legacyArchiveRoot)) {
    fail('MIGRATION_PATH_UNSAFE', 'old and new roots overlap');
  }
  await assertRealPath(legacyArchiveRoot);
  for (const path of [paths.dataRoot, paths.archiveRoot, paths.workRoot]) await prospective(path);
  return { legacyArchiveRoot, paths, libraryId: input.libraryId };
}

async function readRegular(path: string): Promise<Buffer> {
  await assertRealPath(path);
  const before = await pathIdentity(path);
  if (!(await lstat(path)).isFile()) fail('MIGRATION_PATH_UNSAFE', 'expected regular file: ' + path);
  const body = await readFile(path);
  if (await pathIdentity(path) !== before) fail('MIGRATION_PLAN_DRIFT', 'input replaced while reading: ' + path);
  return body;
}

/** This is the only v1 adapter used by this command; it has no database or network fallback. */
async function preparePaper(input: ArchiveMigrationInput, oldRoot: string): Promise<PreparedPaper> {
  const tree = await realTree(oldRoot);
  const payloads = new Map<string, Uint8Array>();
  const inputs: MigrationPaper['inputs'] = [];
  const folded = new Set<string>();
  for (const path of tree) {
    const key = path.replace(/\/$/, '').toLowerCase();
    if (folded.has(key)) fail('MIGRATION_INVALID_SOURCE', 'case-colliding path');
    folded.add(key);
    if (path.endsWith('/')) continue;
    const absolutePath = join(oldRoot, path);
    const body = await readRegular(absolutePath);
    inputs.push({ ...entry(path, body), absolutePath });
    payloads.set(path, body);
  }
  if (canonicalJson(tree) !== canonicalJson(await realTree(oldRoot))) fail('MIGRATION_PLAN_DRIFT', 'source tree changed');
  const body = (path: string): Uint8Array => {
    archivePath(path);
    const value = payloads.get(path);
    if (!value) return fail('MIGRATION_INVALID_SOURCE', 'missing input: ' + path);
    return value;
  };
  const text = (path: string) => Buffer.from(body(path)).toString('utf8');
  const raw: unknown = JSON.parse(text('source.json'));
  const local = !!raw && typeof raw === 'object' && 'sourceKind' in raw && raw.sourceKind === 'local_pdf';
  const source = local ? validateLocalArchiveSource(raw) : validateArchiveSource(raw);
  archivePath(source.baseId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source.baseId)) fail('MIGRATION_INVALID_SOURCE', 'unsafe paper identity');
  const actual = inputs.filter(x => x.path !== 'source.json').map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
  if (canonicalJson(source.files) !== canonicalJson(actual)) fail('MIGRATION_INVALID_SOURCE', 'v1 manifest differs from complete inventory');
  if (!source.pdfPath.startsWith('pdf/') || hash(body(source.pdfPath)) !== source.pdfSha256) {
    fail('MIGRATION_INVALID_SOURCE', 'PDF identity differs');
  }
  const markdown = text(source.normalized.fullMarkdown);
  const content: unknown = JSON.parse(text(source.normalized.contentList));
  const pages: unknown = JSON.parse(text(source.normalized.pages));
  const referenceMap = new Map<string, string>([
    [source.pdfPath, 'source.pdf'], [source.normalized.fullMarkdown, 'document.md'],
    [source.normalized.pages, 'pages.json'], [source.normalized.contentList, 'content-list.json'],
  ]);
  const refs = [...new Set([...archiveReferences(markdown, content), ...archiveReferences('', pages, markdown)])].sort();
  const assetsByHash = new Map<string, string>();
  const destinationOwners = new Map<string, { destination: string; payload: Uint8Array }>();
  const destinationSpellings = new Map<string, string>();
  const output = new Map<string, Uint8Array>();
  const normalizedMarkdown = body(source.normalized.fullMarkdown);
  const rawMarkdownCandidates = inputs.filter(file => {
    if (file.path === source.normalized.fullMarkdown || !/\/(?:auto|txt|ocr|raw|pipeline|vlm)\/[^/]+\.md$/i.test(file.path)) return false;
    if (Buffer.from(body(file.path)).equals(Buffer.from(normalizedMarkdown))) return true;
    // Some v1 normalizers rewrote Markdown but left HTML in content-list tables
    // unchanged. Authenticate the document by replaying that exact path rewrite.
    const rawMarkdown = text(file.path);
    const aliases = new Map<string, string>();
    for (const ref of archiveReferences(rawMarkdown, [])) {
      if (!ref.startsWith('images/')) return false;
      const rawAsset = payloads.get(archivePath(posix.join(posix.dirname(file.path), ref)));
      const normalizedAsset = payloads.get(`assets/${ref}`);
      if (!rawAsset || !normalizedAsset || !Buffer.from(rawAsset).equals(Buffer.from(normalizedAsset))) return false;
      aliases.set(ref, `assets/${ref}`);
    }
    return rewriteArchiveAssetReferences(rawMarkdown, [], aliases).fullMarkdown === markdown;
  });
  const assetInput = (path: string): { inputPath: string; destination: string } => {
    archivePath(path);
    if (path.startsWith('assets/')) return { inputPath: path, destination: path };
    if (!path.startsWith('images/')) fail('MIGRATION_INVALID_SOURCE', 'unsupported local reference: ' + path);
    if (!rawMarkdownCandidates.length) fail('MIGRATION_INVALID_SOURCE', 'missing raw MinerU markdown counterpart for: ' + path);
    if (rawMarkdownCandidates.length !== 1) fail('MIGRATION_INVALID_SOURCE', 'ambiguous raw MinerU markdown counterpart for: ' + path);
    const inputPath = archivePath(posix.join(posix.dirname(rawMarkdownCandidates[0]!.path), path));
    return { inputPath, destination: archivePath(`assets/${path}`) };
  };
  for (const path of refs) {
    if (referenceMap.has(path) || path === 'source.json') { body(path); continue; }
    const resolved = assetInput(path);
    const payload = body(resolved.inputPath);
    const destinationKey = resolved.destination.toLowerCase();
    const owner = destinationOwners.get(destinationKey);
    if (owner && !Buffer.from(owner.payload).equals(Buffer.from(payload))) {
      fail('MIGRATION_INVALID_SOURCE', 'ambiguous asset destination: ' + resolved.destination);
    }
    for (const [ownedKey] of destinationOwners) {
      if (ownedKey.startsWith(`${destinationKey}/`) || destinationKey.startsWith(`${ownedKey}/`)) {
        fail('MIGRATION_INVALID_SOURCE', 'conflicting asset destination: ' + resolved.destination);
      }
    }
    const destinationParts = resolved.destination.split('/');
    for (let length = 1; length <= destinationParts.length; length++) {
      const spelling = destinationParts.slice(0, length).join('/');
      const spellingKey = spelling.toLowerCase();
      const existingSpelling = destinationSpellings.get(spellingKey);
      if (existingSpelling && existingSpelling !== spelling) {
        fail('MIGRATION_INVALID_SOURCE', 'inconsistent asset destination casing: ' + spelling);
      }
      destinationSpellings.set(spellingKey, spelling);
    }
    if (!owner) destinationOwners.set(destinationKey, { destination: resolved.destination, payload });
    const digest = hash(payload);
    const destination = assetsByHash.get(digest) ?? resolved.destination;
    assetsByHash.set(digest, destination);
    referenceMap.set(path, destination);
    const existing = output.get(destination);
    if (existing && !Buffer.from(existing).equals(Buffer.from(payload))) {
      fail('MIGRATION_INVALID_SOURCE', 'ambiguous asset destination: ' + destination);
    }
    output.set(destination, payload);
  }
  const rewritten = rewriteArchiveReferences(markdown, content, referenceMap);
  const metadata: FrozenSourceMetadata = 'arxivId' in source
    ? { title: source.title, authors: source.authors, categories: source.categories, matchedTracks: source.matchedTracks,
      arxivId: source.arxivId, published: source.published, updated: source.updated,
      parseAttemptId: source.parseAttemptId, pageCount: source.pageCount }
    : { title: source.title, authors: [], categories: [], matchedTracks: [], parserConfigKey: source.parserConfigKey,
      parseAttemptId: source.parseAttemptId, pageCount: source.pageCount };
  const sourceKind = local ? 'local_pdf' : 'arxiv';
  validateFrozenSource(metadata, sourceKind);
  output.set('source.json', Buffer.from(canonicalJson(metadata)));
  output.set('source.pdf', body(source.pdfPath));
  output.set('document.md', Buffer.from(rewritten.fullMarkdown));
  output.set('pages.json', Buffer.from(canonicalJson(rewriteArchiveReferences('', pages, referenceMap, markdown).contentList)));
  output.set('content-list.json', Buffer.from(canonicalJson(rewritten.contentList)));
  const manifest: ArchiveSourceV2 = { schemaVersion: 2, libraryId: input.libraryId, sourceKind,
    baseId: source.baseId, version: source.version, pdfSha256: source.pdfSha256,
    // v1 did not freeze the installed MinerU version. Never infer it from today's config.
    parser: { name: 'MinerU', version: 'unknown-v1', model: source.model, method: source.method },
    artifacts: ARCHIVE_ARTIFACTS, files: [...output.keys()].sort().map(path => entry(path, output.get(path)!)) };
  validateArchiveSourceV2(manifest);
  output.set('manifest.json', Buffer.from(canonicalJson(manifest)));
  const kept = new Set(['source.json', source.pdfPath, source.normalized.fullMarkdown, source.normalized.pages, source.normalized.contentList,
    ...assetsByHash.values()]);
  const pruned: MigrationPaper['pruned'] = [];
  for (const file of inputs) {
    if (kept.has(file.path)) continue;
    let kind: PrunedKind;
    if (file.path === source.normalized.pageMarkedText) kind = 'page-marked-text';
    else if (file.path.startsWith('assets/')) kind = assetsByHash.has(file.sha256) ? 'duplicate-asset' : 'unreferenced-asset';
    else if (/(?:^|\/)(?:[^/]+_)?origin\.pdf$/i.test(file.path) && file.sha256 === source.pdfSha256) kind = 'duplicate-pdf';
    // MinerU rewrites PDF bytes through PDFium before dumping its origin PDF.
    // The manifest-authenticated download remains the authoritative source.pdf.
    else if (/\/(?:auto|txt|ocr|raw|pipeline|vlm)\/(?:[^/]+_)?origin\.pdf$/i.test(file.path)) kind = 'mineru-intermediate';
    else if (/(?:^|\/)(?:[^/]+_)?(?:layout|span)\.pdf$|(?:^|\/)(?:[^/]+_)?(?:middle|model|content_list(?:_v2)?)\.json$/i.test(file.path)
      || /\/(?:auto|txt|ocr|raw|pipeline|vlm)\/[^/]+\.md$/i.test(file.path)) kind = 'mineru-intermediate';
    else if (/\/images\/[^/]+\.(?:png|jpg|jpeg|webp|gif|svg)$/i.test(file.path) && assetsByHash.has(file.sha256)) kind = 'duplicate-asset';
    else if (/\/(?:auto|txt|ocr|raw|pipeline|vlm)\/images\/[^/]+\.(?:png|jpg|jpeg|webp|gif|svg)$/i.test(file.path)) kind = 'unreferenced-asset';
    else return fail('MIGRATION_INVALID_SOURCE', 'unknown input: ' + file.path);
    pruned.push({ path: file.path, kind, bytes: file.bytes });
  }
  for (const directory of tree.filter(p => p.endsWith('/'))) {
    if (!inputs.some(file => file.path.startsWith(directory)) && directory !== 'assets/') fail('MIGRATION_INVALID_SOURCE', 'unknown empty directory: ' + directory);
  }
  const targetFiles = [...output.keys()].sort().map(path => entry(path, output.get(path)!));
  return { payloads: output, paper: { baseId: source.baseId, version: source.version, oldRoot,
    targetRoot: join(input.paths.archiveRoot, `${source.baseId}-v${source.version}`), inputs,
    directories: tree.filter(p => p.endsWith('/')), targetFiles, pruned,
    prunedKinds: [...new Set(pruned.map(x => x.kind))].sort(),
    inputBytes: inputs.reduce((n, x) => n + x.bytes, 0), targetBytes: targetFiles.reduce((n, x) => n + x.bytes, 0) } };
}

async function prepare(input: ArchiveMigrationInput): Promise<{ plan: ArchiveMigrationPlan; prepared: PreparedPaper[] }> {
  const checked = await roots(input);
  const tree = await realTree(checked.legacyArchiveRoot);
  const folded = new Set<string>();
  for (const path of tree) {
    const key = path.replace(/\/$/, '').toLowerCase();
    if (folded.has(key)) fail('MIGRATION_INVALID_SOURCE', 'case-colliding path: ' + path);
    folded.add(key);
  }
  const sources = tree.filter(path => path === 'source.json' || path.endsWith('/source.json'));
  const oldRoots = sources.map(path => dirname(join(checked.legacyArchiveRoot, path)));
  for (const path of tree) {
    const absolutePath = join(checked.legacyArchiveRoot, path);
    if (!oldRoots.some(root => inside(root, absolutePath) || (path.endsWith('/') && inside(absolutePath, root)))) {
      fail('MIGRATION_INVALID_SOURCE', 'unowned input: ' + path);
    }
  }
  if (oldRoots.some((root, i) => oldRoots.some((other, j) => i !== j && inside(root, other)))) fail('MIGRATION_INVALID_SOURCE', 'nested paper roots');
  const prepared: PreparedPaper[] = [];
  const targets = new Set<string>();
  for (const oldRoot of oldRoots) {
    const item = await preparePaper(checked, oldRoot);
    const key = item.paper.targetRoot.toLowerCase();
    if (targets.has(key)) fail('MIGRATION_INVALID_SOURCE', 'duplicate target identity');
    targets.add(key); prepared.push(item);
  }
  if (canonicalJson(tree) !== canonicalJson(await realTree(checked.legacyArchiveRoot))) fail('MIGRATION_PLAN_DRIFT', 'inventory changed');
  const body = { schemaVersion: 1 as const, ...checked, directories: tree.filter(p => p.endsWith('/')), papers: prepared.map(x => x.paper) };
  return { plan: { ...body, sha256: hash(canonicalJson(body)) }, prepared };
}

export async function createArchiveMigrationPlan(input: ArchiveMigrationInput): Promise<ArchiveMigrationPlan> {
  try { return (await prepare(input)).plan; }
  catch (error) { throw new Error('MIGRATION_INVALID_SOURCE: ' + String(error), { cause: error }); }
}

async function submittedPlan(input: ArchiveMigrationInput & { planFile: string; planSha256: string }): Promise<string> {
  try {
    if (!/^[0-9a-f]{64}$/.test(input.planSha256)) fail('MIGRATION_PLAN_DRIFT', 'invalid planSha256');
    const serialized = (await readRegular(absolute(input.planFile))).toString('utf8');
    const plan = JSON.parse(serialized);
    const { sha256, ...body } = plan;
    if (serialized !== canonicalJson(plan) || sha256 !== input.planSha256 || hash(canonicalJson(body)) !== sha256) {
      fail('MIGRATION_PLAN_DRIFT', 'submitted plan/hash is not canonical or differs');
    }
    return serialized;
  } catch (error) { throw new Error('MIGRATION_PLAN_DRIFT: ' + String(error), { cause: error }); }
}

async function reviewed(input: ArchiveMigrationInput, serialized: string) {
  try {
    const current = await prepare(input);
    // Never use submitted absolute paths as filesystem authority. Regenerate from
    // independently supplied roots and compare every field (including unknown keys).
    if (canonicalJson(current.plan) !== serialized) fail('MIGRATION_PLAN_DRIFT', 'reviewed plan differs from current inputs');
    return current;
  } catch (error) { throw new Error('MIGRATION_PLAN_DRIFT: ' + String(error), { cause: error }); }
}

async function exactTarget(root: string, paper: MigrationPaper): Promise<void> {
  await verifyArchiveV2(root);
  const expectedTree = new Set(paper.targetFiles.map(file => file.path));
  for (const file of paper.targetFiles) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) expectedTree.add(parts.slice(0, i).join('/') + '/');
  }
  if (canonicalJson(await realTree(root)) !== canonicalJson([...expectedTree].sort())) {
    fail('MIGRATION_TARGET_CONFLICT', 'target tree differs from reviewed package');
  }
  for (const file of paper.targetFiles) {
    const actual = entry(file.path, await readRegular(join(root, file.path)));
    if (canonicalJson(actual) !== canonicalJson(file)) fail('MIGRATION_TARGET_CONFLICT', 'target differs from reviewed bytes');
  }
}

async function targetsState(plan: ArchiveMigrationPlan): Promise<'empty' | 'replay'> {
  let existing = 0;
  try {
    await prospective(plan.paths.archiveRoot);
    for (const paper of plan.papers) {
      if (await info(paper.targetRoot)) { await exactTarget(paper.targetRoot, paper); existing++; }
    }
    if (existing && existing !== plan.papers.length) fail('MIGRATION_TARGET_CONFLICT', 'partially installed plan; no resume or overwrite');
    return existing === plan.papers.length ? 'replay' : 'empty';
  } catch (error) { throw new Error('MIGRATION_TARGET_CONFLICT: ' + String(error), { cause: error }); }
}

/** Copy-only migration. Failure retains staging under work for diagnosis; no recursive deletion. */
export async function applyArchiveMigration(input: ArchiveMigrationApplyInput): Promise<ArchiveMigrationResult> {
  const serialized = await submittedPlan(input);
  let { plan, prepared } = await reviewed(input, serialized);
  const result = (migrated: number, replayed: boolean): ArchiveMigrationResult => ({ planSha256: plan.sha256, migrated, replayed,
    prunedKinds: [...new Set(plan.papers.flatMap(x => x.prunedKinds))].sort() });
  if (await targetsState(plan) === 'replay') return result(0, true);
  await safeMkdir(plan.paths.workRoot);
  const workIdentity = await pathIdentity(plan.paths.workRoot);
  const lock = join(plan.paths.workRoot, 'archive-migration.lock');
  try { await mkdir(lock); } catch (error) { throw new Error('MIGRATION_BUSY: migration lock exists or cannot be created', { cause: error }); }
  const lockIdentity = await pathIdentity(lock);
  try {
    ({ plan, prepared } = await reviewed(input, serialized));
    if (await targetsState(plan) === 'replay') return result(0, true);
    const stagingParent = join(plan.paths.workRoot, 'archive-migration');
    await safeMkdir(stagingParent);
    const stagingParentIdentity = await pathIdentity(stagingParent);
    let migrated = 0;
    for (const { paper, payloads } of prepared) {
      if (await pathIdentity(stagingParent) !== stagingParentIdentity) fail('MIGRATION_PATH_UNSAFE', 'staging root replaced');
      const staging = join(stagingParent, randomUUID());
      await mkdir(staging);
      const stagingIdentity = await pathIdentity(staging);
      const assertStaging = async () => {
        if (await pathIdentity(staging) !== stagingIdentity) fail('MIGRATION_PATH_UNSAFE', 'staging replaced');
      };
      for (const [path, body] of payloads) {
        await assertStaging();
        await safeMkdir(dirname(join(staging, path)));
        await assertRealPath(dirname(join(staging, path)));
        await writeFile(join(staging, path), body, { flag: 'wx' });
      }
      await exactTarget(staging, paper);
      // Rehash ALL sources, even pruned inputs and other papers, at every install boundary.
      if (await submittedPlan(input) !== serialized) fail('MIGRATION_PLAN_DRIFT', 'plan file changed during apply');
      await reviewed(input, serialized);
      await safeMkdir(dirname(paper.targetRoot));
      const targetParentIdentity = await pathIdentity(dirname(paper.targetRoot));
      await assertStaging();
      if (await info(paper.targetRoot)) fail('MIGRATION_TARGET_CONFLICT', 'target appeared during migration');
      if (await pathIdentity(dirname(paper.targetRoot)) !== targetParentIdentity) fail('MIGRATION_PATH_UNSAFE', 'target parent replaced');
      // Both roots live in the same LibraryPaths dataRoot; EXDEV fails closed.
      const stagedDirectory = await lstat(staging, { bigint: true });
      try {
        await (input.install ?? rename)(staging, paper.targetRoot);
        await exactTarget(paper.targetRoot, paper);
        if (await submittedPlan(input) !== serialized) fail('MIGRATION_PLAN_DRIFT', 'plan file changed during installation');
        await reviewed(input, serialized);
      }
      catch (error) {
        if (await info(paper.targetRoot)) {
          await assertRealPath(paper.targetRoot);
          const installed = await lstat(paper.targetRoot, { bigint: true });
          if (installed.dev === stagedDirectory.dev && installed.ino === stagedDirectory.ino && installed.birthtimeNs === stagedDirectory.birthtimeNs
            && await pathIdentity(stagingParent) === stagingParentIdentity && !(await info(staging))) {
            await rename(paper.targetRoot, staging);
          }
        }
        throw error;
      }
      migrated++;
    }
    return result(migrated, false);
  } catch (error) { throw new Error('MIGRATION_APPLY_FAILED: ' + String(error), { cause: error }); }
  finally {
    // Empty lock removal only, and only while its ancestry/identity still matches.
    if (await pathIdentity(plan.paths.workRoot) === workIdentity && await pathIdentity(lock) === lockIdentity) await rmdir(lock);
  }
}
