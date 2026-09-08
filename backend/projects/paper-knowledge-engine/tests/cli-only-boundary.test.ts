import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

test('keeps cli.ts below 80 lines and delegates presentation and business lifecycle', () => {
  const source = readFileSync(join(root, 'src/cli.ts'), 'utf8');
  assert.ok(source.split('\n').length < 80, `cli.ts has ${source.split('\n').length} lines`);
  assert.doesNotMatch(source, /openStateStore\(|createMineruApiSession\(|new MineruApiSession|createInterface\(|admitOperation\(/);
  assert.match(source, /loadEngineContext\(/);
  assert.match(source, /runMenu\(/);
  assert.match(source, /routeCommand\(/);
});

test('the executable entry exports main rather than exposing business routes', async () => {
  const entry = await import('../src/cli.ts');
  assert.deepEqual(Object.keys(entry), ['main']);
});

test('the sole CLI launcher preserves target flags, UTF-8 stdin and the target exit code', async () => {
  const child = Bun.spawn([process.execPath, join(root, 'src/cli.ts'), '--process-launcher', '--', process.execPath, '-e',
    'console.log(JSON.stringify({ args: process.argv.slice(1), stdin: await Bun.stdin.text() })); process.exitCode = 7;',
    '--', '--library', 'target-library', '--worker'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  child.stdin.write(JSON.stringify({ stdinText: '正文🙂' }));
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(stderr, '');
  assert.equal(code, 7);
  assert.deepEqual(JSON.parse(stdout), { args: ['--library', 'target-library', '--worker'], stdin: '正文🙂' });
});

test('project exposes Bun CLI scripts without the retired web entrypoints', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts.start, 'bun src/cli.ts');
  assert.equal(packageJson.scripts.cli, 'bun src/cli.ts');
  assert.equal(packageJson.scripts.build, undefined);
  for (const path of ['src/server.ts', 'src/start.ts', 'src/dev.ts', 'src/build-ui.ts', 'src/http']) {
    assert.equal(existsSync(join(root, path)), false, path);
  }
});

test('the active project has no retired operational script boundary', () => {
  const legacyScript = ['.', 'p', 's', '1'].join('');
  const legacyInterop = ['.', 'c', 's'].join('');
  const files: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) collect(path); else files.push(path);
    }
  };
  for (const directory of [join(root, 'scripts'), join(root, 'automation'), join(root, 'src')]) collect(directory);
  assert.deepEqual(files.filter(path => path.endsWith(legacyScript) || path.endsWith(legacyInterop)), []);
  const legacyShell = ['Power', 'Shell'].join('').toLowerCase();
  for (const path of ['src/runtime/process.ts', 'src/runtime/run-lock.ts', 'src/library/sources/pdf-store.ts', 'src/library/schedule/schedule-config.ts']) {
    assert.equal(readFileSync(join(root, path), 'utf8').toLowerCase().includes(legacyShell), false, path);
  }
});

test('project ships every SQL migration required by the Bun state store', () => {
  for (const name of [
    '001-initial.sql',
    '002-local-mineru.sql',
    '003-harvest-checkpoints.sql',
    '004-evidence-reviews.sql',
    '005-paper-source-metadata.sql',
    '006-evidence-publications.sql',
  ]) {
    assert.equal(existsSync(join(root, 'migrations', name)), true, name);
  }
});
