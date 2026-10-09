// A world's dynamic grids (vehicles, doors...) as viewer bricks, placed where their entity sits
// (src/scene/grids.ts). The viewer draws axis-aligned boxes and meshes per orientation byte, so a
// grid's rotation is applied by composing it with each brick's orientation: exact for rotations in
// quarter turns, otherwise snapped to the nearest quarter-turn rotation. Read-only: these bricks are
// drawn by src/render/extras.ts (all grids in one store of their own, chunked like the scene), not
// edited.

import { BrickShapes } from '../render/meshes/shapes.js';
import type { SaveView } from '../format/saveview.ts';
import { gridBricks, rotate, type Grid, type Quat, type Vec3 } from './grids.ts';
import { viewerBrick } from './load.ts';
import { SceneStore } from './store.ts';
import { putPlain, supportedAsset } from './view.ts';
import type { Brick } from './brick.ts';

type Mat3 = number[][];

/** The rotation of a unit quaternion as a matrix (columns = rotated basis vectors). */
export function quatColumns(q: Quat): Mat3 {
  const c = [rotate(q, [1, 0, 0]), rotate(q, [0, 1, 0]), rotate(q, [0, 0, 1])];
  return [0, 1, 2].map((i) => [c[0]![i]!, c[1]![i]!, c[2]![i]!]);
}

/** The nearest signed-permutation rotation, and how far the original was from it (0 = exact). */
export function snapRotation(m: Mat3): { m: Mat3; error: number } {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], used = new Set<number>();
  let error = 0;
  // greedy by largest entries: each row and column gets exactly one +-1
  const cells = [] as [number, number, number][];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cells.push([Math.abs(m[i]![j]!), i, j]);
  cells.sort((a, b) => b[0] - a[0]);
  const rows = new Set<number>();
  for (const [, i, j] of cells) {
    if (rows.has(i) || used.has(j)) continue;
    rows.add(i); used.add(j);
    out[i]![j] = m[i]![j]! < 0 ? -1 : 1;
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) error = Math.max(error, Math.abs(m[i]![j]! - out[i]![j]!));
  return { m: out, error };
}

const mul = (a: Mat3, b: Mat3): Mat3 => a.map((r) => [0, 1, 2].map((j) => r[0]! * b[0]![j]! + r[1]! * b[1]![j]! + r[2]! * b[2]![j]!));
const sameMat = (a: Mat3, b: Mat3): boolean => a.every((r, i) => r.every((v, j) => Math.round(v) === Math.round(b[i]![j]!)));

/** The orientation byte whose rotation is R (a signed permutation with det +1), or -1. */
export function orientOfMatrix(R: Mat3): number {
  for (let o = 0; o < 24; o++) if (sameMat(BrickShapes.brickOrient(o), R)) return o;
  return -1;
}

export interface PlacedGrid { bricks: Brick[]; skipped: number; snapped: boolean }

/** One grid's bricks as viewer bricks in world space (absolute viewer units). */
export function placedGridBricks(view: SaveView, grid: Grid): PlacedGrid {
  const { m: R, error } = snapRotation(quatColumns(grid.transform.quat));
  const out: Brick[] = [];
  let skipped = 0;
  for (const gb of gridBricks(view, grid)) {
    const o = orientOfMatrix(mul(R, BrickShapes.brickOrient(gb.orient)));
    const b = viewerBrick({ ...gb, orient: o < 0 ? gb.orient : o, pos: gb.world as Vec3 }, false);
    if ('skip' in b) { skipped++; continue; }
    out.push(b);
  }
  return { bricks: out, skipped, snapped: error > 1e-3 };
}

export interface PlacedGridStore { placed: number; skipped: number; snapped: boolean }

/**
 * Adds one grid's bricks to `store` (the world's dynamic grids share one store, drawn as render
 * chunks like the scene). A brick sits at the entity's location plus its grid-local position
 * turned by the grid's rotation, snapped to the nearest quarter turn like the orientations (so a
 * grid that isn't turned by quarter turns is drawn turned by the nearest one as a whole), rounded
 * to whole units.
 */
export function placedGridStore(view: SaveView, grid: Grid, store: SceneStore, linear = false): PlacedGridStore {
  const { m: R, error } = snapRotation(quatColumns(grid.transform.quat));
  const t = grid.transform.pos;
  let skipped = 0, placed = 0;
  for (const gb of gridBricks(view, grid)) {
    if (!supportedAsset(gb.asset, gb.size !== null)) { skipped++; continue; }
    const o = orientOfMatrix(mul(R, BrickShapes.brickOrient(gb.orient))), p = gb.pos;
    const pos = [0, 1, 2].map((i) => Math.round(t[i]! + R[i]![0]! * p[0] + R[i]![1]! * p[1] + R[i]![2]! * p[2])) as Vec3;
    const id = store.alloc();
    putPlain(store, id, { ...gb, orient: o < 0 ? gb.orient : o, pos }, linear, String(grid.id));
    placed++;
  }
  return { placed, skipped, snapped: error > 1e-3 };
}
