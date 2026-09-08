import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

import { createStateDatabase } from '../src/runtime/sqlite.ts';
import { runMineruCli } from '../src/mineru/mineru-cli-runner.ts';
import { loadProjectPaths } from '../src/shared/config.ts';
import type { MinerUCliJob } from '../src/types/jobs.ts';
import type { MinerURunnerOptions } from '../src/mineru/mineru-cli-runner.ts';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';

const fsdRoot = resolve(import.meta.dir, '..');
const repositoryRoot = resolve(fsdRoot, '../../..');
const maintenanceRoot = join(repositoryRoot, 'docs', 'superpowers', 'migrations', '2026-08-30-layout');

async function runBun(script: string, args: string[], tempRoot: string) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, TEMP: tempRoot, TMP: tempRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function makeMaintenanceRoot(root: string) {
  const projectRoot = join(root, 'backend', 'projects', 'fsd-code2doc');
  const configRoot = join(projectRoot, 'config');
  const outputRoot = join(root, 'output');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'paths.local.yaml'), YAML.stringify({
    pdf_root: join(outputRoot, 'pdf'),
    vault_root: join(outputRoot, 'vault'),
    state_root: join(outputRoot, 'state'),
    temp_root: join(outputRoot, 'tmp'),
    backup_root: join(outputRoot, 'backups'),
  }));
  return { projectRoot, outputRoot };
}

test('active maintenance CLIs resolve TypeScript imports, preserve read-only paths, and make verified backups', { skip: !existsSync(maintenanceRoot) }, async () => {
  const fixture = await makeRuntimeFixture();
  try {
    const maintenance = await makeMaintenanceRoot(join(fixture.root, 'maintenance-repository'));
    const pathsCommand = await runBun(join(maintenanceRoot, 'project-paths.mjs'), [join(fixture.root, 'maintenance-repository')], fixture.paths.tempRoot);
    assert.equal(pathsCommand.exitCode, 0, pathsCommand.stderr);
    const paths = JSON.parse(pathsCommand.stdout) as { backupRoot: string; projectRoot: string };
    assert.equal(paths.projectRoot, maintenance.projectRoot);
    assert.equal(paths.backupRoot, join(maintenance.outputRoot, 'backups'));
    await assert.rejects(stat(paths.backupRoot), { code: 'ENOENT' });

    const source = join(fixture.paths.stateRoot, 'state.sqlite');
    const destination = join(fixture.paths.backupRoot, 'snapshot.sqlite');
    const sourceDb = createStateDatabase(source);
    sourceDb.exec('CREATE TABLE papers(id TEXT PRIMARY KEY, title TEXT); INSERT INTO papers VALUES(\'p1\', \'Fixture paper\')');
    sourceDb.close();
    const backup = await runBun(join(maintenanceRoot, 'backup-state.mjs'), [source, destination], fixture.paths.tempRoot);
    assert.equal(backup.exitCode, 0, backup.stderr);
    assert.match(backup.stdout, /SQLite backup verified/);
    const copy = createStateDatabase(destination, { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.deepEqual(copy.prepare('SELECT id, title FROM papers').all(), [{ id: 'p1', title: 'Fixture paper' }]);
    } finally { copy.close(); }
    const before = createHash('sha256').update(await readFile(destination)).digest('hex');
    const duplicate = await runBun(join(maintenanceRoot, 'backup-state.mjs'), [source, destination], fixture.paths.tempRoot);
    assert.notEqual(duplicate.exitCode, 0);
    assert.match(duplicate.stderr, /exist|EEXIST/i);
    assert.equal(createHash('sha256').update(await readFile(destination)).digest('hex'), before);
  } finally { await fixture.dispose(); }
});

test('parser smoke uses the configured timeout and an isolated managed-process context without launching MinerU', { skip: !existsSync(maintenanceRoot) }, async () => {
  const paths = loadProjectPaths({ root: fsdRoot });
  try {
    let captured: { job: MinerUCliJob; options: MinerURunnerOptions } | undefined;
    const fakeRunner: typeof runMineruCli = async (job, options) => {
      captured = { job, options };
      return {
        arxivId: job.arxivId, model: job.model, cliBackend: options.config.cliBackend,
        exitCode: 1, errorCode: 'PROCESS_SUPERVISOR_FAILED', timedOut: false,
        timeoutMs: job.timeoutMs ?? options.config.taskTimeoutMs, signal: null,
        cleanupConfirmed: true, pid: null, activePids: [], outputDir: job.outputDir,
        elapsedMs: 1, stdoutSummary: 'fake stdout', stderrSummary: 'fake stderr',
        clientStderrSummary: 'fake stderr', apiStderrSummary: '', source: null,
      };
    };
    const parser = await import(join(maintenanceRoot, 'parser-smoke.mjs')) as {
      runParserSmoke(options: { root: string; runner: typeof runMineruCli }): Promise<unknown>;
    };
    const auditRoot = join(paths.tempRoot, 'validation');
    const before = new Set(await readdir(auditRoot));
    await assert.rejects(parser.runParserSmoke({ root: repositoryRoot, runner: fakeRunner }), /Parser failed: fake stderr/);
    assert.ok(captured);
    assert.equal(captured.options.config.tempRoot, paths.tempRoot);
    assert.equal(captured.job.timeoutMs, undefined);
    assert.equal(captured.options.processContext.safetyRoot, join(paths.stateRoot, 'locks', 'processes'));
    assert.equal(captured.options.processContext.policy.diagnosticTimeoutMs, 20000);
    const directories = await readdir(auditRoot);
    const audit = join(auditRoot, directories.find(name => name.startsWith('parser-smoke-') && !before.has(name)) ?? 'missing');
    assert.match(await readFile(join(audit, 'parser-live.log'), 'utf8'), /fake stdout[\s\S]*fake stderr/);
    assert.match(await readFile(join(audit, 'parser-smoke-result.json'), 'utf8'), /PROCESS_SUPERVISOR_FAILED/);
    await rm(audit, { recursive: true, force: true });
  } finally { }
});

test('documentation verifier writes JSON only under the isolated candidate data root', { skip: !existsSync(maintenanceRoot) }, async () => {
  const paths = loadProjectPaths({ root: fsdRoot });
  const output = join(paths.tempRoot, 'validation', 'docs-check.json');
  const fixture = await makeRuntimeFixture();
  try {
    // The verifier's output follows the existing path configuration, not a
    // historical candidate installation's fixed validation/tmp layout.
    assert.notEqual(resolve(paths.tempRoot), resolve(paths.stateRoot));
    assert.notEqual(resolve(paths.tempRoot), resolve(paths.vaultRoot));
    const command = await runBun(join(maintenanceRoot, 'verify-docs.mjs'), [repositoryRoot], fixture.paths.tempRoot);
    assert.equal(command.exitCode, 0, command.stderr || command.stdout);
    const result = JSON.parse(await readFile(output, 'utf8')) as { issues: unknown[]; documents: number; localDataDocuments: Array<{ file: string; present: boolean }> };
    assert.equal(result.issues.length, 0);
    assert.ok(result.documents > 20);
    assert.ok(result.localDataDocuments.length > 0);
    for (const document of result.localDataDocuments) {
      const present = await access(join(repositoryRoot, document.file)).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      });
      assert.equal(document.present, present, document.file);
    }
    await access(output);
  } finally { await fixture.dispose(); }
});
