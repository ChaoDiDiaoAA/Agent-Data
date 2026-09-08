import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';

const policy = { processCleanupTimeoutMs: 500, diagnosticTimeoutMs: 1500, maxOutputBytes: 4096 };

test('managed process runs the target directly through Bun and preserves UTF-8 stdin', async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const fixture = await makeRuntimeFixture();
  const safetyRoot = join(fixture.paths.stateRoot, 'locks', 'processes');
  try {
    const stdinText = '中文🙂\n'.repeat(20);
    const result = await runManagedProcess({ executable: process.execPath, args: ['-e', 'console.log(JSON.stringify(await Bun.stdin.text()))'],
      cwd: fixture.root, env: process.env as Record<string, string>, stdinText, timeoutMs: 1000, policy, safetyRoot });
    assert.equal(result.reason, 'exit');
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout), stdinText);
    assert.equal(result.cleanupConfirmed, true);
    assert.deepEqual(await readdir(safetyRoot), []);
  } finally {
    await fixture.dispose();
  }
});

test('managed process joins split UTF-8 code points across chunks', async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const fixture = await makeRuntimeFixture();
  const safetyRoot = join(fixture.paths.stateRoot, 'locks', 'processes');
  try {
    const code = 'const bytes = new Uint8Array([0xE2, 0x82, 0xAC, 0x0A]); await Bun.write(Bun.stdout, bytes.subarray(0, 2)); await Bun.write(Bun.stdout, bytes.subarray(2));';
    const result = await runManagedProcess({
      executable: process.execPath,
      args: ['-e', code],
      cwd: fixture.root,
      env: process.env as Record<string, string>,
      timeoutMs: 1000,
      policy,
      safetyRoot,
    });
    assert.equal(result.reason, 'exit');
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.stdout, '€\n');
  } finally {
    await fixture.dispose();
  }
});

test('managed process emits deadline and confirms native-tree cleanup', async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const fixture = await makeRuntimeFixture();
  const events: string[] = [];
  try {
    const result = await runManagedProcess({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: fixture.root,
      env: process.env as Record<string, string>, timeoutMs: 80, policy, safetyRoot: join(fixture.paths.stateRoot, 'locks', 'processes') },
      { onEvent: event => events.push(event.kind) });
    assert.equal(result.reason, 'timeout');
    assert.equal(result.cleanupConfirmed, true);
    assert.deepEqual(result.activePids, []);
    assert.ok(events.includes('started'));
    assert.ok(events.includes('deadline'));
    assert.ok(events.includes('finished'));
  } finally {
    await fixture.dispose();
  }
});

test('managed Windows process is assigned to the named Job Object before its started event', { skip: process.platform !== 'win32' }, async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const { closeWindowsProcessJob, openWindowsProcessJob, windowsJobActivePids } = await import('../src/platform/windows-native.ts');
  const fixture = await makeRuntimeFixture();
  let observedInJob = false;
  try {
    const result = await runManagedProcess({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 150)'],
      cwd: fixture.root,
      env: process.env as Record<string, string>,
      timeoutMs: 1000,
      policy,
      safetyRoot: join(fixture.paths.stateRoot, 'locks', 'processes'),
    }, { onEvent(event) {
      if (event.kind !== 'started') return;
      const job = openWindowsProcessJob(event.jobName);
      if (!job) return;
      try { observedInJob = windowsJobActivePids(job)?.includes(event.pid) === true; }
      finally { closeWindowsProcessJob(job); }
    } });
    assert.equal(result.reason, 'exit');
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(observedInJob, true);
  } finally {
    await fixture.dispose();
  }
});

test('timeout cleanup includes descendants created by the managed Bun process', async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const { processIdentity } = await import('../src/runtime/run-lock.ts');
  const fixture = await makeRuntimeFixture();
  try {
    const childCode = 'setInterval(() => {}, 1000)';
    const rootCode = `const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(childCode)}], { stdout: 'ignore', stderr: 'ignore' }); console.log(child.pid); setInterval(() => {}, 1000);`;
    const result = await runManagedProcess({ executable: process.execPath, args: ['-e', rootCode], cwd: fixture.root,
      env: process.env as Record<string, string>, timeoutMs: 1000, policy, safetyRoot: join(fixture.paths.stateRoot, 'locks', 'processes') });
    const descendantPid = Number(result.stdout.trim());
    assert.equal(result.reason, 'timeout');
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(processIdentity(descendantPid), null);
  } finally { await fixture.dispose(); }
});

