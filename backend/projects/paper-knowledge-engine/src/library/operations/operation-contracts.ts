import { assertLibraryId, type LibraryId } from '../../shared/identity.ts';
import { arxivCooldownHint, validArxivRetryTime } from '../../shared/arxiv-cooldown.ts';

/** Operation boundary types are independent of model and presentation packages. */
export type Stage = 'acquire' | 'select' | 'download' | 'parse' | 'archive' | 'evidence-publish';
export type JobStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'interrupted' | 'blocked' | 'conflict';
export type Operation = { kind: 'current'; limit?: number; from?: string; to?: string }
  | { kind: 'weekly'; from?: string; to?: string }
  | { kind: 'backfill'; limit?: number; from: string; to: string }
  | { kind: 'import'; previewId: string; reparse: boolean }
  | { kind: 'evidence-publish'; runId: string };
export type InternalOperation = { kind: 'bootstrap' } | { kind: 'import-local'; path: string; reparse: boolean }
  | { kind: 'parse-local'; baseId: string; reparse: boolean } | { kind: 'reconcile'; baseId?: string; keepPath?: string };
export interface JobView { jobId: string; libraryId: LibraryId; requestId: string; runId?: string; status: JobStatus; stage: Stage;
  current?: number; total?: number; updatedAt: string; error?: { code: string; message: string; retryNotBefore?: string; retryAfterMs?: number }; canResume: boolean }
