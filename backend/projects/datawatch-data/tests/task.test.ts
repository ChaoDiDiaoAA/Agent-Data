import { expect, test } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataWatchPaths, HttpClient, HttpResult, SourceConfig, WorkbenchConfig } from '../src/contracts.ts';
import { runDataWatchTask } from '../src/task.ts';
import { createDownloader } from '../src/downloader.ts';

const revision = 'b'.repeat(40);
const workbench: WorkbenchConfig = {
  schema_version: 1,
  enabled_dataset_ids: ['fda-recalls'],
  publish_snapshot: true,
  max_response_bytes: 1024 * 1024,
  request_timeout_ms: 1000,
};
const source: SourceConfig = {
  schema_version: 1,
  source_id: 'fda-recalls',
  dataset_id: 'fda-recalls',
  repository: 'wapplewhite4/fda-recall-intelligence',
  homepage: 'https://huggingface.co/datasets/wapplewhite4/fda-recall-intelligence',
  revision: { kind: 'huggingface-api', url: 'https://huggingface.co/api/datasets/wapplewhite4/fda-recall-intelligence' },
  tree_url_template: 'https://huggingface.co/api/datasets/wapplewhite4/fda-recall-intelligence/tree/{revision}?recursive=true',
  file_url_template: 'https://huggingface.co/datasets/wapplewhite4/fda-recall-intelligence/resolve/{revision}/{path}',
  allowed_origins: ['https://huggingface.co'],
  redirect_origins: [],
  declared_license: 'CC BY 4.0',
  license_evidence: 'https://creativecommons.org/licenses/by/4.0/',
  data_kind: 'public-fda-recall-sample',
  origin_kind: 'public_redacted',
  retention: 'allowed',
  local_use: 'allowed',
  redistribution: 'allowed',
  language: 'en',
  enabled: true,
};

async function paths(): Promise<DataWatchPaths> {
  const root = await mkdtemp(join(tmpdir(), 'datawatch-task-'));
  return {
    projectRoot: root,
    paperEngineRoot: join(root, 'engine'),
    originalRoot: join(root, 'original'),
    dataRoot: join(root, 'data'),
    vaultRoot: join(root, 'vault'),
    backupRoot: join(root, 'backup'),
  };
}
function fakeHttp(onFile?: () => void) {
  return {
    async get(url: string): Promise<HttpResult> {
      if (url.includes('/api/datasets/')) return { url, status: 200, headers: new Headers(), bytes: new TextEncoder().encode(JSON.stringify(url.includes('/tree/') ? [{ type: 'file', path: 'README.md', size: 3 }] : { sha: revision })) };
      onFile?.();
      return { url, status: 200, headers: new Headers(), bytes: new TextEncoder().encode('abc') };
    },
  };
}

test('runs probe, acquisition, catalog, and verify with a fixed revision and resumes without redownloading', async () => {
  const dataPaths = await paths();
  let fileCalls = 0;
  const first = await runDataWatchTask({
    paths: dataPaths,
    sources: [source],
    datasetIds: ['fda-recalls'],
    workbench,
    httpFactory: () => fakeHttp(() => { fileCalls += 1; }),
  });
  expect(first.status).toBe('completed');
  expect(first.datasets[0]?.revision).toBe(revision);
  const callsAfterFirst = fileCalls;
  expect(callsAfterFirst).toBe(1);
  const second = await runDataWatchTask({
    paths: dataPaths,
    sources: [source],
    datasetIds: ['fda-recalls'],
    workbench,
    httpFactory: () => fakeHttp(() => { fileCalls += 1; }),
  });
  expect(second.status).toBe('completed');
  expect(fileCalls).toBe(callsAfterFirst);
  expect(await readFile(join(dataPaths.originalRoot, 'fda-recalls', 'README.md'), 'utf8')).toBe('abc');
  expect(await readFile(join(dataPaths.dataRoot, 'fda-recalls', 'manifest.json'), 'utf8')).toContain(revision);
  expect(await readFile(join(dataPaths.dataRoot, 'versions.json'), 'utf8')).toContain(revision);
  expect(await readFile(join(dataPaths.vaultRoot, 'fda-recalls', 'raw', 'README.md'), 'utf8')).toBe('abc');
});

