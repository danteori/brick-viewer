import { S, hasFocus } from '../app/state.ts';
import { viewOf } from '../core/math.ts';
import { PITCH_MAX, PITCH_MIN, updateDirs, viewDir } from './camera.ts';
import { boxesAlong } from '../scene/spatial.ts';
import type { V3 } from '../scene/brick.ts';
import {
  boomLength, basisOf, CAM_PAD, DIST_MAX, DIST_MIN, FLY_HALF, ops, persp, PLAYER_EXTENT, slideMove, tanHalf,
} from './persp.ts';
import { centrePoint } from './freecam.ts';

const WALK_SPEED = 4;
const EASE_OUT = 0.15;
const REBASE = 60;
const LOOK_YAW = 0.008, LOOK_PITCH = 0.006;

const focusCentre = (): V3 => [0, 1, 2].map((i) => (S.dlo[i]! + S.dhi[i]!) / 2) as V3;
const originCentre = (): V3 => { const c = centrePoint(); return [S.origin[0] + c[0], S.origin[1] + c[1], S.origin[2] + c[2]]; };

function placeView(): void {
  const o = S.orbit;
  o.yaw = o.yawT; o.pitch = o.pitchT;
  S.view = viewOf(o.yaw, o.pitch);
  S.viewT = S.view;
}

function focusExit(a: V3, dir: V3): number {
  if (!hasFocus()) return 0;
  let t = Infinity;
  for (let i = 0; i < 3; i++) {
    if (a[i]! < S.dlo[i]! || a[i]! > S.dhi[i]!) return 0;
    const d = dir[i]!;
    if (Math.abs(d) < 1e-9) continue;
    t = Math.min(t, ((d > 0 ? S.dhi[i]! : S.dlo[i]!) - a[i]!) / d);
  }
  return Number.isFinite(t) ? t : 0;
}

function boomEye(): V3 {
  const { f } = basisOf(S.view), a = persp.anchor;
  const back: V3 = [-f[0], -f[1], -f[2]];
  const want: V3 = [a[0] + back[0] * persp.dist, a[1] + back[1] * persp.dist, a[2] + back[2] * persp.dist];
  const free = boomLength(a, back, persp.dist, CAM_PAD, boxesAlong(a, want, CAM_PAD));
  const len = Math.max(free, focusExit(a, back) + CAM_PAD);
  persp.effDist = len < persp.effDist ? len : Math.min(len, persp.effDist + (len - persp.effDist) * EASE_OUT + 1e-4);
  return [a[0] + back[0] * persp.effDist, a[1] + back[1] * persp.effDist, a[2] + back[2] * persp.effDist];
}

function rebase(): void {
  const e = persp.eye, o = S.origin;
  if (Math.hypot(e[0] - o[0], e[1] - o[1], e[2] - o[2]) < REBASE) return;
  S.origin = e.map((v) => +v.toFixed(3)) as V3;
}

function tick(w: number, h: number): void {
  const asp = w / h;
  persp.fx = Math.max(asp, 1); persp.fy = Math.max(1 / asp, 1);
  const before = S.view;
  placeView();
  if (before[0] !== S.view[0] || before[2] !== S.view[2] || before[4] !== S.view[4] || before[6] !== S.view[6]) updateDirs();
  if (!persp.fly) {
    if (persp.follow && hasFocus()) persp.anchor = focusCentre();
    persp.eye = boomEye();
  }
  rebase();
  S.cam.x = 0; S.cam.y = 0;
  S.cam.half = persp.fly ? FLY_HALF : Math.max(persp.effDist, 0.05) * tanHalf();
  persp.sig = [persp.eye[0], persp.eye[1], persp.eye[2], S.orbit.yaw, S.orbit.pitch, S.cam.half].join();
}

function look(dxPx: number, dyPx: number): void {
  const o = S.orbit;
  o.yawT += dxPx * LOOK_YAW;
  o.pitchT = Math.max(PITCH_MIN, Math.min(PITCH_MAX, o.pitchT + dyPx * LOOK_PITCH));
  placeView(); updateDirs();
}

function moveEye(delta: V3): void {
  persp.eye = slideMove(persp.eye, delta, PLAYER_EXTENT, boxesAlong(persp.eye, [persp.eye[0] + delta[0], persp.eye[1] + delta[1], persp.eye[2] + delta[2]], 0.5));
}

