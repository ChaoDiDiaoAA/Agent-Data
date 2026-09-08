import { loadEngineContext } from '../../shared/engine-context.ts';
import { admitOperation, listOperations, readOperation, readOperationEvents, resumeOperation, type JobView, type EventView } from './operation-store.ts';
import { executeOperation } from '../workflow.ts';
import { launchFixedOperation } from './job-bridge.ts';
import type { SubmitRequest } from './operation-contracts.ts';
import { operationError } from './operation-contracts.ts';
import { asLibraryId, type LibraryId } from '../../shared/identity.ts';

export interface OperationService {
  admit(request: SubmitRequest): Promise<JobView & { replayed: boolean }>;
  read(jobId: string): Promise<JobView>;
  list(): Promise<readonly JobView[]>;
  events(jobId: string, afterSeq: number): EventView[];
  resume(jobId: string, requestId: string): Promise<JobView & { replayed: boolean }>;
  execute(jobId: string): Promise<JobView>;
}

export class BunOperationService implements OperationService {
  constructor(
    private readonly root: string,
    private readonly libraryId: LibraryId = asLibraryId('fsd'),
    private readonly operationsRoot = loadEngineContext({ root, libraryId }).paths.operationsRoot,
  ) {}
  async admit(request: SubmitRequest): Promise<JobView & { replayed: boolean }> {
    if (request.libraryId !== this.libraryId) throw operationError('INVALID_REQUEST');
    const result = await admitOperation({ root: this.root, operationsRoot: this.operationsRoot, request });
    if (!result.replayed) {
      try { await launchFixedOperation(this.root, this.operationsRoot, this.libraryId, result.job.jobId); }
      catch { /* admission remains durably resumable; caller can retry */ }
    }
    return { ...result.job, replayed: result.replayed };
  }
  read(jobId: string): Promise<JobView> { return readOperation(this.operationsRoot, jobId); }
  list(): Promise<readonly JobView[]> { return listOperations(this.operationsRoot); }
  events(jobId: string, afterSeq: number): EventView[] { return readOperationEvents(this.operationsRoot, jobId, afterSeq); }
  async resume(jobId: string, requestId: string): Promise<JobView & { replayed: boolean }> {
    const result = await resumeOperation({ root: this.root, operationsRoot: this.operationsRoot, jobId, requestId });
    if (!result.replayed) {
      try { await launchFixedOperation(this.root, this.operationsRoot, this.libraryId, result.job.jobId); } catch { /* resumable failure is persisted by the dispatcher */ }
    }
    return { ...result.job, replayed: result.replayed };
  }
  execute(jobId: string): Promise<JobView> { return executeOperation({ root: this.root, jobId }, { operationsRoot: this.operationsRoot }); }
}
