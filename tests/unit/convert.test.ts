// E-06 applicator type changes: valid targets, kept sizes, fixed sizes.
import { describe, expect, it } from 'vitest';
import { convertPlain, fitsGrid, knownTarget, snapToGrid, typeGrid } from '../../src/scene/convert.ts';
import type { PlainBrick } from '../../src/format/world.ts';

const pb = (asset: string, size: [number, number, number] | null, pos: [number, number, number] = [0, 0, 6], orient = 16): PlainBrick =>
  ({ asset, size, pos, orient, color: [10, 20, 30, 5], material: 'BMC_Glow', owner: 3, originalOwner: 3, flags: { CollisionFlags_Player: 0 } });

describe('typeGrid / fitsGrid', () => {
  it('knows the plain, micro and special grids; fixed types have none', () => {
    expect(typeGrid('PB_DefaultBrick')).toMatchObject({ step: [10, 10, 4], min: [10, 10, 4] });
    expect(typeGrid('PB_DefaultMicroBrick')).toMatchObject({ step: [2, 2, 2] });
    expect(typeGrid('PB_DefaultRamp')).toMatchObject({ min: [20, 10, 4] });
    expect(typeGrid('BP_RoundPlate')!.fix).toEqual([false, false, true]);
    expect(typeGrid('B_1x1_Round')).toBeNull();
    expect(typeGrid('PB_NoSuchThing')).toBeNull();
  });
  it('checks steps, minimums and fixed axes on full sizes', () => {
    const plain = typeGrid('PB_DefaultBrick')!;
    expect(fitsGrid([5, 5, 6], plain)).toBe(true);           // 1x1 brick
    expect(fitsGrid([5, 5, 2], plain)).toBe(true);           // 1x1 plate
    expect(fitsGrid([1, 1, 1], plain)).toBe(false);          // a 1x1x1 micro
    expect(fitsGrid([5, 5, 6], typeGrid('PB_DefaultRamp')!)).toBe(false);   // a ramp's run is 2 studs at least
    expect(fitsGrid([10, 10, 2], typeGrid('BP_RoundPlate')!)).toBe(true);
    expect(fitsGrid([10, 10, 6], typeGrid('BP_RoundPlate')!)).toBe(false);   // fixed height
    expect(snapToGrid([5, 5, 6], typeGrid('BP_RoundPlate')!)).toEqual([10, 10, 2]);
    expect(snapToGrid([3, 3, 3], plain)).toEqual([5, 5, 4]);
  });
  it('only offers types the viewer draws', () => {
    expect(knownTarget('PB_DefaultTile')).toBe(true);
    expect(knownTarget('B_2x2_Cone')).toBe(true);
    expect(knownTarget('B_Fern')).toBe(knownTarget('B_Fern'));
    expect(knownTarget('PB_Unknown')).toBe(false);
  });
});

describe('convertPlain', () => {
  it('resizable to resizable keeps size, position, orientation, paint, owners and flags', () => {
    const b = pb('PB_DefaultBrick', [10, 5, 6], [7, 8, 9], 5), out = convertPlain(b, 'PB_DefaultSmoothTile');
    expect(out).toEqual({ brick: { ...b, asset: 'PB_DefaultSmoothTile' } });
    expect(convertPlain(pb('PB_DefaultBrick', [10, 5, 6]), 'PB_DefaultMicroBrick')).toHaveProperty('brick.size', [10, 5, 6]);
  });
  it('refuses sizes off the target grid, the same type and unknown types', () => {
    expect(convertPlain(pb('PB_DefaultMicroBrick', [1, 1, 1]), 'PB_DefaultBrick')).toEqual({ skip: 'size' });
    expect(convertPlain(pb('PB_DefaultBrick', [5, 5, 6]), 'PB_DefaultBrick')).toEqual({ skip: 'same' });
    expect(convertPlain(pb('PB_DefaultBrick', [5, 5, 6]), 'PB_Nope')).toEqual({ skip: 'unknown' });
  });
  it('to a fixed type: its own size, centred, standing on the old bottom', () => {
    const out = convertPlain(pb('PB_DefaultBrick', [10, 10, 6], [0, 0, 6]), 'B_2x2F_Round');
    expect(out).toHaveProperty('brick');
    const n = (out as { brick: PlainBrick }).brick;
    expect(n.size).toBeNull();
    expect(n.pos).toEqual([0, 0, 2]);                 // bottom at 0, a 2x2f round is 4 units tall
    expect(n.color).toEqual([10, 20, 30, 5]);
  });
  it('from a fixed type: its box on the target grid, standing on the same bottom', () => {
    const out = convertPlain(pb('B_1x1_Round', null, [0, 0, 6]), 'PB_DefaultBrick') as { brick: PlainBrick };
    expect(out.brick.size).toEqual([5, 5, 6]);
    expect(out.brick.pos).toEqual([0, 0, 6]);
    const plate = convertPlain(pb('B_1x1_Round', null, [0, 0, 6]), 'BP_RoundPlate') as { brick: PlainBrick };
    expect(plate.brick.size).toEqual([10, 10, 2]);    // the round plate's minimum, fixed height
    expect(plate.brick.pos).toEqual([0, 0, 2]);
  });
});
