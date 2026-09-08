import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { currentOwner, ownerState, withRunLock, assertLockAvailable, assertNoUnconfirmedProcesses, type ProcessOwner } from '../../runtime/run-lock.ts';
import { identifier, requestIdentifier, validateRequest, operationError, publicError, type JobView, type EventView, type SubmitRequest } from './operation-contracts.ts';
import { confirmLocalImport, type ConfirmedImport } from '../sources/import-preview.ts';
import type { LibraryId } from '../../shared/identity.ts';
import { configurationFiles } from '../../shared/config-files.ts';
import { loadEngineContext } from '../../shared/engine-context.ts';
export type { JobView, EventView } from './operation-contracts.ts';

const timestamp = () => new Date().toISOString();
export function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export interface PolicySnapshot { collectionHash: string }
/** No global credentials, shared secret configuration, or model requests are read here. */
export function captureOperationPolicy(root: string | undefined, libraryId: LibraryId): PolicySnapshot {
  const hashes: Record<string, string> = {};
  if (root) {
    const kind = existsSync(join(root, 'config', libraryId, 'library.yaml'))
      ? loadEngineContext({ root, libraryId }).library.kind
      : 'paper';
    const names = configurationFiles(libraryId, kind);
    const missing: string[] = [];
    for (const name of names) {
      const path = join(root, 'config', name);
      try { hashes[name] = createHash('sha256').update(readFileSync(path)).digest('hex'); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') missing.push(path);
        else throw error;
      }
    }
    if (missing.length > 0 && missing.length < names.length) {
      throw new Error(`INCOMPLETE_LAYERED_CONFIG: missing ${missing.join(', ')}`);
    }
    if (missing.length === names.length) return { collectionHash: fingerprint({}) };
  }
  return { collectionHash: fingerprint(hashes) };
}
export interface OperationRecord extends JobView {
  schemaVersion: 1; request: SubmitRequest; requestHash: string; owner: ProcessOwner;
  attempts: { requestId: string; acceptedAt: string }[]; policy: PolicySnapshot;
  inputIdentity?: Record<string, unknown>;
  confirmedImport?: ConfirmedImport;
}
const jobPath = (operationsRoot: string, jobId: string) => { identifier(jobId); return join(operationsRoot, `${jobId}.json`); };
const eventPath = (operationsRoot: string, jobId: string) => { identifier(jobId); return join(operationsRoot, 'events', `${jobId}.jsonl`); };
/** Shared by persisted reads and the offline history migration. */
export function validateOperationRecord(value: unknown, jobId: string): OperationRecord {
  const record = value as OperationRecord;
  if (!record || record.schemaVersion !== 1 || record.jobId !== jobId || !Array.isArray(record.attempts)) throw operationError('INVALID_REQUEST');
  const request = validateRequest(record.request, true);
  if (record.libraryId !== request.libraryId || record.requestId !== request.requestId || record.requestHash !== fingerprint(request.operation)) {
    throw operationError('INVALID_REQUEST');
  }
  return record;
}
export function readOperationRecord(operationsRoot: string, jobId: string): OperationRecord {
  try {
    const value = JSON.parse(readFileSync(jobPath(operationsRoot, jobId), 'utf8')) as OperationRecord;
    return validateOperationRecord(value, jobId);
  } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw operationError('JOB_NOT_FOUND'); throw error; }
}
/** Caller holds admission or workflow lock. Temp rename keeps readers off partial JSON. */
export function saveOperationRecord(operationsRoot: string, value: OperationRecord): void {
  const path = jobPath(operationsRoot, value.jobId);
  mkdirSync(operationsRoot, { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { flag: 'wx' });
  renameSync(temp, path);
}
export function jobView(job: JobView): JobView {
  return { jobId: job.jobId, libraryId: job.libraryId, requestId: job.requestId, status: job.status, stage: job.stage, updatedAt: job.updatedAt,
    canResume: job.canResume, ...(job.runId ? { runId: job.runId } : {}), ...(job.current !== undefined ? { current: job.current } : {}),
    ...(job.total !== undefined ? { total: job.total } : {}), ...(job.error ? { error: publicError(job.error) } : {}) };
}
export async function readOperation(operationsRoot: string, jobId: string): Promise<JobView> {
  if (jobId.startsWith('legacy-')) {
    const job = (await listOperations(operationsRoot)).find(job => job.jobId === jobId);
    if (!job) throw operationError('JOB_NOT_FOUND'); return job;
  }
  const job = readOperationRecord(operationsRoot, jobId);
  if (['accepted', 'running'].includes(job.status) && ownerState(job.owner) === 'dead') await recoverOnRead(operationsRoot);
  return jobView(readOperationRecord(operationsRoot, jobId));
}
function allRecords(operationsRoot: string): OperationRecord[] {
  let files: string[];
  try { files = readdirSync(operationsRoot); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  return files.filter(name => name.endsWith('.json')).sort().map(name => readOperationRecord(operationsRoot, name.slice(0, -5)));
}
export async function listOperations(operationsRoot: string): Promise<JobView[]> {
  let records = allRecords(operationsRoot);
  if (records.some(job => ['accepted', 'running'].includes(job.status) && ownerState(job.owner) === 'dead')) {
    await recoverOnRead(operationsRoot); records = allRecords(operationsRoot);
  }
  return records.map(jobView);
}
export function readOperationEvents(operationsRoot: string, jobId: string, afterSeq = 0): EventView[] {
  identifier(jobId);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw operationError('INVALID_REQUEST');
  let raw: string;
  try { raw = readFileSync(eventPath(operationsRoot, jobId), 'utf8'); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  // An incomplete final line after process death is not silently treated as a successful event.
  if (raw && !raw.endsWith('\n')) throw operationError('INTERRUPTED');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as EventView).filter(event => event.seq > afterSeq);
}
/** Synchronous single-writer persistence: callback producers never lose unawaited progress. */
export function appendOperationEvent(operationsRoot: string, event: Omit<EventView, 'seq' | 'at'>): EventView {
  const events = readOperationEvents(operationsRoot, event.jobId);
  const output: EventView = { seq: (events.at(-1)?.seq ?? 0) + 1, jobId: event.jobId, stage: event.stage,
    type: /^[a-z][a-z0-9-]{0,63}$/.test(event.type) ? event.type : 'progress', at: timestamp() };
  for (const key of ['current', 'total'] as const) if (Number.isSafeInteger(event[key]) && Number(event[key]) >= 0) output[key] = event[key];
  if (event.baseId && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(event.baseId) && !event.baseId.includes('..')) output.baseId = event.baseId;
  // Free-form messages/errors are deliberately omitted; only typed stage/count/source identity crosses the bridge.
  mkdirSync(join(operationsRoot, 'events'), { recursive: true });
  appendFileSync(eventPath(operationsRoot, event.jobId), `${JSON.stringify(output)}\n`);
  return output;
}
export function assertWriterBoundary(operationsRoot: string): void {
  assertNoUnconfirmedProcesses(join(operationsRoot, 'locks', 'processes'));
  assertLockAvailable(join(operationsRoot, 'locks', 'paper-sync.lock'));
  assertLockAvailable(join(operationsRoot, 'locks', 'workflow.lock'));
}
function recoverInterrupted(operationsRoot: string): OperationRecord[] {
  const jobs = allRecords(operationsRoot);
  for (const job of jobs) if (['accepted', 'running'].includes(job.status) && ownerState(job.owner) === 'dead') {
    // A reader may have observed the pre-terminal record while the worker was
    // atomically saving its terminal state.  The terminal event is written
    // after that save; honor it so recovery cannot resurrect a completed job
    // as interrupted.
    try {
      const last = readOperationEvents(operationsRoot, job.jobId).at(-1);
      if (last && ['completed', 'failed', 'interrupted', 'launch-failed', 'blocked', 'conflict'].includes(last.type)) continue;
    } catch { /* An incomplete event log still requires conservative recovery. */ }
    assertWriterBoundary(operationsRoot);
    job.status = 'interrupted'; job.canResume = true; job.error = publicError(operationError('INTERRUPTED')); job.updatedAt = timestamp();
    saveOperationRecord(operationsRoot, job); appendOperationEvent(operationsRoot, { jobId: job.jobId, stage: job.stage, type: 'interrupted' });
  }
  return jobs;
}
async function recoverOnRead(operationsRoot: string): Promise<void> {
  try { await withAdmission(operationsRoot, () => { recoverInterrupted(operationsRoot); }); }
  catch (error) {
    // Reads remain available when a legacy lock or unconfirmed subprocess prevents recovery.
    if (!['PROJECT_BUSY', 'PROCESS_CLEANUP_UNCONFIRMED'].includes(publicError(error).code)) throw error;
  }
}
export function withAdmission<T>(operationsRoot: string, fn: () => T | Promise<T>): Promise<T> {
  return withRunLock(join(operationsRoot, 'locks', 'operations.lock'), fn, { jobId: 'admission', waitMs: 5000 });
}
export async function admitOperation(input: { operationsRoot: string; request: unknown; root?: string; internal?: boolean; now?: () => number }): Promise<{ job: JobView; replayed: boolean }> {
  const request = validateRequest(input.request, input.internal);
  return withAdmission(input.operationsRoot, async () => {
    const jobs = recoverInterrupted(input.operationsRoot);
    const existing = jobs.find(job => job.attempts.some(attempt => attempt.requestId === request.requestId));
    const hash = fingerprint(request.operation);
    if (existing) {
      if (existing.request.requestId !== request.requestId || existing.requestHash !== hash) throw operationError('REQUEST_CONFLICT');
      return { job: jobView(existing), replayed: true };
    }
    assertWriterBoundary(input.operationsRoot);
    if (jobs.some(job => ['accepted', 'running'].includes(job.status))) throw operationError('PROJECT_BUSY');
    const now = timestamp(); const operation = request.operation;
    const confirmedImport = operation.kind === 'import' ? await confirmLocalImport({ root: input.root ?? process.cwd(), operationsRoot: input.operationsRoot,
      previewId: operation.previewId, reparse: operation.reparse, now: input.now }) : undefined;
    const job: OperationRecord = { schemaVersion: 1, jobId: randomUUID(), libraryId: request.libraryId, requestId: request.requestId,
      request, requestHash: hash, status: 'accepted', stage: operation.kind === 'parse-local' ? 'parse'
        : operation.kind === 'evidence-publish' ? 'evidence-publish' : operation.kind === 'import' || operation.kind === 'import-local' ? 'select' : 'acquire',
      updatedAt: now, canResume: false, owner: currentOwner(), attempts: [{ requestId: request.requestId, acceptedAt: now }],
      policy: captureOperationPolicy(input.root, request.libraryId), ...(confirmedImport ? { confirmedImport } : {}), ...('runId' in operation ? { runId: operation.runId } : {}) };
    saveOperationRecord(input.operationsRoot, job);
    appendOperationEvent(input.operationsRoot, { jobId: job.jobId, stage: job.stage, type: 'accepted' });
    return { job: jobView(job), replayed: false };
  });
}
export async function resumeOperation(input: { operationsRoot: string; jobId: string; requestId: string; root?: string }): Promise<{ job: JobView; replayed: boolean }> {
  identifier(input.jobId); requestIdentifier(input.requestId);
  return withAdmission(input.operationsRoot, () => {
    const jobs = recoverInterrupted(input.operationsRoot); const job = jobs.find(value => value.jobId === input.jobId);
    if (!job) throw operationError('JOB_NOT_FOUND');
    const existing = jobs.find(value => value.attempts.some(attempt => attempt.requestId === input.requestId));
    if (existing) {
      if (existing.jobId !== job.jobId || existing.requestId === input.requestId) throw operationError('REQUEST_CONFLICT');
      return { job: jobView(job), replayed: true };
    }
    assertWriterBoundary(input.operationsRoot);
    if (jobs.some(value => ['accepted', 'running'].includes(value.status))) throw operationError('PROJECT_BUSY');
    if (!job.canResume || !['failed', 'interrupted'].includes(job.status)) throw operationError('NOT_RESUMABLE');
    if (input.root) {
      const current = captureOperationPolicy(input.root, job.libraryId);
      if (current.collectionHash !== job.policy.collectionHash) throw operationError('POLICY_CHANGED');
    }
    job.attempts.push({ requestId: input.requestId, acceptedAt: timestamp() });
    job.status = 'accepted'; job.canResume = false; job.owner = currentOwner(); job.updatedAt = timestamp(); delete job.error;
    saveOperationRecord(input.operationsRoot, job); appendOperationEvent(input.operationsRoot, { jobId: job.jobId, stage: job.stage, type: 'resume-accepted' });
    return { job: jobView(job), replayed: false };
  });
}
