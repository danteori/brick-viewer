// Picking and overlap queries through a uniform grid of brick boxes (ported from the legacy viewer),
// kept in step with the SceneStore through scene/sync.ts: rows that change move between cells, a
// row that leaves the grid's bounds (or a new store) rebuilds it. Boxes are absolute viewer units.
// The focused brick is tested on its own with its live box; hidden rows (a selection being moved)
// are skipped. Overlap (collision) queries live in collision.ts. Phase 3 replaces this with the
// CSR SpatialIndex.

import { S } from '../app/state.ts';
import { cutStart } from '../render/cutaway.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { addMirror, syncScene } from './sync.ts';
import type { SceneStore } from './store.ts';

export const pickGrid = {
  dirty: true, cs: 1, org: [0, 0, 0] as number[], dim: [1, 1, 1] as number[],
  cells: [] as (number[] | undefined)[], box: new Float64Array(0), stamp: new Uint32Array(0), q: 0,
  /** the store the grid was built from */
  store: null as SceneStore | null,
};

const ub = new Float64Array(6);
/** row id's box in viewer units into pickGrid.box (NaN when it isn't live) */
function storeBox(s: SceneStore, id: number): void {
  const o = id * 6, B = pickGrid.box;
  if (!s.alive(id)) { B.fill(NaN, o, o + 6); return; }
  s.box(id, ub);
  for (let j = 0; j < 6; j++) B[o + j] = ub[j]! * BRZ_UNIT;
}

/** [x0,y0,z0,x1,y1,z1] cells brick k's stored box covers */
function pickCellRange(k: number): number[] | null {
  const G = pickGrid, b = G.box, o = k * 6, r: number[] = [];
  if (Number.isNaN(b[o])) return null;
  for (let i = 0; i < 3; i++) r[i] = Math.max(0, Math.min(G.dim[i]! - 1, Math.floor((b[o + i]! - G.org[i]!) / G.cs)));
  for (let i = 0; i < 3; i++) r[i + 3] = Math.max(0, Math.min(G.dim[i]! - 1, Math.floor((b[o + 3 + i]! - G.org[i]!) / G.cs)));
  return r;
}
function pickCells(k: number, fn: (c: number) => void): void {
  const G = pickGrid, r = pickCellRange(k), [dx, dy] = G.dim;
  if (!r) return;
  for (let z = r[2]!; z <= r[5]!; z++) for (let y = r[1]!; y <= r[4]!; y++) for (let x = r[0]!; x <= r[3]!; x++) fn((z * dy! + y) * dx! + x);
}

export function pickBuild(): void {
  const G = pickGrid, s = S.scene, N = s.n;
  G.store = s;
  G.box = new Float64Array(Math.max(N, 1) * 6); G.stamp = new Uint32Array(Math.max(N, 1)); G.q = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let live = 0;
  for (let k = 0; k < N; k++) {
    storeBox(s, k);
    if (Number.isNaN(G.box[k * 6])) continue;
    live++;
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, G.box[k * 6 + i]!); hi[i] = Math.max(hi[i]!, G.box[k * 6 + 3 + i]!); }
  }
  if (!live) { lo.fill(0); hi.fill(0); }
  // roughly one brick per cell, capped at ~1M cells; a margin so small edits stay inside
  const ext = [0, 1, 2].map((i) => hi[i]! - lo[i]! + 2), vol = ext[0]! * ext[1]! * ext[2]!;
  G.cs = Math.max(0.2, Math.cbrt(vol / Math.max(1, live)), Math.cbrt(vol / 1e6));
  G.org = lo.map((v) => v - 1); G.dim = ext.map((e) => Math.max(1, Math.ceil(e / G.cs)));
  G.cells = new Array(G.dim[0]! * G.dim[1]! * G.dim[2]!);
  for (let k = 0; k < N; k++) pickCells(k, (c) => { (G.cells[c] || (G.cells[c] = [])).push(k); });
  G.dirty = false;
}

