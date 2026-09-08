import { Database } from 'bun:sqlite';
import { closeSync, fstatSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';

export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlRow = Record<string, unknown>;
export type SqlArgs = SqlValue[] | [Record<string, SqlValue>];
export interface SqlStatement {
  get(...args: SqlArgs): SqlRow | undefined;
  all(...args: SqlArgs): SqlRow[];
  run(...args: SqlArgs): { changes: number; lastInsertRowid: number | bigint };
}
export interface StateDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

function normalizeInteger(value: number | bigint): number | bigint {
  if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return value;
}

function normalizeRow(row: SqlRow): SqlRow {
  // Bun's native rows can retain bigint values for numeric column names after
  // assignment. Construct a plain row so every safe integer has one contract.
  return Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, typeof value === 'bigint' ? normalizeInteger(value) : value]));
}

function validateValue(value: SqlValue): SqlValue {
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new RangeError('SQL numbers must be finite; use bigint for integers outside the safe integer range');
  }
  return value;
}

function isNamedArgs(args: SqlArgs): args is [Record<string, SqlValue>] {
  return args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !(args[0] instanceof Uint8Array);
}

function normalizeArgs(args: SqlArgs, count: number): SqlArgs {
  if (isNamedArgs(args)) {
    const bindings: Record<string, SqlValue> = Object.create(null);
    for (const [key, value] of Object.entries(args[0])) {
      const name = key.replace(/^[:@$]/, '');
      if (Object.hasOwn(bindings, name)) throw new Error(`Ambiguous duplicate SQL parameter: ${name}`);
      bindings[name] = validateValue(value);
    }
    return [bindings];
  }
  if (args.length !== count) throw new Error(`Expected ${count} SQL parameters, received ${args.length}`);
  return args.map(validateValue);
}

export function createStateDatabase(path: string, options: { readOnly?: boolean; timeoutMs?: number } = {}): StateDatabase {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) throw new RangeError('Invalid SQLite timeoutMs');
  const native = new Database(path, { readonly: options.readOnly, strict: true, safeIntegers: true });
  try { native.exec(`PRAGMA busy_timeout=${timeoutMs}`); }
  catch (error) { native.close(true); throw error; }
  let closed = false;
  function assertOpen(): void { if (closed) throw new Error('Database has closed'); }
  return {
    exec(sql) { assertOpen(); native.exec(sql); },
    prepare(sql) {
      assertOpen();
      const statement = native.prepare<SqlRow, SqlArgs>(sql);
      return {
        get(...args) {
          assertOpen();
          const row = statement.get(...normalizeArgs(args, statement.paramsCount));
          return row === null ? undefined : normalizeRow(row);
        },
        all(...args) { assertOpen(); return statement.all(...normalizeArgs(args, statement.paramsCount)).map(normalizeRow); },
        run(...args) {
          assertOpen();
          const result = statement.run(...normalizeArgs(args, statement.paramsCount));
          return { changes: result.changes, lastInsertRowid: normalizeInteger(result.lastInsertRowid) };
        },
      };
    },
    close() {
      if (closed) return;
      native.close(true);
      closed = true;
    },
  };
}

function comparablePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function assertOrdinaryParents(destination: string): void {
  let parent = dirname(destination);
  const root = parse(parent).root;
  while (true) {
    const entry = lstatSync(parent);
    if (entry.isSymbolicLink() || comparablePath(realpathSync(parent)) !== comparablePath(parent)) {
      throw new Error(`Backup destination crosses a symbolic link or reparse point: ${parent}`);
    }
    if (!entry.isDirectory()) throw new Error(`Backup parent is not a directory: ${parent}`);
    if (parent === root) break;
    parent = dirname(parent);
  }
}

/** Caller must first restrict destination to its verified test root or project backupRoot.
 * Writers must be stopped for a migration snapshot. VACUUM copies committed WAL data.
 */
export async function backupStateDatabase(source: string, destination: string): Promise<void> {
  const sourcePath = realpathSync(source);
  const destinationPath = resolve(destination);
  if (comparablePath(sourcePath) === comparablePath(destinationPath)) throw new Error('Backup source and destination must differ');
  assertOrdinaryParents(destinationPath);
  // Reserve exclusively, including against empty old snapshots. VACUUM INTO can
  // populate an empty file; retaining its identity protects failure cleanup.
  const descriptor = openSync(destinationPath, 'wx');
  const created = fstatSync(descriptor);
  let sourceDb: StateDatabase | undefined;
  let copyDb: StateDatabase | undefined;
  try {
    sourceDb = createStateDatabase(sourcePath, { readOnly: true });
    sourceDb.prepare('VACUUM INTO ?').run(destinationPath);
    sourceDb.close(); sourceDb = undefined;
    copyDb = createStateDatabase(destinationPath, { readOnly: true });
    const integrity = copyDb.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('Backup integrity check failed');
    copyDb.close(); copyDb = undefined;
  } catch (error) {
    copyDb?.close();
    sourceDb?.close();
    closeSync(descriptor);
    assertOrdinaryParents(destinationPath);
    const current = lstatSync(destinationPath, { throwIfNoEntry: false });
    if (current?.isFile() && current.dev === created.dev && current.ino === created.ino) unlinkSync(destinationPath);
    throw error;
  }
  closeSync(descriptor);
}
