import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SqlRow, StateDatabase } from '../../runtime/sqlite.ts';
import type { RunWindow } from '../../types/jobs.ts';
import type {
  ResearchSource, SourceVersion, ResearchRun, ResearchRunMode, ResearchRunKind,
  ResearchShard, ResearchShardInput, ResearchShardCompletion, ResearchShardFailure,
  ResearchObservation, ResearchEvidenceSource, ResearchEvidenceReservation,
  ResearchEvidenceCompletion, ResearchEvidenceFailure, ResearchEvidencePublication,
} from '../../types/research-sources.ts';
import { canonicalJson } from '../../shared/manifest.ts';
import { redactErrorMessage } from '../../shared/redaction.ts';
import { normalizeSource, normalizeSourceVersion, normalizeVersion, sourceDate, sourceText } from '../../research/source-normalizer.ts';
import { requireSourceHash, requireSourceKind, requireVersionId, sha256 } from '../../research/source-identity.ts';

const now = () => new Date().toISOString();
function conflict(message: string): never { throw new Error(`RESEARCH_STATE_CONFLICT: ${message}`); }
function text(value: unknown, column: string): string {
  if (typeof value !== 'string') throw new TypeError(`State column ${column} must be text`);
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new TypeError('invalid research source ID');
  return value;
}
function integer(value: unknown, column: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new TypeError(`State column ${column} must be a safe integer >= ${minimum}`);
  return value;
}
function choice<const T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new TypeError('invalid research status or mode');
  return value as T;
}
const nullableText = (value: unknown, column: string) => value === null ? null : text(value, column);
const date = (value: unknown, column: string) => sourceDate(text(value, column));
const nullableDate = (value: unknown, column: string) => value === null ? null : date(value, column);
const modeKind = (mode: ResearchRunMode): ResearchRunKind => `research_${choice(mode, ['current', 'weekly', 'backfill'])}`;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected research metadata object');
  return value as Record<string, unknown>;
}
function json(value: unknown): unknown {
  const bytes = text(value, 'metadata_json');
  const parsed: unknown = JSON.parse(bytes);
  if (canonicalJson(parsed) !== bytes) throw new TypeError('research metadata must be canonical JSON');
  return parsed;
}
interface SourcePublicationReceipt {
  schemaVersion: 1;
  publisherVersion: 1;
  runId: string;
  publicationId: string;
  contentSha256: string;
  publishedAt: string;
  sources: ResearchEvidenceSource[];
}
function readSourcePublicationReceipt(value: unknown): SourcePublicationReceipt {
  const receipt = object(value);
  if (receipt.schemaVersion !== 1 || receipt.publisherVersion !== 1) conflict('receipt schema differs');
  if (!Array.isArray(receipt.sources)) conflict('receipt sources must be an array');
  const sources = receipt.sources.map((value: unknown): ResearchEvidenceSource => {
    const source = object(value);
    return { sourceId: id(source.sourceId), versionId: requireVersionId(source.versionId),
      archiveManifestSha256: requireSourceHash(source.archiveManifestSha256), evidenceManifestSha256: requireSourceHash(source.evidenceManifestSha256) };
  });
  return { schemaVersion: 1, publisherVersion: 1,
    runId: sourceText(text(receipt.runId, 'runId')), publicationId: sourceText(text(receipt.publicationId, 'publicationId')),
    contentSha256: requireSourceHash(receipt.contentSha256), publishedAt: date(receipt.publishedAt, 'publishedAt'), sources };
}
function readRun(row: SqlRow) {
  return { run_id: text(row.run_id, 'run_id'), kind: choice(row.kind, ['research_current', 'research_weekly', 'research_backfill']),
    from_utc: date(row.from_utc, 'from_utc'), to_utc: date(row.to_utc, 'to_utc'), status: text(row.status, 'status'),
    started_at: date(row.started_at, 'started_at'), finished_at: nullableDate(row.finished_at, 'finished_at'), error_message: nullableText(row.error_message, 'error_message') };
}
function readSource(row: SqlRow): ResearchSource {
  const source = normalizeSource(json(row.metadata_json) as ResearchSource);
  if (id(row.source_id) !== source.sourceId || text(row.identity_key, 'identity_key') !== source.identityKey ||
    requireSourceKind(row.source_kind) !== source.kind || text(row.canonical_url, 'canonical_url') !== source.canonicalUrl ||
    text(row.title, 'title') !== source.title || text(row.primary_track, 'primary_track') !== source.primaryTrack) conflict('source metadata binding differs');
  choice(row.status, ['discovered', 'accepted', 'rejected', 'archived', 'published']);
  date(row.created_at, 'created_at'); date(row.updated_at, 'updated_at');
  return source;
}
function readVersion(row: SqlRow) {
  const body = object(json(row.metadata_json));
  const version = normalizeVersion(body.version as SourceVersion);
  if (id(row.source_id) !== version.sourceId || requireVersionId(row.version_id) !== version.versionId ||
    text(row.version_label, 'version_label') !== version.versionLabel || requireSourceHash(row.content_sha256) !== version.contentSha256 ||
    text(row.archive_path, 'archive_path') !== version.archivePath || nullableDate(row.published_at, 'published_at') !== version.publishedAt ||
    nullableDate(row.updated_at, 'updated_at') !== version.updatedAt || nullableDate(row.released_at, 'released_at') !== version.releasedAt ||
    date(row.retrieved_at, 'retrieved_at') !== version.retrievedAt) conflict('version metadata binding differs');
  choice(row.status, ['discovered', 'accepted', 'rejected', 'archived', 'published']);
  if (!Object.hasOwn(body, 'metadata')) throw new TypeError('missing version metadata');
  return { version, metadata: body.metadata };
}
function readShard(row: SqlRow): ResearchShard {
  return { runId: text(row.run_id, 'run_id'), shardKey: text(row.shard_key, 'shard_key'), shardIndex: integer(row.shard_index, 'shard_index', 1),
    track: text(row.track, 'track'), sourceKind: requireSourceKind(row.source_kind), status: choice(row.status, ['running', 'completed', 'failed']),
    candidateCount: integer(row.candidate_count, 'candidate_count'), acceptedCount: integer(row.accepted_count, 'accepted_count'),
    newVersionCount: integer(row.new_version_count, 'new_version_count'), archivedCount: integer(row.archived_count, 'archived_count'),
    errorCode: nullableText(row.error_code, 'error_code'), errorMessage: nullableText(row.error_message, 'error_message'),
    startedAt: date(row.started_at, 'started_at'), finishedAt: nullableDate(row.finished_at, 'finished_at') };
}
function readObservation(row: SqlRow): ResearchObservation {
  return { runId: text(row.run_id, 'run_id'), shardKey: text(row.shard_key, 'shard_key'), sourceId: id(row.source_id), versionId: requireVersionId(row.version_id),
    metadata: json(row.metadata_json), decisionStatus: choice(row.decision_status, ['discovered', 'accepted', 'rejected']),
    decisionReason: nullableText(row.decision_reason, 'decision_reason'), observedAt: date(row.observed_at, 'observed_at') };
}
function readPublication(row: SqlRow): ResearchEvidencePublication {
  return { runId: text(row.run_id, 'run_id'), publicationId: text(row.publication_id, 'publication_id'), inputSha256: requireSourceHash(row.input_sha256),
    status: choice(row.status, ['reserved', 'completed', 'failed']), receiptPath: nullableText(row.receipt_path, 'receipt_path'),
    receiptSha256: row.receipt_sha256 === null ? null : requireSourceHash(row.receipt_sha256), reservedAt: date(row.reserved_at, 'reserved_at'),
    completedAt: nullableDate(row.completed_at, 'completed_at'), failedAt: nullableDate(row.failed_at, 'failed_at'), errorCode: nullableText(row.error_code, 'error_code') };
}

