// The pure-TS SQLite writer (sqlitewrite.ts) and writeNewWorldFile: what it writes must read back
// with sql.js, the lazy reader and Python sqlite3, row for row the same as writeNewWorld (sql.js).
import { beforeAll, describe, expect, it } from 'vitest';
import { BRDB_CREATE, BrdbWorld, writeNewWorld, writeNewWorldFile } from '../../src/format/brdb.ts';
import { LazyBrdbWorld } from '../../src/format/brdblazy.ts';
import type { FileMap } from '../../src/format/brz.ts';
import type { SqlBackend, SqlValue } from '../../src/format/sql.ts';
import { bytesSource, LazySqlite } from '../../src/format/sqlitelazy.ts';
import { record, writeSqlite } from '../../src/format/sqlitewrite.ts';
import { digest, hasPython, nodeSql, pyDump, python, sha256, tempDir } from './brdb-helpers.ts';
import { gridWorld, oldWorld } from './brdb-synth.ts';

let sql: SqlBackend;
beforeAll(async () => { sql = await nodeSql(); });

function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}

/** Many files of awkward sizes (around the overflow thresholds), nested folders, odd names, shared contents. */
function manyFiles(n: number, nameLen = 1): FileMap {
  const sizes = [0, 1, 100, 489, 490, 1002, 1003, 4061, 4062, 4063, 4096, 8000, 12345, 20000];
  const files: FileMap = new Map();
  for (let i = 0; i < n; i++) {
    const name = `f${(i * 7919) % n}-é\u{1F9F1}${'x'.repeat(nameLen)}.bin`;
    files.set(`Root/d${i % 7}/sub${i % 3}/${name}`, i % 5 === 0 ? noise(64, 1) : noise(sizes[i % sizes.length]!, i * 31 + 7));
  }
  return files;
}

const dump = (bytes: Uint8Array): Record<string, SqlValue[][]> => {
  const db = sql.open(bytes);
  try {
    const out: Record<string, SqlValue[][]> = {};
    // blobs as sha256 hex: deep-equal on big Uint8Arrays is slow
    for (const t of ['sqlite_master', 'blobs', 'revisions', 'folders', 'files']) out[t] = db.query(`SELECT * FROM ${t} ORDER BY rowid`).map((r) => r.map((v) => (v instanceof Uint8Array ? sha256(v) : v)));
    return out;
  } finally { db.close(); }
};

const integrity = (bytes: Uint8Array): SqlValue[][] => {
  const db = sql.open(bytes);
  try { return db.query('PRAGMA integrity_check'); } finally { db.close(); }
};

/** Python sqlite3: integrity check, plus an index lookup that must use the written index. */
const PY_CHECK = `
import sqlite3, sys, json
c = sqlite3.connect(sys.argv[1])
ok = c.execute('PRAGMA integrity_check').fetchall()
n = c.execute('SELECT COUNT(*) FROM files INDEXED BY files_parent_name_deleted WHERE parent_id IS NOT NULL AND deleted_at IS NULL').fetchone()[0]
b = c.execute('SELECT COUNT(*) FROM blobs INDEXED BY blobs_size_hash WHERE size_uncompressed >= 0').fetchone()[0]
print(json.dumps([ok, n, b]))
`;

describe('record encoding', () => {
  it('uses the smallest serial types', () => {
    // types: NULL, 0, 1, int8 x2, int16, int24, int48 (2^31 needs more than int32), int48, int64, text 2, blob 1
    expect([...record([null, 0, 1, 2, -1, 300, 70000, 2 ** 31, 2 ** 40, 2 ** 50, 'ab', new Uint8Array([9])])]).toEqual([
      13, 0, 8, 9, 1, 1, 2, 3, 5, 5, 6, 17, 14,
      2, 0xff, 0x01, 0x2c, 0x01, 0x11, 0x70, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 97, 98, 9,
    ]);
    expect(() => record([1.5])).toThrow(/integer/);
  });
});

