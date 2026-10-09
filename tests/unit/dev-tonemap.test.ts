import { describe, expect, it } from 'vitest';
import { ueFilmic } from '../../src/dev/tonemap.ts';
import { srgbToLinear } from '../../src/format/environment.ts';

// The calibration's self-test: a grey goes through the whole path as 0.18 -> 0.1800 and 1.0 -> 0.7234.
describe('dev tonemap', () => {
  it.each([[0.18, 0.18], [1, 0.7234]])('grey %s -> %s (display linear)', (x, y) => {
    for (const c of ueFilmic([x, x, x])) expect(srgbToLinear(c)).toBeCloseTo(y, 3);
  });
});
