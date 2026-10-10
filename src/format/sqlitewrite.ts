// A small pure-TS SQLite writer: builds a FRESH database file from rows in one pass, no wasm. It
// only does what a new .brdb needs: rowid tables (an INTEGER PRIMARY KEY column is the rowid) and
// plain indexes over columns, fixed CREATE statements, UTF-8, 4096-byte pages, no free pages.
// Values are null, integers (safe JS numbers), text and blobs; no floats.
//
// File format: https://www.sqlite.org/fileformat2.html. B-trees are built bottom up from sorted
// rows: table trees keep every row in the leaves (interior cells = child + its largest rowid);
// index trees keep each key once, the keys between two siblings moving up as dividers. Payloads
// that don't fit a page spill into overflow page chains. Page 1 holds the header and the schema
// table (sqlite_master), so it's written last, when the root pages are known.

import { compareValues } from './sqlitelazy.ts';
import type { SqlValue } from './sql.ts';

export interface SqliteTable {
  name: string;
  /** The CREATE TABLE statement, stored verbatim. */
  sql: string;
  /** [rowid, column values]; the INTEGER PRIMARY KEY column (if any) must be null here. Any order. */
  rows: [rowid: number, values: SqlValue[]][];
}

export interface SqliteIndex {
  name: string;
  table: string;
  sql: string;
  /** The indexed columns, as positions in the table's rows. */
  columns: number[];
}

const PAGE = 4096;
const enc = new TextEncoder();

/** SQLite varint (big-endian base 128, 9th byte takes 8 bits). Numbers here stay below 2^53. */
function varint(out: number[], v: number): void {
  if (v < 0 || v > Number.MAX_SAFE_INTEGER) throw new RangeError(`varint out of range: ${v}`);
  if (v < 0x80) { out.push(v); return; }
  const b: number[] = [];
  while (v > 0) { b.push(v % 128); v = Math.floor(v / 128); }
  for (let i = b.length - 1; i >= 0; i--) out.push(b[i]! | (i ? 0x80 : 0));
}
const varintLen = (v: number): number => { const o: number[] = []; varint(o, v); return o.length; };

/** Serial type and body bytes of one value. */
function serial(v: SqlValue): [number, Uint8Array] {
  if (v === null) return [0, new Uint8Array(0)];
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError(`only integers can be written, not ${v}`);
    if (v === 0) return [8, new Uint8Array(0)];
    if (v === 1) return [9, new Uint8Array(0)];
    const [t, n] = v >= -128 && v < 128 ? [1, 1] : v >= -32768 && v < 32768 ? [2, 2] : v >= -8388608 && v < 8388608 ? [3, 3]
      : v >= -2147483648 && v < 2147483648 ? [4, 4] : v >= -(2 ** 47) && v < 2 ** 47 ? [5, 6] : [6, 8];
    const b = new Uint8Array(n);
    let x = BigInt.asUintN(n * 8, BigInt(v));
    for (let i = n - 1; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
    return [t, b];
  }
  if (typeof v === 'string') { const b = enc.encode(v); return [b.length * 2 + 13, b]; }
  return [v.length * 2 + 12, v];
}

/** A record: header (size + serial types) then the bodies. */
export function record(values: readonly SqlValue[]): Uint8Array {
  const parts = values.map(serial), types: number[] = [];
  for (const [t] of parts) varint(types, t);
  let hdr = types.length + 1;
  if (varintLen(hdr) > 1) hdr = types.length + varintLen(types.length + 2);
  const head: number[] = [];
  varint(head, hdr);
  const out = new Uint8Array(hdr + parts.reduce((s, [, b]) => s + b.length, 0));
  out.set(head, 0); out.set(types, head.length);
  let at = hdr;
  for (const [, b] of parts) { out.set(b, at); at += b.length; }
  return out;
}

/** How many payload bytes stay in the cell (the rest spills); the format's X / M / K rule. */
function localSize(P: number, index: boolean): number {
  const U = PAGE, X = index ? Math.floor(((U - 12) * 64) / 255) - 23 : U - 35, M = Math.floor(((U - 12) * 32) / 255) - 23;
  if (P <= X) return P;
  const K = M + ((P - M) % (U - 4));
  return K <= X ? K : M;
}

/** Bytes a cell takes on its page (cell + pointer), without writing any overflow pages. */
function cellCost(prefix: number, P: number, index: boolean): number {
  const local = localSize(P, index);
  return prefix + local + (local < P ? 4 : 0) + 2;
}

/** Allocates and fills pages; page n lives at pages[n - 1]. */
class Pager {
  readonly pages: Uint8Array[] = [new Uint8Array(PAGE)];
  alloc(): [number, Uint8Array] { const p = new Uint8Array(PAGE); this.pages.push(p); return [this.pages.length, p]; }

