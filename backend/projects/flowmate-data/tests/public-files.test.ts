import { afterEach, expect, test } from 'bun:test';
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowmatePaths, SourceConfig } from '../src/contracts.ts';
import { createSourceHttp } from '../src/sources/dataset-records.ts';
import { acquirePublicFiles, parsePublicKnowledge } from '../src/sources/public-files.ts';
import { publishStructuredSnapshot } from '../src/structured-snapshot.ts';

const roots: string[] = [];

async function paths(): Promise<FlowmatePaths> {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-public-files-'));
  roots.push(root);
  return { projectRoot: root, paperEngineRoot: join(import.meta.dir, '../../paper-knowledge-engine'), originalRoot: join(root, 'paper'), dataRoot: join(root, 'data'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') };
}

function config(): SourceConfig {
  return {
    schema_version: 1, source_id: 'official-fixtures', reader: 'public-files', homepage: 'https://official.example/notice.html',
    revision: { kind: 'content-hash', url: 'https://official.example/notice.html' },
    files: [
      { id: 'notice', url: 'https://official.example/notice.html', document_kind: 'knowledge', parse: true },
      { id: 'sample', url: 'https://official.example/sample.pdf', document_kind: 'invoice_template', parse: true },
      { id: 'template', url: 'https://official.example/template.doc', document_kind: 'invoice_template', parse: false },
    ],
    allowed_origins: ['https://official.example'], redirect_origins: [], declared_license: 'Public notice', license_evidence: 'https://official.example/license',
    applicable_period: '2024-11 onward', retention: 'allowed', local_use: 'allowed', redistribution: 'unknown', origin_kind: 'public_document', language: 'zh-CN', document_kind: 'knowledge',
  };
}

async function response(url: string, changed = false): Promise<Response> {
  if (url.endsWith('.html')) {
    const page = (await readFile(join(import.meta.dir, 'fixtures/chinatax-announcement.html'), 'utf8')).replace('电子发票的一种。', `电子发票的${changed ? '更新版' : '初版'}。`);
    return new Response(page, { headers: { 'content-type': 'text/html' } });
  }
  if (url.endsWith('.pdf')) return new Response(Buffer.from('%PDF-1.7 fixture'), { headers: { 'content-type': 'application/pdf' } });
  if (url.endsWith('.doc')) return new Response(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]), { headers: { 'content-type': 'application/msword' } });
  throw new Error(`UNEXPECTED_URL ${url}`);
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('acquires only declared public files, publishes HTML, and leaves PDF selected', async () => {
  const configuredPaths = await paths();
  const requested: string[] = [];
  const source = config();
  const transport = createSourceHttp(source, { fetch: async url => { requested.push(url); return response(url); } });

  const result = await acquirePublicFiles({ paths: configuredPaths, config: source, transport, now: () => new Date('2026-09-08T01:02:03.004Z') });

  expect(requested).toEqual(source.files!.map(file => file.url));
  expect(result.records.map(record => record.parse_status)).toEqual(['parsed', 'selected', 'raw_only']);
  expect(result.records.every(record => record.label_kind === 'none')).toBe(true);
  const html = result.records[0]!;
  expect(await Bun.file(join(configuredPaths.originalRoot, html.original_ref.path)).exists()).toBe(true);
  const snapshotText = await Bun.file(join(configuredPaths.originalRoot, `knowledge/${source.source_id}/structured/${html.version}/${html.file_id}/full.md`)).text();
  expect(snapshotText).toContain('国家税务总局关于推广应用全面数字化电子发票的公告');
  expect(snapshotText).toContain('数电发票是电子发票的初版');
  expect(snapshotText).not.toContain('登录');
  expect(snapshotText).not.toContain('搜索');
  expect(snapshotText).not.toContain('联系我们');
  expect(await Bun.file(join(configuredPaths.originalRoot, `knowledge/${source.source_id}/structured/${html.version}/${html.file_id}/snapshot.json`)).exists()).toBe(true);
  const raw = result.records[2]!;
  expect(await Bun.file(join(configuredPaths.originalRoot, `knowledge/${source.source_id}/structured/${raw.version}/${raw.file_id}/snapshot.json`)).exists()).toBe(false);
});

test('parses selected PDFs through MinerU and does not fabricate DOC output', async () => {
  const configuredPaths = await paths();
  const source = config();
  const transport = createSourceHttp(source, { fetch: async url => response(url) });
  const acquired = await acquirePublicFiles({ paths: configuredPaths, config: source, transport, now: () => new Date('2026-09-08T01:02:03.004Z') });

  const parsed = await parsePublicKnowledge({ paths: configuredPaths, config: source }, {
    createSession: () => ({ async ensureReady() { return 'fake'; }, async run(job) { await cp(join(import.meta.dir, 'fixtures/mineru-output'), job.outputDir, { recursive: true }); return { exitCode: 0 }; }, async dispose() {} }),
  });

  expect(parsed.parsed).toBe(1);
  expect(parsed.records[0]).toMatchObject({ file_id: 'sample', parse_status: 'parsed', parser_key: expect.stringContaining('mineru@') });
  expect(await Bun.file(join(configuredPaths.originalRoot, `knowledge/${source.source_id}/structured/${acquired.records[1]!.version}/sample/full.md`)).exists()).toBe(true);
  expect(await Bun.file(join(configuredPaths.originalRoot, `knowledge/${source.source_id}/structured/${acquired.records[2]!.version}/template/snapshot.json`)).exists()).toBe(false);
});

test('creates a new version when the same configured URL changes content', async () => {
  const configuredPaths = await paths();
  const source = config();
  const first = await acquirePublicFiles({ paths: configuredPaths, config: source, transport: createSourceHttp(source, { fetch: async url => response(url) }), now: () => new Date('2026-09-08T01:02:03.004Z') });
  const second = await acquirePublicFiles({ paths: configuredPaths, config: source, transport: createSourceHttp(source, { fetch: async url => response(url, true) }), now: () => new Date('2026-09-08T01:02:04.004Z') });

  expect(second.records.find(record => record.file_id === 'notice')!.version).not.toBe(first.records.find(record => record.file_id === 'notice')!.version);
  expect(await readFile(join(configuredPaths.originalRoot, first.records[0]!.original_ref.path))).not.toEqual(await readFile(join(configuredPaths.originalRoot, second.records[0]!.original_ref.path)));
});

test('retains zero milliseconds in a path-safe content version', async () => {
  const configuredPaths = await paths();
  const source = config();
  const result = await acquirePublicFiles({ paths: configuredPaths, config: source, transport: createSourceHttp(source, { fetch: async url => response(url) }), now: () => new Date('2026-09-08T01:02:03.000Z') });

  expect(result.records[0]!.version).toMatch(/^20260908T010203000Z--[0-9a-f]{64}$/);
  expect(await Bun.file(join(configuredPaths.originalRoot, `knowledge/${source.source_id}/structured/${result.records[0]!.version}/notice/snapshot.json`)).exists()).toBe(true);
});

test('knowledge snapshots reject raw-only records and recover a valid previous HTML snapshot', async () => {
  const configuredPaths = await paths();
  const source = config();
  const result = await acquirePublicFiles({ paths: configuredPaths, config: source, transport: createSourceHttp(source, { fetch: async url => response(url) }), now: () => new Date('2026-09-08T01:02:03.004Z') });
  const html = result.records[0]!;
  const raw = result.records[2]!;
  const rawRecordPath = join(configuredPaths.dataRoot, 'datasets/public-invoice-knowledge', source.source_id, 'records', raw.file_id, `${raw.version}.json`);
  const normalized = join(configuredPaths.dataRoot, 'datasets/public-invoice-knowledge', source.source_id, 'normalized', html.file_id, html.version);
  await mkdir(join(configuredPaths.dataRoot, 'raw-normalized'), { recursive: true });
  await expect(publishStructuredSnapshot({ paths: configuredPaths, sourceId: source.source_id, sourceVersion: raw.version, fileId: raw.file_id, recordPath: rawRecordPath,
    normalizedDir: join(configuredPaths.dataRoot, 'raw-normalized'), sourceUrl: raw.source_url, licenseEvidence: raw.license_evidence, applicablePeriod: raw.applicable_period })).rejects.toThrow('RAW_ONLY');

  const snapshot = join(configuredPaths.originalRoot, 'knowledge', source.source_id, 'structured', html.version, html.file_id);
  const previous = `${snapshot}.previous`;
  await rename(snapshot, previous);
  await mkdir(snapshot, { recursive: true });
  await writeFile(join(snapshot, 'snapshot.json'), '{"corrupt":true}\n');
  await publishStructuredSnapshot({ paths: configuredPaths, sourceId: source.source_id, sourceVersion: html.version, fileId: html.file_id,
    recordPath: join(configuredPaths.dataRoot, 'datasets/public-invoice-knowledge', source.source_id, 'records', html.file_id, `${html.version}.json`), normalizedDir: normalized,
    sourceUrl: html.source_url, licenseEvidence: html.license_evidence, applicablePeriod: html.applicable_period });
  expect(await Bun.file(join(snapshot, 'full.md')).exists()).toBe(true);
  expect(await Bun.file(previous).exists()).toBe(false);
});

test('knowledge parse ignores selected PDFs retired from the current source configuration', async () => {
  const configuredPaths = await paths();
  const source = config();
  await acquirePublicFiles({ paths: configuredPaths, config: source, transport: createSourceHttp(source, { fetch: async url => response(url) }), now: () => new Date('2026-09-08T01:02:03.004Z') });
  const retired = { ...source, files: source.files!.filter(file => file.id !== 'sample') };

  const parsed = await parsePublicKnowledge({ paths: configuredPaths, config: retired }, { createSession: () => { throw new Error('RETIRED_PDF_MUST_NOT_PARSE'); } });
  expect(parsed).toEqual({ parsed: 0, records: [] });
});

test('registers only the Voxel51 original source', async () => {
  expect((await readdir(join(import.meta.dir, '../config/sources'))).filter(name => name.endsWith('.json')).sort()).toEqual(['voxel51-invoice-ocr.json']);
});
