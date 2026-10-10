// Loading and face culling off the main thread (S-01): the pure halves, shared by the parse worker
// (src/workers/parse.worker.ts), the main thread (src/app/parse.ts) and the unit tests.
//
// A worker has its own copies of the name tables (store.ts ASSETS, MATERIALS, GRIDS, FLAG_NAMES),
// so a store built there numbers its names its own way. It is posted as its columns plus those
// tables (packParsed); adoptParsed renumbers the columns into the main thread's tables.
//
// Face culling of a whole multi-million-brick build (scene/cull.ts) would need several hundred
// bytes a brick of tables at once, so regionMasks splits it into tiles: each tile's occluders are
// culled together with every occluder whose box touches theirs (a face can only be covered by
// bricks touching it), which gives exactly the masks of one culler over everything.

import { readBrz, type FileMap } from '../format/brz.ts';
import { storeFromFiles, type LoadReport, type SeqBrick } from './load.ts';
import type { LoadOrder } from './compmodel.ts';
import { ASSETS, F_ALIVE, F_HAS_FLAGS, FLAG_NAMES, GRIDS, Kind, MATERIALS, SceneStore, worldHalfOf, type StoreColumns } from './store.ts';
import { FaceCuller, FULL_BOX_ASSETS, OPAQUE_MATERIALS, type CullBrick } from './cull.ts';

/** A parsed save as posted by the worker. */
export interface ParsedMsg {
  type: 'store';
  cols: StoreColumns;
  names: { assets: string[]; materials: string[]; grids: string[]; flags: string[] };
  report: Omit<LoadReport, 'name' | 'drawn'>;
  unsupported: SeqBrick[];
  order: LoadOrder;
  /** the save's files, when the worker read them from .brz bytes */
  files?: [string, Uint8Array][];
}

/** What a load hands the main thread: the files, the store and the rest of storeFromFiles's result. */
export interface Parsed { files: FileMap; store: SceneStore; report: Omit<LoadReport, 'name' | 'drawn'>; unsupported: SeqBrick[]; order: LoadOrder }

/** Progress callback: phase, done, total (bricks; total 0 = unknown). */
export type Progress = (phase: 'read' | 'bricks' | 'cull', done: number, total: number) => void;

/** Reads a save (its .brz bytes, or its files) into a store and packs it for posting, with the buffers to transfer. */
export function parseForPost(input: { bytes?: Uint8Array; files?: [string, Uint8Array][] }, progress?: Progress): { msg: ParsedMsg; transfer: ArrayBuffer[]; store: SceneStore } {
  progress?.('read', 0, 0);
  const files: FileMap = input.bytes ? readBrz(input.bytes) : new Map(input.files);
  const r = storeFromFiles(files, (d, t) => progress?.('bricks', d, t));
  const cols = r.store.columns();
  const msg: ParsedMsg = {
    type: 'store', cols, report: r.report, unsupported: r.unsupported, order: r.order,
    names: { assets: ASSETS.list.slice(), materials: MATERIALS.list.slice(), grids: GRIDS.list.slice(), flags: FLAG_NAMES.list.slice() },
  };
  if (input.bytes) msg.files = [...files];
  const bufs = new Set<ArrayBuffer>();
  const add = (a: { buffer: ArrayBufferLike }): void => { if (a.buffer instanceof ArrayBuffer) bufs.add(a.buffer); };
  for (const v of Object.values(cols)) if (ArrayBuffer.isView(v)) add(v);
  add(r.order.seqChunk); add(r.order.seqIndex);
  if (msg.files) for (const [, v] of msg.files) add(v);
  return { msg, transfer: [...bufs], store: r.store };
}

/** A posted store in this thread's name tables (renumbers the asset, material, grid and flag columns in place). */
export function adoptParsed(msg: ParsedMsg, files: FileMap): Parsed {
  const c = msg.cols, n = c.n;
  const remap = (list: string[], T: { id(s: string): number }, col: Uint16Array | Uint8Array): void => {
    const m = list.map((s) => T.id(s));
    if (m.every((v, i) => v === i)) return;
    for (let i = 0; i < n; i++) col[i] = m[col[i]!]!;
  };
  remap(msg.names.assets, ASSETS, c.asset);
  remap(msg.names.materials, MATERIALS, c.material);
  remap(msg.names.grids, GRIDS, c.grid);
  // flag fields: collision bit i stands for flag name i (ids under 16 only, as fastload writes them)
  const fm = msg.names.flags.map((s) => FLAG_NAMES.id(s));
  c.flagFields = c.flagFields.map((f) => fm[f]!);
  if (!fm.every((v, i) => v === i)) {
    for (let i = 0; i < n; i++) {
      if (!(c.flags[i]! & F_HAS_FLAGS)) continue;
      const b = c.collision[i]!;
      let o = 0;
      for (let k = 0; k < 16; k++) if (b & (1 << k) && fm[k]! < 16) o |= 1 << fm[k]!;
      c.collision[i] = o;
    }
  }
  return { files, store: SceneStore.fromColumns(c), report: msg.report, unsupported: msg.unsupported, order: msg.order };
}

/** The columns face culling reads (copies can be kept while the store's own go to the main thread). */
export interface CullColumns { n: number; px: Int32Array; py: Int32Array; pz: Int32Array; hx: Uint16Array; hy: Uint16Array; hz: Uint16Array; orient: Uint8Array; asset: Uint16Array; shape: Uint8Array; material: Uint8Array; grid: Uint16Array; flags: Uint8Array }

