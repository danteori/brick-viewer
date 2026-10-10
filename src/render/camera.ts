// Orbit camera (orthographic): view = Rx(pitch) * Ry(yaw). The default is the isometric view
// (pitch 35.264 deg elevation, yaw -45 deg). Middle-drag orbits freely; starting a resize eases back
// to the nearest of the four isometric corners: above the brick, or below it (pitch -35.264 deg) when
// the view is looking up from underneath, so the bottom face can be grabbed (U-03). Ported from the legacy viewer: the easing and the
// framing maths are part of the pixel reference.

import { viewOf, type Mat4 } from '../core/math.ts';
import { STEP } from '../core/units.ts';
import { ELEV, S, YAW0 } from '../app/state.ts';
import type { V3 } from '../scene/brick.ts';
import { pinned, proposedBox } from '../editor/resize.ts';

export const PITCH_MIN = -80 * Math.PI / 180, PITCH_MAX = 80 * Math.PI / 180;   // below 0 = looking up at the underside
export const ZOOM_MIN = 0.3, ZOOM_MAX = 60;           // wide: a big save framed around one small brick needs room

let canvas: HTMLCanvasElement;
export function initCamera(c: HTMLCanvasElement): void {
  canvas = c;
  S.cam.half = minHalf();
  updateDirs();
}

/**
 * World point (absolute, Z up) -> 2D view-plane coords relative to the render origin S.origin, the
 * frame the camera (S.cam) lives in. GL x = X, GL y = Z, GL z = Y.
 */
export function toView(X: number, Y: number, Z: number, m: Mat4 = S.view): [number, number] {
  return viewDir(X - S.origin[0], Y - S.origin[1], Z - S.origin[2], m);
}

/** A world direction (or an origin-relative point) -> view-plane coords. */
export function viewDir(X: number, Y: number, Z: number, m: Mat4 = S.view): [number, number] {
  return [m[0] * X + m[4] * Z + m[8] * Y, m[1] * X + m[5] * Z + m[9] * Y];
}

/** From the view's z row: world +X is GL x (m[2]), world +Y is GL z (m[10]); Z: top, or bottom from below. */
export function updateNear(m: Mat4): void { S.ns = [m[2] >= 0 ? 1 : -1, m[10] >= 0 ? 1 : -1, m[6] >= 0 ? 1 : -1]; }

/** nearest isometric corner to a yaw */
export const snapYaw = (y: number): number => YAW0 + Math.round((y - YAW0) / (Math.PI / 2)) * (Math.PI / 2);
/** the view looks up from below the horizon (where the target pitch is heading) */
export const fromBelow = (): boolean => S.orbit.pitchT < 0;
export function snapToIso(): void {
  S.orbit.yawT = snapYaw(S.orbit.yawT); S.orbit.pitchT = fromBelow() ? -ELEV : ELEV;
  S.viewT = viewOf(S.orbit.yawT, S.orbit.pitchT); updateDirs();
}
/** U: glide to the nearest iso corner on the other side (above <-> below). Not mid-drag. */
export function flipUnderside(): void {
  if (S.held || S.orbit.dragging) return;
  S.orbit.yawT = snapYaw(S.orbit.yawT); S.orbit.pitchT = fromBelow() ? ELEV : -ELEV;
  S.viewT = viewOf(S.orbit.yawT, S.orbit.pitchT); updateDirs();
}
export const isoSettling = (): boolean => Math.abs(S.orbit.yaw - S.orbit.yawT) + Math.abs(S.orbit.pitch - S.orbit.pitchT) > 1e-4;

/**
 * Six screen-space axis directions (px, y down), from the target view: each world axis projected
 * to the screen. d is the world direction along axis i that way points.
 */
export function updateDirs(): void {
  updateNear(S.viewT);
  S.dirs.length = 0;
  for (let i = 0; i < 3; i++) {
    const p = viewDir(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0, S.viewT), L = Math.hypot(p[0], p[1]) || 1;
    const v: [number, number] = [p[0] / L, -p[1] / L];
    S.dirs.push({ i, d: 1, v }, { i, d: -1, v: [-v[0], -v[1]] });
  }
}

/** The near face of each axis is the one that moves; the far face stays put. */
export const nearOf = (i: number, l: readonly number[] = S.lo, h: readonly number[] = S.hi): number => (S.ns[i] > 0 ? h[i] : l[i]);
export const farOf = (i: number, l: readonly number[] = S.lo, h: readonly number[] = S.hi): number => (S.ns[i] > 0 ? l[i] : h[i]);

/** tightest framing, scaled so the default reads the same size */
export const minHalf = (): number => 1.2 * S.STEPS[0] / STEP;