/** Lazy statements preserve inspection of historical databases without research tables. */
export function createResearchStateApi(db: StateDatabase, readOnly = false) {
  function transaction<T>(work: () => T): T {
    if (readOnly) throw new Error('research state is read-only');
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function researchRun(runId: string, mutable = false) {
    const row = db.prepare('SELECT * FROM runs WHERE run_id=?').get(sourceText(runId));
    if (!row) conflict('research run does not exist');
    if (!['research_current', 'research_weekly', 'research_backfill'].includes(text(row.kind, 'kind'))) conflict('research run does not exist');
    const run = readRun(row);
    if (mutable && run.status !== 'running') conflict('research run is not running');
    return run;
  }
  function findResearchSource(sourceId: string): ResearchSource | undefined {
    const row = db.prepare('SELECT * FROM research_sources WHERE source_id=?').get(id(sourceId));
    return row && readSource(row);
  }
  function findVersion(sourceId: string, versionId: string) {
    const row = db.prepare('SELECT * FROM research_source_versions WHERE source_id=? AND version_id=?').get(id(sourceId), requireVersionId(versionId));
    if (!row) return undefined;
    const result = readVersion(row), source = findResearchSource(sourceId);
    if (!source) conflict('version source is missing');
    normalizeSourceVersion(source, result.version);
    return result;
  }
  function upsertResearchSource(input: ResearchSource): void {
    const source = normalizeSource(input);
    // Validate identity against the URL even before the first version is available.
    const key = source.identityKey;
    const matches = source.kind === 'local-artifact' ? /^local:[0-9a-f]{64}$/.test(key) :
      source.kind === 'repository' ? key === `repo:${source.canonicalUrl}` :
      source.kind === 'release' ? key.startsWith(`release:${source.canonicalUrl}:`) && !!requireVersionId(key.slice(`release:${source.canonicalUrl}:`.length)) :
      key === `doc:${source.canonicalUrl}` || (['paper', 'technical-report'].includes(source.kind) && key.startsWith('arxiv:') && source.canonicalUrl === `https://arxiv.org/abs/${key.slice(6)}`);
    if (!matches) conflict('source identity and URL differ');
    transaction(() => {
      const existing = findResearchSource(source.sourceId);
      if (existing && (existing.identityKey !== key || existing.kind !== source.kind || existing.canonicalUrl !== source.canonicalUrl)) conflict('source identity differs');
      const stored = existing ? normalizeSource({ ...source, primaryTrack: existing.primaryTrack,
        secondaryTracks: [...new Set([existing.primaryTrack, ...existing.secondaryTracks, source.primaryTrack, ...source.secondaryTracks])]
          .filter(track => track !== existing.primaryTrack) }) : source;
      db.prepare(`INSERT INTO research_sources(source_id,identity_key,source_kind,canonical_url,title,primary_track,metadata_json,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'discovered',?,?) ON CONFLICT(source_id) DO UPDATE SET
        title=excluded.title,primary_track=excluded.primary_track,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
        .run(stored.sourceId, key, stored.kind, stored.canonicalUrl, stored.title, stored.primaryTrack, canonicalJson(stored), now(), now());
    });
  }
  function upsertResearchSourceVersion(input: SourceVersion, metadata: unknown = null): 'inserted' | 'replayed' | 'updated' {
    return transaction(() => {
      const source = findResearchSource(input.sourceId);
      if (!source) conflict('source must exist before its version');
      const { version } = normalizeSourceVersion(source, input);
      const expectedPath = `archive/sources/${source.kind}/${source.sourceId}/${version.versionId}`;
      if (version.archivePath && version.archivePath !== expectedPath) conflict('archive path does not match version');
      const existing = findVersion(version.sourceId, version.versionId);
      if (existing) {
        const previous = existing.version;
        if (canonicalJson({ ...previous, archivePath: '' }) !== canonicalJson({ ...version, archivePath: '' }) || canonicalJson(existing.metadata) !== canonicalJson(metadata)) conflict('immutable version differs');
        if (!version.archivePath || previous.archivePath === version.archivePath) return 'replayed';
        if (previous.archivePath) conflict('archive path already attached');
        db.prepare("UPDATE research_source_versions SET archive_path=?,metadata_json=?,status='archived' WHERE source_id=? AND version_id=?")
          .run(version.archivePath, canonicalJson({ version, metadata }), version.sourceId, version.versionId);
        return 'updated';
      }
      db.prepare(`INSERT INTO research_source_versions(source_id,version_id,version_label,content_sha256,archive_path,metadata_json,published_at,updated_at,released_at,retrieved_at,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(version.sourceId, version.versionId, version.versionLabel, version.contentSha256, version.archivePath,
          canonicalJson({ version, metadata }), version.publishedAt, version.updatedAt, version.releasedAt, version.retrievedAt, version.archivePath ? 'archived' : 'discovered');
      return 'inserted';
    });
  }
  function startResearchRun(window: RunWindow, mode: ResearchRunMode): ResearchRun {
    const kind = modeKind(mode), from = sourceDate(window.from), to = sourceDate(window.to);
    if (from > to) throw new TypeError('invalid research run window');
    return transaction(() => {
      const row = db.prepare('SELECT * FROM runs WHERE kind=? AND from_utc=? AND to_utc=? ORDER BY started_at DESC,rowid DESC LIMIT 1').get(kind, from, to);
      if (row) {
        const existing = readRun(row);
        if (existing.status === 'completed') return { id: existing.run_id, kind, from, to, status: 'completed', replayed: true };
        db.prepare("UPDATE runs SET status='running',finished_at=NULL,error_message=NULL WHERE run_id=?").run(existing.run_id);
        return { id: existing.run_id, kind, from, to, status: 'running', resumed: true };
      }
      const run = { id: randomUUID(), kind, from, to, status: 'running', startedAt: now() };
      db.prepare('INSERT INTO runs(run_id,kind,from_utc,to_utc,status,started_at) VALUES(?,?,?,?,?,?)').run(run.id, kind, from, to, run.status, run.startedAt);
      return run;
    });
  }
  function findResearchShard(runId: string, shardKey: string): ResearchShard | undefined {
    const row = db.prepare('SELECT * FROM research_shards WHERE run_id=? AND shard_key=?').get(sourceText(runId), sourceText(shardKey));
    return row && readShard(row);
  }
  function beginResearchShard(input: ResearchShardInput): boolean {
    const index = integer(input.shardIndex, 'shard_index', 1), track = sourceText(input.track), kind = requireSourceKind(input.sourceKind), key = sourceText(input.shardKey);
    return transaction(() => {
      const run = researchRun(input.runId), existing = findResearchShard(input.runId, key);
      if (existing && (existing.shardIndex !== index || existing.track !== track || existing.sourceKind !== kind)) conflict('shard identity differs');
      if (existing?.status === 'completed') return false;
      if (!['running', 'failed', 'awaiting_evidence'].includes(run.status)) conflict('research run is not eligible for Evidence publication');
      db.prepare(`INSERT INTO research_shards(run_id,shard_key,shard_index,track,source_kind,status,started_at)
        VALUES(?,?,?,?,?,'running',?) ON CONFLICT(run_id,shard_key) DO UPDATE SET status='running',
        candidate_count=0,accepted_count=0,new_version_count=0,archived_count=0,error_code=NULL,error_message=NULL,started_at=excluded.started_at,finished_at=NULL`)
        .run(input.runId, key, index, track, kind, now());
      return true;
    });
  }
  function completeResearchShard(input: ResearchShardCompletion): void {
    const keys = ['candidateCount', 'acceptedCount', 'newVersionCount', 'archivedCount'] as const;
    for (const key of keys) integer(input[key], key);
    if (input.acceptedCount > input.candidateCount || input.newVersionCount > input.acceptedCount || input.archivedCount > input.acceptedCount) conflict('invalid shard counts');
    transaction(() => {
      researchRun(input.runId);
      const shard = findResearchShard(input.runId, input.shardKey);
      if (shard?.status === 'completed') {
        if (keys.some(key => shard[key] !== input[key])) conflict('completed shard counts differ');
        return;
      }
      researchRun(input.runId, true);
      if (shard?.status !== 'running') conflict('shard is not running');
      db.prepare("UPDATE research_shards SET status='completed',candidate_count=?,accepted_count=?,new_version_count=?,archived_count=?,finished_at=?,error_code=NULL,error_message=NULL WHERE run_id=? AND shard_key=?")
        .run(input.candidateCount, input.acceptedCount, input.newVersionCount, input.archivedCount, now(), input.runId, input.shardKey);
    });
  }
  function failResearchShard(input: ResearchShardFailure): void {
    const code = sourceText(input.errorCode), message = redactErrorMessage({ message: text(input.errorMessage, 'errorMessage') });
    transaction(() => {
      researchRun(input.runId, true);
      const shard = findResearchShard(input.runId, input.shardKey);
      if (shard?.status === 'failed' && shard.errorCode === code && shard.errorMessage === message) return;
      if (shard?.status !== 'running') conflict('shard is not running');
      db.prepare("UPDATE research_shards SET status='failed',error_code=?,error_message=?,finished_at=? WHERE run_id=? AND shard_key=?").run(code, message, now(), input.runId, input.shardKey);
    });
  }
  function recordResearchObservation(input: ResearchObservation): void {
    const value: ResearchObservation = { runId: sourceText(input.runId), shardKey: sourceText(input.shardKey), sourceId: id(input.sourceId), versionId: requireVersionId(input.versionId),
      metadata: JSON.parse(canonicalJson(input.metadata)), decisionStatus: choice(input.decisionStatus, ['discovered', 'accepted', 'rejected']),
      decisionReason: input.decisionReason === null ? null : sourceText(input.decisionReason), observedAt: sourceDate(input.observedAt) };
    transaction(() => {
      researchRun(value.runId);
      const row = db.prepare('SELECT * FROM research_observations WHERE run_id=? AND shard_key=? AND source_id=? AND version_id=?').get(value.runId, value.shardKey, value.sourceId, value.versionId);
      if (row) {
        if (canonicalJson(readObservation(row)) !== canonicalJson(value)) conflict('observation replay differs');
        return;
      }
      researchRun(value.runId, true);
      const shard = findResearchShard(value.runId, value.shardKey);
      if (!shard) conflict('observation shard does not exist');
      if (shard.status !== 'running') conflict('observation shard is not running');
      const source = findResearchSource(value.sourceId);
      if (!source) conflict('observation source does not exist');
      if (source.kind !== shard.sourceKind || !findVersion(value.sourceId, value.versionId)) conflict('observation source/version differs');
      db.prepare('INSERT INTO research_observations(run_id,shard_key,source_id,version_id,metadata_json,decision_status,decision_reason,observed_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(value.runId, value.shardKey, value.sourceId, value.versionId, canonicalJson(value.metadata), value.decisionStatus, value.decisionReason, value.observedAt);
    });
  }
  function findResearchEvidencePublication(runId: string): ResearchEvidencePublication | undefined {
    const row = db.prepare('SELECT * FROM research_evidence_publications WHERE run_id=?').get(sourceText(runId));
    return row && readPublication(row);
  }
  function listResearchEvidenceSources(runId: string): ResearchEvidenceSource[] {
    return db.prepare('SELECT * FROM research_evidence_sources WHERE run_id=? ORDER BY source_id,version_id').all(sourceText(runId)).map(row => {
      text(row.run_id, 'run_id'); date(row.recorded_at, 'recorded_at');
      return { sourceId: id(row.source_id), versionId: requireVersionId(row.version_id), archiveManifestSha256: requireSourceHash(row.archive_manifest_sha256), evidenceManifestSha256: requireSourceHash(row.evidence_manifest_sha256) };
    });
  }
  function reserveResearchEvidencePublication(input: ResearchEvidenceReservation): 'reserved' | 'replayed' {
    sourceText(input.publicationId); requireSourceHash(input.inputSha256);
    return transaction(() => {
      const run = researchRun(input.runId), existing = findResearchEvidencePublication(input.runId);
      if (existing) {
        if (existing.publicationId !== input.publicationId || existing.inputSha256 !== input.inputSha256) conflict('publication identity differs');
        if (existing.status !== 'failed') return 'replayed';
      }
      if (run.status !== 'running') conflict('research run is not running');
      db.prepare(`INSERT INTO research_evidence_publications(run_id,publication_id,input_sha256,status,reserved_at) VALUES(?,?,?,'reserved',?)
        ON CONFLICT(run_id) DO UPDATE SET status='reserved',reserved_at=excluded.reserved_at,failed_at=NULL,error_code=NULL,receipt_path=NULL,receipt_sha256=NULL,completed_at=NULL`)
        .run(input.runId, input.publicationId, input.inputSha256, now());
      return 'reserved';
    });
  }
  function completeResearchEvidencePublication(input: ResearchEvidenceCompletion): void {
    sourceText(input.publicationId); sourceText(input.receiptPath); requireSourceHash(input.receiptSha256);
    transaction(() => {
      const run = researchRun(input.runId), publication = findResearchEvidencePublication(input.runId);
      if (!publication) conflict('publication is not reserved');
      if (publication.publicationId !== input.publicationId) conflict('publication is not reserved');
      const bytes = readFileSync(input.receiptPath);
      if (sha256(bytes) !== input.receiptSha256) conflict('receipt SHA-256 differs');
      const receipt = readSourcePublicationReceipt(JSON.parse(bytes.toString('utf8')));
      if (receipt.runId !== input.runId || receipt.publicationId !== input.publicationId ||
        receipt.contentSha256 !== publication.inputSha256) conflict('receipt identity differs');
      const seen = new Set<string>();
      const sources = receipt.sources.map(result => {
        const key = `${result.sourceId}/${result.versionId}`;
        if (seen.has(key)) conflict('duplicate receipt source');
        seen.add(key);
        if (!findVersion(result.sourceId, result.versionId)?.version.archivePath) conflict('receipt source version is not archived');
        return result;
      }).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0);
      if (publication.status === 'completed') {
        if (publication.receiptPath !== input.receiptPath || publication.receiptSha256 !== input.receiptSha256 || canonicalJson(listResearchEvidenceSources(input.runId)) !== canonicalJson(sources)) conflict('completed receipt differs');
        return;
      }
      if (publication.status !== 'reserved' || !['running', 'failed'].includes(run.status)) conflict('publication cannot complete');
      if (db.prepare("SELECT 1 FROM research_shards WHERE run_id=? AND status!='completed'").get(input.runId)) conflict('research shards are unfinished');
      const stamp = now();
      for (const source of sources) db.prepare('INSERT INTO research_evidence_sources(run_id,source_id,version_id,archive_manifest_sha256,evidence_manifest_sha256,recorded_at) VALUES(?,?,?,?,?,?)')
        .run(input.runId, source.sourceId, source.versionId, source.archiveManifestSha256, source.evidenceManifestSha256, stamp);
      db.prepare("UPDATE research_evidence_publications SET status='completed',receipt_path=?,receipt_sha256=?,completed_at=?,failed_at=NULL,error_code=NULL WHERE run_id=?")
        .run(input.receiptPath, input.receiptSha256, stamp, input.runId);
      db.prepare("UPDATE runs SET status='completed',finished_at=?,error_message=NULL WHERE run_id=?").run(stamp, input.runId);
    });
  }
  function failResearchEvidencePublication(input: ResearchEvidenceFailure): void {
    sourceText(input.publicationId); sourceText(input.errorCode);
    transaction(() => {
      researchRun(input.runId);
      const publication = findResearchEvidencePublication(input.runId);
      if (!publication) conflict('publication is not reserved');
      if (publication.publicationId !== input.publicationId) conflict('publication identity differs');
      if (publication.status === 'failed' && publication.errorCode === input.errorCode) return;
      if (publication.status !== 'reserved') conflict('publication is not reserved');
      db.prepare("UPDATE research_evidence_publications SET status='failed',failed_at=?,error_code=? WHERE run_id=?").run(now(), input.errorCode, input.runId);
    });
  }
  return {
    upsertResearchSource, upsertResearchSourceVersion, findResearchSource,
    listResearchSources(): ResearchSource[] {
      return db.prepare('SELECT * FROM research_sources ORDER BY source_id').all().map(readSource);
    },
    findResearchSourceVersion(sourceId: string, versionId: string): SourceVersion | undefined { return findVersion(sourceId, versionId)?.version; },
    listResearchSourceVersions(sourceId: string): SourceVersion[] {
      return db.prepare('SELECT * FROM research_source_versions WHERE source_id=? ORDER BY version_id').all(id(sourceId)).map(row => {
        const { version } = readVersion(row), source = findResearchSource(sourceId);
        if (!source) conflict('version source is missing');
        return normalizeSourceVersion(source, version).version;
      });
    },
    listAllResearchSourceVersions(): SourceVersion[] {
      return db.prepare('SELECT * FROM research_source_versions ORDER BY source_id,version_id').all().map(row => readVersion(row).version);
    },
    startResearchRun,
    findResumableResearchRun(mode: ResearchRunMode) {
      const row = db.prepare("SELECT * FROM runs WHERE kind=? AND status IN ('running','failed') ORDER BY started_at DESC,rowid DESC LIMIT 1").get(modeKind(mode));
      return row && readRun(row);
    },
    beginResearchShard, completeResearchShard, failResearchShard, findResearchShard,
    listCompletedResearchShards(runId: string): string[] {
      return db.prepare("SELECT * FROM research_shards WHERE run_id=? AND status='completed' ORDER BY shard_index,shard_key").all(sourceText(runId)).map(row => readShard(row).shardKey);
    },
    recordResearchObservation,
    listResearchObservations(runId: string): ResearchObservation[] {
      return db.prepare(`SELECT o.* FROM research_observations o JOIN research_shards s ON s.run_id=o.run_id AND s.shard_key=o.shard_key
        WHERE o.run_id=? ORDER BY s.shard_index,o.shard_key,o.source_id,o.version_id`).all(sourceText(runId)).map(readObservation);
    },
    reserveResearchEvidencePublication, completeResearchEvidencePublication, failResearchEvidencePublication,
    findResearchEvidencePublication, listResearchEvidenceSources,
  };
}
