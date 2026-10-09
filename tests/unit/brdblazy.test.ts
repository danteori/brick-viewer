// The lazy SQLite / .brdb reader (sqlitelazy.ts, brdblazy.ts) against sql.js and Python sqlite3,
// on synthetic databases written here (runs everywhere, no private files needed).
import { beforeAll, describe, expect, it } from 'vitest';
import { blake3 } from '../../src/format/blake3.ts';
import { appendRevision, BRDB_CREATE, BrdbWorld, writeNewWorld } from '../../src/format/brdb.ts';
import { LazyBrdbWorld, NotLoadedError, overviewPaths, runLoaded } from '../../src/format/brdblazy.ts';
import type { FileMap } from '../../src/format/brz.ts';
import { utf8 } from '../../src/format/msgpack.ts';
import { decodeWritten } from '../../src/format/saveview.ts';
import type { SqlBackend, SqlValue } from '../../src/format/sql.ts';
import { blobSource, bytesSource, compareValues, httpRangeSource, LazySqlite, parseCreateTable, readVarint, type RandomAccessSource } from '../../src/format/sqlitelazy.ts';
import { buildWorldModel, buildWorldModelLazy } from '../../src/scene/grids.ts';
import { digest, hasPython, nodeSql, pyDump, sha256, tempDir } from './brdb-helpers.ts';
import { enc, gridWorld, INDEX, W } from './brdb-synth.ts';

let sql: SqlBackend;
beforeAll(async () => { sql = await nodeSql(); });

/** Deterministic pseudo-random bytes (incompressible, so overflow chains are long). */
function noise(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}

