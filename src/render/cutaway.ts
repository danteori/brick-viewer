// X-ray cutaway (U-05): a straight tube from the focused brick toward the camera. Every brick that
// reaches into the tube in front of the focus is hidden whole, so roofs, ceilings and walls in the
// way open up while nothing beside or behind the focus changes, and no brick is ever sliced open.
//
// Geometry (view-aligned, so it reads the same at any zoom and orbit):
//   - A = the focused brick's centre (live box, so it follows a resize);
//   - e = the view direction toward the camera. The camera is orthographic, so what can hide the
//     focus lies in a straight tube along e (a cone would only widen it for nothing);
//   - radius R = 1.1 x the focused box's half-diagonal (the whole focus shows) + size x the view's
//     half-height, so the hole keeps its on-screen size as you zoom;
//   - a brick (its box) is hidden when all of these hold:
//       it overlaps the tube: its box, seen along e, comes within R of the axis. Tested on the three
//       axes e x X, e x Y, e x Z (boxes are world-aligned: quarter turns only), so a box near a
//       corner of the disc can count as touching it; that errs toward showing more of the interior;
//       it is in front of the focus: its centre is nearer the camera than A;
//       it rises above the "keep" level: the focused brick's top plus the dead zone (cut.keep),
//       mirrored below its bottom when looking up from underneath. The floor, the bricks beside the
//       focus at its height and anything low in the room (furniture, counters) stay.
// The focused brick (and anything inside its box) is never hidden, nor the ground plate or the overlays.
//
// Cost: the brick program has a second variant compiled with CUT defined; the vertex shader moves
// a hidden brick's vertices out of the clip volume (as hidden-face culling does), so it costs
// nothing per pixel. The plain variant is used whenever the cutaway is off. The CUT variant draws
// covered faces too (uShowHidden): hiding a brick exposes faces covered from outside.
// Picking follows the same rule (cutHides), so hover and clicks go through the hole to the bricks inside.

import { S } from '../app/state.ts';
import type { Gfx } from './gl.ts';
import { PLATE } from '../core/units.ts';

export const cut = {
  on: false,
  /** 0..1: extra tube radius around the focus, as a fraction of the view's half-height */
  size: 0.2,
  /** dead zone, viewer units above the focused brick's top (below its bottom from underneath) that are never cut */
  keep: 15 * PLATE,
};

/** The tube in world [X,Y,Z] (absolute viewer units): centre a, axis e toward the camera, radius r; the keep level and side. */
export interface Tube { a: number[]; e: number[]; r: number; level: number; side: number; lo: readonly number[]; hi: readonly number[] }

function params(): Tube {
  const lo = S.dlo, hi = S.dhi, m = S.view;
  const a = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2);
  const half = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const side = m[6] >= 0 ? 1 : -1;                                  // camera above (+1) or below (-1)
  return { a, e: [m[2], m[10], m[6]], r: 1.1 * half + cut.size * S.cam.half, level: side > 0 ? hi[2] + cut.keep : lo[2] - cut.keep, side, lo, hi };
}
/** a brick must rise more than this above the keep level to be hidden */
const LEVEL_EPS = 1e-3;
/** inside the focus box, within this */
const BOX_EPS = 1e-3;

/** True when the cutaway is on and there is a focused brick to cut down to. */
export const cutActive = (): boolean => cut.on && S.sel >= 0 && S.scene.alive(S.sel);

/** For the hover key: changes whenever the hole does. */
export const cutKey = (): string => (cutActive() ? `${cut.size},${cut.keep}` : '');

/** The tube for this frame, or null when the cutaway is off (picking calls this once per ray). */
export const cutTube = (): Tube | null => (cutActive() ? params() : null);

