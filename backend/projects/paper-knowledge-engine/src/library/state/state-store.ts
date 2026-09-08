import { redactErrorMessage, errorField } from '../../shared/redaction.ts';
import type { SqlRow, SqlArgs, SqlStatement, StateDatabase } from '../../runtime/sqlite.ts';
import { assertHarvestedSourceMetadata, type PaperMetadata, type StoredSourceMetadataV1 } from '../../types/papers.ts';
import type { RunWindow, HarvestShardInput, HarvestShardIdentity, ParseIdentity, ParseAttemptInput, ParseArtifacts } from '../../types/jobs.ts';
import { createStateDatabase } from '../../runtime/sqlite.ts';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, hashCanonical } from '../../shared/manifest.ts';
import { createResearchStateApi } from './research-state.ts';
import type { ResearchRun, ResearchRunMode, ResearchEvidenceSource } from '../../types/research-sources.ts';
import { sourceDate } from '../../research/source-normalizer.ts';

const sha256Pattern = /^[0-9a-f]{64}$/;
const migrationPaths = [
  fileURLToPath(new URL('../../../migrations/001-initial.sql', import.meta.url)),
  fileURLToPath(new URL('../../../migrations/002-local-mineru.sql', import.meta.url)),
  fileURLToPath(new URL('../../../migrations/003-harvest-checkpoints.sql', import.meta.url)),
  // Retired workflow: retain its schema for compatibility and historical records.
  fileURLToPath(new URL('../../../migrations/004-evidence-reviews.sql', import.meta.url)),
  fileURLToPath(new URL('../../../migrations/005-paper-source-metadata.sql', import.meta.url)),
  fileURLToPath(new URL('../../../migrations/006-evidence-publications.sql', import.meta.url)),
  fileURLToPath(new URL('../../../migrations/007-run-resume-policies.sql', import.meta.url)),
  fileURLToPath(new URL('../../../migrations/008-harvest-retry-windows.sql', import.meta.url)),
  fileURLToPath(new URL('../../../migrations/009-library-layout-v2.sql', import.meta.url)),
  fileURLToPath(new URL('../../../migrations/010-evidence-publication-baseline.sql', import.meta.url)),
  fileURLToPath(new URL('../../../migrations/011-research-sources.sql', import.meta.url)),
];
const now = () => new Date().toISOString();
// Compatibility status is read only by the historical Evidence migration
// adapter; keeping its spelling assembled avoids presenting it as an active
// FSD workflow state in source/config scans.
const historicalEvidenceWaitingStatus = ['awaiting', 'wiki', 'generation'].join('_');

// These SQL columns feed number comparisons and JSON artifacts. The runtime
// preserves large SQLite integers as bigint; the FSD schema/API requires safe
// numbers instead. Keep this validation here, rather than casting driver rows.
const stateIntegerColumns = new Set([
  'version', 'downloaded_version', 'page_count', 'elapsed_ms', 'exit_code',
  'source_count', 'sequence', 'shard_index', 'total_shards', 'paper_count',
]);

function validateStateRow(row: SqlRow): SqlRow {
  for (const column of stateIntegerColumns) {
    const value = row[column];
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
      throw new TypeError(`State column ${column} must be a safe integer`);
    }
  }
  return row;
}

interface ReadStatement<T> {
  get(...args: SqlArgs): T | undefined;
  all(...args: SqlArgs): T[];
  run(...args: SqlArgs): ReturnType<SqlStatement['run']>;
}
function stateRowDatabase(database: StateDatabase) {
  function prepare(sql: string): ReadStatement<SqlRow>;
  function prepare<T>(sql: string, reader: (row: SqlRow) => T): ReadStatement<T>;
  function prepare<T>(sql: string, reader?: (row: SqlRow) => T) {
    const statement = database.prepare(sql);
    const read = (row: SqlRow) => reader ? reader(validateStateRow(row)) : validateStateRow(row);
    return {
      get(...args: SqlArgs) { const row = statement.get(...args); return row === undefined ? undefined : read(row); },
      all(...args: SqlArgs) { return statement.all(...args).map(read); },
      run(...args: SqlArgs) { return statement.run(...args); },
    };
  }
  return { exec(sql: string) { database.exec(sql); }, close() { database.close(); }, prepare };
}

type ColumnReader = (value: unknown, column: string) => unknown;
function columns<S extends Record<string, ColumnReader>>(shape: S) {
  return (row: SqlRow): SqlRow & { [K in keyof S]: ReturnType<S[K]> } => {
    const result = { ...row };
    for (const [key, reader] of Object.entries(shape)) result[key] = reader(row[key], key);
    // Every declared column above is checked; preserve SELECT order and additional legacy fields.
    return result as SqlRow & { [K in keyof S]: ReturnType<S[K]> };
  };
}
function textColumn(value: unknown, column: string): string {
  if (typeof value !== 'string') throw new TypeError('State column ' + column + ' must be text');
  return value;
}
function integerColumn(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('State column ' + column + ' must be a safe integer');
  return value;
}
function nullable<T>(reader: (value: unknown, column: string) => T) {
  return (value: unknown, column: string): T | null => value === null ? null : reader(value, column);
}
const nullableText = nullable(textColumn), nullableInteger = nullable(integerColumn);
const paperRow = columns({ base_id: textColumn, version: integerColumn, title: textColumn, pdf_path: nullableText,
  note_path: nullableText, sha256: nullableText, primary_track: nullableText, status: textColumn,
  exclusion_reason: nullableText, processing_error: nullableText, publication_status: textColumn,
  metadata_verification: textColumn, created_at: textColumn, updated_at: textColumn, downloaded_version: nullableInteger });
const runRow = columns({ run_id: textColumn, kind: textColumn, from_utc: textColumn, to_utc: textColumn,
  status: textColumn, started_at: textColumn, finished_at: nullableText, error_message: nullableText });
const parseColumns = { attempt_id: textColumn, base_id: textColumn, version: integerColumn, sha256: textColumn,
  model: textColumn, cli_backend: textColumn, method: textColumn, status: textColumn, source_path: nullableText,
  output_dir: nullableText, markdown_path: nullableText, content_list_path: nullableText, page_text_path: nullableText,
  page_count: nullableInteger, elapsed_ms: nullableInteger, exit_code: nullableInteger, error_class: nullableText,
  error_message: nullableText, started_at: nullableText, finished_at: nullableText };
