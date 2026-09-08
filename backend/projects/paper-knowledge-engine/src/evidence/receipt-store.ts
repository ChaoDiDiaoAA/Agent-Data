import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../shared/manifest.ts';
import { replaceFileWithRetry } from './atomic-replace.ts';

export interface EvidencePublicationSourceReceipt {
  readonly baseId: string;
  readonly version: number;
  readonly archiveManifestSha256: string;
  readonly evidenceManifestSha256: string;
}

interface EvidencePublicationReceiptBase {
  readonly schemaVersion: 1;
  readonly publicationId: string;
  readonly runId: string;
  readonly publishedAt: string;
  readonly contentSha256: string;
  readonly sources: readonly EvidencePublicationSourceReceipt[];
}

export interface EvidencePublicationReceiptV1 extends EvidencePublicationReceiptBase {
  readonly publisherVersion: 1;
}

export interface EvidencePublicationReceiptV2 extends EvidencePublicationReceiptBase {
  readonly publisherVersion: 2;
}

export interface EvidencePublicationReceiptV3 extends EvidencePublicationReceiptBase {
  readonly publisherVersion: 3;
}

export type EvidencePublicationReceipt = EvidencePublicationReceiptV1 | EvidencePublicationReceiptV2 | EvidencePublicationReceiptV3;
export type EvidencePublicationReceiptInput<T extends EvidencePublicationReceipt = EvidencePublicationReceipt> =
  T extends EvidencePublicationReceipt ? Omit<T, 'publishedAt'> : never;

export class EvidenceReceiptError extends Error {
  readonly code: 'EVIDENCE_RECEIPT_CONFLICT' | 'EVIDENCE_IO';

