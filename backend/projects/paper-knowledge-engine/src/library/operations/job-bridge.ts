import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { admitOperation, listOperations, readOperation, readOperationEvents, resumeOperation, readOperationRecord, saveOperationRecord, withAdmission } from './operation-store.ts';
import { executeOperation, failOperationLaunch } from '../workflow.ts';
import { exact, identifier, requestIdentifier, operationError, publicError, validateRequest } from './operation-contracts.ts';
import { processIdentity } from '../../runtime/run-lock.ts';
import { importRootViews, previewLocalImport } from '../sources/import-preview.ts';
import { asLibraryId, type LibraryId } from '../../shared/identity.ts';
import { loadEngineContext, parseLibrarySelection } from '../../shared/engine-context.ts';

export interface BridgeContext { root: string; libraryId?: LibraryId; dataRoot?: string; operationsRoot?: string; launch?: (jobId: string) => Promise<void>; now?: () => number }
/** Root and launch dependency belong to the local dispatcher, never to stdin/browser payloads. */
export async function dispatchBridge(input: unknown, context: BridgeContext): Promise<unknown> {
  exact(input, ['command', 'payload']);
  const { command, payload } = input;
  const libraryId = context.libraryId ?? asLibraryId('fsd');
  if (!['admit', 'execute', 'list', 'get', 'preview', 'resume', 'events', 'info'].includes(String(command))) throw operationError('INVALID_REQUEST');
  if (command === 'info') {
    exact(payload, []);
    const importRoots = importRootViews(context.root);
    const configuredLibraryId = asLibraryId(loadEngineContext({ root: context.root, libraryId }).library.libraryId);
    return { libraryId: configuredLibraryId, capabilities: { collection: true, localPreview: importRoots.length > 0, evidencePublication: true }, protocolVersion: 1, importRoots };
  }
  if (command === 'preview') {
    exact(payload, ['rootId', 'relativePath']); identifier(payload.rootId);
    if (typeof payload.relativePath !== 'string' || /[\\:\x00-\x1f]/.test(payload.relativePath) || payload.relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw operationError('INVALID_REQUEST');
    const operationsRoot = context.operationsRoot ?? loadEngineContext({ root: context.root, libraryId }).paths.operationsRoot;
    return previewLocalImport({ root: context.root, operationsRoot, request: payload, now: context.now });
  }
  // Validate shape before consulting project paths.
  if (command === 'list') exact(payload, []);
  if (command === 'get' || command === 'execute') { exact(payload, ['jobId']); identifier(payload.jobId); }
  if (command === 'events') { exact(payload, ['jobId', 'afterSeq']); identifier(payload.jobId); if (!Number.isSafeInteger(payload.afterSeq) || Number(payload.afterSeq) < 0) throw operationError('INVALID_REQUEST'); }
  if (command === 'resume') { exact(payload, ['jobId', 'requestId']); identifier(payload.jobId); requestIdentifier(payload.requestId); }
  const operationsRoot = context.operationsRoot ?? loadEngineContext({ root: context.root, libraryId }).paths.operationsRoot;
  if (command === 'admit' || command === 'resume') {
    if (command === 'resume') exact(payload, ['jobId', 'requestId']);
    if (command === 'admit' && validateRequest(payload).libraryId !== libraryId) throw operationError('INVALID_REQUEST');
    const result = command === 'admit' ? await admitOperation({ operationsRoot, request: payload, root: context.root, now: context.now })
      : await resumeOperation({ operationsRoot, root: context.root, jobId: String((payload as Record<string, unknown>).jobId), requestId: String((payload as Record<string, unknown>).requestId) });
    if (!result.replayed && context.launch) {
      try { await context.launch(result.job.jobId); }
      catch { result.job = await failOperationLaunch(operationsRoot, result.job.jobId); }
    }
    return result;
  }
  if (command === 'list') return listOperations(operationsRoot);
  // Payload has been checked above; it is never an options bag forwarded to business code.
  exact(payload, command === 'events' ? ['jobId', 'afterSeq'] : ['jobId']);
  identifier(payload.jobId);
  if (command === 'get') return readOperation(operationsRoot, payload.jobId);
  if (command === 'events') { await readOperation(operationsRoot, payload.jobId); return readOperationEvents(operationsRoot, payload.jobId, Number(payload.afterSeq)); }
  return executeOperation({ root: context.root, jobId: payload.jobId }, { operationsRoot, dataRoot: context.dataRoot });
}
/** Fixed Bun child, fixed entrypoint and fixed environment inheritance. No shell and hidden Windows window. */
export async function launchFixedOperation(root: string, operationsRoot: string, libraryId: LibraryId, jobId: string): Promise<void> {
  identifier(jobId);
  const cliPath = fileURLToPath(new URL('../../cli.ts', import.meta.url));
  const child = Bun.spawn([process.execPath, cliPath, '--library', libraryId, '--worker', '--job-id', jobId], { cwd: root, windowsHide: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  try {
    const pid = child.pid; const startedAt = pid ? processIdentity(pid) : undefined;
    if (!pid || !startedAt) throw operationError('LAUNCH_FAILED');
    await withAdmission(operationsRoot, () => {
      const job = readOperationRecord(operationsRoot, jobId);
      if (job.status !== 'accepted') throw operationError('NOT_RESUMABLE');
      job.owner = { pid, startedAt }; saveOperationRecord(operationsRoot, job);
    });
    child.unref();
  } catch (error) { child.kill(); throw error; }
}
export async function bridgeMain(argv: string[]): Promise<number | undefined> {
  try {
    const selection = parseLibrarySelection(argv);
    if (!selection.libraryId) throw operationError('INVALID_REQUEST');
    const libraryId = asLibraryId(selection.libraryId);
    if (selection.argv.length && (selection.argv.length !== 1 || selection.argv[0] !== '--dispatch')) throw operationError('INVALID_REQUEST');
    let raw = '';
    for await (const chunk of process.stdin) { raw += String(chunk); if (Buffer.byteLength(raw) > 65536) throw operationError('INVALID_REQUEST'); }
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw operationError('INVALID_REQUEST'); }
    const root = process.cwd();
    const paths = loadEngineContext({ root, libraryId }).paths;
    const result = await dispatchBridge(input, { root, libraryId, dataRoot: paths.dataRoot, operationsRoot: paths.operationsRoot, ...(selection.argv[0] === '--dispatch' ? { launch: (jobId: string) => launchFixedOperation(root, paths.operationsRoot, libraryId, jobId) } : {}) });
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: publicError(error) })}\n`); return 1;
  }
}
