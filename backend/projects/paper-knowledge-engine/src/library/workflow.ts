import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../shared/config.ts';
import { loadMinerULocalConfig } from '../mineru/mineru-local-config.ts';
import { createMineruApiSession, type MineruApiSession } from '../mineru/mineru-api-session.ts';
import { withRunLock, currentOwner, assertNoUnconfirmedProcesses, assertLockAvailable } from '../runtime/run-lock.ts';
import { appendOperationEvent, assertWriterBoundary, captureOperationPolicy, jobView, readOperationRecord, saveOperationRecord, withAdmission, fingerprint, type OperationRecord } from './operations/operation-store.ts';
import { operationError, publicError, record, identifier, type JobView, type Operation, type InternalOperation } from './operations/operation-contracts.ts';
import type { ProgressReporter } from '../types/jobs.ts';
import { progressStage } from '../shared/progress.ts';
import { readConfirmedImport, type ImportScan } from './sources/import-preview.ts';
import { createProcessContext } from '../runtime/process.ts';
import type { LibraryId } from '../shared/identity.ts';
import { loadEngineContext } from '../shared/engine-context.ts';
import type { LibraryKind } from '../types/config.ts';
import { runConfiguredTask, bootstrapLibrary, parseLocalPaper, importLocalSources, publishLibraryEvidence, reconcileLibrary, type ResearchExecutionContext } from './execution.ts';
import { resolveTaskWindow } from './schedule/run-window.ts';
import type { CleanupPlanInput } from '../maintenance/cleanup-plan.ts';

export interface WorkflowContext { root: string; jobId: string; libraryId: LibraryId; resumeRunId?: string; onProgress: ProgressReporter; signal?:AbortSignal; confirmedImport?: ImportScan; mineruSession?: MineruApiSession }
export interface WorkflowDependencies {
  operationsRoot?: string; dataRoot?: string; onProgress?: ProgressReporter; signal?:AbortSignal;
  mineruSession?: MineruApiSession;
  createMineruSession?: (root: string, signal?: AbortSignal) => MineruApiSession;
  /** Local CLI only. Raw business results never enter the job record or bridge return value. */
  onResult?: (result: unknown) => void;
  research?: ResearchExecutionContext;
  runTask?: (operation: Extract<Operation, { kind: 'current' | 'weekly' }>, context: WorkflowContext) => Promise<unknown>;
  importLocal?: (operation: Extract<Operation | InternalOperation, { kind: 'import' | 'import-local' }>, context: WorkflowContext) => Promise<unknown>;
  publishEvidence?: (runId: string, context: WorkflowContext) => Promise<unknown>;
  internal?: (operation: InternalOperation, context: WorkflowContext) => Promise<unknown>;
}

