import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOrReplaySourceReceipt, recoverSourcePublicationReceiptTemporary, parseSourcePublicationReceipt } from '../src/evidence/source-receipt-store.ts';
import { canonicalJson } from '../src/shared/manifest.ts';
import { sha256 } from '../src/research/source-identity.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); delete process.env.RESEARCH_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL; });

const receipt = { schemaVersion: 1 as const, publisherVersion: 1 as const, runId: 'run-1', publicationId: 'pub-1', contentSha256: 'a'.repeat(64), sources: [] };

test('source receipt is canonical, strict, replayable and recovers a validated temporary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-evidence-receipt-')); roots.push(root);
  const path = join(root, 'source-publication.json');
  const first = await createOrReplaySourceReceipt({ path, receipt, publishedAt: '2026-09-07T00:00:00.000Z' });
  expect(first.status).toBe('created');
  expect(parseSourcePublicationReceipt(await readFile(path, 'utf8'))).toEqual(first.receipt);
  expect(await createOrReplaySourceReceipt({ path, receipt, publishedAt: '2026-09-07T00:00:00.000Z' })).toMatchObject({ status: 'replayed' });
  await rm(path);
  await writeFile(`${path}.new`, canonicalJson(first.receipt));
  await recoverSourcePublicationReceiptTemporary({ path, receipt: first.receipt });
  expect(parseSourcePublicationReceipt(await readFile(path, 'utf8'))).toEqual(first.receipt);
  expect(sha256(await readFile(path))).toMatch(/^[0-9a-f]{64}$/);
  expect(() => parseSourcePublicationReceipt(canonicalJson({ ...first.receipt, extra: true }))).toThrow();
});

test('invalid receipt temporary bytes are rejected without replacing the receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-evidence-receipt-invalid-')); roots.push(root);
  const path = join(root, 'source-publication.json');
  await writeFile(`${path}.new`, '{"runId":"other"}\n');
  await expect(recoverSourcePublicationReceiptTemporary({ path, receipt })).rejects.toThrow();
});
