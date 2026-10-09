// Brick collision, the game's rules:
//  1. Within ONE grid no brick may overlap another: placing, resizing, rotating and moving are
//     refused (or a resize stops at the last size that fits).
//  2. Bricks in DIFFERENT grids (separate entities, e.g. dynamic grids) never block each other.
//  3. Pasting a selection places what fits and drops each pasted brick that would overlap.
//
// Two bricks collide when their solid volumes intersect with positive volume; touching faces are fine.
// Every brick is tested as its oriented bounding box (worldHalf), including ramps, wedges, rounds and
// the micro shapes: whether the game lets e.g. two ramps' empty slope corners interlock is unverified,
// so the box is the conservative choice.
//
// Comparisons run on integer Brickadia units (a stud is 10, a plate 4, a micro 2): the store keeps
// integer centres and half-extents, and the editor only moves faces by whole steps, so rounding the
// viewer's coordinates to units is exact and the tests have no float edges. Candidates come from
// the pick grid (spatial.ts); the focused brick is tested with its live box; hidden rows (a
// selection being moved) never block.

import { S } from '../app/state.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { worldHalf } from '../core/orient.ts';
import { pickReady } from './spatial.ts';
import { GRIDS } from './store.ts';
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
  return [pos[0]! - h[0], pos[1]! - h[1], pos[2]! - h[2], pos[0]! + h[0], pos[1]! + h[1], pos[2]! + h[2]];
}

/** Positive-volume intersection: touching faces, edges or corners do not count (nor a flat box). */
export function boxesOverlap(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return Math.max(a[0]!, b[0]!) < Math.min(a[3]!, b[3]!) && Math.max(a[1]!, b[1]!) < Math.min(a[4]!, b[4]!) && Math.max(a[2]!, b[2]!) < Math.min(a[5]!, b[5]!);
}

/**
 * Are two boxes "connected" (E-01 select connected, E-09)? They share a face patch of positive area
 * or overlap. Edges and corners that only meet don't count. The game's rule is unknown (the board
 * asks); face contact is the working assumption.
 */
export function touching(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  let flush = 0;
  for (let i = 0; i < 3; i++) {
    const lo = Math.max(a[i]!, b[i]!), hi = Math.min(a[i + 3]!, b[i + 3]!);
    if (hi < lo) return false;               // apart on this axis
    if (hi === lo) flush++;                  // their faces meet on this axis
  }
  return flush <= 1;
}

/** Do two bricks collide? Different grids never do. */
export function bricksCollide(a: { box: ArrayLike<number>; grid?: string }, b: { box: ArrayLike<number>; grid?: string }): boolean {
  return gridOf(a) === gridOf(b) && boxesOverlap(a.box, b.box);
}

/** box faces (absolute viewer units) -> integer box */
export function unitBox(lo: readonly number[], hi: readonly number[]): IBox {
  return [toUnits(lo[0]!), toUnits(lo[1]!), toUnits(lo[2]!), toUnits(hi[0]!), toUnits(hi[1]!), toUnits(hi[2]!)];
}

export interface HitOpts {
  /** the grid the box is in (default: the main grid) */
  grid?: string;
  /** ids that never block (the bricks being edited) */
  ignore?: ReadonlySet<number> | readonly number[];
}

const asSet = (x: ReadonlySet<number> | readonly number[] | undefined): ReadonlySet<number> => (!x ? new Set() : x instanceof Set ? x : new Set(x as readonly number[]));

/**
 * The id of a scene brick that box [lo, hi] (absolute viewer units) would collide with, or -1.
 * Uses the pick grid; the focused brick is tested with its live faces.
 */
