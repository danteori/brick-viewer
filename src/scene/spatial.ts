// Picking and overlap queries through a uniform grid of brick boxes (ported from the legacy viewer).
// The grid holds every brick's box in frame-independent coords (local + histOrigin), so recentring
// doesn't touch it. The focused brick is tested on its own with its live box. Phase 3 replaces this
// with the CSR SpatialIndex.

import { S } from '../app/state.ts';
import type { V3 } from './brick.ts';

export const pickGrid = {
  dirty: true, cs: 1, org: [0, 0, 0] as number[], dim: [1, 1, 1] as number[],
  cells: [] as (number[] | undefined)[], box: new Float64Array(0), stamp: new Uint32Array(0), q: 0,
};

/** [x0,y0,z0,x1,y1,z1] cells brick k's stored box covers */
function pickCellRange(k: number): number[] {
  const G = pickGrid, b = G.box, o = k * 6, r: number[] = [];
  for (let i = 0; i < 3; i++) r[i] = Math.max(0, Math.min(G.dim[i] - 1, Math.floor((b[o + i] - G.org[i]) / G.cs)));
  for (let i = 0; i < 3; i++) r[i + 3] = Math.max(0, Math.min(G.dim[i] - 1, Math.floor((b[o + 3 + i] - G.org[i]) / G.cs)));
  return r;
}
function pickCells(k: number, fn: (c: number) => void): void {
  const G = pickGrid, r = pickCellRange(k), [dx, dy] = G.dim;
  for (let z = r[2]; z <= r[5]; z++) for (let y = r[1]; y <= r[4]; y++) for (let x = r[0]; x <= r[3]; x++) fn((z * dy + y) * dx + x);
}

export function pickBuild(): void {
  const G = pickGrid, N = S.bricks.length;
  G.box = new Float64Array(N * 6); G.stamp = new Uint32Array(N); G.q = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < N; k++) for (let i = 0; i < 3; i++) {
    const a = S.bricks[k].lo[i] + S.histOrigin[i], c = S.bricks[k].hi[i] + S.histOrigin[i];
    G.box[k * 6 + i] = a; G.box[k * 6 + 3 + i] = c;
    lo[i] = Math.min(lo[i], a); hi[i] = Math.max(hi[i], c);
  }
  // roughly one brick per cell, capped at ~1M cells; a margin so small edits stay inside
  const ext = [0, 1, 2].map((i) => hi[i] - lo[i] + 2), vol = ext[0] * ext[1] * ext[2];
  G.cs = Math.max(0.2, Math.cbrt(vol / Math.max(1, N)), Math.cbrt(vol / 1e6));
  G.org = lo.map((v) => v - 1); G.dim = ext.map((e) => Math.max(1, Math.ceil(e / G.cs)));
  G.cells = new Array(G.dim[0] * G.dim[1] * G.dim[2]);
  for (let k = 0; k < N; k++) pickCells(k, (c) => { (G.cells[c] || (G.cells[c] = [])).push(k); });
  G.dirty = false;
}

/** brick k's box may have changed */
export function pickUpdate(k: number): void {
  const G = pickGrid;
  if (G.dirty || k >= G.stamp.length) { G.dirty = true; return; }
  const b = S.bricks[k], o = k * 6;
  const nb = [0, 1, 2, 3, 4, 5].map((j) => (j < 3 ? b.lo[j] : b.hi[j - 3]) + S.histOrigin[j % 3]);
  if (nb.every((v, j) => Math.abs(v - G.box[o + j]) < 1e-6)) return;
  for (let i = 0; i < 3; i++)                         // grew past the grid: rebuild on the next pick
    if (nb[i] < G.org[i] || nb[i + 3] > G.org[i] + G.dim[i] * G.cs) { G.dirty = true; return; }
  pickCells(k, (c) => { const a = G.cells[c], j = a ? a.indexOf(k) : -1; if (j >= 0) a!.splice(j, 1); });
  for (let j = 0; j < 6; j++) G.box[o + j] = nb[j];
  pickCells(k, (c) => { (G.cells[c] || (G.cells[c] = [])).push(k); });
}

/** slab test: entry distance and entry axis of ray S + s D against box (l, h), or null */
export function rayBox(Sv: readonly number[], D: readonly number[], l: ArrayLike<number>, h: ArrayLike<number>, lo: number, hi: number): { s: number; ax: number } | null {
  let t0 = lo, t1 = hi, ax = -1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(D[i]) < 1e-12) { if (Sv[i] < l[i] || Sv[i] > h[i]) return null; continue; }
    let a = (l[i] - Sv[i]) / D[i], b = (h[i] - Sv[i]) / D[i];
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) { t0 = a; ax = i; }
    if (b < t1) t1 = b;
    if (t0 > t1) return null;
  }
  return { s: t0, ax };
}

export interface Hit { k: number; s: number; ax: number }

/**
 * The nearest brick under view-plane point (vx, vy), or null. The ray starts in front of everything
 * visible (the ortho depth range is +-60) and goes straight into the view.
 */
