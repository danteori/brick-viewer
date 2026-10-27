import { PLATE, STEP } from '../core/units.ts';
import type { Room } from '../render/xraymodes.ts';

/** Grid reach around the focus: studs sideways, bricks below and above. */
export const ROOM_REACH = { side: 48, below: 6, above: 24 };
/** Door-closing radii to try, in studs: a gap narrower than 2 r + 1 studs counts as a wall. */
export const ROOM_CLOSE = [4, 2, 0];
/** Wall thickness measured up to this many studs. */
const WALL_MAX = 10;
const BRICK = 3 * PLATE;

/**
 * Finds the room around a focus box on a coarse grid (a stud wide, a plate tall), bounded by ROOM_REACH.
 * `boxes` is a flat list [lo x y z, hi x y z] per brick (viewer units, the focus included).
 * Free cells next to the focus are flooded; doors are closed by shrinking the free space sideways.
 * Returns null when the flood reaches the grid's sides or bottom (outdoors, or no floor).
 */
export function findRoom(boxes: ArrayLike<number>, flo: readonly number[], fhi: readonly number[]): Room | null {
  const dx = 2 * ROOM_REACH.side + 1, dy = dx;
  const cx = Math.floor((flo[0]! + fhi[0]!) / 2 / STEP), cy = Math.floor((flo[1]! + fhi[1]!) / 2 / STEP);
  const x0 = cx - ROOM_REACH.side, y0 = cy - ROOM_REACH.side;
  const z0 = Math.floor((flo[2]! - ROOM_REACH.below * BRICK) / PLATE + 1e-6);
  const dz = Math.ceil((fhi[2]! + ROOM_REACH.above * BRICK) / PLATE) - z0;
  const solid = new Uint8Array(dx * dy * dz);
  const at = (x: number, y: number, z: number): number => (z * dy + y) * dx + x;
  const range = (lo: number, hi: number, o: number, c: number, n: number): [number, number] => [
    Math.max(0, Math.floor(lo / c + 1e-6) - o), Math.min(n - 1, Math.ceil(hi / c - 1e-6) - 1 - o)];
  for (let k = 0; k < boxes.length; k += 6) {
    const [ax, bx] = range(boxes[k]!, boxes[k + 3]!, x0, STEP, dx), [ay, by] = range(boxes[k + 1]!, boxes[k + 4]!, y0, STEP, dy);
    const [az, bz] = range(boxes[k + 2]!, boxes[k + 5]!, z0, PLATE, dz);
    for (let z = az; z <= bz; z++) for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) solid[at(x, y, z)] = 1;
  }
  const focusCell = [Math.floor(flo[0]! / STEP) - x0, Math.floor(flo[1]! / STEP) - y0, Math.floor(flo[2]! / PLATE) - z0];
  for (const r of ROOM_CLOSE) {
    const room = floodRoom(solid, dx, dy, dz, r, focusCell, [Math.ceil(fhi[0]! / STEP) - x0, Math.ceil(fhi[1]! / STEP) - y0, Math.ceil(fhi[2]! / PLATE) - z0]);
    if (room) return { lo: [(x0 + room.c0[0]!) * STEP, (y0 + room.c0[1]!) * STEP, (z0 + room.c0[2]!) * PLATE], hi: [(x0 + room.c1[0]! + 1) * STEP, (y0 + room.c1[1]! + 1) * STEP, (z0 + room.c1[2]! + 1) * PLATE], t: room.t };
  }
  return null;
}

interface Flood { c0: number[]; c1: number[]; t: [number, number, number, number] }

function shrunkFree(solid: Uint8Array, dx: number, dy: number, dz: number, r: number): Uint8Array {
  if (r === 0) return solid.map((v) => 1 - v);
  const grown = new Uint8Array(solid.length), out = new Uint8Array(solid.length);
  for (let z = 0; z < dz; z++) for (let y = 0; y < dy; y++) {
    const row = (z * dy + y) * dx;
    for (let x = 0; x < dx; x++) {
      if (!solid[row + x]) continue;
      for (let i = Math.max(0, x - r); i <= Math.min(dx - 1, x + r); i++) grown[row + i] = 1;
    }
  }
  for (let z = 0; z < dz; z++) for (let x = 0; x < dx; x++) for (let y = 0; y < dy; y++) {
    if (!grown[(z * dy + y) * dx + x]) continue;
    for (let j = Math.max(0, y - r); j <= Math.min(dy - 1, y + r); j++) out[(z * dy + j) * dx + x] = 1;
  }
  return out.map((v) => 1 - v);
}

