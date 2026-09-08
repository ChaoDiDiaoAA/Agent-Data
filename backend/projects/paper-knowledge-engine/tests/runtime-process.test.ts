import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { configureLayeredRuntimeFixture } from './fixtures/layered-config.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { admitOperation } from '../src/library/operations/operation-store.ts';

const policy = { processCleanupTimeoutMs: 500, diagnosticTimeoutMs: 1500, maxOutputBytes: 16 };

test('terminal lifecycle parser rejects malformed cleanup evidence', async () => {
  const { parseSupervisorEvent, processJobName } = await import('../src/runtime/process.ts');
  const id = 'fixture';
  const valid = { v: 1, id, kind: 'finished', reason: 'timeout', exitCode: null, cleanupConfirmed: true, elapsedMs: 450, activePids: [], terminationRequestedElapsedMs: 301, treeEmptyElapsedMs: 320 };
  assert.doesNotThrow(() => parseSupervisorEvent(JSON.stringify(valid), id));
  assert.equal(processJobName(id).startsWith('Local\\Fsd.Process.'), true);
  for (const change of [{ terminationRequestedElapsedMs: -1 }, { treeEmptyElapsedMs: 451 }, { treeEmptyElapsedMs: 300 }, { cleanupConfirmed: false }]) {
    assert.throws(() => parseSupervisorEvent(JSON.stringify({ ...valid, ...change }), id));
  }
});

test('output limits are enforced independently for stdout and stderr', async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const f = await makeRuntimeFixture();
  try {
    const result = await runManagedProcess({ executable: process.execPath, args: ['-e', 'process.stdout.write("O".repeat(32)); process.stderr.write("E".repeat(32))'], cwd: f.root,
      env: process.env as Record<string, string>, timeoutMs: 1000, policy, safetyRoot: join(f.paths.stateRoot, 'locks', 'processes') });
    assert.equal(result.reason, 'output-limit');
    assert.equal(Buffer.byteLength(result.stdout), 16);
    assert.equal(Buffer.byteLength(result.stderr), 16);
    assert.equal(result.cleanupConfirmed, true);
    assert.deepEqual(await readdir(join(f.paths.stateRoot, 'locks', 'processes')), []);
  } finally { await f.dispose(); }
});

test('observer failures retain a durable process record and block the next launch', async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const f = await makeRuntimeFixture();
  const safetyRoot = join(f.paths.stateRoot, 'locks', 'processes');
  try {
    const result = await runManagedProcess({ executable: process.execPath, args: ['-e', 'console.log("observer")'], cwd: f.root,
      env: process.env as Record<string, string>, timeoutMs: 1000, policy, safetyRoot }, { onStdout: () => { throw new Error('observer failure'); } });
    assert.equal(result.reason, 'supervisor-error');
    assert.equal(result.cleanupConfirmed, false);
    const record = JSON.parse(await readFile(join(safetyRoot, 'active.json'), 'utf8'));
    assert.equal(record.cleanupState, 'unconfirmed');
    const blocked = await runManagedProcess({ executable: process.execPath, args: ['-e', 'console.log("must not launch")'], cwd: f.root,
      env: process.env as Record<string, string>, timeoutMs: 1000, policy, safetyRoot });
    assert.equal(blocked.pid, null);
    assert.equal(existsSync(join(safetyRoot, 'active.json')), true);
  } finally {
    await f.dispose();
  }
});

test('managed process metadata is persisted in active.json and cleanup still succeeds', async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const f = await makeRuntimeFixture();
  const safetyRoot = join(f.paths.stateRoot, 'locks', 'processes');
  const controller = new AbortController();
  try {
    const running = runManagedProcess({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      cwd: f.root,
      env: process.env as Record<string, string>,
      timeoutMs: 10_000,
      policy: { ...policy, maxOutputBytes: 64, processCleanupTimeoutMs: 1_500 },
      safetyRoot,
      recordMetadata: { kind: 'mineru-api', host: '127.0.0.1', port: 17860 },
    }, { signal: controller.signal });

    let recordText = '';
    for (let index = 0; index < 50; index += 1) {
      if (existsSync(join(safetyRoot, 'active.json'))) {
        recordText = await readFile(join(safetyRoot, 'active.json'), 'utf8');
        if (recordText.includes('"cleanupState":"running"')) break;
      }
      await Bun.sleep(20);
    }

    assert.notEqual(recordText, '');
    const record = JSON.parse(recordText);
    assert.deepEqual(record.recordMetadata, { kind: 'mineru-api', host: '127.0.0.1', port: 17860 });

    controller.abort();
    const result = await running;
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(existsSync(join(safetyRoot, 'active.json')), false);
  } finally {
    controller.abort();
    await f.dispose();
  }
});

