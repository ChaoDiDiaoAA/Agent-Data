import type { LocalPaper, PdfPaper } from '../../types/papers.ts';
import type { MachineConfig } from '../../types/config.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';

interface PdfRow { base_id?: string; version?: number; downloaded_version?: number | null; pdf_path?: string | null; sha256?: string | null; primary_track?: string | null; primaryTrack?: string; status?: string }
interface PdfStore {
  findByBaseId(id: string): PdfRow | null | undefined; findBySha256(hash: string): PdfRow | null | undefined;
  markDownloaded(id: string, path: string, track: string, hash: string, version: number): unknown;
  markExcluded?(id: string, reason: string, version: number): unknown;
}
interface PdfResponse { status: number; ok: boolean; headers?: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer | Uint8Array> }
type PdfFetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; proxy?: string }) => Promise<PdfResponse>;
export class PdfUnavailableError extends Error {
  readonly code = 'PDF_NOT_FOUND';
  readonly permanent = true;
  constructor(readonly paper: Pick<PdfPaper, 'baseId' | 'arxivId' | 'version'>, readonly status: number) {
    super(`PDF download HTTP ${status}`);
    this.name = 'PdfUnavailableError';
  }
  get baseId() { return this.paper.baseId; }
  get arxivId() { return this.paper.arxivId; }
}

export function isPermanentPdfUnavailable(error: unknown): error is PdfUnavailableError {
  return !!error && typeof error === 'object'
    && Reflect.get(error, 'code') === 'PDF_NOT_FOUND'
    && Reflect.get(error, 'permanent') === true;
}

export interface PdfDownloadOptions {
  network?: MachineConfig['network'];
  fetchImpl?: PdfFetch; sleep?: (ms: number) => Promise<unknown>; maxAttempts?: number;
  pdfRoot: string; tempRoot: string; stateStore: PdfStore; categories?: Record<string, { pdf?: string }>;
  signal?: AbortSignal;
}
function errorField(error: unknown, key: string): unknown { return error && typeof error === 'object' ? Reflect.get(error, key) : undefined; }
function readPdfDecision(input: unknown): { accepted: boolean; primaryTrack?: string; paper: PdfPaper & { pdfUrl: string } } {
  if (!input || typeof input !== 'object' || Reflect.get(input, 'accepted') !== true) throw new Error('cannot download a hard-filtered exclusion');
  const paper: unknown = Reflect.get(input, 'paper');
  if (!paper || typeof paper !== 'object' || Array.isArray(paper)) throw new Error('invalid PDF paper metadata');
  const p = paper as Record<string, unknown>;
  for (const key of ['id', 'title', 'summary', 'published', 'updated', 'submittedAt', 'updatedAt', 'status', 'sourceType']) {
    if (p[key] !== undefined && typeof p[key] !== 'string') throw new Error('invalid PDF paper metadata');
  }
  for (const key of ['categories', 'matchedTracks', 'eligibleTracks', 'dateModes']) {
    if (p[key] !== undefined && (!Array.isArray(p[key]) || !p[key].every(value => typeof value === 'string'))) throw new Error('invalid PDF paper metadata');
  }
  for (const key of ['sha256', 'primaryTrack']) if (p[key] !== undefined && p[key] !== null && typeof p[key] !== 'string') throw new Error('invalid PDF paper metadata');
  if (p.hasImportant2026Version !== undefined && typeof p.hasImportant2026Version !== 'boolean') throw new Error('invalid PDF paper metadata');
  if (typeof p.baseId !== 'string' || !p.baseId || p.baseId.includes('\\') || p.baseId.split('/').some(part => !part || part === '..' || part === '.')
    || typeof p.arxivId !== 'string' || p.arxivId !== p.baseId + 'v' + p.version
    || typeof p.version !== 'number' || !Number.isSafeInteger(p.version) || p.version < 1
    || typeof p.pdfUrl !== 'string' || !/^https?:\/\//i.test(p.pdfUrl)
    || (p.title !== undefined && typeof p.title !== 'string')) throw new Error('invalid PDF paper identity or metadata');
  const track: unknown = Reflect.get(input, 'primaryTrack');
  if (track !== undefined && track !== null && typeof track !== 'string') throw new Error('invalid PDF track');
  return { accepted: true, primaryTrack: typeof track === 'string' ? track : undefined, paper: { ...p, baseId: p.baseId, arxivId: p.arxivId, version: p.version, pdfUrl: p.pdfUrl, title: p.title } };
}

const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN']);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function hasVerifiedPdf(row: PdfRow | null | undefined): Promise<boolean> {
  if (!row?.pdf_path || !row.sha256) return false;
  try {
    const body = await readFile(row.pdf_path);
    return body.subarray(0, 5).toString() === '%PDF-'
      && createHash('sha256').update(body).digest('hex') === row.sha256;
  } catch (error) {
    if (errorField(error, 'code') === 'ENOENT') return false;
    throw error;
  }
}

// A discovered row alone is not a local PDF. Check the downloaded version and
// file bytes, so missing/corrupt files can still be repaired and new versions fetched.
export async function hasStoredPaperPdf(paper: { baseId: string; version?: number }, stateStore: Pick<PdfStore, 'findByBaseId'>) {
  const existing = stateStore.findByBaseId(paper.baseId);
  return Boolean(existing && Number(existing.downloaded_version) >= Number(paper.version ?? 1)
    && await hasVerifiedPdf(existing));
}

