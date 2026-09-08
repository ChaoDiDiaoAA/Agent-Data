import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHttpClient, type HttpScope, type ResearchHttpClient } from './engine-bridge.ts';
import { installImmutableFile, type SupportedMimeType } from './file-store.ts';
import type { SourceConfig } from './contracts.ts';

const retryDelays = [250, 1000, 4000] as const;

export interface DownloadReceipt {
  stable_url: string;
  final_origin: string;
  bytes: number;
  mime_type: SupportedMimeType;
  sha256: string;
}

export interface DownloadRequest {
  url: string;
  source: Pick<SourceConfig, 'allowed_origins' | 'redirect_origins'>;
  destination: string;
  temporaryPath: string;
  expectedMimeType: SupportedMimeType;
  expectedSha256?: string;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface DownloaderOptions {
  http?: ResearchHttpClient;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

function fail(code: string): never {
  throw new Error(code);
}

function exactHttpsOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    if (value !== url.origin && value !== url.href) throw new Error();
    return url.origin;
  } catch { return fail('DOWNLOAD_SOURCE_ORIGIN_REJECTED'); }
}

function responseMimeType(headers: Headers): string {
  const value = headers.get('content-type');
  if (!value) return '';
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function stableUrl(value: string): string {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.href;
}

function scopeFor(request: DownloadRequest): HttpScope {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) fail('DOWNLOAD_INVALID_LIMIT');
  let initial: URL;
  try {
    initial = new URL(request.url);
    if (initial.protocol !== 'https:' || initial.port || initial.username || initial.password) throw new Error();
  } catch { return fail('DOWNLOAD_URL_REJECTED'); }
  const allowedOrigins = request.source.allowed_origins.map(exactHttpsOrigin);
  const redirectOrigins = request.source.redirect_origins.map(exactHttpsOrigin);
  if (!allowedOrigins.includes(initial.origin)) fail('DOWNLOAD_URL_REJECTED');
  const domains = [...new Set([...allowedOrigins, ...redirectOrigins].map(origin => new URL(origin).hostname))];
  const policy: HttpScope['policy'] = {
    dateLowerBound: '1970-01-01', sourceKinds: ['official-doc'], allowedDomains: domains,
    identityVersionRules: {} as HttpScope['policy']['identityVersionRules'], maxResponseBytes: request.maxBytes,
    requestTimeoutMs: 30_000, maxAttempts: 1, retainAllVersions: true, contentHash: 'sha256',
  };
  return { policy, allowedDomains: domains, allowedRedirectOrigins: redirectOrigins, signal: request.signal ?? new AbortController().signal };
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = Reflect.get(error, 'code');
  const status = Reflect.get(error, 'status');
  return code === 'RESEARCH_TRANSPORT_FAILED' || (code === 'RESEARCH_HTTP_STATUS' && (status === 408 || status === 429 || (typeof status === 'number' && status >= 500 && status <= 599)));
}

async function removePart(path: string): Promise<void> {
  await unlink(path).catch(error => {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  });
}

export function createDownloader(options: DownloaderOptions = {}) {
  const http = options.http ?? createHttpClient();
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let previous: Promise<void> = Promise.resolve();

  const download = async (request: DownloadRequest): Promise<DownloadReceipt> => {
    if (!request.temporaryPath.endsWith('.part')) fail('DOWNLOAD_TEMPORARY_PATH_REJECTED');
    const scope = scopeFor(request);
    await mkdir(dirname(request.temporaryPath), { recursive: true });
    for (let retry = 0; retry <= retryDelays.length; retry += 1) {
      try {
        await removePart(request.temporaryPath);
        const result = await http.get(request.url, scope);
        const mimeType = responseMimeType(result.headers);
        if (mimeType !== request.expectedMimeType) fail('DOWNLOAD_MIME_MISMATCH');
        if (result.bytes.byteLength > request.maxBytes) fail('DOWNLOAD_RESPONSE_TOO_LARGE');
        const sha256 = createHash('sha256').update(result.bytes).digest('hex');
        if (request.expectedSha256 && request.expectedSha256 !== sha256) fail('FILE_HASH_MISMATCH');
        await writeFile(request.temporaryPath, result.bytes, { flag: 'wx' });
        await installImmutableFile(request.temporaryPath, request.destination, { sha256, mime_type: request.expectedMimeType });
        return { stable_url: stableUrl(request.url), final_origin: new URL(result.url).origin, bytes: result.bytes.byteLength, mime_type: request.expectedMimeType, sha256 };
      } catch (error) {
        await removePart(request.temporaryPath);
        if (!retryable(error) || retry === retryDelays.length) throw error;
        await sleep(retryDelays[retry]!);
      }
    }
    return fail('DOWNLOAD_RETRY_EXHAUSTED');
  };

  return {
    downloadToTemp(request: DownloadRequest): Promise<DownloadReceipt> {
      const current = previous.then(() => download(request));
      previous = current.then(() => undefined, () => undefined);
      return current;
    },
  };
}

const defaultDownloader = createDownloader();

export function downloadToTemp(request: DownloadRequest): Promise<DownloadReceipt> {
  return defaultDownloader.downloadToTemp(request);
}
