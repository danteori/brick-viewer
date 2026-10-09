// Brick collision, the game's rules:
//  1. Within ONE grid no brick may overlap another: placing, resizing and rotating are refused (or a
//     resize stops at the last size that fits).
//  2. Bricks in DIFFERENT grids (separate entities, e.g. dynamic grids) never block each other.
//  3. Pasting a selection places what fits and drops each pasted brick that would overlap.
//
// Two bricks collide when their solid volumes intersect with positive volume; touching faces are fine.
// Every brick is tested as its oriented bounding box (worldHalf), including ramps, wedges, rounds and
// the micro shapes: whether the game lets e.g. two ramps' empty slope corners interlock is unverified,
// so the box is the conservative choice.
//
// Comparisons run on integer Brickadia units (a stud is 10, a plate 4, a micro 2): every brick face
// in a save is pos +- half with integer pos and half, and the editor only moves faces by whole steps,
// so rounding the viewer's 3-decimal coordinates to units is exact and the tests have no float edges.
// Candidates are found through the pick grid (spatial.ts); the focused brick is tested live.

import { S } from '../app/state.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { worldHalf } from '../core/orient.ts';
import { pickBuild, pickGrid, pickUpdate } from './spatial.ts';
import { inst } from '../render/instances.ts';
import type { Brick, V3 } from './brick.ts';

/** An axis-aligned box in integer Brickadia units: [x0, y0, z0, x1, y1, z1]. */
export type IBox = [number, number, number, number, number, number];

/** The grid a brick belongs to (the save's grid folder name); the main static grid is '1'. */
export const gridOf = (b: { grid?: string } | null | undefined): string => b?.grid ?? '1';

/** viewer units -> integer Brickadia units */
export const toUnits = (v: number): number => Math.round(v / BRZ_UNIT);

/** Oriented box of a brick at integer position pos with LOCAL half-extents half and orientation byte o. */
export function orientedBox(pos: readonly number[], half: readonly [number, number, number], o: number): IBox {
  const h = worldHalf(o, half);
  return [pos[0] - h[0], pos[1] - h[1], pos[2] - h[2], pos[0] + h[0], pos[1] + h[1], pos[2] + h[2]];
}

/** Positive-volume intersection: touching faces, edges or corners do not count (nor a flat box). */
export function boxesOverlap(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return Math.max(a[0], b[0]) < Math.min(a[3], b[3]) && Math.max(a[1], b[1]) < Math.min(a[4], b[4]) && Math.max(a[2], b[2]) < Math.min(a[5], b[5]);
}

/** Do two bricks collide? Different grids never do. */
export function bricksCollide(a: { box: ArrayLike<number>; grid?: string }, b: { box: ArrayLike<number>; grid?: string }): boolean {
  return gridOf(a) === gridOf(b) && boxesOverlap(a.box, b.box);
}

/** box faces in the current frame (viewer units) -> frame-independent integer box */
export function unitBox(lo: readonly number[], hi: readonly number[]): IBox {
  const o = S.histOrigin;
  return [toUnits(lo[0] + o[0]), toUnits(lo[1] + o[1]), toUnits(lo[2] + o[2]), toUnits(hi[0] + o[0]), toUnits(hi[1] + o[1]), toUnits(hi[2] + o[2])];
}

/**
 * The pick grid is brought up to date once a frame (syncInstances). An edit can be checked before
 * that frame, so apply the pending changes now: a changed brick list rebuilds, changed bricks and
 * the brick that just lost the focus (its grid box is from before it was focused) update in place.
 */
function syncPickGrid(): void {
  if (inst.all || S.bricks.length !== pickGrid.stamp.length) pickGrid.dirty = true;
  if (!pickGrid.dirty) {
    for (const k of inst.dirty) if (k < S.bricks.length) pickUpdate(k);
    if (inst.sel !== S.sel && inst.sel >= 0 && inst.sel < S.bricks.length) pickUpdate(inst.sel);
  }
  if (pickGrid.dirty) pickBuild();
}

export interface HitOpts {
  /** the grid the box is in (default: the main grid) */
  grid?: string;
  /** brick indices that never block (the brick being edited) */
  ignore?: readonly number[];
}

/**
 * The index of a scene brick that box [lo, hi] (current frame, viewer units) would collide with, or
 * -1. Uses the pick grid; the focused brick is tested with its live faces.
 */