const hex = (b: Uint8Array | null): string | null => (b ? Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') : null);

/** gridWorld plus big brick chunks, so the chunk blobs dwarf the tree. */
function bigGridWorld(chunks = 24, size = 96 << 10): FileMap {
  const files = gridWorld();
  const keys = Array.from({ length: chunks }, (_, i) => ({ X: i + 1, Y: -i - 1, Z: 0 }));
  files.set(W + 'Bricks/Grids/1/ChunkIndex.mps', enc(INDEX, {
    Chunk3DIndices: [{ X: 0, Y: 0, Z: 0 }, ...keys], ChunkOffsets: [{ X: 0, Y: 0, Z: 0 }, ...keys.map(() => ({ X: 0, Y: 0, Z: 0 }))],
    ChunkSizes: [2048, ...keys.map(() => 2048)], NumBricks: [2, ...keys.map(() => 1000)], NumComponents: [0, ...keys.map(() => 0)], NumWires: [0, ...keys.map(() => 0)],
  }));
  keys.forEach((k, i) => files.set(`${W}Bricks/Grids/1/Chunks/${k.X}_${k.Y}_${k.Z}.mps`, noise(size + i * 997, i + 1)));
  return files;
}

/** A tree of many files of awkward sizes (around the overflow thresholds), in nested folders. */
function manyFiles(n: number): FileMap {
  const sizes = [0, 1, 100, 489, 490, 4061, 4062, 4063, 4096, 8000, 12345, 65536 + 7];
  const files: FileMap = new Map();
  for (let i = 0; i < n; i++) files.set(`Root/d${i % 7}/sub${i % 3}/f${i}-é\u{1F9F1}.bin`, noise(sizes[i % sizes.length]!, i * 31 + 7));
  return files;
}

/** The same rows written with a small page size (deeper b-trees, more overflow pages). */
function smallPages(files: FileMap, pageSize: number): Uint8Array {
  const db = sql.open();
  try {
    db.exec(`PRAGMA page_size = ${pageSize}`);
    db.exec('BEGIN');
    for (const s of BRDB_CREATE) db.run(s);
    db.run("INSERT INTO revisions VALUES (1, 'Initial Revision', 5)");
    const folders = new Map<string, number>();
    let fileId = 1, blobId = 1;
    for (const [p, b] of files) {
      const dirs = p.split('/'), name = dirs.pop()!;
      let parent: number | null = null;
      for (let i = 0; i < dirs.length; i++) {
        const key = dirs.slice(0, i + 1).join('/');
        let id = folders.get(key);
        if (id === undefined) { id = folders.size + 1; folders.set(key, id); db.run('INSERT INTO folders VALUES (?, ?, ?, 5, NULL)', [id, parent, dirs[i]!]); }
        parent = id;
      }
      db.run('INSERT INTO blobs VALUES (?, 0, ?, ?, NULL, ?, ?)', [blobId, b.length, b.length, blake3(b), b]);
      db.run('INSERT INTO files VALUES (?, ?, ?, ?, 5, NULL)', [fileId++, parent, name, blobId++]);
    }
    db.exec('COMMIT');
    return db.export();
  } finally {
    db.close();
  }
}

/** Opens both readers and checks that every table, every tree and every file agree. */
async function expectSameAsSqlJs(bytes: Uint8Array, mode: 'index' | 'table' | 'none' = 'index'): Promise<LazyBrdbWorld> {
  const ref = BrdbWorld.open(sql, bytes, { verify: true });
  const lazy = await LazyBrdbWorld.open(bytesSource(bytes), { verify: true, blobMeta: mode, cacheBytes: 64 << 10 });
  expect(lazy.schemaMatches).toBe(true);
  expect(lazy.revisions).toEqual(ref.revisions);
  expect([...lazy.folders]).toEqual([...ref.folders]);
  expect(lazy.rows).toEqual(ref.rows);
  expect(lazy.revisionStats()).toEqual(ref.revisionStats());
  if (mode !== 'none') {
    expect([...lazy.blobs.keys()].sort((a, b) => a - b)).toEqual([...ref.blobs.keys()].sort((a, b) => a - b));
    for (const [id, b] of ref.blobs) {
      const l = lazy.blobs.get(id)!;
      expect([l.sizeUncompressed, hex(l.hash)]).toEqual([b.sizeUncompressed, hex(b.hash)]);
      if (mode === 'table') expect(l).toEqual({ ...b });
    }
  }
  for (const rev of [undefined, ...ref.revisions.map((r) => r.id)]) {
    const a = ref.tree(rev), b = lazy.tree(rev);
    expect(b.paths()).toEqual(a.paths());
    expect(digest(await b.loadAll())).toEqual(digest(a.files()));
  }
  for (const [id, b] of ref.blobs) expect(lazy.blobs.get(id)).toEqual({ ...b });   // every row read by now
  ref.close();
  return lazy;
}

describe('LazySqlite basics', () => {
  it('varints, CREATE parsing and value order', () => {
    expect(readVarint(new Uint8Array([0x7f]), 0)).toEqual([127, 1]);
    expect(readVarint(new Uint8Array([0x81, 0x00]), 0)).toEqual([128, 2]);
    expect(readVarint(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]), 0)).toEqual([2 ** 56 - 1, 8]);
    expect(parseCreateTable(BRDB_CREATE[0]!)).toEqual({ columns: ['blob_id', 'compression', 'size_uncompressed', 'size_compressed', 'delta_base_id', 'hash', 'content'], rowidColumn: 0, withoutRowid: false });
    expect(parseCreateTable('CREATE TABLE "a b" ("x y" TEXT, [z] INT, w, PRIMARY KEY (w)) WITHOUT ROWID')).toEqual({ columns: ['x y', 'z', 'w'], rowidColumn: -1, withoutRowid: true });
    const vals: SqlValue[] = [null, -5, 2, 'a', 'b', '\u{1F9F1}', '￿', new Uint8Array([1]), new Uint8Array([1, 0])];
    const sorted = [...vals].sort(compareValues);
    expect(sorted).toEqual([null, -5, 2, 'a', 'b', '￿', '\u{1F9F1}', new Uint8Array([1]), new Uint8Array([1, 0])]);
  });

  it('decodes every serial type as sql.js does, by scan and by rowid', async () => {
    const db = sql.open();
    db.exec('PRAGMA page_size = 1024');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v, w TEXT)');
    const values: SqlValue[] = [null, 0, 1, -1, 127, 128, -128, -129, 32767, -32768, 8388607, -8388608, 2 ** 31 - 1, -(2 ** 31), 2 ** 40 + 3, -(2 ** 47), 2 ** 53 - 1, -(2 ** 53 - 1),
      3.5, -1e300, 0.1, 'héllo \u{1F9F1}', '', new Uint8Array(0), new Uint8Array([0, 255, 7]), 'x'.repeat(5000), noise(3000, 9)];
    values.forEach((v, i) => db.run('INSERT INTO t VALUES (?, ?, ?)', [i * 3 + 1, v, `row ${i}`]));
    db.exec('INSERT INTO t VALUES (1000, 4611686018427387904, NULL)');   // 2^62: past 2^53, so a bigint
    const bytes = db.export(), want = db.query('SELECT id, v, w FROM t ORDER BY id');
    db.close();
    const lz = await LazySqlite.open(bytesSource(bytes)), t = lz.table('t');
    expect(lz.header).toMatchObject({ pageSize: 1024, usableSize: 1024, encoding: 'utf-8', wal: false });
    const got: SqlValue[][] = [];
    await lz.scan(t, (r) => { got.push([...r.values] as SqlValue[]); }, { full: true });
    const last = got.pop()!;
    expect(last).toEqual([1000, 2n ** 62n, null]);
    expect(got).toEqual(want.slice(0, -1));
    for (const row of want.slice(0, -1)) {
      const r = (await lz.row(t, row[0] as number))!;
      expect([r.rowid, await lz.column(r, 1), await lz.column(r, 2)]).toEqual(row);
    }
    expect(await lz.row(t, 2)).toBeNull();
    expect(await lz.row(t, 99999)).toBeNull();
    expect(() => lz.table('nope')).toThrow(/no table/);
  });

  it('follows overflow chains that jump (freed pages reused), and still reads them right', async () => {
    const db = sql.open();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB)');
    const a = noise(50_000, 1), b = noise(50_000, 2), c = noise(130_000, 3);
    db.run('INSERT INTO t VALUES (1, ?)', [a]);
    db.run('INSERT INTO t VALUES (2, ?)', [b]);
    db.run('DELETE FROM t WHERE id = 1');
    db.run('INSERT INTO t VALUES (3, ?)', [c]);   // reuses id 1's freed pages, then new ones
    const bytes = db.export();
    db.close();
    const lz = await LazySqlite.open(bytesSource(bytes)), t = lz.table('t');
    for (const [id, want] of [[2, b], [3, c]] as const) {
      const r = (await lz.row(t, id))!;
      expect(r.values[1]).toBeUndefined();   // past the local payload: not read yet
      expect(sha256((await lz.column(r, 1)) as Uint8Array)).toBe(sha256(want));
    }
    expect(lz.stats.overflowPages).toBeGreaterThan(40);
  });

  it('index scans: in order, and by key prefix through the b-tree', async () => {
    const db = sql.open();
    db.exec('PRAGMA page_size = 512');
    db.exec('CREATE TABLE f (id INTEGER PRIMARY KEY, parent INTEGER, name TEXT, gone INTEGER)');
    db.exec('CREATE INDEX f_parent_name ON f(parent, name, gone)');
    for (let i = 1; i <= 3000; i++) db.run('INSERT INTO f VALUES (?, ?, ?, ?)', [i, i % 13 === 0 ? null : i % 17, `name-${i % 101}-${'z'.repeat(i % 40)}`, i % 5 ? null : i]);
    const bytes = db.export();
    const all = db.query('SELECT parent, name, gone, id FROM f ORDER BY parent, name, gone, id');
    const [p0, n0] = db.query('SELECT parent, name FROM f WHERE parent = 4 ORDER BY id LIMIT 1')[0]!;
    const some = db.query('SELECT parent, name, gone, id FROM f WHERE parent = ? AND name = ? ORDER BY gone, id', [p0!, n0!]);
    const nulls = db.query('SELECT parent, name, gone, id FROM f WHERE parent IS NULL ORDER BY name, gone, id');
    db.close();
    expect(some.length).toBeGreaterThan(0);
    const lz = await LazySqlite.open(bytesSource(bytes)), ix = lz.index('f_parent_name')!;
    expect(ix.columns).toEqual(['parent', 'name', 'gone']);
    const scan = async (prefix: SqlValue[] = []): Promise<SqlValue[][]> => { const out: SqlValue[][] = []; await lz.scanIndex(ix, (k) => { out.push(k); }, prefix); return out; };
    expect(await scan()).toEqual(all);
    const before = lz.stats.pageMisses + lz.stats.pageHits;
    expect(await scan([p0!, n0!])).toEqual(some);
    expect(lz.stats.pageMisses + lz.stats.pageHits - before).toBeLessThan(10);   // a descent, not a scan
    expect(await scan([null])).toEqual(nulls);
    expect(await scan([999])).toEqual([]);
    let n = 0;
    await lz.scanIndex(ix, () => ++n < 5);
    expect(n).toBe(5);
  });

  it('keeps the page cache under its budget', async () => {
    const bytes = smallPages(manyFiles(400), 1024);
    const lz = await LazySqlite.open(bytesSource(bytes), { cacheBytes: 16 << 10 });
    let rows = 0;
    await lz.scan(lz.table('files'), () => { rows++; });
    await lz.scan(lz.table('blobs'), () => {});
    expect(rows).toBe(400);
    expect(lz.cachedBytes).toBeLessThanOrEqual(16 << 10);
  });

  it('rejects files that are not SQLite and WITHOUT ROWID tables', async () => {
    await expect(LazySqlite.open(bytesSource(new Uint8Array(200)))).rejects.toThrow(/not a SQLite/);
    const db = sql.open();
    db.exec('CREATE TABLE k (a TEXT PRIMARY KEY, b) WITHOUT ROWID');
    const lz = await LazySqlite.open(bytesSource(db.export()));
    db.close();
    expect(() => lz.table('k')).toThrow(/WITHOUT ROWID/);
  });
});

