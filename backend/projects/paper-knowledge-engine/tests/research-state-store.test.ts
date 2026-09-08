import { test, expect } from 'bun:test';
import { openStateStore } from '../src/library/state/state-store.ts';
import { createStateDatabase } from '../src/runtime/sqlite.ts';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { researchFixture } from './fixtures/research-source.ts';
import { canonicalJson } from '../src/shared/manifest.ts';
import { sha256 } from '../src/research/source-identity.ts';
import { writeFile } from 'node:fs/promises';

const window = { from: '2026-09-01', to: '2026-09-06' };
const counts = { candidateCount: 2, acceptedCount: 1, newVersionCount: 1, archivedCount: 1 };

test('source versions retain immutable content and permit only one archive-path attachment', () => {
  const store = openStateStore(':memory:');
  const first = researchFixture(), next = researchFixture('r2', 'Changed\n');
  try {
    store.upsertResearchSource(first.source);
    expect(store.upsertResearchSourceVersion(first.version, { z: 1, a: 2 })).toBe('inserted');
    expect(store.upsertResearchSourceVersion(first.version, { a: 2, z: 1 })).toBe('replayed');
    expect(store.upsertResearchSourceVersion(next.version, null)).toBe('inserted');
    expect(store.listResearchSourceVersions(first.source.sourceId).map(v => v.versionId)).toEqual(['r1', 'r2']);
    expect(() => store.upsertResearchSourceVersion(researchFixture('r1', 'Conflict\n').version, null)).toThrow(/conflict/i);
    expect(() => store.upsertResearchSourceVersion(first.version, { different: true })).toThrow(/conflict/i);
    const archived = { ...first.version, archivePath: `archive/sources/official-doc/${first.source.sourceId}/r1` };
    expect(store.upsertResearchSourceVersion(archived, { a: 2, z: 1 })).toBe('updated');
    expect(store.upsertResearchSourceVersion(first.version, { a: 2, z: 1 })).toBe('replayed');
    expect(store.findResearchSourceVersion(first.source.sourceId, 'r1')?.archivePath).toBe(archived.archivePath);
    expect(store.findResearchSourceVersion(first.source.sourceId, 'r1')?.contentSha256).toBe(first.version.contentSha256);
    expect(() => store.upsertResearchSourceVersion({ ...archived, archivePath: 'archive/elsewhere' }, null)).toThrow();
    expect(() => store.upsertResearchSource({ ...first.source, canonicalUrl: 'https://openai.com/other' })).toThrow();
    expect(store.findResearchSource(first.source.sourceId)?.secondaryTracks).toEqual(['tools']);
    expect(store.findResearchSource('f'.repeat(32))).toBeUndefined();
    expect(store.findByBaseId(first.source.sourceId)).toBeUndefined();
  } finally { store.close(); }
});