export function sceneHit(lo: readonly number[], hi: readonly number[], opts: HitOpts = {}): number {
  const N = S.bricks.length;
  if (!N) return -1;
  const q = unitBox(lo, hi), grid = opts.grid ?? '1', ignore = opts.ignore ?? [];
  if (q[0] >= q[3] || q[1] >= q[4] || q[2] >= q[5]) return -1;          // empty box: no volume
  const sel = S.sel, focus = S.bricks[sel];
  if (focus && !ignore.includes(sel) && gridOf(focus) === grid && boxesOverlap(q, unitBox(focus.lo, focus.hi))) return sel;
  syncPickGrid();
  const G = pickGrid, B = G.box, U = 1 / BRZ_UNIT, dx = G.dim[0], dy = G.dim[1];
  // cells of the query, from its frame-independent float box (cells are G.cs viewer units)
  const cell = (u: number, i: number): number => Math.max(0, Math.min(G.dim[i] - 1, Math.floor((u * BRZ_UNIT - G.org[i]) / G.cs)));
  const c0 = [cell(q[0], 0), cell(q[1], 1), cell(q[2], 2)], c1 = [cell(q[3], 0), cell(q[4], 1), cell(q[5], 2)];
  const stamp = ++G.q, b: number[] = [0, 0, 0, 0, 0, 0];
  for (let z = c0[2]; z <= c1[2]; z++) for (let y = c0[1]; y <= c1[1]; y++) for (let x = c0[0]; x <= c1[0]; x++) {
    const ks = G.cells[(z * dy + y) * dx + x];
    if (!ks) continue;
    for (const k of ks) {
      if (G.stamp[k] === stamp || k === sel || k >= N) continue;
      G.stamp[k] = stamp;
      if (ignore.includes(k) || gridOf(S.bricks[k]) !== grid) continue;
      const o = k * 6;
      for (let j = 0; j < 6; j++) b[j] = Math.round(B[o + j] * U);
      if (boxesOverlap(q, b)) return k;
    }
  }
  return -1;
}

/** Would brick-shaped box t, placed at p (its offset, current frame), collide with the scene? */
export const itemHits = (p: readonly number[], t: Pick<Brick, 'lo' | 'hi' | 'grid'>, ignore?: readonly number[]): boolean =>
  sceneHit([0, 1, 2].map((i) => p[i] + t.lo[i]), [0, 1, 2].map((i) => p[i] + t.hi[i]), { grid: gridOf(t), ignore }) >= 0;

/**
 * Would focused brick b, changed to box [lo, hi], newly collide? Only the bricks the old box did NOT
 * already overlap count, so overlaps that came with a loaded save never lock a brick in place.
 */
export function focusChangeHits(oldLo: readonly number[], oldHi: readonly number[], lo: readonly number[], hi: readonly number[]): boolean {
  const b = S.bricks[S.sel];
  if (!b) return false;
  const ignore = [S.sel], grid = gridOf(b);
  for (;;) {
    const k = sceneHit(lo, hi, { grid, ignore });
    if (k < 0) return false;
    const o = S.bricks[k];
    if (!boxesOverlap(unitBox(oldLo, oldHi), unitBox(o.lo, o.hi))) return true;   // a new overlap
    ignore.push(k);                                                       // was already overlapping
  }
}

/**
 * Growing the focused brick on axis i, near face side ns (+1 hi, -1 lo), from size `from` to `to`
 * extra steps of `step` viewer units beyond its faces lo / hi: the largest count in [from, to] whose
 * added slab is free (from itself when the first step is blocked). Only the slab the face sweeps is
 * tested, so overlaps the brick already had never block it.
 */
export function freeGrowth(lo: V3, hi: V3, i: number, ns: number, step: number, from: number, to: number): number {
  const b = S.bricks[S.sel], grid = gridOf(b), ignore = [S.sel];
  let ok = from;
  for (let n = from + 1; n <= to; n++) {
    const l = lo.slice() as V3, h = hi.slice() as V3;
    if (ns > 0) { l[i] = hi[i] + (n - 1) * step; h[i] = hi[i] + n * step; } else { h[i] = lo[i] - (n - 1) * step; l[i] = lo[i] - n * step; }
    if (sceneHit(l, h, { grid, ignore }) >= 0) break;
    ok = n;
  }
  return ok;
}
