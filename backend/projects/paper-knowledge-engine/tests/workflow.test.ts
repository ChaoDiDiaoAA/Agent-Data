import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { admitOperation, captureOperationPolicy, fingerprint, readOperation, readOperationEvents, resumeOperation, saveOperationRecord, type OperationRecord } from '../src/library/operations/operation-store.ts';
import { currentOwner } from '../src/runtime/run-lock.ts';
import { executeOperation } from '../src/library/workflow.ts';
import { loadProjectPaths } from '../src/shared/config.ts';
import { loadMinerULocalConfig } from '../src/mineru/mineru-local-config.ts';
import { asLibraryId } from '../src/shared/identity.ts';

async function fixture(fn: (stateRoot: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const libraryId = asLibraryId('fsd');
const request = { libraryId, requestId: 'start', operation: { kind: 'current' as const, limit: 1 } };
const projectRoot = join(import.meta.dirname, '..');

function createFakeSession() {
  const calls = { ensureReady: 0, run: 0, dispose: 0 };
  const session = {
    async ensureReady() { calls.ensureReady++; return 'http://127.0.0.1:17860'; },
    async run() { calls.run++; return {} as any; },
    async dispose() { calls.dispose++; },
  } as any;
  return { calls, session };
}

function borrowedSession() {
  return createFakeSession().session;
}

for (const retryAfterMs of [0, 60_000]) test(`workflow final and persisted errors retain arXiv delay (${retryAfterMs}ms)`, () => fixture(async stateRoot => {
  const { job } = await admitOperation({operationsRoot:stateRoot,request});
  const result = await executeOperation({root:stateRoot,jobId:job.jobId}, {
    operationsRoot:stateRoot,dataRoot:stateRoot,mineruSession:borrowedSession(),
    runTask:async () => { throw Object.assign(new Error('private-secret'), {
      code:'ARXIV_CAPACITY_LIMITED',retryAfterMs,retryNotBefore:'2026-09-15T13:06:43.952Z',
    }); },
  });
  const persisted = await readOperation(stateRoot,job.jobId);
  for (const value of [result,persisted]) {
    assert.equal(value.status,'failed');
    assert.equal(value.error?.retryAfterMs,retryAfterMs);
    assert.ok(value.error?.message.includes(retryAfterMs === 0 ? '未设置本地冷却' : '冷却至'));
    assert.doesNotMatch(JSON.stringify(value),/private-secret/);
  }
  assert.deepEqual(persisted.error,result.error);
}));

async function createImportJob(stateRoot: string): Promise<string> {
  const snapshotId = randomUUID();
  const fileId = createHash('sha256').update('paper.pdf').digest('hex');
  const pdfDirectory = join(stateRoot, 'import-snapshots', snapshotId, fileId);
  await mkdir(pdfDirectory, { recursive: true });
  const pdfPath = join(pdfDirectory, 'paper.pdf');
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
  await writeFile(pdfPath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const requestId = `import-${snapshotId}`;
  const paths = loadProjectPaths({ root: projectRoot });
  const mineruConfig = loadMinerULocalConfig(projectRoot);
  const policyHash = createHash('sha256').update(JSON.stringify({
    roots: mineruConfig.localImport?.roots ?? [],
    localImport: mineruConfig.localImport,
    excluded: [paths.stateRoot, resolve(projectRoot, paths.vaultRoot), resolve(paths.stateRoot, 'archive')],
  })).digest('hex');
  const request = {
    libraryId,
    requestId,
    operation: { kind: 'import' as const, previewId: 'preview-1', reparse: false },
  };
  const jobId = randomUUID();
  const job: OperationRecord = {
    schemaVersion: 1,
    jobId,
    libraryId,
    requestId,
    request,
    requestHash: fingerprint(request.operation),
    status: 'accepted',
    stage: 'select',
    updatedAt: new Date().toISOString(),
    canResume: false,
    owner: currentOwner(),
    attempts: [{ requestId, acceptedAt: new Date().toISOString() }],
    policy: captureOperationPolicy(projectRoot, libraryId),
    confirmedImport: {
      snapshotId,
      policyHash,
      files: [{ fileId, name: 'paper.pdf', relativePath: 'paper.pdf', sha256, pages: 1, bytes: bytes.length }],
    },
  };
  saveOperationRecord(stateRoot, job);
  return jobId;
}

test('workflow persists FSD progress and completes a collection result without raw output', () => fixture(async stateRoot => {
  const { job } = await admitOperation({ operationsRoot: stateRoot, request });
  const result = await executeOperation({ root: stateRoot, jobId: job.jobId }, { operationsRoot: stateRoot, dataRoot: stateRoot, runTask: async (_operation: unknown, context: any) => {
    context.onProgress({ type: 'task-start', runId: 'run-1', configPath: 'D:/secret' });
    context.onProgress({ type: 'selection-complete', phase: 'selection' });
    context.onProgress({ type: 'download-complete', phase: 'download' });
    context.onProgress({ type: 'archive-complete', phase: 'archive' });
    context.onProgress({ type: 'evidence-publish-complete', phase: 'evidence-publish', publicationId: 'evidence-1' });
    return { status: 'completed', runId: 'run-1', privatePath: 'D:/secret' };
  }, mineruSession: borrowedSession() });
  assert.equal(result.status, 'completed');
  const events = readOperationEvents(stateRoot, job.jobId);
  assert.deepEqual(events.filter(event => event.type.endsWith('-complete')).map(event => event.stage), ['select', 'download', 'archive', 'evidence-publish']);
  assert.doesNotMatch(JSON.stringify({ result, events }), /secret|privatePath/);
}));

test('evidence publication dispatches only the publisher boundary', () => fixture(async stateRoot => {
  const { job } = await admitOperation({ operationsRoot: stateRoot, request: { libraryId: 'fsd', requestId: 'publish', operation: { kind: 'evidence-publish', runId: 'run-1' } } });
  let published = 0;
  const result = await executeOperation({ root: stateRoot, jobId: job.jobId }, { operationsRoot: stateRoot, dataRoot: stateRoot,
    runTask: async () => assert.fail('collection must not run'),
    publishEvidence: async (runId, context) => { published++; assert.equal(runId, 'run-1'); context.onProgress({ type: 'evidence-publish-complete', phase: 'evidence-publish', runId }); return { status: 'completed', runId }; },
  });
  assert.equal(result.status, 'completed'); assert.equal(result.stage, 'evidence-publish'); assert.equal(published, 1);
}));

for (const failureCode of ['PARSE_FAILED', 'ARXIV_CAPACITY_LIMITED', 'ARXIV_COOLDOWN_ACTIVE']) test(`failed collection resumes its same run identity (${failureCode})`, () => fixture(async stateRoot => {
  const { job } = await admitOperation({ operationsRoot: stateRoot, request });
  const failed = await executeOperation({ root: stateRoot, jobId: job.jobId }, { operationsRoot: stateRoot, dataRoot: stateRoot, runTask: async (_operation: unknown, context: any) => {
    context.onProgress({ type: 'task-start', runId: 'run-1' }); throw Object.assign(new Error('private-upstream-diagnostic'), { code: failureCode, retryNotBefore: '2026-09-05T16:45:03.029Z' });
  }, mineruSession: borrowedSession() });
  assert.equal(failed.status, 'failed'); assert.equal(failed.canResume, true);
  assert.equal(failed.error?.code, failureCode);
  assert.doesNotMatch(failed.error?.message ?? '', /private-upstream/);
  if (failureCode.startsWith('ARXIV_')) assert.match(failed.error!.message, /2026-09-06 00:45:03 北京时间/);
  await resumeOperation({ operationsRoot: stateRoot, jobId: job.jobId, requestId: 'resume' });
  const resumed = await executeOperation({ root: stateRoot, jobId: job.jobId }, { operationsRoot: stateRoot, dataRoot: stateRoot, runTask: async (_operation: unknown, context: any) => {
    assert.equal(context.resumeRunId, 'run-1'); return { status: 'completed', runId: 'run-1' };
  }, mineruSession: borrowedSession() });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.runId, 'run-1');
}));

test('unknown work cannot report a success', () => fixture(async stateRoot => {
  await assert.rejects(executeOperation({ root: stateRoot, jobId: 'unknown' }, { operationsRoot: stateRoot, dataRoot: stateRoot }), { code: 'JOB_NOT_FOUND' });
  const { job } = await admitOperation({ operationsRoot: stateRoot, request });
  const result = await executeOperation({ root: stateRoot, jobId: job.jobId }, { operationsRoot: stateRoot, dataRoot: stateRoot, mineruSession: borrowedSession() });
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'OPERATION_FAILED');
}));

test('MinerU operations create and dispose one command-owned session when none is supplied', () => fixture(async stateRoot => {
  const cases = [
    { operation: { kind: 'current' as const }, internal: false, root: stateRoot },
    { operation: { kind: 'weekly' as const }, internal: false, root: stateRoot },
    { operation: { kind: 'import-local' as const, path: 'D:/papers', reparse: false }, internal: true, root: stateRoot },
    { operation: { kind: 'parse-local' as const, baseId: '2608.23146', reparse: false }, internal: true, root: stateRoot },
  ];
  for (const entry of cases) {
    const { calls, session } = createFakeSession();
    const { job } = await admitOperation({
      operationsRoot: stateRoot,
      root: entry.root,
      internal: entry.internal,
      request: { libraryId: 'fsd', requestId: `req-${entry.operation.kind}`, operation: entry.operation },
    });
    const result = await executeOperation({ root: entry.root, jobId: job.jobId }, {
      operationsRoot: stateRoot,
      dataRoot: stateRoot,
      createMineruSession: () => session,
      runTask: async () => ({ status: 'completed', runId: `${entry.operation.kind}-run` }),
      importLocal: async () => ({ status: 'completed', runId: `${entry.operation.kind}-run` }),
      internal: async () => ({ status: 'completed', runId: `${entry.operation.kind}-run` }),
    } as any);
    assert.equal(result.status, 'completed');
    assert.equal(calls.dispose, 1, `${entry.operation.kind} should dispose one owned session`);
  }
  const importJobId = await createImportJob(stateRoot);
  const { calls, session } = createFakeSession();
  const importResult = await executeOperation({ root: projectRoot, jobId: importJobId }, {
    operationsRoot: stateRoot,
    dataRoot: stateRoot,
    createMineruSession: () => session,
    importLocal: async () => ({ status: 'completed', runId: 'import-run' }),
  } as any);
  assert.equal(importResult.status, 'completed');
  assert.equal(calls.dispose, 1, 'import should dispose one owned session');
}));

test('supplied MinerU session is reused and never disposed by executeOperation', () => fixture(async stateRoot => {
  const { calls, session } = createFakeSession();
  const { job } = await admitOperation({ operationsRoot: stateRoot, request });
  const result = await executeOperation({ root: stateRoot, jobId: job.jobId }, {
    operationsRoot: stateRoot,
    dataRoot: stateRoot,
    mineruSession: session,
    runTask: async (_operation: unknown, context: any) => {
      assert.equal(context.mineruSession, session);
      return { status: 'completed', runId: 'run-1' };
    },
  } as any);
  assert.equal(result.status, 'completed');
  assert.equal(calls.dispose, 0);
}));

test('non-MinerU operations create no session', () => fixture(async stateRoot => {
  let created = 0;
  for (const operation of [
    { kind: 'evidence-publish' as const, runId: 'run-1' },
    { kind: 'reconcile' as const },
    { kind: 'bootstrap' as const },
  ]) {
    const { job } = await admitOperation({ operationsRoot: stateRoot, internal: operation.kind !== 'evidence-publish', request: { libraryId: 'fsd', requestId: `req-${operation.kind}`, operation } });
    const result = await executeOperation({ root: stateRoot, jobId: job.jobId }, {
      operationsRoot: stateRoot,
      dataRoot: stateRoot,
      createMineruSession: () => { created++; return createFakeSession().session; },
      publishEvidence: async (runId: string) => ({ status: 'completed', runId }),
      internal: async () => ({ status: 'completed' }),
    } as any);
    assert.equal(result.status, 'completed');
  }
  assert.equal(created, 0);
}));

test('Evidence conflicts retain a bounded safe reason in the failed JobView', () => fixture(async stateRoot => {
  const { job } = await admitOperation({ operationsRoot: stateRoot, request: {
    libraryId: 'fsd', requestId: 'publish-detail', operation: { kind: 'evidence-publish', runId: 'run-1' },
  } });
  const result = await executeOperation({ root: stateRoot, jobId: job.jobId }, {
    operationsRoot: stateRoot,
    dataRoot: stateRoot,
    publishEvidence: async () => { throw Object.assign(new Error('EVIDENCE_CONFLICT: managed file differs: 01-Evidence/index.md'), { code: 'EVIDENCE_CONFLICT' }); },
  });
  assert.equal(result.error?.code, 'EVIDENCE_CONFLICT');
  assert.equal(result.error?.message, 'EVIDENCE_CONFLICT: managed file differs: 01-Evidence/index.md');
}));

test('Evidence errors with unsafe detail remain code-only', () => fixture(async stateRoot => {
  const { job } = await admitOperation({ operationsRoot: stateRoot, request: {
    libraryId: 'fsd', requestId: 'publish-redaction', operation: { kind: 'evidence-publish', runId: 'run-1' },
  } });
  const result = await executeOperation({ root: stateRoot, jobId: job.jobId }, {
    operationsRoot: stateRoot,
    dataRoot: stateRoot,
    publishEvidence: async () => { throw Object.assign(new Error('EVIDENCE_CONFLICT: Bearer secretword'), { code: 'EVIDENCE_CONFLICT' }); },
  });
  assert.deepEqual(result.error, { code: 'EVIDENCE_CONFLICT', message: 'EVIDENCE_CONFLICT' });
}));

test('command-owned MinerU session is disposed on business error', () => fixture(async stateRoot => {
  const { calls, session } = createFakeSession();
  const { job } = await admitOperation({ operationsRoot: stateRoot, request });
  const result = await executeOperation({ root: stateRoot, jobId: job.jobId }, {
    operationsRoot: stateRoot,
    dataRoot: stateRoot,
    createMineruSession: () => session,
    runTask: async () => { throw Object.assign(new Error('parse failed'), { code: 'PARSE_FAILED' }); },
  } as any);
  assert.equal(result.status, 'failed');
  assert.equal(calls.dispose, 1);
}));

test('cleanup-unconfirmed disposal takes priority over a business failure', () => fixture(async stateRoot => {
  const { job } = await admitOperation({ operationsRoot: stateRoot, request });
  const result = await executeOperation({ root: stateRoot, jobId: job.jobId }, {
    operationsRoot: stateRoot,
    dataRoot: stateRoot,
    createMineruSession: () => ({
      async ensureReady() { return 'http://127.0.0.1:17860'; },
      async run() { return { status: 'completed' as const, runId: 'run-1' }; },
      async dispose() { throw Object.assign(new Error('cleanup failed'), { code: 'PROCESS_CLEANUP_UNCONFIRMED' }); },
    }),
    runTask: async () => { throw Object.assign(new Error('parse failed'), { code: 'PARSE_FAILED' }); },
  } as any);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'PROCESS_CLEANUP_UNCONFIRMED');
}));

test('cleanup failure suppresses a successful business result from the public result channel', () => fixture(async stateRoot => {
  const { job } = await admitOperation({ operationsRoot: stateRoot, request });
  const emitted: unknown[] = [];
  const result = await executeOperation({ root: stateRoot, jobId: job.jobId }, {
    operationsRoot: stateRoot,
    dataRoot: stateRoot,
    createMineruSession: () => ({
      async ensureReady() { return 'http://127.0.0.1:17860'; },
      async run() { return { status: 'completed' as const, runId: 'run-1' }; },
      async dispose() { throw Object.assign(new Error('cleanup failed'), { code: 'PROCESS_CLEANUP_UNCONFIRMED' }); },
    }),
    runTask: async () => ({ status: 'completed', runId: 'run-1' }),
    onResult: (value: unknown) => { emitted.push(value); },
  } as any);

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'PROCESS_CLEANUP_UNCONFIRMED');
  assert.deepEqual(emitted, []);
}));