test('research runs and shards recover idempotently without paper checkpoints', () => {
  const store = openStateStore(':memory:');
  try {
    const run = store.startResearchRun(window, 'current');
    expect(run.kind).toBe('research_current');
    expect(store.startResearchRun(window, 'current').id).toBe(run.id);
    expect(store.startResearchRun(window, 'weekly').id).not.toBe(run.id);
    expect(store.startResearchRun(window, 'backfill').kind).toBe('research_backfill');
    expect(() => store.startResearchRun(window, 'paper' as never)).toThrow();
    expect(() => store.startResearchRun({ from: '2026-02-30', to: '2026-09-06' }, 'current')).toThrow();
    expect(() => store.startResearchRun({ from: '2026-09-07', to: '2026-09-06' }, 'current')).toThrow();
    const shard = { runId: run.id, shardKey: 'docs', shardIndex: 1, track: 'runtime', sourceKind: 'official-doc' as const };
    expect(store.beginResearchShard(shard)).toBe(true);
    store.failResearchShard({ ...shard, errorCode: 'FETCH_FAILED', errorMessage: 'fetch failed' });
    expect(store.findResearchShard(run.id, shard.shardKey)?.status).toBe('failed');
    expect(store.findResumableResearchRun('current')?.run_id).toBe(run.id);
    expect(store.findResumableHarvestRun('research_current')).toBeUndefined();
    expect(store.beginResearchShard(shard)).toBe(true);
    expect(store.findResearchShard(run.id, shard.shardKey)?.errorCode).toBeNull();
    expect(() => store.completeResearchShard({ ...shard, ...counts, candidateCount: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/i);
    expect(() => store.completeResearchShard({ ...shard, ...counts, candidateCount: 0 })).toThrow();
    store.completeResearchShard({ ...shard, ...counts });
    store.completeResearchShard({ ...shard, ...counts });
    expect(store.beginResearchShard(shard)).toBe(false);
    expect(() => store.beginResearchShard({ ...shard, track: 'tools' })).toThrow(/conflict/i);
    expect(() => store.completeResearchShard({ ...shard, ...counts, archivedCount: 0 })).toThrow(/conflict/i);
    expect(() => store.failResearchShard({ ...shard, errorCode: 'LATE', errorMessage: 'late error' })).toThrow();
    expect(store.listCompletedResearchShards(run.id)).toEqual(['docs']);
    expect(store.listCompletedHarvestShardKeys(run.id)).toEqual([]);
    const paperRun = store.startRun(window, 'current');
    expect(() => store.beginResearchShard({ ...shard, runId: paperRun.id })).toThrow(/research/i);
  } finally { store.close(); }
});

test('observations deduplicate per shard and version, retain multiple tracks, and reject conflicting replay', () => {
  const store = openStateStore(':memory:');
  try {
    const fetched = researchFixture();
    store.upsertResearchSource(fetched.source);
    store.upsertResearchSourceVersion(fetched.version, null);
    const run = store.startResearchRun(window, 'current');
    const shard = { runId: run.id, shardKey: 'runtime', shardIndex: 1, track: 'runtime', sourceKind: fetched.source.kind };
    store.beginResearchShard(shard);
    const observation = { runId: run.id, shardKey: 'runtime', sourceId: fetched.source.sourceId, versionId: 'r1',
      metadata: { matchedTracks: ['runtime', 'tools'] }, decisionStatus: 'accepted' as const, decisionReason: null, observedAt: '2026-09-06T00:00:00.000Z' };
    store.recordResearchObservation(observation);
    store.recordResearchObservation(observation);
    expect(store.listResearchObservations(run.id)).toEqual([observation]);
    expect(store.listHarvestObservations(run.id)).toEqual([]);
    expect(() => store.recordResearchObservation({ ...observation, decisionStatus: 'rejected' })).toThrow(/conflict/i);
    expect(() => store.recordResearchObservation({ ...observation, sourceId: 'f'.repeat(32) })).toThrow();
    store.beginResearchShard({ ...shard, shardKey: 'tools', track: 'tools', shardIndex: 2 });
    store.recordResearchObservation({ ...observation, shardKey: 'tools' });
    expect(store.listResearchObservations(run.id).map(o => o.shardKey)).toEqual(['runtime', 'tools']);
    store.completeResearchShard({ ...shard, ...counts });
    store.recordResearchObservation(observation);
    expect(() => store.recordResearchObservation({ ...observation, metadata: {} })).toThrow(/conflict/i);
  } finally { store.close(); }
});

test('research publication verifies receipts, rolls back bad sources, replays, and leaves paper watermarks alone', async () => {
  const fixture = await makeRuntimeFixture();
  const store = openStateStore(`${fixture.root}/state.sqlite`);
  try {
    const fetched = researchFixture();
    store.upsertResearchSource(fetched.source);
    store.upsertResearchSourceVersion({ ...fetched.version, archivePath: `archive/sources/official-doc/${fetched.source.sourceId}/r1` }, null);
    const run = store.startResearchRun(window, 'current');
    const reservation = { runId: run.id, publicationId: 'research-publication-1', inputSha256: 'a'.repeat(64) };
    expect(store.reserveResearchEvidencePublication(reservation)).toBe('reserved');
    expect(store.reserveResearchEvidencePublication(reservation)).toBe('replayed');
    expect(() => store.reserveResearchEvidencePublication({ ...reservation, inputSha256: 'b'.repeat(64) })).toThrow(/conflict/i);
    store.failResearchEvidencePublication({ ...reservation, errorCode: 'WRITE_FAILED' });
    expect(store.findResearchEvidencePublication(run.id)?.status).toBe('failed');
    expect(store.reserveResearchEvidencePublication(reservation)).toBe('reserved');
    const source = { sourceId: fetched.source.sourceId, versionId: 'r1', archiveManifestSha256: 'b'.repeat(64), evidenceManifestSha256: 'c'.repeat(64) };
    const receipt = { schemaVersion: 1, publisherVersion: 1, runId: run.id, publicationId: reservation.publicationId,
      publishedAt: '2026-09-06T00:00:00.000Z', contentSha256: reservation.inputSha256, sources: [source] };
    const receiptPath = `${fixture.root}/source-publication.json`;
    const complete = async (body: unknown) => {
      const bytes = canonicalJson(body); await writeFile(receiptPath, bytes);
      return { ...reservation, receiptPath, receiptSha256: sha256(bytes) };
    };
    for (const invalid of [
      { ...receipt, runId: 'other' }, { ...receipt, contentSha256: 'd'.repeat(64) },
      { ...receipt, sources: [source, source] },
      { ...receipt, sources: [source, { ...source, sourceId: 'f'.repeat(32) }] },
      { ...receipt, sources: [{ ...source, archiveManifestSha256: 'B'.repeat(64) }] },
    ]) {
      const input = await complete(invalid);
      expect(() => store.completeResearchEvidencePublication(input)).toThrow();
      expect(store.findResearchEvidencePublication(run.id)?.status).toBe('reserved');
      expect(store.listResearchEvidenceSources(run.id)).toEqual([]);
      expect(store.getRun(run.id)?.status).toBe('running');
    }
    const completion = await complete(receipt);
    expect(() => store.completeResearchEvidencePublication({ ...completion, receiptSha256: 'd'.repeat(64) })).toThrow();
    store.completeResearchEvidencePublication(completion);
    store.completeResearchEvidencePublication(completion);
    expect(store.getRun(run.id)?.status).toBe('completed');
    expect(store.listResearchEvidenceSources(run.id)).toEqual([source]);
    expect(store.findResearchEvidencePublication(run.id)?.receiptSha256).toBe(completion.receiptSha256);
    expect(store.findEvidencePublication(run.id)).toBeUndefined();
    expect(store.getLastSuccess()).toBeNull();
    expect(store.startResearchRun(window, 'current')).toMatchObject({ id: run.id, replayed: true });
    expect(() => store.failResearchEvidencePublication({ ...reservation, errorCode: 'LATE' })).toThrow();
    const other = store.startResearchRun(window, 'weekly');
    expect(() => store.reserveResearchEvidencePublication({ ...reservation, runId: other.id })).toThrow();
    const paper = store.startRun(window, 'current');
    expect(() => store.reserveResearchEvidencePublication({ ...reservation, runId: paper.id, publicationId: 'paper' })).toThrow(/research/i);
    await writeFile(receiptPath, '{}');
    expect(() => store.completeResearchEvidencePublication(completion)).toThrow();
  } finally { store.close(); await fixture.dispose(); }
});

test('research readers reject malformed SQLite text, hashes and unsafe integers', async () => {
  const fixture = await makeRuntimeFixture();
  const path = `${fixture.root}/state.sqlite`;
  const store = openStateStore(path), raw = createStateDatabase(path);
  try {
    const fetched = researchFixture();
    store.upsertResearchSource(fetched.source);
    store.upsertResearchSourceVersion(fetched.version, null);
    const run = store.startResearchRun(window, 'current');
    store.beginResearchShard({ runId: run.id, shardKey: 'docs', shardIndex: 1, track: 'runtime', sourceKind: 'official-doc' });
    raw.prepare('UPDATE research_shards SET candidate_count=?').run(9007199254740993n);
    expect(() => store.findResearchShard(run.id, 'docs')).toThrow(/safe integer/i);
    raw.exec('PRAGMA ignore_check_constraints=ON');
    raw.prepare('UPDATE research_source_versions SET content_sha256=?').run('A'.repeat(64));
    expect(() => store.findResearchSourceVersion(fetched.source.sourceId, 'r1')).toThrow(/SHA-256/i);
    // A historical loose table exercises actual SELECT validation, not STRICT's write rejection.
    raw.exec('ALTER TABLE research_sources RENAME TO old_research_sources');
    raw.exec('CREATE TABLE research_sources AS SELECT * FROM old_research_sources');
    raw.prepare('UPDATE research_sources SET title=?').run(new Uint8Array([42]));
    expect(() => store.findResearchSource(fetched.source.sourceId)).toThrow(/title.*text/i);
  } finally { raw.close(); store.close(); await fixture.dispose(); }
});

test('migration adds research tables while preserving existing paper state on reopen', async () => {
  const fixture = await makeRuntimeFixture();
  const path = `${fixture.root}/state.sqlite`;
  let store = openStateStore(path);
  try {
    store.upsertDiscovered({ baseId: '2609.00001', version: 1, title: 'Existing paper' });
    store.close();
    store = openStateStore(path);
    expect(store.findByBaseId('2609.00001')?.title).toBe('Existing paper');
    const raw = createStateDatabase(path);
    try {
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'research_%' ORDER BY name").all().map(row => row.name)).toEqual([
        'research_evidence_publications', 'research_evidence_sources', 'research_observations',
        'research_shards', 'research_source_versions', 'research_sources',
      ]);
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { raw.close(); }
  } finally { store.close(); await fixture.dispose(); }
});