function floodRoom(solid: Uint8Array, dx: number, dy: number, dz: number, r: number, fl: number[], fh: number[]): Flood | null {
  const free = shrunkFree(solid, dx, dy, dz, r);
  const seed = nearestFree(free, dx, dy, dz, fl, fh);
  if (seed < 0) return null;
  const seen = new Uint8Array(free.length), queue = new Int32Array(free.length);
  let head = 0, tail = 0;
  queue[tail++] = seed; seen[seed] = 1;
  const c0 = [dx, dy, dz], c1 = [-1, -1, -1], plane = dx * dy;
  while (head < tail) {
    const i = queue[head++]!, x = i % dx, y = Math.floor(i / dx) % dy, z = Math.floor(i / plane);
    if (x === 0 || y === 0 || x === dx - 1 || y === dy - 1 || z === 0) return null;
    c0[0] = Math.min(c0[0]!, x); c1[0] = Math.max(c1[0]!, x); c0[1] = Math.min(c0[1]!, y); c1[1] = Math.max(c1[1]!, y);
    c0[2] = Math.min(c0[2]!, z); c1[2] = Math.max(c1[2]!, z);
    for (const n of [i - 1, i + 1, i - dx, i + dx, i - plane, i + plane]) {
      if (n < 0 || n >= free.length || seen[n] || !free[n]) continue;
      seen[n] = 1; queue[tail++] = n;
    }
  }
  c0[0] = Math.max(0, c0[0]! - r); c1[0] = Math.min(dx - 1, c1[0]! + r); c0[1] = Math.max(0, c0[1]! - r); c1[1] = Math.min(dy - 1, c1[1]! + r);
  return { c0, c1, t: wallThickness(solid, dx, dy, c0, c1) };
}

function nearestFree(free: Uint8Array, dx: number, dy: number, dz: number, fl: number[], fh: number[]): number {
  const reach = 6;
  let best = -1, bestD = Infinity;
  const x0 = Math.max(0, fl[0]! - reach), x1 = Math.min(dx - 1, fh[0]! + reach), y0 = Math.max(0, fl[1]! - reach), y1 = Math.min(dy - 1, fh[1]! + reach);
  const z0 = Math.max(0, fl[2]! - 3 * reach), z1 = Math.min(dz - 1, fh[2]! + 3 * reach);
  const gap = (v: number, lo: number, hi: number): number => (v < lo ? lo - v : v >= hi ? v - hi + 1 : 0);
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (z * dy + y) * dx + x;
    if (!free[i]) continue;
    const d = gap(x, fl[0]!, fh[0]!) ** 2 + gap(y, fl[1]!, fh[1]!) ** 2 + (gap(z, fl[2]!, fh[2]!) / 3) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function wallThickness(solid: Uint8Array, dx: number, dy: number, c0: number[], c1: number[]): [number, number, number, number] {
  const at = (x: number, y: number, z: number): number => (z * dy + y) * dx + x;
  const run = (x: number, y: number, z: number, sx: number, sy: number): number => {
    let n = 0;
    while (n < WALL_MAX) {
      const px = x + sx * n, py = y + sy * n;
      if (px < 0 || py < 0 || px >= dx || py >= dy || !solid[at(px, py, z)]) break;
      n++;
    }
    return n;
  };
  const t: [number, number, number, number] = [0, 0, 0, 0];
  for (let z = c0[2]!; z <= c1[2]!; z++) {
    for (let y = c0[1]!; y <= c1[1]!; y++) {
      t[0] = Math.max(t[0], run(c1[0]! + 1, y, z, 1, 0));
      t[1] = Math.max(t[1], run(c0[0]! - 1, y, z, -1, 0));
    }
    for (let x = c0[0]!; x <= c1[0]!; x++) {
      t[2] = Math.max(t[2], run(x, c1[1]! + 1, z, 0, 1));
      t[3] = Math.max(t[3], run(x, c0[1]! - 1, z, 0, -1));
    }
  }
  return [t[0] * STEP, t[1] * STEP, t[2] * STEP, t[3] * STEP];
}
