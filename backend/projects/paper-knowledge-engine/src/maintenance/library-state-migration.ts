import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { canonicalJson } from '../shared/manifest.ts';
import { parsePublicationReceipt } from '../evidence/receipt-store.ts';
import { archivePath, assertRealPath, pathIdentity, realTree, verifyArchiveV2 } from '../shared/archive-v2.ts';
import { safeMkdir } from '../mineru/archive-writer.ts';
import { assertLibraryId, type LibraryId } from '../shared/identity.ts';
import type { LibraryPaths } from '../shared/paths.ts';
import { fingerprint, validateOperationRecord } from '../library/operations/operation-store.ts';
import { validateRequest } from '../library/operations/operation-contracts.ts';
import { createArchiveMigrationPlan } from './archive-migration.ts';
import { LEGACY_PROJECT_ID as oldProjectId } from '../shared/historical-compatibility.ts';

type Paths = Pick<LibraryPaths, 'dataRoot' | 'databasePath' | 'archiveRoot' | 'runsRoot' | 'operationsRoot' | 'workRoot'>;
export interface LibraryStateInput {
  legacyStateRoot: string;
  legacyPdfRoot: string;
  paths: Paths;
  libraryId: LibraryId;
  /** Explicit extra roots for historical code/Vault paths; never inferred from a submitted plan. */
  pathRewrites?: { from: string; to: string }[];
}
type CellChange = { table: string; rowid: number; column: string; before: string; after: string };
type Mapping = { from: string; to: string };
export interface LibraryStatePlan extends LibraryStateInput {
  schemaVersion: 1;
  sha256: string;
  archivePlanSha256: string;
  database: { sourceSha256: string; targetContentSha256: string; changes: CellChange[] };
  directories: string[];
  files: { sourcePath: string; targetPath: string; sourceSha256: string; sha256: string; bytes: number }[];
  counts: { rewrittenDatabaseCells: number; databaseCellsByColumn: Record<string, number>; operations: number; runFiles: number; receipts: number };
}
export interface LibraryStateResult {
  planSha256: string;
  replayed: boolean;
  rewrittenDatabaseCells: number;
  operations: number;
  oldPathOccurrences: number;
  oldProjectIdOccurrences: number;
  libraryIds: LibraryId[];
  integrityCheck: 'ok';
  foreignKeyViolations: number;
}
interface ApplyInput extends LibraryStateInput {
  planFile: string;
  planSha256: string;
  /** Atomic rename seam, also used to exercise installation rollback. */
  install?: (source: string, destination: string) => Promise<void>;
}
const hash = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
const fail = (code: string, message: string): never => { throw new Error(`${code}: ${message}`); };
const info = (path: string) => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const slash = (path: string) => path.replaceAll('\\', '/');
const key = (path: string) => slash(path).toLowerCase();
const sqlPath = new URL('../../migrations/009-library-layout-v2.sql', import.meta.url);