test('normal root exit also sweeps descendants before releasing the safety record', async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const { processIdentity } = await import('../src/runtime/run-lock.ts');
  const fixture = await makeRuntimeFixture();
  try {
    const rootCode = `const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify('setInterval(() => {}, 1000)')}], { stdout: 'ignore', stderr: 'ignore' }); console.log(child.pid); process.exit(0);`;
    const result = await runManagedProcess({ executable: process.execPath, args: ['-e', rootCode], cwd: fixture.root,
      env: process.env as Record<string, string>, timeoutMs: 1000, policy, safetyRoot: join(fixture.paths.stateRoot, 'locks', 'processes') });
    assert.equal(result.reason, 'exit');
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(processIdentity(Number(result.stdout.trim())), null);
  } finally { await fixture.dispose(); }
});

test('managed process closes inherited output pipes by terminating its Windows job descendants', { skip: process.platform !== 'win32' }, async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const { processIdentity } = await import('../src/runtime/run-lock.ts');
  const fixture = await makeRuntimeFixture();
  let descendantPid: number | undefined;
  try {
    const descendantCode = 'setInterval(() => {}, 1000)';
    const rootCode = `const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(descendantCode)}], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', windowsHide: true, detached: true }); console.log(child.pid); process.exit(0);`;
    const result = await runManagedProcess({
      executable: process.execPath,
      args: ['-e', rootCode],
      cwd: fixture.root,
      env: process.env as Record<string, string>,
      timeoutMs: 1000,
      policy,
      safetyRoot: join(fixture.paths.stateRoot, 'locks', 'processes'),
    });
    descendantPid = Number(result.stdout.trim());
    assert.equal(result.reason, 'exit');
    assert.equal(result.cleanupConfirmed, true);
    assert.ok(result.elapsedMs < 2000);
    assert.equal(processIdentity(descendantPid), null);
  } finally {
    if (descendantPid && processIdentity(descendantPid) !== null) process.kill(descendantPid);
    await fixture.dispose();
  }
});

test('Windows native tree termination reports success after the exact process is gone', { skip: process.platform !== 'win32' }, async () => {
  const { terminateWindowsProcessTree } = await import('../src/platform/windows-native.ts');
  const { processIdentity } = await import('../src/runtime/run-lock.ts');
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true,
  });
  try {
    assert.notEqual(processIdentity(child.pid), null);
    assert.equal(await terminateWindowsProcessTree(child.pid, 1500), true);
    assert.equal(processIdentity(child.pid), null);
  } finally {
    if (processIdentity(child.pid) !== null) child.kill();
    await child.exited;
  }
});

test('Windows native tree termination finds a detached descendant after its root exits', { skip: process.platform !== 'win32' }, async () => {
  const { terminateWindowsProcessTree } = await import('../src/platform/windows-native.ts');
  const { processIdentity } = await import('../src/runtime/run-lock.ts');
  const descendantCode = 'setInterval(() => {}, 1000)';
  const rootCode = `const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(descendantCode)}], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true, detached: true }); console.log(child.pid); process.exit(0);`;
  const root = Bun.spawn([process.execPath, '-e', rootCode], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', windowsHide: true,
  });
  const descendantPid = Number((await new Response(root.stdout).text()).trim());
  await root.exited;
  try {
    assert.notEqual(processIdentity(descendantPid), null);
    assert.equal(await terminateWindowsProcessTree(root.pid, 1500), true);
    assert.equal(processIdentity(descendantPid), null);
  } finally {
    if (processIdentity(descendantPid) !== null) process.kill(descendantPid);
  }
});

