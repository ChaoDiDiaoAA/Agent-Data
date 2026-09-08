import type { ProjectPaths } from '../types/config.ts';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertRealPath } from '../shared/archive-v2.ts';
import { EVIDENCE_LAYOUT_V3 } from '../evidence/layout-paths.ts';
interface Categories { tracks?: Record<string, { pdf: string }>; fallback_pdf?: string }

/** Initialization creates directories only. Publication owns the Evidence file inventory. */
export async function bootstrapStageOne(
  config: Pick<ProjectPaths, 'pdfRoot' | 'vaultRoot'> & { root?: string; libraryKind?: 'paper' | 'research' },
  categories: Categories = {},
) {
  let ancestor = resolve(config.vaultRoot);
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  await assertRealPath(ancestor);
  const libraryKind = config.libraryKind ?? 'paper';
  const pdfDirs = libraryKind === 'paper'
    ? [...new Set([...Object.values(categories.tracks ?? {}).map(track => track.pdf), categories.fallback_pdf ?? '99-Unclassified'])].sort()
    : [];
  await Promise.all(pdfDirs.map(dir => mkdir(join(config.pdfRoot, dir), { recursive: true })));
  await mkdir(config.vaultRoot, { recursive: true });
  const entries = await readdir(config.vaultRoot);
  if (entries.some(name => name.toLowerCase() === EVIDENCE_LAYOUT_V3.root.toLowerCase() && name !== EVIDENCE_LAYOUT_V3.root)) {
    throw new Error('EVIDENCE_PATH: Evidence root has a different case identity');
  }
  const root = join(config.vaultRoot, EVIDENCE_LAYOUT_V3.root);
  const childDirectories = libraryKind === 'research' ? ['sources', 'indexes'] : ['papers', 'indexes'];
  for (const path of [root, ...childDirectories.map(child => join(root, child))]) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('EVIDENCE_PATH: bootstrap target must be a real directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(path);
    }
  }
  return { pdfDirectories: pdfDirs.length, vaultDirectories: 2, templates: 0 };
}
