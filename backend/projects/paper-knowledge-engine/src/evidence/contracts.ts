import { canonicalJson, hashCanonical, normalizeArchivePath } from '../shared/manifest.ts';
export { validateArchiveSourceV2, type ArchiveSourceV2, type FrozenSourceMetadata } from '../shared/archive-v2.ts';

/** Read projection only: v2 metadata and manifest remain separate on disk. */
export type EvidenceSourceV2 =
  | (Omit<ArchiveSourceV1, 'schemaVersion' | 'normalized'> & { schemaVersion: 2 })
  | (Omit<LocalArchiveSourceV1, 'schemaVersion' | 'normalized'> & { schemaVersion: 2 });

export interface ArchiveSourceV1 {
  schemaVersion: 1;
  baseId: string;
  arxivId: string;
  version: number;
  title: string;
  authors: string[];
  categories: string[];
  matchedTracks: string[];
  published: string;
  updated: string;
  pdfPath: string;
  pdfSha256: string;
  parseAttemptId: string;
  model: 'pipeline' | 'vlm';
  cliBackend: 'pipeline' | 'vlm-engine';
  method: 'auto' | 'txt' | 'ocr';
  pageCount: number;
  normalized: {
    fullMarkdown: 'normalized/full.md';
    pageMarkedText: 'normalized/page-marked.txt';
    pages: 'normalized/pages.json';
    contentList: 'normalized/content-list.json';
  };
  files: { path: string; sha256: string; bytes: number }[];
}

/** A non-arXiv source is deliberately discriminated so it cannot pass as v1 arXiv metadata. */
export interface LocalArchiveSourceV1 {
  schemaVersion: 1;
  sourceKind: 'local_pdf';
  baseId: string;
  version: number;
  title: string;
  pdfPath: string;
  pdfSha256: string;
  parseAttemptId: string;
  parserConfigKey: string;
  model: 'pipeline' | 'vlm';
  cliBackend: 'pipeline' | 'vlm-engine';
  method: 'auto' | 'txt' | 'ocr';
  pageCount: number;
  normalized: ArchiveSourceV1['normalized'];
  files: ArchiveSourceV1['files'];
}

export { canonicalJson, hashCanonical };

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SHA256 = /^[0-9a-f]{64}$/;
const NORMALIZED = {
  fullMarkdown: 'normalized/full.md',
  pageMarkedText: 'normalized/page-marked.txt',
  pages: 'normalized/pages.json',
  contentList: 'normalized/content-list.json',
} as const;
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const SOURCE_KEYS = [
  'schemaVersion', 'baseId', 'arxivId', 'version', 'title', 'authors', 'categories', 'matchedTracks',
  'published', 'updated', 'pdfPath', 'pdfSha256', 'parseAttemptId', 'model', 'cliBackend', 'method',
  'pageCount', 'normalized', 'files',
] as const;
const LOCAL_SOURCE_KEYS = [
  'schemaVersion', 'sourceKind', 'baseId', 'version', 'title', 'pdfPath', 'pdfSha256', 'parseAttemptId',
  'parserConfigKey', 'model', 'cliBackend', 'method', 'pageCount', 'normalized', 'files',
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${label} contains unknown field ${key}`);
  for (const key of keys) if (!(key in value)) throw new TypeError(`${label} is missing required field ${key}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || CONTROL_CHARACTER.test(value)) throw new TypeError(`${label} must be non-empty text without control characters`);
  return value;
}

