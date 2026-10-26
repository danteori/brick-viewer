import { describe, expect, it } from 'vitest';
import { canStretch, copyCount, dragCounts, repeatCorners, repeatSpan, stretchBox } from '../../src/editor/dragmath.ts';

const STEP = 0.2, PLATE = 0.08;
const brickRule = { steps: [STEP, STEP, PLATE], fix: [false, false, false], max: 12 };

describe('dragCounts', () => {
  it('adds the axis in progress to the finished axes', () => {
    expect(dragCounts([2, 0, 0], 1, -3)).toEqual([2, -3, 0]);
    expect(dragCounts([2, 0, 0], 0, 1)).toEqual([3, 0, 0]);
    expect(dragCounts([2, 1, 0], -1, 0)).toEqual([2, 1, 0]);
  });
});

describe('stretchBox', () => {
  const lo = [0, 0, 0], hi = [0.4, 0.4, 0.24];

  it('is the start box with no steps', () => {
    expect(stretchBox(lo, hi, [0, 0, 0], brickRule)).toEqual({ lo: [0, 0, 0], hi: [0.4, 0.4, 0.24] });
  });

  it('grows the high side for positive steps, in size steps of each axis', () => {
    expect(stretchBox(lo, hi, [4, 0, 2], brickRule)).toEqual({ lo: [0, 0, 0], hi: [1.2, 0.4, 0.4] });
  });

  it('grows the low side for negative steps', () => {
    expect(stretchBox(lo, hi, [0, -3, 0], brickRule)).toEqual({ lo: [0, -0.6, 0], hi: [0.4, 0.4, 0.24] });
  });

  it('refuses a fixed axis and a size past the limit', () => {
    expect(stretchBox(lo, hi, [0, 1, 0], { ...brickRule, fix: [false, true, false] })).toBeNull();
    expect(stretchBox(lo, hi, [58, 0, 0], brickRule)?.hi[0]).toBe(12);
    expect(stretchBox(lo, hi, [59, 0, 0], brickRule)).toBeNull();
  });
});

describe('repeatSpan', () => {
  const cell = [0.4, 0.4, 0.24];

  it('one copy with no steps', () => {
    expect(repeatSpan([0, 0, 0], cell, [0, 0, 0])).toEqual({ lo: [0, 0, 0], n: [1, 1, 1] });
  });

  it('a row along one axis', () => {
    const s = repeatSpan([0, 0, 0], cell, [3, 0, 0]);
    expect(s).toEqual({ lo: [0, 0, 0], n: [4, 1, 1] });
    expect(repeatCorners(s, cell)).toEqual([[0, 0, 0], [0.4, 0, 0], [0.8, 0, 0], [1.2, 0, 0]]);
  });

  it('a block on three axes, toward negative X, anchored on the start copy', () => {
    const s = repeatSpan([1, 1, 0], cell, [-2, 1, 2]);
    expect(s).toEqual({ lo: [0.2, 1, 0], n: [3, 2, 3] });
    expect(copyCount(s)).toBe(18);
    expect(repeatCorners(s, cell)).toContainEqual([1, 1, 0]);
  });

  it('tiles a selection ghost by its own bounding box, with no overlap between copies', () => {
    const items = [{ lo: [0, 0, 0], hi: [0.4, 0.2, 0.24] }, { lo: [0.2, 0.2, 0], hi: [0.6, 0.4, 0.08] }];
    const size = [0, 1, 2].map((i) => Math.max(...items.map((t) => t.hi[i]!)));
    const s = repeatSpan([0, 0, 0], size, [2, 1, 0]);
    const boxes = repeatCorners(s, size).flatMap((c) => items.map((t) => ({ lo: t.lo.map((v, i) => v + c[i]!), hi: t.hi.map((v, i) => v + c[i]!) })));
    const overlap = (a: typeof boxes[0], b: typeof boxes[0]): boolean => [0, 1, 2].every((i) => a.lo[i]! < b.hi[i]! - 1e-9 && b.lo[i]! < a.hi[i]! - 1e-9);
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) expect(overlap(boxes[a]!, boxes[b]!)).toBe(false);
  });
});

describe('canStretch', () => {
  it('only one free brick can stretch', () => {
    expect(canStretch(1, false, [false, false, false])).toBe(true);
    expect(canStretch(2, false, [false, false, false])).toBe(false);
    expect(canStretch(1, true, [false, false, false])).toBe(false);
    expect(canStretch(1, false, [true, true, true])).toBe(false);
  });
});