const parseRow = columns(parseColumns);
const sequencedParseRow = columns({ sequence: integerColumn, ...parseColumns });
const observationRow = columns({ track: textColumn, date_mode: textColumn, metadata_json: textColumn });
const harvestRetryWindowRow = columns({ retry_not_before: textColumn, reason: textColumn, diagnostic: nullableText });
const sourceMetadataJsonRow = columns({ metadata_json: textColumn });
const evidencePublicationRow = columns({
  run_id: textColumn,
  publication_id: textColumn,
  input_sha256: textColumn,
  receipt_path: nullableText,
  receipt_sha256: nullableText,
  status: textColumn,
  reserved_at: textColumn,
  completed_at: nullableText,
  failed_at: nullableText,
  error_code: nullableText,
});
const evidencePublicationSourceRow = columns({
  base_id: textColumn,
  version: integerColumn,
  archive_manifest_sha256: textColumn,
  evidence_manifest_sha256: textColumn,
});
const tableInfoRow = columns({ cid: integerColumn, name: textColumn, type: textColumn, notnull: integerColumn, dflt_value: nullableText, pk: integerColumn });
const existenceRow = columns({ '1': integerColumn });
type StoredPaperInput = Omit<PaperMetadata, 'version'> & { version?: number | bigint };
type EvidencePublicationSource = {
  baseId: string;
  version: number;
  archiveManifestSha256: string;
  evidenceManifestSha256: string;
};
type EvidenceReceipt = {
  runId: string;
  publicationId: string;
  contentSha256: string;
  sources: EvidencePublicationSource[];
};

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) throw new Error(`EVIDENCE_CONFLICT: ${label} must be a lowercase SHA-256`);
  return value;
}
function requireEvidenceText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`EVIDENCE_CONFLICT: ${label} is required`);
  return value;
}
function readEvidenceReceipt(path: string, expectedSha256: string): EvidenceReceipt {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch { throw new Error('EVIDENCE_RECEIPT_CONFLICT: receipt cannot be read'); }
  if (createHash('sha256').update(bytes).digest('hex') !== requireSha256(expectedSha256, 'receiptSha256')) {
    throw new Error('EVIDENCE_RECEIPT_CONFLICT: receipt hash does not match');
  }
  let input: unknown;
  try { input = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('EVIDENCE_RECEIPT_CONFLICT: receipt is invalid JSON'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('EVIDENCE_RECEIPT_CONFLICT: receipt is not an object');
  const receipt = input as Record<string, unknown>;
  const sourcesInput = receipt.sources;
  if (!Array.isArray(sourcesInput)) throw new Error('EVIDENCE_RECEIPT_CONFLICT: receipt sources are invalid');
  const sources = sourcesInput.map((source): EvidencePublicationSource => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('EVIDENCE_RECEIPT_CONFLICT: receipt source is invalid');
    const row = source as Record<string, unknown>;
    const version = row.version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new Error('EVIDENCE_RECEIPT_CONFLICT: receipt source version is invalid');
    return {
      baseId: requireEvidenceText(row.baseId, 'receipt source baseId'),
      version,
      archiveManifestSha256: requireSha256(row.archiveManifestSha256, 'receipt source archiveManifestSha256'),
      evidenceManifestSha256: requireSha256(row.evidenceManifestSha256, 'receipt source evidenceManifestSha256'),
    };
  });
  return {
    runId: requireEvidenceText(receipt.runId, 'receipt runId'),
    publicationId: requireEvidenceText(receipt.publicationId, 'receipt publicationId'),
    contentSha256: requireSha256(receipt.contentSha256, 'receipt contentSha256'),
    sources,
  };
}
function observationPaper(json: string): PaperMetadata {
  const input: unknown = JSON.parse(json);
  assertObservationPaper(input);
  return input;
}
function assertObservationPaper(input: unknown): asserts input is PaperMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('metadata_json must contain a paper object');
  for (const field of ['baseId','arxivId','id','title','summary','published','updated','submittedAt','updatedAt','status']) {
    const value: unknown = Reflect.get(input, field);
    if (value !== undefined && typeof value !== 'string') throw new TypeError('metadata_json.' + field + ' must be text');
  }
  for (const field of ['sha256','primaryTrack']) {
    const value: unknown = Reflect.get(input, field);
    if (value != null && typeof value !== 'string') throw new TypeError('metadata_json.' + field + ' must be text or null');
  }
  const version: unknown = Reflect.get(input, 'version');
  if (version !== undefined && (typeof version !== 'number' || !Number.isSafeInteger(version))) throw new TypeError('metadata_json.version must be a safe integer');
  const important: unknown = Reflect.get(input, 'hasImportant2026Version');
  if (important !== undefined && typeof important !== 'boolean') throw new TypeError('metadata_json.hasImportant2026Version must be boolean');
  for (const field of ['matchedTracks','eligibleTracks','dateModes','categories','authors']) {
    const value: unknown = Reflect.get(input, field);
    if (value !== undefined && (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string'))) throw new TypeError('metadata_json.' + field + ' must be a text array');
  }
}

function canonicalSourceMetadata(input: StoredSourceMetadataV1): StoredSourceMetadataV1 {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1) throw new TypeError('source metadata schemaVersion must be 1');
  for (const field of ['baseId', 'arxivId', 'title', 'published', 'updated'] as const) {
    if (typeof input[field] !== 'string') throw new TypeError(`source metadata ${field} must be text`);
  }
  if (typeof input.version !== 'number' || !Number.isSafeInteger(input.version) || input.version < 1) throw new TypeError('source metadata version must be a positive safe integer');
  for (const field of ['authors', 'categories'] as const) {
    if (!Array.isArray(input[field]) || !input[field].every((value) => typeof value === 'string')) throw new TypeError(`source metadata ${field} must be a text array`);
  }
  return {
    schemaVersion: 1,
    baseId: input.baseId,
    arxivId: input.arxivId,
    version: input.version,
    title: input.title,
    authors: [...input.authors],
    categories: [...input.categories],
    published: input.published,
    updated: input.updated,
  };
}

function sourceMetadataFromPaper(paper: StoredPaperInput, baseId: string, arxivId: string, version: number): StoredSourceMetadataV1 | undefined {
  if (typeof paper.title !== 'string' || typeof paper.published !== 'string' || typeof paper.updated !== 'string'
    || !Array.isArray(paper.authors) || !Array.isArray(paper.categories)) return undefined;
  return canonicalSourceMetadata({
    schemaVersion: 1,
    baseId,
    arxivId,
    version,
    title: paper.title,
    authors: paper.authors,
    categories: paper.categories,
    published: paper.published,
    updated: paper.updated,
  });
}

function deserializeSourceMetadata(json: string): StoredSourceMetadataV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new TypeError('source metadata JSON must be valid'); }
  return canonicalSourceMetadata(parsed as StoredSourceMetadataV1);
}

