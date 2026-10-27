import { describe, expect, it } from 'vitest';
import { HOLE_MARGIN, KEEP_STEP, SIZE_MAX, XRAY_DEFAULTS, fitXray, needFrom, xrayOff } from '../../src/render/xrayfit.ts';

describe('X-ray fit (U-33)', () => {
  it('fits Keep under the lowest covering brick, on the brick grid, and Hole a bit larger than needed', () => {
    expect(needFrom(2 * KEEP_STEP, 0, 3)).toEqual({ size: HOLE_MARGIN, keep: KEEP_STEP });
    expect(needFrom(5 * KEEP_STEP + 0.01, 0, 3).keep).toBeCloseTo(4 * KEEP_STEP);
    expect(needFrom(0.01, 0, 3).keep).toBe(0);
    expect(needFrom(1, 0.6, 3).size).toBeCloseTo(0.2 + HOLE_MARGIN);
    expect(needFrom(1, 100, 3).size).toBe(SIZE_MAX);
  });
  it('turns on with the fit when it was off', () => {
    expect(fitXray(xrayOff(), { size: 0.15, keep: 2 * KEEP_STEP })).toEqual({ on: true, size: 0.15, keep: 2 * KEEP_STEP });
  });
  it('while on, Hole only grows and Keep only drops', () => {
    const cur = { on: true, size: 0.5, keep: 5 * KEEP_STEP };
    expect(fitXray(cur, { size: 0.1, keep: 8 * KEEP_STEP })).toEqual(cur);
    expect(fitXray(cur, { size: 0.6, keep: 2 * KEEP_STEP })).toEqual({ on: true, size: 0.6, keep: 2 * KEEP_STEP });
  });
  it('a focus in the clear turns it off and resets the values', () => {
    expect(fitXray({ on: true, size: 0.7, keep: KEEP_STEP }, null)).toEqual({ on: false, ...XRAY_DEFAULTS });
    const again = fitXray(fitXray({ on: true, size: 0.7, keep: KEEP_STEP }, null), { size: 0.1, keep: 3 * KEEP_STEP });
    expect(again).toEqual({ on: true, size: 0.1, keep: 3 * KEEP_STEP });
  });
});