function absolute(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) return fail('MIGRATION_PATH_UNSAFE', 'absolute path required');
  archivePath(slash(path.slice(parse(path).root.length)));
  return resolve(path);
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}
async function prospective(path: string): Promise<void> {
  const s = await info(path);
  if (!s) {
    const parent = dirname(path);
    if (parent === path) fail('MIGRATION_PATH_UNSAFE', 'missing filesystem root');
    return prospective(parent);
  }
  await assertRealPath(path);
  if (!s.isDirectory()) fail('MIGRATION_PATH_UNSAFE', 'expected directory: ' + path);
}
async function roots(input: LibraryStateInput): Promise<LibraryStateInput> {
  assertLibraryId(input.libraryId);
  const legacyStateRoot = absolute(input.legacyStateRoot), legacyPdfRoot = absolute(input.legacyPdfRoot);
  const paths = Object.fromEntries(Object.entries(input.paths).filter(([name]) =>
    ['dataRoot','databasePath','archiveRoot','runsRoot','operationsRoot','workRoot'].includes(name)).map(([name, value]) => [name, absolute(value)])) as Paths;
  for (const [field, part] of Object.entries({ databasePath: 'library.sqlite', archiveRoot: 'archive', runsRoot: 'runs', operationsRoot: 'operations', workRoot: 'work' })) {
    if (paths[field as keyof Paths] !== join(paths.dataRoot, part)) fail('MIGRATION_PATH_UNSAFE', 'targets must be derived LibraryPaths');
  }
  for (const old of [legacyStateRoot, legacyPdfRoot]) {
    if (within(old, paths.dataRoot) || within(paths.dataRoot, old)) fail('MIGRATION_PATH_UNSAFE', 'source and destination overlap');
  }
  await assertRealPath(legacyStateRoot);
  const sourceNames = await readdir(legacyStateRoot);
  if (new Set(sourceNames.map(name => name.toLowerCase())).size !== sourceNames.length) {
    fail('MIGRATION_INVALID_SOURCE', 'case-colliding state root entries');
  }
  if (await info(join(legacyStateRoot, 'library.sqlite'))) fail('MIGRATION_DATABASE_CONFLICT', 'source also contains library.sqlite');
  await prospective(paths.dataRoot);
  for (const name of ['runsRoot','operationsRoot','workRoot','archiveRoot'] as const) await prospective(paths[name]);
  const pathRewrites = (input.pathRewrites ?? []).map(m => ({ from: absolute(m.from), to: absolute(m.to) }))
    .sort((a, b) => key(a.from).localeCompare(key(b.from)));
  if (new Set(pathRewrites.map(m => key(m.from))).size !== pathRewrites.length) fail('MIGRATION_PATH_UNSAFE', 'duplicate mapping');
  return { legacyStateRoot, legacyPdfRoot, paths, libraryId: input.libraryId, pathRewrites };
}
async function regular(path: string): Promise<Buffer> {
  await assertRealPath(path);
  const identity = await pathIdentity(path);
  if (!(await lstat(path)).isFile()) fail('MIGRATION_PATH_UNSAFE', 'expected file: ' + path);
  const bytes = await readFile(path);
  if (await pathIdentity(path) !== identity) fail('MIGRATION_PLAN_DRIFT', 'file replaced during read');
  return bytes;
}
async function idleDatabase(path: string): Promise<Buffer> {
  for (const suffix of ['-wal','-shm','-journal']) if (await info(path + suffix)) {
    fail('MIGRATION_STATE_BUSY', 'stop writers and checkpoint SQLite before migration');
  }
  return regular(path);
}
/** Deserialize a checkpointed snapshot entirely in memory. The original WAL
 * header is switched to rollback mode only in this private byte copy. */
