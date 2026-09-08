import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { hashCanonical } from '../shared/manifest.ts';

export type CleanupTargetType = 'directory' | 'file';

export interface CleanupTargetSnapshot {
  path: string;
  type: CleanupTargetType;
  sha256: string;
  bytes: number;
  fileCount: number;
  newestMtimeMs: number;
  members: string[];
}

export interface WorkGcEntry extends CleanupTargetSnapshot {
  reason: 'work/tests' | 'work/publishing' | 'diagnostics older than 30 days';
}

export interface WorkGcPlan {
  schemaVersion: 1;
  workRoot: string;
  entries: WorkGcEntry[];
  planSha256: string;
}

export interface CollectExpiredWorkInput {
  workRoot: string;
  now?: Date | string;
  diagnosticsRetentionDays?: number;
}

type TreeMember = { path: string; type: CleanupTargetType; bytes: number; sha256?: string };

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function normalizeCleanupPath(value: string): string {
  const plain = value.replace(/^\\\\\?\\/, '');
  const result = /^[A-Za-z]:$/.test(plain) ? `${plain}\\` : resolve(plain);
  const root = parse(result).root;
  const normalized = result.length > root.length ? result.replace(/[\\/]+$/, '') : result;
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function sameCleanupPath(left: string, right: string): boolean {
  return normalizeCleanupPath(left) === normalizeCleanupPath(right);
}

function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export function cleanupPathsOverlap(left: string, right: string): boolean {
  const a = normalizeCleanupPath(left);
  const b = normalizeCleanupPath(right);
  return a === b || inside(a, b) || inside(b, a);
}

async function missing(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

export interface CleanupPathIdentity {
  lexical: string;
  physical: string;
  exists: boolean;
}

/**
 * Resolves one path without ever stepping through a linked/reparse component.
 * Missing suffixes are projected from the nearest verified physical ancestor.
 */
export async function resolveCleanupPathIdentity(path: string): Promise<CleanupPathIdentity> {
  if (!isAbsolute(path)) throw new Error(`CLEANUP_UNSAFE: path must be absolute: ${path}`);
  const lexical = resolve(path);
  const volumeRoot = parse(lexical).root;
  if (!volumeRoot) throw new Error(`CLEANUP_UNSAFE: invalid absolute path: ${path}`);
  const parts = relative(volumeRoot, lexical).split(/[\\/]+/).filter(Boolean);
  let current = volumeRoot;
  for (let index = 0; index <= parts.length; index++) {
    if (index > 0) current = join(current, parts[index - 1]!);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = index === 0 ? volumeRoot : resolve(current, '..');
      const parentPhysical = await realpath(parent);
      const missingParts = index === 0 ? parts : [parts[index - 1]!, ...parts.slice(index)];
      return { lexical, physical: resolve(parentPhysical, ...missingParts), exists: false };
    }
    if (info.isSymbolicLink()) throw new Error(`CLEANUP_UNSAFE: link or reparse point at ${current}`);
    const actual = await realpath(current);
    if (!sameCleanupPath(actual, current)) {
      throw new Error(`CLEANUP_UNSAFE: path resolves through a link or reparse point: ${current}`);
    }
  }
  return { lexical, physical: await realpath(lexical), exists: true };
}

const protectedNames = new Set(['archive', 'library.sqlite', 'runs', 'operations', 'receipts', '.obsidian']);

export function protectedCleanupMember(path: string): boolean {
  const segments = path.replaceAll('\\', '/').split('/').filter(Boolean).map(segment => segment.toLocaleLowerCase('en-US'));
  if (segments.some(segment => protectedNames.has(segment))) return true;
  return segments.some((segment, index) => segment === '.trellis' && segments[index + 1] === 'tasks');
}

export function snapshotContainsProtectedMember(snapshot: CleanupTargetSnapshot): boolean {
  return protectedCleanupMember(basename(snapshot.path)) || snapshot.members.some(protectedCleanupMember);
}

async function inspectNode(path: string, relativePath: string, members: TreeMember[]): Promise<{ bytes: number; fileCount: number; newestMtimeMs: number }> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`CLEANUP_UNSAFE: link or reparse point at ${path}`);
  if (info.isFile()) {
    const bytes = await readFile(path);
    members.push({ path: relativePath, type: 'file', bytes: bytes.byteLength, sha256: digest(bytes) });
    return { bytes: bytes.byteLength, fileCount: 1, newestMtimeMs: info.mtimeMs };
  }
  if (!info.isDirectory()) throw new Error(`CLEANUP_UNSAFE: unsupported filesystem entry at ${path}`);
  if (relativePath) members.push({ path: relativePath, type: 'directory', bytes: 0 });
  let bytes = 0;
  let fileCount = 0;
  let newestMtimeMs = info.mtimeMs;
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
    const child = await inspectNode(join(path, entry.name), relativePath ? `${relativePath}/${entry.name}` : entry.name, members);
    bytes += child.bytes;
    fileCount += child.fileCount;
    newestMtimeMs = Math.max(newestMtimeMs, child.newestMtimeMs);
  }
  return { bytes, fileCount, newestMtimeMs };
}

