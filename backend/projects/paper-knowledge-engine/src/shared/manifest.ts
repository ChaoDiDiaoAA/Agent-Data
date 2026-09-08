import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface ArchiveManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isManifestEntry(value: unknown): value is ArchiveManifestEntry {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort(compareText);
  return keys.length === 3 && keys[0] === 'bytes' && keys[1] === 'path' && keys[2] === 'sha256'
    && typeof value.path === 'string' && typeof value.sha256 === 'string' && typeof value.bytes === 'number';
}

/** Normalize a manifest entry path and reject anything that can escape its Archive root. */
export function normalizeArchivePath(value: string): string {
  if (!value || CONTROL_CHARACTER.test(value) || value.includes('\\') || value.startsWith('/') || WINDOWS_ABSOLUTE.test(value)) {
    throw new TypeError('archive manifest path must be a safe relative POSIX path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError('archive manifest path must not contain empty, dot, or parent segments');
  }
  return segments.join('/');
}

function canonicalize(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not permit non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) {
    const entries = value.map((item) => canonicalize(item, ancestors));
    if (entries.length > 0 && entries.every(isManifestEntry)) {
      return entries.sort((left, right) => compareText(
        normalizeArchivePath(left.path),
        normalizeArchivePath(right.path),
      ));
    }
    return entries;
  }
  if (!isRecord(value)) throw new TypeError('canonical JSON only permits plain objects, arrays, and JSON primitives');
  if (ancestors.has(value)) throw new TypeError('canonical JSON does not permit cycles');
  ancestors.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    const item = value[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
      throw new TypeError('canonical JSON only permits JSON values');
    }
    result[key] = canonicalize(item, ancestors);
  }
  ancestors.delete(value);
  return result;
}

/** Stable UTF-8 JSON bytes used by source and future Evidence manifests. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

/** Read an Archive tree deterministically, excluding source.json to avoid a self-referential hash. */
export async function archiveFileManifest(root: string): Promise<ArchiveManifestEntry[]> {
  const canonicalRoot = await realpath(root);
  const files: ArchiveManifestEntry[] = [];
  for (const entry of await readdir(canonicalRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('archive manifest refuses symbolic links');
    if (!entry.isFile()) continue;
    const absolute = resolve(entry.parentPath, entry.name);
    const actual = await realpath(absolute);
    if (!isInside(canonicalRoot, actual)) throw new Error('archive manifest path escapes archive root');
    const path = normalizeArchivePath(relative(canonicalRoot, actual).replaceAll('\\', '/'));
    if (path === 'source.json') continue;
    const info = await lstat(actual);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('archive manifest refuses non-file entries');
    const body = await readFile(actual);
    files.push({ path, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.byteLength });
  }
  return files.sort((left, right) => compareText(left.path, right.path));
}
