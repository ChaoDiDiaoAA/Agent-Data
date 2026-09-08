import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dispatchBridge } from '../src/library/operations/job-bridge.ts';
import { main } from '../src/cli.ts';
import { admitOperation, readOperationRecord, readOperationEvents, saveOperationRecord } from '../src/library/operations/operation-store.ts';
import { executeOperation } from '../src/library/workflow.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';

function fakeMineruSession() {
  return {
    async ensureReady() { return 'http://127.0.0.1:17860'; },
    async run() { return {} as any; },
    async dispose() {},
  } as any;
}

async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'job-bridge-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('bridge scopes info, admission, listing and resume to the selected library', () => fixture(async root => {
  await writeLayeredConfigFixture({ root, additionalLibraryIds: ['ai-tdd'] });
  const libraryId = asLibraryId('ai-tdd');
  const context = { root, libraryId };
  const info = await dispatchBridge({ command: 'info', payload: {} }, context) as { libraryId: string };
  assert.equal(info.libraryId, 'ai-tdd');

  const admitted = await dispatchBridge({ command: 'admit', payload: {
    libraryId: 'ai-tdd', requestId: 'bridge-ai', operation: { kind: 'current' },
  } }, context) as { job: { jobId: string; libraryId: string } };
  assert.equal(admitted.job.libraryId, 'ai-tdd');
  const stateRoot = loadEngineContext({ root, libraryId }).paths.operationsRoot;
  const record = readOperationRecord(stateRoot, admitted.job.jobId);
  record.status = 'failed';
  record.canResume = true;
  record.runId = 'run-ai';
  saveOperationRecord(stateRoot, record);

  const resumed = await dispatchBridge({ command: 'resume', payload: {
    jobId: admitted.job.jobId, requestId: 'bridge-ai-resume',
  } }, context) as { job: { libraryId: string; runId?: string } };
  assert.equal(resumed.job.libraryId, 'ai-tdd');
  assert.equal(resumed.job.runId, 'run-ai');
  const listed = await dispatchBridge({ command: 'list', payload: {} }, context) as { libraryId: string }[];
  assert.deepEqual(listed.map((job) => job.libraryId), ['ai-tdd']);

  await assert.rejects(dispatchBridge({ command: 'admit', payload: {
    libraryId: 'fsd', requestId: 'cross-library', operation: { kind: 'current' },
  } }, context), { code: 'INVALID_REQUEST' });
}));