/** Read-only exact-tree snapshot used by both planning and apply preflight. */
export async function inspectCleanupTarget(path: string): Promise<CleanupTargetSnapshot | undefined> {
  if (!isAbsolute(path)) throw new Error(`CLEANUP_UNSAFE: target must be absolute: ${path}`);
  const target = resolve(path);
  if (sameCleanupPath(target, parse(target).root)) throw new Error('CLEANUP_UNSAFE: filesystem roots cannot be cleanup targets');
  const identity = await resolveCleanupPathIdentity(target);
  if (!identity.exists) return undefined;
  const top = await lstat(target);
  if (top.isSymbolicLink()) throw new Error(`CLEANUP_UNSAFE: link or reparse point at ${target}`);
  if (!sameCleanupPath(identity.physical, target)) throw new Error(`CLEANUP_UNSAFE: target resolves through a link or reparse point: ${target}`);
  const members: TreeMember[] = [];
  const aggregate = await inspectNode(target, '', members);
  const type: CleanupTargetType = top.isFile() ? 'file' : 'directory';
  const canonicalMembers = members.sort((a, b) => compare(a.path, b.path));
  return {
    path: target,
    type,
    sha256: hashCanonical({ type, members: canonicalMembers }),
    bytes: aggregate.bytes,
    fileCount: aggregate.fileCount,
    newestMtimeMs: aggregate.newestMtimeMs,
    members: canonicalMembers.map(member => member.path),
  };
}

function parseNow(value: Date | string | undefined): number {
  const result = value === undefined ? Date.now() : value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(result)) throw new Error('CLEANUP_INVALID_TIME: now must be a valid date');
  return result;
}

/** Creates a read-only, deterministic plan for lifecycle-owned work directories. */
export async function collectExpiredWork(input: CollectExpiredWorkInput): Promise<WorkGcPlan> {
  const workRoot = resolve(input.workRoot);
  if (!isAbsolute(input.workRoot)) throw new Error('CLEANUP_UNSAFE: workRoot must be absolute');
  const retentionDays = input.diagnosticsRetentionDays ?? 30;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 30) {
    throw new Error('CLEANUP_INVALID_RETENTION: diagnostics retention must be at least 30 days');
  }
  const nowMs = parseNow(input.now);
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const entries: WorkGcEntry[] = [];
  const add = async (path: string, reason: WorkGcEntry['reason']): Promise<void> => {
    const target = resolve(path);
    if (!inside(workRoot, target)) throw new Error(`CLEANUP_UNSAFE: work target escapes workRoot: ${target}`);
    const snapshot = await inspectCleanupTarget(target);
    if (snapshot && !snapshotContainsProtectedMember(snapshot)) entries.push({ ...snapshot, reason });
  };
  await add(join(workRoot, 'tests'), 'work/tests');
  await add(join(workRoot, 'publishing'), 'work/publishing');
  const diagnosticsRoot = join(workRoot, 'diagnostics');
  if (!await missing(diagnosticsRoot)) {
    const rootInfo = await lstat(diagnosticsRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('CLEANUP_UNSAFE: diagnostics must be a normal directory');
    for (const entry of (await readdir(diagnosticsRoot, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      const target = join(diagnosticsRoot, entry.name);
      const snapshot = await inspectCleanupTarget(target);
      if (snapshot && snapshot.newestMtimeMs < cutoff && !snapshotContainsProtectedMember(snapshot)) {
        entries.push({ ...snapshot, reason: 'diagnostics older than 30 days' });
      }
    }
  }
  entries.sort((a, b) => compare(a.path, b.path));
  const body = { schemaVersion: 1 as const, workRoot, entries };
  return { ...body, planSha256: hashCanonical(body) };
}
