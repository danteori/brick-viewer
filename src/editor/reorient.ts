// Reorient gesture (backlog E-05), pure logic only: no DOM, no state.
//
// In the game, holding R turns the brick clockwise about its current rotation axis (the stud
// axis, local +Z); holding R and dragging toward an axis direction sets the brick's top (and so
// its rotation axis) to that direction. This module does the maths; the input wiring lives with
// the tool.
//
// Orientation byte o = dir << 2 | rot, with the verified rule M = D[dir] * Rz(90deg * rot) from
// src/core/orient.ts. All vectors here are in the SAVE's axes (Unreal: X, Y, Z up, left-handed).
//
// Why rot+1 is clockwise: each rot step takes local +X to where local +Y was, so in world
// components the brick's +X goes from x to up × x (the plain component cross product; det M = +1).
// In a left-handed world (Unreal's), v -> n × v appears CLOCKWISE when you look along -n, i.e.
// down onto the stud face. That matches the in-game top-down shot: dir 4 goes +X -> +Y -> -X -> -Y,
// clockwise with screen-up = +X and screen-right = +Y. The viewer's camera maps world (X, Y, Z) to
// GL (x, z, y), a mirror that cancels the handedness change, so it looks clockwise on our screen
// too. tests/unit/reorient.test.ts checks both for all 24 orientations.

import { brickOrient, type Vec3 } from '../core/orient.ts';
import type { Mat4 } from '../core/math.ts';

/** The six world axis directions, in the order used to break exact ties. */
export const AXIS_DIRS: readonly Vec3[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** Default drag dead zone in CSS pixels: shorter drags pick no direction. */
export const DRAG_DEAD_ZONE_PX = 16;

/**
 * An axis whose on-screen projection is shorter than this (as a fraction of its true length) is
 * pointing almost straight at or away from the camera, so its screen direction is meaningless and
 * it can't be picked by a drag. 0.25 means it must be at least ~14.5 deg out of the view axis.
 */
export const MIN_SCREEN_PROJECTION = 0.25;

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const col = (o: number, j: number): Vec3 => { const M = brickOrient(o); return [M[0][j] + 0, M[1][j] + 0, M[2][j] + 0]; };   // + 0: no -0 entries

/** World direction of the brick's local +X (its "facing" for the stability rule). */
export const worldX = (o: number): Vec3 => col(o, 0);
/** World direction of the brick's local +Y. */
export const worldY = (o: number): Vec3 => col(o, 1);
/** World direction of the brick's local +Z (the stud side / top / rotation axis). */
export const worldUp = (o: number): Vec3 => col(o, 2);

/** Index 0-5 of a unit world axis vector in dir order (+X -X +Y -Y +Z -Z), or -1. */
export function axisIndex(v: readonly number[]): number {
  for (let i = 0; i < 6; i++) { const a = AXIS_DIRS[i]!; if (a[0] === v[0] && a[1] === v[1] && a[2] === v[2]) return i; }
  return -1;
}

/**
 * One clockwise step about the brick's current up axis (local +Z): rot + 1 within the same dir,
 * wrapping 3 -> 0. Clockwise as seen looking down onto the stud face, in the game and in the
 * viewer (see the header).
 */
export function rotateCW(o: number): number {
  return (o & ~3) | ((o + 1) & 3);
}

/** n steps clockwise (negative = counter-clockwise). */
export function rotateBy(o: number, n: number): number {
  return (o & ~3) | ((((o & 3) + n) % 4 + 4) % 4);
}

/**
 * New orientation whose local +Z points at worldDir (a unit world axis, e.g. [0, 0, 1]).
 * dir comes from worldDir (D[dir]'s +Z column; dir i is exactly AXIS_DIRS[i]). Of the four rots:
 *   1. keep local +X as close as possible to its previous world direction (max dot product);
 *   2. if that ties (old +X lies along worldDir, so every candidate is perpendicular to it),
 *      keep local +Y as close as possible to its previous world direction;
 *   3. any remaining tie takes the lowest rot (can't happen for a proper rotation, but keeps
 *      the result deterministic).
 * For a 90 deg change this equals tipping the brick over the shared edge (the smallest rotation);
 * for worldDir = current up the orientation is unchanged; for worldDir = -up it flips about +X.
 * Throws if worldDir isn't one of the six axis directions.
 */
export function reorientTo(o: number, worldDir: readonly number[]): number {
  const dir = axisIndex(worldDir);
  if (dir < 0) throw new Error(`reorientTo: not a world axis direction: [${worldDir.join(', ')}]`);
  const oldX = worldX(o), oldY = worldY(o);
  let best = dir << 2, bestX = -2, bestY = -2;
  for (let rot = 0; rot < 4; rot++) {
    const c = dir << 2 | rot, sx = dot(worldX(c), oldX), sy = dot(worldY(c), oldY);
    if (sx > bestX || (sx === bestX && sy > bestY)) { best = c; bestX = sx; bestY = sy; }
  }
  return best;
}

/** Screen right and screen up as world-space vectors (save axes). */
export interface CameraBasis { right: Vec3; up: Vec3 }

/**
 * Camera basis from the viewer's view matrix (src/render/camera.ts: world X -> GL x, Z -> GL y,
 * Y -> GL z; toView gives screen x and y-up). right/up are the view's first two rows in world
 * components. Orthographic, so the basis is the same everywhere on screen.
 */
export function cameraBasisFromView(m: Mat4): CameraBasis {
  return { right: [m[0]!, m[8]!, m[4]!], up: [m[1]!, m[9]!, m[5]!] };
}

/**
 * Screen-space drag -> the world axis direction it points along on screen, or null inside the
 * dead zone. drag is [dx, dy] in CSS pixels with y DOWN (pointer-event convention); the basis's
 * up is screen-up. Picks the axis whose projected screen direction makes the smallest angle with
 * the drag, ignoring axes foreshortened below MIN_SCREEN_PROJECTION. Exact angle ties go to the
 * axis with the longer projection (the one more side-on to the camera), then AXIS_DIRS order.
 */
export function dragToWorldDir(
  drag: readonly [number, number],
  basis: CameraBasis,
  deadZone: number = DRAG_DEAD_ZONE_PX,
): Vec3 | null {
  const len = Math.hypot(drag[0], drag[1]);
  if (!(len > deadZone)) return null;
  const ux = drag[0] / len, uy = -drag[1] / len;          // to y-up
  const rl = Math.hypot(...basis.right) || 1, ul = Math.hypot(...basis.up) || 1;
  let best: Vec3 | null = null, bestCos = -Infinity, bestLen = -Infinity;
  const EPS = 1e-9;
  for (const a of AXIS_DIRS) {
    const sx = dot(a, basis.right) / rl, sy = dot(a, basis.up) / ul, pl = Math.hypot(sx, sy);
    if (pl < MIN_SCREEN_PROJECTION) continue;
    const c = (sx * ux + sy * uy) / pl;
    if (c > bestCos + EPS || (Math.abs(c - bestCos) <= EPS && pl > bestLen + EPS)) {
      best = [a[0]!, a[1]!, a[2]!]; bestCos = c; bestLen = pl;
    }
  }
  return best;
}
