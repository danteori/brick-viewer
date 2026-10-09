// 4x4 matrices, column-major Float32Array as GL wants them (ported from the legacy viewer; the
// float32 rounding is part of the pixel reference, so keep these exactly as they are).

export type Mat4 = Float32Array;

export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

export function rotX(t: number): Mat4 {
  const c = Math.cos(t), s = Math.sin(t);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

export function rotY(t: number): Mat4 {
  const c = Math.cos(t), s = Math.sin(t);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

/** Orbit view = Rx(pitch) * Ry(yaw). */
export const viewOf = (yaw: number, pitch: number): Mat4 => mul(rotX(pitch), rotY(yaw));

// Large-array helpers. Spreading a big array into a call (push(...a), Math.min(...a)) passes every
// element as an argument and overflows the call stack on saves with hundreds of thousands of bricks.
export function pushAll<T>(dst: T[], src: readonly T[]): void { for (let i = 0; i < src.length; i++) dst.push(src[i]!); }
export function minOf<T>(src: readonly T[], f: (t: T) => number): number { let m = Infinity; for (let i = 0; i < src.length; i++) { const v = f(src[i]!); if (v < m) m = v; } return m; }
export function maxOf<T>(src: readonly T[], f: (t: T) => number): number { let m = -Infinity; for (let i = 0; i < src.length; i++) { const v = f(src[i]!); if (v > m) m = v; } return m; }
