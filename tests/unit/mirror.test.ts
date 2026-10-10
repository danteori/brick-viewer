// E-14 mirror: twins, exact orientations, the closest orientation for shapes with no mirror image,
// and the group reflection. U-22: the timestamped prefab name.
import { describe, expect, it } from 'vitest';
import { BrickShapes } from '../../src/render/meshes/shapes.js';
import { MIRROR_TWINS, mirrorBrick, mirrorGroup, mirrorOrient } from '../../src/scene/mirror.ts';
import { stampedName } from '../../src/ui/panels/savegame.ts';
import type { Brick } from '../../src/scene/brick.ts';

const ramp = (): Brick => ({ lo: [0, 0, 0], hi: [0.8, 0.4, 0.24], micro: false, color: [0.5, 0.5, 0.5], up: 1, top: 'studs', tile: false, shape: 'ramp', run: 0, lip: 1, material: 'BMC_Glow', intensity: 9 });
const plain = (x: number): Brick => ({ lo: [x, 0, 0], hi: [x + 0.4, 0.4, 0.24], micro: false, color: [0.1, 0.2, 0.3], up: 1, top: 'studs', tile: false });
const ASSETS = [...Object.keys(BrickShapes.SPECIAL_TYPES), ...Object.keys(BrickShapes.MICRO_TYPES)];
const halfOf = (a: string): number[] => (BrickShapes.isMicro(a) ? [2, 4, 6] : [20, 10, 6]);

describe('mirrorOrient', () => {
  it('a ramp mirrored along its run flips its lip; across its width it stays', () => {
    const x = mirrorBrick(ramp(), 0, 0.8).brick, y = mirrorBrick(ramp(), 1, 0.4).brick;
    expect(x.shape).toBe('ramp'); expect(x.run).toBe(0); expect(x.lip).toBe(-1);
    expect(y.lip).toBe(1);
    expect(x.material).toBe('BMC_Glow'); expect(x.intensity).toBe(9); expect(x.color).toEqual([0.5, 0.5, 0.5]);
    expect(x.lo).toEqual([0, 0, 0]); expect(x.hi).toEqual([0.8, 0.4, 0.24]);
  });

  it('the micro half inner corner swaps to its Inverted twin, exactly', () => {
    for (const [a, b] of Object.entries(MIRROR_TWINS)) {
      for (const o of [16, 17, 2, 9]) for (const ax of [0, 1] as const) {
        const m = mirrorOrient(a, [2, 2, 2], o, ax);
        expect(m.asset).toBe(b); expect(m.exact).toBe(true);
      }
    }
  });

  it('box-like bricks keep their byte when mirrored across a vertical plane', () => {
    for (const a of ['PB_DefaultBrick', 'PB_DefaultTile', 'PB_DefaultMicroBrick']) {
      expect(mirrorOrient(a, [10, 20, 6], 16, 0)).toEqual({ asset: a, o: 16, half: [10, 20, 6], exact: true });
    }
    // a sideways brick with its studs toward +X turns to face -X
    const m = mirrorOrient('PB_DefaultBrick', [10, 20, 6], 0, 0), M = BrickShapes.brickOrient(m.o);
    expect(BrickShapes.brickOrient(0)[0][2]).toBe(-M[0][2]);
  });

  it('every shaped asset mirrors exactly except the ramp inner corners (closest orientation)', () => {
    const inexact = new Set<string>();
    for (const a of ASSETS) for (const o of [16, 17, 0, 9]) for (const ax of [0, 1] as const) {
      if (!mirrorOrient(a, halfOf(a), o, ax).exact) inexact.add(a);
    }
    expect([...inexact].sort()).toEqual(['PB_DefaultRampInnerCorner', 'PB_DefaultRampInnerCornerInverted']);
  });

  it('mirroring twice gives the same asset back, and keeps the world size', () => {
    for (const a of ASSETS) for (const ax of [0, 1] as const) {
      const h = halfOf(a), m1 = mirrorOrient(a, h, 17, ax), m2 = mirrorOrient(m1.asset, m1.half, m1.o, ax);
      expect(m2.asset).toBe(a);
      expect([...m1.half].sort()).toEqual([...h].sort());
    }
  });
});

describe('mirrorGroup', () => {
  it('reflects the group inside its own span and collects inexact assets', () => {
    const inexact = new Set<string>();
    const { bricks } = mirrorGroup([ramp(), plain(0.8)], 0, inexact);
    expect(bricks.map((b) => [b.lo[0], b.hi[0]])).toEqual([[0.4, 1.2], [0, 0.4]]);
    expect(inexact.size).toBe(0);
  });
});

describe('stampedName', () => {
  it('adds a sortable local timestamp without colons', () => {
    expect(stampedName('castle.brz', new Date(2026, 9, 10, 4, 5, 6))).toBe('castle 2026-10-10 04-05-06.brz');
    expect(stampedName('', new Date(2026, 0, 2, 3, 4, 5))).toBe('build 2026-01-02 03-04-05.brz');
    expect(stampedName('a:b?', new Date(2026, 0, 2, 3, 4, 5))).toBe('a b 2026-01-02 03-04-05.brz');
  });
});