/** view-plane bounds [x0,x1,y0,y1] of a box */
export function extents(l: readonly number[], u: readonly number[]): [number, number, number, number] {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let c = 0; c < 8; c++) {
    const v = toView(c & 1 ? u[0] : l[0], c & 2 ? u[1] : l[1], c & 4 ? u[2] : l[2]);
    x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]);
  }
  return [x0, x1, y0, y1];
}

/** Camera half-height that fits box [l, h] with margin, never tighter than the default framing. */
export function fitHalf(l: readonly number[], h: readonly number[]): number {
  const cw = canvas.clientWidth || innerWidth, ch = canvas.clientHeight || innerHeight;
  const fx = Math.max(cw / ch, 1), fy = Math.max(ch / cw, 1), [x0, x1, y0, y1] = extents(l, h);
  return Math.max(minHalf(), 1.25 * (x1 - x0) / 2 / fx, 1.25 * (y1 - y0) / 2 / fy);
}

/** On-screen length (CSS px) of one grid step along axis i at the current zoom. */
export function studPx(i: number): number {
  const cw = canvas.clientWidth || innerWidth, ch = canvas.clientHeight || innerHeight;
  const ppu = ch / (2 * S.cam.half * Math.max(cw ? ch / cw : 1, 1));   // px per view-plane unit
  const v = viewDir(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
  return S.STEPS[i] * Math.hypot(v[0], v[1]) * ppu;                  // a plate's height for Z
}

/**
 * One frame of camera motion for a w x h drawing buffer: ease the view toward the target (the iso
 * snap), then pan / zoom to frame the focused brick (with any resize ghost).
 */
export function updateCamera(w: number, h: number): void {
  const { orbit, cam, dlo, dhi } = S;
  for (let i = 0; i < 3; i++) { dlo[i] = S.lo[i]; dhi[i] = S.hi[i]; }   // snap straight to whole-stud sizes, no easing
  const turning = orbit.dragging || isoSettling();
  orbit.yaw += (orbit.yawT - orbit.yaw) * 0.25; orbit.pitch += (orbit.pitchT - orbit.pitch) * 0.25;
  if (!isoSettling()) { orbit.yaw = orbit.yawT; orbit.pitch = orbit.pitchT; }
  S.view = viewOf(orbit.yaw, orbit.pitch);

  const asp = w / h, fx = Math.max(asp, 1), fy = Math.max(1 / asp, 1);
  const [pl, ph] = proposedBox();
  const ul = dlo.map((v, i) => Math.min(v, pl[i])) as V3, uh = dhi.map((v, i) => Math.max(v, ph[i])) as V3;   // default + ghost
  const [x0, x1, y0, y1] = extents(ul, uh);
  if (turning) {
    // rotating: keep the brick centred exactly (a lagging pan would swim around the spin)
    cam.x = (x0 + x1) / 2; cam.y = (y0 + y1) / 2;
    const needHalf = S.zoomMul * fitHalf(ul, uh);
    cam.half += (needHalf - cam.half) * 0.12;
  } else if (!S.held || S.autoCenter) {
    // released (or auto-center on): glide to the box's centre and fit it with margin
    const needHalf = S.zoomMul * fitHalf(ul, uh);
    cam.x += ((x0 + x1) / 2 - cam.x) * 0.12; cam.y += ((y0 + y1) / 2 - cam.y) * 0.12;
    cam.half += (needHalf - cam.half) * 0.12;
  } else if (!S.userZoomed) {
    // dragging: no panning. Only zoom out if the box nears the screen edge, about the pinned point.
    const P = pinned(), H = cam.half, B = 0.9;
    const ux = (P[0] - cam.x) / (H * fx), uy = (P[1] - cam.y) / (H * fy);
    let k = 1;
    const fit = (dq: number, u: number): void => {
      if (dq > 0 && B - u > 0.05) k = Math.max(k, dq / (B - u));
      if (dq < 0 && B + u > 0.05) k = Math.max(k, -dq / (B + u));
    };
    fit((x1 - P[0]) / (H * fx), ux); fit((x0 - P[0]) / (H * fx), ux);
    fit((y1 - P[1]) / (H * fy), uy); fit((y0 - P[1]) / (H * fy), uy);
    cam.half = H + (H * k - H) * 0.2;
    cam.x = P[0] - ux * cam.half * fx; cam.y = P[1] - uy * cam.half * fy;
  }
}

/** The camera's settle signature (test hook): unchanged values mean the glide has stopped. */
export const camSignature = (): string =>
  [S.cam.x, S.cam.y, S.cam.half, S.orbit.yaw, S.orbit.pitch].map((v) => Math.round(v * 1e12)).join();

export { ELEV, YAW0 };