  constructor(message: string, code: 'EVIDENCE_RECEIPT_CONFLICT' | 'EVIDENCE_IO' = 'EVIDENCE_RECEIPT_CONFLICT', cause?: unknown) {
    super(`${code}: ${message}`);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export function equivalentReceipt(left: EvidencePublicationReceipt, right: EvidencePublicationReceiptInput): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.publicationId === right.publicationId
    && left.runId === right.runId
    && left.publisherVersion === right.publisherVersion
    && left.contentSha256 === right.contentSha256
    && canonicalJson(left.sources) === canonicalJson(right.sources);
}

function receipt(value: unknown): EvidencePublicationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvidenceReceiptError('receipt is not an object');
  const valueRecord = value as Record<string, unknown>;
  const keys = Object.keys(valueRecord).sort();
  const expected = ['contentSha256', 'publicationId', 'publishedAt', 'publisherVersion', 'runId', 'schemaVersion', 'sources'];
  if (keys.join('\u0000') !== expected.join('\u0000') || valueRecord.schemaVersion !== 1
    || (valueRecord.publisherVersion !== 1 && valueRecord.publisherVersion !== 2 && valueRecord.publisherVersion !== 3)
    || typeof valueRecord.publicationId !== 'string' || typeof valueRecord.runId !== 'string' || typeof valueRecord.publishedAt !== 'string'
    || typeof valueRecord.contentSha256 !== 'string' || !Array.isArray(valueRecord.sources)) {
    throw new EvidenceReceiptError('receipt has an invalid schema');
  }
  for (const source of valueRecord.sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new EvidenceReceiptError('receipt has an invalid schema');
    const sourceRecord = source as Record<string, unknown>;
    const sourceKeys = Object.keys(sourceRecord).sort();
    const expectedSourceKeys = ['archiveManifestSha256', 'baseId', 'evidenceManifestSha256', 'version'];
    if (sourceKeys.join('\u0000') !== expectedSourceKeys.join('\u0000')
      || typeof sourceRecord.baseId !== 'string' || typeof sourceRecord.version !== 'number'
      || typeof sourceRecord.archiveManifestSha256 !== 'string' || typeof sourceRecord.evidenceManifestSha256 !== 'string') {
      throw new EvidenceReceiptError('receipt has an invalid schema');
    }
  }
  return valueRecord as unknown as EvidencePublicationReceipt;
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  const temporary = `${path}.new`;
  try {
    const info = await lstat(temporary);
    if (info.isSymbolicLink()) throw new EvidenceReceiptError('receipt temporary is a symlink or junction');
    throw new EvidenceReceiptError('receipt temporary already exists');
  } catch (error) {
    if (error instanceof EvidenceReceiptError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(temporary, contents, { flag: 'wx' });
  try {
    await replaceFileWithRetry(temporary, path);
  } catch (error) {
    throw new EvidenceReceiptError('Evidence 文件事务写入失败，恢复材料已保留，请稍后重试', 'EVIDENCE_IO', error);
  }
}

/** Validate the exact inventoried bytes without reopening a migration source. */
export function parsePublicationReceipt(contents: string): EvidencePublicationReceipt {
  try { return receipt(JSON.parse(contents)); }
  catch (error) {
    if (error instanceof EvidenceReceiptError) throw error;
    throw new EvidenceReceiptError('existing receipt is unreadable');
  }
}

export async function readPublicationReceipt(path: string): Promise<EvidencePublicationReceipt | null> {
  try { return parsePublicationReceipt(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof EvidenceReceiptError) throw error;
    throw new EvidenceReceiptError('existing receipt is unreadable');
  }
}

/** Reconcile a crash-left receipt temporary only when it is canonical and for this exact publication. */
export async function recoverPublicationReceiptTemporary<T extends EvidencePublicationReceipt>(input: {
  path: string;
  receipt: EvidencePublicationReceiptInput<T>;
}): Promise<void> {
  const temporary = `${input.path}.new`;
  let temporaryBytes: Uint8Array;
  try { temporaryBytes = await readFile(temporary); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new EvidenceReceiptError('receipt temporary is unreadable'); }
  let candidate: EvidencePublicationReceipt;
  try { candidate = receipt(JSON.parse(Buffer.from(temporaryBytes).toString('utf8'))); }
  catch (error) {
    if (error instanceof EvidenceReceiptError) throw error;
    throw new EvidenceReceiptError('receipt temporary is invalid');
  }
  if (Buffer.from(temporaryBytes).toString('utf8') !== canonicalJson(candidate) || !equivalentReceipt(candidate, input.receipt)) {
    throw new EvidenceReceiptError('receipt temporary is not publisher bytes for this publication');
  }
  const existing = await readPublicationReceipt(input.path);
  if (existing) {
    if (!equivalentReceipt(existing, input.receipt)) throw new EvidenceReceiptError('existing receipt differs from receipt temporary');
    await unlink(temporary);
    return;
  }
  try {
    await replaceFileWithRetry(temporary, input.path);
  } catch (error) {
    throw new EvidenceReceiptError('Evidence 文件事务写入失败，恢复材料已保留，请稍后重试', 'EVIDENCE_IO', error);
  }
}

/** Create one immutable receipt per run, or return the byte-validated equivalent receipt. */
export async function createOrReplayReceipt<T extends EvidencePublicationReceipt>(input: {
  path: string;
  receipt: EvidencePublicationReceiptInput<T>;
}): Promise<{ status: 'created' | 'replayed'; receipt: T }> {
  try {
    const existing = await readPublicationReceipt(input.path);
    if (!existing) throw Object.assign(new Error('receipt does not exist'), { code: 'ENOENT' });
    if (!equivalentReceipt(existing, input.receipt)) throw new EvidenceReceiptError('existing receipt differs from this publication');
    return { status: 'replayed', receipt: existing as T };
  } catch (error) {
    if (error instanceof EvidenceReceiptError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new EvidenceReceiptError('existing receipt is unreadable');
  }

  const created = { ...input.receipt, publishedAt: new Date().toISOString() } as unknown as T;
  await writeAtomically(input.path, canonicalJson(created));
  return { status: 'created', receipt: created };
}

export const receiptPathForRun = (stateRoot: string, runId: string) => join(stateRoot, 'runs', runId, 'evidence', 'publication.json');