describe('sources', () => {
  const bytes = noise(10_000, 4);
  const check = async (src: RandomAccessSource): Promise<void> => {
    expect(src.size).toBe(bytes.length);
    expect(await src.readAt(4000, 300)).toEqual(bytes.subarray(4000, 4300));
    await expect(src.readAt(9990, 20)).rejects.toThrow(RangeError);
  };

  it('bytes and Blob', async () => {
    await check(bytesSource(bytes));
    await check(blobSource(new Blob([new Uint8Array(bytes)])));
  });

  it('HTTP Range (and refuses a server that ignores Range)', async () => {
    const calls: string[] = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range')!;
      calls.push(range);
      const [a, b] = /bytes=(\d+)-(\d+)/.exec(range)!.slice(1).map(Number) as [number, number];
      return new Response(bytes.slice(a, b + 1), { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${bytes.length}` } });
    }) as typeof fetch;
    await check(await httpRangeSource('https://example.invalid/w.brdb', { fetch: fake }));
    expect(calls).toEqual(['bytes=0-0', 'bytes=4000-4299']);
    const ignores = (async () => new Response(bytes, { status: 200 })) as typeof fetch;
    await expect(httpRangeSource('https://example.invalid/w.brdb', { fetch: ignores })).rejects.toThrow(/206/);
  });
});

describe('LazyBrdbWorld', () => {
  it('a world from writeNewWorld plus appended revisions: same tables, trees and files as sql.js, in all blobMeta modes', async () => {
    const v1 = writeNewWorld(sql, bigGridWorld(6, 20_000), { when: 1000 });
    const next = bigGridWorld(6, 20_000);
    next.set(W + 'Bricks/Grids/1/Chunks/3_-3_0.mps', noise(70_000, 99));
    next.delete('Meta/Copy.json');
    next.set('Meta/New é.json', utf8('{}'));
    const v2 = appendRevision(BrdbWorld.open(sql, v1), next, { when: 2000 }).bytes;
    for (const mode of ['index', 'table', 'none'] as const) await expectSameAsSqlJs(v2, mode);
  });

  it('many files of awkward sizes, 4096- and 512-byte pages', async () => {
    const files = manyFiles(600);
    await expectSameAsSqlJs(writeNewWorld(sql, files, { when: 7 }));
    const w = await expectSameAsSqlJs(smallPages(files, 512));
    expect(w.db.header.pageSize).toBe(512);
  });

  it.skipIf(!hasPython)('matches Python sqlite3 row for row', async () => {
    const t = tempDir();
    try {
      const bytes = writeNewWorld(sql, bigGridWorld(4, 30_000), { when: 1234 }), file = t.file('w.brdb', bytes), py = pyDump(file, { rows: true });
      const w = await LazyBrdbWorld.open(bytesSource(bytes), { blobMeta: 'table' });
      expect(w.revisions.map((r) => [r.id, r.description, r.createdAt])).toEqual(py.revisions);
      expect([...w.folders.values()].map((f) => [f.id, f.parentId, f.name, f.createdAt, f.deletedAt])).toEqual(py.folders);
      expect(w.rows.map((r) => [r.id, r.folderId, r.name, r.contentId, r.createdAt, r.deletedAt])).toEqual(py.files);
      expect(digest(await w.tree().loadAll())).toEqual(py.live);
      expect([...w.blobs.values()].map((b) => [b.id, b.compression, b.sizeUncompressed, b.sizeCompressed, b.deltaBaseId, hex(b.hash)])).toEqual(py.blobs!.map((r) => r.slice(0, 6)));
    } finally {
      t.done();
    }
  });

  it('the overview reads the tree and chunk indexes, not the brick chunks', async () => {
    const files = bigGridWorld(), bytes = writeNewWorld(sql, files, { when: 10 });
    const w = await LazyBrdbWorld.open(bytesSource(bytes)), tree = w.tree();
    const ref = BrdbWorld.open(sql, bytes), m0 = buildWorldModel(ref.tree());
    const m = await buildWorldModelLazy(tree);
    expect(m).toEqual(m0);
    const chunks = tree.paths().filter((p) => p.includes('/Chunks/') && p.includes('/Grids/'));
    expect(chunks.length).toBe(26);
    expect(chunks.filter((p) => tree.isLoaded(p))).toEqual([]);
    expect(overviewPaths(tree).every((p) => tree.isLoaded(p))).toBe(true);
    expect(w.stats.bytesRead).toBeLessThan(bytes.length / 10);
    // sizes known up front (from the index); stored sizes once read
    const c = chunks[3]!;
    expect(tree.sizeOf(c)).toBe(files.get(c)!.length);
    expect(tree.storedSizeOf(c)).toBeUndefined();
    expect(() => tree.get(c)).toThrow(NotLoadedError);
    await tree.load([c]);
    expect(sha256(tree.get(c)!)).toBe(sha256(files.get(c)!));
    expect(tree.storedSizeOf(c)).toBe(files.get(c)!.length);
    tree.unload([c]);
    expect(tree.isLoaded(c)).toBe(false);
    // any sync consumer works through runLoaded
    const f = await runLoaded(tree, (v) => decodeWritten(v, W + 'Bricks/Grids/1/Chunks/0_0_0.mps'));
    expect(f.schemaPath).toBe(W + 'Bricks/ChunksShared.schema');
    ref.close();
  });

  it('reads through a Blob as a browser File would', async () => {
    const bytes = writeNewWorld(sql, bigGridWorld(3, 10_000), { when: 3 });
    const w = await LazyBrdbWorld.open(blobSource(new Blob([new Uint8Array(bytes)])), { verify: true });
    const ref = BrdbWorld.open(sql, bytes);
    expect(digest(await w.tree().loadAll())).toEqual(digest(ref.tree().files()));
    ref.close();
  });
});