export function safePaperFilename(paper: Pick<PdfPaper, 'arxivId' | 'title'>) {
  const title = String(paper.title ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  return `${paper.arxivId}_${title || 'Untitled'}.pdf`;
}

function shouldRetryResponse(response: PdfResponse) {
  return response.status === 429 || response.status >= 500;
}

async function fetchWithRetry(url: string, { fetchImpl, sleep = delay, maxAttempts = 4, signal, network }: Pick<PdfDownloadOptions, 'sleep' | 'maxAttempts' | 'signal' | 'network'> & { fetchImpl: PdfFetch }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal, headers: { 'User-Agent': 'paper-knowledge-engine/1.0' },
        ...(network?.httpProxy === undefined ? {} : { proxy: network.httpProxy }) });
      if (!shouldRetryResponse(response) || attempt === maxAttempts) return response;
      lastError = new Error(`PDF download HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (!transientCodes.has(String(errorField(error, 'code'))) || attempt === maxAttempts) throw error;
    }
    await sleep(1000 * (2 ** (attempt - 1)));
  }
  throw lastError;
}

export async function downloadAcceptedPdf(
  input: unknown,
  {
    fetchImpl = fetch,
    sleep = delay,
    maxAttempts = 4,
    pdfRoot,
    tempRoot,
    stateStore,
    categories = {},
    signal,
    network,
  }: PdfDownloadOptions,
): Promise<LocalPaper & { pdfUrl: string; primaryTrack: string; skipped?: string; duplicateOf?: string; bytes?: number }> {
  const decision = readPdfDecision(input);
  if (!decision.accepted) throw new Error('cannot download a hard-filtered exclusion');
  const paper = { ...decision.paper, primaryTrack: decision.primaryTrack ?? '99-Unclassified' };
  const existing = stateStore.findByBaseId(paper.baseId);
  if (existing && Number(existing.version) > Number(paper.version)) {
    throw new Error(`拒绝下载旧版本 ${paper.arxivId}；已发现 v${existing.version}，请更新任务检索窗口`);
  }
  if (existing && Number(existing.downloaded_version) === Number(paper.version)
    && existing.pdf_path && existing.sha256 && await hasVerifiedPdf(existing)) {
    return {
      ...paper,
      primaryTrack: existing.primary_track ?? existing.primaryTrack ?? paper.primaryTrack,
      pdfPath: existing.pdf_path,
      sha256: existing.sha256,
      skipped: 'existing-version',
    };
  }

  await mkdir(tempRoot, { recursive: true });
  let body;
  let status = 200;
  let contentType = 'application/pdf';
  const response = await fetchWithRetry(paper.pdfUrl, { fetchImpl, sleep, maxAttempts, signal, network });
  status = response.status;
  contentType = response.headers?.get?.('content-type') ?? '';
  if (response.status === 404 || response.status === 410) throw new PdfUnavailableError(paper, response.status);
  const bytes = await response.arrayBuffer();
  body = bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(new Uint8Array(bytes));
  if (!response.ok) throw new Error(`PDF download HTTP ${response.status}`);
  if (status < 200 || status >= 300 || !contentType.toLowerCase().includes('pdf') || body.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('response is not a valid PDF');
  }
  if (body.length > 200 * 1024 * 1024) throw new Error('PDF exceeds 200MB');
  const pageCount = (await PDFDocument.load(body, { ignoreEncryption: false })).getPageCount();
  if (pageCount > 200) throw new Error('PDF exceeds 200 pages');

  const sha256 = createHash('sha256').update(body).digest('hex');
  const latest = stateStore.findByBaseId(paper.baseId);
  if (latest && Number(latest.version) > Number(paper.version)) throw new Error('stale version：下载期间已发现新版本');
  const duplicate = stateStore.findBySha256(sha256);
  if (duplicate?.pdf_path) {
    if (!(await hasVerifiedPdf(duplicate))) {
      const repairPath = join(tempRoot, `${paper.baseId}-v${paper.version}.part`);
      await mkdir(dirname(duplicate.pdf_path), { recursive: true });
      try {
        await writeFile(repairPath, body, { flag: 'wx' });
        await rename(repairPath, duplicate.pdf_path);
      } finally { await rm(repairPath, { force: true }); }
    }
    if (duplicate.base_id !== paper.baseId) {
      if (!stateStore.markExcluded) throw new Error('PDF store must record duplicate exclusions');
      stateStore.markExcluded(paper.baseId, `duplicate-content:${duplicate.base_id}`, paper.version);
      return { ...paper, pdfPath: duplicate.pdf_path, skipped: 'duplicate-content', duplicateOf: duplicate.base_id, sha256 };
    }
    stateStore.markDownloaded(paper.baseId, duplicate.pdf_path, paper.primaryTrack, sha256, paper.version);
    return { ...paper, pdfPath: duplicate.pdf_path, skipped: 'duplicate-content', sha256, bytes: body.length, pageCount };
  }

  const category = categories[paper.primaryTrack]?.pdf ?? '99-Unclassified';
  const destinationDirectory = join(pdfRoot, category);
  await mkdir(destinationDirectory, { recursive: true });
  const temporary = join(tempRoot, `${paper.baseId}-v${paper.version}.part`);
  const destination = join(destinationDirectory, safePaperFilename(paper));
  try {
    await writeFile(temporary, body, { flag: 'wx' });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  stateStore.markDownloaded(paper.baseId, destination, paper.primaryTrack, sha256, paper.version);
  return { ...paper, pdfPath: destination, sha256, bytes: body.length, pageCount };
}