describe('writeSqlite', () => {
  it('writes an empty table and a one-row table that sql.js reads', () => {
    const bytes = writeSqlite([
      { type: 'table', name: 't', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', rows: [] },
      { type: 'table', name: 'u', sql: 'CREATE TABLE u (id INTEGER PRIMARY KEY, v TEXT)', rows: [[7, [null, 'x']]] },
      { type: 'index', name: 'u_v', table: 'u', sql: 'CREATE INDEX u_v ON u(v)', columns: [1] },
    ]);
    expect(integrity(bytes)).toEqual([['ok']]);
    const db = sql.open(bytes);
    expect(db.query('SELECT * FROM t')).toEqual([]);
    expect(db.query("SELECT id, v FROM u WHERE v = 'x'")).toEqual([[7, 'x']]);
    db.close();
  });

  it('deep table and index trees (thousands of rows, long keys) pass the integrity check', () => {
    const rows: [number, SqlValue[]][] = Array.from({ length: 30_000 }, (_, i) => [i * 3 + 1, [null, `k${(i * 7919) % 30_000}`.padEnd(40 + (i % 900), 'é'), i % 11]]);
    const bytes = writeSqlite([
      { type: 'table', name: 't', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT, g INTEGER)', rows },
      { type: 'index', name: 't_gk', table: 't', sql: 'CREATE INDEX t_gk ON t(g, k)', columns: [2, 1] },
    ]);
    expect(integrity(bytes)).toEqual([['ok']]);
    const db = sql.open(bytes);
    expect(db.query('SELECT COUNT(*) FROM t')).toEqual([[30_000]]);
    expect(db.query('SELECT COUNT(*) FROM t INDEXED BY t_gk WHERE g = 3')).toEqual([[rows.filter((r) => r[1][2] === 3).length]]);
    db.close();
  });

  it('reads back with the lazy reader, by scan and by index', async () => {
    const rows: [number, SqlValue[]][] = Array.from({ length: 5000 }, (_, i) => [i + 1, [null, `name${i}`.repeat(1 + (i % 40)), noise(i % 9000, i)]]);
    const bytes = writeSqlite([
      { type: 'table', name: 't', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT, b BLOB)', rows },
      { type: 'index', name: 't_k', table: 't', sql: 'CREATE INDEX t_k ON t(k)', columns: [1] },
    ]);
    expect(integrity(bytes)).toEqual([['ok']]);
    const lazy = await LazySqlite.open(bytesSource(bytes));
    const ref = sql.open(bytes);
    const want = ref.query('SELECT id, k, b FROM t ORDER BY id');
    ref.close();
    const got: [number, SqlValue][] = [];
    await lazy.scan(lazy.table('t'), (r) => { got.push([r.rowid, r.values[1]!]); }, { full: true });
    expect(got).toEqual(want.map((r) => [r[0], r[1]]));
    const keys: SqlValue[][] = [];
    await lazy.scanIndex(lazy.index('t_k')!, (k) => { keys.push(k); });
    expect(keys.map((k) => k[0])).toEqual(want.map((r) => r[1]).sort());
  });
});

describe('writeNewWorldFile', () => {
  const worlds: [string, () => FileMap][] = [['old world', oldWorld], ['grid world', gridWorld], ['many files', () => manyFiles(1500)], ['long names', () => manyFiles(600, 700)]];

  it.each(worlds)('%s: the same rows as writeNewWorld (sql.js), integrity ok', (_, make) => {
    const files = make();
    const pure = writeNewWorldFile(files, { when: 1234 }), ref = writeNewWorld(sql, files, { when: 1234 });
    expect(integrity(pure)).toEqual([['ok']]);
    const a = dump(pure), b = dump(ref);
    expect(a.sqlite_master!.map((r) => [r[0], r[1], r[2], r[4]])).toEqual(b.sqlite_master!.map((r) => [r[0], r[1], r[2], r[4]]));
    for (const t of ['blobs', 'revisions', 'folders', 'files']) expect(a[t], t).toEqual(b[t]);
    const w = BrdbWorld.open(sql, pure, { verify: true });
    expect(digest(w.tree().files())).toEqual(digest(files));
    w.close();
  }, 240_000);

  it.each(worlds)('%s: the lazy reader opens it like sql.js', async (_, make) => {
    const files = make(), bytes = writeNewWorldFile(files, { when: 99 });
    const lazy = await LazyBrdbWorld.open(bytesSource(bytes), { verify: true, cacheBytes: 64 << 10 });
    expect(lazy.schemaMatches).toBe(true);
    expect(lazy.revisions).toEqual([{ id: 1, description: 'Initial Revision', createdAt: 99 }, { id: 2, description: 'Manual Save', createdAt: 99 }]);
    const tree = lazy.tree();
    expect(tree.paths()).toEqual([...files.keys()]);
    expect(digest(await tree.loadAll())).toEqual(digest(files));
  }, 240_000);

  it('keeps the game CREATE statements verbatim', () => {
    const db = sql.open(writeNewWorldFile(oldWorld()));
    expect(db.query('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid').map((r) => r[0])).toEqual([...BRDB_CREATE]);
    expect(db.query('PRAGMA page_size')[0]![0]).toBe(4096);
    expect(db.query('PRAGMA encoding')[0]![0]).toBe('UTF-8');
    db.close();
  });

  it.skipIf(!hasPython)('Python sqlite3: integrity ok, index lookups work, same files', () => {
    const t = tempDir();
    try {
      for (const files of [oldWorld(), manyFiles(1500), manyFiles(600, 700)]) {
        const f = t.file('pure.brdb', writeNewWorldFile(files, { when: 1234 }));
        const [ok, n, b] = JSON.parse(python(['-c', PY_CHECK, f])) as [string[][], number, number];
        expect(ok).toEqual([['ok']]);
        expect(n).toBe(files.size);
        expect(b).toBeGreaterThan(0);
        const py = pyDump(f, { rows: true });
        expect(py.live).toEqual(digest(files));
        expect(py.master.filter((m) => m[3]).map((m) => m[3])).toEqual([...BRDB_CREATE]);
      }
    } finally {
      t.done();
    }
  }, 240_000);
});
