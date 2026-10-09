// Orientation byte -> rotation. Ported from tools/orient.js (verified in-game 2026-10-08 with
// orient-test_ramps.brz) and the viewer's orient() / BrzWriter.localSize.
//
// o = dir << 2 | rot. Axes are the SAVE's axes (Unreal: X, Y, Z up). The matrix is plain
// components, valid as long as the same axes are used throughout.
//
// brickOrient returns M as 3 ROWS: M[i][j] = world component i of local axis j, so the columns
// are the world images of local +X, +Y, +Z and world = M * local. Every entry is -1, 0 or 1 and
// det = +1 (a proper rotation, never a mirror).
//
// Rule: M = D[dir] * Rz(90deg * rot), where Rz(90) takes local +X to local +Y.
//   dir: local +Z (stud side) ->  0:+X  1:-X  2:+Y  3:-Y  4:+Z  5:-Z
//   rot 0 local +X ->  dirs 0-3: +Z   dir 4: +X   dir 5: -X  (dir 5 = dir 4 turned 180deg about Y)
//   each rot step turns local +X onto where local +Y was (about the stud axis).

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];

/** D[dir] as columns [local X, local Y, local Z], each a world axis vector. */
const D: [Vec3, Vec3, Vec3][] = [
  [Z, neg(Y), X],    // 0: studs +X
  [Z, Y, neg(X)],    // 1: studs -X
  [Z, X, Y],         // 2: studs +Y
  [Z, neg(X), neg(Y)], // 3: studs -Y
  [X, Y, Z],         // 4: upright
  [neg(X), Y, neg(Z)], // 5: upside down (180deg about Y)
];

/** Orientation byte -> 3x3 rotation matrix as rows (world = M * local). */
export function brickOrient(o: number): Mat3 {
  const [cx, cy, cz] = D[(o >> 2) % 6]!;
  // Rz(90*rot) in local space: rot 1 -> local X lands on D's Y, local Y on D's -X; and so on.
  const cols: [Vec3, Vec3] = ([[cx, cy], [cy, neg(cx)], [neg(cx), neg(cy)], [neg(cy), cx]] as [Vec3, Vec3][])[o & 3]!;
  const c: [Vec3, Vec3, Vec3] = [cols[0], cols[1], cz];
  return [0, 1, 2].map((i) => [c[0][i]!, c[1][i]!, c[2][i]!]) as Mat3;
}

/** World half-extents of a brick with local half-extents s: h[i] = sum_j |M[i][j]| * s[j]. */
export function worldHalf(o: number, s: readonly [number, number, number]): Vec3 {
  const M = brickOrient(o);
  return M.map((r) => Math.abs(r[0]) * s[0] + Math.abs(r[1]) * s[1] + Math.abs(r[2]) * s[2]) as Vec3;
}

/** Inverse of worldHalf: world half-extents -> local half-extents (M is a signed permutation). */
export function localSize(o: number, half: readonly [number, number, number]): Vec3 {
  const M = brickOrient(o);
  // local j = sum_i |M[i][j]| * half[i]  (the transpose of the absolute permutation)
  return [0, 1, 2].map((j) => Math.abs(M[0][j]!) * half[0] + Math.abs(M[1][j]!) * half[1] + Math.abs(M[2][j]!) * half[2]) as Vec3;
}

/** +1 studs up, -1 upside down, 0 sideways (the legacy viewer's `up`). */
export function upOf(o: number): 1 | -1 | 0 {
  const dir = o >> 2;
  return dir === 4 ? 1 : dir === 5 ? -1 : 0;
}

/** Axis name of a unit axis vector, e.g. "+X". */
export function axisName(v: readonly number[]): string {
  const i = v.findIndex((c) => c !== 0);
  return (v[i]! > 0 ? '+' : '-') + 'XYZ'[i]!;
}
