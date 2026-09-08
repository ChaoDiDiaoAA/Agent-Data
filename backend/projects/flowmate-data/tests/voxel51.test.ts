import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from './fixtures/voxel51-samples.json';
import { loadSourceConfig } from '../src/config.ts';
import type { FlowmatePaths } from '../src/contracts.ts';
import { createSourceHttp, resolveHuggingFaceRevision } from '../src/sources/dataset-records.ts';
import { assertVoxel51AcquireLimit, readVoxel51Index, selectVoxel51, acquireVoxel51Selection, probeVoxel51 } from '../src/sources/voxel51.ts';
import { runCli } from '../src/cli.ts';

const revision = 'd21f03cfeea2b330e15a229883c66d7ebece8e69';
const sourcePath = join(import.meta.dir, '../config/sources/voxel51-invoice-ocr.json');
const workbenchPath = join(import.meta.dir, 'fixtures/workbench.json');
const indexBytes = Buffer.from(JSON.stringify(fixture));
const roots: string[] = [];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function paths(): Promise<FlowmatePaths> {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-voxel51-'));
  roots.push(root);
  return { projectRoot: join(import.meta.dir, '..'), paperEngineRoot: join(root, 'engine'), originalRoot: join(root, 'original'), dataRoot: join(root, 'data'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('selects only annotated publisher records and sorts by record id, not image name', () => {
  const input = structuredClone(fixture);
  input.samples[0]!.json_annotation = '';
  input.samples.reverse();
  const selection = selectVoxel51(readVoxel51Index(Buffer.from(JSON.stringify(input))), { limit: 2, revision });
  expect(selection.records.map(record => record.source_record_id)).toEqual(['6984bad10f763d83586fdd2e', '6984bad10f763d83586fdd2f']);
  expect(selection.records[0]!.image_path).toBe('data/batch1-0489.jpg');
  expect(selection.records[0]!.annotation_locator).toBe('/samples/1');
});

test('enforces the configured total and annotated Voxel51 counts before acquisition', () => {
  const config = loadSourceConfig(sourcePath);
  expect(() => assertVoxel51AcquireLimit(config, 20)).not.toThrow();
  expect(() => assertVoxel51AcquireLimit(config, 1490)).toThrow('VOXEL51_LIMIT_EXCEEDS_ANNOTATED_RECORDS');
  expect(() => assertVoxel51AcquireLimit(config, 8182)).toThrow('VOXEL51_LIMIT_EXCEEDS_TOTAL_RECORDS');
});

test('pins a stable selection hash to revision and exact record/annotation pairing', () => {
  const records = readVoxel51Index(indexBytes);
  const selection = selectVoxel51(records, { limit: 2, revision });
  expect(selection.selection_hash).toBe(selectVoxel51([...records].reverse(), { limit: 2, revision }).selection_hash);
  expect(selection.selection_hash).not.toBe(selectVoxel51(records, { limit: 2, revision: 'a'.repeat(40) }).selection_hash);
  expect(selection.records[0]!.sample_id).not.toBe(selectVoxel51(records, { limit: 2, revision: 'a'.repeat(40) }).records[0]!.sample_id);
  expect(selection.records[0]!.sample_id).toBe('voxel51-84b83a4d92669a6dec10');
  expect(selection.records[0]!.image_path).toBe(fixture.samples[0]!.filepath);
  expect(selection.records[0]!.annotation_sha256).toMatch(/^[a-f0-9]{64}$/);
});

test('rejects ambiguous ids, unsafe paths, abbreviated revisions and insufficient annotated samples', () => {
  expect(() => readVoxel51Index(Buffer.from(JSON.stringify({ samples: [fixture.samples[0], fixture.samples[0]] })))).toThrow('VOXEL51_DUPLICATE_RECORD');
  for (const filepath of ['../secret.jpg', 'data/%2e%2e/secret.jpg', 'https://other.example/a.jpg', 'data/a.exe']) {
    expect(() => readVoxel51Index(Buffer.from(JSON.stringify({ samples: [{ ...fixture.samples[0], filepath }] })))).toThrow();
  }
  expect(() => selectVoxel51(readVoxel51Index(indexBytes), { limit: 1, revision: 'd21f03c' })).toThrow('INVALID_HUGGINGFACE_REVISION');
  expect(() => selectVoxel51(readVoxel51Index(indexBytes), { limit: 20, revision })).toThrow('VOXEL51_INSUFFICIENT_ANNOTATED_RECORDS');
  for (const json_annotation of ['', 'null', '{}', '[]', 'not JSON']) {
    const records = readVoxel51Index(Buffer.from(JSON.stringify({ samples: [{ ...fixture.samples[0], json_annotation }] })));
    expect(() => selectVoxel51(records, { limit: 1, revision })).toThrow('VOXEL51_INSUFFICIENT_ANNOTATED_RECORDS');
  }
});

test('resolves the full API SHA and fails closed on an unregistered redirect with its exact origin', async () => {
  const config = loadSourceConfig(sourcePath);
  const valid = createSourceHttp(config, { fetch: async () => Response.json({ sha: revision }) });
  expect(await resolveHuggingFaceRevision(config, { http: valid.http })).toBe(revision);
  const short = createSourceHttp(config, { fetch: async () => Response.json({ sha: 'd21f03c' }) });
  await expect(resolveHuggingFaceRevision(config, { http: short.http })).rejects.toThrow('INVALID_HUGGINGFACE_REVISION');
  const blocked = createSourceHttp(config, { fetch: async () => new Response(null, { status: 302, headers: { location: 'https://unregistered.hf.co/signed?token=secret' } }) });
  await expect(resolveHuggingFaceRevision(config, { http: blocked.http })).rejects.toThrow('REDIRECT_ORIGIN_NOT_ALLOWED: https://unregistered.hf.co');
});

test('probe reads API and pinned index metadata and reports scrubbed permitted redirects, without images', async () => {
  const config = loadSourceConfig(sourcePath);
  const transport = createSourceHttp(config, { fetch: async url => {
    if (url === config.revision.url) return Response.json({ sha: revision });
    if (url.includes(`/${revision}/samples.json`)) return new Response(null, { status: 302, headers: { location: 'https://cdn-lfs.hf.co/index.json?token=secret' } });
    if (new URL(url).origin === 'https://cdn-lfs.hf.co') return Response.json(fixture);
    throw new Error('UNEXPECTED_IMAGE_REQUEST');
  } });
  const probe = await probeVoxel51(config, { transport });
  expect(probe.revision).toBe(revision);
  expect(probe.record_count).toBe(3);
  expect(probe.index_sha256).toBe(sha(indexBytes));
  expect(probe.redirect_chain).toEqual([{ from_origin: 'https://huggingface.co', to_origin: 'https://cdn-lfs.hf.co' }]);
  expect(JSON.stringify(probe)).not.toContain('secret');
});

test('acquisition stores original record objects and receipts, then reuses the persisted selection offline', async () => {
  const configuredPaths = await paths();
  const config = loadSourceConfig(sourcePath);
  const imageA = Buffer.from([0xff, 0xd8, 0xff, 1]);
  const imageB = Buffer.from([0xff, 0xd8, 0xff, 2]);
  const transport = createSourceHttp(config, { fetch: async url => {
    if (url === config.revision.url) return Response.json({ sha: revision });
    if (url.endsWith(`/${revision}/samples.json`)) return new Response(indexBytes);
    if (url.endsWith(`/${revision}/data/batch1-0494.jpg`)) return new Response(imageA, { headers: { 'content-type': 'image/jpeg' } });
    if (url.endsWith(`/${revision}/data/batch1-0489.jpg`)) return new Response(imageB, { headers: { 'content-type': 'image/jpeg' } });
    throw new Error(`UNEXPECTED_URL ${url}`);
  } });
  const result = await acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 2, transport });
  expect({ added: result.added, reused: result.reused }).toEqual({ added: 2, reused: 0 });
  const datasetBase = join('datasets', 'voxel51-hq-invoice-ocr');
  const selectionPath = join(configuredPaths.dataRoot, datasetBase, 'selections', 'initial-20.json');
  const selectionBytes = await readFile(selectionPath);
  const selection = JSON.parse(selectionBytes.toString());
  expect(selection.revision).toBe(revision);
  expect(selection.index_sha256).toBe(sha(indexBytes));
  expect(selection.index_url).toContain(`/${revision}/samples.json`);
  for (const [index, entry] of selection.records.entries()) {
    const originalDir = join(configuredPaths.originalRoot, datasetBase, 'samples', entry.sample_id);
    expect(JSON.parse(await readFile(join(originalDir, 'annotation.json'), 'utf8'))).toEqual(fixture.samples[index]);
    expect(await readFile(join(originalDir, 'original.jpg'))).toEqual(index === 0 ? imageA : imageB);
    const record = JSON.parse(await readFile(join(configuredPaths.dataRoot, datasetBase, 'samples', entry.sample_id, 'record.json'), 'utf8'));
    expect(record.original_sha256).toBe(sha(index === 0 ? imageA : imageB));
    expect(record.source_record_id).toBe(fixture.samples[index]!._id.$oid);
    expect(record.annotation_sha256).toBe(sha(await readFile(join(originalDir, 'annotation.json'))));
    const receipt = JSON.parse(await readFile(join(configuredPaths.dataRoot, datasetBase, 'samples', entry.sample_id, 'receipt.json'), 'utf8'));
    expect(receipt.sha256).toBe(record.original_sha256);
  }
  const dataset = JSON.parse(await readFile(join(configuredPaths.dataRoot, datasetBase, 'dataset.json'), 'utf8'));
  expect(dataset).toMatchObject({ publisher: 'Voxel51', hosting_platform: 'Hugging Face', revision, record_count: 8181, annotated_record_count: 1489, retention: 'allowed', local_use: 'allowed', redistribution: 'unknown' });
  const offline = createSourceHttp(config, { fetch: async () => { throw new Error('NETWORK_FORBIDDEN_ON_REUSE'); } });
  expect(await acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 2, transport: offline })).toMatchObject({ added: 0, reused: 2 });
  expect(await readFile(selectionPath)).toEqual(selectionBytes);
  await expect(acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 3, transport: offline })).rejects.toThrow('SELECTION_LIMIT_CONFLICT');
  const first = selection.records[0];
  const firstAnnotation = join(configuredPaths.originalRoot, datasetBase, 'samples', first.sample_id, 'annotation.json');
  const originalAnnotation = await readFile(firstAnnotation);
  await writeFile(firstAnnotation, '{}');
  await expect(acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 2, transport: offline })).rejects.toThrow('VOXEL51_ANNOTATION_HASH_MISMATCH');
  await writeFile(firstAnnotation, originalAnnotation);
  const firstReceipt = join(configuredPaths.dataRoot, datasetBase, 'samples', first.sample_id, 'receipt.json');
  const originalReceipt = await readFile(firstReceipt);
  await writeFile(firstReceipt, JSON.stringify({ ...JSON.parse(originalReceipt.toString()), stable_url: 'https://other.example/invoice.jpg' }));
  await expect(acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 2, transport: offline })).rejects.toThrow('VOXEL51_RECEIPT_MISMATCH');
  await writeFile(firstReceipt, originalReceipt);
  // Simulate a crash after immutable originals/receipt were installed but before record.json was committed.
  await unlink(join(configuredPaths.dataRoot, datasetBase, 'samples', first.sample_id, 'record.json'));
  expect(await acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 2, transport })).toMatchObject({ added: 1, reused: 1 });
  expect(await readdir(join(configuredPaths.dataRoot, 'work', 'downloads'))).toEqual([]);
  await writeFile(join(configuredPaths.originalRoot, datasetBase, 'samples', first.sample_id, 'original.jpg'), 'tampered');
  await expect(acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 2, transport: offline })).rejects.toThrow('VOXEL51_ORIGINAL_HASH_MISMATCH');
});

