import { describe, expect, it } from 'vitest';
import { rotatorDirection, zoneBox } from '../../src/ui/overlay/volumes.ts';

describe('volume previews', () => {
  it('turns an Unreal rotator into a direction', () => {
    const [x, y, z] = rotatorDirection(0, 0);
    expect([x, y, z]).toEqual([1, 0, 0]);
    expect(rotatorDirection(270, 0)[2]).toBeCloseTo(-1);
    expect(rotatorDirection(0, 90)[1]).toBeCloseTo(1);
  });
  it('puts a zone box over the footprint, from start to end above the top face', () => {
    expect(zoneBox([0, 0, 0, 10, 20, 12], 0, 60)).toEqual([[0, 0, 12], [10, 20, 72]]);
  });
});