/** row k's box may have changed */
export function pickUpdate(k: number): void {
  const G = pickGrid, s = S.scene;
  if (G.dirty || G.store !== s || k >= G.stamp.length) { G.dirty = true; return; }
  const o = k * 6, old = G.box.slice(o, o + 6);
  storeBox(s, k);
  const nb = G.box.subarray(o, o + 6);
  if (nb.every((v, j) => (Number.isNaN(v) && Number.isNaN(old[j])) || Math.abs(v - old[j]!) < 1e-9)) return;
  for (let i = 0; i < 3; i++)                         // grew past the grid: rebuild on the next query
    if (nb[i]! < G.org[i]! || nb[i + 3]! > G.org[i]! + G.dim[i]! * G.cs) { G.dirty = true; return; }
  const now = nb.slice();
  G.box.set(old, o);
  pickCells(k, (c) => { const a = G.cells[c], j = a ? a.indexOf(k) : -1; if (j >= 0) a!.splice(j, 1); });
  G.box.set(now, o);
  pickCells(k, (c) => { (G.cells[c] || (G.cells[c] = [])).push(k); });
}

export function initSpatial(): void {
  addMirror({
    reset: () => { pickGrid.dirty = true; },
    changed: (_s, ids) => { if (!pickGrid.dirty) for (const k of ids) pickUpdate(k); },
  });
}

/** The pick grid, current with the scene. */
export function pickReady(): typeof pickGrid {
  syncScene();
  if (pickGrid.dirty || pickGrid.store !== S.scene) pickBuild();
  return pickGrid;
}

/** slab test: entry distance and entry axis of ray S + s D against box (l, h), or null */
export function rayBox(Sv: readonly number[], D: readonly number[], l: ArrayLike<number>, h: ArrayLike<number>, lo: number, hi: number): { s: number; ax: number } | null {
  let t0 = lo, t1 = hi, ax = -1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(D[i]!) < 1e-12) { if (Sv[i]! < l[i]! || Sv[i]! > h[i]!) return null; continue; }
    let a = (l[i]! - Sv[i]!) / D[i]!, b = (h[i]! - Sv[i]!) / D[i]!;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) { t0 = a; ax = i; }
    if (b < t1) t1 = b;
    if (t0 > t1) return null;
  }
  return { s: t0, ax };
}

export interface Hit { k: number; s: number; ax: number }

/**
 * The view ray through view-plane point (vx, vy) (relative to the render origin, as the camera):
 * it starts in front of everything visible (the ortho depth range is +-60 around the render
 * origin) and goes straight into the view. Start (absolute) and direction in world X, Y, Z.
 */
export function viewRay(vx: number, vy: number): { S: number[]; D: number[] } {
  const m = S.view, r0 = [m[0]!, m[8]!, m[4]!], r1 = [m[1]!, m[9]!, m[5]!], r2 = [m[2]!, m[10]!, m[6]!];   // view axes in world X,Y,Z
  const o = S.origin;
  return { S: [0, 1, 2].map((i) => o[i]! + (vx * r0[i]! + vy * r1[i]! + 60 * r2[i]!)), D: r2.map((v) => -v) };
}

/**
 * The nearest brick under view-plane point (vx, vy) (relative to the render origin), or null. With
 * the X-ray cutaway on the ray starts where it leaves the cone (cutStart), so surfaces cut away are
 * passed through; a brick the cone cuts into is hit where the ray leaves the cone. The focused brick
 * is never cut.
 */
