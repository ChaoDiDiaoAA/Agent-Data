import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, win32 } from 'node:path';
import { canonicalJson, hashCanonical, replaceFileWithRetry } from './engine-bridge.ts';

export { canonicalJson, hashCanonical };

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

export function safeRelativePath(value: string, code = 'PATH_INVALID'): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value)
    || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(code);
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) {
    throw new Error(code);
  }
  return parts.join('/');
}

export function resolveOwnedPath(root: string, relativePath: string): string {
  const safe = safeRelativePath(relativePath, 'PATH_INVALID');
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, ...safe.split('/'));
  const child = relative(rootResolved, candidate);
  if (!child || child === '..' || child.startsWith('..' + requireSeparator()) || isAbsolutePath(child)) {
    throw new Error('PATH_ESCAPE');
  }
  return candidate;
}

function requireSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

export async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + crypto.randomUUID() + '.tmp';
  await writeFile(temporary, content, { flag: 'wx' });
  try {
    await replaceFileWithRetry(temporary, path, { maxAttempts: 12 });
  } catch (error) {
    await Bun.file(temporary).delete().catch(() => undefined);
    throw error;
  }
}

export async function writeCanonicalJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, canonicalJson(value));
}

export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export function errorRecord(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown };
    return { code: typeof record.code === 'string' ? record.code : 'ERROR', message: typeof record.message === 'string' ? record.message : String(error) };
  }
  return { code: 'ERROR', message: String(error) };
}
