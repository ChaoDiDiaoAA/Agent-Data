import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { downloadAcceptedPdf, type PdfDownloadOptions } from '../src/library/sources/pdf-store.ts';
import { removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';

function stateStore(overrides: Record<string, unknown> = {}) {
  return { findByBaseId: () => null, findBySha256: () => null, markDownloaded() {}, ...overrides };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pdf-store-'));
  const pdfRoot = join(root, 'paper');
  const tempRoot = join(root, 'tmp');
  await mkdir(pdfRoot, { recursive: true });
  return { root, pdfRoot, tempRoot };
}

test('explicit proxy downloads PDF bytes without changing the caller environment', async () => {
  const f = await fixture();
  const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const requests: string[] = [];
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests.push(request.url);
    return new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } });
  } });
  const before = { ...process.env };
  try {
    const result = await downloadAcceptedPdf({ accepted: true, paper: {
      baseId: 'proxy', arxivId: 'proxyv1', version: 1, pdfUrl: 'http://paper.invalid/proxy.pdf',
    } }, { ...f, stateStore: stateStore(), network: { httpProxy: `http://127.0.0.1:${proxy.port}` },
      maxAttempts: 1, signal: AbortSignal.timeout(3000) });
    assert.deepEqual(await readFile(result.pdfPath), bytes);
    assert.deepEqual(requests, ['http://paper.invalid/proxy.pdf']);
    assert.deepEqual({ ...process.env }, before);
  } finally { await proxy.stop(true); await removeOwnedTestDirectory(f.root); }
});

test('rejects malformed PDF metadata before transport or state mutation', async () => {
  const f = await fixture();
  try {
    let fetches = 0;
    await assert.rejects(downloadAcceptedPdf({ accepted: true, paper: { baseId: 'one', arxivId: 'onev1', version: 1, pdfUrl: 'http://127.0.0.1/unused', categories: [123] } }, {
      ...f, stateStore: stateStore({ markDownloaded() { throw new Error('must not register'); } }), fetchImpl: async () => { fetches += 1; throw new Error('must not fetch'); },
    } as PdfDownloadOptions), /invalid PDF paper metadata/);
    assert.equal(fetches, 0);
  } finally { await removeOwnedTestDirectory(f.root); }
});

test('Bun fetch downloads and validates a PDF on every platform', async () => {
  const f = await fixture();
  const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  let registered: unknown[] | undefined;
  try {
    const result = await downloadAcceptedPdf({ accepted: true, paper: { baseId: 'synthetic', arxivId: 'syntheticv1', version: 1, title: 'Synthetic', pdfUrl: 'https://example.test/synthetic.pdf' } }, {
      ...f, fetchImpl: async (_url, init) => { assert.ok(init?.headers?.['User-Agent']); assert.equal(Object.hasOwn(init ?? {}, 'proxy'), false); return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => bytes }; },
      stateStore: stateStore({ markDownloaded: (...args: unknown[]) => { registered = args; } }),
      categories: { '99-Unclassified': { pdf: '99-Unclassified' } },
    });
    assert.equal(result.pageCount, 1);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.ok(registered);
    assert.deepEqual(await readFile(result.pdfPath), bytes);
  } finally { await removeOwnedTestDirectory(f.root); }
});

test('accepts a valid arXiv PDF over the local-import page limit', async () => {
  const f = await fixture();
  const pdf = await PDFDocument.create();
  for (let page = 0; page < 201; page += 1) pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  try {
    const result = await downloadAcceptedPdf({ accepted: true, paper: {
      baseId: 'long-paper', arxivId: 'long-paperv1', version: 1,
      title: 'Long paper', pdfUrl: 'https://arxiv.org/pdf/long-paperv1',
    } }, {
      ...f,
      maxAttempts: 1,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/pdf' },
        arrayBuffer: async () => bytes,
      }),
      stateStore: stateStore(),
    });
    assert.equal(result.pageCount, 201);
  } finally { await removeOwnedTestDirectory(f.root); }
});

