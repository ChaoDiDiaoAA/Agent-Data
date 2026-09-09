import type { LocalParseJob } from '../types/jobs.ts';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { normalizeMinerUPages, renderPageMarkedText } from './page-text.ts';
import { archiveReferences, rewriteArchiveReferences, realTree } from '../shared/archive-v2.ts';

function isInside(root: string, candidate: string) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== ''
    && pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

const VLM_TEXT_KEYS = new Set([
  'algorithm_caption',
  'algorithm_content',
  'chart_caption',
  'chart_footnote',
  'code_caption',
  'code_content',
  'content',
  'equation_content',
  'html',
  'image_caption',
  'image_footnote',
  'item_content',
  'latex',
  'list_items',
  'math_content',
  'page_aside_text',
  'page_footer_content',
  'page_footnote_content',
  'page_header_content',
  'page_number_content',
  'paragraph_content',
  'table_caption',
  'table_footnote',
  'text',
  'text_content',
  'title_content',
]);

function extractVlmText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractVlmText).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value)
    .filter(([key]) => VLM_TEXT_KEYS.has(key))
    .map(([, child]) => extractVlmText(child))
    .filter(Boolean)
    .join('');
}

function pageBlocksFor(contentList: unknown): unknown {
  if (!Array.isArray(contentList) || !contentList.every(Array.isArray)) return contentList;
  return contentList.flatMap((pageBlocks, pageIndex) => {
    if (pageBlocks.length === 0) return [{ page_idx: pageIndex, text: '' }];
    return pageBlocks.map((block) => ({
      ...block,
      page_idx: pageIndex,
      text: extractVlmText(block),
    }));
  });
}

async function filesBelow(root: string, minimumMtime = 0) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries.filter((item) => item.isFile() || item.isSymbolicLink())) {
    const path = resolve(entry.parentPath, entry.name);
    if (minimumMtime > 0 && (await stat(path)).mtimeMs < minimumMtime) continue;
    files.push(path);
  }
  return files;
}
async function assertArtifactsInside(root: string, files: string[]) {
  const resolvedRoot = await realpath(root);
  for (const file of files) {
    const resolvedFile = await realpath(file).catch(() => file);
    if (!isInside(resolvedRoot, resolvedFile)) throw new Error('artifact outside output directory');
  }
}

async function atomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}
async function sourcePdfPageCount(fileSource: unknown): Promise<number | undefined> {
  if (typeof fileSource !== 'string' || !fileSource) return undefined;
  try { return (await PDFDocument.load(await readFile(fileSource))).getPageCount(); }
  catch { return undefined; }
}

export async function normalizeLocalMinerUResult(job: Pick<LocalParseJob, 'model' | 'cliBackend' | 'outputDir' | 'attemptStartedAt' | 'pageCount' | 'fileSource'>) {
  if (!job.outputDir) throw new Error('output directory is required');
  const root = resolve(job.outputDir);
  try { await realTree(root); }
  catch (error) { throw new Error('artifact outside output directory or link/reparse point', { cause: error }); }
  const files = await filesBelow(root, job.attemptStartedAt ?? 0);
  await assertArtifactsInside(root, files);

  const markdown = files.find((path) => path.toLowerCase().endsWith('.md'));
  const v2 = files.find((path) => /_content_list_v2\.json$/i.test(basename(path)));
  const v1 = files.find((path) => /_content_list\.json$/i.test(basename(path)));
  const structured = job.model === 'vlm' ? (v2 ?? v1) : v1;
  if (!markdown || !structured) throw new Error('structured content list required');

  const markdownText = await readFile(markdown, 'utf8');
  const contentList: unknown = JSON.parse(await readFile(structured, 'utf8'));
  const expectedPageCount = typeof job.pageCount === 'number' && Number.isSafeInteger(job.pageCount) && job.pageCount >= 1
    ? job.pageCount
    : await sourcePdfPageCount(job.fileSource);
  const pages = normalizeMinerUPages(job.model === 'vlm' ? pageBlocksFor(contentList) : contentList, expectedPageCount);
  if (Number.isInteger(expectedPageCount) && pages.length !== expectedPageCount) throw new Error('page count mismatch');

  const assetPaths = new Map<string, string>();
  const assetHashes = new Map<string, string>();
  for (const path of archiveReferences(markdownText, contentList)) {
    const source = resolve(dirname(markdown), ...path.split('/'));
    const actual = await realpath(source);
    if (!isInside(await realpath(root), actual)) throw new Error(`referenced asset outside output directory: ${path}`);
    const info = await lstat(actual);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`referenced asset must be a real file: ${path}`);
    const hash = createHash('sha256').update(await readFile(actual)).digest('hex');
    const existing = assetHashes.get(hash);
    if (existing) { assetPaths.set(path, existing); continue; }
    const normalizedPath = `assets/${path}`;
    const destination = resolve(root, ...normalizedPath.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    if (actual !== destination) await copyFile(actual, destination);
    assetPaths.set(path, normalizedPath);
    assetHashes.set(hash, normalizedPath);
  }
  const rewritten = rewriteArchiveReferences(markdownText, contentList, assetPaths);
  const normalizedPages = pages.map(page => ({ ...page,
    text: rewriteArchiveReferences(page.text, [], assetPaths).fullMarkdown,
  }));

  const normalizedDir = join(root, 'normalized');
  const markdownPath = join(normalizedDir, 'full.md');
  const contentListPath = join(normalizedDir, 'content-list.json');
  const pageTextPath = join(normalizedDir, 'page-marked.txt');
  await atomic(markdownPath, rewritten.fullMarkdown);
  await atomic(contentListPath, `${JSON.stringify(rewritten.contentList, null, 2)}\n`);
  await atomic(join(normalizedDir, 'pages.json'), `${JSON.stringify(normalizedPages, null, 2)}\n`);
  await atomic(pageTextPath, `${renderPageMarkedText(normalizedPages)}\n`);

  const contentHash = createHash('sha256')
    .update(rewritten.fullMarkdown)
    .update(JSON.stringify(rewritten.contentList))
    .digest('hex');
  return {
    model: job.model,
    cliBackend: job.cliBackend,
    rawOutputDir: root,
    normalizedDir,
    markdownPath,
    contentListPath,
    pageTextPath,
    pageCount: pages.length,
    contentHash,
  };
}
