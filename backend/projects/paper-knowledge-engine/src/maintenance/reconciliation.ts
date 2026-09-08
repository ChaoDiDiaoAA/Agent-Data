import type { Dirent } from 'node:fs';
interface DuplicateGroup { sha256: string; paths: string[] }
interface DuplicateDependencies { readDirectory?: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>; hashFile?: (path: string) => Promise<string> }
interface ArtifactRow { base_id: string; status: string; pdf_path?: string | null; note_path?: string | null; sha256?: string | null }
interface ReconcileOptions { rows: ArtifactRow[]; exists(path: string): boolean | Promise<boolean>; pdfRoot?: string; scanDuplicates?: typeof scanDuplicatePdfs }
interface RepairDependencies { hashFile?: (path: string) => Promise<string>; removeFile?: (path: string) => Promise<unknown>; scanDuplicates?: typeof scanDuplicatePdfs; pdfRoot?: string; store: { findByBaseId(id: string): Omit<ArtifactRow, 'status'> | undefined | Promise<Omit<ArtifactRow, 'status'> | undefined>; updatePdfPath(id: string, path: string): unknown } }
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { realTree, verifyArchiveV2 } from '../shared/archive-v2.ts';
import { validateVault } from '../evidence/vault-validator.ts';

async function fileSha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function scanDuplicatePdfs(pdfRoot: string, dependencies: DuplicateDependencies = {}) {
  const readDirectory = dependencies.readDirectory ?? readdir;
  const hashFile = dependencies.hashFile ?? fileSha256;
  const byHash = new Map<string, string[]>();
  const entries = await readDirectory(pdfRoot, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const categories = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const category of categories) {
    const directory = join(pdfRoot, category.name);
    const files = (await readDirectory(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const file of files) {
      const path = join(directory, file.name);
      const sha256 = await hashFile(path);
      byHash.set(sha256, [...(byHash.get(sha256) ?? []), path]);
    }
  }
  return [...byHash.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([sha256, paths]) => ({ sha256, paths: paths.sort() }))
    .sort((left, right) => left.sha256.localeCompare(right.sha256));
}

export async function reconcilePaperArtifacts({ rows, exists, pdfRoot, scanDuplicates }: ReconcileOptions) {
  const report: Record<'consistent' | 'missingPdf' | 'rebuildNote' | 'retryParse' | 'retryWiki', string[]> & { duplicatePdfs: DuplicateGroup[] } = {
    consistent: [], missingPdf: [], rebuildNote: [], retryParse: [], retryWiki: [],
    duplicatePdfs: pdfRoot ? await (scanDuplicates ?? scanDuplicatePdfs)(pdfRoot) : [],
  };
  for (const row of rows) {
    if (['excluded', 'download_failed', 'parse_failed'].includes(row.status)) continue;
    if (!row.pdf_path || !await exists(row.pdf_path)) { report.missingPdf.push(row.base_id); continue; }
    if (row.status === 'downloaded') { report.retryParse.push(row.base_id); continue; }
    if (!row.note_path || !await exists(row.note_path)) { report.rebuildNote.push(row.base_id); continue; }
    if (row.status === 'parsed') { report.retryWiki.push(row.base_id); continue; }
    if (row.status === 'synthesized') report.consistent.push(row.base_id);
  }
  for (const key of ['consistent', 'missingPdf', 'rebuildNote', 'retryParse', 'retryWiki'] as const) report[key].sort();
  return report;
}

/** L2 reconciliation checks the Archive and its deterministic projection, not legacy Wiki notes. */
export async function reconcileLibraryArtifacts(input: ReconcileOptions & { archiveRoot: string; vaultRoot: string }) {
  const sources = [];
  const archiveIssues: { path: string; detail: string }[] = [];
  const tree = await realTree(input.archiveRoot).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    archiveIssues.push({ path: '.', detail: String(error) });
    return [];
  });
  for (const path of tree) {
    if (!/^[^/]+\/manifest\.json$/.test(path)) continue;
    try { sources.push(await verifyArchiveV2(dirname(join(input.archiveRoot, path)))); }
    catch (error) { archiveIssues.push({ path, detail: String(error) }); }
  }
  const evidence = await validateVault({ vaultRoot: input.vaultRoot, sources });
  if (archiveIssues.length) evidence.valid = false;
  const report = await reconcilePaperArtifacts({ ...input, rows: [] });
  for (const row of input.rows) {
    if (['discovered', 'excluded', 'download_failed', 'parse_failed'].includes(row.status)) continue;
    if (!row.pdf_path || !await input.exists(row.pdf_path)) { report.missingPdf.push(row.base_id); continue; }
    if (row.status === 'downloaded') { report.retryParse.push(row.base_id); continue; }
    const source = sources.find(s => s.manifest.baseId === row.base_id && resolve(row.pdf_path!) === join(s.root, 'source.pdf'));
    if (!source || (row.sha256 && row.sha256 !== source.manifest.pdfSha256)) { report.retryParse.push(row.base_id); continue; }
    // Aggregate indexes are one projection: any validation issue requires a checked republish.
    (evidence.valid ? report.consistent : report.rebuildNote).push(row.base_id);
  }
  for (const values of [report.consistent, report.missingPdf, report.retryParse, report.rebuildNote]) values.sort();
  return { ...report, evidence, archiveIssues };
}

export async function repairDuplicatePdf(baseId: string, keepPath: string, dependencies: RepairDependencies) {
  const hashFile = dependencies.hashFile ?? fileSha256;
  const removeFile = dependencies.removeFile ?? ((path) => rm(path));
  const scanDuplicates = dependencies.scanDuplicates ?? scanDuplicatePdfs;
  const row = await dependencies.store.findByBaseId(baseId);
  if (!row?.pdf_path || !row.sha256) throw new Error(`registered PDF not found: ${baseId}`);
  if (!dependencies.pdfRoot) throw new Error('duplicate PDF repair requires pdfRoot');
  const groups = await scanDuplicates(dependencies.pdfRoot);
  const group = groups.find((item) => item.sha256 === row.sha256);
  if (!group) {
    if (row.pdf_path === keepPath) return { baseId, keepPath, removedPaths: [], replayed: true };
    throw new Error('registered PDF is not in a duplicate hash group');
  }
  if (!group.paths.includes(keepPath)) throw new Error('keep path is not in the duplicate hash group');
  const keepHash = await hashFile(keepPath);
  if (keepHash !== row.sha256 || group.sha256 !== row.sha256) throw new Error('duplicate PDF repair requires three equal hashes');
  if (row.pdf_path !== keepPath) {
    const registeredHash = await hashFile(row.pdf_path);
    if (registeredHash !== row.sha256) throw new Error('duplicate PDF repair requires three equal hashes');
    await dependencies.store.updatePdfPath(baseId, keepPath);
  }
  const removedPaths = group.paths.filter((path) => path !== keepPath).sort();
  for (const path of removedPaths) await removeFile(path);
  return { baseId, keepPath, removedPaths };
}
