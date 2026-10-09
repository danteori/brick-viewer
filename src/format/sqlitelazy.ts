// A read-only SQLite file-format reader that never loads the whole file (backlog S-08,
// OPTIMIZATION B.1a). It reads pages through a random-access source (a File / Blob, an HTTP
// Range endpoint, or bytes already in memory), keeps a small LRU of b-tree pages under a byte
// budget, and follows overflow-page chains only when a column that lives there is asked for.
// No wasm and no SQL: it walks table and index b-trees directly, which is all a .brdb needs.
//
//   const db = await LazySqlite.open(blobSource(file));
//   const t = db.table('files');                        // root page and columns from sqlite_master
//   await db.scan(t, (row) => { ... row.values ... });  // values past the local payload are undefined
//   const r = await db.row(db.table('blobs'), 42);      // by rowid
//   const content = await db.column(r!, 6);             // follows the overflow chain
//
// File format: https://www.sqlite.org/fileformat2.html. Supported: any page size, reserved
// bytes, UTF-8 / UTF-16 text, rowid tables (INTEGER PRIMARY KEY aliases the rowid) and indexes,
// overflow chains. Not supported: WITHOUT ROWID tables, and the -wal file (a database in WAL
// mode is read as its main file alone, like sqlite3 with immutable=1; header.wal says so).
// DOM-free: Blob and fetch are only touched by the adapters that take them.

import type { SqlValue } from './sql.ts';

/** Random access to a file's bytes. readAt must return exactly `length` bytes. */
export interface RandomAccessSource {
  readonly size: number;
  readAt(offset: number, length: number): Promise<Uint8Array>;
}

/** Bytes already in memory (tests, small files). */
export function bytesSource(bytes: Uint8Array): RandomAccessSource {
  return {
    size: bytes.length,
    readAt: (o, n) => {
      if (o < 0 || o + n > bytes.length) return Promise.reject(new RangeError(`read ${o}+${n} past the end (${bytes.length})`));
      return Promise.resolve(bytes.subarray(o, o + n));
    },
  };
}

/** A File or Blob (a dropped file): Blob.slice reads only the bytes asked for. Works in workers. */
export function blobSource(blob: Blob): RandomAccessSource {
  return {
    size: blob.size,
    readAt: async (o, n) => {
      if (o < 0 || o + n > blob.size) throw new RangeError(`read ${o}+${n} past the end (${blob.size})`);
      return new Uint8Array(await blob.slice(o, o + n).arrayBuffer());
    },
  };
}

