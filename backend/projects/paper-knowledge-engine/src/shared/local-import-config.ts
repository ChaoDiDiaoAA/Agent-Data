import type { LocalImportConfig } from '../types/config.ts';
import { isAbsolute, resolve } from 'node:path';
export function normalizeLocalImportConfig(input: unknown): LocalImportConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('local_import must be an object');
  const raw = input as Record<string, unknown>;
  if (typeof raw.recursive !== 'boolean') throw new Error('local_import.recursive 必须为布尔值');
  for (const key of ['max_files', 'max_pdf_pages', 'max_pdf_size_mb']) {
    if (typeof raw[key] !== 'number' || !Number.isSafeInteger(raw[key]) || raw[key] < 1) throw new Error(`local_import.${key} 必须为正整数`);
  }
  if (typeof raw.default_track !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(raw.default_track)) {
    throw new Error('local_import.default_track 必须为安全的单级分类名称');
  }
  const roots = raw.roots ?? [];
  if (!Array.isArray(roots) || roots.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new Error('local_import.roots 必须为来源根目录数组');
  }
  const normalizedRoots = roots.map((entry) => {
    const root = entry as Record<string, unknown>;
    if (typeof root.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(root.id)) {
      throw new Error('local_import.roots.id 必须为安全标识');
    }
    if (typeof root.path !== 'string' || !root.path.trim() || !isAbsolute(root.path)) {
      throw new Error('local_import.roots.path 必须为绝对路径');
    }
    return { id: root.id, path: resolve(root.path) };
  });
  if (new Set(normalizedRoots.map((root) => root.id)).size !== normalizedRoots.length) {
    throw new Error('local_import.roots.id 必须唯一');
  }
  return {
    recursive: raw.recursive,
    maxFiles: Number(raw.max_files),
    maxPdfPages: Number(raw.max_pdf_pages),
    maxPdfSizeMb: Number(raw.max_pdf_size_mb),
    defaultTrack: raw.default_track,
    roots: normalizedRoots,
  };
}