test('resumes the same failed run after a mid-dataset interruption', async () => {
  const dataPaths = await paths();
  let fileCalls = 0;
  let interrupted = true;
  const httpFactory = (): HttpClient => ({
    async get(url: string): Promise<HttpResult> {
      if (url.includes('/api/datasets/')) {
        const body = url.includes('/tree/')
          ? JSON.stringify([
            { type: 'file', path: 'A.txt', size: 3 },
            { type: 'file', path: 'B.txt', size: 3 },
          ])
          : JSON.stringify({ sha: revision });
        return { url, status: 200, headers: new Headers(), bytes: new TextEncoder().encode(body) };
      }
      fileCalls += 1;
      return { url, status: 200, headers: new Headers(), bytes: new TextEncoder().encode(url.endsWith('/A.txt') ? 'aaa' : 'bbb') };
    },
  });
  const downloaderFactory = (_source: SourceConfig, transport: ReturnType<typeof httpFactory>) => createDownloader({
    maxAttempts: 1,
    get: async (url, request) => {
      if (interrupted && url.endsWith('/B.txt')) throw Object.assign(new Error('interrupted'), { code: 'RESEARCH_TRANSPORT_FAILED' });
      return transport.get(url, request);
    },
  });
  const first = await runDataWatchTask({ paths: dataPaths, sources: [source], datasetIds: ['fda-recalls'], workbench, httpFactory, downloaderFactory });
  expect(first.status).toBe('failed');
  expect(first.errors.some(error => error.path === 'B.txt')).toBe(true);
  expect(fileCalls).toBe(1);
  interrupted = false;
  const second = await runDataWatchTask({ paths: dataPaths, sources: [source], datasetIds: ['fda-recalls'], workbench, httpFactory, downloaderFactory });
  expect(second.status).toBe('completed');
  expect(second.run_id).toBe(first.run_id);
  expect(second.datasets[0]?.skipped).toBe(1);
  expect(fileCalls).toBe(2);
  expect(await readFile(join(dataPaths.originalRoot, 'fda-recalls', 'B.txt'), 'utf8')).toBe('bbb');
});

test('activates a changed revision, refreshes its Obsidian copy, and prunes removed managed files', async () => {
  const dataPaths = await paths();
  const run = async (revision: string, files: Record<string, string>) => runDataWatchTask({
    paths: dataPaths, sources: [source], datasetIds: ['fda-recalls'], workbench,
    httpFactory: () => ({ async get(url: string): Promise<HttpResult> {
      if (url.includes('/api/datasets/')) {
        const body = url.includes('/tree/')
          ? JSON.stringify(Object.entries(files).map(([path, body]) => ({ type: 'file', path, size: new TextEncoder().encode(body).byteLength })))
          : JSON.stringify({ sha: revision });
        return { url, status: 200, headers: new Headers(), bytes: new TextEncoder().encode(body) };
      }
      const path = decodeURIComponent(new URL(url).pathname).split('/').at(-1)!;
      return { url, status: 200, headers: new Headers(), bytes: new TextEncoder().encode(files[path]!) };
    } }),
  });
  expect((await run('a'.repeat(40), { 'A.txt': 'old', 'B.txt': 'stale' })).status).toBe('completed');
  expect((await run('c'.repeat(40), { 'A.txt': 'new' })).status).toBe('completed');
  expect(await readFile(join(dataPaths.originalRoot, 'fda-recalls', 'A.txt'), 'utf8')).toBe('new');
  expect(await readFile(join(dataPaths.vaultRoot, 'fda-recalls', 'raw', 'A.txt'), 'utf8')).toBe('new');
  await expect(readFile(join(dataPaths.originalRoot, 'fda-recalls', 'B.txt'), 'utf8')).rejects.toThrow();
  await expect(readFile(join(dataPaths.vaultRoot, 'fda-recalls', 'raw', 'B.txt'), 'utf8')).rejects.toThrow();
});

