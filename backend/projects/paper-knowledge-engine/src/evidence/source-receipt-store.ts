import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalJson } from '../shared/manifest.ts';
import { sourceDate, sourceText } from '../research/source-normalizer.ts';
import { requireSourceHash, requireVersionId } from '../research/source-identity.ts';
import { replaceFileWithRetry } from './atomic-replace.ts';

export interface SourcePublicationSourceReceipt {
  readonly sourceId: string;
  readonly versionId: string;
  readonly archiveManifestSha256: string;
  readonly evidenceManifestSha256: string;
}

export interface SourcePublicationReceipt {
  readonly schemaVersion: 1;
  readonly publisherVersion: 1;
  readonly runId: string;
  readonly publicationId: string;
  readonly publishedAt: string;
  readonly contentSha256: string;
  readonly sources: readonly SourcePublicationSourceReceipt[];
}

export type SourcePublicationReceiptInput = Omit<SourcePublicationReceipt, 'publishedAt'>;

export class SourceReceiptError extends Error {
  readonly code: 'SOURCE_RECEIPT_CONFLICT' | 'SOURCE_RECEIPT_IO';

  constructor(message: string, code: SourceReceiptError['code'] = 'SOURCE_RECEIPT_CONFLICT', cause?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'SourceReceiptError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const receiptKeys = ['contentSha256', 'publicationId', 'publishedAt', 'publisherVersion', 'runId', 'schemaVersion', 'sources'];
const sourceKeys = ['archiveManifestSha256', 'evidenceManifestSha256', 'sourceId', 'versionId'];
const sourceIdPattern = /^[0-9a-f]{32}$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new SourceReceiptError(`invalid ${label}`);
  }
  return sourceText(value);
}

function readSource(value: unknown): SourcePublicationSourceReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceReceiptError('invalid receipt source');
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, sourceKeys) || typeof record.sourceId !== 'string' || !sourceIdPattern.test(record.sourceId)) {
    throw new SourceReceiptError('invalid receipt source schema');
  }
  const versionId = requireVersionId(record.versionId);
  const archiveManifestSha256 = requireSourceHash(record.archiveManifestSha256);
  const evidenceManifestSha256 = requireSourceHash(record.evidenceManifestSha256);
  return { sourceId: record.sourceId, versionId, archiveManifestSha256, evidenceManifestSha256 };
}

function compareSource(left: SourcePublicationSourceReceipt, right: SourcePublicationSourceReceipt): number {
  return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1
    : left.versionId < right.versionId ? -1 : left.versionId > right.versionId ? 1 : 0;
}

function readReceipt(value: unknown): SourcePublicationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceReceiptError('receipt is not an object');
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, receiptKeys) || record.schemaVersion !== 1 || record.publisherVersion !== 1 || !Array.isArray(record.sources)) {
    throw new SourceReceiptError('receipt has an invalid schema');
  }
  const runId = requiredText(record.runId, 'runId');
  const publicationId = requiredText(record.publicationId, 'publicationId');
  const publishedAt = sourceDate(requiredText(record.publishedAt, 'publishedAt'));
  const contentSha256 = requireSourceHash(record.contentSha256);
  const sources = record.sources.map(readSource).sort(compareSource);
  for (let index = 1; index < sources.length; index += 1) {
    if (compareSource(sources[index - 1]!, sources[index]!) === 0) throw new SourceReceiptError('receipt contains duplicate source/version');
  }
  return { schemaVersion: 1, publisherVersion: 1, runId, publicationId, publishedAt, contentSha256, sources };
}

function canonicalReceipt(value: SourcePublicationReceipt): string {
  return canonicalJson({ ...value, sources: [...value.sources].sort(compareSource) });
}

