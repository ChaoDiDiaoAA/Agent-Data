import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backupStateDatabase, createStateDatabase } from '../src/runtime/sqlite.ts';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';

test('binds positional values and preserves null, blobs, no rows and change metadata', () => {
  const db = createStateDatabase(':memory:');
  try {
    db.exec('CREATE TABLE x(n INTEGER PRIMARY KEY, label TEXT, body BLOB) STRICT');
    assert.deepEqual(db.prepare('INSERT INTO x VALUES(?,?,?)').run(3, null, new Uint8Array([0, 255])), { changes: 1, lastInsertRowid: 3 });
    const row = db.prepare('SELECT * FROM x WHERE n=?').get(3);
    assert.equal(row?.n, 3);
    assert.equal(row?.label, null);
    assert.ok(row?.body instanceof Uint8Array);
    assert.deepEqual([...row.body], [0, 255]);
    assert.equal(db.prepare('SELECT * FROM x WHERE n=?').get(4), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM x WHERE n=?').all(4), []);
    assert.equal(db.prepare('UPDATE x SET label=? WHERE n=?').run('new', 4).changes, 0);
  } finally { db.close(); }
});

test('binds bare and colon-prefixed object keys and rejects ambiguous collisions', () => {
  const db = createStateDatabase(':memory:');
  try {
    const statement = db.prepare('SELECT :name AS value');
    assert.equal(statement.get({ name: 'bare' })?.value, 'bare');
    assert.equal(statement.get({ ':name': 'prefixed' })?.value, 'prefixed');
    assert.throws(() => statement.get({ name: 'one', ':name': 'two' }), /ambiguous|duplicate/i);
  } finally { db.close(); }
});

test('requires complete named bindings but ignores surplus keys as documented', () => {
  const db = createStateDatabase(':memory:');
  try {
    const statement = db.prepare('SELECT :n AS n');
    assert.equal(statement.get({ n: 3, extra: 1 })?.n, 3);
    assert.throws(() => statement.get({}), /Missing parameter/);
    assert.throws(() => statement.get(), /parameter|binding/i);
  } finally { db.close(); }
});

test('returns safe INTEGER cells as numbers and unsafe INTEGER cells and rowids as bigint', () => {
  const db = createStateDatabase(':memory:');
  try {
    db.exec('CREATE TABLE x(n INTEGER PRIMARY KEY) STRICT');
    assert.equal(db.prepare('SELECT ? AS n').get(42n)?.n, 42);
    assert.equal(db.prepare('SELECT ? AS n').get(9007199254740993n)?.n, 9007199254740993n);
    assert.equal(db.prepare('SELECT ? AS n').all(-9007199254740993n)[0]?.n, -9007199254740993n);
    assert.deepEqual(db.prepare('INSERT INTO x VALUES(?)').run(9007199254740993n), { changes: 1, lastInsertRowid: 9007199254740993n });
    assert.throws(() => db.prepare('SELECT ?').get(Number.MAX_SAFE_INTEGER + 1), /safe integer|bigint/i);
    assert.throws(() => db.prepare('SELECT ?').get(9223372036854775808n), /range/i);
    assert.equal(db.prepare('SELECT ? AS n').get(1.25)?.n, 1.25);
  } finally { db.close(); }
});

test('normalizes numeric expression column names in get and all without losing unsafe integers', () => {
  const db = createStateDatabase(':memory:');
  try {
    assert.deepEqual(db.prepare('SELECT 1').get(), { '1': 1 });
    assert.deepEqual(db.prepare('SELECT 1 UNION ALL SELECT 2').all(), [{ '1': 1 }, { '1': 2 }]);
    const sql = 'SELECT 1, 9007199254740993, -9007199254740993';
    const expected = { '1': 1, '9007199254740993': 9007199254740993n, '-9007199254740993': -9007199254740993n };
    assert.deepEqual(db.prepare(sql).get(), expected);
    assert.deepEqual(db.prepare(sql).all(), [expected]);
  } finally { db.close(); }
});

test('does not reuse stale bound values when a positional call omits parameters', () => {
  const db = createStateDatabase(':memory:');
  try {
    const statement = db.prepare('SELECT ? AS n');
    assert.equal(statement.get(1)?.n, 1);
    assert.throws(() => statement.get(), /parameter|binding/i);
  } finally { db.close(); }
});

test('preserves the default lock timeout and validates custom timeouts', () => {
  const db = createStateDatabase(':memory:');
  const custom = createStateDatabase(':memory:', { timeoutMs: 25 });
  try {
    assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
    assert.equal(custom.prepare('PRAGMA busy_timeout').get()?.timeout, 25);
    for (const timeoutMs of [-1, 1.5, Infinity, 2147483648]) {
      assert.throws(() => createStateDatabase(':memory:', { timeoutMs }), /timeout/i);
    }
  } finally { db.close(); custom.close(); }
});

test('WAL readers see only committed writes and a rolled-back transaction releases its lock', async () => {
  const fx = await makeRuntimeFixture();
  const path = join(fx.root, 'wal.sqlite');
  const writer = createStateDatabase(path);
  const reader = createStateDatabase(path, { timeoutMs: 25 });
  try {
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE x(n INTEGER); INSERT INTO x VALUES(1); BEGIN IMMEDIATE; INSERT INTO x VALUES(2)');
    assert.deepEqual(reader.prepare('SELECT n FROM x').all(), [{ n: 1 }]);
    const started = performance.now();
    assert.throws(() => reader.exec('BEGIN IMMEDIATE'), /locked|busy/i);
    assert.ok(performance.now() - started >= 15, 'contending connection must wait for its busy timeout');
    writer.exec('ROLLBACK');
    reader.exec('BEGIN IMMEDIATE; INSERT INTO x VALUES(3); COMMIT');
    assert.deepEqual(writer.prepare('SELECT n FROM x ORDER BY n').all(), [{ n: 1 }, { n: 3 }]);
  } finally { writer.close(); reader.close(); await unlink(path); await fx.dispose(); }
});

test('read-only connections can read existing data but cannot write or create a missing source', async () => {
  const fx = await makeRuntimeFixture();
  try {
    const path = join(fx.root, 'readonly.sqlite');
    const seed = createStateDatabase(path);
    seed.exec('CREATE TABLE x(n INTEGER); INSERT INTO x VALUES(1)'); seed.close();
    const db = createStateDatabase(path, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT n FROM x').get()?.n, 1);
      assert.throws(() => db.exec('INSERT INTO x VALUES(2)'), /readonly|read.only/i);
    } finally { db.close(); }
    assert.throws(() => createStateDatabase(join(fx.root, 'missing.sqlite'), { readOnly: true }));
    await unlink(path);
  } finally { await fx.dispose(); }
});

test('close releases the file despite retained prepared statements', async () => {
  const fx = await makeRuntimeFixture();
  try {
    const path = join(fx.root, 'state.sqlite');
    const db = createStateDatabase(path);
    db.exec('CREATE TABLE x(n INTEGER) STRICT; INSERT INTO x VALUES(1)');
    const retained = db.prepare('SELECT n FROM x');
    assert.equal(retained.get()?.n, 1);
    db.close(); db.close();
    assert.throws(() => retained.get(), /closed|finalized/);
    assert.throws(() => retained.all(), /closed|finalized/);
    assert.throws(() => retained.run(), /closed|finalized/);
    assert.throws(() => db.prepare('SELECT 1'), /closed/);
    assert.throws(() => db.exec('SELECT 1'), /closed/);
    await unlink(path);
  } finally { await fx.dispose(); }
});

test('backup captures committed WAL data, verifies integrity and can be reopened read-only', async () => {
  const fx = await makeRuntimeFixture();
  const source = join(fx.paths.stateRoot, 'state.sqlite');
  const destination = join(fx.paths.backupRoot, "snapshot's.sqlite");
  const db = createStateDatabase(source);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE x(n INTEGER); INSERT INTO x VALUES(1)');
    const before = await readFile(source);
    await backupStateDatabase(source, destination);
    assert.deepEqual(await readFile(source), before);
    const copy = createStateDatabase(destination, { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.deepEqual(copy.prepare('SELECT n FROM x').all(), [{ n: 1 }]);
      assert.throws(() => copy.exec('INSERT INTO x VALUES(2)'), /readonly|read.only/i);
    } finally { copy.close(); }
    await unlink(destination);
  } finally { db.close(); await fx.dispose(); }
});

test('backup refuses the source path and existing snapshots without changing their bytes', async () => {
  const fx = await makeRuntimeFixture();
  try {
    const source = join(fx.paths.stateRoot, 'state.sqlite');
    const destination = join(fx.paths.backupRoot, 'existing.sqlite');
    const db = createStateDatabase(source);
    db.exec('CREATE TABLE x(n INTEGER)'); db.close();
    const before = await readFile(source);
    await writeFile(destination, 'keep existing snapshot');
    await assert.rejects(backupStateDatabase(source, source), /same|source|exist/i);
    await assert.rejects(backupStateDatabase(source, destination), /exist/i);
    assert.deepEqual(await readFile(source), before);
    assert.equal(await readFile(destination, 'utf8'), 'keep existing snapshot');
  } finally { await fx.dispose(); }
});

test('failed backup removes only its new output and never creates a missing source', async () => {
  const fx = await makeRuntimeFixture();
  try {
    const source = join(fx.paths.stateRoot, 'corrupt.sqlite');
    const destination = join(fx.paths.backupRoot, 'failed.sqlite');
    await writeFile(source, 'not a sqlite database');
    await assert.rejects(backupStateDatabase(source, destination), /database/i);
    await assert.rejects(access(destination), { code: 'ENOENT' });
    assert.equal(await readFile(source, 'utf8'), 'not a sqlite database');
    const missing = join(fx.paths.stateRoot, 'missing.sqlite');
    await assert.rejects(backupStateDatabase(missing, destination));
    await assert.rejects(access(missing), { code: 'ENOENT' });
    await assert.rejects(access(destination), { code: 'ENOENT' });
  } finally { await fx.dispose(); }
});

test('backup rejects a reparse point anywhere in the destination parent chain', async () => {
  const fx = await makeRuntimeFixture();
  const link = join(fx.root, 'redirect');
  try {
    const source = join(fx.paths.stateRoot, 'state.sqlite');
    const db = createStateDatabase(source);
    db.exec('CREATE TABLE x(n INTEGER)'); db.close();
    await mkdir(join(fx.paths.backupRoot, 'nested'));
    await symlink(fx.paths.backupRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(backupStateDatabase(source, join(link, 'nested', 'blocked.sqlite')), /reparse|symbolic/i);
    await assert.rejects(access(join(fx.paths.backupRoot, 'nested', 'blocked.sqlite')), { code: 'ENOENT' });
  } finally { await unlink(link); await fx.dispose(); }
});
