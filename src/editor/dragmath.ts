import { r3 } from '../core/units.ts';
import type { V3 } from '../scene/brick.ts';

/** U-29: a drag stretches one brick (resize) or tiles copies of the ghost (repeat). Values are viewer units. */
export type DragMode = 'resize' | 'repeat';

/** The two axes a drag runs on when the ghost sits on a face along `axis` (2: the ground or a top). */
export const planeAxes = (axis: number): number[] => [0, 1, 2].filter((i) => i !== axis);

const EPS = 1e-6;

/** Whole cells from `from` to `to` (signed): 0 while `to` is inside the first cell. */
const cellIndex = (from: number, to: number, cell: number): number => Math.floor((to - from) / cell + EPS);

/** Lowers the larger counts until their product is at most `cap`. */
export function capCounts(n: V3, cap: number): V3 {
  const out = n.slice() as V3;
  while (out[0] * out[1] * out[2] > cap) {
    const i = [0, 1, 2].reduce((a, b) => (out[b] > out[a] ? b : a), 0);
    if (out[i] <= 1) break;
    out[i]--;
  }
  return out;
}

export interface RepeatSpan {
  /** the low corner of the whole tiling */
  lo: V3;
  /** copies along each axis */
  n: V3;
}

/**
 * Drag repeat: copies of a ghost of size `cell` with its low corner at `start`, tiled toward `point`
 * on the given axes (a row on one, a grid on two). The other axis keeps one copy. `cap` limits the
 * number of copies; the tiling stays anchored on the start copy.
 */
export function repeatSpan(start: readonly number[], cell: readonly number[], point: readonly number[], axes: readonly number[], cap = Infinity): RepeatSpan {
  const k = [0, 0, 0];
  for (const i of axes) k[i] = cellIndex(start[i]!, point[i]!, cell[i]!);
  const n = capCounts(k.map((v) => Math.abs(v) + 1) as V3, cap);
  const lo = [0, 1, 2].map((i) => r3(start[i]! + (k[i]! < 0 ? -(n[i] - 1) * cell[i]! : 0))) as V3;
  return { lo, n };
}

/** The low corner of every copy of a tiling, row by row (X fastest, then Y, then Z). */
export function repeatCorners(span: RepeatSpan, cell: readonly number[]): V3[] {
  const out: V3[] = [];
  for (let z = 0; z < span.n[2]; z++) for (let y = 0; y < span.n[1]; y++) for (let x = 0; x < span.n[0]; x++) {
    out.push([r3(span.lo[0] + x * cell[0]!), r3(span.lo[1] + y * cell[1]!), r3(span.lo[2] + z * cell[2]!)]);
  }
  return out;
}

export interface StretchRule {
  /** the size step of each axis */
  steps: readonly number[];
  /** axes that can't change size */
  fix: readonly boolean[];
  /** the largest size of any axis */
  max: number;
}

/**
 * Drag resize: the brick box [lo, hi] grown, in whole size steps, until it covers `point` on the
 * given axes. It never shrinks below the start box, fixed axes keep their size, and no axis grows
 * past `rule.max` (rounded down to a whole step).
 */
export function resizeBox(lo: readonly number[], hi: readonly number[], point: readonly number[], axes: readonly number[], rule: StretchRule): { lo: V3; hi: V3 } {
  const l = lo.slice() as V3, h = hi.slice() as V3;
  for (const i of axes) {
    if (rule.fix[i]) continue;
    const st = rule.steps[i]!, size = h[i] - l[i];
    const room = Math.max(0, Math.floor((rule.max - size) / st + EPS));
    const past = (d: number): number => Math.min(room, Math.max(0, Math.ceil(d / st - EPS)));
    if (point[i]! > h[i]) h[i] = r3(h[i] + past(point[i]! - h[i]) * st);
    else if (point[i]! < l[i]) l[i] = r3(l[i] - past(l[i] - point[i]!) * st);
  }
  return { lo: l, hi: h };
}

/** Can a drag resize stretch this ghost on these axes? (One brick, not a fixed size, one free axis.) */
export const canStretch = (count: number, fixedSize: boolean, fix: readonly boolean[], axes: readonly number[]): boolean =>
  count === 1 && !fixedSize && axes.some((i) => !fix[i]);