test('keeps dataset metadata immutable while allowing a later source revision', async () => {
  const configuredPaths = await paths();
  const config = loadSourceConfig(sourcePath);
  const nextRevision = 'b'.repeat(40);
  const image = Buffer.from([0xff, 0xd8, 0xff, 9]);
  const transport = (currentRevision: string) => createSourceHttp(config, { fetch: async url => {
    if (url === config.revision.url) return Response.json({ sha: currentRevision });
    if (url.endsWith(`/${currentRevision}/samples.json`)) return new Response(indexBytes);
    if (url.endsWith(`/${currentRevision}/data/batch1-0494.jpg`)) return new Response(image, { headers: { 'content-type': 'image/jpeg' } });
    throw new Error(`UNEXPECTED_URL ${url}`);
  } });
  await expect(acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'first', limit: 1, transport: transport(revision) })).resolves.toMatchObject({ added: 1, revision });
  await expect(acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'second', limit: 1, transport: transport(nextRevision) })).resolves.toMatchObject({ added: 1, revision: nextRevision });
  const datasetRoot = join(configuredPaths.dataRoot, 'datasets/voxel51-hq-invoice-ocr');
  const stable = JSON.parse(await readFile(join(datasetRoot, 'dataset.json'), 'utf8')) as { revision: string };
  expect(stable.revision).toBe(revision);
  expect((JSON.parse(await readFile(join(datasetRoot, 'revisions', nextRevision, 'dataset.json'), 'utf8')) as { revision: string }).revision).toBe(nextRevision);
});