function move(right: number, forward: number, up: number, dt: number): void {
  const { r, f } = basisOf(S.view);
  const hl = Math.hypot(f[0], f[1]) || 1, fh: V3 = [f[0] / hl, f[1] / hl, 0], rl = Math.hypot(r[0], r[1]) || 1, rh: V3 = [r[0] / rl, r[1] / rl, 0];
  const n = Math.hypot(right, forward) || 1;
  if (persp.fly) {
    const s = WALK_SPEED * dt;
    moveEye([(rh[0] * right + fh[0] * forward) / n * s, (rh[1] * right + fh[1] * forward) / n * s, up * s]);
    return;
  }
  const s = Math.max(persp.effDist, 1) * 0.9 * dt;
  if (right || forward || up) persp.follow = false;
  const a = persp.anchor;
  persp.anchor = [a[0] + (rh[0] * right + fh[0] * forward) / n * s, a[1] + (rh[1] * right + fh[1] * forward) / n * s, a[2] + up * s];
}

function pan(dxPx: number, dyPx: number, cw: number, ch: number): void {
  const { r, u } = basisOf(S.view);
  if (persp.fly) {
    const k = 2 * persp.dist * tanHalf() / Math.max(1, Math.min(cw, ch));
    moveEye([(-dxPx * r[0] + dyPx * u[0]) * k, (-dxPx * r[1] + dyPx * u[1]) * k, (-dxPx * r[2] + dyPx * u[2]) * k]);
    return;
  }
  persp.follow = false;
  const k = 2 * persp.effDist * tanHalf() / Math.max(1, Math.min(cw, ch)), a = persp.anchor;
  persp.anchor = [a[0] + (-dxPx * r[0] + dyPx * u[0]) * k, a[1] + (-dxPx * r[1] + dyPx * u[1]) * k, a[2] + (-dxPx * r[2] + dyPx * u[2]) * k];
}

function zoom(g: number): void {
  if (persp.fly) {
    const { f } = basisOf(S.view), s = (1 - g) * 4;
    moveEye([f[0] * s, f[1] * s, f[2] * s]);
    return;
  }
  persp.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, persp.dist * g));
}

function rootAt(point: readonly number[], follow: boolean): void {
  persp.anchor = [point[0]!, point[1]!, point[2]!];
  persp.follow = follow;
  if (persp.fly) setFly(false);
}

export function setFly(on: boolean): void {
  if (!persp.on || on === persp.fly) return;
  const { f } = basisOf(S.view);
  if (on) {
    persp.fly = true;
    persp.follow = false;
  } else {
    persp.fly = false;
    persp.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, persp.dist));
    persp.effDist = persp.dist;
    persp.anchor = [persp.eye[0] + f[0] * persp.dist, persp.eye[1] + f[1] * persp.dist, persp.eye[2] + f[2] * persp.dist];
  }
}

export function setFollow(on: boolean): void {
  if (!persp.on) return;
  if (on && !hasFocus()) return;
  if (on && persp.fly) setFly(false);
  persp.follow = on;
}

export function setPerspective(on: boolean): void {
  if (on === persp.on) return;
  if (on) {
    const t = tanHalf();
    persp.follow = hasFocus();
    persp.anchor = persp.follow ? focusCentre() : originCentre();
    persp.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, S.cam.half / t));
    persp.effDist = persp.dist;
    persp.fly = false;
    placeView();
    persp.on = true;
    persp.eye = boomEye();
    tick(1, 1);
    return;
  }
  if (persp.fly) setFly(false);
  persp.on = false;
  const half = Math.max(persp.effDist, 0.05) * tanHalf();
  const v = viewDir(persp.anchor[0] - S.origin[0], persp.anchor[1] - S.origin[1], persp.anchor[2] - S.origin[2]);
  S.cam.x = v[0]; S.cam.y = v[1]; S.cam.half = half;
}

export function resetRoot(): void {
  if (!persp.on) return;
  if (persp.fly) setFly(false);
  persp.follow = hasFocus();
  persp.anchor = persp.follow ? focusCentre() : persp.anchor;
}

Object.assign(ops, { tick, look, pan, zoom, move, rootAt });