/** The shared test (the shader's cutHides is the same maths): box [lo, hi], world X,Y,Z, absolute viewer units. */
export function tubeHides(t: Tube, lo: ArrayLike<number>, hi: ArrayLike<number>): boolean {
  let inFocus = true;
  for (let i = 0; i < 3; i++) if (lo[i]! < t.lo[i]! - BOX_EPS || hi[i]! > t.hi[i]! + BOX_EPS) { inFocus = false; break; }
  if (inFocus) return false;
  const top = t.side > 0 ? hi[2]! : lo[2]!;
  if (t.side * (top - t.level) <= LEVEL_EPS) return false;
  const c = [0, 1, 2].map((i) => (lo[i]! + hi[i]!) / 2), h = [0, 1, 2].map((i) => (hi[i]! - lo[i]!) / 2);
  const q = [c[0]! - t.a[0]!, c[1]! - t.a[1]!, c[2]! - t.a[2]!], e = t.e;
  if (q[0]! * e[0]! + q[1]! * e[1]! + q[2]! * e[2]! <= 0) return false;
  for (let i = 0; i < 3; i++) {
    // n = e x (unit axis i)
    const n = i === 0 ? [0, e[2]!, -e[1]!] : i === 1 ? [-e[2]!, 0, e[0]!] : [e[1]!, -e[0]!, 0];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (l < 1e-4) continue;
    const d = Math.abs(q[0]! * n[0]! + q[1]! * n[1]! + q[2]! * n[2]!) / l;
    const ext = (Math.abs(n[0]!) * h[0]! + Math.abs(n[1]!) * h[1]! + Math.abs(n[2]!) * h[2]!) / l;
    if (d > t.r + ext) return false;
  }
  return true;
}

/** True when the cutaway hides box [lo, hi] (absolute viewer units). */
export const cutHides = (lo: ArrayLike<number>, hi: ArrayLike<number>): boolean => { const t = cutTube(); return !!t && tubeHides(t, lo, hi); };

/** Sets the cut uniforms (call each frame while the CUT program is in use). */
export function setCutUniforms(G: Gfx): void {
  // the shader's positions are relative to the render origin, in GL axes (x = X, y = Z, z = Y)
  const { gl, u } = G, { a, r, level, side } = params(), E = BOX_EPS, lo = S.dlo, hi = S.dhi, o = S.origin;
  gl.uniform3f(u.uCutA, a[0]! - o[0], a[2]! - o[2], a[1]! - o[1]);
  gl.uniform4f(u.uCutK, r, 0, level - o[2], side);
  gl.uniform3f(u.uCutLo, lo[0] - o[0] - E, lo[2] - o[2] - E, lo[1] - o[1] - E);
  gl.uniform3f(u.uCutHi, hi[0] - o[0] + E, hi[2] - o[2] + E, hi[1] - o[1] + E);
}

/** The per-brick test, compiled only into the CUT variant's vertex shader (GL axes: y is up). */
export const CUT_VS_GLSL = `
#ifdef CUT
uniform vec3 uCutA, uCutLo, uCutHi;
uniform vec4 uCutK;   // tube radius, unused, the keep level (world Z) and side (+1 above / -1 below)
uniform float uCutOff, uCutEdge, uEdge;
// box centre c, half-extents h (GL axes, relative to the render origin)
bool cutHides(vec3 c, vec3 h){
  if (uCutOff > 0.5) return false;
  if (all(greaterThanEqual(c - h, uCutLo)) && all(lessThanEqual(c + h, uCutHi))) return false;
  float top = uCutK.w > 0.0 ? c.y + h.y : c.y - h.y;
  if (uCutK.w * (top - uCutK.z) <= ${LEVEL_EPS}) return false;
  vec3 q = c - uCutA;
  if (dot(q, uEye) <= 0.0) return false;
  for (int i = 0; i < 3; i++) {
    vec3 n = cross(uEye, vec3(i == 0 ? 1.0 : 0.0, i == 1 ? 1.0 : 0.0, i == 2 ? 1.0 : 0.0));
    float l = length(n);
    if (l < 1e-4) continue;
    n /= l;
    if (abs(dot(q, n)) > uCutK.x + dot(abs(n), h)) return false;
  }
  return true;
}
#endif
`;