function memoryDatabase(bytes: Buffer): Database {
  const snapshot = Buffer.from(bytes);
  if (snapshot.subarray(0, 16).toString() !== 'SQLite format 3\0') fail('MIGRATION_INVALID_SOURCE', 'not a SQLite database');
  snapshot[18] = 1; snapshot[19] = 1;
  return Database.deserialize(snapshot, { strict: true });
}
function checkDatabase(db: Database): void {
  const integrity = db.query('PRAGMA integrity_check').all();
  if (canonicalJson(integrity) !== canonicalJson([{ integrity_check: 'ok' }])) fail('MIGRATION_INVALID_SOURCE', 'integrity_check failed');
  if (db.query('PRAGMA foreign_key_check').all().length) fail('MIGRATION_INVALID_SOURCE', 'foreign_key_check failed');
}
function tables(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(x => x.name);
}
function contentHash(db: Database): string {
  const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const rows = tables(db).map(name => ({ name, rows: db.query(`SELECT rowid AS _migration_rowid_,* FROM ${quoted(name)} ORDER BY rowid`).all() }));
  return hash(canonicalJson({ schema, rows }));
}
function transformer(mappings: Mapping[], libraryId: LibraryId, normalizeTarget = (path: string) => path) {
  const sorted = [...mappings].sort((a, b) => b.from.length - a.from.length);
  const rewriteString = (value: string): string => {
    // Whole paths get component-aware replacement. Normalize separators only
    // when a mapping matches, preserving unrelated prose and identifiers.
    const normalized = slash(value);
    const match = sorted.find(m => key(normalized) === key(m.from) || key(normalized).startsWith(key(m.from) + '/'));
    if (match) {
      try { absolute(value); }
      catch (error) { throw new Error('MIGRATION_PATH_UNSAFE: invalid rooted path', { cause: error }); }
      return normalizeTarget(join(match.to, ...normalized.slice(slash(match.from).length).split('/').filter(Boolean)));
    }
    return normalizeTarget(value);
  };
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') return rewriteString(value);
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== 'object') return value;
    const source = value as Record<string, unknown>;
    if (Object.hasOwn(source, 'projectId') && source.projectId !== oldProjectId) fail('MIGRATION_INVALID_SOURCE', 'unknown project identity');
    if (Object.hasOwn(source, 'libraryId') && source.libraryId !== libraryId) fail('MIGRATION_INVALID_SOURCE', 'conflicting library identity');
    const result: Record<string, unknown> = Object.create(null);
    for (const [name, item] of Object.entries(source)) result[name === 'projectId' ? 'libraryId' : name] = name === 'projectId' ? libraryId : rewrite(item);
    return result;
  };
  const text = (value: string): string => {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') {
      const next = rewrite(parsed); return canonicalJson(next) === canonicalJson(parsed) ? value : canonicalJson(next);
    } } catch (error) { if (String(error).includes('MIGRATION_')) throw error; }
    return rewriteString(value);
  };
  return { rewrite, text };
}
function remaining(value: unknown, mappings: Mapping[]): void {
  if (typeof value === 'string') {
    if (mappings.some(m => key(value) === key(m.from) || key(value).startsWith(key(m.from) + '/'))) {
      fail('MIGRATION_INVALID_SOURCE', 'unmapped rooted path remains');
    }
    return;
  }
  if (Array.isArray(value)) { for (const item of value) remaining(item, mappings); return; }
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, 'projectId')) fail('MIGRATION_INVALID_SOURCE', 'old project identity remains');
    for (const item of Object.values(value)) remaining(item, mappings);
  }
}
function databaseChanges(db: Database, transform: ReturnType<typeof transformer>, mappings: Mapping[]): CellChange[] {
  const changes: CellChange[] = [];
  for (const table of tables(db)) {
    if (table === 'library_layout_migrations') continue;
    const rows = db.query(`SELECT rowid AS _migration_rowid_,* FROM ${quoted(table)} ORDER BY rowid`).all() as Record<string, unknown>[];
    for (const row of rows) for (const [column, before] of Object.entries(row)) {
      if (typeof before !== 'string') continue;
      const after = transform.text(before);
      remaining(after, mappings);
      if (before !== after) changes.push({ table, rowid: Number(row._migration_rowid_), column, before, after });
    }
  }
  return changes;
}
/** Inspect actual rows, including provenance-trigger side effects. Planned
 * replacements and precomputed hashes are not evidence that these rows are clean. */
