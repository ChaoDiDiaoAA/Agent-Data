import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

test('archive concurrency regression exits without an orphaned Bun process', { timeout: 6000 }, async () => {
  // A process boundary is deliberate: a synchronous Bun assertion can starve
  // its own test timeout. The parent must remain able to terminate that child.
  const child = Bun.spawn([process.execPath, 'test', 'tests/archive-v2.test.ts', '-t', '^competing writers'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: process.env, stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 3000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    assert.equal(timedOut, false, `Archive concurrency test hung and was killed:\n${stdout}\n${stderr}`);
    assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
    assert.match(stderr, /1 pass/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
});