export interface EventView { seq: number; jobId: string; stage: Stage; type: string; at: string; current?: number; total?: number; baseId?: string; message?: string }
export interface SubmitRequest { libraryId: LibraryId; requestId: string; operation: Operation | InternalOperation }
export function operationError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function exact(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) throw operationError('INVALID_REQUEST');
}
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) || value === '..') throw operationError('INVALID_REQUEST');
}
export function requestIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw operationError('INVALID_REQUEST');
}
function localPath(value: unknown): void { if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) throw operationError('INVALID_REQUEST'); }
export function validateRequest(value: unknown, internal = false): SubmitRequest {
  exact(value, ['libraryId', 'requestId', 'operation']);
  assertLibraryId(value.libraryId);
  requestIdentifier(value.requestId);
  if (!record(value.operation)) throw operationError('INVALID_REQUEST');
  const operation = value.operation;
  switch (operation.kind) {
    case 'current': case 'weekly': case 'backfill': {
      exact(operation, ['kind'], operation.kind === 'current' || operation.kind === 'backfill' ? ['limit', 'from', 'to'] : ['from', 'to']);
      if (operation.limit !== undefined && (!Number.isSafeInteger(operation.limit) || Number(operation.limit) < 1)) throw operationError('INVALID_REQUEST');
      if (operation.kind === 'backfill' && (typeof operation.from !== 'string' || typeof operation.to !== 'string')) throw operationError('INVALID_REQUEST');
      if (operation.kind !== 'backfill' && (operation.from === undefined) !== (operation.to === undefined)) throw operationError('INVALID_REQUEST');
      for (const date of [operation.from, operation.to]) if (date !== undefined && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw operationError('INVALID_REQUEST');
      if (typeof operation.from === 'string' && typeof operation.to === 'string' && operation.from > operation.to) throw operationError('INVALID_REQUEST');
      break;
    }
    case 'import': exact(operation, ['kind', 'previewId', 'reparse']); identifier(operation.previewId); if (typeof operation.reparse !== 'boolean') throw operationError('INVALID_REQUEST'); break;
    case 'evidence-publish': exact(operation, ['kind', 'runId']); identifier(operation.runId); break;
    default:
      if (!internal) throw operationError('INVALID_REQUEST');
      switch (operation.kind) {
        case 'bootstrap': exact(operation, ['kind']); break;
        case 'import-local': exact(operation, ['kind', 'path', 'reparse']); localPath(operation.path); if (typeof operation.reparse !== 'boolean') throw operationError('INVALID_REQUEST'); break;
        case 'parse-local': exact(operation, ['kind', 'baseId', 'reparse']);
          if (typeof operation.baseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(operation.baseId) || operation.baseId.includes('..')) throw operationError('INVALID_REQUEST');
          if (typeof operation.reparse !== 'boolean') throw operationError('INVALID_REQUEST'); break;
        case 'reconcile': exact(operation, ['kind'], ['baseId', 'keepPath']);
          if ((operation.baseId === undefined) !== (operation.keepPath === undefined)) throw operationError('INVALID_REQUEST');
          if (operation.baseId !== undefined) { localPath(operation.baseId); localPath(operation.keepPath); } break;
        default: throw operationError('INVALID_REQUEST');
      }
  }
  return structuredClone(value) as unknown as SubmitRequest;
}
const codes = new Set(['ARXIV_CAPACITY_LIMITED', 'ARXIV_COOLDOWN_ACTIVE', 'ARXIV_TRANSPORT_UNAVAILABLE', 'INVALID_REQUEST', 'REQUEST_CONFLICT', 'PROJECT_BUSY', 'JOB_NOT_FOUND', 'NOT_RESUMABLE', 'PROCESS_CLEANUP_UNCONFIRMED',
  'PROCESS_IDENTITY_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE', 'CONFIG_REQUIRED', 'SOURCE_NOT_AUTHORIZED', 'BUDGET_EXHAUSTED', 'POLICY_CHANGED', 'PREVIEW_CHANGED', 'PREVIEW_EXPIRED', 'IMPORT_LIMIT_EXCEEDED',
  'INPUT_CHANGED', 'RUN_ID_MISMATCH', 'PARSE_FAILED', 'DOWNLOAD_FAILED', 'LAUNCH_FAILED', 'INTERRUPTED', 'WEEKLY_DISABLED',
  'OPERATION_FAILED', 'EVIDENCE_CONFLICT', 'process_error', 'timeout', 'quality_failed', 'invalid_output',
  'EVIDENCE_IO',
  'process_cleanup_unconfirmed', 'path_too_long', 'cuda_oom', 'system_memory', 'model_missing', 'dependency', 'invalid_artifact',
  'empty_output', 'missing_pages', 'low_text_quality', 'invalid_artifact', 'OLD_SOURCE_UNAVAILABLE']);
/** Never return arbitrary exception text or raw results across the browser boundary. */
export function publicError(error: unknown): { code: string; message: string; retryNotBefore?: string; retryAfterMs?: number } {
  const candidate = record(error) ? error.code ?? error.errorClass : undefined;
  const code = typeof candidate === 'string' && codes.has(candidate) ? candidate : 'OPERATION_FAILED';
  if (code === 'ARXIV_CAPACITY_LIMITED' || code === 'ARXIV_COOLDOWN_ACTIVE') {
    const retryNotBefore = record(error) && validArxivRetryTime(error.retryNotBefore) ? error.retryNotBefore : undefined;
    // jobView sanitizes persisted public errors again. Preserve the numeric
    // delay so zero does not turn back into a cooldown when rendered a second time.
    const retryAfterMs = record(error) && typeof error.retryAfterMs === 'number'
      && Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : undefined;
    return { code, message: `${code}: ${code === 'ARXIV_COOLDOWN_ACTIVE' ? 'arXiv 冷却尚未结束' : 'arXiv 请求受到限流'}；${arxivCooldownHint(retryNotBefore, code === 'ARXIV_CAPACITY_LIMITED' && retryAfterMs === 0)}`,
      ...(retryNotBefore ? { retryNotBefore } : {}), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  if (code === 'ARXIV_TRANSPORT_UNAVAILABLE') {
    const mode = record(error) && ['configured', 'direct', 'inherit'].includes(String(error.proxyMode)) ? String(error.proxyMode) : 'selected';
    const host = record(error) && ['arxiv.org', 'export.arxiv.org'].includes(String(error.apiHost)) ? String(error.apiHost) : 'selected API host';
    return { code, message: `${code}: arXiv 传输不可用（${mode} 路由，API 主机 ${host}）；请检查 API 主机连通性` };
  }
  if (code === 'EVIDENCE_IO') {
    return { code, message: `${code}: Evidence 文件事务写入失败，恢复材料已保留；请稍后重试 Evidence 发布` };
  }
  const candidateMessage = record(error) ? error.message : undefined;
  const safeEvidenceMessage = code === 'EVIDENCE_CONFLICT' && typeof candidateMessage === 'string'
    && [
      /^EVIDENCE_CONFLICT: (?:managed file differs|staging file differs|unexpected install temporary|uncommitted install temporary|journal backup differs): [A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/,
      /^EVIDENCE_CONFLICT: unknown manual file [A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/,
      /^EVIDENCE_CONFLICT: (?:failed run does not have a complete verified Archive set|managed target is incomplete|installed publication cannot be verified)$/,
    ].some(pattern => pattern.test(candidateMessage))
    ? candidateMessage
    : undefined;
  return { code, message: safeEvidenceMessage ?? code };
}