  /**
   * The cell bytes for a payload: the local part plus, when it spills, the overflow page number
   * (the chain is written now). maxLocal / minLocal follow the format's X / M for the tree kind.
   */
  spill(prefix: number[], payload: Uint8Array, index: boolean): Uint8Array {
    const U = PAGE, P = payload.length, local = localSize(P, index);
    const cell = new Uint8Array(prefix.length + local + (local < P ? 4 : 0));
    cell.set(prefix, 0); cell.set(payload.subarray(0, local), prefix.length);
    if (local < P) {
      // write the chain back to front so each page knows its successor
      const chunks: Uint8Array[] = [];
      for (let at = local; at < P; at += U - 4) chunks.push(payload.subarray(at, Math.min(P, at + U - 4)));
      let next = 0;
      const nums = chunks.map(() => this.alloc());
      for (let i = chunks.length - 1; i >= 0; i--) {
        const [n, pg] = nums[i]!;
        new DataView(pg.buffer).setUint32(0, next); pg.set(chunks[i]!, 4); next = n;
      }
      new DataView(cell.buffer).setUint32(cell.length - 4, next);
    }
    return cell;
  }

  /** Writes a b-tree page: type, cells (in order), right pointer for interior pages. */
  page(num: number, type: number, cells: readonly Uint8Array[], right = 0): void {
    const pg = this.pages[num - 1]!, dv = new DataView(pg.buffer), base = num === 1 ? 100 : 0;
    const hsize = right ? 12 : 8;
    let end = PAGE;
    pg[base] = type;
    dv.setUint16(base + 3, cells.length);
    cells.forEach((c, i) => {
      end -= c.length;
      if (end < base + hsize + 2 * cells.length) throw new Error('sqlite writer: page overflow');
      pg.set(c, end); dv.setUint16(base + hsize + 2 * i, end);
    });
    dv.setUint16(base + 5, end);
    if (right) dv.setUint32(base + 8, right);
  }
}

const LEAF_ROOM = PAGE - 8, INNER_ROOM = PAGE - 12;

/** A table b-tree from rows sorted by rowid. Returns the root page. */
function tableTree(pg: Pager, rows: readonly [number, SqlValue[]][]): number {
  // leaves
  let level: { page: number; max: number }[] = [];
  let cells: Uint8Array[] = [], used = 0, max = 0;
  const flush = (): void => { const [n] = pg.alloc(); pg.page(n, 0x0d, cells); level.push({ page: n, max }); cells = []; used = 0; };
  for (const [rowid, vals] of rows) {
    const payload = record(vals), pre: number[] = [];
    varint(pre, payload.length); varint(pre, rowid);
    const c = pg.spill(pre, payload, false), cost = c.length + 2;
    if (cells.length && used + cost > LEAF_ROOM) flush();
    cells.push(c); used += cost; max = rowid;
  }
  flush();
  // interior levels: each page takes children evenly (cells are tiny and alike)
  while (level.length > 1) {
    const per = Math.floor(INNER_ROOM / (2 + 4 + 9)), groups = Math.ceil(level.length / per), next: typeof level = [];
    for (let g = 0; g < groups; g++) {
      const kids = level.slice(Math.floor((g * level.length) / groups), Math.floor(((g + 1) * level.length) / groups));
      const cs = kids.slice(0, -1).map((k) => { const b: number[] = [0, 0, 0, 0]; varint(b, k.max); const u = new Uint8Array(b); new DataView(u.buffer).setUint32(0, k.page); return u; });
      const last = kids[kids.length - 1]!, [n] = pg.alloc();
      pg.page(n, 0x05, cs, last.page);
      next.push({ page: n, max: last.max });
    }
    level = next;
  }
  return level[0]!.page;
}

