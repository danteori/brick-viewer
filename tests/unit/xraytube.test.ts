// X-ray tube (render/cutaway.ts tubeHides): which whole bricks the cutaway hides. Viewer units
// (1 stud = 0.2, a plate 0.08), world X, Y, Z up.

import { describe, expect, it } from 'vitest';
import { tubeHides, type Tube } from '../../src/render/cutaway.ts';

// focus: a 2x2 brick on the floor (top at 0.24); camera straight above-ish from +X +Y, 35 degrees up
const el = 35 * Math.PI / 180, e = [Math.cos(el) / Math.SQRT2, Math.cos(el) / Math.SQRT2, Math.sin(el)];
const flo = [-0.2, -0.2, 0], fhi = [0.2, 0.2, 0.24];
const tube = (r: number, keep = 0.72): Tube => ({ a: [0, 0, 0.12], e, r, level: fhi[2]! + keep, side: 1, lo: flo, hi: fhi });
/** a box of half-extents h centred at c */
const box = (c: number[], h: number[]): [number[], number[]] => [c.map((v, i) => v - h[i]!), c.map((v, i) => v + h[i]!)];
const hides = (t: Tube, c: number[], h: number[]): boolean => { const [lo, hi] = box(c, h); return tubeHides(t, lo, hi); };

describe('X-ray tube', () => {
  const t = tube(0.6);
  it('hides a roof brick over the focus and a ceiling brick straight up the view line', () => {
    expect(hides(t, [0, 0, 2], [2, 2, 0.08])).toBe(true);
    const up = 1.5;   // on the axis, 1.5 units toward the camera
    expect(hides(t, [e[0]! * up, e[1]! * up, 0.12 + e[2]! * up], [0.1, 0.1, 0.1])).toBe(true);
  });
  it('never hides the focus itself or bricks behind it', () => {
    expect(hides(t, [0, 0, 0.12], [0.2, 0.2, 0.12])).toBe(false);
    expect(hides(t, [-1, -1, 1.5], [0.2, 0.2, 0.2])).toBe(false);   // behind: away from the camera
  });
  it('keeps the floor, the bricks beside the focus and anything inside the dead zone', () => {
    expect(hides(t, [0, 0, -0.04], [3, 3, 0.04])).toBe(false);       // floor slab
    expect(hides(t, [0.6, 0.6, 0.12], [0.2, 0.2, 0.12])).toBe(false); // neighbour at the focus's height
    expect(hides(t, [0.6, 0.6, 0.5], [0.2, 0.2, 0.2])).toBe(false);   // a cupboard, top inside the 3-brick dead zone
    expect(hides(tube(0.6, 0), [0.6, 0.6, 0.5], [0.2, 0.2, 0.2])).toBe(true);   // no dead zone: it goes
  });
  it('keeps bricks off to the side of the tube, however high', () => {
    expect(hides(t, [3, -3, 2], [0.2, 0.2, 0.2])).toBe(false);
    expect(hides(tube(5), [3, -3, 2], [0.2, 0.2, 0.2])).toBe(true);    // a wide tube reaches them
  });
  it('looking up from underneath mirrors the keep level', () => {
    const below: Tube = { ...t, e: [e[0]!, e[1]!, -e[2]!], level: flo[2]! - 0.72, side: -1 };
    expect(hides(below, [0, 0, -2], [2, 2, 0.08])).toBe(true);        // a slab far under the focus
    expect(hides(below, [0, 0, 2], [2, 2, 0.08])).toBe(false);        // the roof is behind now
  });
  describe('the far side of the focus always stays (U-33)', () => {
    const el60 = 60 * Math.PI / 180, fromY = [0, Math.cos(el60), Math.sin(el60)];
    const steep: Tube = { ...tube(0.6), e: fromY };
    const wall = (y: number): [number[], number[]] => [[0, y, 1.5], [1, 0.05, 1.5]];
    it('keeps a tall far wall, though its centre is nearer the camera in view depth', () => {
      const [c, h] = wall(-0.6);
      const depth = c[0]! * fromY[0]! + c[1]! * fromY[1]! + (c[2]! - 0.12) * fromY[2]!;
      expect(depth).toBeGreaterThan(0);
      expect(hides(steep, c, h)).toBe(false);
    });
    it('cuts the near wall', () => {
      const [c, h] = wall(0.6);
      expect(hides(steep, c, h)).toBe(true);
    });
    it('keeps both far walls of a room seen from its corner, and cuts the near ones', () => {
      expect(hides(t, [0, -0.6, 1.5], [0.6, 0.05, 1.5])).toBe(false);
      expect(hides(t, [-0.6, 0, 1.5], [0.05, 0.6, 1.5])).toBe(false);
      expect(hides(t, [0, 0.6, 1.5], [0.6, 0.05, 1.5])).toBe(true);
      expect(hides(t, [0.6, 0, 1.5], [0.05, 0.6, 1.5])).toBe(true);
    });
    it('a top-down view uses the view depth test', () => {
      const l = Math.hypot(0.02, 1), down: Tube = { ...tube(0.6), e: [0, 0.02 / l, 1 / l] };
      expect(hides(down, [0, -0.3, 2], [0.1, 0.1, 0.1])).toBe(true);
      expect(hides(steep, [0, -0.3, 2], [0.1, 0.1, 0.1])).toBe(false);
    });
  });
});
