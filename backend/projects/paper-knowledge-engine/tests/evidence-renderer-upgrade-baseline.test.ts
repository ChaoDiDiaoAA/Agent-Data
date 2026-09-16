import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVerifiedRunSources } from '../src/evidence/archive-reader.ts';
import { prepareEvidenceSources } from '../src/evidence/layout-v3.ts';
import { publishRunEvidence, verifyEvidencePublicationHistory } from '../src/evidence/publication-service.ts';
import { planEvidencePublication } from '../src/evidence/publisher.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { createVaultRebuildPlan, applyVaultRebuild } from '../src/maintenance/vault-rebuild.ts';
import { routeEvidenceRendererBaseline } from '../src/cli/routes.ts';
import { canonicalJson, hashCanonical } from '../src/shared/manifest.ts';
import { archiveContext } from './fixtures/library-paths.ts';
import { validRunSourceFixture } from './fixtures/publication-baseline.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const lastSuccess = '2026-09-04T00:00:00.000Z';

async function api() {
  const module = await import('../src/maintenance/publication-baseline.ts');
  expect(module.createRendererUpgradeBaseline).toBeFunction();
  expect(module.applyRendererUpgradeBaseline).toBeFunction();
  return module;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'renderer-upgrade-baseline-'));
  const { libraryPaths: paths, libraryId } = archiveContext(join(root, 'state'));
  await mkdir(paths.dataRoot, { recursive: true });
  const store = openStateStore(paths.databasePath);
  const cumulative = [] as Awaited<ReturnType<typeof prepareEvidenceSources>>;
  const originalReceipts: { path: string; bytes: Buffer; sha256: string }[] = [];
  try {
    for (const index of [1, 2] as const) {
      const run = store.startRun({
        from: `2026-09-0${index}T00:00:00.000Z`,
        to: `2026-09-0${index + 1}T00:00:00.000Z`,
      }, 'current', { autoResume: false });
      await validRunSourceFixture({
        runId: run.id,
        stateRoot: paths.dataRoot,
        store,
        baseId: `2609.2000${index}`,
      });
      cumulative.push(...await prepareEvidenceSources(await readVerifiedRunSources({
        runId: run.id,
        stateRoot: paths.dataRoot,
        paths,
        libraryId,
        store,
      })));
      const current = planEvidencePublication({ runId: run.id, sources: cumulative });
      const sources = current.sources.map((source, sourceIndex) => ({
        ...source,
        evidenceManifestSha256: hash(`pre-upgrade-renderer-${index}-${sourceIndex}`),
      }));
      const contentSha256 = hash(`pre-upgrade-content-${index}`);
      const publicationId = `evidence-${hashCanonical({
        runId: run.id,
        contentSha256,
        publisherVersion: 3,
      }).slice(0, 32)}`;
      const receiptPath = join(paths.runsRoot, run.id, 'evidence', 'publication.json');
      const bytes = Buffer.from(canonicalJson({
        schemaVersion: 1,
        publisherVersion: 3,
        runId: run.id,
        publicationId,
        contentSha256,
        publishedAt: `2026-09-0${index + 1}T00:00:00.000Z`,
        sources,
      }));
      store.reserveEvidencePublication({ runId: run.id, publicationId, inputSha256: contentSha256 });
      await mkdir(join(paths.runsRoot, run.id, 'evidence'), { recursive: true });
      await writeFile(receiptPath, bytes);
      store.completeEvidencePublication({
        runId: run.id,
        publicationId,
        receiptPath,
        receiptSha256: hash(bytes),
        lastSuccess: `2026-09-0${index + 1}T00:00:00.000Z`,
      });
      originalReceipts.push({ path: receiptPath, bytes, sha256: hash(bytes) });
    }

    const nextRun = store.startRun({
      from: '2026-09-03T00:00:00.000Z',
      to: lastSuccess,
    }, 'current', { autoResume: false });
    await validRunSourceFixture({
      runId: nextRun.id,
      stateRoot: paths.dataRoot,
      store,
      baseId: '2609.20003',
    });

    const previousVaultRoot = join(root, 'previous-vault');
    await mkdir(join(previousVaultRoot, '.obsidian'), { recursive: true });
    await writeFile(join(previousVaultRoot, '.obsidian', 'app.json'), '{"preserved":true}');
    const vaultRoot = join(root, 'rebuilt-vault');
    const { dataRoot, workRoot, runsRoot, operationsRoot, backupRoot } = paths;
    const vaultInput = {
      libraryId,
      archiveRoot: paths.archiveRoot,
      legacyVaultRoot: previousVaultRoot,
      vaultRoot,
      runtimeRoots: { dataRoot, workRoot, runsRoot, operationsRoot, backupRoot },
    };
    const vaultPlan = await createVaultRebuildPlan(vaultInput);
    const vaultPlanFile = join(root, 'vault-plan.json');
    await writeFile(vaultPlanFile, canonicalJson(vaultPlan));
    await applyVaultRebuild({ ...vaultInput, planFile: vaultPlanFile, planSha256: vaultPlan.sha256 });

    const baselineInput = {
      libraryId,
      stateRoot: paths.dataRoot,
      vaultRoot,
      store,
      vaultPlan: { path: vaultPlanFile, sha256: vaultPlan.sha256 },
    };
    const next = {
      runId: nextRun.id,
      stateRoot: paths.dataRoot,
      tempRoot: paths.workRoot,
      vaultRoot,
      store,
      lastSuccess,
    };
    return {
      root,
      paths,
      store,
      baselineInput,
      next,
      originalReceipts,
      close: async () => {
        store.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    store.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function crossRunBackfillFixture() {
  const f = await fixture();
  try {
    const [early, later] = f.store.listCompletedEvidencePublications();
    if (!early || !later) throw new Error('fixture history is incomplete');
    const laterSource = later.sources.find(source => !early.sources.some(
      existing => existing.baseId === source.baseId && existing.version === source.version,
    ));
    if (!laterSource) throw new Error('fixture later publication has no source');
    const receipt = JSON.parse(await readFile(early.receiptPath, 'utf8')) as { sources: typeof early.sources };
    receipt.sources = [...receipt.sources, laterSource];
    const bytes = Buffer.from(canonicalJson(receipt));
    await writeFile(early.receiptPath, bytes);
    const db = new Database(f.paths.databasePath);
    try {
      db.query('UPDATE evidence_publications SET receipt_sha256=? WHERE run_id=?').run(hash(bytes), early.runId);
      db.query(`INSERT INTO evidence_publication_sources(
        run_id,base_id,version,archive_manifest_sha256,evidence_manifest_sha256,recorded_at
      ) VALUES(?,?,?,?,?,?)`).run(
        early.runId,
        laterSource.baseId,
        laterSource.version,
        laterSource.archiveManifestSha256,
        laterSource.evidenceManifestSha256,
        '2026-09-02T00:00:00.000Z',
      );
    } finally {
      db.close();
    }
    return f;
  } catch (error) {
    await f.close();
    throw error;
  }
}

test('reviewed renderer baseline authenticates drift and permits cumulative publication without rewriting old receipts', async () => {
  const f = await fixture();
  try {
    await expect(publishRunEvidence(f.next)).rejects.toThrow(
      /completed publication Evidence manifest identity differs.*renderer-baseline/s,
    );
    expect(f.store.findEvidencePublication(f.next.runId)).toBeUndefined();

    const { createRendererUpgradeBaseline, applyRendererUpgradeBaseline } = await api();
    const before = f.store.listCompletedEvidencePublications();
    const baseline = await createRendererUpgradeBaseline(f.baselineInput);
    expect(baseline.kind).toBe('evidence-v3-renderer-upgrade-baseline');
    expect(baseline.publications).toHaveLength(2);
    expect(await createRendererUpgradeBaseline(f.baselineInput)).toEqual(baseline);
    expect(await applyRendererUpgradeBaseline({
      ...f.baselineInput,
      baseline,
      baselineSha256: baseline.sha256,
    })).toEqual({ replayed: false, sha256: baseline.sha256 });
    expect(await applyRendererUpgradeBaseline({
      ...f.baselineInput,
      baseline,
      baselineSha256: baseline.sha256,
    })).toEqual({ replayed: true, sha256: baseline.sha256 });

    const published = await publishRunEvidence(f.next);
    expect(published.sourceCount).toBe(3);
    expect((await publishRunEvidence(f.next)).applyReplayed).toBe(true);
    expect(f.store.listCompletedEvidencePublications().filter(row => before.some(old => old.runId === row.runId))).toEqual(before);
    for (const receipt of f.originalReceipts) {
      expect((await readFile(receipt.path)).equals(receipt.bytes)).toBe(true);
      expect(hash(await readFile(receipt.path))).toBe(receipt.sha256);
    }
  } finally {
    await f.close();
  }
});

test('CLI renderer baseline route is explicit, hash-bound, and reuses the reviewed baseline implementation', async () => {
  const f = await fixture();
  try {
    const dryRun = await routeEvidenceRendererBaseline(['--dry-run', '--format', 'json'], { input: f.baselineInput });
    if (!('kind' in dryRun) || dryRun.kind !== 'evidence-v3-renderer-upgrade-baseline') throw new Error('renderer baseline dry-run returned apply output');
    const baselineFile = join(f.root, 'renderer-baseline.json');
    await writeFile(baselineFile, canonicalJson(dryRun));
    await expect(routeEvidenceRendererBaseline(['--apply'], { input: f.baselineInput })).rejects.toThrow('EVIDENCE_BASELINE_ARGUMENTS');
    await expect(routeEvidenceRendererBaseline([
      '--apply', '--baseline-file', baselineFile, '--baseline-sha256', dryRun.sha256,
    ], { input: f.baselineInput })).resolves.toEqual({ mode: 'apply', replayed: false, sha256: dryRun.sha256 });
  } finally {
    await f.close();
  }
});

test('publication history preflight fails before a new task can spend time on discovery or parsing', async () => {
  const f = await fixture();
  try {
    await expect(verifyEvidencePublicationHistory({
      stateRoot: f.next.stateRoot,
      libraryId: f.baselineInput.libraryId,
      store: f.store,
    })).rejects.toThrow(/evidence-renderer-baseline/);
  } finally {
    await f.close();
  }
});

test('rejects cross-run Archive backfill before baseline insertion, reservation, or Vault writes', async () => {
  const f = await crossRunBackfillFixture();
  try {
    const { createRendererUpgradeBaseline } = await api();
    await expect(createRendererUpgradeBaseline(f.baselineInput)).rejects.toThrow('renderer baseline run Archive source membership differs');
    expect(f.store.getPublicationBaseline()).toBeNull();

    const historyBefore = f.store.listCompletedEvidencePublications();
    const existingVaultPaper = join(f.baselineInput.vaultRoot, 'Evidence', 'papers', '2609.20001-v1', 'paper.md');
    const existingVaultBytes = await readFile(existingVaultPaper);
    const nextVaultPaper = join(f.baselineInput.vaultRoot, 'Evidence', 'papers', '2609.20003-v1', 'paper.md');
    const nextVaultBytes = await readFile(nextVaultPaper);
    await expect(publishRunEvidence(f.next)).rejects.toThrow('completed run Archive source membership differs');
    expect(f.store.findEvidencePublication(f.next.runId)).toBeUndefined();
    expect(f.store.listCompletedEvidencePublications()).toEqual(historyBefore);
    expect((await readFile(existingVaultPaper)).equals(existingVaultBytes)).toBe(true);
    expect((await readFile(nextVaultPaper)).equals(nextVaultBytes)).toBe(true);
  } finally {
    await f.close();
  }
});

for (const drift of ['baseline', 'history', 'receipt', 'archive', 'vault'] as const) {
  test(`renderer baseline apply rejects ${drift} drift before installing the anchor`, async () => {
    const f = await fixture();
    try {
      const { createRendererUpgradeBaseline, applyRendererUpgradeBaseline } = await api();
      const baseline = structuredClone(await createRendererUpgradeBaseline(f.baselineInput));
      if (drift === 'baseline') baseline.publications[0] = {
        ...baseline.publications[0]!,
        projection: { ...baseline.publications[0]!.projection, contentSha256: hash('forged projection') },
      };
      if (drift === 'history') {
        const row = f.store.listCompletedEvidencePublications()[0]!;
        const db = new Database(f.paths.databasePath);
        try { db.query('UPDATE evidence_publications SET input_sha256=? WHERE run_id=?').run(hash('changed history'), row.runId); }
        finally { db.close(); }
      }
      if (drift === 'receipt') await writeFile(f.originalReceipts[0]!.path, '{}');
      if (drift === 'archive') await writeFile(join(f.paths.archiveRoot, '2609.20001-v1', 'document.md'), 'changed');
      if (drift === 'vault') await writeFile(join(f.baselineInput.vaultRoot, 'Evidence', 'papers', '2609.20001-v1', 'paper.md'), 'changed');
      await expect(applyRendererUpgradeBaseline({
        ...f.baselineInput,
        baseline,
        baselineSha256: baseline.sha256,
      })).rejects.toThrow();
      expect(f.store.getPublicationBaseline()).toBeNull();
    } finally {
      await f.close();
    }
  });
}

for (const drift of ['baseline', 'receipt', 'archive'] as const) {
  test(`installed renderer baseline rejects ${drift} tampering during normal publication`, async () => {
    const f = await fixture();
    try {
      const { createRendererUpgradeBaseline, applyRendererUpgradeBaseline } = await api();
      const baseline = await createRendererUpgradeBaseline(f.baselineInput);
      await applyRendererUpgradeBaseline({ ...f.baselineInput, baseline, baselineSha256: baseline.sha256 });
      if (drift === 'baseline') {
        const db = new Database(f.paths.databasePath);
        try { db.exec("UPDATE evidence_publication_baseline SET canonical_json='{}'"); }
        finally { db.close(); }
      }
      if (drift === 'receipt') await writeFile(f.originalReceipts[0]!.path, '{}');
      if (drift === 'archive') await writeFile(join(f.paths.archiveRoot, '2609.20001-v1', 'document.md'), 'changed');
      await expect(publishRunEvidence(f.next)).rejects.toThrow();
      expect(f.store.findEvidencePublication(f.next.runId)).toBeUndefined();
    } finally {
      await f.close();
    }
  });
}

test('installed renderer baseline rejects coordinated receipt and publication-row tampering', async () => {
  const f = await fixture();
  try {
    const { createRendererUpgradeBaseline, applyRendererUpgradeBaseline } = await api();
    const baseline = await createRendererUpgradeBaseline(f.baselineInput);
    await applyRendererUpgradeBaseline({ ...f.baselineInput, baseline, baselineSha256: baseline.sha256 });
    const original = f.store.listCompletedEvidencePublications()[0]!;
    const receipt = JSON.parse(await readFile(original.receiptPath, 'utf8'));
    receipt.contentSha256 = hash('coordinated content');
    receipt.publicationId = `evidence-${hashCanonical({
      runId: receipt.runId,
      contentSha256: receipt.contentSha256,
      publisherVersion: 3,
    }).slice(0, 32)}`;
    receipt.sources[0].archiveManifestSha256 = hash('coordinated Archive identity');
    const bytes = Buffer.from(canonicalJson(receipt));
    await writeFile(original.receiptPath, bytes);
    const db = new Database(f.paths.databasePath);
    try {
      db.query('UPDATE evidence_publications SET input_sha256=?,publication_id=?,receipt_sha256=? WHERE run_id=?')
        .run(receipt.contentSha256, receipt.publicationId, hash(bytes), original.runId);
      db.query('UPDATE evidence_publication_sources SET archive_manifest_sha256=? WHERE run_id=? AND base_id=? AND version=?')
        .run(receipt.sources[0].archiveManifestSha256, original.runId, receipt.sources[0].baseId, receipt.sources[0].version);
    } finally {
      db.close();
    }
    await expect(publishRunEvidence(f.next)).rejects.toThrow('publication baseline authentication failed');
    expect(f.store.findEvidencePublication(f.next.runId)).toBeUndefined();
  } finally {
    await f.close();
  }
});
