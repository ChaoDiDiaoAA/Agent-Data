import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { admitOperation, listOperations, readOperation, readOperationRecord, resumeOperation, saveOperationRecord, readOperationEvents } from '../src/library/operations/operation-store.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { withRunLock, processIdentity } from '../src/runtime/run-lock.ts';

const request = (requestId = 'req-1', limit = 1) => ({ libraryId: 'fsd', requestId, operation: { kind: 'current', limit } });
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'operations-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('concurrent identical admissions durably accept exactly once', () => fixture(async stateRoot => {
  const results = await Promise.all([admitOperation({ operationsRoot: stateRoot, request: request() }), admitOperation({ operationsRoot: stateRoot, request: request() })]);
  assert.equal(results[0].job.jobId, results[1].job.jobId);
  assert.equal(results.filter(value => value.replayed).length, 1);
  assert.equal((await readOperation(stateRoot, results[0].job.jobId)).status, 'accepted');
  assert.deepEqual(readOperationEvents(stateRoot, results[0].job.jobId).map(event => event.type), ['accepted']);
}));
test('persists jobs directly under the explicit operations root', () => fixture(async operationsRoot => {
  const { job } = await admitOperation({ operationsRoot, request: request('explicit-root') });
  assert.ok(await readFile(join(operationsRoot, `${job.jobId}.json`), 'utf8'));
  await assert.rejects(readFile(join(operationsRoot, 'operations', `${job.jobId}.json`), 'utf8'), { code: 'ENOENT' });
}));
test('persisted operations and public JobViews expose only libraryId', () => fixture(async stateRoot => {
  const { job } = await admitOperation({ operationsRoot: stateRoot, request: { libraryId: 'fsd', requestId: 'library-shape', operation: { kind: 'current' } } });
  assert.equal(job.libraryId, 'fsd');
  assert.equal(Object.hasOwn(job, 'projectId'), false);
  const persisted = JSON.parse(await readFile(join(stateRoot, `${job.jobId}.json`), 'utf8'));
  assert.equal(persisted.libraryId, 'fsd');
  assert.equal(persisted.request.libraryId, 'fsd');
  assert.equal(Object.hasOwn(persisted, 'projectId'), false);
  assert.equal(Object.hasOwn(persisted.request, 'projectId'), false);
}));
test('conflicting request and competing project cannot create a second job', () => fixture(async stateRoot => {
  await admitOperation({ operationsRoot: stateRoot, request: request() });
  await assert.rejects(admitOperation({ operationsRoot: stateRoot, request: request('req-1', 2) }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(admitOperation({ operationsRoot: stateRoot, request: request('req-2') }), { code: 'PROJECT_BUSY' });
  assert.equal((await listOperations(stateRoot)).length, 1);
}));
test('request validation excludes paths, invalid dates, weekly limits and non-ASCII request IDs', () => fixture(async stateRoot => {
  for (const value of [
    { ...request(), requestId: '../secret' }, { ...request(), requestId: '中' }, { ...request(), requestId: 'x'.repeat(129) },
    { ...request(), cwd: 'D:/secret' }, { ...request(), operation: { kind: 'current', env: {} } },
    { ...request(), operation: { kind: 'current', from: '2026-02-30', to: '2026-03-01' } },
    { ...request(), operation: { kind: 'current', from: '2026-01-01' } },
    { ...request(), operation: { kind: 'weekly', limit: 1 } },
    { ...request(), operation: { kind: 'parse-local', baseId: '1' } },
  ]) await assert.rejects(admitOperation({ operationsRoot: stateRoot, request: value }), { code: 'INVALID_REQUEST' });
}));
test('evidence publication admits only a safe explicit run identity', () => fixture(async stateRoot => {
  const accepted = await admitOperation({ operationsRoot: stateRoot, request: { libraryId: 'fsd', requestId: 'evidence-1', operation: { kind: 'evidence-publish', runId: 'run-1' } } });
  assert.equal(accepted.job.stage, 'evidence-publish');
  await assert.rejects(admitOperation({ operationsRoot: stateRoot, request: { libraryId: 'fsd', requestId: 'evidence-2', operation: { kind: 'wiki', runId: 'run-2' } } }), { code: 'INVALID_REQUEST' });
}));
test('old paper-sync locks and unconfirmed process markers conservatively block admission', () => fixture(async stateRoot => {
  await mkdir(join(stateRoot, 'locks', 'processes'), { recursive: true });
  const paperLock = join(stateRoot, 'locks', 'paper-sync.lock');
  await writeFile(paperLock, '');
  await assert.rejects(admitOperation({ operationsRoot: stateRoot, request: request() }), { code: 'PROJECT_BUSY' });
  assert.equal(await readFile(paperLock, 'utf8'), '');
  await rm(paperLock);
  await writeFile(join(stateRoot, 'locks', 'processes', 'unconfirmed.json'), '{}');
  await assert.rejects(admitOperation({ operationsRoot: stateRoot, request: request() }), { code: 'PROCESS_CLEANUP_UNCONFIRMED' });
}));
test('locks record actual process creation identity and never reclaim unknown owners', () => fixture(async stateRoot => {
  const path = join(stateRoot, 'locks', 'workflow.lock');
  await withRunLock(path, async () => {
    const owner = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.startedAt, processIdentity(process.pid));
    assert.equal(owner.jobId, 'job-1');
  }, { jobId: 'job-1' });
  await writeFile(path, JSON.stringify({ pid: 1234, startedAt: 'old', jobId: 'job-1' }));
  await assert.rejects(withRunLock(path, () => assert.fail(), { inspectProcess: () => undefined }), { code: 'PROJECT_BUSY' });
}));
test('verified interrupted owner resumes same job and run; unknown owner stays busy', () => fixture(async stateRoot => {
  const { job } = await admitOperation({ operationsRoot: stateRoot, request: request() });
  const record = readOperationRecord(stateRoot, job.jobId);
  record.status = 'running'; record.runId = 'older-run'; record.inputIdentity = { fingerprint: 'original' };
  record.owner = { pid: 2147483000, startedAt: 'gone' };
  saveOperationRecord(stateRoot, record);
  const resumed = await resumeOperation({ operationsRoot: stateRoot, jobId: job.jobId, requestId: 'resume-1' });
  assert.equal(resumed.job.jobId, job.jobId);
  assert.equal(resumed.job.runId, 'older-run');
  assert.deepEqual(readOperationRecord(stateRoot, job.jobId).inputIdentity, { fingerprint: 'original' });
  assert.equal((await resumeOperation({ operationsRoot: stateRoot, jobId: job.jobId, requestId: 'resume-1' })).replayed, true);
  assert.equal(readOperationRecord(stateRoot, job.jobId).attempts.length, 2);
}));
test('operation listing never synthesizes background work and missing DB is not created', () => fixture(async stateRoot => {
  assert.deepEqual(await listOperations(stateRoot), []);
  await assert.rejects(stat(join(stateRoot, 'papers.sqlite')), { code: 'ENOENT' });
  const store = openStateStore(join(stateRoot, 'papers.sqlite'));
  store.startRun({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }, 'current'); store.close();
  const before = await readFile(join(stateRoot, 'papers.sqlite'));
  const a = await listOperations(stateRoot); const b = await listOperations(stateRoot);
  assert.deepEqual(a, b); assert.equal(a.length, 0);
  assert.deepEqual(await readFile(join(stateRoot, 'papers.sqlite')), before);
  await assert.rejects(stat(join(stateRoot, 'operations')), { code: 'ENOENT' });
}));

test('reading a crashed worker marks interrupted without removing unknown process locks', () => fixture(async stateRoot => {
  const { job } = await admitOperation({ operationsRoot: stateRoot, request: request() });
  const saved = readOperationRecord(stateRoot, job.jobId);
  saved.status = 'running'; saved.owner = { pid: 2147483000, startedAt: 'gone' }; saveOperationRecord(stateRoot, saved);
  const recovered = await readOperation(stateRoot, job.jobId);
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.canResume, true);
}));


test('real crashed Bun worker leaves a verifiable lock and resumes its original run', () => fixture(async stateRoot => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'crashed-job.ts'), stateRoot], { stdout: 'pipe', stderr: 'pipe' });
  const [output, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(exit, 19, stderr);
  const { jobId } = JSON.parse(output);
  assert.equal(readOperationRecord(stateRoot, jobId).status, 'running');
  const resumed = await resumeOperation({ operationsRoot: stateRoot, jobId, requestId: 'real-resume' });
  assert.equal(resumed.job.runId, 'crashed-run'); assert.equal(resumed.job.jobId, jobId);
  assert.equal(readOperationRecord(stateRoot, jobId).attempts.length, 2);
}));
