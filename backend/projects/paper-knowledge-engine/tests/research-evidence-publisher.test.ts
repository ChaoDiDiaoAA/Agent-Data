import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStateStore } from '../src/library/state/state-store.ts';
import { publishResearchEvidence } from '../src/evidence/source-publisher.ts';
import { installResearchEvidenceTargets } from '../src/evidence/research-publication-transaction.ts';
import { readVerifiedResearchArchive, writeResearchArchive } from '../src/research/source-archive.ts';
import { researchFixture } from './fixtures/research-source.ts';
import { sha256 } from '../src/research/source-identity.ts';

const roots: string[] = [];
afterEach(async () => { delete process.env.RESEARCH_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'research-evidence-publisher-')); roots.push(root);
  const store = openStateStore(join(root, 'state.sqlite'));
  const fetched = researchFixture();
  const written = await writeResearchArchive({ root: join(root, 'data'), libraryId: 'research-fixture', fetched });
  const archive = await readVerifiedResearchArchive(written.archivePath);
  const run = store.startResearchRun({ from: '2026-09-01', to: '2026-09-07' }, 'current');
  store.upsertResearchSource(archive.manifest.source);
  store.upsertResearchSourceVersion(archive.manifest.version, null);
  const shard = { runId: run.id, shardKey: 'source', shardIndex: 1, track: archive.manifest.source.primaryTrack, sourceKind: archive.manifest.source.kind };
  store.beginResearchShard(shard);
  store.recordResearchObservation({ ...shard, sourceId: archive.manifest.sourceId, versionId: archive.manifest.versionId,
    metadata: { matchedTracks: [archive.manifest.source.primaryTrack] }, decisionStatus: 'accepted', decisionReason: 'selected', observedAt: archive.manifest.version.retrievedAt });
  store.completeResearchShard({ ...shard, candidateCount: 1, acceptedCount: 1, newVersionCount: 1, archivedCount: 1 });
  return { root, store, archive, run };
}

test('publisher installs only generic research Evidence and completes/replays one publication', async () => {
  const f = await fixture();
  try {
    const input = { runId: f.run.id, stateRoot: f.root, vaultRoot: join(f.root, 'vault'), tempRoot: join(f.root, 'temp'), store: f.store, selectionHash: 'a'.repeat(64), archives: [f.archive] };
    const first = await publishResearchEvidence(input);
    expect(first).toMatchObject({ status: 'completed', sourceCount: 1, replayed: false });
    expect((await stat(join(f.root, 'vault', 'Evidence', 'sources', 'official-doc', f.archive.manifest.sourceId, 'r1', 'index.md'))).isFile()).toBe(true);
    await expect(stat(join(f.root, 'vault', 'Evidence', 'papers'))).rejects.toThrow();
    await expect(stat(join(f.root, 'vault', 'Knowledge'))).rejects.toThrow();
    const receiptBefore = await readFile(first.receiptPath);
    const replay = await publishResearchEvidence(input);
    expect(replay).toMatchObject({ status: 'completed', replayed: true, receiptPath: first.receiptPath });
    expect(await readFile(first.receiptPath)).toEqual(receiptBefore);
  } finally { f.store.close(); }
});

test('publisher rejects selection conflicts, target tamper and archive identity drift', async () => {
  const f = await fixture();
  try {
    const input = { runId: f.run.id, stateRoot: f.root, vaultRoot: join(f.root, 'vault'), tempRoot: join(f.root, 'temp'), store: f.store, selectionHash: 'b'.repeat(64), archives: [f.archive] };
    await publishResearchEvidence(input);
    await expect(publishResearchEvidence({ ...input, selectionHash: 'c'.repeat(64) })).rejects.toThrow(/conflict|identity/i);
    await writeFile(join(f.root, 'vault', 'Evidence', 'sources', 'official-doc', f.archive.manifest.sourceId, 'r1', 'index.md'), 'tampered');
    await expect(publishResearchEvidence(input)).rejects.toThrow(/conflict|tamper|differs/i);
  } finally { f.store.close(); }
});

test('publisher rolls back a journaled interruption before retrying', async () => {
  const f = await fixture();
  try {
    const input = { runId: f.run.id, stateRoot: f.root, vaultRoot: join(f.root, 'vault'), tempRoot: join(f.root, 'temp'), store: f.store, selectionHash: 'd'.repeat(64), archives: [f.archive] };
    process.env.RESEARCH_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL = '1';
    await expect(publishResearchEvidence(input)).rejects.toThrow(/EVIDENCE_INTERRUPTED/);
    delete process.env.RESEARCH_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL;
    const recovered = await publishResearchEvidence(input);
    expect(recovered.status).toBe('completed');
    await expect(stat(join(f.root, 'runs', f.run.id, 'evidence', 'source-publication-journal.json'))).rejects.toThrow();
    await expect(stat(join(f.root, 'runs', f.run.id, 'evidence', 'backups'))).resolves.toBeTruthy();
  } finally { f.store.close(); }
});

test('publisher transaction rejects a target path escape before writing', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'vault'), { recursive: true });
    await mkdir(join(f.root, 'temp'), { recursive: true });
    await expect(installResearchEvidenceTargets({
      stateRoot: f.root,
      tempRoot: join(f.root, 'temp'),
      vaultRoot: join(f.root, 'vault'),
      binding: { publisherVersion: 1, runId: f.run.id, publicationId: 'escape-test', contentSha256: 'e'.repeat(64) },
      targets: [{ relativePath: 'Evidence/../Knowledge/escape.md', bytes: Buffer.from('escape'), sha256: sha256(Buffer.from('escape')) }],
    })).rejects.toThrow(/path|Evidence/i);
  } finally { f.store.close(); }
});