export function pickRay(vx: number, vy: number): Hit | null {
  const m = S.view, r0 = [m[0], m[8], m[4]], r1 = [m[1], m[9], m[5]], r2 = [m[2], m[10], m[6]];   // view axes in world X,Y,Z
  const Sv = [0, 1, 2].map((i) => vx * r0[i] + vy * r1[i] + 60 * r2[i]), D = r2.map((v) => -v), SMAX = 120;
  let best: Hit | null = null;
  const s0 = rayBox(Sv, D, S.dlo, S.dhi, 0, SMAX);
  if (s0 && S.bricks[S.sel]) best = { k: S.sel, s: s0.s, ax: s0.ax };
  if (!S.bricks.length) return best;           // empty scene: no grid to build
  if (pickGrid.dirty) pickBuild();
  const G = pickGrid, Sg = Sv.map((v, i) => v + S.histOrigin[i]);
  // clip the ray to the grid, then walk its cells (3D DDA), stopping once a hit beats the cell exit
  const gl0 = G.org, gh0 = G.org.map((v, i) => v + G.dim[i] * G.cs);
  const span = rayBox(Sg, D, gl0, gh0, 0, SMAX);
  if (!span) return best;
  let tEnd = SMAX;
  for (let i = 0; i < 3; i++) if (Math.abs(D[i]) >= 1e-12) tEnd = Math.min(tEnd, Math.max((gl0[i] - Sg[i]) / D[i], (gh0[i] - Sg[i]) / D[i]));
  const t = span.s, c: number[] = [], stp: number[] = [], tMax: number[] = [], tDel: number[] = [];
  for (let i = 0; i < 3; i++) {
    const p = Sg[i] + D[i] * t;
    c[i] = Math.max(0, Math.min(G.dim[i] - 1, Math.floor((p - G.org[i]) / G.cs)));
    if (Math.abs(D[i]) < 1e-12) { stp[i] = 0; tMax[i] = Infinity; tDel[i] = Infinity; continue; }
    stp[i] = D[i] > 0 ? 1 : -1;
    const edge = G.org[i] + (c[i] + (D[i] > 0 ? 1 : 0)) * G.cs;
    tMax[i] = (edge - Sg[i]) / D[i]; tDel[i] = G.cs / Math.abs(D[i]);
  }
  const q = ++G.q, bl = [0, 0, 0], bh = [0, 0, 0];
  for (let guard = 0; guard < 100000; guard++) {
    const cell = G.cells[(c[2] * G.dim[1] + c[1]) * G.dim[0] + c[0]];
    if (cell) for (const k of cell) {
      if (G.stamp[k] === q || k === S.sel) continue;
      G.stamp[k] = q;
      const o = k * 6;
      bl[0] = G.box[o]; bl[1] = G.box[o + 1]; bl[2] = G.box[o + 2]; bh[0] = G.box[o + 3]; bh[1] = G.box[o + 4]; bh[2] = G.box[o + 5];
      const h = rayBox(Sg, D, bl, bh, 0, SMAX);
      if (h && (!best || h.s < best.s)) best = { k, s: h.s, ax: h.ax };
    }
    const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
    const exit = tMax[a];
    if ((best && best.s <= exit) || exit > tEnd) break;
    c[a] += stp[a];
    if (c[a] < 0 || c[a] >= G.dim[a]) break;
    tMax[a] += tDel[a];
  }
  return best;
}

/**
 * Does any box [p + lo, p + hi] overlap a brick (touching is fine)? The focused brick is tested
 * live, the rest through the pick grid.
 */
export function boxesHit(p: readonly number[], items: readonly { lo: V3; hi: V3 }[]): boolean {
  const E = 1e-4;
  const over = (l: ArrayLike<number>, h: ArrayLike<number>, L: ArrayLike<number>, H: ArrayLike<number>): boolean =>
    l[0] < H[0] - E && h[0] > L[0] + E && l[1] < H[1] - E && h[1] > L[1] + E && l[2] < H[2] - E && h[2] > L[2] + E;
  if (!S.bricks.length) return false;
  if (pickGrid.dirty) pickBuild();
  const PG = pickGrid, B = PG.box, cell = (v: number, i: number): number => Math.max(0, Math.min(PG.dim[i] - 1, Math.floor((v - PG.org[i]) / PG.cs)));
  const L = [0, 0, 0], H = [0, 0, 0];
  for (const t of items) {
    const l = [0, 1, 2].map((i) => p[i] + t.lo[i]), h = [0, 1, 2].map((i) => p[i] + t.hi[i]);
    if (S.bricks[S.sel] && over(l, h, S.dlo, S.dhi)) return true;
    const la = l.map((v, i) => v + S.histOrigin[i]), ha = h.map((v, i) => v + S.histOrigin[i]);
    const c0 = la.map(cell), c1 = ha.map(cell), dx = PG.dim[0], dy = PG.dim[1];
    for (let z = c0[2]; z <= c1[2]; z++) for (let y = c0[1]; y <= c1[1]; y++) for (let x = c0[0]; x <= c1[0]; x++) {
      const ks = PG.cells[(z * dy + y) * dx + x];
      if (ks) for (const k of ks) {
        if (k === S.sel) continue;
        const o = k * 6;
        L[0] = B[o]; L[1] = B[o + 1]; L[2] = B[o + 2]; H[0] = B[o + 3]; H[1] = B[o + 4]; H[2] = B[o + 5];
        if (over(la, ha, L, H)) return true;
      }
    }
  }
  return false;
}