/** An index b-tree from sorted keys. Returns the root page. */
function indexTree(pg: Pager, keys: readonly SqlValue[][]): number {
  const records = keys.map((k) => record(k));
  const cost = (i: number, interior: boolean): number => cellCost((interior ? 4 : 0) + varintLen(records[i]!.length), records[i]!.length, true);
  const cellOf = (i: number, child: number): Uint8Array => {
    const pre: number[] = child ? [0, 0, 0, 0] : [];
    varint(pre, records[i]!.length);
    const c = pg.spill(pre, records[i]!, true);
    if (child) new DataView(c.buffer).setUint32(0, child);
    return c;
  };
  // leaves: a key that doesn't fit becomes the divider up to the next level
  let children: number[] = [], dividers: number[] = [];
  {
    let page: number[] = [], used = 0;
    const flush = (): void => { const [n] = pg.alloc(); pg.page(n, 0x0a, page.map((k) => cellOf(k, 0))); children.push(n); page = []; used = 0; };
    for (let i = 0; i < keys.length; i++) {
      const c = cost(i, false);
      if (page.length && used + c > LEAF_ROOM) {
        // the last key never goes up alone (the last leaf would be empty): the one before it does
        if (i === keys.length - 1) { dividers.push(page.pop()!); flush(); page = [i]; used = c; continue; }
        flush(); dividers.push(i); continue;
      }
      page.push(i); used += c;
    }
    flush();
  }
  // interior levels: children c0..cn with dividers d0..dn-1 between them
  while (children.length > 1) {
    const kids: number[] = [], ups: number[] = [];
    let cells: [key: number, child: number][] = [], used = 0, right = children[0]!;
    const close = (): void => { const [n] = pg.alloc(); pg.page(n, 0x02, cells.map(([k, ch]) => cellOf(k, ch)), right); kids.push(n); cells = []; used = 0; };
    for (let i = 0; i < dividers.length; i++) {
      const d = dividers[i]!, c = cost(d, true);
      if (cells.length && used + c > INNER_ROOM) {
        if (i === dividers.length - 1) {
          // keep the last page non-empty: the previous divider moves up instead
          const [pk, pc] = cells.pop()!;
          const after = right; right = pc; close(); ups.push(pk);
          cells = [[d, after]]; used = c; right = children[i + 1]!;
          continue;
        }
        close(); ups.push(d); right = children[i + 1]!; continue;
      }
      cells.push([d, right]); used += c; right = children[i + 1]!;
    }
    close();
    children = kids; dividers = ups;
  }
  return children[0]!;
}

const compareKeys = (a: readonly SqlValue[], b: readonly SqlValue[]): number => {
  for (let i = 0; i < a.length; i++) { const c = compareValues(a[i], b[i]); if (c) return c; }
  return 0;
};

export type SqliteObject = ({ type: 'table' } & SqliteTable) | ({ type: 'index' } & SqliteIndex);

/** The whole database file. Objects go in sqlite_master in the order given; an index after its table. */
export function writeSqlite(objects: readonly SqliteObject[], opts: { userVersion?: number } = {}): Uint8Array {
  const pg = new Pager();
  const master: [number, SqlValue[]][] = [];
  const tables = new Map<string, readonly [number, SqlValue[]][]>();
  for (const o of objects) {
    if (o.type === 'table') {
      const rows = [...o.rows].sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < rows.length; i++) if (rows[i]![0] === rows[i - 1]![0]) throw new Error(`${o.name}: duplicate rowid ${rows[i]![0]}`);
      tables.set(o.name, rows);
      master.push([master.length + 1, ['table', o.name, o.name, tableTree(pg, rows), o.sql]]);
    } else {
      const rows = tables.get(o.table);
      if (!rows) throw new Error(`index ${o.name}: no table ${o.table} before it`);
      const keys = rows.map(([id, v]) => [...o.columns.map((c) => v[c] ?? null), id]).sort(compareKeys);
      master.push([master.length + 1, ['index', o.name, o.table, indexTree(pg, keys), o.sql]]);
    }
  }
  // page 1: the schema table (it must fit one page: a handful of CREATE statements)
  const cells = master.map(([id, v]) => { const payload = record(v), pre: number[] = []; varint(pre, payload.length); varint(pre, id); return pg.spill(pre, payload, false); });
  if (cells.reduce((s, c) => s + c.length + 2, 0) > PAGE - 100 - 8) throw new Error('sqlite writer: schema too big for page 1');
  pg.page(1, 0x0d, cells);

  const n = pg.pages.length, out = new Uint8Array(n * PAGE);
  pg.pages.forEach((p, i) => out.set(p, i * PAGE));
  const dv = new DataView(out.buffer);
  out.set(enc.encode('SQLite format 3\0'), 0);
  dv.setUint16(16, PAGE);
  out[18] = 1; out[19] = 1;                // legacy (rollback journal) read / write versions
  out[20] = 0; out[21] = 64; out[22] = 32; out[23] = 32;
  dv.setUint32(24, 1);                     // file change counter
  dv.setUint32(28, n);                     // database size in pages
  dv.setUint32(40, 1);                     // schema cookie
  dv.setUint32(44, 4);                     // schema format 4
  dv.setUint32(56, 1);                     // UTF-8
  dv.setUint32(60, opts.userVersion ?? 0);
  dv.setUint32(92, 1);                     // version-valid-for = change counter
  dv.setUint32(96, 3046000);               // SQLITE_VERSION_NUMBER of the writer (format-compatible)
  return out;
}
