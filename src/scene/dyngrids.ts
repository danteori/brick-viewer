// Dynamic grids in the scene (W-03 / W-04): a save's moving grids (Grids/N with entity N) live in
// the scene store like grid 1, tagged with their grid (the `grid` column, GRIDS name "N"), so they
// can be picked, selected, painted and moved. What a row can't say is kept per store in a GridSet:
// each grid's transform, the grids as loaded (to tell what changed), and the bricks the viewer
// can't draw (written back unchanged, in grid-local units).
//
// A row holds WORLD units: world = origin + R * local, where origin is the entity location rounded
// to whole units and R the grid's rotation snapped to a quarter-turn rotation (grids turned by other
// angles draw turned by the nearest one, as before). The rest of the location (frac) and the exact
// quaternion stay in the transform, so an untouched grid writes back exactly what it read, and a
// moved one keeps its fractional offset. Every transform change is a whole-grid edit of its rows
// plus a new transform; the undo history keeps the GridSet's map on both sides (history.ts).

import { BrickShapes } from '../render/meshes/shapes.js';
import type { FileMap } from '../format/brz.ts';
import { extractBricks } from '../format/world.ts';
import { fileMapView } from '../format/saveview.ts';
import { entityLayoutProblem } from '../format/entitywrite.ts';
import { buildWorldModel, type Quat, type Vec3 } from './grids.ts';
import { orientOfMatrix, quatColumns, snapRotation } from './worldgrids.ts';
import { GRIDS, type SceneStore } from './store.ts';
import { putPlain, supportedAsset } from './view.ts';
import type { SeqBrick } from './load.ts';

export type Mat3 = number[][];

/** A grid's placement (immutable: a change makes a new one). */
export interface GridXf {
  /** whole units: where local (0,0,0) is drawn */
  readonly origin: Vec3;
  /** entity location - origin */
  readonly frac: Vec3;
  /** the exact rotation (unit quaternion x, y, z, w) */
  readonly quat: Quat;
  /** the quarter-turn rotation the rows are drawn with */
  readonly R: Mat3;
}

export interface LoadedGrid {
  xf: GridXf;
  /** the grid has component or wire chunks: its bricks may not be removed (their indices are named) */
  components: boolean;
  /** its chunks store linear colour bytes */
  linear: boolean;
  owner: number;
}

export interface GridSet {
  /** the dynamic grids now, by persistent index (the grid folder number) */
  grids: Map<number, GridXf>;
  /** the dynamic grids as loaded */
  loaded: Map<number, LoadedGrid>;
  /** per grid: the bricks the viewer can't draw, grid-local, with their load order */
  unsupported: Map<number, SeqBrick[]>;
  /** the persistent index the next new grid gets */
  next: number;
  /** why this save can't take new grids, or null */
  createProblem: string | null;
}

const sets = new WeakMap<SceneStore, GridSet>();
export const gridSetOf = (s: SceneStore): GridSet | null => sets.get(s) ?? null;
export function setGridSet(s: SceneStore, g: GridSet): void { sets.set(s, g); }

// --- maths ---------------------------------------------------------------------------------------------

export const IDENT: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export const mul3 = (a: Mat3, b: Mat3): Mat3 => a.map((r) => [0, 1, 2].map((j) => r[0]! * b[0]![j]! + r[1]! * b[1]![j]! + r[2]! * b[2]![j]!));
export const transpose = (a: Mat3): Mat3 => [0, 1, 2].map((i) => [a[0]![i]!, a[1]![i]!, a[2]![i]!]);
export const apply3 = (m: Mat3, v: readonly number[]): Vec3 => [0, 1, 2].map((i) => m[i]![0]! * v[0]! + m[i]![1]! * v[1]! + m[i]![2]! * v[2]!) as Vec3;
const clean = (m: Mat3): Mat3 => m.map((r) => r.map((v) => Math.round(v) + 0));

/** Hamilton product a * b (apply b, then a). */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
export function quatNorm(q: Quat): Quat {
  const n = Math.hypot(...q) || 1;
  return q.map((v) => v / n) as Quat;
}
/** A turn of `deg` degrees about a unit axis. */
export const axisQuat = (axis: Vec3, deg: number): Quat => { const h = deg * Math.PI / 360, s = Math.sin(h); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)]; };

/**
 * Yaw (about Z), pitch (about Y), roll (about X) in degrees -> quaternion: q = yaw * pitch * roll,
 * right-handed about the save's axes (the convention grids.ts rotate() uses). The game's own
 * rotator signs aren't known (backlog W-04 question).
 */
