import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { loadEngineContext } from '../../shared/engine-context.ts';
import type { LocalPdfIdentity } from './local-pdf-files.ts';
import { exact, identifier, operationError, record } from '../operations/operation-contracts.ts';

interface FileSnapshot { fileId: string; name: string; relativePath: string; sha256: string; pages: number; bytes: number }
interface PreviewRecord { schemaVersion: 1; previewId: string; rootId: string; relativePath: string; createdAt: number; expiresAt: number; policyHash: string; files: FileSnapshot[] }
export interface ConfirmedImport { snapshotId: string; policyHash: string; files: FileSnapshot[] }
export interface ImportScan { path: string; files: string[]; expectedFiles: LocalPdfIdentity[] }
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fail(code = 'INVALID_REQUEST'): never { throw operationError(code); }
const inside = (root: string, candidate: string) => { const rel = relative(root, candidate); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'); };
// Bun on Windows may return a volume root as "D:". Never resolve that spelling
// directly: Windows interprets it relative to the drive's current directory.
const canonicalRealPath = (path: string) => process.platform === 'win32' && /^[A-Za-z]:$/.test(path) ? `${path}\\` : path;
function safeRelative(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || /[\\:*?"<>|\x00-\x1f\x7f]/.test(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) fail();
}
function settings(root: string) {
  try {
    const context = loadEngineContext({ root, libraryId: 'fsd' });
    const localImport = context.engine.mineru.localImport;
    const roots = localImport.roots ?? [];
    const excluded = [context.paths.dataRoot, context.paths.vaultRoot, context.paths.archiveRoot];
    return { roots, localImport, excluded, policyHash: digest(JSON.stringify({ roots, localImport, excluded })) };
  } catch { return fail('CONFIG_REQUIRED'); }
}
// These are configuration reads only: preview never initializes MinerU or opens the state database.
export function importRootViews(root: string): { id: string; label: string }[] {
  try { return settings(root).roots.map(({ id }) => ({ id, label: id })); } catch { return []; }
}

/** Check every existing component, including ancestors of a configured root. Do not resolve links first. */
async function noLinks(path: string): Promise<string> {
  const absolute = resolve(path), volume = parse(absolute).root;
  let current = volume;
  for (const segment of relative(volume, absolute).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink > 1)) fail();
  }
  if (canonicalRealPath(await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) fail();
  return absolute;
}
async function safeDirectory(path: string): Promise<string> {
  const absolute = resolve(path), parent = parse(absolute).root; let current = parent;
  for (const part of relative(parent, absolute).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if (!record(error) || error.code !== 'EEXIST') throw error; }
    await noLinks(current); if (!(await lstat(current)).isDirectory()) fail();
  }
  return absolute;
}
async function bytesAt(path: string, maxBytes: number): Promise<Buffer> {
  await noLinks(path); const before = await lstat(path);
  if (!before.isFile() || extname(path).toLowerCase() !== '.pdf') fail();
  if (before.size > maxBytes) fail('IMPORT_LIMIT_EXCEEDED');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > maxBytes) fail('PREVIEW_CHANGED');
    // Bound allocation even if a selected file grows while it is being read.
    const data = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1)); let offset = 0;
    while (offset < data.length) { const { bytesRead } = await handle.read(data, offset, data.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    const after = await handle.stat(); await noLinks(path);
    const current = await lstat(path);
    if (after.size !== opened.size || current.ino !== opened.ino || current.dev !== opened.dev || offset !== opened.size) fail('PREVIEW_CHANGED');
    if (offset > maxBytes) fail('IMPORT_LIMIT_EXCEEDED');
    return data.subarray(0, offset);
  } finally { await handle.close(); }
}
async function scan(root: string, rootId: string, relativePath: string) {
  const config = settings(root), allowed = config.roots.find(value => value.id === rootId);
  if (!allowed) fail('SOURCE_NOT_AUTHORIZED');
  const base = await noLinks(allowed.path), selected = resolve(base, relativePath);
  if (!inside(base, selected)) fail();
  const excluded = await Promise.all(config.excluded.map(path => realpath(path).then(canonicalRealPath).catch(() => resolve(path))));
  const files: FileSnapshot[] = [];
  let visited = 0;
  async function visit(path: string, initial = false): Promise<void> {
    if (++visited > Math.max(1000, config.localImport.maxFiles * 100)) fail('IMPORT_LIMIT_EXCEEDED');
    await noLinks(path);
    if (!inside(base, path) || excluded.some(exclusion => inside(exclusion, path))) fail();
    const info = await lstat(path);
    if (info.isDirectory()) {
      if (!initial && !config.localImport.recursive) return;
      for (const name of (await readdir(path)).sort()) { safeRelative(name); await visit(join(path, name)); }
    } else if (info.isFile() && extname(path).toLowerCase() === '.pdf') {
      if (files.length >= config.localImport.maxFiles) fail('IMPORT_LIMIT_EXCEEDED');
      const bytes = await bytesAt(path, config.localImport.maxPdfSizeMb * 1024 * 1024);
      if (bytes.subarray(0, 5).toString() !== '%PDF-') fail();
      let pages: number;
      try { pages = (await PDFDocument.load(bytes, { ignoreEncryption: false })).getPageCount(); } catch { return fail(); }
      if (pages < 1 || pages > config.localImport.maxPdfPages) fail('IMPORT_LIMIT_EXCEEDED');
      const location = relative(base, path).split(/[\\/]/).join('/');
      files.push({ fileId: digest(location), name: basename(path), relativePath: location, sha256: digest(bytes), pages, bytes: bytes.length });
    } else if (initial) fail();
  }
  await visit(selected, true);
  if (!files.length) fail();
  return { base, files, config };
}
export async function previewLocalImport(input: { root: string; operationsRoot: string; request: unknown; now?: () => number }) {
  exact(input.request, ['rootId', 'relativePath']); identifier(input.request.rootId); safeRelative(input.request.relativePath);
  let scanned: Awaited<ReturnType<typeof scan>>;
  try { scanned = await scan(input.root, input.request.rootId, input.request.relativePath); }
  catch (error) { if (record(error) && ['CONFIG_REQUIRED', 'SOURCE_NOT_AUTHORIZED', 'IMPORT_LIMIT_EXCEEDED'].includes(String(error.code))) throw error; return fail(); }
  const now = (input.now ?? Date.now)(), previewId = randomUUID();
  const value: PreviewRecord = { schemaVersion: 1, previewId, rootId: input.request.rootId, relativePath: input.request.relativePath,
    createdAt: now, expiresAt: now + 600000, policyHash: scanned.config.policyHash, files: scanned.files };
  const directory = await safeDirectory(join(input.operationsRoot, 'import-previews'));
  await writeFile(join(directory, `${previewId}.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  return { previewId, expiresAt: new Date(value.expiresAt).toISOString(), requiresReparseConfirmation: true,
    files: value.files.map(({ fileId, name, pages, bytes }) => ({ fileId, name, pages, bytes })) };
}
async function readPreview(operationsRoot: string, previewId: string): Promise<PreviewRecord> {
  identifier(previewId);
  try {
    const path = await noLinks(join(operationsRoot, 'import-previews', `${previewId}.json`));
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!record(raw) || raw.schemaVersion !== 1 || raw.previewId !== previewId || !Number.isSafeInteger(raw.createdAt) ||
      !Number.isSafeInteger(raw.expiresAt) || Number(raw.expiresAt) - Number(raw.createdAt) !== 600000 || !Array.isArray(raw.files)) fail('PREVIEW_CHANGED');
    identifier(raw.rootId); safeRelative(raw.relativePath);
    return raw as unknown as PreviewRecord;
  } catch (error) { if (record(error) && error.code === 'ENOENT') return fail('PREVIEW_EXPIRED'); return fail('PREVIEW_CHANGED'); }
}
/** Called within admission after idempotency/busy checks. Snapshot filenames are derived from checked metadata. */
export async function confirmLocalImport(input: { root: string; operationsRoot: string; previewId: string; reparse: boolean; now?: () => number }): Promise<ConfirmedImport> {
  if (typeof input.reparse !== 'boolean') fail();
  const preview = await readPreview(input.operationsRoot, input.previewId), now = (input.now ?? Date.now)();
  if (now < preview.createdAt || now >= preview.expiresAt) fail('PREVIEW_EXPIRED');
  let scanned: Awaited<ReturnType<typeof scan>>;
  try { scanned = await scan(input.root, preview.rootId, preview.relativePath); } catch { return fail('PREVIEW_CHANGED'); }
  if (scanned.config.policyHash !== preview.policyHash || JSON.stringify(scanned.files) !== JSON.stringify(preview.files)) fail('PREVIEW_CHANGED');
  if ((input.now ?? Date.now)() >= preview.expiresAt) fail('PREVIEW_EXPIRED');
  const snapshotId = randomUUID(), directory = await safeDirectory(join(input.operationsRoot, 'import-snapshots', snapshotId));
  for (const file of scanned.files) {
    const bytes = await bytesAt(join(scanned.base, file.relativePath), scanned.config.localImport.maxPdfSizeMb * 1024 * 1024);
    if (digest(bytes) !== file.sha256 || bytes.length !== file.bytes) fail('PREVIEW_CHANGED');
    const target = await safeDirectory(join(directory, file.fileId));
    await writeFile(join(target, file.name), bytes, { flag: 'wx', mode: 0o600 });
  }
  return { snapshotId, policyHash: preview.policyHash, files: scanned.files };
}
/** Accepted jobs use immutable content identity, not a ten-minute token or a later directory rescan. */
export async function readConfirmedImport(input: { root: string; operationsRoot: string; confirmed: ConfirmedImport }): Promise<ImportScan> {
  const { confirmed } = input; identifier(confirmed.snapshotId);
  const config = settings(input.root);
  if (config.policyHash !== confirmed.policyHash) fail('POLICY_CHANGED');
  const directory = await noLinks(join(input.operationsRoot, 'import-snapshots', confirmed.snapshotId)), files: string[] = [], expectedFiles: LocalPdfIdentity[] = [];
  if (!Array.isArray(confirmed.files) || !confirmed.files.length || confirmed.files.length > config.localImport.maxFiles) fail('PREVIEW_CHANGED');
  for (const file of confirmed.files) {
    if (!/^[a-f0-9]{64}$/.test(file.fileId) || basename(file.name) !== file.name) fail('PREVIEW_CHANGED');
    safeRelative(file.name);
    const path = join(directory, file.fileId, file.name), bytes = await bytesAt(path, config.localImport.maxPdfSizeMb * 1024 * 1024);
    if (digest(bytes) !== file.sha256 || bytes.length !== file.bytes) fail('PREVIEW_CHANGED');
    files.push(path);
    expectedFiles.push({ path, sha256: file.sha256, bytes: file.bytes, pageCount: file.pages });
  }
  return { path: directory, files, expectedFiles };
}