export function pickRay(vx: number, vy: number): Hit | null {
  const { S: Sv, D } = viewRay(vx, vy), SMAX = 120;
  const s0c = Math.max(0, cutStart(Sv, D));                 // 0 unless the X-ray cutaway is on
  let best: Hit | null = null;
  const s0 = rayBox(Sv, D, S.dlo, S.dhi, 0, SMAX);
  if (s0 && S.sel >= 0 && S.scene.alive(S.sel) && !S.hidden.has(S.sel)) best = { k: S.sel, s: s0.s, ax: s0.ax };
  if (!S.scene.count) return best;
  const G = pickReady(), Sg = Sv;
  // clip the ray to the grid, then walk its cells (3D DDA), stopping once a hit beats the cell exit
  const gl0 = G.org, gh0 = G.org.map((v, i) => v + G.dim[i]! * G.cs);
  const span = rayBox(Sg, D, gl0, gh0, s0c, SMAX);
  if (!span) return best;
  let tEnd = SMAX;
  for (let i = 0; i < 3; i++) if (Math.abs(D[i]!) >= 1e-12) tEnd = Math.min(tEnd, Math.max((gl0[i]! - Sg[i]!) / D[i]!, (gh0[i]! - Sg[i]!) / D[i]!));
  const t = span.s, c: number[] = [], stp: number[] = [], tMax: number[] = [], tDel: number[] = [];
  for (let i = 0; i < 3; i++) {
    const p = Sg[i]! + D[i]! * t;
    c[i] = Math.max(0, Math.min(G.dim[i]! - 1, Math.floor((p - G.org[i]!) / G.cs)));
    if (Math.abs(D[i]!) < 1e-12) { stp[i] = 0; tMax[i] = Infinity; tDel[i] = Infinity; continue; }
    stp[i] = D[i]! > 0 ? 1 : -1;
    const edge = G.org[i]! + (c[i]! + (D[i]! > 0 ? 1 : 0)) * G.cs;
    tMax[i] = (edge - Sg[i]!) / D[i]!; tDel[i] = G.cs / Math.abs(D[i]!);
  }
  const q = ++G.q, bl = [0, 0, 0], bh = [0, 0, 0], hidden = S.hidden;
  for (let guard = 0; guard < 100000; guard++) {
    const cell = G.cells[(c[2]! * G.dim[1]! + c[1]!) * G.dim[0]! + c[0]!];
    if (cell) for (const k of cell) {
      if (G.stamp[k] === q || k === S.sel) continue;
      G.stamp[k] = q;
      if (hidden.size && hidden.has(k)) continue;
      const o = k * 6;
      bl[0] = G.box[o]!; bl[1] = G.box[o + 1]!; bl[2] = G.box[o + 2]!; bh[0] = G.box[o + 3]!; bh[1] = G.box[o + 4]!; bh[2] = G.box[o + 5]!;
      const h = rayBox(Sg, D, bl, bh, s0c, SMAX);
      if (h && (!best || h.s < best.s)) best = { k, s: h.s, ax: h.ax };
    }
    const a = tMax[0]! < tMax[1]! ? (tMax[0]! < tMax[2]! ? 0 : 2) : (tMax[1]! < tMax[2]! ? 1 : 2);
    const exit = tMax[a]!;
    if ((best && best.s <= exit) || exit > tEnd) break;
    c[a]! += stp[a]!;
    if (c[a]! < 0 || c[a]! >= G.dim[a]!) break;
    tMax[a]! += tDel[a]!;
  }
  return best;
}

/** Ids whose boxes (viewer units) overlap or touch box [lo, hi] grown by `pad`, from the grid (focus included by its live box). */
export function boxQuery(lo: readonly number[], hi: readonly number[], pad = 0): number[] {
  const G = pickReady(), out: number[] = [];
  const cell = (v: number, i: number): number => Math.max(0, Math.min(G.dim[i]! - 1, Math.floor((v - G.org[i]!) / G.cs)));
  const c0 = [0, 1, 2].map((i) => cell(lo[i]! - pad, i)), c1 = [0, 1, 2].map((i) => cell(hi[i]! + pad, i));
  const q = ++G.q, [dx, dy] = G.dim;
  for (let z = c0[2]!; z <= c1[2]!; z++) for (let y = c0[1]!; y <= c1[1]!; y++) for (let x = c0[0]!; x <= c1[0]!; x++) {
    const ks = G.cells[(z * dy! + y) * dx! + x];
    if (ks) for (const k of ks) {
      if (G.stamp[k] === q) continue;
      G.stamp[k] = q;
      const o = k * 6;
      let ok = true;
      for (let i = 0; i < 3 && ok; i++) ok = G.box[o + i]! <= hi[i]! + pad + 1e-9 && G.box[o + 3 + i]! >= lo[i]! - pad - 1e-9;
      if (ok) out.push(k);
    }
  }
  return out;
}
