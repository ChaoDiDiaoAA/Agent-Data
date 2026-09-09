import { prettyJson } from './readable-json.ts';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile as defaultCopyFile, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalJson, replaceFileWithRetry } from './engine-bridge.ts';

export type SupportedMimeType =
  | 'image/png' | 'image/jpeg' | 'application/pdf' | 'application/json'
  | 'text/html' | 'application/xml' | 'text/xml' | 'text/plain' | 'text/markdown'
  | 'application/msword' | 'application/ofd';

export interface ExpectedFile {
  sha256: string;
  mime_type: SupportedMimeType;
}

export interface InstallImmutableFileOptions {
  copyFile?: (source: string, destination: string, mode: number) => Promise<void>;
}

const supportedMimeTypes = new Set<SupportedMimeType>([
  'image/png', 'image/jpeg', 'application/pdf', 'application/json', 'text/html',
  'application/xml', 'text/xml', 'text/plain', 'text/markdown', 'application/msword', 'application/ofd',
]);

function fail(code: string): never {
  throw new Error(code);
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function validatesMime(bytes: Uint8Array, mimeType: SupportedMimeType): boolean {
  switch (mimeType) {
    case 'image/png': return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg': return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'application/pdf': return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'application/msword': return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    // OFD is a ZIP package; an empty ZIP is not a valid document package.
    case 'application/ofd': return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
    case 'application/json':
      try { JSON.parse(Buffer.from(bytes).toString('utf8')); return true; } catch { return false; }
    default: return true;
  }
}

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function writeCanonicalJson(path: string, value: unknown): Promise<void> {
  return writeJson(path, value, canonicalJson);
}

export async function writePrettyJson(path: string, value: unknown): Promise<void> {
  return writeJson(path, value, prettyJson);
}

async function writeJson(path: string, value: unknown, serialize: (value: unknown) => string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, serialize(value), { encoding: 'utf8', flag: 'wx' });
  try {
    await replaceFileWithRetry(temporary, path);
  } catch (error) {
    await Bun.file(temporary).delete().catch(() => undefined);
    throw error;
  }
}

async function verifyInstalledFile(destination: string, expected: ExpectedFile): Promise<void> {
  const destinationInfo = await lstat(destination);
  if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()) fail('IMMUTABLE_FILE_CONFLICT');
  if ((await sha256File(destination)) !== expected.sha256) fail('IMMUTABLE_FILE_CONFLICT');
}

export async function installImmutableFile(
  temporary: string,
  destination: string,
  expected: ExpectedFile,
  options: InstallImmutableFileOptions = {},
): Promise<void> {
  if (!supportedMimeTypes.has(expected.mime_type)) fail('UNSUPPORTED_FILE_MIME');
  const temporaryBytes = await readFile(temporary);
  if (!validatesMime(temporaryBytes, expected.mime_type)) fail('FILE_MIME_MISMATCH');
  if (createHash('sha256').update(temporaryBytes).digest('hex') !== expected.sha256) fail('FILE_HASH_MISMATCH');

  await mkdir(dirname(destination), { recursive: true });
  try {
    await (options.copyFile ?? defaultCopyFile)(temporary, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    await verifyInstalledFile(destination, expected);
    return;
  }
  await unlink(temporary);
}
