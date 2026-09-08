import type { LocalImportConfig } from '../../types/config.ts';
import type { LocalPdfDocument } from '../../types/papers.ts';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

/** Server-owned confirmation metadata; never inferred again from replacement files. */
export interface LocalPdfIdentity { path: string; sha256: string; bytes: number; pageCount: number }
function previewChanged(): never { throw Object.assign(new Error('PREVIEW_CHANGED'), { code: 'PREVIEW_CHANGED' }); }
async function readConfirmedPdf(expected: LocalPdfIdentity): Promise<Buffer> {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || !/^[a-f0-9]{64}$/.test(expected.sha256)) previewChanged();
  try {
    const before = await lstat(expected.path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size !== expected.bytes ||
      (await realpath(expected.path)).toLowerCase() !== resolve(expected.path).toLowerCase()) previewChanged();
    const handle = await open(expected.path, 'r');
    try {
      const opened = await handle.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== expected.bytes) previewChanged();
      const body = Buffer.alloc(expected.bytes + 1); let offset = 0;
      while (offset < body.length) { const read = await handle.read(body, offset, body.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      const current = await lstat(expected.path);
      if (offset !== expected.bytes || current.ino !== opened.ino || current.dev !== opened.dev || current.isSymbolicLink() ||
        current.size !== expected.bytes || createHash('sha256').update(body.subarray(0, offset)).digest('hex') !== expected.sha256) previewChanged();
      return body.subarray(0, offset);
    } finally { await handle.close(); }
  } catch { return previewChanged(); }
}
export async function verifyConfirmedPdfFiles(expected: LocalPdfIdentity[] | undefined): Promise<void> {
  if (expected) for (const identity of expected) await readConfirmedPdf(identity);
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel));
}

export async function scanLocalPdfs(input: unknown, config: { localImport: LocalImportConfig | null; stateRoot?: string; outputRoot: string; vaultRoot?: string }) {
  if (!config.localImport) throw new Error('请先配置 config/engine.yaml 的 mineru.local_import');
  const localImport = config.localImport;
  let text = String(input ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1);
  if (!text) throw new Error('请输入原始 PDF 文件或文件夹路径');
  const path = await realpath(resolve(text));
  const excluded = await Promise.all([config.stateRoot, config.outputRoot, config.vaultRoot].filter((root): root is string => typeof root === 'string').map(async (root) => realpath(root).catch(() => resolve(root))));
  const isOutput = (candidate: string) => excluded.some((root) => inside(root, candidate));
  if (isOutput(path)) throw new Error('不能导入 state/extracted、状态库或 Wiki 输出目录，请选择原始 PDF');
  const files: string[] = [];
  async function visit(candidate: string, initial = false): Promise<void> {
    if (isOutput(candidate)) return;
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) return; // Never follow recursive links/junctions outside the selected tree.
    if (info.isDirectory()) {
      if (!initial && !localImport.recursive) return;
      for (const name of (await readdir(candidate)).sort()) await visit(join(candidate, name));
    } else if (info.isFile() && extname(candidate).toLowerCase() === '.pdf') {
      files.push(candidate);
      if (files.length > localImport.maxFiles) throw new Error(`PDF 数量超过 local_import.max_files 上限 ${localImport.maxFiles}`);
    }
  }
  await visit(path, true);
  if (files.length === 0) throw new Error('指定路径没有可导入的 PDF 文件');
  return { path, files };
}

export async function inspectLocalPdfs(files: string[], config: { localImport: LocalImportConfig }, expected?: LocalPdfIdentity[]): Promise<LocalPdfDocument[]> {
  if (expected && (expected.length !== files.length || new Set(expected.map(file => file.path)).size !== files.length || files.some(path => !expected.some(file => file.path === path)))) previewChanged();
  const documents = [];
  for (const path of files) {
    const identity = expected?.find(file => file.path === path);
    const maxBytes = config.localImport.maxPdfSizeMb * 1024 * 1024;
    let body: Buffer;
    if (identity) {
      // Check the confirmed identity before ordinary CLI diagnostics; missing,
      // oversized or replaced snapshots all have the same safe failure code.
      body = await readConfirmedPdf(identity);
    } else {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`PDF 输入已变化：${path}`);
      if (stat.size > maxBytes) throw new Error(`PDF 大小超过配置上限：${path}`);
      body = await readFile(path);
    }
    if (body.length > maxBytes || body.subarray(0, 5).toString() !== '%PDF-') throw new Error(`无效的 PDF 文件：${path}`);
    let document;
    try { document = await PDFDocument.load(body, { ignoreEncryption: false }); }
    catch { throw new Error(`PDF 已加密、损坏或无法读取：${path}`); }
    const pageCount = document.getPageCount();
    if (identity && pageCount !== identity.pageCount) previewChanged();
    if (pageCount < 1 || pageCount > config.localImport.maxPdfPages) throw new Error(`PDF 页数超出配置范围：${path}（${pageCount} 页）`);
    const sha256 = createHash('sha256').update(body).digest('hex');
    documents.push({ path, sha256, pageCount, title: basename(path, extname(path)) });
  }
  return documents;
}