/** Parse only canonical bytes with the exact source receipt schema. */
export function parseSourcePublicationReceipt(contents: string): SourcePublicationReceipt {
  try {
    const parsed = readReceipt(JSON.parse(contents));
    if (canonicalReceipt(parsed) !== contents) throw new SourceReceiptError('receipt is not canonical JSON');
    return parsed;
  } catch (error) {
    if (error instanceof SourceReceiptError) throw error;
    throw new SourceReceiptError('receipt is unreadable');
  }
}

export async function readSourcePublicationReceipt(path: string): Promise<SourcePublicationReceipt | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new SourceReceiptError('receipt is not a real file');
    return parseSourcePublicationReceipt(await readFile(path, 'utf8'));
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SourceReceiptError) throw error;
    throw new SourceReceiptError('receipt is unreadable', 'SOURCE_RECEIPT_IO', error);
  }
}

export function equivalentSourceReceipt(left: SourcePublicationReceipt, right: SourcePublicationReceiptInput): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.publisherVersion === right.publisherVersion
    && left.runId === right.runId
    && left.publicationId === right.publicationId
    && left.contentSha256 === right.contentSha256
    && canonicalJson([...left.sources].sort(compareSource)) === canonicalJson([...right.sources].sort(compareSource));
}

async function writeReceiptAtomically(path: string, contents: string): Promise<void> {
  const temporary = `${path}.new`;
  await mkdir(dirname(path), { recursive: true });
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new SourceReceiptError('receipt is not a real file');
  } catch (error) {
    if (error instanceof SourceReceiptError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    const info = await lstat(temporary);
    if (info.isSymbolicLink()) throw new SourceReceiptError('receipt temporary is a symlink or junction');
    throw new SourceReceiptError('receipt temporary already exists');
  } catch (error) {
    if (error instanceof SourceReceiptError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(temporary, contents, { flag: 'wx' });
  try { await replaceFileWithRetry(temporary, path); }
  catch (error) { throw new SourceReceiptError('receipt replacement failed; temporary bytes retained', 'SOURCE_RECEIPT_IO', error); }
}

export async function recoverSourcePublicationReceiptTemporary(input: {
  path: string;
  receipt: SourcePublicationReceiptInput;
}): Promise<void> {
  const temporary = `${input.path}.new`;
  let temporaryBytes: Uint8Array;
  try {
    const info = await lstat(temporary);
    if (info.isSymbolicLink()) throw new SourceReceiptError('receipt temporary is a symlink or junction');
    temporaryBytes = await readFile(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof SourceReceiptError) throw error;
    throw new SourceReceiptError('receipt temporary is unreadable', 'SOURCE_RECEIPT_IO', error);
  }
  const contents = Buffer.from(temporaryBytes).toString('utf8');
  const candidate = parseSourcePublicationReceipt(contents);
  if (!equivalentSourceReceipt(candidate, input.receipt)) throw new SourceReceiptError('receipt temporary differs from this publication');
  const existing = await readSourcePublicationReceipt(input.path);
  if (existing) {
    if (!equivalentSourceReceipt(existing, input.receipt)) throw new SourceReceiptError('existing receipt differs from temporary receipt');
    await unlink(temporary);
    return;
  }
  try { await replaceFileWithRetry(temporary, input.path); }
  catch (error) { throw new SourceReceiptError('receipt recovery replacement failed', 'SOURCE_RECEIPT_IO', error); }
}

export async function createOrReplaySourceReceipt(input: {
  path: string;
  receipt: SourcePublicationReceiptInput;
  publishedAt?: string;
}): Promise<{ status: 'created' | 'replayed'; receipt: SourcePublicationReceipt }> {
  const existing = await readSourcePublicationReceipt(input.path);
  if (existing) {
    if (!equivalentSourceReceipt(existing, input.receipt)) throw new SourceReceiptError('existing receipt differs from this publication');
    return { status: 'replayed', receipt: existing };
  }
  const created = readReceipt({ ...input.receipt, publishedAt: input.publishedAt ?? new Date().toISOString() });
  await writeReceiptAtomically(input.path, canonicalReceipt(created));
  return { status: 'created', receipt: created };
}
