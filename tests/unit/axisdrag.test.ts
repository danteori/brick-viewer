import { describe, expect, it } from 'vitest';
import type { AxisDir } from '../../src/app/state.ts';
import { axisDragFinish, axisDragMove, newAxisDrag } from '../../src/editor/axisdrag.ts';
import { dragCounts } from '../../src/editor/dragmath.ts';

const dir = (i: number, v: [number, number]): AxisDir[] => [{ i, d: 1, v }, { i, d: -1, v: [-v[0], -v[1]] }];
const DIRS = [...dir(0, [1, 0]), ...dir(1, [0, 1]), ...dir(2, [0.6, -0.8])];
const PX = 20;

/** A drag placement as dragplace.ts runs it: steps on the axis in progress, finished axes kept. */
function session() {
  const d = newAxisDrag([0, 0]), done = [0, 0, 0];
  let axis = -1, pending = 0;
  const step = (q: AxisDir): void => {
    if (axis !== q.i) { axis = q.i; pending = 0; }
    pending += q.d;
    d.lockAxis = pending ? axis : -1;
  };
  return {
    d,
    to(x: number, y: number): void { axisDragMove(d, [x, y], DIRS, () => PX, step); },
    finish(x: number, y: number): void { if (axis >= 0) done[axis]! += pending; axisDragFinish(d, axis, [x, y]); axis = -1; pending = 0; },
    counts: () => dragCounts(done, axis, pending),
  };
}

describe('axis drag', () => {
  it('snaps to the axis the motion runs along and steps once per grid line', () => {
    const s = session();
    s.to(50, 2);
    expect(s.counts()).toEqual([2, 0, 0]);
    expect(s.d.lockAxis).toBe(0);
  });

  it('stays on the locked axis when the cursor turns away', () => {
    const s = session();
    s.to(50, 0); s.to(50, 80);
    expect(s.counts()[1]).toBe(0);
    expect(s.d.lockAxis).toBe(0);
  });

  it('steps back down to zero, which frees the axis', () => {
    const s = session();
    s.to(30, 0); s.to(0, 0);
    expect(s.counts()).toEqual([0, 0, 0]);
    expect(s.d.lockAxis).toBe(-1);
    s.to(0, 50);
    expect(s.counts()).toEqual([0, 2, 0]);
  });

  it('a right-click finishes the axis: the drag then goes another way, and a third', () => {
    const s = session();
    s.to(50, 0); s.finish(50, 0);
    expect(s.d.bannedAxis).toBe(0);
    s.to(90, 0);
    expect(s.counts()).toEqual([2, 0, 0]);
    s.to(90, 50);
    expect(s.counts()).toEqual([2, 2, 0]);
    s.finish(90, 50);
    s.to(90 + 0.6 * 30, 50 - 0.8 * 30);
    expect(s.counts()).toEqual([2, 2, 1]);
  });

  it('a negative drag counts down', () => {
    const s = session();
    s.to(-70, 0);
    expect(s.counts()).toEqual([-3, 0, 0]);
  });
});
