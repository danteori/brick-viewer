// Free camera moves for Explore mode (U-24): pan, orbit about a fixed point, zoom toward a point.
// They change S.cam (the view-plane offset from the render origin, plus the half-height) and the
// orbit angles directly, with no framing of the focused brick. The orthographic projection lives in
// updateCamera; a perspective camera (U-24 phase B) would replace these three moves, not the callers.

import { S } from '../app/state.ts';
import { viewOf } from '../core/math.ts';
import { minHalf, PITCH_MAX, PITCH_MIN, updateDirs, ZOOM_MAX, ZOOM_MIN } from './camera.ts';
import type { V3 } from '../scene/brick.ts';

/** Past this view-plane distance from the render origin the origin is moved onto the camera (float32 stays exact). */
const REBASE = 200;

/** View-plane units per CSS pixel at the current zoom. */
export const unitsPerPx = (cw: number, ch: number): number => 2 * S.cam.half / Math.max(1, Math.min(cw, ch));

export function panBy(dxPx: number, dyPx: number, cw: number, ch: number): void {
  const u = unitsPerPx(cw, ch);
  S.cam.x -= dxPx * u; S.cam.y += dyPx * u;
}

/** Pan by a fraction of the view height (WASD): +x right, +y up. */
export function panView(fx: number, fy: number): void { S.cam.x += fx * S.cam.half; S.cam.y += fy * S.cam.half; }

/** Zoom by factor g (>1 zooms out) keeping the point under (px, py) CSS px fixed. */
export function zoomAt(g: number, px: number, py: number, cw: number, ch: number): void {
  const cam = S.cam, fx = Math.max(cw / ch, 1), fy = Math.max(ch / cw, 1);
  const half = Math.min(minHalf() * ZOOM_MAX, Math.max(minHalf() * ZOOM_MIN, cam.half * g));
  const ux = 2 * px / cw - 1, uy = 1 - 2 * py / ch;
  cam.x += ux * fx * (cam.half - half); cam.y += uy * fy * (cam.half - half);
  cam.half = half;
}

/** The world point (relative to the render origin) that sits at the screen centre: on the ground plane when the view is steep enough, else at the origin's depth. */
export function centrePoint(): V3 {
  const m = S.view, { x: cx, y: cy } = S.cam;
  const det = m[0]! * m[9]! - m[8]! * m[1]!;
  if (Math.abs(det) > 0.2) {
    const X = (cx * m[9]! - m[8]! * cy) / det, Y = (m[0]! * cy - m[1]! * cx) / det;
    return [X, Y, 0];
  }
  return [cx * m[0]! + cy * m[1]!, cx * m[8]! + cy * m[9]!, cx * m[4]! + cy * m[5]!];
}

/** Orbit by a pointer delta about `pivot` (relative to the render origin): the pivot stays put on screen. Free angles; pitch keeps the usual limits. */
export function orbitAbout(pivot: V3, dxPx: number, dyPx: number): void {
  const o = S.orbit;
  o.yawT += dxPx * 0.008;
  o.pitchT = Math.max(PITCH_MIN, Math.min(PITCH_MAX, o.pitchT + dyPx * 0.006));
  o.yaw = o.yawT; o.pitch = o.pitchT;
  S.viewT = viewOf(o.yawT, o.pitchT); S.view = viewOf(o.yaw, o.pitch); updateDirs();
  const m = S.view;
  S.cam.x = m[0]! * pivot[0] + m[4]! * pivot[2] + m[8]! * pivot[1];
  S.cam.y = m[1]! * pivot[0] + m[5]! * pivot[2] + m[9]! * pivot[1];
}

/** Moves the render origin onto the camera's centre line when the camera has drifted far from it. */
export function rebaseOrigin(): void {
  const { x, y } = S.cam;
  if (Math.hypot(x, y) < REBASE) return;
  const m = S.view;
  const d = [x * m[0]! + y * m[1]!, x * m[8]! + y * m[9]!, x * m[4]! + y * m[5]!].map((v) => +v.toFixed(3)) as V3;   // X, Y, Z of the depth-0 point
  S.origin = S.origin.map((v, i) => +(v + d[i]!).toFixed(3)) as V3;
  S.cam.x -= m[0]! * d[0] + m[4]! * d[2] + m[8]! * d[1];
  S.cam.y -= m[1]! * d[0] + m[5]! * d[2] + m[9]! * d[1];
}