export interface HttpRangeOptions {
  /** fetch to use (default globalThis.fetch). */
  fetch?: typeof fetch;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

/**
 * A file served over HTTP with Range support. The size comes from a first one-byte range request
 * (Content-Range). Throws if the server ignores Range (status 200), rather than download it all.
 */
export async function httpRangeSource(url: string, opts: HttpRangeOptions = {}): Promise<RandomAccessSource> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const get = async (o: number, n: number): Promise<{ bytes: Uint8Array; total: number | null }> => {
    const res = await f(url, { headers: { ...opts.headers, Range: `bytes=${o}-${o + n - 1}` } });
    if (res.status !== 206) throw new Error(`${url}: expected 206 Partial Content for a range request, got ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const m = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') ?? '');
    return { bytes, total: m ? Number(m[1]) : null };
  };
  const probe = await get(0, 1);
  if (probe.total === null) throw new Error(`${url}: no Content-Range total in the range response`);
  const size = probe.total;
  return {
    size,
    readAt: async (o, n) => {
      if (o < 0 || o + n > size) throw new RangeError(`read ${o}+${n} past the end (${size})`);
      const { bytes } = await get(o, n);
      if (bytes.length !== n) throw new Error(`${url}: asked for ${n} bytes at ${o}, got ${bytes.length}`);
      return bytes;
    },
  };
}

export interface SqliteHeader {
  pageSize: number;
  /** Bytes reserved at the end of each page (usable size = pageSize - reserved). */
  reserved: number;
  usableSize: number;
  pageCount: number;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  /** True when the file is in WAL mode: commits still in the -wal file are not seen. */
  wal: boolean;
  schemaFormat: number;
  userVersion: number;
  applicationId: number;
  changeCounter: number;
}

export interface MasterRow {
  type: string;
  name: string;
  tblName: string;
  rootpage: number;
  sql: string | null;
}

export interface TableInfo {
  name: string;
  root: number;
  /** Column names in declaration order. */
  columns: string[];
  /** Index of the INTEGER PRIMARY KEY column (its value is the rowid), or -1. */
  rowidColumn: number;
}

export interface IndexInfo {
  name: string;
  table: string;
  root: number;
  /** Indexed column names; every key ends with the rowid after them. */
  columns: string[];
}

/** A table row. Columns stored past the cell's local payload (on overflow pages) are undefined until read with column(). */
export interface LazyRow {
  rowid: number;
  values: (SqlValue | undefined)[];
  /** Total record bytes. */
  readonly payloadSize: number;
  /** @internal where the rest of the payload lives */
  readonly cell: CellRef;
}

/** @internal */
export interface CellRef {
  local: Uint8Array;
  payloadSize: number;
  overflow: number;
  table: TableInfo;
  rowid: number;
}

export interface ReadStats {
  /** Bytes fetched from the source. */
  bytesRead: number;
  /** readAt calls. */
  reads: number;
  /** b-tree pages served from the cache. */
  pageHits: number;
  /** b-tree pages fetched. */
  pageMisses: number;
  /** Overflow pages consumed. */
  overflowPages: number;
  /** Bytes read ahead on overflow chains that turned out not to be contiguous. */
  wastedBytes: number;
}

export interface LazySqliteOptions {
  /** Byte budget of the b-tree page cache (default 4 MB). Overflow pages are never cached. */
  cacheBytes?: number;
}

const MAGIC = 'SQLite format 3\0';
const LEAF_TABLE = 0x0d, INTERIOR_TABLE = 0x05, LEAF_INDEX = 0x0a, INTERIOR_INDEX = 0x02;
/** Longest single read when reading an overflow chain ahead (pages). */
const MAX_RUN = 2048;

/** A SQLite varint at `o`: [value, bytes used]. Values past 2^53 lose precision (none in a .brdb). */
export function readVarint(b: Uint8Array, o: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const x = b[o + i]!;
    v = v * 128 + (x & 0x7f);
    if (x < 0x80) return [v, i + 1];
  }
  return [v * 256 + b[o + 8]!, 9];
}

const u16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const u32 = (b: Uint8Array, o: number): number => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;

/** Bytes a value of this serial type takes in a record. */
function serialLen(t: number): number {
  if (t < 12) return [0, 1, 2, 3, 4, 6, 8, 8, 0, 0, 0, 0][t]!;
  return (t - (t & 1 ? 13 : 12)) / 2;
}

/** Signed big-endian integer of n bytes (n <= 8): a number when safe, else a bigint. */
function readInt(b: Uint8Array, o: number, n: number): number | bigint {
  if (n <= 6) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + b[o + i]!;
    return b[o]! & 0x80 ? v - 256 ** n : v;
  }
  const dv = new DataView(b.buffer, b.byteOffset + o, 8), big = dv.getBigInt64(0);
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}

/** An LRU of pages with a byte budget. */
class PageCache {
  private readonly map = new Map<number, Uint8Array>();
  private bytes = 0;
  constructor(readonly budget: number) {}

  get(n: number): Uint8Array | undefined {
    const p = this.map.get(n);
    if (p) { this.map.delete(n); this.map.set(n, p); }
    return p;
  }

  has(n: number): boolean {
    return this.map.has(n);
  }

  set(n: number, p: Uint8Array): void {
    if (this.map.has(n)) { this.map.delete(n); this.bytes -= p.length; }
    this.map.set(n, p);
    this.bytes += p.length;
    while (this.bytes > this.budget && this.map.size > 1) {
      const [k, v] = this.map.entries().next().value!;
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.bytes;
  }
}

/** Splits a CREATE TABLE / CREATE INDEX column list into its top-level parts. */
function columnList(sql: string): string[] {
  const start = sql.indexOf('('), parts: string[] = [];
  if (start < 0) return parts;
  let depth = 0, cur = '', quote = '';
  for (let i = start + 1; i < sql.length; i++) {
    const c = sql[i]!;
    if (quote) { cur += c; if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`' || c === '[') { quote = c === '[' ? ']' : c; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') { if (depth === 0) { parts.push(cur.trim()); return parts; } depth--; }
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return parts;
}

const unquote = (s: string): string => (/^["`[']/.test(s) ? s.slice(1, -1) : s);
const firstWord = (s: string): string => unquote(/^("[^"]*"|`[^`]*`|\[[^\]]*\]|'[^']*'|\S+)/.exec(s)?.[1] ?? '');

/** Column names and the rowid alias of a CREATE TABLE statement. */
export function parseCreateTable(sql: string): { columns: string[]; rowidColumn: number; withoutRowid: boolean } {
  const columns: string[] = [];
  let rowidColumn = -1;
  for (const part of columnList(sql)) {
    if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(part)) continue;
    const name = firstWord(part);
    if (/^\S+\s+INTEGER\s+PRIMARY\s+KEY\b/i.test(part) && !/\bDESC\b/i.test(part)) rowidColumn = columns.length;
    columns.push(name);
  }
  const tail = sql.slice(sql.lastIndexOf(')') + 1);
  return { columns, rowidColumn, withoutRowid: /WITHOUT\s+ROWID/i.test(tail) };
}

/** SQLite's order of values (BINARY collation): NULL < numbers < text < blobs. */
export function compareValues(a: SqlValue | undefined, b: SqlValue | undefined): number {
  const rank = (v: SqlValue | undefined): number => (v === null || v === undefined ? 0 : typeof v === 'number' || typeof v === 'bigint' ? 1 : typeof v === 'string' ? 2 : 3);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (ra === 2) {
    // code point order = UTF-8 byte order
    const x = a as string, y = b as string;
    for (let i = 0, j = 0; i < x.length && j < y.length;) {
      const cx = x.codePointAt(i)!, cy = y.codePointAt(j)!;
      if (cx !== cy) return cx - cy;
      i += cx > 0xffff ? 2 : 1; j += cy > 0xffff ? 2 : 1;
    }
    return [...x].length - [...y].length;
  }
  const x = a as Uint8Array, y = b as Uint8Array, n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** Compares the first prefix.length columns of a key with a prefix. */
function comparePrefix(key: readonly SqlValue[], prefix: readonly SqlValue[]): number {
  for (let i = 0; i < prefix.length; i++) {
    const c = compareValues(key[i], prefix[i]);
    if (c) return c;
  }
  return 0;
}

interface PageHeader {
  type: number;
  cells: number;
  /** Offset of the cell pointer array within the page. */
  ptrs: number;
  right: number;
}

/** An open database file. Read-only; nothing is ever written to the source. */
export class LazySqlite {
  readonly header: SqliteHeader;
  /** sqlite_master, in rowid order. */
  master: MasterRow[] = [];
  readonly stats: ReadStats = { bytesRead: 0, reads: 0, pageHits: 0, pageMisses: 0, overflowPages: 0, wastedBytes: 0 };
  private readonly cache: PageCache;
  private readonly inflight = new Map<number, Promise<Uint8Array>>();
  private readonly text: TextDecoder;
  private readonly masterTable: TableInfo = { name: 'sqlite_master', root: 1, columns: ['type', 'name', 'tbl_name', 'rootpage', 'sql'], rowidColumn: -1 };

  private constructor(readonly source: RandomAccessSource, first: Uint8Array, opts: LazySqliteOptions) {
    for (let i = 0; i < 16; i++) if (first[i] !== MAGIC.charCodeAt(i)) throw new Error('not a SQLite database (bad header)');
    const raw = u16(first, 16), pageSize = raw === 1 ? 65536 : raw;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1))) throw new Error(`SQLite: bad page size ${raw}`);
    const reserved = first[20]!, enc = u32(first, 56), changeCounter = u32(first, 24);
    const inHeader = u32(first, 28), valid = u32(first, 92) === changeCounter && inHeader > 0;
    this.header = {
      pageSize, reserved, usableSize: pageSize - reserved,
      pageCount: valid ? inHeader : Math.floor(source.size / pageSize),
      encoding: enc === 2 ? 'utf-16le' : enc === 3 ? 'utf-16be' : 'utf-8',
      wal: first[18] === 2 || first[19] === 2,
      schemaFormat: u32(first, 44), userVersion: u32(first, 60), applicationId: u32(first, 68), changeCounter,
    };
    this.text = new TextDecoder(this.header.encoding);
    this.cache = new PageCache(Math.max(opts.cacheBytes ?? 4 << 20, pageSize * 4));
  }

  /** Opens a database: reads the header and sqlite_master (usually just page 1). */
  static async open(source: RandomAccessSource, opts: LazySqliteOptions = {}): Promise<LazySqlite> {
    if (source.size < 100) throw new Error('not a SQLite database (too short)');
    const first = await source.readAt(0, 100);
    const db = new LazySqlite(source, first, opts);
    db.stats.bytesRead += 100; db.stats.reads++;
    await db.scan(db.masterTable, (r) => {
      const [type, name, tbl, root, sql] = r.values;
      db.master.push({ type: String(type), name: String(name), tblName: String(tbl), rootpage: Number(root ?? 0), sql: typeof sql === 'string' ? sql : null });
    }, { full: true });
    return db;
  }

  /** A table from sqlite_master. Throws when it isn't there or is WITHOUT ROWID. */
  table(name: string): TableInfo {
    const m = this.master.find((r) => r.type === 'table' && r.name.toLowerCase() === name.toLowerCase());
    if (!m?.sql) throw new Error(`SQLite: no table ${name}`);
    const p = parseCreateTable(m.sql);
    if (p.withoutRowid) throw new Error(`SQLite: ${name} is a WITHOUT ROWID table (not supported)`);
    return { name: m.name, root: m.rootpage, columns: p.columns, rowidColumn: p.rowidColumn };
  }

  /** An index from sqlite_master, or null. */
  index(name: string): IndexInfo | null {
    const m = this.master.find((r) => r.type === 'index' && r.name.toLowerCase() === name.toLowerCase());
    if (!m?.sql) return null;
    return { name: m.name, table: m.tblName, root: m.rootpage, columns: columnList(m.sql).map(firstWord) };
  }

  /** Drops every cached page. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Bytes held by the page cache now. */
  get cachedBytes(): number {
    return this.cache.size;
  }

  private async read(offset: number, length: number): Promise<Uint8Array> {
    this.stats.bytesRead += length;
    this.stats.reads++;
    const b = await this.source.readAt(offset, length);
    if (b.length !== length) throw new Error(`SQLite: short read at ${offset} (${b.length} of ${length})`);
    return b;
  }

  private checkPage(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > this.header.pageCount) throw new Error(`SQLite: page ${n} out of range (1..${this.header.pageCount}); corrupt file?`);
  }

  /** One b-tree page, through the cache. */
  private page(n: number): Promise<Uint8Array> {
    const hit = this.cache.get(n);
    if (hit) { this.stats.pageHits++; return Promise.resolve(hit); }
    let p = this.inflight.get(n);
    if (!p) {
      this.checkPage(n);
      this.stats.pageMisses++;
      p = this.read((n - 1) * this.header.pageSize, this.header.pageSize)
        .then((b) => { this.cache.set(n, b); return b; })
        .finally(() => this.inflight.delete(n));
      this.inflight.set(n, p);
    }
    return p;
  }

  /** Reads the uncached pages of a list in runs of consecutive page numbers, into the cache. */
  private async prefetch(pages: readonly number[]): Promise<void> {
    const want = [...new Set(pages)].filter((n) => !this.cache.has(n) && !this.inflight.has(n)).sort((a, b) => a - b);
    const ps = this.header.pageSize, jobs: Promise<void>[] = [];
    for (let i = 0; i < want.length;) {
      let j = i + 1;
      while (j < want.length && want[j] === want[j - 1]! + 1 && j - i < MAX_RUN) j++;
      const first = want[i]!, count = j - i;
      this.checkPage(first); this.checkPage(first + count - 1);
      this.stats.pageMisses += count;
      jobs.push(this.read((first - 1) * ps, count * ps).then((b) => {
        for (let k = 0; k < count; k++) this.cache.set(first + k, b.slice(k * ps, (k + 1) * ps));
      }));
      i = j;
    }
    await Promise.all(jobs);
  }

  private pageHeader(b: Uint8Array, n: number): PageHeader {
    const h = n === 1 ? 100 : 0, type = b[h]!;
    const interior = type === INTERIOR_TABLE || type === INTERIOR_INDEX;
    if (!interior && type !== LEAF_TABLE && type !== LEAF_INDEX) throw new Error(`SQLite: page ${n} is not a b-tree page (type ${type})`);
    return { type, cells: u16(b, h + 3), ptrs: h + (interior ? 12 : 8), right: interior ? u32(b, h + 8) : 0 };
  }

  /** Bytes of a payload kept on the b-tree page (the rest is on overflow pages). */
  private localSize(p: number, index: boolean): number {
    const U = this.header.usableSize, X = index ? Math.floor(((U - 12) * 64) / 255) - 23 : U - 35;
    if (p <= X) return p;
    const M = Math.floor(((U - 12) * 32) / 255) - 23, K = M + ((p - M) % (U - 4));
    return K <= X ? K : M;
  }

  /** Payload bytes [0, upto) of a cell, following its overflow chain as far as needed. */
  private async payload(cell: { local: Uint8Array; payloadSize: number; overflow: number }, upto = cell.payloadSize): Promise<Uint8Array> {
    const need = Math.min(upto, cell.payloadSize);
    if (need <= cell.local.length) return cell.local.subarray(0, need);
    const out = new Uint8Array(need);
    out.set(cell.local);
    const ps = this.header.pageSize, per = this.header.usableSize - 4;
    let got = cell.local.length, page = cell.overflow, spec = Infinity;
    while (got < need) {
      this.checkPage(page);
      // Read the rest of the chain at once, assuming its pages are consecutive (the usual case
      // for rows written in one go); drop what turns out to belong elsewhere and continue there.
      const run = Math.min(Math.ceil((need - got) / per), this.header.pageCount - page + 1, MAX_RUN, spec);
      const buf = await this.read((page - 1) * ps, run * ps);
      let used = 0, next = 0;
      for (let i = 0; i < run && got < need; i++) {
        const o = i * ps, n = Math.min(per, need - got);
        next = u32(buf, o);
        out.set(buf.subarray(o + 4, o + 4 + n), got);
        got += n; used++;
        this.stats.overflowPages++;
        if (got < need && next !== page + i + 1) break;
      }
      if (used < run) { this.stats.wastedBytes += (run - used) * ps; spec = Math.max(1, used); }
      page = next;
      if (got < need && page === 0) throw new Error('SQLite: overflow chain ends early; corrupt file?');
    }
    return out;
  }

  private decodeValue(b: Uint8Array, o: number, t: number): SqlValue {
    switch (t) {
      case 0: return null;
      case 1: return (b[o]! << 24) >> 24;
      case 2: return (u16(b, o) << 16) >> 16;
      case 3: return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8)) >> 8;
      case 4: return u32(b, o) | 0;
      case 5: return readInt(b, o, 6);
      case 6: return readInt(b, o, 8);
      case 7: return new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0);
      case 8: return 0;
      case 9: return 1;
      case 10: case 11: throw new Error(`SQLite: reserved serial type ${t}`);
      default: {
        const n = serialLen(t), v = b.subarray(o, o + n);
        return t & 1 ? this.text.decode(v) : v.slice();
      }
    }
  }

  /** Decodes a record. Columns that don't fit in `b` (the payload read so far) come back undefined. */
  private decodeRecord(b: Uint8Array): (SqlValue | undefined)[] {
    const [hlen, hl] = readVarint(b, 0);
    if (hlen > b.length) return [];
    const out: (SqlValue | undefined)[] = [];
    let h = hl, o = hlen;
    while (h < hlen) {
      const [t, n] = readVarint(b, h);
      h += n;
      const len = serialLen(t);
      out.push(o + len <= b.length ? this.decodeValue(b, o, t) : undefined);
      o += len;
    }
    return out;
  }

  private tableCell(page: Uint8Array, at: number, table: TableInfo): LazyRow {
    let o = at;
    const [p, n1] = readVarint(page, o); o += n1;
    const [rowid, n2] = readVarint(page, o); o += n2;
    const local = this.localSize(p, false);
    const cell: CellRef = { local: page.subarray(o, o + local), payloadSize: p, overflow: local < p ? u32(page, o + local) : 0, table, rowid };
    return { rowid, values: [], payloadSize: p, cell };
  }

  private async finishRow(r: LazyRow, full: boolean): Promise<LazyRow> {
    let bytes = r.cell.local;
    // A record header that runs past the local bytes (very wide rows) needs the payload first.
    if (full || (bytes.length < r.payloadSize && readVarint(bytes, 0)[0] > bytes.length)) bytes = await this.payload(r.cell);
    r.values = this.fixRow(this.decodeRecord(bytes), r);
    return r;
  }

  private fixRow(vals: (SqlValue | undefined)[], r: LazyRow): (SqlValue | undefined)[] {
    const t = r.cell.table;
    // Columns added by ALTER TABLE after a row was written are missing from it: NULL.
    while (vals.length < t.columns.length) vals.push(r.payloadSize > r.cell.local.length ? undefined : null);
    if (t.rowidColumn >= 0) vals[t.rowidColumn] = r.rowid;
    return vals;
  }

  /**
   * Every row of a table in rowid order. Only b-tree pages are read: columns that start on
   * overflow pages are left undefined unless `full` is set. Leaves are read ahead in runs.
   */
  async scan(table: TableInfo, cb: (row: LazyRow) => void, opts: { full?: boolean } = {}): Promise<void> {
    const group = Math.max(1, Math.floor(this.cache.budget / 2 / this.header.pageSize));
    const walk = async (n: number): Promise<void> => {
      const b = await this.page(n), h = this.pageHeader(b, n);
      if (h.type === LEAF_TABLE) {
        for (let i = 0; i < h.cells; i++) cb(await this.finishRow(this.tableCell(b, u16(b, h.ptrs + 2 * i), table), !!opts.full));
        return;
      }
      if (h.type !== INTERIOR_TABLE) throw new Error(`SQLite: page ${n} of table ${table.name} is an index page`);
      const kids: number[] = [];
      for (let i = 0; i < h.cells; i++) kids.push(u32(b, u16(b, h.ptrs + 2 * i)));
      kids.push(h.right);
      for (let i = 0; i < kids.length; i += group) {
        const part = kids.slice(i, i + group);
        await this.prefetch(part);
        for (const k of part) await walk(k);
      }
    };
    await walk(table.root);
  }

  /** One row by rowid (b-tree descent), or null. */
  async row(table: TableInfo, rowid: number, opts: { full?: boolean } = {}): Promise<LazyRow | null> {
    let n = table.root;
    for (let depth = 0; depth < 64; depth++) {
      const b = await this.page(n), h = this.pageHeader(b, n);
      if (h.type === LEAF_TABLE) {
        let lo = 0, hi = h.cells - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1, at = u16(b, h.ptrs + 2 * mid);
          const [, n1] = readVarint(b, at), [key] = readVarint(b, at + n1);
          if (key === rowid) return this.finishRow(this.tableCell(b, at, table), !!opts.full);
          if (key < rowid) lo = mid + 1; else hi = mid - 1;
        }
        return null;
      }
      if (h.type !== INTERIOR_TABLE) throw new Error(`SQLite: page ${n} of table ${table.name} is an index page`);
      // first cell whose key >= rowid holds it in its left child; else the right-most child
      let lo = 0, hi = h.cells;
      while (lo < hi) {
        const mid = (lo + hi) >> 1, at = u16(b, h.ptrs + 2 * mid), [key] = readVarint(b, at + 4);
        if (key < rowid) lo = mid + 1; else hi = mid;
      }
      n = lo < h.cells ? u32(b, u16(b, h.ptrs + 2 * lo)) : h.right;
    }
    throw new Error(`SQLite: table ${table.name} b-tree too deep; corrupt file?`);
  }

  /** One column of a row, reading overflow pages when it lives there. */
  async column(row: LazyRow, i: number): Promise<SqlValue> {
    const v = row.values[i];
    if (v !== undefined) return v;
    if (i < 0 || i >= row.cell.table.columns.length) throw new RangeError(`no column ${i} in ${row.cell.table.name}`);
    const all = this.fixRow(this.decodeRecord(await this.payload(row.cell)), row);
    row.values = all;
    return all[i] ?? null;
  }

  /** A column by name. */
  columnByName(row: LazyRow, name: string): Promise<SqlValue> {
    return this.column(row, row.cell.table.columns.indexOf(name));
  }

  private async indexKey(b: Uint8Array, at: number, interior: boolean): Promise<SqlValue[]> {
    let o = at + (interior ? 4 : 0);
    const [p, n] = readVarint(b, o); o += n;
    const local = this.localSize(p, true);
    const cell = { local: b.subarray(o, o + local), payloadSize: p, overflow: local < p ? u32(b, o + local) : 0 };
    return this.decodeRecord(await this.payload(cell)) as SqlValue[];
  }

  /**
   * Index keys in order (each is the indexed columns then the rowid). With `prefix`, only keys
   * whose first columns equal it, found by descending the b-tree. Return false from cb to stop.
   */
  async scanIndex(index: IndexInfo, cb: (key: SqlValue[]) => boolean | void, prefix: readonly SqlValue[] = []): Promise<void> {
    const group = Math.max(1, Math.floor(this.cache.budget / 2 / this.header.pageSize));
    // true = stop (past the prefix range, or cb said so)
    const walk = async (n: number): Promise<boolean> => {
      const b = await this.page(n), h = this.pageHeader(b, n);
      if (h.type === LEAF_INDEX) {
        for (let i = 0; i < h.cells; i++) {
          const key = await this.indexKey(b, u16(b, h.ptrs + 2 * i), false), c = comparePrefix(key, prefix);
          if (c > 0) return true;
          if (c === 0 && cb(key) === false) return true;
        }
        return false;
      }
      if (h.type !== INTERIOR_INDEX) throw new Error(`SQLite: page ${n} of index ${index.name} is a table page`);
      const keys: SqlValue[][] = [], kids: number[] = [];
      for (let i = 0; i < h.cells; i++) {
        const at = u16(b, h.ptrs + 2 * i);
        kids.push(u32(b, at));
        keys.push(await this.indexKey(b, at, true));
      }
      kids.push(h.right);
      // the children that can hold keys in range: left of every key >= prefix, up to the first key > prefix
      let first = keys.findIndex((k) => comparePrefix(k, prefix) >= 0);
      if (first < 0) first = keys.length;
      let last = keys.findIndex((k) => comparePrefix(k, prefix) > 0);
      if (last < 0) last = keys.length;
      for (let g = first; g <= last; g += group) {
        await this.prefetch(kids.slice(g, Math.min(last + 1, g + group)));
        for (let i = g; i <= last && i < g + group; i++) {
          if (await walk(kids[i]!)) return true;
          if (i < keys.length) {
            const c = comparePrefix(keys[i]!, prefix);
            if (c > 0) return true;
            if (c === 0 && cb(keys[i]!) === false) return true;
          }
        }
      }
      return last < keys.length;
    };
    await walk(index.root);
  }
}