test('invalid UTF-8 bytes are replaced while output keeps draining and exit zero remains success', async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const f = await makeRuntimeFixture();
  try {
    const code = 'await Bun.write(Bun.stdout, new Uint8Array([0x61,0x81,0x62,0x0a])); console.log("after-invalid");';
    const result = await runManagedProcess({
      executable: process.execPath,
      args: ['-e', code],
      cwd: f.root,
      env: process.env as Record<string, string>,
      timeoutMs: 1000,
      policy: { ...policy, maxOutputBytes: 64 },
      safetyRoot: join(f.paths.stateRoot, 'locks', 'processes'),
    });
    assert.equal(result.reason, 'exit');
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupConfirmed, true);
    assert.match(result.stdout, /a�b/);
    assert.match(result.stdout, /after-invalid/);
  } finally { await f.dispose(); }
});

test('process context reloads policy and paths without creating locks', async () => {
  const { createProcessContext } = await import('../src/runtime/process.ts');
  const f = await makeRuntimeFixture();
  await configureLayeredRuntimeFixture(f);
  try {
    const context = createProcessContext(f.projectRoot);
    assert.equal(context.safetyRoot, join(loadEngineContext({ root: f.projectRoot }).paths.operationsRoot, 'locks', 'processes'));
    assert.equal(existsSync(context.safetyRoot), false);
  } finally { await f.dispose(); }
});

test('a marker produced by the configured process context blocks operation admission', async () => {
  const { createProcessContext, runManagedProcess } = await import('../src/runtime/process.ts');
  const f = await makeRuntimeFixture();
  await configureLayeredRuntimeFixture(f);
  const context = createProcessContext(f.projectRoot);
  const operationsRoot = loadEngineContext({ root: f.projectRoot }).paths.operationsRoot;
  const controller = new AbortController();
  try {
    const running = runManagedProcess({
      ...context,
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      cwd: f.root,
      env: process.env as Record<string, string>,
      timeoutMs: 10_000,
    }, { signal: controller.signal });

    for (let index = 0; index < 50 && !existsSync(join(context.safetyRoot, 'active.json')); index += 1) {
      await Bun.sleep(20);
    }
    assert.equal(existsSync(join(context.safetyRoot, 'active.json')), true);
    await assert.rejects(admitOperation({
      root: f.projectRoot,
      operationsRoot,
      request: { libraryId: 'fsd', requestId: 'marker-gate', operation: { kind: 'current' } },
    }), { code: 'PROCESS_CLEANUP_UNCONFIRMED' });

    controller.abort();
    assert.equal((await running).cleanupConfirmed, true);
  } finally {
    controller.abort();
    await f.dispose();
  }
});

test('prelaunch records cannot be resolved without process identity', async () => {
  const { processJobName, inspectProcessRecord, resolveProcessRecord } = await import('../src/runtime/process.ts');
  const f = await makeRuntimeFixture();
  const path = join(f.paths.stateRoot, 'locks', 'processes', 'active.json');
  try {
    await mkdir(join(f.paths.stateRoot, 'locks', 'processes'), { recursive: true });
    const id = crypto.randomUUID();
    await Bun.write(path, JSON.stringify({ v: 1, id, jobName: processJobName(id), executable: 'not-started.exe', ownerPid: process.pid,
      pid: null, startedAt: null, createdAt: new Date().toISOString(), cleanupState: 'launching' }));
    assert.equal((await inspectProcessRecord(path)).cleanupConfirmed, false);
    assert.equal((await resolveProcessRecord(path)).resolved, false);
    assert.equal(existsSync(path), true);
  } finally { await f.dispose(); }
});
