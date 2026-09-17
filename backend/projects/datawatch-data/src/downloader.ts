import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import type { HttpResult } from './contracts.ts';
import { sha256 } from './util.ts';

export interface DownloadRequest {
  url: string;
  destination: string;
  temporaryPath: string;
  expectedBytes: number;
  expectedSha256?: string;
  maxBytes: number;
  timeoutMs?: number;
  allowedOrigins?: string[];
  redirectOrigins?: string[];
  /** A changed source revision replaces the current snapshot after verification. */
  replaceExisting?: boolean;
}

export interface DownloadReceipt {
  url: string;
  final_url: string;
  bytes: number;
  sha256: string;
  retrieved_at: string;
  skipped: boolean;
}

export interface Downloader {
  download(request: DownloadRequest): Promise<DownloadReceipt>;
}

export interface DownloaderOptions {
  get(url: string, options: { maxBytes: number; timeoutMs: number; allowedOrigins: string[]; redirectOrigins: string[] }): Promise<HttpResult>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  maxAttempts?: number;
}

function fail(code: string): never { throw new Error(code); }
function retryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.code === 'RESEARCH_TRANSPORT_FAILED' || record.code === 'RESEARCH_TIMEOUT'
    || (record.code === 'RESEARCH_HTTP_STATUS' && (record.status === 408 || record.status === 429 || (typeof record.status === 'number' && record.status >= 500 && record.status <= 599)));
}

async function verifyDestination(request: DownloadRequest): Promise<DownloadReceipt | undefined> {
  try {
    const info = await lstat(request.destination);
    if (!info.isFile() || info.isSymbolicLink()) fail('IMMUTABLE_FILE_CONFLICT');
    const body = await readFile(request.destination);
    const digest = sha256(body);
    if (body.byteLength !== request.expectedBytes || (request.expectedSha256 && request.expectedSha256 !== digest)) fail('IMMUTABLE_FILE_CONFLICT');
    return {
      url: request.url,
      final_url: request.url,
      bytes: body.byteLength,
      sha256: digest,
      retrieved_at: new Date(0).toISOString(),
      skipped: true,
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function createDownloader(options: DownloaderOptions): Downloader {
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => new Date());
  const maxAttempts = Number.isSafeInteger(options.maxAttempts) && Number(options.maxAttempts) > 0 ? Number(options.maxAttempts) : 4;
  let previous = Promise.resolve();
  const download = async (request: DownloadRequest): Promise<DownloadReceipt> => {
    if (!request.temporaryPath.endsWith('.part')) fail('DOWNLOAD_TEMPORARY_PATH_REJECTED');
    if (!Number.isSafeInteger(request.expectedBytes) || request.expectedBytes < 0 || !Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) fail('DOWNLOAD_INVALID_LIMIT');
    const existing = request.replaceExisting ? undefined : await verifyDestination(request);
    if (existing) return existing;
    await mkdir(dirname(request.destination), { recursive: true });
    await mkdir(dirname(request.temporaryPath), { recursive: true });
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await unlink(request.temporaryPath).catch(error => {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        });
        const response = await options.get(request.url, {
          maxBytes: request.maxBytes,
          timeoutMs: request.timeoutMs ?? 30_000,
          allowedOrigins: request.allowedOrigins ?? [],
          redirectOrigins: request.redirectOrigins ?? [],
        });
        if (response.bytes.byteLength > request.maxBytes || response.bytes.byteLength !== request.expectedBytes) fail('DOWNLOAD_SIZE_MISMATCH');
        const digest = createHash('sha256').update(response.bytes).digest('hex');
        if (request.expectedSha256 && request.expectedSha256 !== digest) fail('FILE_HASH_MISMATCH');
        await writeFile(request.temporaryPath, response.bytes, { flag: 'wx' });
        if (request.replaceExisting) {
          await rename(request.temporaryPath, request.destination);
        } else try {
          await copyFile(request.temporaryPath, request.destination, constants.COPYFILE_EXCL);
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
          const reused = await verifyDestination(request);
          if (!reused) throw error;
          await unlink(request.temporaryPath).catch(() => undefined);
          return reused;
        }
        if (!request.replaceExisting) await unlink(request.temporaryPath);
        return {
          url: request.url,
          final_url: response.url,
          bytes: response.bytes.byteLength,
          sha256: digest,
          retrieved_at: now().toISOString(),
          skipped: false,
        };
      } catch (error) {
        await unlink(request.temporaryPath).catch(() => undefined);
        if (!retryable(error) || attempt === maxAttempts) throw error;
        await sleep([250, 1000, 4000][Math.min(attempt - 1, 2)]!);
      }
    }
    fail('DOWNLOAD_RETRY_EXHAUSTED');
  };
  return {
    download(request) {
      const current = previous.then(() => download(request));
      previous = current.then(() => undefined, () => undefined);
      return current;
    },
  };
}