test('CLI dispatches probe/acquire and preserves usage exit for unsupported commands', async () => {
  const configuredPaths = await paths();
  const configPath = join(configuredPaths.dataRoot, '..', 'paths.json');
  await writeFile(configPath, JSON.stringify(configuredPaths));
  const output: unknown[] = [];
  const transport = createSourceHttp(loadSourceConfig(sourcePath), { fetch: async url => {
    if (url.endsWith('/revision/main')) return Response.json({ sha: revision });
    if (url.endsWith('/samples.json')) return Response.json(fixture);
    if (url.endsWith(`/${revision}/data/batch1-0494.jpg`)) return new Response(Buffer.from([0xff, 0xd8, 0xff, 1]), { headers: { 'content-type': 'image/jpeg' } });
    throw new Error('UNEXPECTED_CLI_REQUEST');
  } });
  expect(await runCli(['source', 'probe', 'voxel51-invoice-ocr', '--paths', configPath, '--config', workbenchPath], { transport, print: value => output.push(value) })).toBe(0);
  expect(output[0]).toMatchObject({ revision, record_count: 3 });
  const customWorkbenchPath = join(configuredPaths.dataRoot, '..', 'workbench.json');
  await writeFile(customWorkbenchPath, JSON.stringify({
    schema_version: 1,
    sample: { source_id: 'voxel51-invoice-ocr', dataset_id: 'voxel51-hq-invoice-ocr', selection_id: 'cli-default', acquire_limit: 1, parse_limit: 1, publish_snapshot: false },
    knowledge: { source_ids: [], parse_source_ids: [] },
    release: { version: 'public-invoice-p0-v1', include_originals: false },
    backup: { verify: false, restore_smoke: false },
  }));
  expect(await runCli(['acquire', 'voxel51-invoice-ocr', '--paths', configPath, '--config', customWorkbenchPath], { transport, print: value => output.push(value) })).toBe(0);
  expect(output[1]).toMatchObject({ revision, added: 1, reused: 0 });
  expect(await Bun.file(join(configuredPaths.dataRoot, 'datasets/voxel51-hq-invoice-ocr/selections/cli-default.json')).exists()).toBe(true);
  expect(await runCli(['acquire', 'voxel51-invoice-ocr', '--selection', 'initial-20', '--limit', '1', '--paths', configPath, '--config', workbenchPath], { transport, print: value => output.push(value) })).toBe(0);
  expect(output[2]).toMatchObject({ revision, added: 0, reused: 1 });
  expect(await runCli(['unknown'])).toBe(2);
  expect(await runCli(['acquire', 'voxel51-invoice-ocr', '--limit', 'abc', '--paths', configPath])).toBe(2);
});