test('abort signal reaches the Bun fetch boundary without creating partial files', async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const pending = downloadAcceptedPdf({ accepted: true, paper: { baseId: 'cancelled', arxivId: 'cancelledv1', version: 1, pdfUrl: 'https://example.test/cancelled.pdf' } }, {
      ...f, signal: controller.signal, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
        if (init?.signal?.aborted) { fail(); return; }
        init?.signal?.addEventListener('abort', fail, { once: true });
      }), stateStore: stateStore(),
    });
    controller.abort();
    await assert.rejects(pending, /aborted|ABORT_ERR/);
    assert.deepEqual(await readdir(f.tempRoot).catch(() => []), []);
  } finally { await removeOwnedTestDirectory(f.root); }
});

test('retries transient network failures before accepting a PDF response', async () => {
  const f = await fixture();
  let attempts = 0;
  try {
    await assert.rejects(downloadAcceptedPdf({ accepted: true, paper: { baseId: 'retry', arxivId: 'retryv1', version: 1, title: 'Retry', pdfUrl: 'https://example.test/retry.pdf' } }, {
      ...f, fetchImpl: async () => { attempts += 1; throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }, sleep: async () => {}, maxAttempts: 3, stateStore: stateStore(),
    }), /ECONNRESET|reset/);
    assert.equal(attempts, 3);
  } finally { await removeOwnedTestDirectory(f.root); }
});

test('classifies an arXiv file-unavailable 500 as a deferred PDF without mutating state', async () => {
  const f = await fixture();
  let registered = false;
  try {
    await assert.rejects(
      () => downloadAcceptedPdf({ accepted: true, paper: {
        baseId: 'not-ready', arxivId: 'not-readyv3', version: 3,
        pdfUrl: 'https://arxiv.org/pdf/not-readyv3',
      } }, {
        ...f,
        maxAttempts: 1,
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          headers: { get: () => 'text/html; charset=utf-8' },
          arrayBuffer: async () => Buffer.from('<html><body><h1>file unavailable</h1></body></html>'),
        }),
        stateStore: stateStore({ markDownloaded() { registered = true; } }),
      }),
      error => {
        assert.equal((error as { code?: string }).code, 'PDF_NOT_READY');
        assert.equal((error as { status?: number }).status, 500);
        assert.equal((error as { baseId?: string }).baseId, 'not-ready');
        assert.equal((error as { permanent?: boolean }).permanent, false);
        assert.match((error as Error).message, /file unavailable/i);
        return true;
      },
    );
    assert.equal(registered, false);
  } finally { await removeOwnedTestDirectory(f.root); }
});

test('keeps a generic HTTP 500 fatal after the final retry', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => downloadAcceptedPdf({ accepted: true, paper: {
        baseId: 'server-error', arxivId: 'server-errorv1', version: 1,
        pdfUrl: 'https://arxiv.org/pdf/server-errorv1',
      } }, {
        ...f,
        maxAttempts: 1,
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          headers: { get: () => 'text/html; charset=utf-8' },
          arrayBuffer: async () => Buffer.from('<html><body><h1>internal server error</h1></body></html>'),
        }),
        stateStore: stateStore(),
      }),
      error => {
        assert.equal((error as { code?: string }).code, undefined);
        assert.equal((error as { status?: number }).status, undefined);
        assert.match((error as Error).message, /PDF download HTTP 500/);
        return true;
      },
    );
  } finally { await removeOwnedTestDirectory(f.root); }
});

test('classifies an arXiv 404 as a permanent unavailable PDF', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => downloadAcceptedPdf({ accepted: true, paper: {
        baseId: 'withdrawn', arxivId: 'withdrawnv2', version: 2,
        pdfUrl: 'https://arxiv.org/pdf/withdrawnv2',
      } }, {
        ...f,
        fetchImpl: async () => ({
          ok: false, status: 404,
          headers: { get: () => 'text/html' },
          arrayBuffer: async () => new Uint8Array(),
        }),
        stateStore: stateStore(),
      }),
      error => {
        assert.equal((error as { code?: string }).code, 'PDF_NOT_FOUND');
        assert.equal((error as { status?: number }).status, 404);
        assert.equal((error as { baseId?: string }).baseId, 'withdrawn');
        assert.equal((error as { permanent?: boolean }).permanent, true);
        return true;
      },
    );
  } finally { await removeOwnedTestDirectory(f.root); }
});
