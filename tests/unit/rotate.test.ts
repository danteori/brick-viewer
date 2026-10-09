// E-05 wiring: turning a viewer brick to a new orientation byte keeps its centre, its volume and
// every non-orientation field, and four clockwise steps come back to the start.
import { describe, expect, it } from 'vitest';
import { orientBrick } from '../../src/editor/rotate.ts';
import { reorientTo, rotateCW } from '../../src/editor/reorient.ts';
import { orientOf } from '../../src/scene/save.ts';
import type { Brick } from '../../src/scene/brick.ts';

const plain = (): Brick => ({ lo: [0, 0, 0], hi: [0.4, 0.8, 0.24], micro: false, color: [0.2, 0.4, 0.6], up: 1, top: 'studs', tile: false, material: 'BMC_Plastic', intensity: 7, grid: '1' });
const ramp = (): Brick => ({ lo: [0, 0, 0], hi: [0.6, 0.4, 0.24], micro: false, color: [0.5, 0.5, 0.5], up: 1, top: 'studs', tile: false, shape: 'ramp', run: 0, lip: 1 });
const size = (b: Brick): number[] => b.hi.map((v, i) => +(v - b.lo[i]!).toFixed(3));
const mid = (b: Brick): number[] => b.hi.map((v, i) => +((v + b.lo[i]!) / 2).toFixed(3));
const vol = (b: Brick): number => +size(b).reduce((a, v) => a * v, 1).toFixed(6);

describe('orientBrick', () => {
  it('a clockwise step swaps the footprint about the centre and keeps the other fields', () => {
    const b = plain(), r = orientBrick(b, rotateCW(orientOf(b)))!;
    expect(size(r)).toEqual([0.8, 0.4, 0.24]);
    expect(mid(r)).toEqual(mid(b));
    expect(r.color).toEqual(b.color);
    expect(r.intensity).toBe(7); expect(r.grid).toBe('1'); expect(r.material).toBe('BMC_Plastic'); expect(r.up).toBe(1);
  });

  it('works in a shifted frame (origin)', () => {
    const b = plain(), o = [12.3, -4.5, 0.6], r = orientBrick(b, rotateCW(orientOf(b)), o)!;
    expect(mid(r)).toEqual(mid(b));
  });

  it('four clockwise steps of a ramp come back to the same ramp', () => {
    let b = ramp();
    const seen = new Set<string>();
    for (let n = 0; n < 4; n++) { b = orientBrick(b, rotateCW(orientOf(b)))!; seen.add(`${b.run},${b.lip}`); }
    expect(b).toEqual(ramp());
    expect(seen.size).toBe(4);                      // every step points the slope a new way
  });

  it('reorienting the top to +X lays the brick on its side', () => {
    const b = plain(), r = orientBrick(b, reorientTo(orientOf(b), [1, 0, 0]))!;
    expect(r.up).toBe(0); expect(r.side).toBe(2);
    expect(vol(r)).toBe(vol(b)); expect(mid(r)).toEqual(mid(b));
    expect(size(r)[0]).toBe(0.24);                  // its height now runs along X
    const back = orientBrick(r, reorientTo(orientOf(r), [0, 0, 1]))!;
    expect(back.up).toBe(1); expect(back.side).toBeUndefined();
    expect(vol(back)).toBe(vol(b));
  });

  it('a sideways ramp becomes the export-measured special shape and keeps its asset', () => {
    const r = orientBrick(ramp(), reorientTo(orientOf(ramp()), [0, -1, 0]))!;
    expect(r.shape).toBe('special'); expect(r.asset).toBe('PB_DefaultRamp'); expect(r.side).toBe(-3);
    expect(r.run).toBeUndefined(); expect(r.lip).toBeUndefined();
    const up = orientBrick(r, reorientTo(orientOf(r), [0, 0, 1]))!;
    expect(up.shape).toBe('ramp'); expect(up.asset).toBeUndefined();
  });
});