export function quatOfEuler(yaw: number, pitch: number, roll: number): Quat {
  return quatNorm(quatMul(quatMul(axisQuat([0, 0, 1], yaw), axisQuat([0, 1, 0], pitch)), axisQuat([1, 0, 0], roll)));
}
/** Inverse of quatOfEuler (degrees, yaw and roll in (-180, 180], pitch in [-90, 90]). */
export function eulerOfQuat(q: Quat): [yaw: number, pitch: number, roll: number] {
  const [x, y, z, w] = quatNorm(q), d = 180 / Math.PI;
  const sp = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)), roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const r = (v: number): number => { const a = Math.round(v * d * 1e4) / 1e4; return a === -180 ? 180 : a + 0; };
  return [r(yaw), r(Math.asin(sp)), r(roll)];
}

/** The transform of an entity at `location` turned by `quat`. */
export function xfOf(location: readonly number[], quat: Quat, R?: Mat3): GridXf {
  const origin = location.map((v) => Math.round(v)) as Vec3;
  return { origin, frac: location.map((v, i) => v - origin[i]!) as Vec3, quat: quatNorm(quat), R: R ?? clean(snapRotation(quatColumns(quatNorm(quat))).m) };
}
export const locationOf = (x: GridXf): Vec3 => x.origin.map((v, i) => v + x.frac[i]!) as Vec3;
export const sameXf = (a: GridXf, b: GridXf): boolean => a === b || (a.origin.every((v, i) => v === b.origin[i]) && a.frac.every((v, i) => v === b.frac[i]) && a.quat.every((v, i) => v === b.quat[i]));
/** Is the transform's rotation a whole number of quarter turns (drawn exactly)? */
export const exactTurn = (x: GridXf): boolean => snapRotation(quatColumns(x.quat)).error < 1e-3;

/** Orientation byte o turned by the signed permutation T (T * M(o)); o unchanged if none matches. */
export function turnOrient(T: Mat3, o: number): number {
  const r = orientOfMatrix(mul3(T, BrickShapes.brickOrient(o)));
  return r < 0 ? o : r;
}

/** A grid-local brick -> world (a row's position and orientation). */
export const toWorld = (x: GridXf, pos: readonly number[], orient: number): { pos: Vec3; orient: number } =>
  ({ pos: apply3(x.R, pos).map((v, i) => v + x.origin[i]!) as Vec3, orient: turnOrient(x.R, orient) });
/** A row's world position and orientation -> grid-local. */
export function toLocal(x: GridXf, pos: readonly number[], orient: number): { pos: Vec3; orient: number } {
  const Rt = transpose(x.R);
  return { pos: apply3(Rt, pos.map((v, i) => v - x.origin[i]!)), orient: turnOrient(Rt, orient) };
}

// --- rows ---------------------------------------------------------------------------------------------

/** The grid number of row id (1 = the main grid). */
export const gridOfRow = (s: SceneStore, id: number): number => Number(GRIDS.name(s.grid[id]!)) || 1;
/** Is row id in a dynamic grid of this scene? */
export function isDynamicRow(s: SceneStore, id: number): boolean {
  const g = gridSetOf(s);
  return !!g && s.alive(id) && g.grids.has(gridOfRow(s, id));
}
/** Rows among ids in a dynamic grid that has components or wires (their bricks may not be removed: indices name them). */
export function lockedGridRows(s: SceneStore, ids: readonly number[]): number[] {
  const g = gridSetOf(s);
  if (!g) return [];
  return ids.filter((id) => s.alive(id) && g.loaded.get(gridOfRow(s, id))?.components === true);
}
/** Live rows of grid `grid`, in list order. */
export function rowsOfGrid(s: SceneStore, grid: number): number[] {
  const gi = GRIDS.id(String(grid)), out: number[] = [];
  for (const id of s.ids()) if (s.grid[id] === gi) out.push(id);
  return out.sort((a, b) => s.order[a]! - s.order[b]!);
}
/** Live rows per dynamic grid. */
export function gridCounts(s: SceneStore): Map<number, number> {
  const g = gridSetOf(s), out = new Map<number, number>();
  if (!g) return out;
  const want = new Map([...g.grids.keys()].map((k) => [GRIDS.id(String(k)), k]));
  for (const id of s.ids()) { const k = want.get(s.grid[id]!); if (k !== undefined) out.set(k, (out.get(k) ?? 0) + 1); }
  return out;
}

/**
 * Moves grid `grid`'s rows from transform `from` to `to` (each row: world -> local by `from`, local
 * -> world by `to`) and makes `to` its transform. The caller holds the undo step open.
 */
export function placeGrid(s: SceneStore, grid: number, from: GridXf, to: GridXf, ids = rowsOfGrid(s, grid)): void {
  const set = gridSetOf(s);
  if (!set) throw new Error('no dynamic grids in this scene');
  const T = mul3(to.R, transpose(from.R));
  for (const id of ids) {
    const p = apply3(T, [s.px[id]! - from.origin[0], s.py[id]! - from.origin[1], s.pz[id]! - from.origin[2]]);
    s.px[id] = p[0] + to.origin[0]; s.py[id] = p[1] + to.origin[1]; s.pz[id] = p[2] + to.origin[2];
    s.orient[id] = turnOrient(T, s.orient[id]!);
    s.touch(id);
  }
  set.grids.set(grid, to);
}

