import type { Mat4 } from '../core/math.ts';
import type { V3 } from '../scene/brick.ts';

export const NEAR = 0.04;
export const FLY_HALF = 2.4;
export const CAM_PAD = 0.1;
export const PLAYER_HALF_WIDTH = 0.23;
export const PLAYER_EYE = 0.88;
export const PLAYER_HEIGHT = 0.96;
export const DIST_MIN = 0.15, DIST_MAX = 3000;

export interface Persp {
  on: boolean;
  fly: boolean;
  follow: boolean;
  fovDeg: number;
  dist: number;
  effDist: number;
  anchor: V3;
  eye: V3;
  sig: string;
  fx: number;
  fy: number;
}

export const persp: Persp = {
  on: false, fly: false, follow: false, fovDeg: 60, dist: 6, effDist: 6,
  anchor: [0, 0, 0], eye: [0, 0, 0], sig: '', fx: 1, fy: 1,
};

export interface PerspOps {
  tick(w: number, h: number): void;
  look(dxPx: number, dyPx: number): void;
  pan(dxPx: number, dyPx: number, cw: number, ch: number): void;
  zoom(g: number): void;
  move(right: number, forward: number, up: number, dt: number): void;
  rootAt(point: readonly number[], follow: boolean): void;
}

const NOOP_OPS: PerspOps = { tick() {}, look() {}, pan() {}, zoom() {}, move() {}, rootAt() {} };
export const ops: PerspOps = { ...NOOP_OPS };

export const tanHalf = (fovDeg: number = persp.fovDeg): number => Math.tan(fovDeg * Math.PI / 360);

export interface Basis { r: V3; u: V3; f: V3 }

export function basisOf(m: Mat4): Basis {
  return {
    r: [m[0]!, m[8]!, m[4]!],
    u: [m[1]!, m[9]!, m[5]!],
    f: [-m[2]!, -m[10]!, -m[6]!],
  };
}

export function perspMatrix(fx: number, fy: number, t: number, near: number, far: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1 / (t * fx); m[5] = 1 / (t * fy);
  m[10] = (far + near) / (near - far); m[11] = -1;
  m[14] = 2 * far * near / (near - far);
  return m;
}

export function eyeTranslation(rel: V3): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -rel[0], -rel[2], -rel[1], 1]);
}

const BEHIND = 1e6;

export function projectPseudo(m: Mat4, rel: V3, half: number, t: number): [number, number] {
  const x = m[0]! * rel[0] + m[4]! * rel[2] + m[8]! * rel[1];
  const y = m[1]! * rel[0] + m[5]! * rel[2] + m[9]! * rel[1];
  const z = -(m[2]! * rel[0] + m[6]! * rel[2] + m[10]! * rel[1]);
  if (z < NEAR * 0.25) return [x >= 0 ? BEHIND : -BEHIND, y >= 0 ? BEHIND : -BEHIND];
  const k = half / (z * t);
  return [x * k, y * k];
}

export function rayDirection(m: Mat4, vx: number, vy: number, half: number, t: number): V3 {
  const { r, u, f } = basisOf(m), a = vx / half * t, b = vy / half * t;
  const d: V3 = [f[0] + r[0] * a + u[0] * b, f[1] + r[1] * a + u[1] * b, f[2] + r[2] * a + u[2] * b];
  const L = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / L, d[1] / L, d[2] / L];
}

export type Box = readonly [V3, V3];

const contains = (b: Box, p: readonly number[]): boolean => {
  for (let i = 0; i < 3; i++) if (p[i]! < b[0][i]! || p[i]! > b[1][i]!) return false;
  return true;
};

export function castCamera(start: readonly number[], dir: readonly number[], max: number, pad: number, boxes: readonly Box[]): number {
  let best = max;
  for (const b of boxes) {
    if (contains(b, start)) continue;
    let t0 = 0, t1 = best;
    let ok = true;
    for (let i = 0; i < 3 && ok; i++) {
      const lo = b[0][i]! - pad, hi = b[1][i]! + pad, d = dir[i]!, s = start[i]!;
      if (Math.abs(d) < 1e-12) { if (s < lo || s > hi) ok = false; continue; }
      let a = (lo - s) / d, c = (hi - s) / d;
      if (a > c) { const x = a; a = c; c = x; }
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      if (t0 > t1) ok = false;
    }
    if (ok && t0 < best) best = t0;
  }
  return best;
}

export function boomLength(anchor: readonly number[], back: readonly number[], want: number, pad: number, boxes: readonly Box[]): number {
  return Math.max(0, castCamera(anchor, back, want, pad, boxes));
}

export interface Extent { lo: V3; hi: V3 }

const EPS = 1e-6;

export function slideMove(pos: V3, delta: readonly number[], ext: Extent, boxes: readonly Box[]): V3 {
  const p: V3 = [pos[0], pos[1], pos[2]];
  for (let i = 0; i < 3; i++) {
    const d = delta[i]!;
    if (!d) continue;
    p[i] += d;
    for (const b of boxes) {
      let overlap = true;
      for (let j = 0; j < 3 && overlap; j++) overlap = p[j]! + ext.lo[j]! < b[1][j]! - EPS && p[j]! + ext.hi[j]! > b[0][j]! + EPS;
      if (!overlap) continue;
      p[i] = d > 0 ? b[0][i]! - ext.hi[i]! - EPS : b[1][i]! - ext.lo[i]! + EPS;
    }
  }
  return p;
}

export const PLAYER_EXTENT: Extent = {
  lo: [-PLAYER_HALF_WIDTH, -PLAYER_HALF_WIDTH, -PLAYER_EYE],
  hi: [PLAYER_HALF_WIDTH, PLAYER_HALF_WIDTH, PLAYER_HEIGHT - PLAYER_EYE],
};
