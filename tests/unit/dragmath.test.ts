import { describe, expect, it } from 'vitest';
import { canStretch, capCounts, planeAxes, repeatCorners, repeatSpan, resizeBox } from '../../src/editor/dragmath.ts';
import type { V3 } from '../../src/scene/brick.ts';

const STEP = 0.2, PLATE = 0.08;
const brickRule = { steps: [STEP, STEP, PLATE], fix: [false, false, false], max: 12 };

describe('planeAxes', () => {
  it('the ground drags on X and Y, a side face on the other two axes', () => {
    expect(planeAxes(2)).toEqual([0, 1]);
    expect(planeAxes(0)).toEqual([1, 2]);
  });
});

describe('resizeBox', () => {
  const lo = [0, 0, 0], hi = [0.4, 0.4, 0.24];

  it('stays the start box while the point is inside it', () => {
    expect(resizeBox(lo, hi, [0.3, 0.1, 5], [0, 1], brickRule)).toEqual({ lo: [0, 0, 0], hi: [0.4, 0.4, 0.24] });
  });

  it('grows in whole studs to cover the point, on both plane axes', () => {
    expect(resizeBox(lo, hi, [1.01, 0.75, 0], [0, 1], brickRule)).toEqual({ lo: [0, 0, 0], hi: [1.2, 0.8, 0.24] });
  });

  it('grows the low side toward a point below the start', () => {
    expect(resizeBox(lo, hi, [-0.5, 0.2, 0], [0, 1], brickRule)).toEqual({ lo: [-0.6, 0, 0], hi: [0.4, 0.4, 0.24] });
  });

  it('keeps the height off the plane, and plates when the plane is a side face', () => {
    expect(resizeBox(lo, hi, [9, 0.2, 0.5], [1, 2], brickRule)).toEqual({ lo: [0, 0, 0], hi: [0.4, 0.4, 0.56] });
  });

  it('keeps fixed axes and stops at the size limit', () => {
    const r = resizeBox(lo, hi, [50, 50, 0], [0, 1], { ...brickRule, fix: [false, true, false] });
    expect(r.hi).toEqual([12, 0.4, 0.24]);
  });
});

describe('repeatSpan', () => {
  const cell = [0.4, 0.4, 0.24];

  it('one copy while the point is in the start cell', () => {
    expect(repeatSpan([0, 0, 0], cell, [0.39, 0.01, 0], [0, 1])).toEqual({ lo: [0, 0, 0], n: [1, 1, 1] });
  });

  it('a row along one axis', () => {
    const s = repeatSpan([0, 0, 0], cell, [1.3, 0.2, 0], [0, 1]);
    expect(s).toEqual({ lo: [0, 0, 0], n: [4, 1, 1] });
    expect(repeatCorners(s, cell)).toEqual([[0, 0, 0], [0.4, 0, 0], [0.8, 0, 0], [1.2, 0, 0]]);
  });

  it('a grid toward negative X and positive Y, anchored on the start copy', () => {
    const s = repeatSpan([1, 1, 0], cell, [0.5, 1.5, 0], [0, 1]);
    expect(s).toEqual({ lo: [0.2, 1, 0], n: [3, 2, 1] });
    const c = repeatCorners(s, cell);
    expect(c).toHaveLength(6);
    expect(c).toContainEqual([1, 1, 0]);
  });

  it('a wall up a side face', () => {
    expect(repeatSpan([0, 0, 0], cell, [0, 0.1, 0.6], [1, 2])).toEqual({ lo: [0, 0, 0], n: [1, 1, 3] });
  });

  it('tiles a selection ghost by its own bounding box, with no overlap between copies', () => {
    const items = [{ lo: [0, 0, 0], hi: [0.4, 0.2, 0.24] }, { lo: [0.2, 0.2, 0], hi: [0.6, 0.4, 0.08] }];
    const size = [0, 1, 2].map((i) => Math.max(...items.map((t) => t.hi[i]!)));
    const s = repeatSpan([0, 0, 0], size, [1.3, 0.5, 0], [0, 1]);
    expect(s.n).toEqual([3, 2, 1]);
    const boxes = repeatCorners(s, size).flatMap((c) => items.map((t) => ({ lo: t.lo.map((v, i) => v + c[i]!), hi: t.hi.map((v, i) => v + c[i]!) })));
    const overlap = (a: typeof boxes[0], b: typeof boxes[0]): boolean => [0, 1, 2].every((i) => a.lo[i]! < b.hi[i]! - 1e-9 && b.lo[i]! < a.hi[i]! - 1e-9);
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) expect(overlap(boxes[a]!, boxes[b]!)).toBe(false);
  });

  it('a cap keeps the copy count down', () => {
    const s = repeatSpan([0, 0, 0], cell, [40, 40, 0], [0, 1], 100);
    expect(s.n[0] * s.n[1]).toBeLessThanOrEqual(100);
    expect(s.lo).toEqual([0, 0, 0]);
  });
});

describe('capCounts and canStretch', () => {
  it('lowers the largest count first', () => {
    expect(capCounts([10, 2, 1] as V3, 10)).toEqual([5, 2, 1]);
  });
  it('only one free brick can stretch', () => {
    expect(canStretch(1, false, [false, false, false], [0, 1])).toBe(true);
    expect(canStretch(2, false, [false, false, false], [0, 1])).toBe(false);
    expect(canStretch(1, true, [true, true, true], [0, 1])).toBe(false);
    expect(canStretch(1, false, [true, true, false], [0, 1])).toBe(false);
  });
});
