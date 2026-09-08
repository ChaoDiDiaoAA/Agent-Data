import { mkdir, readFile, rename, writeFile, lstat, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { LibraryPaths } from '../shared/paths.ts';
import { ARCHIVE_ARTIFACTS, archivePath, archiveReferences, assertRealPath, pathIdentity, realTree, verifyArchiveV2, type ArchiveSourceV2, type FrozenSourceMetadata, type VerifiedArchiveV2 } from '../shared/archive-v2.ts';
import { assertLibraryId } from '../shared/identity.ts';
import { canonicalJson } from '../shared/manifest.ts';
import { withRunLock } from '../runtime/run-lock.ts';

export interface ArchiveWriteInput extends Omit<ArchiveSourceV2, 'schemaVersion' | 'files' | 'artifacts'> {
  paths: LibraryPaths;
  workspace: string;
  attemptId: string;
  source: FrozenSourceMetadata;
  /** Filesystem seam for installation fault tests. Must perform an atomic rename. */
  install?: (source: string, destination: string) => Promise<void>;
  onInstalled?: (archive: VerifiedArchiveV2) => unknown;
}

export function assertArchivePaths(paths: LibraryPaths, attemptId: string): void {
  archivePath(attemptId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(attemptId) ||
    resolve(paths.workRoot) !== resolve(paths.dataRoot, 'work') ||
    resolve(paths.archiveRoot) !== resolve(paths.dataRoot, 'archive') ||
    resolve(paths.operationsRoot) !== resolve(paths.dataRoot, 'operations')) throw new Error('invalid LibraryPaths/workspace identity');
}
export async function safeMkdir(path: string): Promise<void> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info) { await assertRealPath(path); if (!info.isDirectory()) throw new Error('expected directory'); return; }
  await safeMkdir(dirname(path)); await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await assertRealPath(path);
}

export async function writeArchiveV2(input: ArchiveWriteInput): Promise<VerifiedArchiveV2> {
  assertLibraryId(input.libraryId); assertArchivePaths(input.paths, input.attemptId);
  archivePath(input.baseId);
  if (input.baseId.includes('/') || !Number.isSafeInteger(input.version) || input.version < 1) throw new Error('invalid Archive identity');
  if (resolve(input.workspace) !== resolve(input.paths.workRoot, 'parsing', input.attemptId)) throw new Error('invalid parsing workspace path');
  await realTree(input.workspace);
  const lockRoot = join(input.paths.operationsRoot, 'locks');
  await safeMkdir(lockRoot);
  return withRunLock(join(lockRoot, `archive-${input.baseId}-v${input.version}.lock`), () => installPackage(input), { waitMs: 3000 });
}

async function installPackage(input: ArchiveWriteInput): Promise<VerifiedArchiveV2> {
  const workspaceIdentity = await pathIdentity(input.workspace);
  const assertWorkspace = async () => {
    if (await pathIdentity(input.workspace) !== workspaceIdentity) throw new Error('workspace identity changed');
  };
  const retainDiagnostics = async () => {
    await assertWorkspace();
    const diagnostics = join(input.paths.workRoot, 'diagnostics', input.attemptId);
    await safeMkdir(dirname(diagnostics));
    if (await lstat(diagnostics).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error('diagnostics conflict');
    await rename(input.workspace, diagnostics);
    return diagnostics;
  };
  try {
    const staging = join(input.workspace, 'package');
    await mkdir(staging);
    const markdown = await readFile(join(input.workspace, 'document.md'), 'utf8');
    const contentList = JSON.parse(await readFile(join(input.workspace, 'content-list.json'), 'utf8'));
    const pages = JSON.parse(await readFile(join(input.workspace, 'pages.json'), 'utf8'));
    const payloads = [...new Set(['source.pdf', 'document.md', 'pages.json', 'content-list.json',
      ...archiveReferences(markdown, contentList), ...archiveReferences('', pages)])].filter(path => path !== 'source.json').sort();
    const files: ArchiveSourceV2['files'] = [];
    for (const path of [...payloads, 'source.json'].sort()) {
      const body = path === 'source.json' ? Buffer.from(canonicalJson(input.source)) : await readFile(join(input.workspace, path));
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), body);
      files.push({ path, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length });
    }
    const manifest: ArchiveSourceV2 = { schemaVersion: 2, libraryId: input.libraryId, sourceKind: input.sourceKind,
      baseId: input.baseId, version: input.version, pdfSha256: input.pdfSha256, parser: input.parser,
      artifacts: ARCHIVE_ARTIFACTS, files };
    await writeFile(join(staging, 'manifest.json'), canonicalJson(manifest));
    await verifyArchiveV2(staging);
    const root = join(input.paths.archiveRoot, `${input.baseId}-v${input.version}`);
    await safeMkdir(dirname(root));
    const existing = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) {
      const verified = await verifyArchiveV2(root);
      if (canonicalJson(verified.manifest) !== canonicalJson(manifest)) throw new Error('Archive conflict: existing package differs');
    } else {
      await assertWorkspace();
      await verifyArchiveV2(staging);
      await assertRealPath(dirname(root));
      await (input.install ?? rename)(staging, root);
    }
    let result: VerifiedArchiveV2;
    const installedIdentity = await pathIdentity(root);
    try {
      result = await verifyArchiveV2(root);
      await input.onInstalled?.(result);
    } catch (error) {
      if (!existing) {
        await assertWorkspace();
        if (await pathIdentity(root) !== installedIdentity) throw new Error('installed Archive identity changed', { cause: error });
        await rename(root, staging);
      }
      throw error;
    }
    // onInstalled has resolved: the state transaction is committed. Cleanup
    // must not enter the publication-failure/rollback path beyond this point.
    try {
      await assertWorkspace(); await realTree(input.workspace);
      await rm(input.workspace, { recursive: true });
    } catch {
      let retained = input.workspace;
      try { retained = await retainDiagnostics(); }
      catch { /* Preserve an unsafe/replaced workspace or conflicting diagnostics. */ }
      result.cleanupPending = { reason: 'workspace_cleanup_failed', path: retained };
    }
    return result;
  } catch (error) {
    await retainDiagnostics();
    throw error;
  }
}
