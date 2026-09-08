import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../src/shared/config.ts';
import { loadMinerULocalConfig } from '../src/mineru/mineru-local-config.ts';
import { createMineruApiSession } from '../src/mineru/mineru-api-session.ts';
import { runMineruCli } from '../src/mineru/mineru-cli-runner.ts';
import { normalizeLocalMinerUResult } from '../src/mineru/mineru-local-result.ts';
import { createProcessContext, runManagedProcess, type ManagedProcessResult } from '../src/runtime/process.ts';
import { makeRuntimeFixture, realProcessFixtureCleanup } from './fixtures/runtime-fixtures.ts';

const smoke = process.env.FSD_MINERU_SMOKE === '1' ? test : test.skip;

async function smallestPdf(root: string): Promise<string> {
  const explicit = process.env.FSD_MINERU_SMOKE_PDF;
  if (explicit) {
    const path = resolve(explicit);
    const info = await stat(path);
    if (!info.isFile() || !path.toLowerCase().endsWith('.pdf')) throw new Error('FSD_MINERU_SMOKE_PDF must name a PDF file');
    return path;
  }
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
    .map(async entry => {
      const path = join(entry.parentPath, entry.name);
      return { path, bytes: (await stat(path)).size };
    }));
  candidates.sort((left, right) => left.bytes - right.bytes || left.path.localeCompare(right.path));
  if (!candidates[0]) throw new Error('no PDF is available for the real MinerU smoke; set FSD_MINERU_SMOKE_PDF');
  return candidates[0].path;
}

async function entries(path: string): Promise<string[]> {
  return readdir(path).catch(error => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
}

async function assertPortReleased(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(error => error ? reject(error) : resolvePromise());
    });
  });
}

smoke('one real MinerU API serves two requests with one model initialization and confirmed cleanup', { timeout: 600_000 }, async () => {
  const projectRoot = process.cwd();
  const fixture = await makeRuntimeFixture();
  const cleanup = realProcessFixtureCleanup(fixture);
  const processContext = createProcessContext(fixture.projectRoot);
  const config = { ...loadConfig({ root: fixture.projectRoot }), ...loadMinerULocalConfig(fixture.projectRoot) };
  const source = await smallestPdf(loadConfig({ root: projectRoot }).pdfRoot);
  const input = join(fixture.paths.tempRoot, 'smoke.pdf');
  await copyFile(source, input);

  let serverLaunches = 0;
  let serverResult: ManagedProcessResult | undefined;
  const clientResults: Awaited<ReturnType<typeof runMineruCli>>[] = [];
  const session = createMineruApiSession({
    config,
    processContext,
    dependencies: {
      managedProcess: async (spec, options) => {
        serverLaunches += 1;
        serverResult = await cleanup.invoke(() => runManagedProcess(spec, options));
        return serverResult;
      },
      runClient: async (job, options) => {
        const result = await runMineruCli(job, {
          ...options,
          managedProcess: (spec, processOptions) => cleanup.invoke(() => runManagedProcess(spec, processOptions)),
        });
        clientResults.push(result);
        return result;
      },
    },
  });

  let cleanupResult: Awaited<ReturnType<typeof cleanup.dispose>> | undefined;
  try {
    for (const name of ['one', 'two']) {
      const outputDir = join(fixture.paths.tempRoot, `mineru-${name}`);
      const result = await session.run({
        arxivId: `smoke-${name}`,
        model: config.model,
        fileSource: input,
        outputDir,
        method: config.pipelineMethod,
        language: config.pipelineLanguage,
        formula: config.formulaEnabled,
        table: config.tableEnabled,
      });
      assert.equal(result.exitCode, 0, result.stderrSummary || result.stdoutSummary || 'MinerU smoke failed');
      assert.equal(result.cleanupConfirmed, true);
      const artifact = await normalizeLocalMinerUResult({
        model: config.model,
        cliBackend: config.cliBackend,
        outputDir,
      });
      for (const path of [artifact.markdownPath, artifact.contentListPath, artifact.pageTextPath, join(artifact.normalizedDir, 'pages.json')]) {
        assert.equal(await Bun.file(path).exists(), true, `missing normalized artifact: ${path}`);
      }
    }
  } finally {
    try {
      await session.dispose();
    } finally {
      cleanupResult = await cleanup.dispose();
    }
  }

  assert.equal(serverLaunches, 1);
  assert.equal(clientResults.length, 2);
  assert.ok(serverResult);
  assert.equal(serverResult.cleanupConfirmed, true);
  const serverLog = `${serverResult.stdout}\n${serverResult.stderr}`;
  assert.equal(serverLog.match(/DocAnalysis init done!/g)?.length, 1, serverLog.slice(-4000));
  assert.match(serverLog, /Batch Ratio:\s*1\b/);
  assert.equal(cleanupResult?.disposed, true, cleanupResult && 'root' in cleanupResult ? cleanupResult.root : 'fixture cleanup did not complete');
  assert.deepEqual(await entries(processContext.safetyRoot), []);
  assert.deepEqual(await entries(join(dirname(processContext.safetyRoot), 'mineru-api-process')), []);
  await assertPortReleased(config.apiPort);
});