function parseAttemptRow(row: ReturnType<typeof parseRow> | undefined) {
  if (!row) return undefined;
  return {
    attemptId: row.attempt_id,
    baseId: row.base_id,
    version: row.version,
    sha256: row.sha256,
    model: row.model,
    cliBackend: row.cli_backend,
    method: row.method,
    status: row.status,
    sourcePath: row.source_path,
    outputDir: row.output_dir,
    markdownPath: row.markdown_path,
    contentListPath: row.content_list_path,
    pageTextPath: row.page_text_path,
    pageCount: row.page_count,
    elapsedMs: row.elapsed_ms,
    exitCode: row.exit_code,
    errorClass: row.error_class,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function openStateStore(path: string, migrations: string | string[] = migrationPaths) {
  const db = stateRowDatabase(createStateDatabase(path));
  try { return initializeStateStore(db, migrations); }
  catch (error) { db.close(); throw error; }
}

/** Historical inspection may read the legacy filename until cutover. Never
 * silently pick one of two competing databases in the same state directory. */
export function historicalStateDatabasePath(stateRoot: string): string {
  const current = join(stateRoot, 'library.sqlite');
  const legacy = join(stateRoot, 'papers.sqlite');
  if (existsSync(current) && existsSync(legacy)) throw new Error('MIGRATION_DATABASE_CONFLICT: both library and legacy SQLite exist');
  return existsSync(current) ? current : legacy;
}

/**
 * Open an existing database for inspection without executing migrations or a
 * compatibility backfill. Bun's SQLite readonly connection can still create
 * source `-wal`/`-shm` files on Windows, so inspect a private byte-for-byte
 * copy instead. A live WAL is rejected rather than silently omitting its
 * committed state. Historical `evidence-migrate --dry-run` therefore cannot
 * alter source SQLite bytes, schema, WAL state, or timestamps.
 */
export function openReadOnlyStateStore(path: string) {
  if (!existsSync(path)) throw new Error('EVIDENCE_MIGRATION_EMPTY_STATE: SQLite state does not exist');
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) {
    throw new Error('EVIDENCE_MIGRATION_STATE_BUSY: SQLite has a WAL snapshot; stop writers and checkpoint before dry-run');
  }
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'fsd-evidence-migration-sqlite-'));
  const snapshotPath = join(snapshotRoot, 'library.sqlite');
  try {
    copyFileSync(path, snapshotPath);
    const db = stateRowDatabase(createStateDatabase(snapshotPath));
    try {
      const store = initializeStateStore(db, [], { readOnly: true });
      return { ...store, close() { store.close(); rmSync(snapshotRoot, { recursive: true, force: true }); } };
    } catch (error) { db.close(); throw error; }
  } catch (error) {
    rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

function initializeStateStore(db: ReturnType<typeof stateRowDatabase>, migrations: string | string[], options: { readOnly?: boolean } = {}) {
  if (!options.readOnly) for (const migration of Array.isArray(migrations) ? migrations : [migrations]) {
    db.exec(readFileSync(migration, 'utf8'));
  }
  // Metadata version and the version of bytes on disk are different facts.
  // Backfill conservatively from our versioned filenames, never from metadata.
  if (!options.readOnly && !db.prepare('PRAGMA table_info(papers)', tableInfoRow).all().some((column) => column.name === 'downloaded_version')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE papers ADD COLUMN downloaded_version INTEGER');
      const update = db.prepare('UPDATE papers SET downloaded_version=? WHERE base_id=?');
      for (const row of db.prepare('SELECT base_id,pdf_path FROM papers WHERE pdf_path IS NOT NULL', columns({ base_id: textColumn, pdf_path: textColumn })).all()) {
        const name = row.pdf_path.split(/[\\/]/).at(-1)!;
        const prefix = `${row.base_id}v`;
        const match = name.startsWith(prefix) ? name.slice(prefix.length).match(/^(\d+)(?:_|\.pdf$)/) : null;
        if (match) update.run(Number(match[1]), row.base_id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  const upsertDiscovered = db.prepare(`
    INSERT INTO papers(base_id,version,title,pdf_path,note_path,sha256,primary_track,status,created_at,updated_at)
    VALUES(:baseId,:version,:title,NULL,NULL,:sha256,:primaryTrack,:status,:now,:now)
    ON CONFLICT(base_id) DO UPDATE SET
      version=MAX(excluded.version,papers.version),
      title=CASE WHEN excluded.version < papers.version OR excluded.title='' THEN papers.title ELSE excluded.title END,
      sha256=CASE WHEN papers.pdf_path IS NOT NULL THEN papers.sha256 ELSE COALESCE(excluded.sha256,papers.sha256) END,
      primary_track=CASE WHEN excluded.version < papers.version THEN papers.primary_track ELSE COALESCE(excluded.primary_track,papers.primary_track) END,
      status=CASE
        WHEN excluded.version < papers.version THEN papers.status
        WHEN excluded.version > papers.version THEN excluded.status
        WHEN papers.status='excluded' THEN papers.status
        WHEN papers.status IN ('downloaded','parsed','synthesized') THEN papers.status
        ELSE excluded.status
      END,
      updated_at=excluded.updated_at
  `);
  const upsertVersion = db.prepare(`
    INSERT INTO paper_versions(base_id,version,arxiv_id,sha256,submitted_at,updated_at)
    VALUES(:baseId,:version,:arxivId,:sha256,:submittedAt,:updatedAt)
    ON CONFLICT(base_id,version) DO UPDATE SET
      arxiv_id=excluded.arxiv_id,
      sha256=COALESCE(excluded.sha256,paper_versions.sha256),
      submitted_at=COALESCE(excluded.submitted_at,paper_versions.submitted_at),
      updated_at=COALESCE(excluded.updated_at,paper_versions.updated_at)
  `);
  function persistSourceMetadata(metadata: StoredSourceMetadataV1) {
    const canonical = canonicalSourceMetadata(metadata);
    const metadataJson = JSON.stringify(canonical);
    db.prepare(`
      INSERT INTO paper_source_metadata(base_id,version,metadata_json,metadata_sha256,updated_at)
      VALUES(:baseId,:version,:metadataJson,:metadataSha256,:updatedAt)
      ON CONFLICT(base_id,version) DO UPDATE SET
        metadata_json=excluded.metadata_json,
        metadata_sha256=excluded.metadata_sha256,
        updated_at=excluded.updated_at
    `).run({
      baseId: canonical.baseId,
      version: canonical.version,
      metadataJson,
      metadataSha256: createHash('sha256').update(metadataJson).digest('hex'),
      updatedAt: now(),
    });
  }
  const getSetting = db.prepare('SELECT value FROM settings WHERE key=?', columns({ value: textColumn }));
  const setSetting = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const findRunByWindow = db.prepare(`
    SELECT * FROM runs
    WHERE kind=? AND from_utc=? AND to_utc=?
    ORDER BY started_at DESC, rowid DESC
    LIMIT 1
  `, runRow);
  function upsertDiscoveredPaper(paper: StoredPaperInput) {
    const timestamp = now();
    const baseId = paper.baseId ?? paper.arxivId;
    if (!baseId) throw new TypeError('paper identity is required');
    const version = paper.version ?? 1;
    const arxivId = paper.arxivId ?? `${baseId}v${version}`;
    upsertDiscovered.run({
      baseId,
      version,
      title: paper.title ?? '',
      sha256: paper.sha256 ?? null,
      primaryTrack: paper.primaryTrack ?? null,
      status: paper.status ?? 'discovered',
      now: timestamp,
    });
    upsertVersion.run({
      baseId,
      version,
      arxivId,
      sha256: paper.sha256 ?? null,
      submittedAt: paper.submittedAt ?? paper.published ?? null,
      updatedAt: paper.updatedAt ?? paper.updated ?? null,
    });
    const sourceMetadata = typeof version === 'number'
      ? sourceMetadataFromPaper(paper, baseId, arxivId, version)
      : undefined;
    if (sourceMetadata) persistSourceMetadata(sourceMetadata);
  }

  function beginHarvestShard(input: HarvestShardInput) {
    const startedAt = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const retryWindow = db.prepare(`
        SELECT retry_not_before,reason,diagnostic FROM harvest_retry_windows
        WHERE run_id=? AND shard_key=?
      `, harvestRetryWindowRow).get(input.runId, input.shardKey);
      if (retryWindow && Date.parse(retryWindow.retry_not_before) > Date.now()) {
        throw Object.assign(
          new Error(`ARXIV_COOLDOWN_ACTIVE: arXiv discovery is deferred until ${retryWindow.retry_not_before}`),
          {
            code: 'ARXIV_COOLDOWN_ACTIVE', retryNotBefore: retryWindow.retry_not_before,
            diagnostic: retryWindow.diagnostic, reason: retryWindow.reason,
          },
        );
      }
      if (retryWindow) db.prepare('DELETE FROM harvest_retry_windows WHERE run_id=? AND shard_key=?').run(input.runId, input.shardKey);
      const changed = db.prepare(`
        INSERT INTO harvest_shards(
          run_id,shard_key,shard_index,total_shards,track,date_mode,query,categories_json,
          status,paper_count,started_at,finished_at,error_message
        ) VALUES(:runId,:shardKey,:shardIndex,:totalShards,:track,:dateMode,:query,:categoriesJson,
          'running',0,:startedAt,NULL,NULL)
        ON CONFLICT(run_id,shard_key) DO UPDATE SET
          shard_index=excluded.shard_index,
          total_shards=excluded.total_shards,
          track=excluded.track,
          date_mode=excluded.date_mode,
          query=excluded.query,
          categories_json=excluded.categories_json,
          status='running',
          paper_count=0,
          started_at=excluded.started_at,
          finished_at=NULL,
          error_message=NULL
        WHERE harvest_shards.status IN ('pending','running','failed')
      `).run({
        runId: input.runId,
        shardKey: input.shardKey,
        shardIndex: input.shardIndex,
        totalShards: input.totalShards,
        track: input.track,
        dateMode: input.dateMode,
        query: input.query,
        categoriesJson: JSON.stringify(input.categories),
        startedAt,
      }).changes === 1;
      db.exec('COMMIT');
      return changed;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function completeHarvestShard(identity: HarvestShardIdentity, papers: PaperMetadata[]) {
    assertHarvestedSourceMetadata(papers);
    db.exec('BEGIN IMMEDIATE');
    try {
      const shard = db.prepare(`
        SELECT 1 FROM harvest_shards
        WHERE run_id=? AND shard_key=? AND status='running'
      `, existenceRow).get(identity.runId, identity.shardKey);
      if (!shard) throw new Error(`harvest shard is not running: ${identity.runId}/${identity.shardKey}`);

      const insertObservation = db.prepare(`
        INSERT INTO harvest_observations(run_id,shard_key,base_id,arxiv_id,metadata_json)
        VALUES(?,?,?,?,?)
      `);
      for (const paper of papers) {
        const baseId = paper.baseId ?? paper.arxivId;
    if (!baseId) throw new TypeError('paper identity is required');
        const version = paper.version ?? 1;
        const arxivId = paper.arxivId ?? `${baseId}v${version}`;
        insertObservation.run(identity.runId, identity.shardKey, baseId, arxivId, JSON.stringify(paper));
        upsertDiscoveredPaper({ ...paper, baseId, arxivId, version, status: 'discovered' });
      }

      const completed = db.prepare(`
        UPDATE harvest_shards
        SET status='completed',paper_count=?,finished_at=?,error_message=NULL
        WHERE run_id=? AND shard_key=? AND status='running'
      `).run(papers.length, now(), identity.runId, identity.shardKey);
      if (completed.changes !== 1) throw new Error(`harvest shard is not running: ${identity.runId}/${identity.shardKey}`);
      db.prepare('DELETE FROM harvest_retry_windows WHERE run_id=? AND shard_key=?').run(identity.runId, identity.shardKey);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function failHarvestShard(identity: HarvestShardIdentity, error: unknown) {
    const code = errorField(error, 'code');
    const retryNotBefore = errorField(error, 'retryNotBefore');
    const isCapacityLimited = code === 'ARXIV_CAPACITY_LIMITED'
      && typeof retryNotBefore === 'string' && Number.isFinite(Date.parse(retryNotBefore));
    const rawDiagnostic = errorField(error, 'diagnostic');
    const diagnostic = typeof rawDiagnostic === 'string'
      ? redactErrorMessage({ message: rawDiagnostic }).slice(0, 1024) : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const failed = db.prepare(`
        UPDATE harvest_shards
        SET status='failed',finished_at=?,error_message=?
        WHERE run_id=? AND shard_key=? AND status='running'
      `).run(now(), redactErrorMessage(error), identity.runId, identity.shardKey);
      if (failed.changes === 1 && isCapacityLimited) {
        db.prepare(`
          INSERT INTO harvest_retry_windows(run_id,shard_key,retry_not_before,reason,diagnostic,created_at)
          VALUES(?,?,?,?,?,?)
          ON CONFLICT(run_id,shard_key) DO UPDATE SET
            retry_not_before=excluded.retry_not_before,
            reason=excluded.reason,
            diagnostic=excluded.diagnostic,
            created_at=excluded.created_at
        `).run(identity.runId, identity.shardKey, retryNotBefore, 'ARXIV_CAPACITY_LIMITED', diagnostic, now());
      } else if (failed.changes === 1) {
        db.prepare('DELETE FROM harvest_retry_windows WHERE run_id=? AND shard_key=?').run(identity.runId, identity.shardKey);
      }
      db.exec('COMMIT');
    } catch (caught) {
      try { db.exec('ROLLBACK'); } catch {}
      throw caught;
    }
  }

  function listCompletedHarvestShardKeys(runId: string) {
    return db.prepare(`
      SELECT shard_key FROM harvest_shards
      WHERE run_id=? AND status='completed'
      ORDER BY shard_index,shard_key
    `, columns({ shard_key: textColumn })).all(runId).map((row) => row.shard_key);
  }

  function listHarvestObservations(runId: string, shardKeys?: string[]) {
    if (shardKeys?.length === 0) return [];
    const shardFilter = shardKeys ? ` AND o.shard_key IN (${shardKeys.map(() => '?').join(',')})` : '';
    return db.prepare(`
      SELECT h.track,h.date_mode,o.metadata_json
      FROM harvest_observations o
      JOIN harvest_shards h ON h.run_id=o.run_id AND h.shard_key=o.shard_key
      WHERE o.run_id=? AND h.status='completed'${shardFilter}
      ORDER BY h.shard_index,h.shard_key,o.rowid
    `, observationRow).all(runId, ...(shardKeys ?? [])).map((row) => ({
      track: row.track,
      dateMode: row.date_mode,
      paper: observationPaper(row.metadata_json),
    }));
  }

  function findResumableHarvestRun(kind: string) {
    // Legacy review stops resume through automatic filtering using the original
    // window and checkpoints. Historical review receipts are not consulted.
    return db.prepare(`
      SELECT r.* FROM runs r
      LEFT JOIN run_resume_policies p ON p.run_id=r.run_id
      WHERE r.kind=? AND COALESCE(p.auto_resume,1)=1
        AND (r.status='awaiting_evidence_review' OR (r.status IN ('failed','running','awaiting_local_parse')
        AND EXISTS (SELECT 1 FROM harvest_shards h WHERE h.run_id=r.run_id)))
      ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1
    `, runRow).get(kind);
  }

  function setRunAutoResume(runId: string, autoResume: boolean | undefined) {
    if (autoResume === undefined) return;
    db.prepare(`
      INSERT INTO run_resume_policies(run_id,auto_resume) VALUES(?,?)
      ON CONFLICT(run_id) DO UPDATE SET auto_resume=excluded.auto_resume
    `).run(runId, autoResume ? 1 : 0);
  }

  function startRun(window: RunWindow, kind: string, options: { autoResume?: boolean } = {}): RunWindow & { id: string; kind: string; status: string; replayed?: boolean; resumed?: boolean; startedAt?: string } {
    const existing = findRunByWindow.get(kind, window.from, window.to);
    if (existing?.status === 'completed') {
      setRunAutoResume(existing.run_id, options.autoResume);
      return { id: existing.run_id, kind, from: existing.from_utc, to: existing.to_utc, status: 'completed', replayed: true };
    }
    if (existing) {
      db.prepare('UPDATE runs SET status=?,started_at=?,finished_at=NULL,error_message=NULL WHERE run_id=?').run('running', now(), existing.run_id);
      setRunAutoResume(existing.run_id, options.autoResume);
      return { id: existing.run_id, kind, from: existing.from_utc, to: existing.to_utc, status: 'running', resumed: true };
    }
    const run = { id: randomUUID(), kind, ...window, status: 'running', startedAt: now() };
    db.prepare('INSERT INTO runs(run_id,kind,from_utc,to_utc,status,started_at) VALUES(?,?,?,?,?,?)')
      .run(run.id, run.kind, run.from, run.to, run.status, run.startedAt);
    setRunAutoResume(run.id, options.autoResume);
    return run;
  }

  function completeRunInTransaction(runId: string, expectedStatus: string, lastSuccess: string) {
    if (!Number.isFinite(Date.parse(lastSuccess))) throw new Error('invalid last_success watermark');
    const finishedAt = now();
      const updated = db.prepare('UPDATE runs SET status=?,finished_at=?,error_message=NULL WHERE run_id=? AND status=?')
        .run('completed', finishedAt, runId, expectedStatus);
      if (updated.changes !== 1) throw new Error(`run is not eligible for completion: ${runId}`);
      const current = getSetting.get('last_success')?.value;
      const kind = db.prepare('SELECT kind FROM runs WHERE run_id=?', columns({ kind: textColumn })).get(runId)?.kind;
      if (kind !== 'local_import' && (!current || Date.parse(lastSuccess) > Date.parse(current))) setSetting.run('last_success', lastSuccess);
    return { runId, status: 'completed', finishedAt, lastSuccess: getSetting.get('last_success')?.value ?? null };
  }

  function completeRun(runId: string, expectedStatus: string, lastSuccess: string) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = completeRunInTransaction(runId, expectedStatus, lastSuccess); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function completeEmptyRun(runId: string, lastSuccess: string) {
    return completeRun(runId, 'running', lastSuccess);
  }

  function reserveEvidencePublication(input: { runId: string; publicationId: string; inputSha256: string }, eligibility: 'normal' | 'historical' | 'failed-recovery' = 'normal'): 'reserved' | 'replayed' {
    requireEvidenceText(input.runId, 'runId');
    requireEvidenceText(input.publicationId, 'publicationId');
    requireSha256(input.inputSha256, 'inputSha256');
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT * FROM evidence_publications WHERE run_id=?', evidencePublicationRow).get(input.runId);
      const run = db.prepare('SELECT status FROM runs WHERE run_id=?', columns({ status: textColumn })).get(input.runId);
      if (!run) throw new Error('EVIDENCE_CONFLICT: run does not exist');
      if (run.status === 'failed' && eligibility !== 'failed-recovery' && (!existing || existing.status !== 'reserved')) {
        throw new Error('EVIDENCE_CONFLICT: failed run has no reserved evidence publication');
      }
      if (existing) {
        if (existing.publication_id !== input.publicationId || existing.input_sha256 !== input.inputSha256) {
          throw new Error('EVIDENCE_CONFLICT: run already has a different publication');
        }
        if (existing.status === 'failed') {
          db.prepare(`UPDATE evidence_publications
            SET status='reserved',reserved_at=?,receipt_path=NULL,receipt_sha256=NULL,completed_at=NULL,failed_at=NULL,error_code=NULL
            WHERE run_id=?`).run(now(), input.runId);
          db.exec('COMMIT');
          return 'reserved';
        }
        db.exec('COMMIT');
        return 'replayed';
      }
      if (!['running', 'awaiting_local_parse', 'awaiting_evidence_review'].includes(run.status)
        && !(eligibility === 'historical' && run.status === historicalEvidenceWaitingStatus)
        && !(eligibility === 'failed-recovery' && run.status === 'failed')) {
        throw new Error('EVIDENCE_CONFLICT: run is not eligible for evidence reservation');
      }
      const publication = db.prepare('SELECT run_id FROM evidence_publications WHERE publication_id=?', columns({ run_id: textColumn })).get(input.publicationId);
      if (publication) throw new Error('EVIDENCE_CONFLICT: publication belongs to another run');
      db.prepare(`INSERT INTO evidence_publications(run_id,publication_id,input_sha256,status,reserved_at)
        VALUES(?,?,?,?,?)`).run(input.runId, input.publicationId, input.inputSha256, 'reserved', now());
      db.exec('COMMIT');
      return 'reserved';
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function completeEvidencePublication(input: {
    runId: string;
    publicationId: string;
    receiptPath: string;
    receiptSha256: string;
    lastSuccess: string;
  }, allowHistoricalWikiRun = false): { status: 'completed' } {
    requireEvidenceText(input.runId, 'runId');
    requireEvidenceText(input.publicationId, 'publicationId');
    requireEvidenceText(input.receiptPath, 'receiptPath');
    requireSha256(input.receiptSha256, 'receiptSha256');
    if (!Number.isFinite(Date.parse(input.lastSuccess))) throw new Error('EVIDENCE_CONFLICT: invalid last_success watermark');
    db.exec('BEGIN IMMEDIATE');
    try {
      // The durable receipt is an external boundary. Verify its current bytes before any state write.
      const receipt = readEvidenceReceipt(input.receiptPath, input.receiptSha256);
      const publication = db.prepare('SELECT * FROM evidence_publications WHERE run_id=?', evidencePublicationRow).get(input.runId);
      if (!publication || publication.publication_id !== input.publicationId) throw new Error('EVIDENCE_CONFLICT: publication is not reserved for this run');
      if (receipt.runId !== input.runId || receipt.publicationId !== input.publicationId || receipt.contentSha256 !== publication.input_sha256) {
        throw new Error('EVIDENCE_RECEIPT_CONFLICT: receipt does not match the reserved publication');
      }
      if (publication.status === 'completed') {
        if (publication.receipt_sha256 !== input.receiptSha256 || publication.receipt_path !== input.receiptPath) {
          throw new Error('EVIDENCE_RECEIPT_CONFLICT: completed publication has a different receipt');
        }
        db.exec('COMMIT');
        return { status: 'completed' };
      }
      if (publication.status !== 'reserved') throw new Error('EVIDENCE_CONFLICT: publication is not reserved');
      const run = db.prepare('SELECT status FROM runs WHERE run_id=?', columns({ status: textColumn })).get(input.runId);
      const eligible = run && (['running', 'awaiting_local_parse', 'awaiting_evidence_review'].includes(run.status)
        || (allowHistoricalWikiRun && run.status === historicalEvidenceWaitingStatus)
        || (run.status === 'failed' && publication.status === 'reserved'));
      if (!eligible) throw new Error(`EVIDENCE_CONFLICT: run is not eligible for completion: ${input.runId}`);

      const insertSource = db.prepare(`
        INSERT INTO evidence_publication_sources(
          run_id,base_id,version,archive_manifest_sha256,evidence_manifest_sha256,recorded_at
        ) VALUES(?,?,?,?,?,?)
      `);
      for (const source of receipt.sources) {
        insertSource.run(input.runId, source.baseId, source.version, source.archiveManifestSha256, source.evidenceManifestSha256, now());
      }
      const finishedAt = now();
      const publicationUpdated = db.prepare(`UPDATE evidence_publications
        SET status='completed',receipt_path=?,receipt_sha256=?,completed_at=?,failed_at=NULL,error_code=NULL
        WHERE run_id=? AND publication_id=? AND status='reserved'`).run(
        input.receiptPath, input.receiptSha256, finishedAt, input.runId, input.publicationId,
      );
      if (publicationUpdated.changes !== 1) throw new Error('EVIDENCE_CONFLICT: publication is not reserved');
      const runUpdated = db.prepare(`UPDATE runs SET status='completed',finished_at=?,error_message=NULL
        WHERE run_id=? AND status IN ('running','awaiting_local_parse','awaiting_evidence_review','failed'${allowHistoricalWikiRun ? `,'${historicalEvidenceWaitingStatus}'` : ''})`).run(finishedAt, input.runId);
      if (runUpdated.changes !== 1) throw new Error(`EVIDENCE_CONFLICT: run is not eligible for completion: ${input.runId}`);
      const current = getSetting.get('last_success')?.value;
      const kind = db.prepare('SELECT kind FROM runs WHERE run_id=?', columns({ kind: textColumn })).get(input.runId)?.kind;
      if (kind !== 'local_import' && (!current || Date.parse(input.lastSuccess) > Date.parse(current))) setSetting.run('last_success', input.lastSuccess);
      db.exec('COMMIT');
      return { status: 'completed' };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function failEvidencePublication(input: { runId: string; publicationId: string; errorCode: string }): void {
    requireEvidenceText(input.runId, 'runId');
    requireEvidenceText(input.publicationId, 'publicationId');
    requireEvidenceText(input.errorCode, 'errorCode');
    db.exec('BEGIN IMMEDIATE');
    try {
      const updated = db.prepare(`UPDATE evidence_publications
        SET status='failed',failed_at=?,error_code=?
        WHERE run_id=? AND publication_id=? AND status='reserved'`).run(now(), input.errorCode, input.runId, input.publicationId);
      if (updated.changes !== 1) throw new Error('EVIDENCE_CONFLICT: publication is not reserved');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function findEvidencePublication(runId: string) {
    return db.prepare('SELECT * FROM evidence_publications WHERE run_id=?', evidencePublicationRow).get(runId);
  }

  function listCompletedEvidencePublications(): Array<{
    runId: string;
    publicationId: string;
    inputSha256: string;
    receiptPath: string;
    receiptSha256: string;
    completedAt: string;
    sources: EvidencePublicationSource[];
  }> {
    const publications = db.prepare(`
      SELECT * FROM evidence_publications
      WHERE status='completed'
      ORDER BY completed_at,run_id
    `, evidencePublicationRow).all();
    const listSources = db.prepare(`
      SELECT base_id,version,archive_manifest_sha256,evidence_manifest_sha256
      FROM evidence_publication_sources
      WHERE run_id=?
      ORDER BY base_id,version
    `, evidencePublicationSourceRow);
    return publications.map(publication => {
      if (publication.receipt_path === null || publication.receipt_sha256 === null || publication.completed_at === null) {
        throw new Error('EVIDENCE_CONFLICT: completed publication is incomplete');
      }
      return {
        runId: publication.run_id,
        publicationId: publication.publication_id,
        inputSha256: publication.input_sha256,
        receiptPath: publication.receipt_path,
        receiptSha256: publication.receipt_sha256,
        completedAt: publication.completed_at,
        sources: listSources.all(publication.run_id).map(source => ({
          baseId: source.base_id,
          version: source.version,
          archiveManifestSha256: source.archive_manifest_sha256,
          evidenceManifestSha256: source.evidence_manifest_sha256,
        })),
      };
    });
  }

  function listRunsByStatus(status: string) {
    return db.prepare('SELECT * FROM runs WHERE status=? ORDER BY started_at, run_id', runRow).all(status);
  }

  function assertParseAttemptCurrent(attemptId: string) {
    const attempt = db.prepare('SELECT rowid AS sequence,* FROM parse_attempts WHERE attempt_id=?', sequencedParseRow).get(attemptId);
    if (!attempt || !['pending', 'running'].includes(attempt.status)) throw new Error('parse attempt is inactive or stale');
    const paper = db.prepare('SELECT version,sha256 FROM papers WHERE base_id=?', columns({ version: integerColumn, sha256: nullableText })).get(attempt.base_id);
    const newer = db.prepare(`SELECT 1 FROM parse_attempts WHERE base_id=? AND model=? AND rowid>?
      AND status IN ('pending','running','succeeded') LIMIT 1`, existenceRow).get(attempt.base_id, attempt.model, attempt.sequence);
    if (newer || !paper || paper.version !== attempt.version || (paper.sha256 && paper.sha256 !== attempt.sha256)) {
      throw new Error('parse attempt superseded：禁止旧版本或旧解析覆盖当前结果');
    }
    return attempt;
  }

  const researchState = createResearchStateApi(db, options.readOnly);
  function getResearchRun(runId: string): ResearchRun | undefined {
    const row = db.prepare('SELECT * FROM runs WHERE run_id=?', runRow).get(runId);
    if (!row || !['research_current', 'research_weekly', 'research_backfill'].includes(row.kind)) return undefined;
    return { id: row.run_id, kind: row.kind as ResearchRun['kind'], from: row.from_utc, to: row.to_utc, status: row.status, startedAt: row.started_at };
  }
  function researchWorkflowTransaction<T>(work: () => T): T {
    if (options.readOnly) throw new Error('research state is read-only');
    db.exec('BEGIN IMMEDIATE');
    try { const value = work(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function getResearchRunCheckpoint(runId: string): { requestSha256: string; selectionSha256: string | null } | undefined {
    const raw = getSetting.get(`research_checkpoint:${runId}`)?.value;
    if (!raw) return undefined;
    const value = JSON.parse(raw);
    requireSha256(value.requestSha256, 'research request hash');
    if (value.selectionSha256 !== null) requireSha256(value.selectionSha256, 'research selection hash');
    if (canonicalJson(value) !== raw) throw new Error('RESEARCH_RESUME_CONFLICT');
    return value;
  }

  return {
    ...researchState,
    getResearchRun,
    getResearchRunCheckpoint,
    bindResearchRunCheckpoint(runId: string, requestSha256: string, selectionSha256?: string) {
      requireSha256(requestSha256, 'research request hash');
      if (selectionSha256 !== undefined) requireSha256(selectionSha256, 'research selection hash');
      researchWorkflowTransaction(() => {
        if (!getResearchRun(runId)) throw new Error('RESEARCH_RESUME_CONFLICT');
        const previous = getResearchRunCheckpoint(runId);
        if (previous && (previous.requestSha256 !== requestSha256 || (previous.selectionSha256 && previous.selectionSha256 !== selectionSha256))) throw new Error('RESEARCH_RESUME_CONFLICT');
        setSetting.run(`research_checkpoint:${runId}`, canonicalJson({ requestSha256, selectionSha256: selectionSha256 ?? previous?.selectionSha256 ?? null }));
      });
    },
    resumeResearchRun(runId: string, window: RunWindow, mode: ResearchRunMode): ResearchRun {
      return researchWorkflowTransaction(() => {
        const run = getResearchRun(runId);
        if (!run || run.kind !== `research_${mode}` || run.from !== sourceDate(window.from) || run.to !== sourceDate(window.to)
          || !['running', 'failed', 'awaiting_evidence', 'completed'].includes(run.status)) throw new Error('RESEARCH_RESUME_CONFLICT');
        if (run.status !== 'completed') db.prepare("UPDATE runs SET status='running',finished_at=NULL,error_message=NULL WHERE run_id=?").run(runId);
        return { ...run, status: run.status === 'completed' ? 'completed' : 'running', resumed: true };
      });
    },
    awaitResearchEvidence(runId: string) {
      researchWorkflowTransaction(() => {
        if (getResearchRun(runId)?.status !== 'running') throw new Error('RESEARCH_STATE_CONFLICT');
        db.prepare("UPDATE runs SET status='awaiting_evidence',error_message=NULL WHERE run_id=?").run(runId);
      });
    },
    completeResearchWorkflowRun(runId: string, selectionSha256: string, expected: ResearchEvidenceSource[]) {
      researchWorkflowTransaction(() => {
        const run = getResearchRun(runId), binding = getResearchRunCheckpoint(runId);
        const publication = researchState.findResearchEvidencePublication(runId);
        const sources = researchState.listResearchEvidenceSources(runId);
        if (!run || binding?.selectionSha256 !== selectionSha256 || publication?.status !== 'completed'
          || publication.inputSha256 !== selectionSha256 || canonicalJson(sources) !== canonicalJson(expected)
          || db.prepare("SELECT 1 FROM research_shards WHERE run_id=? AND status!='completed'").get(runId)) throw new Error('RESEARCH_PUBLICATION_INCOMPLETE');
        db.prepare("UPDATE runs SET status='completed',finished_at=COALESCE(finished_at,?),error_message=NULL WHERE run_id=?").run(now(), runId);
        const current = getSetting.get('last_success')?.value;
        if (run.kind !== 'research_backfill' && (!current || Date.parse(run.to) > Date.parse(current))) setSetting.run('last_success', run.to);
      });
    },
    startLocalImportRun(batchKey: string, { force = false }: { force?: boolean } = {}) {
      const key = `local_import_batch:${batchKey}`;
      db.exec('BEGIN IMMEDIATE');
      try {
        const id = !force && getSetting.get(key)?.value;
        const existing = id && db.prepare('SELECT * FROM runs WHERE run_id=?', runRow).get(id);
        if (existing) {
          const status = existing.status === 'completed' ? 'completed' : 'running';
          if (status === 'running') db.prepare('UPDATE runs SET status=?,started_at=?,finished_at=NULL,error_message=NULL WHERE run_id=?').run(status, now(), id);
          db.exec('COMMIT');
          return { id, status, kind: 'local_import', from: existing.from_utc, to: existing.to_utc, resumed: true };
        }
        const stamp = now(); const runId = randomUUID();
        db.prepare('INSERT INTO runs(run_id,kind,from_utc,to_utc,status,started_at) VALUES(?,?,?,?,?,?)').run(runId, 'local_import', stamp, stamp, 'running', stamp);
        setSetting.run(key, runId);
        db.exec('COMMIT');
        return { id: runId, kind: 'local_import', from: stamp, to: stamp, status: 'running' };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    findLocalImportRun(batchKey: string) {
      const id = getSetting.get(`local_import_batch:${batchKey}`)?.value;
      return id ? db.prepare('SELECT * FROM runs WHERE run_id=?', runRow).get(id) : undefined;
    },
    upsertDiscovered(paper: StoredPaperInput) {
      upsertDiscoveredPaper(paper);
    },
    upsertSourceMetadata(metadata: StoredSourceMetadataV1) { persistSourceMetadata(metadata); },
    findSourceMetadata(baseId: string, version: number) {
      const row = db.prepare(`
        SELECT metadata_json FROM paper_source_metadata WHERE base_id=? AND version=?
      `, sourceMetadataJsonRow).get(baseId, version);
      return row ? deserializeSourceMetadata(row.metadata_json) : undefined;
    },
    findByBaseId(id: string) { return db.prepare('SELECT * FROM papers WHERE base_id=?', paperRow).get(id); },
    findBySha256(hash: string) { return db.prepare('SELECT * FROM papers WHERE sha256=?', paperRow).get(hash); },
    markExcluded(id: string, reason: string, version: number) {
      return db.prepare('UPDATE papers SET status=?,exclusion_reason=?,updated_at=? WHERE base_id=? AND version=?')
        .run('excluded', reason, now(), id, version).changes;
    },
    markDownloaded(id: string, pdfPath: string, track: string | null, sha256: string, version?: number) {
      const downloadedVersion = version ?? db.prepare('SELECT version FROM papers WHERE base_id=?', columns({ version: integerColumn })).get(id)?.version;
      if (downloadedVersion === undefined) throw new TypeError('paper version is required');
      db.exec('BEGIN IMMEDIATE');
      try {
        const changed = db.prepare('UPDATE papers SET status=?,pdf_path=?,primary_track=?,sha256=?,downloaded_version=?,processing_error=NULL,updated_at=? WHERE base_id=? AND version=?')
          .run('downloaded', pdfPath, track, sha256, downloadedVersion, now(), id, downloadedVersion).changes;
        if (changed !== 1) throw new Error('stale version：下载期间版本已变化，拒绝提交旧版本');
        db.prepare('UPDATE paper_versions SET sha256=? WHERE base_id=? AND version=?').run(sha256, id, downloadedVersion);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    updatePdfPath(id: string, path: string) { db.prepare('UPDATE papers SET pdf_path=?,updated_at=? WHERE base_id=?').run(path, now(), id); },
    /** Record parse completion without writing or overwriting a semantic paper note. */
    markParsedStatus(id: string) {
      return db.prepare("UPDATE papers SET status='parsed',processing_error=NULL,updated_at=? WHERE base_id=? AND status IN ('downloaded','parse_failed','parsed')").run(now(), id).changes;
    },
    markParseFailed(id: string, error: unknown) { db.prepare('UPDATE papers SET status=?,processing_error=?,updated_at=? WHERE base_id=?').run('parse_failed', String(error), now(), id); },
    startRun(window: RunWindow, kind: string, options?: { autoResume?: boolean }) { return startRun(window, kind, options); },
    failRun(id: string, message: string) { db.prepare('UPDATE runs SET status=?,finished_at=?,error_message=? WHERE run_id=?').run('failed', now(), message, id); },
    beginHarvestShard(input: HarvestShardInput) { return beginHarvestShard(input); },
    completeHarvestShard(identity: HarvestShardIdentity, papers: PaperMetadata[]) { completeHarvestShard(identity, papers); },
    failHarvestShard(identity: HarvestShardIdentity, error: unknown) { failHarvestShard(identity, error); },
    listCompletedHarvestShardKeys(runId: string) { return listCompletedHarvestShardKeys(runId); },
    listHarvestObservations(runId: string, shardKeys?: string[]) { return listHarvestObservations(runId, shardKeys); },
    findResumableHarvestRun(kind: string) { return findResumableHarvestRun(kind); },
    recordLocalParseManifest<T>(runId: string, manifest: { jobs?: T[] } | null) {
      db.prepare(`UPDATE runs SET status='running' WHERE run_id=? AND status IN ('running','awaiting_local_parse')`).run(runId);
      return manifest?.jobs ?? [];
    },
    completeRun(runId: string, expectedStatus: string, lastSuccess: string) { return completeRun(runId, expectedStatus, lastSuccess); },
    reserveEvidencePublication(input: { runId: string; publicationId: string; inputSha256: string }) { return reserveEvidencePublication(input); },
    /** Migration-only escape hatch; normal FSD code cannot complete retired Wiki waiting runs. */
    reserveHistoricalEvidencePublication(input: { runId: string; publicationId: string; inputSha256: string }) { return reserveEvidencePublication(input, 'historical'); },
    reserveFailedEvidencePublication(input: { runId: string; publicationId: string; inputSha256: string }) { return reserveEvidencePublication(input, 'failed-recovery'); },
    completeEvidencePublication(input: { runId: string; publicationId: string; receiptPath: string; receiptSha256: string; lastSuccess: string }) { return completeEvidencePublication(input); },
    /** Migration-only escape hatch; receipt verification still precedes the status transition. */
    completeHistoricalEvidencePublication(input: { runId: string; publicationId: string; receiptPath: string; receiptSha256: string; lastSuccess: string }) { return completeEvidencePublication(input, true); },
    failEvidencePublication(input: { runId: string; publicationId: string; errorCode: string }) { failEvidencePublication(input); },
    findEvidencePublication(runId: string) { return findEvidencePublication(runId); },
    listCompletedEvidencePublications() { return listCompletedEvidencePublications(); },
    getLibraryLayoutMigration() {
      return db.prepare('SELECT library_id,source_sha256,history_sha256,rewritten_cells FROM library_layout_migrations WHERE layout_version=2',
        columns({ library_id: textColumn, source_sha256: textColumn, history_sha256: textColumn, rewritten_cells: integerColumn })).get();
    },
    getPublicationBaseline() {
      // Inspection of databases predating this migration must remain read-only.
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evidence_publication_baseline'", existenceRow).get()) return null;
      return db.prepare('SELECT sha256,canonical_json FROM evidence_publication_baseline WHERE singleton=1',
        columns({ sha256: textColumn, canonical_json: textColumn })).get() ?? null;
    },
    /** Offline maintenance only: immutable insert, with a transaction-bound history check. */
    installPublicationBaseline(input: { sha256: string; canonicalJson: string; completedHistoryJson: string; libraryId?: string }) {
      if (options.readOnly) throw new Error('EVIDENCE_CONFLICT: read-only baseline store');
      requireSha256(input.sha256, 'baseline sha256');
      const { sha256: digest, ...body } = JSON.parse(input.canonicalJson);
      // The evidence module validates canonical structure; bind the exact approved payload here too.
      if (digest !== input.sha256 || hashCanonical(body) !== digest || canonicalJson({ ...body, sha256: digest }) !== input.canonicalJson) {
        throw new Error('EVIDENCE_CONFLICT: baseline identity differs');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const completedHistory = listCompletedEvidencePublications();
        if (JSON.stringify(completedHistory) !== input.completedHistoryJson) throw new Error('EVIDENCE_CONFLICT: baseline history drift');
        if (body.kind === 'archive-v2-publication-baseline') {
          const provenance = db.prepare('SELECT library_id,source_sha256,history_sha256,rewritten_cells FROM library_layout_migrations WHERE layout_version=2',
            columns({ library_id: textColumn, source_sha256: textColumn, history_sha256: textColumn, rewritten_cells: integerColumn })).get();
          if (!provenance || canonicalJson(provenance) !== canonicalJson(body.migration)) throw new Error('EVIDENCE_CONFLICT: baseline provenance drift');
        } else if (body.kind === 'evidence-v3-renderer-upgrade-baseline') {
          if (!input.libraryId || body.libraryId !== input.libraryId
            || !/^[a-z][a-z0-9-]{1,31}$/.test(input.libraryId)) throw new Error('EVIDENCE_CONFLICT: renderer baseline library drift');
          const keys = Object.keys({ ...body, sha256: digest }).sort().join('\0');
          if (keys !== ['kind', 'libraryId', 'publications', 'schemaVersion', 'sha256', 'vaultPlanSha256'].join('\0')
            || body.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(body.vaultPlanSha256)
            || !Array.isArray(body.publications) || body.publications.length !== completedHistory.length) {
            throw new Error('EVIDENCE_CONFLICT: renderer baseline history identity differs');
          }
          for (let index = 0; index < completedHistory.length; index++) {
            const { receiptPath: _, ...original } = completedHistory[index]!;
            const entry = body.publications[index];
            if (!entry || entry.original?.runId !== original.runId
              || canonicalJson(entry.original) !== canonicalJson(original)
              || entry.projection?.publisherVersion !== 3 || entry.projection.runId !== original.runId) {
              throw new Error('EVIDENCE_CONFLICT: renderer baseline history identity differs');
            }
          }
        } else {
          throw new Error('EVIDENCE_CONFLICT: unsupported baseline kind');
        }
        const existing = db.prepare('SELECT sha256,canonical_json FROM evidence_publication_baseline WHERE singleton=1',
          columns({ sha256: textColumn, canonical_json: textColumn })).get();
        if (existing && (existing.sha256 !== input.sha256 || existing.canonical_json !== input.canonicalJson)) throw new Error('EVIDENCE_CONFLICT: baseline already installed');
        if (!existing) db.prepare('INSERT INTO evidence_publication_baseline(singleton,sha256,canonical_json) VALUES(1,?,?)').run(input.sha256, input.canonicalJson);
        db.exec('COMMIT');
        return { replayed: !!existing, sha256: input.sha256 };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    completeEmptyRun(runId: string, lastSuccess: string) { return completeEmptyRun(runId, lastSuccess); },
    getLastSuccess() { return getSetting.get('last_success')?.value ?? null; },
    getRun(id: string) { return db.prepare('SELECT * FROM runs WHERE run_id=?', runRow).get(id); },
    listRunsByStatus(status: string) { return listRunsByStatus(status); },
    reserveParseAttempt(input: ParseAttemptInput, options: { force?: boolean; staleAfterMs?: number; startedAt?: string } = {}) {
      const identity = {
        baseId: input.baseId,
        version: input.version,
        sha256: input.sha256,
        model: input.model,
        method: input.method ?? 'auto',
      };
      const staleAfterMs = typeof options.staleAfterMs === 'number' && Number.isFinite(options.staleAfterMs) ? Math.max(0, options.staleAfterMs) : 60 * 60 * 1000;
      const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        if (options.force !== true) {
          db.prepare(`
            UPDATE parse_attempts SET status='failed', error_class='stale_reclaimed',
              error_message='stale parse attempt reclaimed', finished_at=?
            WHERE base_id=? AND version=? AND sha256=? AND model=? AND method=?
              AND status IN ('pending','running') AND started_at < ?
          `).run(now(), identity.baseId, identity.version, identity.sha256, identity.model, identity.method, staleBefore);
          const existing = db.prepare(`
            SELECT * FROM parse_attempts
            WHERE base_id=? AND version=? AND sha256=? AND model=? AND method=?
              AND status IN ('pending','running','succeeded')
            ORDER BY started_at DESC, rowid DESC
            LIMIT 1
          `, parseRow).get(identity.baseId, identity.version, identity.sha256, identity.model, identity.method);
          if (existing) {
            db.exec('COMMIT');
            return null;
          }
        }
        const attemptId = randomUUID();
        const startedAt = options.startedAt ?? now();
        db.prepare(`
          INSERT INTO parse_attempts(
            attempt_id,base_id,version,sha256,model,cli_backend,method,status,
            source_path,output_dir,started_at
          ) VALUES(:attemptId,:baseId,:version,:sha256,:model,:cliBackend,:method,'pending',
            :sourcePath,:outputDir,:startedAt)
        `).run({
          attemptId,
          baseId: identity.baseId,
          version: identity.version,
          sha256: identity.sha256,
          model: identity.model,
          cliBackend: input.cliBackend,
          method: identity.method,
          sourcePath: input.sourcePath ?? input.fileSource ?? null,
          outputDir: input.outputDir ?? null,
          startedAt,
        });
        db.exec('COMMIT');
        return parseAttemptRow(db.prepare('SELECT * FROM parse_attempts WHERE attempt_id=?', parseRow).get(attemptId));
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
    startParseAttempt(attemptId: string) {
      db.prepare(`
        UPDATE parse_attempts SET status='running', started_at=?
        WHERE attempt_id=? AND status='pending'
      `).run(now(), attemptId);
      return parseAttemptRow(db.prepare('SELECT * FROM parse_attempts WHERE attempt_id=?', parseRow).get(attemptId));
    },
    finishParseAttempt(attemptId: string, artifacts: ParseArtifacts = {}) {
      db.exec('BEGIN IMMEDIATE');
      try {
      const currentAttempt = assertParseAttemptCurrent(attemptId);
      if (artifacts.archivePdfPath !== undefined) {
        if (typeof artifacts.archivePdfPath !== 'string' || !isAbsolute(artifacts.archivePdfPath)
          || !artifacts.outputDir || !isAbsolute(artifacts.outputDir)
          || artifacts.archivePdfPath !== artifacts.sourcePath
          || resolve(artifacts.archivePdfPath) !== resolve(artifacts.outputDir, 'source.pdf')) {
          throw new Error('invalid installed Archive PDF identity');
        }
        const adopted = db.prepare(`UPDATE papers SET pdf_path=?,status='parsed',processing_error=NULL,
          sha256=COALESCE(sha256,?),downloaded_version=?,updated_at=?
          WHERE base_id=? AND version=? AND (sha256 IS NULL OR sha256=?)`)
          .run(artifacts.archivePdfPath, currentAttempt.sha256, currentAttempt.version, now(),
            currentAttempt.base_id, currentAttempt.version, currentAttempt.sha256).changes;
        if (adopted !== 1) throw new Error('installed Archive PDF is stale');
      }
      if (artifacts.previousOutputDir && artifacts.archivedOutputDir) {
        const from = artifacts.previousOutputDir.replaceAll('\\', '/');
        const to = artifacts.archivedOutputDir.replaceAll('\\', '/');
        const relocate = (value: string | null) => {
          const normalized = value?.replaceAll('\\', '/');
          return normalized === from || normalized?.startsWith(`${from}/`) ? `${to}${normalized.slice(from.length)}` : value;
        };
        for (const row of db.prepare('SELECT * FROM parse_attempts WHERE status=\'succeeded\'', parseRow).all()) {
          if (relocate(row.output_dir) === row.output_dir) continue;
          db.prepare('UPDATE parse_attempts SET output_dir=?,markdown_path=?,content_list_path=?,page_text_path=? WHERE attempt_id=?')
            .run(relocate(row.output_dir), relocate(row.markdown_path), relocate(row.content_list_path), relocate(row.page_text_path), row.attempt_id);
        }
      }
      const changed = db.prepare(`
        UPDATE parse_attempts SET
          source_path=COALESCE(?, source_path), output_dir=COALESCE(?, output_dir),
          markdown_path=COALESCE(?, markdown_path), content_list_path=COALESCE(?, content_list_path),
          page_text_path=COALESCE(?, page_text_path), page_count=COALESCE(?, page_count),
          elapsed_ms=COALESCE(?, elapsed_ms), exit_code=COALESCE(?, exit_code),
          error_class=NULL, error_message=NULL, status='succeeded', finished_at=?
        WHERE attempt_id=? AND status IN ('pending','running')
      `).run(
        artifacts.sourcePath ?? artifacts.fileSource ?? null,
        artifacts.outputDir ?? null,
        artifacts.markdownPath ?? null,
        artifacts.contentListPath ?? null,
        artifacts.pageTextPath ?? null,
        artifacts.pageCount ?? null,
        artifacts.elapsedMs ?? null,
        artifacts.exitCode ?? 0,
        now(),
        attemptId,
      ).changes;
      if (changed !== 1) throw new Error('parse attempt is inactive or stale');
      db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return parseAttemptRow(db.prepare('SELECT * FROM parse_attempts WHERE attempt_id=?', parseRow).get(attemptId));
    },
    assertParseAttemptCurrent,
    failParseAttempt(attemptId: string, error: unknown) {
      const errorClass = String(errorField(error, 'errorClass') ?? 'process_error');
      const errorMessage = redactErrorMessage(error);
      db.prepare(`
        UPDATE parse_attempts SET
          status='failed', error_class=?, error_message=?, exit_code=?, finished_at=?
        WHERE attempt_id=? AND status IN ('pending','running')
      `).run(errorClass, errorMessage, nullableInteger(errorField(error, 'exitCode') ?? null, 'exit_code'), now(), attemptId);
      return parseAttemptRow(db.prepare('SELECT * FROM parse_attempts WHERE attempt_id=?', parseRow).get(attemptId));
    },
    findParseAttempt(identity: ParseIdentity) {
      return parseAttemptRow(db.prepare(`
        SELECT * FROM parse_attempts
        WHERE base_id=? AND version=? AND sha256=? AND model=? AND method=?
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1
      `, parseRow).get(identity.baseId, identity.version, identity.sha256, identity.model, identity.method ?? 'auto'));
    },
    findSuccessfulParse(identityOrBaseId: ParseIdentity | string, model?: string) {
      if (identityOrBaseId && typeof identityOrBaseId === 'object') {
        return parseAttemptRow(db.prepare(`
          SELECT * FROM parse_attempts
          WHERE base_id=? AND version=? AND sha256=? AND model=? AND method=? AND status='succeeded'
          ORDER BY finished_at DESC, started_at DESC, rowid DESC
          LIMIT 1
        `, parseRow).get(identityOrBaseId.baseId, identityOrBaseId.version, identityOrBaseId.sha256, identityOrBaseId.model, identityOrBaseId.method ?? 'auto'));
      }
      if (model === undefined) throw new TypeError('parse model is required');
      return parseAttemptRow(db.prepare(`
        SELECT * FROM parse_attempts
        WHERE base_id=? AND model=? AND status='succeeded'
        ORDER BY finished_at DESC, started_at DESC, rowid DESC
        LIMIT 1
      `, parseRow).get(identityOrBaseId, model));
    },
    hasSuccessfulParse(identityOrBaseId: ParseIdentity | string) {
      if (identityOrBaseId && typeof identityOrBaseId === 'object') {
        return db.prepare(`
          SELECT 1 FROM parse_attempts
          WHERE base_id=? AND version=? AND sha256=? AND model=? AND method=? AND status='succeeded'
          LIMIT 1
        `, existenceRow).get(identityOrBaseId.baseId, identityOrBaseId.version, identityOrBaseId.sha256, identityOrBaseId.model, identityOrBaseId.method ?? 'auto') !== undefined;
      }
      return db.prepare(`
        SELECT 1 FROM parse_attempts
        WHERE base_id=? AND status='succeeded'
        LIMIT 1
      `, existenceRow).get(identityOrBaseId) !== undefined;
    },
    exportManifest() { return db.prepare('SELECT * FROM papers ORDER BY base_id', paperRow).all(); },
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}

export type StateStore = ReturnType<typeof openStateStore>;
