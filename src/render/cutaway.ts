// X-ray cutaway (U-05): a cone from the focused brick toward the camera; every surface inside it is
// cut away (fragment discard), leaving a round hole through roofs and walls down to the focus.
//
// Geometry (view-aligned, so it reads the same at any zoom and orbit):
//   - apex A = the focused brick's centre (live box, so it follows a resize);
//   - axis e = the view direction toward the camera (the ortho camera has no eye point);
//   - for a point P: d = (P - A) . e is its height toward the camera above the apex plane, r its
//     distance from the axis. P is cut when d > 0 and r < R0 + d * tan(spread).
//   - R0 = 1.1 x the focused box's half-diagonal (the whole focus shows) + size x the view's
//     half-height, so the hole keeps its on-screen size as you zoom.
//   - only above a "keep" level: the focused brick's top plus the dead zone (cut.keep), mirrored
//     below its bottom when looking up from underneath. The floor, the bricks beside the focus at its
//     own height and anything low in the room (furniture, counters) stay whole; only what is higher,
//     the upper walls, ceilings and roofs, is cut, so the hole reads as a dollhouse section through
//     the room rather than a pit carved into the floor around the focus.
// The focused brick itself is never cut (fragments inside its box are kept), nor is anything behind
// the apex plane (d <= 0), nor the ground plate, the grid or the overlays.
//
// Cost: the brick program has a second variant compiled with CUT defined; the plain one (no
// discard, so early depth testing stays on) is used whenever the cutaway is off.
// When hidden-face culling (S-02, scene/cull.ts) starts dropping covered faces in the shader, the CUT
// variant must draw them anyway: the hole exposes faces that are covered from outside.
// Picking follows the same rule: a ray starts where it leaves the cone (cutStart), so hover and
// clicks go through the hole to the bricks inside.

import { S } from '../app/state.ts';
import type { Gfx } from './gl.ts';
import { PLATE } from '../core/units.ts';

export const cut = {
  on: false,
  /** 0..1: extra hole radius at the apex, as a fraction of the view's half-height */
  size: 0.2,
  /** cone half-angle, degrees: how fast the hole widens toward the camera */
  spread: 15,
  /** dead zone, viewer units above the focused brick's top (below its bottom from underneath) that are never cut */
  keep: 9 * PLATE,                     // 3 bricks
};

/** World [X,Y,Z] (absolute viewer units) apex, axis toward the camera, base radius, tan(half-angle). */
function params(): { a: number[]; e: number[]; r0: number; t: number; level: number; side: number } {
  const lo = S.dlo, hi = S.dhi, m = S.view;
  const a = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2);
  const half = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const side = m[6] >= 0 ? 1 : -1;                                  // camera above (+1) or below (-1)
  return {
    a, e: [m[2], m[10], m[6]], r0: 1.1 * half + cut.size * S.cam.half, t: Math.tan(cut.spread * Math.PI / 180),
    level: side > 0 ? hi[2] + cut.keep : lo[2] - cut.keep, side,
  };
}
/** cut only where side * (Z - level) > LEVEL_EPS (the floor the brick stands on stays) */
const LEVEL_EPS = 1e-3;

/** True when the cutaway is on and there is a focused brick to cut down to. */
export const cutActive = (): boolean => cut.on && S.sel >= 0 && S.scene.alive(S.sel);

/** For the hover key: changes whenever the hole does. */
export const cutKey = (): string => (cutActive() ? `${cut.size},${cut.spread},${cut.keep}` : '');

/**
 * The ray parameter where a ray S + s D (D = into the view, world [X,Y,Z], absolute) leaves the
 * cone: every surface before it is cut away. -Infinity when nothing on this ray is cut.
 */
export function cutStart(Sv: readonly number[], D: readonly number[]): number {
  if (!cutActive()) return -Infinity;
  const { a, e, r0, t, level, side } = params();
  const q = [Sv[0] - a[0], Sv[1] - a[1], Sv[2] - a[2]];
  const d0 = q[0] * e[0] + q[1] * e[1] + q[2] * e[2];
  const r = Math.hypot(q[0] - d0 * e[0], q[1] - d0 * e[1], q[2] - d0 * e[2]);
  const dmin = r < r0 ? 0 : t > 1e-6 ? (r - r0) / t : Infinity;   // cut while d > dmin
  if (dmin === Infinity) return -Infinity;
  const toward = -(D[0] * e[0] + D[1] * e[1] + D[2] * e[2]) || 1;    // D = -e: d drops by 1 per unit of s
  // and only while side * (Z(s) - level) > eps, Z(s) = Sv.z + D.z s
  const gap = side * (Sv[2] - level) - LEVEL_EPS, rate = side * D[2];
  const sLevel = rate < 0 ? gap / -rate : gap > 0 ? Infinity : -Infinity;
  return Math.min((d0 - dmin) / toward, sLevel);
}

/** Sets the cut uniforms (call each frame while the CUT program is in use). */
export function setCutUniforms(G: Gfx): void {
  // the shader's positions are relative to the render origin, in GL axes (x = X, y = Z, z = Y)
  const { gl, u } = G, { a, r0, t, level, side } = params(), E = 1e-3, lo = S.dlo, hi = S.dhi, o = S.origin;
  gl.uniform3f(u.uCutA, a[0]! - o[0], a[2]! - o[2], a[1]! - o[1]);
  gl.uniform4f(u.uCutK, r0, t, level - o[2], side);
  gl.uniform3f(u.uCutLo, lo[0] - o[0] - E, lo[2] - o[2] - E, lo[1] - o[1] - E);
  gl.uniform3f(u.uCutHi, hi[0] - o[0] + E, hi[2] - o[2] + E, hi[1] - o[1] + E);
}

/** The fragment test, compiled only into the CUT variant of the brick program. */
export const CUT_GLSL = `
#ifdef CUT
uniform vec3 uCutA, uCutLo, uCutHi;
uniform vec4 uCutK;   // base radius, tan(half-angle), the level (world Z) and side (+1 above / -1 below)
uniform float uCutOff, uCutEdge;
uniform vec3 uEye;    // the view direction (the lit shading gets it turned per vertex; the cut needs it here)
bool cutAway(vec3 p){
  if (uCutOff > 0.5 || uCutK.w * (p.y - uCutK.z) <= ${LEVEL_EPS} || all(greaterThanEqual(p, uCutLo)) && all(lessThanEqual(p, uCutHi))) return false;
  vec3 q = p - uCutA;
  float d = dot(q, uEye);
  if (d <= 0.0) return false;
  float R = uCutK.x + d * uCutK.y;
  return dot(q, q) - d * d < R * R;
}
#endif
`;
