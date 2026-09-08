import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { join, parse, relative } from 'node:path';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { dispatchBridge } from '../src/library/operations/job-bridge.ts';
import { executeOperation } from '../src/library/workflow.ts';
import { readOperationRecord } from '../src/library/operations/operation-store.ts';
import { routeImportLocal } from '../src/cli/routes.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';

interface Preview { previewId: string; expiresAt: string; files: { fileId: string; name: string; pages: number; bytes: number }[]; requiresReparseConfirmation: boolean }
const borrowedSession = () => ({
  async ensureReady() { return 'http://127.0.0.1:17860'; },
  async run() { throw new Error('preview tests must not invoke MinerU through the workflow session'); },
  async dispose() {},
});
async function pdf(pages = 2) { const document = await PDFDocument.create(); for (let i = 0; i < pages; i++) document.addPage(); return document.save(); }
async function fixture(fn: (f: { root: string; stateRoot: string; input: string; now: () => number; advance: () => void; preview: (path?: string) => Promise<Preview> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'preview-')); const stateRoot = join(root, 'state'), input = join(root, 'inputs'); let clock = Date.now();
  try {
    await mkdir(stateRoot); await mkdir(input); await mkdir(join(input, 'batch'));
    await writeFile(join(input, 'batch', 'paper.pdf'), await pdf());
    await writeLayeredConfigFixture({ root, localImportRoots: [{ id: 'papers', path: input }] });
    const enginePath = join(root, 'config', 'engine.yaml');
    const engine = (await import('yaml')).default.parse(await readFile(enginePath, 'utf8'));
    Object.assign(engine.mineru.local_import, { max_files: 2, max_pdf_pages: 3, max_pdf_size_mb: 1, default_track: 'software' });
    await writeFile(enginePath, JSON.stringify(engine));
    const context = { root, stateRoot, operationsRoot: stateRoot, dataRoot: stateRoot, now: () => clock };
    await fn({ ...context, input, advance: () => { clock += 600001; }, preview: async (relativePath = 'batch') =>
      await dispatchBridge({ command: 'preview', payload: { rootId: 'papers', relativePath } }, context) as Preview });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const request = (previewId: string, requestId = 'confirm', reparse = false) => ({ libraryId: 'fsd', requestId, operation: { kind: 'import', previewId, reparse } });

test('preview exposes only FSD-configured safe root labels and PDF metadata without opening a database', () => fixture(async f => {
  const info = await dispatchBridge({ command: 'info', payload: {} }, f);
  assert.deepEqual(info, { libraryId: 'fsd', capabilities: { collection: true, localPreview: true, evidencePublication: true }, protocolVersion: 1,
    importRoots: [{ id: 'papers', label: 'papers' }] });
  const preview = await f.preview();
  assert.equal(preview.files.length, 1); assert.equal(preview.files[0].name, 'paper.pdf'); assert.equal(preview.files[0].pages, 2);
  assert.ok(preview.files[0].bytes > 0); assert.equal(Date.parse(preview.expiresAt) - f.now(), 600000);
  assert.equal(preview.requiresReparseConfirmation, true); assert.doesNotMatch(JSON.stringify(preview), /inputs|state|pageTextPath|sha256/);
  assert.equal((await readdir(f.stateRoot)).includes('papers.sqlite'), false);
}));

test('preview rejects path traversal, absolute paths, unknown roots and links including a linked ancestor', () => fixture(async f => {
  for (const relativePath of ['../batch', '/batch', 'C:/secret.pdf', 'batch\\paper.pdf', 'batch/../paper.pdf', 'batch/./paper.pdf'])
    await assert.rejects(f.preview(relativePath), { code: 'INVALID_REQUEST' });
  await assert.rejects(dispatchBridge({ command: 'preview', payload: { rootId: 'unknown', relativePath: 'batch' } }, f), { code: 'SOURCE_NOT_AUTHORIZED' });
  await symlink(join(f.input, 'batch'), join(f.input, 'linked'), 'junction');
  await assert.rejects(f.preview('linked/paper.pdf'), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.preview('linked'), { code: 'INVALID_REQUEST' });
  await symlink(join(f.input, 'batch'), join(f.input, 'batch/nested-link'), 'junction');
  await assert.rejects(f.preview(), { code: 'INVALID_REQUEST' }); // Recursive scan also refuses the linked entry, rather than following it.
}));

test('preview enforces PDF type, per-file size/page limits and file-count cap', () => fixture(async f => {
  await writeFile(join(f.input, 'not.txt'), 'text'); await assert.rejects(f.preview('not.txt'), { code: 'INVALID_REQUEST' });
  await writeFile(join(f.input, 'broken.pdf'), '%PDF-not-a-document'); await assert.rejects(f.preview('broken.pdf'), { code: 'INVALID_REQUEST' });
  await writeFile(join(f.input, 'large.pdf'), Buffer.alloc(1024 * 1024 + 1)); await assert.rejects(f.preview('large.pdf'), { code: 'IMPORT_LIMIT_EXCEEDED' });
  await writeFile(join(f.input, 'pages.pdf'), await pdf(4)); await assert.rejects(f.preview('pages.pdf'), { code: 'IMPORT_LIMIT_EXCEEDED' });
  await writeFile(join(f.input, 'batch/two.pdf'), await pdf()); await writeFile(join(f.input, 'batch/three.pdf'), await pdf());
  await assert.rejects(f.preview(), { code: 'IMPORT_LIMIT_EXCEEDED' });
}));

test('confirmation rejects changed content or membership without admitting a job', () => fixture(async f => {
  const first = await f.preview(); await writeFile(join(f.input, 'batch/paper.pdf'), await pdf(3));
  await assert.rejects(dispatchBridge({ command: 'admit', payload: request(first.previewId) }, f), { code: 'PREVIEW_CHANGED' });
  const second = await f.preview(); await writeFile(join(f.input, 'batch/new.pdf'), await pdf());
  await assert.rejects(dispatchBridge({ command: 'admit', payload: request(second.previewId) }, f), { code: 'PREVIEW_CHANGED' });
  assert.deepEqual(await dispatchBridge({ command: 'list', payload: {} }, f), []);
}));

test('confirmation requires a fresh preview and an explicit reparse boolean', () => fixture(async f => {
  const preview = await f.preview(); f.advance();
  await assert.rejects(dispatchBridge({ command: 'admit', payload: request(preview.previewId) }, f), { code: 'PREVIEW_EXPIRED' });
  const fresh = await f.preview(); const raw = request(fresh.previewId); delete (raw.operation as { reparse?: boolean }).reparse;
  await assert.rejects(dispatchBridge({ command: 'admit', payload: raw }, f), { code: 'INVALID_REQUEST' });
  assert.deepEqual(await dispatchBridge({ command: 'list', payload: {} }, f), []);
}));

test('confirmation freezes checked PDFs, retries one request idempotently after expiry and executes only that snapshot', () => fixture(async f => {
  const preview = await f.preview(); const original = await readFile(join(f.input, 'batch/paper.pdf'));
  const admitted = await dispatchBridge({ command: 'admit', payload: request(preview.previewId, 'confirmed', true) }, f) as { job: { jobId: string }; replayed: boolean };
  assert.equal(admitted.replayed, false); assert.doesNotMatch(JSON.stringify(admitted), /inputs|state|paper\.pdf/);
  await writeFile(join(f.input, 'batch/paper.pdf'), await pdf(1)); f.advance();
  const replay = await dispatchBridge({ command: 'admit', payload: request(preview.previewId, 'confirmed', true) }, f) as typeof admitted;
  assert.equal(replay.job.jobId, admitted.job.jobId); assert.equal(replay.replayed, true);
  let seen = false;
  const result = await executeOperation({ root: f.root, jobId: admitted.job.jobId }, { operationsRoot: f.stateRoot, dataRoot: f.stateRoot, mineruSession: borrowedSession(), importLocal: async (operation, context) => {
    assert.equal(operation.reparse, true); assert.ok(context.confirmedImport); assert.equal(context.confirmedImport.files.length, 1);
    assert.deepEqual(await readFile(context.confirmedImport.files[0]), original); seen = true; return { status: 'completed' };
  } });
  assert.equal(result.status, 'completed'); assert.equal(seen, true); assert.equal(readOperationRecord(f.stateRoot, admitted.job.jobId).status, 'completed');
}));

test('changed FSD import-root policy invalidates preview and a tampered confirmed snapshot never reaches the importer', () => fixture(async f => {
  const preview = await f.preview();
  const policyPath = join(f.root, 'config/engine.yaml'), policy = (await import('yaml')).default.parse(await readFile(policyPath, 'utf8'));
  policy.mineru.local_import.roots = [];
  await writeFile(policyPath, JSON.stringify(policy));
  await assert.rejects(dispatchBridge({ command: 'admit', payload: request(preview.previewId) }, f), { code: 'PREVIEW_CHANGED' });
  policy.mineru.local_import.roots = [{ id: 'papers', path: f.input }]; await writeFile(policyPath, JSON.stringify(policy));
  const admitted = await dispatchBridge({ command: 'admit', payload: request(preview.previewId) }, f) as { job: { jobId: string } };
  const stored = readOperationRecord(f.stateRoot, admitted.job.jobId).confirmedImport!;
  await writeFile(join(f.stateRoot, 'import-snapshots', stored.snapshotId, stored.files[0].fileId, stored.files[0].name), await pdf(1));
  const result = await executeOperation({ root: f.root, jobId: admitted.job.jobId }, { operationsRoot: f.stateRoot, dataRoot: f.stateRoot, mineruSession: borrowedSession(), importLocal: async () => { assert.fail('tampered PDF reached importer'); } });
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'PREVIEW_CHANGED');
}));

test('real Bun preview bridge returns a bounded safe JSON response for synthetic PDFs', () => fixture(async f => {
  const child = Bun.spawn([process.execPath, join(process.cwd(), 'src/cli.ts'), '--library', 'fsd', '--bridge'], { cwd: f.root,
    stdin: new Blob([JSON.stringify({ command: 'preview', payload: { rootId: 'papers', relativePath: 'batch' } })]), stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text();
  assert.equal(await child.exited, 0); assert.equal(stderr, '');
  const value = JSON.parse(stdout); assert.equal(value.ok, true); assert.equal(value.result.files[0].pages, 2);
  assert.doesNotMatch(stdout, /inputs|state|sha256|sourcePath/);
}));

test('a configured Windows volume root permits only its selected temporary PDF descendant', { skip: process.platform !== 'win32' }, () => fixture(async f => {
  const policyPath = join(f.root, 'config/engine.yaml'), policy = (await import('yaml')).default.parse(await readFile(policyPath, 'utf8'));
  policy.mineru.local_import.roots[0].path = parse(f.root).root; await writeFile(policyPath, JSON.stringify(policy));
  const preview = await f.preview(relative(parse(f.root).root, join(f.input, 'batch/paper.pdf')).split('\\').join('/'));
  assert.equal(preview.files[0].pages, 2);
}));

for (const timing of ['before-inspect', 'after-inspect', 'before-inspect-oversize', 'before-inspect-missing'] as const) test(`confirmed SHA and size survive actual importer handoff (${timing})`, () => fixture(async f => {
  const preview = await f.preview();
  const admitted = await dispatchBridge({ command: 'admit', payload: request(preview.previewId) }, f) as { job: { jobId: string } };
  const store = openStateStore(join(f.stateRoot, 'papers.sqlite')); let parserCalls = 0, changed = false;
  const replacement = await pdf(1);
  const config = { stateRoot: f.stateRoot, outputRoot: join(f.stateRoot, 'extracted'), vaultRoot: join(f.root, 'vault'), model: 'pipeline', cliBackend: 'pipeline',
    localImport: { recursive: true, maxFiles: 2, maxPdfPages: 3, maxPdfSizeMb: 1, defaultTrack: 'software' } };
  try {
    const result = await executeOperation({ root: f.root, jobId: admitted.job.jobId }, { operationsRoot: f.stateRoot, dataRoot: f.stateRoot, mineruSession: borrowedSession(), importLocal: async (_operation, context) => {
      assert.ok(context.confirmedImport); const path = context.confirmedImport.files[0];
      if (timing.startsWith('before-inspect')) {
        if (timing === 'before-inspect-missing') await rm(path);
        else await writeFile(path, timing === 'before-inspect-oversize' ? Buffer.alloc(1024 * 1024 + 1) : replacement);
        changed = true;
      }
      const controlledStore = timing !== 'after-inspect' ? store : new Proxy(store, { get(target, name) {
        if (name === 'exportManifest') return () => { if (!changed) { writeFileSync(path, replacement); changed = true; } return target.exportManifest(); };
        const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
      } });
      return routeImportLocal(['--path', context.confirmedImport.path], { ...context, config, stateStore: controlledStore,
        processContext: { safetyRoot: join(f.stateRoot, 'locks/processes'), policy: { processCleanupTimeoutMs: 1800, diagnosticTimeoutMs: 5000, maxOutputBytes: 16384 } },
        runner: async () => { parserCalls++; return { exitCode: 1 }; } });
    } });
    assert.equal(changed, true); assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'PREVIEW_CHANGED');
    assert.equal(result.canResume, true); assert.equal(parserCalls, 0); assert.equal(store.exportManifest().length, 0);
  } finally { store.close(); }
}));
