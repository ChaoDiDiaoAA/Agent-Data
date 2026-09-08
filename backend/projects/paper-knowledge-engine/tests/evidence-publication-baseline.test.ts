import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, hashCanonical } from '../src/shared/manifest.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { readVerifiedRunSources } from '../src/evidence/archive-reader.ts';
import { publishRunEvidence } from '../src/evidence/publication-service.ts';
import { createArchiveMigrationPlan, applyArchiveMigration } from '../src/maintenance/archive-migration.ts';
import { createLibraryStatePlan, applyLibraryStatePlan } from '../src/maintenance/library-state-migration.ts';
import { createVaultRebuildPlan, applyVaultRebuild } from '../src/maintenance/vault-rebuild.ts';
import { archiveContext } from './fixtures/library-paths.ts';
import { validRunSourceFixture } from './fixtures/publication-baseline.ts';

const hash = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex');
const window = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' };
async function snapshot(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  // SQLite readers update transient SHM read marks; DB and WAL bytes must not change.
  return Object.fromEntries(await Promise.all(entries.filter(e => e.isFile() && !e.name.endsWith('-shm')).map(async e => {
    const path = join(e.parentPath, e.name);
    return [path, hash(await readFile(path))];
  })));
}
async function api() {
  const path = '../src/maintenance/publication-baseline.ts';
  const mod = await import(path).catch(() => null);
  expect(mod?.createPublicationBaseline).toBeFunction();
  expect(mod?.applyPublicationBaseline).toBeFunction();
  return mod!;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'publication-baseline-'));
  const legacyStateRoot = join(root, 'old');
  await mkdir(legacyStateRoot);
  const oldStore = openStateStore(join(legacyStateRoot, 'papers.sqlite'));
  const rows: { baseId: string; version: number; archiveManifestSha256: string; evidenceManifestSha256: string }[] = [];
  try {
    for (const i of [1, 2] as const) {
      const run = oldStore.startRun({ from: `2026-09-0${i}T00:00:00.000Z`, to: `2026-09-0${i + 1}T00:00:00.000Z` }, 'current', { autoResume: false });
      await validRunSourceFixture({ runId: run.id, stateRoot: legacyStateRoot, store: oldStore, baseId: `2609.1000${i}`, legacy: true });
      const [source] = await readVerifiedRunSources({ runId: run.id, stateRoot: legacyStateRoot, store: oldStore });
      rows.push({ baseId: source!.source.baseId, version: 1, archiveManifestSha256: source!.archiveManifestSha256, evidenceManifestSha256: hash(`historical-evidence-${i}`) });
      const contentSha256 = hash(`historical-renderer-${i}`);
      const publicationId = `evidence-${(i === 1 ? contentSha256 : hashCanonical({ runId: run.id, contentSha256, publisherVersion: 2 })).slice(0, 32)}`;
      const receiptPath = join(legacyStateRoot, 'runs', run.id, 'evidence', 'publication.json');
      const bytes = canonicalJson({ schemaVersion: 1, publisherVersion: i, runId: run.id, publicationId, contentSha256, publishedAt: window.to, sources: [...rows] });
      oldStore.reserveEvidencePublication({ runId: run.id, publicationId, inputSha256: contentSha256 });
      await mkdir(join(legacyStateRoot, 'runs', run.id, 'evidence'));
      await writeFile(receiptPath, bytes);
      oldStore.completeEvidencePublication({ runId: run.id, publicationId, receiptPath, receiptSha256: hash(bytes), lastSuccess: window.to });
    }
  } finally { oldStore.close(); }
  const { libraryPaths: paths, libraryId } = archiveContext(join(root, 'new'));
  const archiveInput = { libraryId, paths, legacyArchiveRoot: join(legacyStateRoot, 'extracted') };
  const archive = await createArchiveMigrationPlan(archiveInput);
  const archivePlanFile = join(root, 'archive.json'); await writeFile(archivePlanFile, canonicalJson(archive));
  await applyArchiveMigration({ ...archiveInput, planFile: archivePlanFile, planSha256: archive.sha256 });
  const libraryInput = { libraryId, paths, legacyStateRoot, legacyPdfRoot: join(legacyStateRoot, 'pdf') };
  const library = await createLibraryStatePlan(libraryInput);
  const libraryPlanFile = join(root, 'library.json'); await writeFile(libraryPlanFile, canonicalJson(library));
  await applyLibraryStatePlan({ ...libraryInput, planFile: libraryPlanFile, planSha256: library.sha256 });
  const legacyVaultRoot = join(root, 'old-vault'); await mkdir(join(legacyVaultRoot, '.obsidian'), { recursive: true });
  await writeFile(join(legacyVaultRoot, '.obsidian', 'app.json'), '{}');
  const { dataRoot, workRoot, runsRoot, operationsRoot, backupRoot } = paths;
  const vaultInput = { libraryId, archiveRoot: paths.archiveRoot, legacyVaultRoot, vaultRoot: join(root, 'vault'), runtimeRoots: { dataRoot, workRoot, runsRoot, operationsRoot, backupRoot } };
  const vault = await createVaultRebuildPlan(vaultInput);
  const vaultPlanFile = join(root, 'vault.json'); await writeFile(vaultPlanFile, canonicalJson(vault));
  await applyVaultRebuild({ ...vaultInput, planFile: vaultPlanFile, planSha256: vault.sha256 });
  const store = openStateStore(paths.databasePath);
  const input = { stateRoot: paths.dataRoot, vaultRoot: vaultInput.vaultRoot, store,
    archivePlan: { path: archivePlanFile, sha256: archive.sha256 },
    libraryPlan: { path: libraryPlanFile, sha256: library.sha256 },
    vaultPlan: { path: vaultPlanFile, sha256: vault.sha256 } };
  const next = async () => {
    const run = store.startRun({ from: '2026-09-03T00:00:00.000Z', to: '2026-09-04T00:00:00.000Z' }, 'current', { autoResume: false });
    await validRunSourceFixture({ runId: run.id, stateRoot: paths.dataRoot, store, baseId: '2609.10003' });
    return { runId: run.id, stateRoot: paths.dataRoot, tempRoot: paths.workRoot, vaultRoot: input.vaultRoot, store, lastSuccess: window.to };
  };
  return { root, legacyStateRoot, paths, store, input, next, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('reviewed legacy baseline extends migrated cumulative publication and replays without old roots', async () => {
  const f = await fixture();
  try {
    const { createPublicationBaseline, applyPublicationBaseline } = await api();
    const before = f.store.listCompletedEvidencePublications();
    // The next Archive may already exist and personal settings may evolve.
    const next = await f.next();
    await writeFile(join(f.input.vaultRoot, '.obsidian', 'app.json'), '{"updated":true}');
    const baseline = await createPublicationBaseline(f.input);
    expect(await createPublicationBaseline(f.input)).toEqual(baseline);
    expect(f.store.listCompletedEvidencePublications()).toEqual(before);
    expect(await applyPublicationBaseline({ ...f.input, baseline, baselineSha256: baseline.sha256 })).toEqual({ replayed: false, sha256: baseline.sha256 });
    expect(await applyPublicationBaseline({ ...f.input, baseline, baselineSha256: baseline.sha256 })).toEqual({ replayed: true, sha256: baseline.sha256 });
    await rename(f.legacyStateRoot, join(f.root, 'retired'));
    const result = await publishRunEvidence(next);
    expect(result.sourceCount).toBe(3);
    expect((await readFile(join(f.input.vaultRoot, 'Evidence', 'papers', '2609.10001-v1', 'paper.md'), 'utf8'))).toContain('Reservation ordering fixture');
    expect((await publishRunEvidence(next)).applyReplayed).toBe(true);
    expect(f.store.listCompletedEvidencePublications().filter(x => before.some(b => b.runId === x.runId))).toEqual(before);
    for (const p of before) expect(hash(await readFile(p.receiptPath))).toBe(p.receiptSha256);
  } finally { await f.close(); }
});

test('legacy history cannot publish without an explicit baseline', async () => {
  const f = await fixture();
  try {
    const next = await f.next();
    await expect(publishRunEvidence(next)).rejects.toThrow('completed run Archive is not represented');
    expect(f.store.findEvidencePublication(next.runId)).toBeUndefined();
  } finally { await f.close(); }
});

for (const drift of ['baseline', 'plan', 'receipt', 'archive', 'run', 'provenance', 'vault'] as const) {
  test(`offline baseline apply rejects ${drift} drift without installing an anchor`, async () => {
    const f = await fixture();
    try {
      const { createPublicationBaseline, applyPublicationBaseline } = await api();
      const baseline = structuredClone(await createPublicationBaseline(f.input));
      expect(f.store.getPublicationBaseline()).toBeNull();
      if (drift === 'baseline') baseline.publications[0].projection.contentSha256 = hash('forged');
      if (drift === 'plan') await writeFile(f.input.archivePlan.path, '{}');
      if (drift === 'receipt') await writeFile(f.store.listCompletedEvidencePublications()[0]!.receiptPath, '{}');
      if (drift === 'archive') await writeFile(join(f.paths.archiveRoot, '2609.10001-v1', 'document.md'), 'changed');
      if (drift === 'run') await writeFile(join(f.paths.runsRoot, f.store.listCompletedEvidencePublications()[0]!.runId, 'mineru-jobs.json'), '{}');
      if (drift === 'provenance') {
        const db = new Database(f.paths.databasePath);
        try { db.exec('UPDATE library_layout_migrations SET rewritten_cells=0'); } finally { db.close(); }
      }
      if (drift === 'vault') await writeFile(join(f.input.vaultRoot, 'Evidence', 'papers', '2609.10001-v1', 'paper.md'), 'changed');
      await expect(applyPublicationBaseline({ ...f.input, baseline, baselineSha256: baseline.sha256 })).rejects.toThrow();
      expect(f.store.getPublicationBaseline()).toBeNull();
    } finally { await f.close(); }
  });
}

for (const drift of ['baseline', 'receipt', 'archive', 'coherent-archive', 'v3-receipt'] as const) {
  test(`normal publishing rejects ${drift} tampering after baseline installation`, async () => {
    const f = await fixture();
    try {
      const { createPublicationBaseline, applyPublicationBaseline } = await api();
      const baseline = await createPublicationBaseline(f.input);
      await applyPublicationBaseline({ ...f.input, baseline, baselineSha256: baseline.sha256 });
      const next = await f.next();
      if (drift === 'baseline') {
        const db = new Database(f.paths.databasePath);
        try { db.exec("UPDATE evidence_publication_baseline SET canonical_json='{}'"); } finally { db.close(); }
      }
      if (drift === 'receipt') await writeFile(f.store.listCompletedEvidencePublications()[0]!.receiptPath, '{}');
      const archive = join(f.paths.archiveRoot, '2609.10001-v1');
      if (drift === 'archive' || drift === 'coherent-archive') await writeFile(join(archive, 'document.md'), 'changed');
      if (drift === 'coherent-archive') {
        const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'));
        const file = manifest.files.find((x: { path: string }) => x.path === 'document.md');
        file.sha256 = hash('changed'); file.bytes = 7;
        await writeFile(join(archive, 'manifest.json'), canonicalJson(manifest));
      }
      if (drift === 'v3-receipt') {
        const result = await publishRunEvidence(next);
        const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
        receipt.contentSha256 = hash('forged-v3');
        receipt.publicationId = `evidence-${hashCanonical({ runId: next.runId, contentSha256: receipt.contentSha256, publisherVersion: 3 }).slice(0, 32)}`;
        const bytes = canonicalJson(receipt); await writeFile(result.receiptPath, bytes);
        const db = new Database(f.paths.databasePath);
        try { db.query('UPDATE evidence_publications SET input_sha256=?,publication_id=?,receipt_sha256=? WHERE run_id=?')
          .run(receipt.contentSha256, receipt.publicationId, hash(bytes), next.runId); } finally { db.close(); }
      }
      await expect(publishRunEvidence(next)).rejects.toThrow();
      if (drift !== 'v3-receipt') expect(f.store.findEvidencePublication(next.runId)).toBeUndefined();
    } finally { await f.close(); }
  });
}

test('SQLite anchor insertion refuses provenance changed since offline verification', async () => {
  const f = await fixture();
  try {
    const { createPublicationBaseline } = await api();
    const baseline = await createPublicationBaseline(f.input);
    const completedHistoryJson = JSON.stringify(f.store.listCompletedEvidencePublications());
    const db = new Database(f.paths.databasePath);
    try { db.exec('UPDATE library_layout_migrations SET rewritten_cells=0'); } finally { db.close(); }
    expect(() => f.store.installPublicationBaseline({ sha256: baseline.sha256, canonicalJson: canonicalJson(baseline), completedHistoryJson })).toThrow('provenance');
    expect(f.store.getPublicationBaseline()).toBeNull();
  } finally { await f.close(); }
});

test('both legacy completed runs replay read-only before and after V3 cumulative publication', async () => {
  const f = await fixture();
  try {
    const { createPublicationBaseline, applyPublicationBaseline } = await api();
    const baseline = await createPublicationBaseline(f.input);
    await applyPublicationBaseline({ ...f.input, baseline, baselineSha256: baseline.sha256 });
    const original = f.store.listCompletedEvidencePublications();
    const next = await f.next();
    await rename(f.legacyStateRoot, join(f.root, 'retired'));
    for (const phase of ['before-v3', 'after-v3']) {
      if (phase === 'after-v3') await publishRunEvidence(next);
      const before = await snapshot(f.root);
      for (const old of original) {
        const replay = await publishRunEvidence({ ...next, runId: old.runId });
        expect(replay).toEqual({ status: 'completed', publicationId: old.publicationId, contentSha256: old.inputSha256,
          receiptPath: old.receiptPath, receiptSha256: old.receiptSha256, sourceCount: old.sources.length,
          reservationReplayed: true, applyReplayed: true });
      }
      expect(await snapshot(f.root)).toEqual(before);
      // Even the first legacy run must accept the whole current cumulative set.
      const latest = phase === 'before-v3' ? '2609.10002-v1' : '2609.10003-v1';
      const page = join(f.input.vaultRoot, 'Evidence', 'papers', latest, 'paper.md');
      const bytes = await readFile(page);
      await writeFile(page, 'tampered');
      for (const old of original) await expect(publishRunEvidence({ ...next, runId: old.runId })).rejects.toThrow();
      await writeFile(page, bytes);
    }
    expect(f.store.listCompletedEvidencePublications().filter(x => original.some(p => p.runId === x.runId))).toEqual(original);
  } finally { await f.close(); }
});