/** grid's transform shifted by du units on axis i (rows not touched: the Move drag moves them). */
export function shiftedXf(x: GridXf, i: number, du: number): GridXf {
  const origin = x.origin.slice() as Vec3;
  origin[i] = origin[i]! + du;
  return { ...x, origin };
}

/** grid's transform turned `turns` quarter turns about world Z through its origin. */
export function turnedXf(x: GridXf, turns: number): GridXf {
  const n = ((turns % 4) + 4) % 4;
  let Rz: Mat3 = IDENT;
  for (let k = 0; k < n; k++) Rz = mul3([[0, -1, 0], [1, 0, 0], [0, 0, 1]], Rz);
  return { origin: x.origin, frac: apply3(Rz, x.frac), quat: quatNorm(quatMul(axisQuat([0, 0, 1], 90 * n), x.quat)), R: clean(mul3(Rz, x.R)) };
}

// --- undo ---------------------------------------------------------------------------------------------

/** The scene's grid transforms as an undo step keeps them (null: the scene has no GridSet). */
export const snapGrids = (s: SceneStore): ReadonlyMap<number, GridXf> | null => { const g = gridSetOf(s); return g ? new Map(g.grids) : null; };
export function restoreGrids(s: SceneStore, m: ReadonlyMap<number, GridXf> | null | undefined): void {
  const g = gridSetOf(s);
  if (g && m) g.grids = new Map(m);
}
export function sameGrids(a: ReadonlyMap<number, GridXf> | null | undefined, b: ReadonlyMap<number, GridXf> | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

// --- loading -------------------------------------------------------------------------------------------

export interface DynLoad {
  /** dynamic grids put in the scene */
  grids: number;
  /** of those, turned by an angle that isn't a quarter turn (drawn at the nearest) */
  snapped: number;
  /** bricks the viewer can't draw (kept for saving) */
  skipped: number;
  /** grids that couldn't be read */
  failed: number;
  /** grids other than 1 that aren't dynamic brick grids (microchips...), left alone */
  others: number;
}

/**
 * Puts a save's dynamic grids into store `s` (rows tagged with their grid, after grid 1's) and
 * gives it a GridSet; every save with a template gets one, so new grids can be made in it.
 */
export function loadDynamicGrids(s: SceneStore, files: FileMap): DynLoad {
  const out: DynLoad = { grids: 0, snapped: 0, skipped: 0, failed: 0, others: 0 };
  let problem: string | null;
  try { problem = entityLayoutProblem(files); } catch (err) { problem = (err as Error).message; }
  const set: GridSet = { grids: new Map(), loaded: new Map(), unsupported: new Map(), next: 2, createProblem: problem };
  setGridSet(s, set);
  if (![...files.keys()].some((p) => /^World\/0\/(Bricks\/Grids\/(?!1\/)|Entities\/ChunkIndex\.mps)/.test(p))) return out;
  let model: ReturnType<typeof buildWorldModel>;
  try { model = buildWorldModel(fileMapView(files)); } catch (err) { console.warn('dynamic grids not read', err); out.failed++; return out; }
  set.next = Math.max(2, model.entities.nextPersistentIndex ?? 2, ...model.grids.map((g) => g.id + 1), ...model.entities.entities.map((e) => e.persistentIndex + 1));
  for (const g of model.grids) {
    if (g.id === 1) continue;
    if (g.kind !== 'dynamic' || !g.entity) { out.others++; continue; }
    const name = String(g.id), xf = xfOf(g.entity.location, g.entity.rotation);
    let bricks: ReturnType<typeof extractBricks>;
    try { bricks = extractBricks(files, { grid: name }); } catch (err) { console.warn(`grid ${g.id} not shown`, err); out.failed++; continue; }
    const hasComp = [...files.keys()].some((p) => p.startsWith(`World/0/Bricks/Grids/${name}/`) && /\/(Components|Wires)\//.test(p));
    set.loaded.set(g.id, { xf, components: hasComp, linear: bricks.linear[0] ?? false, owner: g.entity.owner ?? 0 });
    set.grids.set(g.id, xf);
    const keep: SeqBrick[] = [];
    bricks.bricks.forEach((pb, i) => {
      if (!supportedAsset(pb.asset, pb.size !== null)) { keep.push({ ...pb, seq: i }); out.skipped++; return; }
      const w = toWorld(xf, pb.pos, pb.orient), id = s.alloc();
      putPlain(s, id, { ...pb, pos: w.pos, orient: w.orient, seq: i }, bricks.linear[i]!, name);
    });
    if (keep.length) set.unsupported.set(g.id, keep);
    out.grids++;
    if (!exactTurn(xf)) out.snapped++;
  }
  return out;
}