/** The face-culling columns of a store (copies of its first n rows). */
export function cullColumnsOf(s: { n: number } & Omit<CullColumns, 'n'>): CullColumns {
  const n = s.n, cut = <T extends { slice(a: number, b: number): T }>(a: T): T => a.slice(0, n);
  return { n, px: cut(s.px), py: cut(s.py), pz: cut(s.pz), hx: cut(s.hx), hy: cut(s.hy), hz: cut(s.hz), orient: cut(s.orient), asset: cut(s.asset), shape: cut(s.shape), material: cut(s.material), grid: cut(s.grid), flags: cut(s.flags) };
}

/** Tile size (units, X and Y) regionMasks culls at a time. */
export const CULL_TILE = 4096;

/**
 * The hidden-face masks (scene/cull.ts) of every row, the same as one FaceCuller over all of them
 * would give, computed a tile at a time. `assets` / `materials`: the names the columns' ids stand
 * for; `skip`: rows to treat as absent (e.g. a selection being moved).
 */
export function regionMasks(c: CullColumns, assets: readonly string[], materials: readonly string[], skip: ReadonlySet<number> | null = null, progress?: Progress): Uint8Array {
  const n = c.n, T = CULL_TILE, out = new Uint8Array(n);
  // 1. the occluders (the only rows that cover or get culled), their boxes and tiles
  const occ: number[] = [], bx: number[] = [];
  const boxAsset = assets.map((a) => FULL_BOX_ASSETS.has(a)), opaque = materials.map((m) => OPAQUE_MATERIALS.has(m || 'BMC_Plastic'));
  for (let i = 0; i < n; i++) {
    if (!(c.flags[i]! & F_ALIVE) || c.shape[i] !== Kind.Box || !boxAsset[c.asset[i]!] || !opaque[c.material[i]!] || (skip && skip.has(i))) continue;
    const h = worldHalfOf(c.orient[i]!, c.hx[i]!, c.hy[i]!, c.hz[i]!);
    if (!(h[0] > 0 && h[1] > 0 && h[2] > 0)) continue;
    occ.push(i);
    bx.push(c.px[i]! - h[0], c.py[i]! - h[1], c.pz[i]! - h[2], c.px[i]! + h[0], c.py[i]! + h[1], c.pz[i]! + h[2]);
  }
  const K = occ.length;
  if (!K) return out;
  const cellKey = (x: number, y: number): number => (x + 1048576) * 2097152 + (y + 1048576);
  const tileKey = (x: number, y: number): number => cellKey(Math.floor(x / T), Math.floor(y / T));
  const tiles = new Map<number, { own: number[]; ext: number[]; box: number[]; seen: number }>();
  for (let k = 0; k < K; k++) {
    const i = occ[k]!, key = tileKey(c.px[i]!, c.py[i]!);
    let t = tiles.get(key);
    if (!t) tiles.set(key, (t = { own: [], ext: [], box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], seen: -1 }));
    t.own.push(k);
    for (let a = 0; a < 3; a++) { t.box[a] = Math.min(t.box[a]!, bx[k * 6 + a]!); t.box[a + 3] = Math.max(t.box[a + 3]!, bx[k * 6 + 3 + a]!); }
  }
  // 2. each tile's box into a coarse grid of T-sized cells, then every occluder into the tiles whose box it touches
  const list = [...tiles.values()], cells = new Map<number, number[]>();
  list.forEach((t, ti) => {
    for (let x = Math.floor(t.box[0]! / T); x <= Math.floor(t.box[3]! / T); x++)
      for (let y = Math.floor(t.box[1]! / T); y <= Math.floor(t.box[4]! / T); y++) {
        const key = cellKey(x, y);
        let l = cells.get(key);
        if (!l) cells.set(key, (l = []));
        l.push(ti);
      }
  });
  for (let k = 0; k < K; k++) {
    const o = k * 6, i = occ[k]!, own = tiles.get(tileKey(c.px[i]!, c.py[i]!))!;
    for (let x = Math.floor(bx[o]! / T); x <= Math.floor(bx[o + 3]! / T); x++)
      for (let y = Math.floor(bx[o + 1]! / T); y <= Math.floor(bx[o + 4]! / T); y++) {
        const l = cells.get(cellKey(x, y));
        if (l) for (const ti of l) {
          const t = list[ti]!, b = t.box;
          if (t === own || t.seen === k) continue;
          t.seen = k;
          if (bx[o]! <= b[3]! && bx[o + 3]! >= b[0]! && bx[o + 1]! <= b[4]! && bx[o + 4]! >= b[1]! && bx[o + 2]! <= b[5]! && bx[o + 5]! >= b[2]!) t.ext.push(k);
        }
      }
  }
  // 3. cull tile by tile: its own occluders first (their masks are kept), then the touching ones
  const brick = (k: number): CullBrick => {
    const o = k * 6;
    return { pos: [(bx[o]! + bx[o + 3]!) / 2, (bx[o + 1]! + bx[o + 4]!) / 2, (bx[o + 2]! + bx[o + 5]!) / 2], half: [(bx[o + 3]! - bx[o]!) / 2, (bx[o + 4]! - bx[o + 1]!) / 2, (bx[o + 5]! - bx[o + 2]!) / 2], shape: 'box', material: 'BMC_Plastic', grid: c.grid[occ[k]!]!, fullBox: true };
  };
  let done = 0;
  for (const t of list) {
    const bricks = [...t.own.map(brick), ...t.ext.map(brick)];
    const m = new FaceCuller(bricks).masks;
    for (let q = 0; q < t.own.length; q++) out[occ[t.own[q]!]!] = m[q]!;
    done += t.own.length;
    progress?.('cull', done, K);
  }
  return out;
}
