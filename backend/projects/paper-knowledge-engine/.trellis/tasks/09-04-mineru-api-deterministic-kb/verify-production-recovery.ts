import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const stateRoot = 'D:/agent-data/data/fsd-code2doc/state';
const vaultPaperRoot = 'D:/obsidian/data/fsd-code2doc/01-Evidence/sources/papers';
const runId = '739bac0f-7868-4915-968c-288a14e069f1';
const predecessorRunId = '0f6fdade-2026-4fe4-b9d2-7b03cad0c635';
const expectedPublicationId = 'evidence-092b5a1744fecc221081ae572cc73eea';
const expectedPredecessorReceiptSha256 = '5c135c4667b6e3278b9683fb134418376e1422f19304e44b58f9cf02f347005c';

const expectedPredecessorPaperHashes: Readonly<Record<string, string>> = {
  '2506.08311': 'de93fc4a37088aacb33aec4efcdb4a558d8f11fcaeebc74725e833d5267f3a60',
  '2606.02875': '0d98147c1f0d70da2b788337aeda5255344fb23aed22f07de708c21e9aacf360',
  '2606.30524': '8e76997882cdfb5677082a0dbdec58e485de1034fa7dcfed76b1177ca4a3bd56',
  '2607.24965': '49056aebc771964854cd6a6252deda12dbb8eba35797d87445d493b9f6fcd88b',
  '2608.09072': 'cf975b4fc5840e360f2560123b64ac1f50dcb6780f055617aca6fcaf7aafef40',
  '2608.10314': '6ead49cff77a6f8d1b74cd71f6c6025e8338f1fb9028f89c675d5eef578362fd',
  '2608.25573': '31bf208b41a6d42660daa9a05e19bbd27a31bef619931fc8987580538daa0fe3',
  '2608.30258': '44c75442091f215f8fff58a83f1cde5485a0366eb8dad1c2775e76d0b9b51853',
  '2608.30581': 'bc1685d4bccf16b8e62494e3a5d102635adf42a48272f018b6830acbe5950173',
  '2609.02011': 'a5a0bf6df1a9918c7d3656ec05eeaa1b3c23bbcc45f00b09d3176012c7460b9f',
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function isAbsent(path: string): Promise<boolean> {
  try { await stat(path); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`unexpected linked or special paper entry: ${path}`);
  }
  return files;
}

async function paperTreeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const path of (await filesBelow(root)).sort()) {
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const database = new Database(join(stateRoot, 'papers.sqlite'), { readonly: true });
try {
  const run = database.query('SELECT status FROM runs WHERE run_id=?1').get(runId) as { status?: string } | null;
  assert(run?.status === 'completed', 'recovered run is not completed');

  const publication = database.query('SELECT * FROM evidence_publications WHERE run_id=?1').get(runId) as Record<string, unknown> | null;
  assert(publication?.status === 'completed', 'publication is not completed');
  assert(publication.publication_id === expectedPublicationId, 'publication ID differs');
  const sourceCount = (database.query('SELECT count(*) AS count FROM evidence_publication_sources WHERE run_id=?1').get(runId) as { count: number }).count;
  assert(sourceCount === 20, 'publication source-row count differs');

  const receiptBytes = await readFile(String(publication.receipt_path));
  const receipt = JSON.parse(new TextDecoder().decode(receiptBytes)) as Record<string, unknown> & { sources: unknown[] };
  assert(sha256(receiptBytes) === publication.receipt_sha256, 'receipt bytes do not match SQLite hash');
  assert(receipt.publisherVersion === 2, 'receipt is not publisherVersion 2');
  assert(receipt.runId === runId && receipt.publicationId === expectedPublicationId, 'receipt identity differs');
  assert(receipt.contentSha256 === publication.input_sha256, 'receipt content hash differs from SQLite');
  assert(receipt.sources.length === 20, 'receipt source count differs');

  const predecessor = database.query('SELECT * FROM evidence_publications WHERE run_id=?1').get(predecessorRunId) as Record<string, unknown> | null;
  assert(predecessor?.status === 'completed', 'predecessor publication is not completed');
  const predecessorReceiptBytes = await readFile(String(predecessor.receipt_path));
  assert(sha256(predecessorReceiptBytes) === expectedPredecessorReceiptSha256, 'predecessor v1 receipt changed');
  assert(predecessor.receipt_sha256 === expectedPredecessorReceiptSha256, 'predecessor SQLite receipt hash changed');

  const evidenceRoot = join(stateRoot, 'runs', runId, 'evidence');
  assert(await isAbsent(join(evidenceRoot, 'publication-journal.json')), 'publication journal remains');
  assert(await isAbsent(join(evidenceRoot, 'publication-journal.json.new')), 'publication journal temporary remains');

  const paperDirectories = (await readdir(vaultPaperRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  assert(paperDirectories.length === 20, 'Vault managed paper count differs');
  for (const [baseId, expectedHash] of Object.entries(expectedPredecessorPaperHashes)) {
    assert(await paperTreeHash(join(vaultPaperRoot, baseId)) === expectedHash, `predecessor paper bytes changed: ${baseId}`);
  }

  console.log(JSON.stringify({
    verified: true,
    runId,
    publicationId: expectedPublicationId,
    publisherVersion: 2,
    sourceCount,
    vaultPaperCount: paperDirectories.length,
    oldPapersByteIdentical: Object.keys(expectedPredecessorPaperHashes).length,
    receiptSha256: publication.receipt_sha256,
    journalClean: true,
  }, null, 2));
} finally {
  database.close();
}
