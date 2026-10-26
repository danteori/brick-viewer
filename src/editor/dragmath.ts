import { r3 } from '../core/units.ts';
import type { V3 } from '../scene/brick.ts';

/** U-29: a drag stretches one brick (resize) or tiles copies of the ghost (repeat). Values are viewer units. */
export type DragMode = 'resize' | 'repeat';

/**
 * The signed steps of a drag on each axis: the finished axes plus the one in progress. A positive
 * count grows the high side, a negative count the low side.
 */
export const dragCounts = (done: readonly number[], axis: number, pending: number): V3 =>
  [0, 1, 2].map((i) => done[i]! + (i === axis ? pending : 0)) as V3;

export interface RepeatSpan {
  /** the low corner of the whole tiling */
  lo: V3;
  /** copies along each axis */
  n: V3;
}

/** Drag repeat: |k| more copies of a ghost of size `cell` on each axis, from the start copy at `start`. */
export function repeatSpan(start: readonly number[], cell: readonly number[], k: readonly number[]): RepeatSpan {
  const n = k.map((v) => Math.abs(v) + 1) as V3;
  const lo = [0, 1, 2].map((i) => r3(start[i]! + Math.min(0, k[i]!) * cell[i]!)) as V3;
  return { lo, n };
}

/** The number of copies in a tiling. */
export const copyCount = (s: RepeatSpan): number => s.n[0] * s.n[1] * s.n[2];

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

const EPS = 1e-6;

/**
 * Drag resize: the brick box [lo, hi] grown by |k| size steps on each axis. Null when a fixed axis
 * would change or an axis would grow past `rule.max`. It never shrinks below the start box.
 */
export function stretchBox(lo: readonly number[], hi: readonly number[], k: readonly number[], rule: StretchRule): { lo: V3; hi: V3 } | null {
  const l = lo.slice() as V3, h = hi.slice() as V3;
  for (let i = 0; i < 3; i++) {
    const n = k[i]!;
    if (!n) continue;
    const grow = Math.abs(n) * rule.steps[i]!;
    if (rule.fix[i] || h[i] - l[i] + grow > rule.max + EPS) return null;
    if (n > 0) h[i] = r3(h[i] + grow); else l[i] = r3(l[i] - grow);
  }
  return { lo: l, hi: h };
}

/** Can a drag resize stretch this ghost? (One brick, not a fixed size, one free axis.) */
export const canStretch = (count: number, fixedSize: boolean, fix: readonly boolean[]): boolean =>
  count === 1 && !fixedSize && fix.some((f) => !f);