export function sceneHit(lo: readonly number[], hi: readonly number[], opts: HitOpts = {}): number {
  const s = S.scene;
  if (!s.count) return -1;
  const q = unitBox(lo, hi), grid = GRIDS.id(opts.grid ?? '1'), ignore = asSet(opts.ignore), hidden = S.hidden;
  if (q[0] >= q[3] || q[1] >= q[4] || q[2] >= q[5]) return -1;          // empty box: no volume
  const sel = S.sel;
  if (sel >= 0 && s.alive(sel) && !ignore.has(sel) && !hidden.has(sel) && s.grid[sel] === grid && boxesOverlap(q, unitBox(S.lo, S.hi))) return sel;
  const G = pickReady(), B = G.box, U = 1 / BRZ_UNIT, dx = G.dim[0]!, dy = G.dim[1]!;
  const cell = (u: number, i: number): number => Math.max(0, Math.min(G.dim[i]! - 1, Math.floor((u * BRZ_UNIT - G.org[i]!) / G.cs)));
  const c0 = [cell(q[0], 0), cell(q[1], 1), cell(q[2], 2)], c1 = [cell(q[3], 0), cell(q[4], 1), cell(q[5], 2)];
  const stamp = ++G.q, b: number[] = [0, 0, 0, 0, 0, 0];
  for (let z = c0[2]!; z <= c1[2]!; z++) for (let y = c0[1]!; y <= c1[1]!; y++) for (let x = c0[0]!; x <= c1[0]!; x++) {
    const ks = G.cells[(z * dy + y) * dx + x];
    if (!ks) continue;
    for (const k of ks) {
      if (G.stamp[k] === stamp || k === sel) continue;
      G.stamp[k] = stamp;
      if (ignore.has(k) || (hidden.size && hidden.has(k)) || s.grid[k] !== grid || !s.alive(k)) continue;
      const o = k * 6;
      for (let j = 0; j < 6; j++) b[j] = Math.round(B[o + j]! * U);
      if (boxesOverlap(q, b)) return k;
    }
  }
  return -1;
}

/** Would brick-shaped box t, placed at p (its offset, absolute viewer units), collide with the scene? */
export const itemHits = (p: readonly number[], t: Pick<Brick, 'lo' | 'hi' | 'grid'>, ignore?: ReadonlySet<number> | readonly number[]): boolean =>
  sceneHit([0, 1, 2].map((i) => p[i]! + t.lo[i]!), [0, 1, 2].map((i) => p[i]! + t.hi[i]!), { grid: gridOf(t), ignore }) >= 0;

/**
 * Would the focused brick, changed to box [lo, hi], newly collide? Only the bricks the old box did
 * NOT already overlap count, so overlaps that came with a loaded save never lock a brick in place.
 */
export function focusChangeHits(oldLo: readonly number[], oldHi: readonly number[], lo: readonly number[], hi: readonly number[]): boolean {
  const b = S.focus;
  if (!b || S.sel < 0) return false;
  const ignore = new Set([S.sel]), grid = gridOf(b), s = S.scene, ob = unitBox(oldLo, oldHi), bx = new Array<number>(6);
  for (;;) {
    const k = sceneHit(lo, hi, { grid, ignore });
    if (k < 0) return false;
    s.box(k, bx);
    if (!boxesOverlap(ob, bx)) return true;                       // a new overlap
    ignore.add(k);                                                 // was already overlapping
  }
}

/**
 * Growing the focused brick on axis i, near face side ns (+1 hi, -1 lo), from size `from` to `to`
 * extra steps of `step` viewer units beyond its faces lo / hi: the largest count in [from, to] whose
 * added slab is free (from itself when the first step is blocked). Only the slab the face sweeps is
 * tested, so overlaps the brick already had never block it.
 */
export function freeGrowth(lo: V3, hi: V3, i: number, ns: number, step: number, from: number, to: number): number {
  const grid = gridOf(S.focus), ignore = new Set([S.sel]);
  let ok = from;
  for (let n = from + 1; n <= to; n++) {
    const l = lo.slice() as V3, h = hi.slice() as V3;
    if (ns > 0) { l[i] = hi[i] + (n - 1) * step; h[i] = hi[i] + n * step; } else { h[i] = lo[i] - (n - 1) * step; l[i] = lo[i] - n * step; }
    if (sceneHit(l, h, { grid, ignore }) >= 0) break;
    ok = n;
  }
  return ok;
}