function identityTextArray(value: unknown, label: string, required = false): string[] {
  if (!Array.isArray(value) || (required && value.length === 0)) throw new TypeError(`${label} must be ${required ? 'a non-empty' : 'an'} text array`);
  const result = value.map((item) => text(item, label));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicate identities`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function sha256(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256.test(result)) throw new TypeError(`${label} must be lowercase SHA-256 hex`);
  return result;
}

function parseEngine(model: unknown, cliBackend: unknown): { model: 'pipeline' | 'vlm'; cliBackend: 'pipeline' | 'vlm-engine' } {
  if ((model !== 'pipeline' && model !== 'vlm') || (cliBackend !== 'pipeline' && cliBackend !== 'vlm-engine')
    || (model === 'pipeline' && cliBackend !== 'pipeline') || (model === 'vlm' && cliBackend !== 'vlm-engine')) {
    throw new TypeError('ArchiveSource model and cliBackend identity is invalid');
  }
  return { model, cliBackend };
}

function parseMethod(value: unknown): 'auto' | 'txt' | 'ocr' {
  if (value !== 'auto' && value !== 'txt' && value !== 'ocr') throw new TypeError('ArchiveSource method is invalid');
  return value;
}

function parseNormalized(value: unknown): ArchiveSourceV1['normalized'] {
  const normalizedInput = record(value, 'normalized');
  exactKeys(normalizedInput, Object.keys(NORMALIZED), 'normalized');
  for (const [key, path] of Object.entries(NORMALIZED)) if (normalizedInput[key] !== path) throw new TypeError(`unknown normalized path for ${key}`);
  return { ...NORMALIZED };
}

function parseFiles(value: unknown): ArchiveSourceV1['files'] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('files must be a non-empty manifest array');
  const normalizedPaths = new Set(Object.values(NORMALIZED));
  const files = value.map((entry) => {
    const file = record(entry, 'manifest file');
    exactKeys(file, ['path', 'sha256', 'bytes'], 'manifest file');
    const path = normalizeArchivePath(text(file.path, 'manifest file path'));
    if (path.startsWith('normalized/') && !normalizedPaths.has(path as typeof NORMALIZED[keyof typeof NORMALIZED])) {
      throw new TypeError(`unknown normalized manifest path ${path}`);
    }
    if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new TypeError('manifest file bytes must be a non-negative safe integer');
    return { path, sha256: sha256(file.sha256, 'manifest file sha256'), bytes: file.bytes };
  });
  const filePaths = new Set(files.map((file) => file.path));
  if (filePaths.size !== files.length) throw new TypeError('manifest contains duplicate file paths');
  for (const path of normalizedPaths) if (!filePaths.has(path)) throw new TypeError(`manifest is missing normalized path ${path}`);
  return files.sort((left, right) => compareText(left.path, right.path));
}

/** Strictly validate new Archive schema v1. Historical source.json must use Task 12's migration adapter. */
export function validateArchiveSource(value: unknown): ArchiveSourceV1 {
  const input = record(value, 'ArchiveSource');
  exactKeys(input, SOURCE_KEYS, 'ArchiveSource');
  if (input.schemaVersion !== 1) throw new TypeError('ArchiveSource schemaVersion must be 1');

  const baseId = text(input.baseId, 'baseId');
  const version = positiveInteger(input.version, 'version');
  const arxivId = text(input.arxivId, 'arxivId');
  if (arxivId !== `${baseId}v${version}`) throw new TypeError('ArchiveSource identity is inconsistent with arxivId and version');
  const { model, cliBackend } = parseEngine(input.model, input.cliBackend);
  const method = parseMethod(input.method);

  return {
    schemaVersion: 1,
    baseId,
    arxivId,
    version,
    title: text(input.title, 'title'),
    authors: identityTextArray(input.authors, 'authors', true),
    categories: identityTextArray(input.categories, 'categories'),
    matchedTracks: identityTextArray(input.matchedTracks, 'matchedTracks'),
    published: text(input.published, 'published'),
    updated: text(input.updated, 'updated'),
    pdfPath: normalizeArchivePath(text(input.pdfPath, 'pdfPath')),
    pdfSha256: sha256(input.pdfSha256, 'pdfSha256'),
    parseAttemptId: text(input.parseAttemptId, 'parseAttemptId'),
    model,
    cliBackend,
    method,
    pageCount: positiveInteger(input.pageCount, 'pageCount'),
    normalized: parseNormalized(input.normalized),
    files: parseFiles(input.files),
  };
}

/** Validate the explicit local-PDF alternative; it intentionally has no arXiv fields. */
export function validateLocalArchiveSource(value: unknown): LocalArchiveSourceV1 {
  const input = record(value, 'LocalArchiveSource');
  exactKeys(input, LOCAL_SOURCE_KEYS, 'LocalArchiveSource');
  if (input.schemaVersion !== 1 || input.sourceKind !== 'local_pdf') throw new TypeError('LocalArchiveSource must be local_pdf schema v1');
  const { model, cliBackend } = parseEngine(input.model, input.cliBackend);
  return {
    schemaVersion: 1,
    sourceKind: 'local_pdf',
    baseId: text(input.baseId, 'baseId'),
    version: positiveInteger(input.version, 'version'),
    title: text(input.title, 'title'),
    pdfPath: normalizeArchivePath(text(input.pdfPath, 'pdfPath')),
    pdfSha256: sha256(input.pdfSha256, 'pdfSha256'),
    parseAttemptId: text(input.parseAttemptId, 'parseAttemptId'),
    parserConfigKey: text(input.parserConfigKey, 'parserConfigKey'),
    model,
    cliBackend,
    method: parseMethod(input.method),
    pageCount: positiveInteger(input.pageCount, 'pageCount'),
    normalized: parseNormalized(input.normalized),
    files: parseFiles(input.files),
  };
}
