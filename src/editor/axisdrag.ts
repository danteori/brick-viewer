import type { AxisDir } from '../app/state.ts';
import { THRESH, TOL } from '../core/units.ts';

/** A step fires once the cursor is SNAP of the way to the next grid line. */
export const SNAP = 0.6;

/**
 * The state of a stepped axis drag (the Resize and Move tools, drag placement): the drag snaps to
 * one axis at a time, a step locks it there, and a right-click finishes that axis.
 */
export interface AxisDrag {
  /** the screen point the next step is measured from */
  anchor: [number, number] | null;
  /** the axis the drag is held to (-1: free to pick) */
  lockAxis: number;
  /** the axis a right-click finished: it can't be picked next */
  bannedAxis: number;
  /** the screen direction the cursor follows now */
  active: AxisDir | null;
  /** the last direction a step went */
  dragDir: AxisDir | null;
  steppedThisDrag: boolean;
}

/** A fresh drag pressed at screen point `p`. */
export const newAxisDrag = (p: [number, number]): AxisDrag =>
  ({ anchor: p, lockAxis: -1, bannedAxis: -1, active: null, dragDir: null, steppedThisDrag: false });

/**
 * The cursor moved to `p`: picks the axis the motion runs along (or keeps the locked one) and calls
 * `step` once for each grid line crossed. `stepPx(i)` is one step along axis i in screen px; `step`
 * sets or clears `d.lockAxis`.
 */
export function axisDragMove(d: AxisDrag, p: [number, number], dirs: readonly AxisDir[], stepPx: (i: number) => number, step: (q: AxisDir) => void): void {
  for (let guard = 0; guard < 200; guard++) {
    const anchor: [number, number] = d.anchor!;
    const dx = p[0] - anchor[0], dy = p[1] - anchor[1], dist = Math.hypot(dx, dy);
    d.active = null;
    if (d.lockAxis >= 0) {
      const pos = dirs.find((q) => q.i === d.lockAxis && q.d > 0)!;
      d.active = dx * pos.v[0] + dy * pos.v[1] >= 0 ? pos : dirs.find((q) => q.i === d.lockAxis && q.d < 0)!;
    } else if (dist > Math.min(6, SNAP * stepPx(0))) {
      let best = dirs[0]!, bestAng = 1e9;
      for (const q of dirs) {
        const ang = Math.acos(Math.max(-1, Math.min(1, (dx * q.v[0] + dy * q.v[1]) / dist)));
        if (ang < bestAng) { bestAng = ang; best = q; }
      }
      if (best.i === d.bannedAxis) { d.anchor = p; break; }
      if (bestAng <= TOL) d.active = best;
    }
    const active: AxisDir | null = d.active;
    const sp = Math.max(4, stepPx(active ? active.i : 0));
    if (active && dx * active.v[0] + dy * active.v[1] >= sp * SNAP) {
      step(active); d.dragDir = active; d.steppedThisDrag = true;
      const along = dx * active.v[0] + dy * active.v[1] - sp;
      d.anchor = [p[0] - active.v[0] * along, p[1] - active.v[1] * along];
      continue;
    }
    if (d.lockAxis < 0 && !active && dist >= Math.max(THRESH, sp) * 2.5) d.anchor = p;
    break;
  }
}

/** A right-click finished axis `done`: it can't be picked next, and the next step starts at the cursor. */
export function axisDragFinish(d: AxisDrag, done: number, cursor: [number, number] | null): void {
  d.bannedAxis = done; d.active = null; d.lockAxis = -1;
  if (cursor) d.anchor = cursor.slice() as [number, number];
  d.steppedThisDrag = false;
}