test('keeps the active snapshot and manifest unchanged when a staged revision fails', async () => {
  const dataPaths = await paths();
  const first = await runDataWatchTask({ paths: dataPaths, sources: [source], datasetIds: ['fda-recalls'], workbench, httpFactory: () => fakeHttp() });
  expect(first.status).toBe('completed');
  const nextRevision = 'e'.repeat(40);
  const httpFactory = (): HttpClient => ({ async get(url: string): Promise<HttpResult> {
    if (url.includes('/api/datasets/')) {
      const body = url.includes('/tree/') ? JSON.stringify([{ type: 'file', path: 'README.md', size: 3 }, { type: 'file', path: 'other.txt', size: 3 }]) : JSON.stringify({ sha: nextRevision });
      return { url, status: 200, headers: new Headers(), bytes: new TextEncoder().encode(body) };
    }
    if (url.includes('/other.txt')) throw Object.assign(new Error('stop'), { code: 'RESEARCH_TRANSPORT_FAILED' });
    return { url, status: 200, headers: new Headers(), bytes: new TextEncoder().encode('new') };
  } });
  const result = await runDataWatchTask({ paths: dataPaths, sources: [source], datasetIds: ['fda-recalls'], workbench, httpFactory, downloaderFactory: (_source, http) => createDownloader({ maxAttempts: 1, get: (url, request) => http.get(url, request) }) });
  expect(result.status).toBe('failed');
  expect(await readFile(join(dataPaths.originalRoot, 'fda-recalls', 'README.md'), 'utf8')).toBe('abc');
  expect(await readFile(join(dataPaths.vaultRoot, 'fda-recalls', 'raw', 'README.md'), 'utf8')).toBe('abc');
  expect(await readFile(join(dataPaths.dataRoot, 'fda-recalls', 'manifest.json'), 'utf8')).toContain(revision);
});

test('recovers a journaled activation failure to one consistent revision on retry', async () => {
  const dataPaths = await paths();
  const run = async (revision: string, body: string, activationHook?: Parameters<typeof runDataWatchTask>[0]['activationHook']) => runDataWatchTask({
    paths: dataPaths, sources: [source], datasetIds: ['fda-recalls'], workbench, activationHook,
    httpFactory: () => ({ async get(url: string): Promise<HttpResult> {
      const response = url.includes('/api/datasets/') ? (url.includes('/tree/') ? JSON.stringify([{ type: 'file', path: 'README.md', size: 3 }]) : JSON.stringify({ sha: revision })) : body;
      return { url, status: 200, headers: new Headers(), bytes: new TextEncoder().encode(response) };
    } }),
  });
  expect((await run('a'.repeat(40), 'old')).status).toBe('completed');
  expect((await run('c'.repeat(40), 'new', async phase => { if (phase === 'original-moved') throw new Error('inject'); })).status).toBe('failed');
  const recovered = await run('c'.repeat(40), 'new');
  expect(recovered.status).toBe('completed');
  expect(await readFile(join(dataPaths.originalRoot, 'fda-recalls', 'README.md'), 'utf8')).toBe('new');
  expect(await readFile(join(dataPaths.vaultRoot, 'fda-recalls', 'raw', 'README.md'), 'utf8')).toBe('new');
  expect(await readFile(join(dataPaths.dataRoot, 'fda-recalls', 'manifest.json'), 'utf8')).toContain('c'.repeat(40));
});

test('refuses to prune a user-modified formerly managed raw file', async () => {
  const dataPaths = await paths();
  const run = async (revision: string, files: Record<string, string>) => runDataWatchTask({
    paths: dataPaths, sources: [source], datasetIds: ['fda-recalls'], workbench,
    httpFactory: () => ({ async get(url: string): Promise<HttpResult> {
      const response = url.includes('/api/datasets/') ? (url.includes('/tree/') ? JSON.stringify(Object.entries(files).map(([path, body]) => ({ type: 'file', path, size: body.length }))) : JSON.stringify({ sha: revision })) : files[decodeURIComponent(new URL(url).pathname).split('/').at(-1)!]!;
      return { url, status: 200, headers: new Headers(), bytes: new TextEncoder().encode(response) };
    } }),
  });
  expect((await run('a'.repeat(40), { 'A.txt': 'old', 'B.txt': 'old' })).status).toBe('completed');
  await Bun.write(join(dataPaths.vaultRoot, 'fda-recalls', 'raw', 'B.txt'), 'note');
  const result = await run('c'.repeat(40), { 'A.txt': 'new' });
  expect(result.status).toBe('failed');
  expect(await readFile(join(dataPaths.vaultRoot, 'fda-recalls', 'raw', 'B.txt'), 'utf8')).toBe('note');
});