/** Ordinary runtime cleanup is limited to current work and Trellis caches. */
export function libraryCleanupInput(root: string, libraryId: LibraryId): CleanupPlanInput {
  return {
    libraryPaths: loadEngineContext({ root, libraryId }).paths,
    projectRoot: root,
  };
}
function persistedErrorCode(errorClass: unknown): string | undefined {
  if (errorClass === 'process_cleanup_unconfirmed') return 'PROCESS_CLEANUP_UNCONFIRMED';
  return typeof errorClass === 'string' ? errorClass : undefined;
}
function needsMineruSession(operation: Operation | InternalOperation, libraryKind: 'paper' | 'research'): boolean {
  if (libraryKind === 'research') return false;
  return operation.kind === 'current'
    || operation.kind === 'weekly'
    || operation.kind === 'import'
    || operation.kind === 'import-local'
    || operation.kind === 'parse-local';
}
function configuredLibraryKind(root: string, libraryId: LibraryId): LibraryKind {
  // Unit/bridge fixtures may intentionally omit layered configuration. Real
  // configured libraries must still fail loudly on malformed configuration.
  if (!existsSync(join(root, 'config', libraryId, 'library.yaml'))) return 'paper';
  return loadEngineContext({ root, libraryId }).library.kind;
}
export function taskArguments(operation: Extract<Operation, { kind: 'current' | 'weekly' | 'backfill' }>): string[] {
  return ['--mode', operation.kind, ...('limit' in operation && operation.limit !== undefined ? ['--limit', String(operation.limit)] : []),
    ...(operation.from ? ['--from', operation.from, '--to', operation.to!] : [])];
}
async function business(operation: Operation | InternalOperation, context: WorkflowContext, job: OperationRecord, dependencies: WorkflowDependencies): Promise<unknown> {
  if (operation.kind === 'evidence-publish') {
    if (dependencies.publishEvidence) return dependencies.publishEvidence(operation.runId, context);
    return publishLibraryEvidence(operation.runId, context);
  }
  if (operation.kind === 'current' || operation.kind === 'weekly' || operation.kind === 'backfill') {
    if (operation.kind !== 'backfill' && dependencies.runTask) return dependencies.runTask(operation, context);
    const configured = dependencies.research ? { ...context, research: dependencies.research } : context;
    return runConfiguredTask({ mode: operation.kind, ...('limit' in operation ? { limit: operation.limit } : {}), window: resolveTaskWindow(operation.from, operation.to) }, context.root, configured as never);
  }
  if (operation.kind === 'import' || operation.kind === 'import-local') {
    if (operation.kind === 'import') {
      if (!job.confirmedImport) throw operationError('PREVIEW_EXPIRED');
      const confirmedImport = await readConfirmedImport({ root: context.root, operationsRoot: dependencies.operationsRoot ?? loadEngineContext({ root: context.root, libraryId: context.libraryId }).paths.operationsRoot, confirmed: job.confirmedImport });
      const controlled = { ...context, confirmedImport };
      if (dependencies.importLocal) return dependencies.importLocal(operation, controlled);
      return importLocalSources({ path: confirmedImport.path, reparse: operation.reparse }, controlled);
    }
    if (dependencies.importLocal) return dependencies.importLocal(operation, context);
    return importLocalSources({ path: operation.path, reparse: operation.reparse }, context);
  }
  if (dependencies.internal) return dependencies.internal(operation, context);
  switch (operation.kind) {
    case 'bootstrap': return bootstrapLibrary(context);
    case 'parse-local': return parseLocalPaper({ baseId: operation.baseId, reparse: operation.reparse }, context);
    case 'reconcile': return reconcileLibrary({ baseId: operation.baseId, keepPath: operation.keepPath }, context);
  }
}
function bindRun(job: OperationRecord, runId: unknown): void {
  if (runId === undefined) return;
  identifier(runId);
  if (job.runId && job.runId !== runId) throw operationError('RUN_ID_MISMATCH');
  job.runId = runId;
}
/** Only registered accepted jobs execute. Pipeline owns its separate paper-sync lock. */
export async function executeOperation(input: { root: string; jobId: string }, dependencies: WorkflowDependencies = {}): Promise<JobView> {
  identifier(input.jobId);
  const operationsRoot = dependencies.operationsRoot ?? loadEngineContext({ root: input.root }).paths.operationsRoot;
  // Read before creating any lock or invoking a business dependency.
  readOperationRecord(operationsRoot, input.jobId);
  assertNoUnconfirmedProcesses(join(operationsRoot, 'locks', 'processes'));
  return withRunLock(join(operationsRoot, 'locks', 'workflow.lock'), async () => {
    assertNoUnconfirmedProcesses(join(operationsRoot, 'locks', 'processes'));
    assertLockAvailable(join(operationsRoot, 'locks', 'paper-sync.lock'));
    const job = readOperationRecord(operationsRoot, input.jobId);
    if (job.status !== 'accepted') throw operationError('NOT_RESUMABLE');
    if (job.request.operation.kind === 'parse-local') job.stage = 'parse';
    job.owner = currentOwner(); job.status = 'running'; job.updatedAt = new Date().toISOString();
    saveOperationRecord(operationsRoot, job);
    appendOperationEvent(operationsRoot, { jobId: job.jobId, stage: job.stage, type: 'running' });
    const persist = () => { job.updatedAt = new Date().toISOString(); saveOperationRecord(operationsRoot, job); };
    const createOwnedMineruSession = dependencies.createMineruSession
      ?? ((root: string, signal?: AbortSignal) => createMineruApiSession({
        config: { ...loadConfig({ root, libraryId: job.libraryId }), ...loadMinerULocalConfig(root, {
          stateRoot: dependencies.dataRoot ?? loadEngineContext({ root, libraryId: job.libraryId }).paths.dataRoot,
          libraryId: job.libraryId,
        }) },
        processContext: createProcessContext(root, join(operationsRoot, 'locks', 'processes')),
        signal,
      }));
    let ownedMineruSession: MineruApiSession | undefined;
    let disposeError: unknown;
    const context: WorkflowContext = { root: input.root, jobId: job.jobId, libraryId: job.libraryId, signal:dependencies.signal, mineruSession: dependencies.mineruSession,
      ...(job.attempts.length > 1 && job.runId ? { resumeRunId: job.runId } : {}),
      onProgress: event => {
        bindRun(job, event.runId);
        job.stage = progressStage(event, job.stage);
        if (event.current !== undefined) job.current = event.current;
        if (event.total !== undefined) job.total = event.total;
        if (event.type === 'task-start') {
          const identity = { ...(event.window ? { window: event.window } : {}), ...(event.requestedLimit !== undefined ? { requestedLimit: event.requestedLimit } : {}),
            ...(event.inputFingerprint ? { fingerprint: event.inputFingerprint } : {}) };
          if (Object.keys(identity).length) {
            if (job.inputIdentity && fingerprint(identity) !== fingerprint(job.inputIdentity)) throw operationError('INPUT_CHANGED');
            job.inputIdentity = identity;
          }
        }
        if (event.errorClass) {
          const code = persistedErrorCode(event.errorClass);
          job.error = publicError(code ? { code } : { code: event.errorClass });
        }
        appendOperationEvent(operationsRoot, { jobId: job.jobId, stage: job.stage, type: event.type, current: event.current, total: event.total, baseId: event.baseId });
        persist();
        dependencies.onProgress?.(event);
      } };
    let returnedResult: unknown;
    let hasReturnedResult = false;
    try {
      const libraryKind = configuredLibraryKind(input.root, job.libraryId);
      if (!context.mineruSession && needsMineruSession(job.request.operation, libraryKind)) {
        ownedMineruSession = createOwnedMineruSession(input.root, dependencies.signal);
        context.mineruSession = ownedMineruSession;
      }
      const current = captureOperationPolicy(input.root, job.libraryId);
      if (current.collectionHash !== job.policy.collectionHash) throw operationError('POLICY_CHANGED');
      const result = await business(job.request.operation, context, job, dependencies);
      // A failed ParseReport/import summary is still a returned business result.
      // Keep it for the local CLI before mapping its failure into the public job.
      returnedResult = result;
      hasReturnedResult = record(result);
      if (!record(result)) {
        if (job.request.operation.kind !== 'bootstrap') throw operationError('OPERATION_FAILED');
        job.status = 'completed';
      } else {
        bindRun(job, result.runId);
        switch (result.status) {
          case 'disabled': job.status = 'blocked'; job.error = publicError(operationError('WEEKLY_DISABLED')); break;
          case 'failed': {
            const failure = publicError(result.cleanupConfirmed === false || result.errorCode === 'PROCESS_CLEANUP_UNCONFIRMED'
              ? { code: 'PROCESS_CLEANUP_UNCONFIRMED' } : result);
            throw operationError(failure.code === 'OPERATION_FAILED' ? job.error?.code ?? failure.code : failure.code);
          }
          case 'completed': case 'already_processed': case 'succeeded': case 'skipped': case 'applied': job.status = 'completed'; break;
          default:
            if (['bootstrap', 'reconcile'].includes(job.request.operation.kind)) job.status = 'completed';
            else throw operationError('OPERATION_FAILED');
        }
      }
      job.canResume = false;
      hasReturnedResult = true;
    } catch (error) {
      job.status = 'failed'; job.canResume = true;
      const safe = publicError(error);
      job.error = safe.code === 'OPERATION_FAILED' && job.error ? job.error : safe;
    } finally {
      if (ownedMineruSession) {
        try {
          await ownedMineruSession.dispose();
        } catch (error) {
          disposeError = error;
        }
      }
    }
    if (disposeError) {
      job.status = 'failed';
      job.canResume = true;
      const safe = publicError(disposeError);
      job.error = safe.code === 'OPERATION_FAILED' && job.error ? job.error : safe;
    }
    persist(); appendOperationEvent(operationsRoot, { jobId: job.jobId, stage: job.stage, type: job.status.replaceAll('_', '-') });
    if (hasReturnedResult && !disposeError) dependencies.onResult?.(returnedResult);
    return jobView(job);
  }, { jobId: input.jobId });
}
/** Dispatcher catches a fixed child's launch failure while it still owns admission state. */
export async function failOperationLaunch(operationsRoot: string, jobId: string): Promise<JobView> {
  return withAdmission(operationsRoot, () => {
    const job = readOperationRecord(operationsRoot, jobId);
    if (job.status !== 'accepted') return jobView(job);
    assertWriterBoundary(operationsRoot);
    job.status = 'failed'; job.canResume = true; job.error = publicError(operationError('LAUNCH_FAILED')); job.updatedAt = new Date().toISOString();
    saveOperationRecord(operationsRoot, job); appendOperationEvent(operationsRoot, { jobId, stage: job.stage, type: 'launch-failed' });
    return jobView(job);
  });
}