test('worker resolves the selected library operation root', () => fixture(async root => {
  await writeLayeredConfigFixture({ root, additionalLibraryIds: ['ai-tdd'] });
  const libraryId = asLibraryId('ai-tdd');
  const stateRoot = loadEngineContext({ root, libraryId }).paths.operationsRoot;
  const { job } = await admitOperation({ root, operationsRoot: stateRoot, internal: true, request: {
    libraryId,
    requestId: 'worker-ai',
    operation: { kind: 'bootstrap' },
  } });
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, '..', 'src', 'cli.ts'),
    '--library',
    libraryId,
    '--worker',
    '--job-id',
    job.jobId,
  ], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(exitCode, 0, `stderr=${stderr}; stdout=${stdout}`);
  const result = JSON.parse(stdout);
  assert.equal(result.libraryId, 'ai-tdd');
  assert.equal(result.jobId, job.jobId);
  assert.equal(result.status, 'completed');
  assert.notEqual(result.error?.code, 'JOB_NOT_FOUND');
  assert.equal(readOperationRecord(stateRoot, job.jobId).status, 'completed');
}));
test('bridge allowlist rejects executable, paths, env, unknown commands and internal operations', () => fixture(async root => {
  for (const command of [
    { command: 'shell', payload: {} }, { command: 'info', payload: { path: 'D:/secret' } },
    { command: 'execute', payload: { jobId: 'x', executable: 'cmd.exe' } },
    { command: 'list', payload: { cwd: 'D:/secret' } },
    { command: 'admit', payload: { libraryId: 'fsd', requestId: 'r', operation: { kind: 'wiki', runId: 'r' } } },
  ]) await assert.rejects(dispatchBridge(command, { root, operationsRoot: root, dataRoot: root }), { code: 'INVALID_REQUEST' });
  await assert.rejects(dispatchBridge({ command: 'preview', payload: { rootId: 'local', relativePath: 'fake.pdf' } }, { root, operationsRoot: root, dataRoot: root }), { code: 'CONFIG_REQUIRED' });
}));
test('fixed dispatcher launch failure leaves the durably admitted job resumable', () => fixture(async root => {
  const result = await dispatchBridge({ command: 'admit', payload: { libraryId: 'fsd', requestId: 'r', operation: { kind: 'current' } } },
    { root, operationsRoot: root, dataRoot: root, launch: async jobId => {
      assert.equal(readOperationRecord(root, jobId).status, 'accepted'); throw new Error('D:/secret token=private');
    } });
  assert.ok(result && typeof result === 'object' && 'job' in result);
  const job = (result as { job: { status: string; canResume: boolean; error: { code: string } } }).job;
  assert.equal(job.status, 'failed'); assert.equal(job.canResume, true); assert.equal(job.error.code, 'LAUNCH_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
}));
test('all mutating CLI routes normalize into shared admission/workflow; business exports do not recurse', () => fixture(async root => {
  const commands = [['bootstrap'], ['run-task', '--mode', 'current', '--limit', '1'], ['import-local', '--path', 'fake.pdf'],
    ['parse-local', '--base-id', '1'], ['evidence-publish', '--run-id', 'run-1'], ['reconcile'], ['reconcile', '--repair-duplicate-pdf', '1', '--keep', 'fake.pdf']];
  const kinds: string[] = [];
  for (const command of commands) await main(['--library', 'fsd', ...command], { root, operationsRoot: root, output: () => {}, execute: async ({ jobId }, dependencies) => {
    const job = readOperationRecord(root, jobId); kinds.push(job.request.operation.kind);
    // Mark through real workflow with injected business boundaries, not bypassing admission.
    const { executeOperation } = await import('../src/library/workflow.ts');
    return executeOperation({ root, jobId }, { ...dependencies, operationsRoot: root, dataRoot: root, mineruSession: fakeMineruSession(), internal: async () => ({ status: 'completed' }), runTask: async () => ({ status: 'completed' }), importLocal: async () => ({ status: 'completed' }), publishEvidence: async runId => ({ status: 'completed', runId }) });
  } });
  assert.deepEqual(kinds, ['bootstrap', 'current', 'import-local', 'parse-local', 'evidence-publish', 'reconcile', 'reconcile']);
}));
test('CLI import-local retains menu result fields while persisted and bridge DTOs stay safe', () => fixture(async root => {
  const original = { status: 'completed', runId: 'local-run', fileCount: 4, paperCount: 2, successCount: 2,
    failureCount: 0, skippedCount: 2, failures: [], evidenceReceiptPath: 'D:/private/publication.json' };
  let output: unknown; let jobId = '';
  await main(['--library', 'fsd', 'import-local', '--path', 'fake.pdf'], { root, operationsRoot: root, output: value => { output = value; },
    execute: async (input, dependencies) => {
      jobId = input.jobId;
      assert.equal(readOperationRecord(root, jobId).status, 'accepted');
      return executeOperation(input, { ...dependencies, mineruSession: fakeMineruSession(), importLocal: async () => original });
    } });
  assert.deepEqual(output, original);
  const stored = readOperationRecord(root, jobId);
  assert.equal(stored.status, 'completed');
  assert.doesNotMatch(JSON.stringify({ stored, events: readOperationEvents(root, jobId) }), /D:\/private|evidenceReceiptPath|fileCount|successCount|failures/);
  const bridge = await dispatchBridge({ command: 'get', payload: { jobId } }, { root, operationsRoot: root, dataRoot: root });
  assert.doesNotMatch(JSON.stringify(bridge), /D:\/private|evidenceReceiptPath|fileCount|successCount|failures/);
}));
test('CLI business exception falls back to safe failed JobView and nonzero exit', () => fixture(async root => {
  const priorExitCode = process.exitCode;
  try {
    let output: unknown;
    await main(['--library', 'fsd', 'import-local', '--path', 'fake.pdf'], { root, operationsRoot: root, output: value => { output = value; },
      execute: (input, dependencies) => executeOperation(input, { ...dependencies, mineruSession: fakeMineruSession(), importLocal: async () => { throw new Error('Bearer secret D:/private'); } }) });
    assert.ok(output && typeof output === 'object' && 'status' in output);
    assert.equal(output.status, 'failed'); assert.equal(process.exitCode, 1);
    assert.doesNotMatch(JSON.stringify(output), /secret|private/);
  } finally { process.exitCode = priorExitCode ?? 0; }
}));

test('worker-style current operation gets one command-owned MinerU session through workflow dependencies', () => fixture(async root => {
  const { job } = await admitOperation({ operationsRoot: root, request: { libraryId: 'fsd', requestId: 'worker-current', operation: { kind: 'current' } } });
  let created = 0;
  let disposed = 0;
  const result = await executeOperation({ root, jobId: job.jobId }, {
    operationsRoot: root,
    dataRoot: root,
    createMineruSession: () => {
      created++;
      return {
        async ensureReady() { return 'http://127.0.0.1:17860'; },
        async run() { return { status: 'completed' as const, runId: 'run-worker' }; },
        async dispose() { disposed++; },
      };
    },
    runTask: async () => ({ status: 'completed', runId: 'run-worker' }),
  } as any);
  assert.equal(result.status, 'completed');
  assert.equal(created, 1);
  assert.equal(disposed, 1);
}));

test('CLI partial import failure retains counts, diagnostics and pending batches without exposing raw bridge results', () => fixture(async root => {
  const priorExitCode = process.exitCode;
  try {
    const original = { status: 'failed', runId: 'partial-run', fileCount: 4, paperCount: 2, successCount: 1, failureCount: 1,
      skippedCount: 2, failures: [{ baseId: 'paper-2', path: 'D:/private/paper-2.pdf', error: 'synthetic parser failure' }] };
    let output: unknown; let jobId = '';
    await main(['--library', 'fsd', 'import-local', '--path', 'fake.pdf'], { root, operationsRoot: root, output: value => { output = value; },
      execute: (input, dependencies) => {
        jobId = input.jobId;
        return executeOperation(input, { ...dependencies, mineruSession: fakeMineruSession(), importLocal: async () => original });
      } });
    assert.deepEqual(output, original); assert.equal(process.exitCode, 1);
    const stored = readOperationRecord(root, jobId);
    assert.equal(stored.status, 'failed'); assert.equal(stored.canResume, true);
    const bridge = await dispatchBridge({ command: 'get', payload: { jobId } }, { root, operationsRoot: root, dataRoot: root });
    assert.doesNotMatch(JSON.stringify({ stored, events: readOperationEvents(root, jobId), bridge }), /D:\/private|knowledgeManifestPath|fileCount|successCount|synthetic parser failure/);
  } finally { process.exitCode = priorExitCode ?? 0; }
}));
test('real Bun bridge accepts one stdin JSON and emits one protocol JSON with truthful exit code', () => fixture(async root => {
  await writeLayeredConfigFixture({ root });
  const executable = process.execPath;
  const bridge = join(process.cwd(), 'src', 'cli.ts');
  for (const [input, ok] of [[JSON.stringify({ command: 'list', payload: {} }), true], [JSON.stringify({ command: 'info', payload: { env: { TOKEN: 'secret' } } }), false], ['{}\n{}', false]] as const) {
    const child = Bun.spawn([executable, bridge, '--library', 'fsd', '--bridge'], { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, FSD_OFFLINE_TESTS: '1' } });
    child.stdin.write(input); child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = JSON.parse(stdout);
    assert.equal(output.ok, ok); assert.equal(exit, ok ? 0 : 1);
    assert.equal(stdout.trim().split('\n').length, 1); assert.doesNotMatch(stdout + stderr, /secret|TOKEN/);
  }
}));