test('Windows process job keeps a spawned descendant supervised after its root exits', { skip: process.platform !== 'win32' }, async () => {
  const {
    assignWindowsProcessToJob,
    closeWindowsProcessJob,
    createWindowsProcessJob,
    terminateWindowsProcessJob,
    windowsJobActivePids,
  } = await import('../src/platform/windows-native.ts');
  const { processIdentity } = await import('../src/runtime/run-lock.ts');
  const job = createWindowsProcessJob(`Local\\Fsd.Test.${crypto.randomUUID()}`);
  assert.ok(job, 'Windows Job Object creation must be available');
  const descendantCode = 'setInterval(() => {}, 1000)';
  const rootCode = `setTimeout(() => { const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(descendantCode)}], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true, detached: true }); console.log(child.pid); process.exit(0); }, 80);`;
  const root = Bun.spawn([process.execPath, '-e', rootCode], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', windowsHide: true,
  });
  let descendantPid: number | undefined;
  try {
    assert.equal(assignWindowsProcessToJob(job, root.pid), true);
    descendantPid = Number((await new Response(root.stdout).text()).trim());
    assert.equal(await root.exited, 0);
    assert.ok(descendantPid > 0);
    assert.notEqual(processIdentity(descendantPid), null);
    assert.equal(windowsJobActivePids(job)?.includes(descendantPid), true);
    const cleanup = await terminateWindowsProcessJob(job, 1500);
    assert.deepEqual(cleanup, { cleanupConfirmed: true, activePids: [] });
    assert.equal(processIdentity(descendantPid), null);
  } finally {
    closeWindowsProcessJob(job);
    if (root.exitCode === null) root.kill();
    if (descendantPid && processIdentity(descendantPid) !== null) process.kill(descendantPid);
    await root.exited;
  }
});

