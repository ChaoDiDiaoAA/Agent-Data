import type { LocalParseJob, MinerUCliJob, NormalizedArtifact } from '../types/jobs.ts';
import { copyFile, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { assertLibraryId } from '../shared/identity.ts';
import { assertRealPath, pathIdentity, realTree } from '../shared/archive-v2.ts';
import { assertArchivePaths, safeMkdir, writeArchiveV2 } from './archive-writer.ts';

export type ParseWorkspace = Awaited<ReturnType<typeof createParseWorkspace>>;

export function assertMinerUPathLength(job: Pick<MinerUCliJob, 'fileSource' | 'outputDir'>) {
  if (process.platform !== 'win32') return;
  const stem = basename(job.fileSource, extname(job.fileSource));
  const longest = resolve(job.outputDir, stem, 'hybrid_auto', `${stem}_content_list_v2.json`);
  if (longest.length >= 260) throw Object.assign(new Error(`MinerU 输出路径过长（${longest.length} 字符）：${longest}；请缩短 config/machine.local.yaml 的根路径`), { code: 'MINERU_PATH_TOO_LONG' });
}

export async function createParseWorkspace(job: LocalParseJob) {
  if (!job.fileSource || !job.libraryPaths || !job.parseAttemptId) throw new Error('MinerU LibraryPaths and attempt identity are required');
  assertLibraryId(job.libraryId);
  const paths = job.libraryPaths;
  assertArchivePaths(paths, job.parseAttemptId);
  const stem = `${job.baseId}v${job.version}`;
  if (!/^[A-Za-z0-9.-]+v\d+$/.test(stem)) throw new Error('invalid paper identity for MinerU workspace');
  const destination = resolve(paths.archiveRoot, `${job.baseId}-v${job.version}`);
  if (job.outputDir && resolve(job.outputDir) !== destination) throw new Error('Archive destination differs from LibraryPaths');
  const root = resolve(paths.workRoot, 'parsing', job.parseAttemptId);
  await safeMkdir(dirname(root)); await mkdir(root);
  const identity = await pathIdentity(root);
  const assertOwned = async () => {
    if (await pathIdentity(root) !== identity) throw new Error('workspace identity changed');
  };
  const fileSource = join(root, `${stem}.pdf`);
  const cleanup = async () => {
    if (!await lstat(root).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) return;
    await assertOwned(); await realTree(root); await rm(root, { recursive: true });
  };
  const diagnose = async () => {
    if (!await lstat(root).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) return;
    await assertOwned();
    const diagnostics = join(paths.workRoot, 'diagnostics', job.parseAttemptId!);
    await safeMkdir(dirname(diagnostics));
    if (await lstat(diagnostics).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) throw new Error('diagnostics conflict');
    await rename(root, diagnostics);
  };
  try {
    assertMinerUPathLength({ fileSource, outputDir: root });
    await assertRealPath(job.fileSource);
    await copyFile(job.fileSource, fileSource);
    const hash = createHash('sha256').update(await readFile(fileSource)).digest('hex');
    if (hash !== job.sha256) throw new Error('PDF 内容校验失败，请重新下载后解析');
    return { root, destination, fileSource, cleanup, diagnose };
  } catch (error) { await diagnose(); throw error; }
}

export async function publishParseWorkspace<T extends NormalizedArtifact>(
  workspace: ParseWorkspace, artifact: T, job: LocalParseJob,
  commit: (artifact: T, archive: { previousOutputDir?: string; archivedOutputDir?: string }) => unknown,
  install?: (source: string, destination: string) => Promise<void>,
) {
  const result = { ...artifact, outputDir: workspace.destination, normalizedDir: workspace.destination,
    archivePdfPath: join(workspace.destination, 'source.pdf'), sourcePath: join(workspace.destination, 'source.pdf'),
    markdownPath: join(workspace.destination, 'document.md'), contentListPath: join(workspace.destination, 'content-list.json') };
  delete result.rawOutputDir; delete result.pageTextPath;
  await realTree(workspace.root);
  for (const [source, target] of [
    [workspace.fileSource, 'source.pdf'], [artifact.markdownPath, 'document.md'],
    [artifact.contentListPath, 'content-list.json'], [join(artifact.normalizedDir!, 'pages.json'), 'pages.json'],
  ] as const) {
    if (!source) throw new Error('missing normalized artifact');
    const rel = relative(workspace.root, source);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('artifact outside workspace');
    await assertRealPath(source);
    if (resolve(source) !== resolve(workspace.root, target)) await copyFile(source, join(workspace.root, target));
  }
  const source = {
    title: job.title!, authors: job.authors ?? [], categories: job.categories ?? [], matchedTracks: job.matchedTracks ?? [],
    parseAttemptId: job.parseAttemptId!, pageCount: artifact.pageCount!,
    ...(job.sourceType === 'local_pdf' ? { parserConfigKey: job.parserConfigKey! } :
      { arxivId: job.arxivId!, published: job.published!, updated: job.updated! }),
  };
  const archive = await writeArchiveV2({
    paths: job.libraryPaths!, libraryId: job.libraryId!, attemptId: job.parseAttemptId!, workspace: workspace.root,
    sourceKind: job.sourceType === 'local_pdf' ? 'local_pdf' : 'arxiv', baseId: job.baseId, version: job.version,
    pdfSha256: job.sha256, parser: { name: 'MinerU', version: job.mineruVersion!, model: job.model as 'pipeline' | 'vlm', method: (job.method ?? 'auto') as 'auto' | 'txt' | 'ocr' },
    source,
    install,
    onInstalled: () => commit(result, {}),
  });
  if (archive.cleanupPending) result.cleanupPending = archive.cleanupPending;
  return result;
}