test('acquisition rejects image magic and blocked CDN redirects without recording a downloaded sample', async () => {
  const config = loadSourceConfig(sourcePath);
  for (const mode of ['magic', 'redirect'] as const) {
    const configuredPaths = await paths();
    const transport = createSourceHttp(config, { fetch: async url => {
      if (url === config.revision.url) return Response.json({ sha: revision });
      if (url.endsWith('/samples.json')) return Response.json(fixture);
      return mode === 'magic' ? new Response('<html>blocked</html>', { headers: { 'content-type': 'image/jpeg' } }) : new Response(null, { status: 302, headers: { location: 'https://new-cdn.example/image.jpg?signed=secret' } });
    } });
    await expect(acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 1, transport })).rejects.toThrow(mode === 'magic' ? 'FILE_MIME_MISMATCH' : 'REDIRECT_ORIGIN_NOT_ALLOWED: https://new-cdn.example');
    expect(await Bun.file(join(configuredPaths.dataRoot, 'datasets/voxel51-hq-invoice-ocr/samples/voxel51-84b83a4d92669a6dec10/record.json')).exists()).toBe(false);
  }
});

test('recovers a legacy orphan index after upstream main advances without manual cleanup', async () => {
  const configuredPaths = await paths();
  const config = loadSourceConfig(sourcePath);
  const selectionDir = join(configuredPaths.dataRoot, 'datasets/voxel51-hq-invoice-ocr/selections');
  await mkdir(selectionDir, { recursive: true });
  // Old write ordering could leave this index without any committed selection/revision intent.
  await writeFile(join(selectionDir, 'initial-20.index.json'), indexBytes);
  const advancedRevision = 'a'.repeat(40);
  const advanced = structuredClone(fixture);
  advanced.samples[0]!.ocr_text = 'REDACTED ADVANCED REVISION';
  const advancedBytes = Buffer.from(JSON.stringify(advanced));
  const transport = createSourceHttp(config, { fetch: async url => {
    if (url === config.revision.url) return Response.json({ sha: advancedRevision });
    if (url.endsWith(`/${advancedRevision}/samples.json`)) return new Response(advancedBytes);
    if (url.endsWith(`/${advancedRevision}/data/batch1-0494.jpg`)) return new Response(Buffer.from([0xff, 0xd8, 0xff, 1]), { headers: { 'content-type': 'image/jpeg' } });
    throw new Error('UNEXPECTED_OLD_REVISION_REQUEST');
  } });
  const result = await acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 1, transport });
  expect(result).toMatchObject({ revision: advancedRevision, added: 1, reused: 0 });
  const selection = JSON.parse(await readFile(join(selectionDir, 'initial-20.json'), 'utf8'));
  expect(selection.index_sha256).toBe(sha(advancedBytes));
  expect(await readFile(join(selectionDir, 'initial-20.index.json'))).toEqual(advancedBytes);
  const annotation = join(configuredPaths.originalRoot, 'datasets/voxel51-hq-invoice-ocr/samples', selection.records[0].sample_id, 'annotation.json');
  expect(JSON.parse(await readFile(annotation, 'utf8'))).toEqual(advanced.samples[0]);
});