test('process-record inspection rejects a dead root while its named Windows job still has descendants', { skip: process.platform !== 'win32' }, async () => {
  const {
    assignWindowsProcessToJob,
    closeWindowsProcessJob,
    createWindowsProcessJob,
    terminateWindowsProcessJob,
  } = await import('../src/platform/windows-native.ts');
  const { inspectProcessRecord, processJobName } = await import('../src/runtime/process.ts');
  const { processIdentity } = await import('../src/runtime/run-lock.ts');
  const fixture = await makeRuntimeFixture();
  const id = crypto.randomUUID();
  const job = createWindowsProcessJob(processJobName(id));
  assert.ok(job);
  const descendantCode = 'setInterval(() => {}, 1000)';
  const rootCode = `const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(descendantCode)}], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true, detached: true }); console.log(child.pid); process.exit(0);`;
  const root = Bun.spawn([process.execPath, '-e', rootCode], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', windowsHide: true });
  let descendantPid: number | undefined;
  try {
    const startedAt = processIdentity(root.pid);
    assert.ok(startedAt);
    assert.equal(assignWindowsProcessToJob(job, root.pid), true);
    descendantPid = Number((await new Response(root.stdout).text()).trim());
    await root.exited;
    assert.notEqual(processIdentity(descendantPid), null);
    const safetyRoot = join(fixture.paths.stateRoot, 'locks', 'processes');
    const path = join(safetyRoot, 'active.json');
    await mkdir(safetyRoot, { recursive: true });
    await Bun.write(path, `${JSON.stringify({
      v: 1,
      id,
      jobName: processJobName(id),
      executable: process.execPath,
      ownerPid: 999999999,
      pid: root.pid,
      startedAt,
      createdAt: new Date().toISOString(),
      cleanupState: 'unconfirmed',
    })}\n`);
    const inspection = await inspectProcessRecord(path);
    assert.equal(inspection.ownerAlive, false);
    assert.equal(inspection.rootState, 'dead');
    assert.equal(inspection.cleanupConfirmed, false);
    assert.equal(inspection.activePids.includes(descendantPid), true);
  } finally {
    await terminateWindowsProcessJob(job, 1500);
    closeWindowsProcessJob(job);
    if (root.exitCode === null) root.kill();
    if (descendantPid && processIdentity(descendantPid) !== null) process.kill(descendantPid);
    await root.exited;
    await fixture.dispose();
  }
});

test('process identity uses native Bun support and rejects a dead PID', async () => {
  const { processIdentity } = await import('../src/runtime/run-lock.ts');
  const self = processIdentity(process.pid);
  assert.equal(typeof self, 'string');
  assert.match(self!, /^(?:windows|linux|unknown):/);
  assert.equal(processIdentity(999999999), null);
});

test('unresolved process records fail closed before a new spawn', async () => {
  const { runManagedProcess } = await import('../src/runtime/process.ts');
  const fixture = await makeRuntimeFixture();
  const safetyRoot = join(fixture.paths.stateRoot, 'locks', 'processes');
  try {
    await mkdir(safetyRoot, { recursive: true });
    await Bun.write(join(safetyRoot, 'active.json'), '{interrupted');
    const result = await runManagedProcess({ executable: process.execPath, args: ['-e', 'console.log("must not launch")'], cwd: fixture.root,
      env: process.env as Record<string, string>, timeoutMs: 1000, policy, safetyRoot });
    assert.equal(result.pid, null);
    assert.equal(result.cleanupConfirmed, false);
    assert.equal(await readFile(join(safetyRoot, 'active.json'), 'utf8'), '{interrupted');
  } finally {
    await fixture.dispose();
  }
});

for (const [operation, code] of [['--inspect', 0], ['--resolve', 1]] as const) {
test(`Bun recovery via the CLI ${operation} preserves an unresolved prelaunch record`, async () => {
  const { processJobName } = await import('../src/runtime/process.ts');
  const fixture = await makeRuntimeFixture();
  try {
    const id = crypto.randomUUID();
    const path = join(fixture.paths.stateRoot, 'locks', 'processes', 'active.json');
    await mkdir(join(fixture.paths.stateRoot, 'locks', 'processes'), { recursive: true });
    await Bun.write(path, JSON.stringify({ v: 1, id, jobName: processJobName(id), executable: 'not-started.exe', ownerPid: process.pid,
      pid: null, startedAt: null, createdAt: new Date().toISOString(), cleanupState: 'launching' }));
    const child = Bun.spawn([process.execPath, 'src/cli.ts', '--process-supervisor', operation, path], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(stderr, '');
    assert.equal(exitCode, code);
    assert.equal(JSON.parse(stdout).cleanupConfirmed, false);
    assert.equal(JSON.parse(stdout).resolved, false);
    assert.equal(existsSync(path), true);
  } finally {
    await fixture.dispose();
  }
});
}

test('CLI supervisor preserves invalid-argument and record-error exit contracts without loading config', async () => {
  const fixture = await makeRuntimeFixture();
  const cli = join(process.cwd(), 'src/cli.ts');
  try {
    for (const args of [[], ['--invalid'], ['--inspect'], ['--resolve']]) {
      const child = Bun.spawn([process.execPath, cli, '--process-supervisor', ...args], { cwd: fixture.root, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      assert.equal(stdout, '');
      assert.match(stderr, /Usage: bun src\/cli.ts --process-supervisor --inspect\|--resolve/);
      assert.equal(code, 2);
    }
    for (const operation of ['--inspect', '--resolve']) {
      const child = Bun.spawn([process.execPath, cli, '--process-supervisor', operation, 'active.json'], { cwd: fixture.root, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      assert.equal(stderr, '');
      assert.equal(code, 1);
      assert.deepEqual(JSON.parse(stdout), { ownerAlive: true, rootState: 'unknown', activePids: [], cleanupConfirmed: false, resolved: false,
        error: 'record inspection could not establish safe cleanup' });
    }
  } finally { await fixture.dispose(); }
});

test('CLI supervisor resolves only a safely dead test process record and returns success', async () => {
  const { processJobName } = await import('../src/runtime/process.ts');
  const fixture = await makeRuntimeFixture();
  const target = Bun.spawn([process.execPath, '-e', ''], { cwd: fixture.root, stdout: 'ignore', stderr: 'ignore', windowsHide: true });
  await target.exited;
  try {
    const id = crypto.randomUUID(), stamp = new Date().toISOString();
    const path = join(fixture.root, 'active.json');
    await Bun.write(path, JSON.stringify({ v: 1, id, jobName: processJobName(id), executable: process.execPath,
      ownerPid: target.pid, pid: target.pid, startedAt: stamp, createdAt: stamp, cleanupState: 'unconfirmed' }));
    const child = Bun.spawn([process.execPath, join(process.cwd(), 'src/cli.ts'), '--process-supervisor', '--resolve', 'active.json'], {
      cwd: fixture.root, stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(stderr, '');
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { ownerAlive: false, rootState: 'dead', activePids: [], cleanupConfirmed: true, resolved: true });
    assert.equal(existsSync(path), false);
  } finally { await fixture.dispose(); }
});