function assertNoDatabaseResidue(db: Database, mappings: Mapping[]): void {
  const hasResidue = (value: unknown): boolean => {
    if (typeof value === 'string') {
      if (value === oldProjectId || mappings.some(m => key(value) === key(m.from) || key(value).startsWith(key(m.from) + '/'))) return true;
      let decoded: unknown;
      try { decoded = JSON.parse(value); } catch { return false; }
      return decoded !== value && hasResidue(decoded);
    }
    if (Array.isArray(value)) return value.some(hasResidue);
    return !!value && typeof value === 'object' && (Object.hasOwn(value, 'projectId') || Object.values(value).some(hasResidue));
  };
  for (const table of tables(db)) {
    for (const row of db.query(`SELECT * FROM ${quoted(table)}`).all() as Record<string, unknown>[]) {
      for (const [column, value] of Object.entries(row)) if (typeof value === 'string' && hasResidue(value)) {
        fail('MIGRATION_DATABASE_RESIDUE', `old rooted path or project identity remains in ${table}.${column}`);
      }
    }
  }
}
function updateDatabase(db: Database, changes: CellChange[], sql: string, identity: { libraryId: LibraryId; sourceSha256: string; historySha256: string }, mappings: Mapping[]): void {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    db.exec('PRAGMA defer_foreign_keys=ON');
    for (const c of changes) {
      const changed = db.query(`UPDATE ${quoted(c.table)} SET ${quoted(c.column)}=? WHERE rowid=? AND ${quoted(c.column)}=?`).run(c.after, c.rowid, c.before).changes;
      if (changed !== 1) fail('MIGRATION_PLAN_DRIFT', 'database cell count differs');
    }
    db.exec(sql);
    db.query('INSERT INTO library_layout_migrations(layout_version,library_id,source_sha256,history_sha256,rewritten_cells) VALUES(2,?,?,?,?)')
      .run(identity.libraryId, identity.sourceSha256, identity.historySha256, changes.length);
    assertNoDatabaseResidue(db, mappings);
    checkDatabase(db);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** One Windows-compatible identity per target component on every platform.
 * Binary lexical minimum chooses a stable spelling independently of discovery
 * order. Contents are checked separately before any target is written. */
function canonicalTargets(root: string, directories: string[], files: LibraryStatePlan['files']) {
  const nodes = new Map<string, { name: string; directory: boolean }>();
  const add = (path: string, directory: boolean) => {
    const parts = archivePath(slash(relative(root, path))).split('/');
    for (let i = 0; i < parts.length; i++) {
      const id = parts.slice(0, i + 1).join('/').toLowerCase(), name = parts[i]!;
      const isDirectory = i < parts.length - 1 || directory, existing = nodes.get(id);
      if (existing && existing.directory !== isDirectory) fail('MIGRATION_TARGET_CONFLICT', 'case-fold file/directory collision');
      if (!existing || name < existing.name) nodes.set(id, { name, directory: isDirectory });
    }
  };
  for (const dir of directories) add(join(root, dir), true);
  for (const file of files) add(file.targetPath, false);
  const normalize = (path: string): string => {
    if (!key(path).startsWith(key(root) + '/')) return path;
    absolute(path);
    const parts = slash(path).slice(slash(root).length + 1).split('/');
    return join(root, ...parts.map((part, i) => nodes.get(parts.slice(0, i + 1).join('/').toLowerCase())?.name ?? part));
  };
  return { normalize, directories: [...nodes].filter(([, node]) => node.directory)
    .map(([id]) => slash(relative(root, normalize(join(root, id)))) + '/').sort() };
}

function normalizeHistoryBytes(path: string, body: Buffer, normalize: ReturnType<typeof transformer>, operationsRoot: string): Buffer {
  if (/\.jsonl?$/i.test(path)) {
    const jsonl = /\.jsonl$/i.test(path);
    const values: unknown[] = jsonl ? body.toString().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [JSON.parse(body.toString())];
    const next = values.map(normalize.rewrite);
    if (!jsonl && dirname(path) === operationsRoot) {
      const operation = next[0] as Record<string, any>;
      operation.requestHash = fingerprint(operation.request.operation);
      validateOperationRecord(operation, operation.jobId);
    }
    // Preserve immutable receipt bytes and already-canonical history exactly.
    if (canonicalJson(values) === canonicalJson(next)) return body;
    if (/\/evidence\/publication\.json$/i.test(slash(path))) fail('MIGRATION_INVALID_SOURCE', 'immutable receipt would change');
    return Buffer.from(jsonl ? next.map(canonicalJson).join('\n') + (next.length ? '\n' : '') : canonicalJson(next[0]));
  }
  return /\.(md|txt|log|yaml)$/i.test(path) ? Buffer.from(normalize.text(body.toString())) : body;
}

async function prepare(input: LibraryStateInput) {
  const checked = await roots(input), { paths } = checked;
  const dbBytes = await idleDatabase(join(checked.legacyStateRoot, 'papers.sqlite'));
  const sourceSha256 = hash(dbBytes), db = memoryDatabase(dbBytes);
  const payloads = new Map<string, Buffer>();
  try {
    checkDatabase(db);
    if (tables(db).includes('library_layout_migrations') && db.query('SELECT 1 FROM library_layout_migrations').get()) fail('MIGRATION_INVALID_SOURCE', 'source already migrated');
    const archivePlan = await createArchiveMigrationPlan({ legacyArchiveRoot: join(checked.legacyStateRoot, 'extracted'), paths, libraryId: checked.libraryId });
    const mappings: Mapping[] = [...checked.pathRewrites!, { from: checked.legacyStateRoot, to: paths.dataRoot },
      { from: join(checked.legacyStateRoot, 'papers.sqlite'), to: paths.databasePath },
      { from: checked.legacyPdfRoot, to: join(paths.workRoot, 'downloads') }];
    const archives = new Map<string, Awaited<ReturnType<typeof verifyArchiveV2>>>();
    for (const paper of archivePlan.papers) {
      const archive = await verifyArchiveV2(paper.targetRoot);
      if (archive.manifest.libraryId !== checked.libraryId || archive.manifest.baseId !== paper.baseId || archive.manifest.version !== paper.version) fail('MIGRATION_INVALID_SOURCE', 'Archive identity differs');
      for (const file of paper.targetFiles) if (hash(await regular(join(paper.targetRoot, file.path))) !== file.sha256) fail('MIGRATION_INVALID_SOURCE', 'Archive differs from reviewed v1 migration');
      archives.set(`${paper.baseId}-v${paper.version}`, archive);
      const source = JSON.parse((await regular(join(paper.oldRoot, 'source.json'))).toString());
      mappings.push({ from: paper.oldRoot, to: paper.targetRoot },
        ...Object.entries({ [source.pdfPath]: 'source.pdf', [source.normalized.fullMarkdown]: 'document.md',
          [source.normalized.contentList]: 'content-list.json', [source.normalized.pages]: 'pages.json', [source.normalized.pageMarkedText]: 'pages.json' })
          .map(([old, next]) => ({ from: join(paper.oldRoot, old), to: join(paper.targetRoot, next) })));
    }
    for (const table of ['papers','parse_attempts']) {
      const pathColumn = table === 'papers' ? 'pdf_path' : 'source_path';
      for (const row of db.query(`SELECT * FROM ${table} WHERE ${pathColumn} IS NOT NULL`).all() as Record<string, any>[]) {
        const version = table === 'papers' ? row.downloaded_version ?? row.version : row.version;
        const archive = archives.get(`${row.base_id}-v${version}`);
        if (archive && archive.manifest.pdfSha256 === row.sha256) mappings.push({ from: row[pathColumn], to: join(archive.root, 'source.pdf') });
      }
    }
    const distinct = new Map<string, string>();
    for (const m of mappings) {
      if (distinct.has(key(m.from)) && key(distinct.get(key(m.from))!) !== key(m.to)) fail('MIGRATION_INVALID_SOURCE', 'ambiguous path mapping');
      distinct.set(key(m.from), m.to);
    }
    const transform = transformer(mappings, checked.libraryId);
    const directories: string[] = [], files: LibraryStatePlan['files'] = [];
    let operations = 0, runFiles = 0, receipts = 0;
    for (const folder of ['runs','operations']) {
      const sourceRoot = join(checked.legacyStateRoot, folder);
      directories.push(folder + '/');
      if (!(await info(sourceRoot))) continue;
      const tree = await realTree(sourceRoot);
      for (const rel of tree) {
        if (rel.endsWith('/')) { directories.push(`${folder}/${rel}`); continue; }
        if (folder === 'operations' && /^(locks|processes)\//.test(rel)) fail('MIGRATION_STATE_BUSY', 'operation lock/process records require reconciliation');
        const sourcePath = join(sourceRoot, rel), original = await regular(sourcePath);
        let body = original;
        if (/\.jsonl?$/i.test(rel)) {
          const jsonl = rel.endsWith('.jsonl');
          if (jsonl && original.length && !original.toString().endsWith('\n')) fail('MIGRATION_INVALID_SOURCE', 'incomplete event log');
          const values: unknown[] = jsonl ? original.toString().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [JSON.parse(original.toString())];
          const next = values.map(transform.rewrite);
          if (folder === 'operations' && !rel.includes('/') && rel.endsWith('.json')) {
            operations++;
            const originalOp = values[0] as Record<string, any>;
            if (!originalOp?.request || originalOp.requestHash !== fingerprint(originalOp.request.operation)) fail('MIGRATION_INVALID_SOURCE', 'source request hash differs');
            const op = next[0] as Record<string, any>;
            if (!op || op.schemaVersion !== 1 || op.jobId + '.json' !== rel || !Array.isArray(op.attempts)) fail('MIGRATION_INVALID_SOURCE', 'invalid operation record');
            if (['accepted','running'].includes(op.status)) fail('MIGRATION_STATE_BUSY', 'operation still active');
            const request = validateRequest(op.request, true);
            if (op.libraryId !== checked.libraryId || request.libraryId !== checked.libraryId) fail('MIGRATION_INVALID_SOURCE', 'operation identity differs');
            op.requestHash = fingerprint(request.operation);
            validateOperationRecord(op, rel.slice(0, -5));
          }
          for (const value of next) remaining(value, mappings);
          if (/\/evidence\/publication\.json$/.test('/' + rel)) {
            parsePublicationReceipt(original.toString());
            if (canonicalJson(values) !== canonicalJson(next)) fail('MIGRATION_INVALID_SOURCE', 'immutable receipt would change');
            receipts++;
          } else body = Buffer.from(jsonl ? next.map(canonicalJson).join('\n') + (next.length ? '\n' : '') : canonicalJson(next[0]));
        } else if (/\.(md|txt|log|yaml)$/i.test(rel)) { body = Buffer.from(transform.text(original.toString())); remaining(body.toString(), mappings); }
        if (folder === 'runs') runFiles++;
        const targetPath = join(paths.dataRoot, folder, rel);
        payloads.set(targetPath, body);
        files.push({ sourcePath, targetPath, sourceSha256: hash(original), sha256: hash(body), bytes: body.length });
      }
      if (canonicalJson(await realTree(sourceRoot)) !== canonicalJson(tree)) fail('MIGRATION_PLAN_DRIFT', 'history tree changed');
    }
    let changes = databaseChanges(db, transform, mappings);
    // Copy only still-needed downloaded PDFs. Parsed documents point at the
    // already verified Archive and keep their single authoritative PDF copy.
    for (const c of changes.filter(c => (c.table === 'papers' && c.column === 'pdf_path') || (c.table === 'parse_attempts' && c.column === 'source_path'))) {
      if (!within(join(paths.workRoot, 'downloads'), c.after)) continue;
      if (!within(checked.legacyPdfRoot, absolute(c.before))) fail('MIGRATION_PATH_UNSAFE', 'download outside source PDF root');
      const bytes = await regular(c.before);
      const row = db.query(`SELECT sha256 FROM ${quoted(c.table)} WHERE rowid=?`).get(c.rowid) as { sha256: string | null };
      if (!row.sha256 || hash(bytes) !== row.sha256) fail('MIGRATION_INVALID_SOURCE', 'downloaded PDF hash differs from SQLite');
      if (payloads.has(c.after)) {
        if (hash(payloads.get(c.after)!) !== hash(bytes)) fail('MIGRATION_INVALID_SOURCE', 'conflicting downloaded PDFs');
        continue;
      }
      payloads.set(c.after, bytes);
      files.push({ sourcePath: c.before, targetPath: c.after, sourceSha256: hash(bytes), sha256: hash(bytes), bytes: bytes.length });
    }
    const targets = canonicalTargets(paths.dataRoot, directories, files);
    const normalize = transformer([], checked.libraryId, targets.normalize);
    const canonicalPayloads = new Map<string, Buffer>();
    for (const file of files) {
      const body = normalizeHistoryBytes(file.targetPath, payloads.get(file.targetPath)!, normalize, paths.operationsRoot);
      file.targetPath = targets.normalize(file.targetPath);
      const existing = canonicalPayloads.get(file.targetPath);
      if (existing && !existing.equals(body)) fail('MIGRATION_TARGET_CONFLICT', 'case-fold file content collision');
      canonicalPayloads.set(file.targetPath, body);
      file.sha256 = hash(body); file.bytes = body.length;
    }
    payloads.clear();
    for (const [path, body] of canonicalPayloads) payloads.set(path, body);
    files.sort((a, b) => a.targetPath.localeCompare(b.targetPath) || a.sourcePath.localeCompare(b.sourcePath));
    const finalTransform = transformer(mappings, checked.libraryId, targets.normalize);
    changes = databaseChanges(db, finalTransform, mappings);
    for (const row of db.query('SELECT receipt_path,receipt_sha256 FROM evidence_publications WHERE receipt_path IS NOT NULL').all() as { receipt_path: string; receipt_sha256: string }[]) {
      const target = finalTransform.text(row.receipt_path), receiptBytes = payloads.get(target);
      if (!receiptBytes || hash(receiptBytes) !== row.receipt_sha256) fail('MIGRATION_INVALID_SOURCE', 'receipt path/hash mismatch');
    }
    const uniqueDirs = targets.directories;
    const counts = { rewrittenDatabaseCells: changes.length, databaseCellsByColumn: {} as Record<string, number>, operations, runFiles, receipts };
    for (const c of changes) { const column = `${c.table}.${c.column}`; counts.databaseCellsByColumn[column] = (counts.databaseCellsByColumn[column] ?? 0) + 1; }
    const historySha256 = hash(canonicalJson({ files, directories: uniqueDirs }));
    const sql = await readFile(sqlPath, 'utf8');
    updateDatabase(db, changes, sql, { libraryId: checked.libraryId, sourceSha256, historySha256 }, mappings);
    const targetContentSha256 = contentHash(db);
    if (hash(await idleDatabase(join(checked.legacyStateRoot, 'papers.sqlite'))) !== sourceSha256) fail('MIGRATION_PLAN_DRIFT', 'database changed during inventory');
    const body = { schemaVersion: 1 as const, ...checked, archivePlanSha256: archivePlan.sha256,
      database: { sourceSha256, targetContentSha256, changes }, directories: uniqueDirs, files, counts };
    return { plan: { ...body, sha256: hash(canonicalJson(body)) } satisfies LibraryStatePlan, payloads, dbBytes, sql, historySha256, mappings };
  } finally { db.close(); }
}

export async function createLibraryStatePlan(input: LibraryStateInput): Promise<LibraryStatePlan> {
  try { return (await prepare(input)).plan; }
  catch (error) { throw new Error('MIGRATION_INVALID_SOURCE: ' + String(error), { cause: error }); }
}
async function readPlan(input: ApplyInput): Promise<string> {
  try {
    const serialized = (await regular(absolute(input.planFile))).toString();
    const plan = JSON.parse(serialized), { sha256, ...body } = plan;
    if (!/^[0-9a-f]{64}$/.test(input.planSha256) || sha256 !== input.planSha256 || hash(canonicalJson(body)) !== sha256 || canonicalJson(plan) !== serialized) throw new Error('invalid canonical plan/hash');
    return serialized;
  } catch (error) { throw new Error('MIGRATION_PLAN_DRIFT: ' + String(error), { cause: error }); }
}
async function reviewed(input: ApplyInput, serialized: string) {
  try {
    const current = await prepare(input);
    if (canonicalJson(current.plan) !== serialized) fail('MIGRATION_PLAN_DRIFT', 'current sources/counts differ from reviewed plan');
    return current;
  } catch (error) { throw new Error('MIGRATION_PLAN_DRIFT: ' + String(error), { cause: error }); }
}
function installRoots(plan: LibraryStatePlan): string[] {
  return [plan.paths.runsRoot, plan.paths.operationsRoot,
    ...(plan.files.some(f => within(join(plan.paths.workRoot, 'downloads'), f.targetPath)) ? [join(plan.paths.workRoot, 'downloads')] : []), plan.paths.databasePath];
}
async function exactTarget(plan: LibraryStatePlan): Promise<void> {
  const db = memoryDatabase(await idleDatabase(plan.paths.databasePath));
  try { checkDatabase(db); if (contentHash(db) !== plan.database.targetContentSha256) fail('MIGRATION_TARGET_CONFLICT', 'database content differs'); }
  finally { db.close(); }
  for (const root of installRoots(plan).filter(r => r !== plan.paths.databasePath)) {
    const prefix = slash(relative(plan.paths.dataRoot, root)) + '/';
    const expected = [...new Set([...plan.directories.filter(d => d.startsWith(prefix) && d !== prefix).map(d => d.slice(prefix.length)),
      ...plan.files.filter(f => within(root, f.targetPath)).map(f => slash(relative(root, f.targetPath)))])].sort();
    if (canonicalJson(await realTree(root)) !== canonicalJson(expected)) fail('MIGRATION_TARGET_CONFLICT', 'history tree differs');
  }
  for (const f of plan.files) if (hash(await regular(f.targetPath)) !== f.sha256) fail('MIGRATION_TARGET_CONFLICT', 'history bytes differ');
}
async function targetState(plan: LibraryStatePlan): Promise<'empty' | 'replay'> {
  try {
    const targets = installRoots(plan), present = await Promise.all(targets.map(info));
    if (present.every(x => !x)) return 'empty';
    if (present.some(x => !x)) fail('MIGRATION_TARGET_CONFLICT', 'partial destination; refuse overwrite');
    await exactTarget(plan); return 'replay';
  } catch (error) { throw new Error('MIGRATION_TARGET_CONFLICT: ' + String(error), { cause: error }); }
}
/** Copy-only, offline migration. JSON directories are installed before SQLite;
 * the database rename is the commit point. A crash-left partial target fails
 * closed; a complete exact replay is read-only. Failed staging is retained. */
export async function applyLibraryStatePlan(input: ApplyInput): Promise<LibraryStateResult> {
  const serialized = await readPlan(input);
  let prepared = await reviewed(input, serialized);
  const result = (replayed: boolean): LibraryStateResult => ({ planSha256: prepared.plan.sha256, replayed,
    rewrittenDatabaseCells: prepared.plan.counts.rewrittenDatabaseCells, operations: prepared.plan.counts.operations,
    oldPathOccurrences: 0, oldProjectIdOccurrences: 0, libraryIds: [input.libraryId], integrityCheck: 'ok', foreignKeyViolations: 0 });
  if (await targetState(prepared.plan) === 'replay') return result(true);
  const { paths } = prepared.plan;
  await safeMkdir(paths.workRoot);
  const lock = join(paths.workRoot, 'library-state-migration.lock');
  try { await mkdir(lock); } catch (error) { throw new Error('MIGRATION_BUSY: state migration lock exists', { cause: error }); }
  const lockIdentity = await pathIdentity(lock);
  const installed: { from: string; to: string; identity: string }[] = [];
  try {
    prepared = await reviewed(input, serialized);
    if (await targetState(prepared.plan) === 'replay') return result(true);
    const staging = join(paths.workRoot, 'library-state-migration', randomUUID());
    await safeMkdir(staging);
    for (const d of prepared.plan.directories) await safeMkdir(join(staging, d));
    for (const [target, body] of prepared.payloads) await writeFile(join(staging, relative(paths.dataRoot, target)), body, { flag: 'wx' });
    const stagedDb = join(staging, 'library.sqlite');
    await writeFile(stagedDb, prepared.dbBytes, { flag: 'wx' });
    const db = new Database(toNamespacedPath(stagedDb), { strict: true });
    try {
      db.exec('PRAGMA journal_mode=DELETE');
      updateDatabase(db, prepared.plan.database.changes, prepared.sql, { libraryId: input.libraryId,
        sourceSha256: prepared.plan.database.sourceSha256, historySha256: prepared.historySha256 }, prepared.mappings);
      if (contentHash(db) !== prepared.plan.database.targetContentSha256) fail('MIGRATION_PLAN_DRIFT', 'copied database/counts differ');
    } finally { db.close(); }
    if (await readPlan(input) !== serialized) fail('MIGRATION_PLAN_DRIFT', 'plan changed during apply');
    await reviewed(input, serialized);
    if (await targetState(prepared.plan) !== 'empty') fail('MIGRATION_TARGET_CONFLICT', 'target appeared');
    for (const to of installRoots(prepared.plan)) {
      const from = join(staging, relative(paths.dataRoot, to));
      await safeMkdir(dirname(to));
      const identity = await pathIdentity(from);
      if (await info(to)) fail('MIGRATION_TARGET_CONFLICT', 'target appeared');
      await (input.install ?? rename)(from, to);
      installed.push({ from, to, identity });
    }
    await exactTarget(prepared.plan);
    if (await readPlan(input) !== serialized) fail('MIGRATION_PLAN_DRIFT', 'plan changed during installation');
    await reviewed(input, serialized);
    return result(false);
  } catch (error) {
    for (const entry of installed.reverse()) {
      // Rename changes the path portion of pathIdentity; compare the leaf's
      // physical identity and verify both ancestries before rolling it back.
      await assertRealPath(entry.to); await prospective(dirname(entry.from));
      const actual = (await pathIdentity(entry.to)).split('|')[0]!.slice(entry.to.length);
      const expected = entry.identity.split('|')[0]!.slice(entry.from.length);
      if (actual !== expected || await info(entry.from)) fail('MIGRATION_TARGET_CONFLICT', 'rollback identity changed');
      await rename(entry.to, entry.from);
    }
    throw new Error('MIGRATION_APPLY_FAILED: ' + String(error), { cause: error });
  } finally { if (await pathIdentity(lock) === lockIdentity) await rmdir(lock); }
}