test('restores a missing cache from persisted pinned intent and rejects different bytes at that URL', async () => {
  const configuredPaths = await paths();
  const config = loadSourceConfig(sourcePath);
  const selectionDir = join(configuredPaths.dataRoot, 'datasets/voxel51-hq-invoice-ocr/selections');
  const selectionPath = join(selectionDir, 'initial-20.json');
  const indexPath = join(selectionDir, 'initial-20.index.json');
  const initial = createSourceHttp(config, { fetch: async url => {
    if (url === config.revision.url) return Response.json({ sha: revision });
    if (url.endsWith(`/${revision}/samples.json`)) return new Response(indexBytes);
    return new Response('interrupted before image installation', { status: 403 });
  } });
  await expect(acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 1, transport: initial })).rejects.toThrow('RESEARCH_HTTP_STATUS');
  const committedSelection = await readFile(selectionPath);
  await unlink(indexPath); // State after manifest commit but before index installation.
  const advanced = structuredClone(fixture);
  advanced.samples[0]!.ocr_text = 'CHANGED UPSTREAM';
  let serveMatchingIndex = false;
  const pinned = createSourceHttp(config, { fetch: async url => {
    if (url === config.revision.url) throw new Error('MUST_NOT_RESOLVE_ADVANCED_MAIN');
    if (url.endsWith(`/${revision}/samples.json`)) return new Response(serveMatchingIndex ? indexBytes : JSON.stringify(advanced));
    if (url.endsWith(`/${revision}/data/batch1-0494.jpg`)) return new Response(Buffer.from([0xff, 0xd8, 0xff, 1]), { headers: { 'content-type': 'image/jpeg' } });
    throw new Error('MUST_USE_PINNED_URL');
  } });
  await expect(acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 1, transport: pinned })).rejects.toThrow('VOXEL51_INDEX_HASH_MISMATCH');
  expect(await Bun.file(indexPath).exists()).toBe(false);
  serveMatchingIndex = true;
  expect(await acquireVoxel51Selection({ paths: configuredPaths, config, selectionId: 'initial-20', limit: 1, transport: pinned })).toMatchObject({ revision, added: 1, reused: 0 });
  expect(await readFile(selectionPath)).toEqual(committedSelection);
  expect(await readFile(indexPath)).toEqual(indexBytes);
});
