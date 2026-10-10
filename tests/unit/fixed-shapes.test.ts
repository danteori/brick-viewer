// Fixed-mesh bricks (C-01): the B_* decor / gadget / joint / gate bricks and the stretched designs
// (PB_Frog, BP_ZoneProjector, the sliders) load, draw one mesh each and save back without a size.
import { describe, expect, it } from 'vitest';
import { BrickShapes } from '../../src/render/meshes/shapes.js';
import { faceRects } from '../../src/render/meshes/registry.ts';
import { viewerBrick } from '../../src/scene/load.ts';
import { plainBrick } from '../../src/scene/save.ts';
import { fixedSize, isFixedAsset, sizeRule } from '../../src/scene/brick.ts';
import { kindOfName, supportedAsset } from '../../src/scene/view.ts';
import { displayName } from '../../src/ui/names.ts';
import type { PlainBrick } from '../../src/format/world.ts';
import { BRZ_UNIT } from '../../src/core/units.ts';

const FIXED = Object.keys(BrickShapes.FIXED_SHAPES);
const STRETCHED = Object.keys(BrickShapes.STRETCHED);
const KIND_SPECIAL = 5;

describe('fixed meshes', () => {
  it('covers the 132 B_* types and the 6 stretched designs', () => {
    expect(FIXED.length).toBe(132);
    expect(STRETCHED.sort()).toEqual(['BP_ZoneProjector', 'PB_Frog', 'PB_MotorSliderJoint', 'PB_RigidSliderJoint', 'PB_ServoSliderJoint', 'PB_SliderJoint']);
  });

  it.each(FIXED)('%s builds a mesh inside its unit box', (asset) => {
    const m = faceRects(BrickShapes.fixedMesh(asset, [0, 0, 0], 16));
    if (asset === 'B_Joint_Coupler') { expect(m.count).toBe(0); return; }   // no geometry in the game either
    expect(m.count).toBeGreaterThan(0);
    expect(m.count % 3).toBe(0);
    for (const v of m.positions) { expect(Number.isFinite(v)).toBe(true); expect(Math.abs(v)).toBeLessThan(0.62); }
    for (const v of m.normals) expect(Number.isFinite(v)).toBe(true);
  });

  it.each(STRETCHED)('%s stretches to the saved size', (asset) => {
    for (const h of [[5, 5, 1], [20, 5, 1], [15, 15, 2]] as [number, number, number][]) {
      const m = BrickShapes.fixedMesh(asset, h, 16);
      expect(m.count).toBeGreaterThan(0);
      expect(m.worldHalf).toEqual(h);
    }
  });

  it('loads a B_* brick with its generator box, at any orientation, and saves it with no size', () => {
    for (const asset of ['B_Fern', 'B_1x1_Gate_Expr_LogicalAND', 'B_Pine_Tree', 'B_Joint_Bearing_Micro']) {
      expect(supportedAsset(asset, false)).toBe(true);
      for (const orient of [16, 17, 20, 0, 9]) {
        expect(kindOfName(asset, orient)).toBe(KIND_SPECIAL);
        const pb: PlainBrick = { asset, size: null, pos: [100, 200, 300], orient, color: [10, 20, 30, 5], material: 'BMC_Plastic' };
        const b = viewerBrick(pb, false);
        if ('skip' in b) throw new Error('skipped ' + asset);
        expect(b.shape).toBe('special');
        expect(fixedSize(b)).toBe(true);
        expect(sizeRule(b).fix).toEqual([true, true, true]);
        const M = BrickShapes.brickOrient(orient), h = BrickShapes.fixedHalf(asset)!;
        const world = [0, 1, 2].map((r) => Math.abs(M[r]![0]) * h[0] + Math.abs(M[r]![1]) * h[1] + Math.abs(M[r]![2]) * h[2]);
        expect(b.hi.map((v, i) => Math.round((v - b.lo[i]!) / 2 / BRZ_UNIT))).toEqual(world.map(Math.round));
        const back = plainBrick(b, [0, 0, 0], false);
        expect(back.asset).toBe(asset);
        expect(back.size).toBeNull();
        expect(back.orient).toBe(orient);
        expect(back.pos).toEqual([100, 200, 300]);
      }
    }
  });

  it('stretched designs keep their saved size', () => {
    const pb: PlainBrick = { asset: 'PB_SliderJoint', size: [20, 5, 1], pos: [0, 0, 1], orient: 16, color: [1, 2, 3, 5], material: 'BMC_Plastic' };
    const b = viewerBrick(pb, false);
    if ('skip' in b) throw new Error('skipped');
    expect(fixedSize(b)).toBe(false);
    expect(plainBrick(b, [0, 0, 0], false).size).toEqual([20, 5, 1]);
  });

  it('gates the generator does not list draw as the 1x1f gate plate', () => {
    for (const asset of ['B_1x1_Gate_AND', 'B_1x1_Gate_Timer_Tick', 'B_1x1_EntityGate_ReadBrickGrid', 'B_1x1_NOT_Gate']) {
      expect(isFixedAsset(asset)).toBe(true);
      expect(BrickShapes.fixedHalf(asset)).toEqual([5, 5, 2]);
    }
    expect(isFixedAsset('B_Not_A_Brick')).toBe(false);
    expect(supportedAsset('B_Not_A_Brick', false)).toBe(false);
  });

  it('names a fixed brick by its asset', () => {
    const b = viewerBrick({ asset: 'B_1x1_Gate_Expr_LogicalAND', size: null, pos: [0, 0, 2], orient: 16, color: [0, 0, 0, 5], material: 'BMC_Plastic' }, false);
    if ('skip' in b) throw new Error('skipped');
    expect(displayName(b, 1, 1, 1)).toBe('Gate Expr Logical AND');
  });
});
