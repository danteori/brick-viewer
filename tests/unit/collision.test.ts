import { beforeEach, describe, expect, it } from 'vitest';
import { S } from '../../src/app/state.ts';
import { worldHalf } from '../../src/core/orient.ts';
import { BRZ_UNIT } from '../../src/core/units.ts';
import type { Brick, V3 } from '../../src/scene/brick.ts';
import { pickGrid } from '../../src/scene/spatial.ts';
import { inst } from '../../src/render/instances.ts';
import {
  boxesOverlap, bricksCollide, focusChangeHits, freeGrowth, gridOf, orientedBox, sceneHit, toUnits, unitBox, type IBox,
} from '../../src/scene/collision.ts';

const shift = (b: IBox, d: readonly number[]): IBox => [b[0] + d[0], b[1] + d[1], b[2] + d[2], b[3] + d[0], b[4] + d[1], b[5] + d[2]];

describe('box overlap (integer Brickadia units)', () => {
  it('needs positive volume: faces, edges and corners touching are fine', () => {
    const a: IBox = [0, 0, 0, 10, 10, 12];
    expect(boxesOverlap(a, a)).toBe(true);
    expect(boxesOverlap(a, shift(a, [10, 0, 0]))).toBe(false);    // face
    expect(boxesOverlap(a, shift(a, [10, 10, 0]))).toBe(false);   // edge
    expect(boxesOverlap(a, shift(a, [10, 10, 12]))).toBe(false);  // corner
    expect(boxesOverlap(a, shift(a, [9, 0, 0]))).toBe(true);      // one unit in
    expect(boxesOverlap(a, shift(a, [0, 0, -11]))).toBe(true);
    expect(boxesOverlap(a, [2, 2, 2, 4, 4, 4])).toBe(true);       // contained
    expect(boxesOverlap(a, [2, 2, 2, 2, 4, 4])).toBe(false);      // zero-width box has no volume
  });

  it('touching vs overlapping for every one of the 24 orientations, on every face', () => {
    const half: [number, number, number] = [15, 5, 2];       // 3x1 plate: all three extents differ
    for (let o = 0; o < 24; o++) {
      const h = worldHalf(o, half), a = orientedBox([100, -40, 6], half, o);
      expect([a[3] - a[0], a[4] - a[1], a[5] - a[2]]).toEqual(h.map((v) => 2 * v));
      expect([...h].sort((x, y) => x - y)).toEqual([2, 5, 15]);   // a rotation only permutes the extents
      for (let q = 0; q < 24; q++) {
        const hb = worldHalf(q, half);
        for (let ax = 0; ax < 3; ax++) for (const s of [-1, 1]) {
          // neighbour b (orientation q) placed flush against a's face on axis ax, side s
          const d = [0, 0, 0]; d[ax] = s * (h[ax] + hb[ax]);
          const b = orientedBox([100 + d[0], -40 + d[1], 6 + d[2]], half, q);
          expect(boxesOverlap(a, b), `o${o} q${q} ax${ax}${s}`).toBe(false);
          expect(boxesOverlap(a, shift(b, [0, 1, 2].map((i) => (i === ax ? -s : 0)))), `o${o} q${q} ax${ax}${s} in`).toBe(true);
        }
      }
    }
  });

  it('exempts bricks in different grids', () => {
    const box: IBox = [0, 0, 0, 10, 10, 12];
    expect(bricksCollide({ box }, { box })).toBe(true);
    expect(bricksCollide({ box, grid: '1' }, { box })).toBe(true);
    expect(bricksCollide({ box, grid: '1' }, { box, grid: '7' })).toBe(false);
    expect(bricksCollide({ box, grid: '7' }, { box, grid: '7' })).toBe(true);
    expect(gridOf({})).toBe('1');
  });

  it('converts viewer units to whole Brickadia units', () => {
    expect(toUnits(0.2)).toBe(10);
    expect(toUnits(0.08)).toBe(4);
    expect(toUnits(-0.04)).toBe(-2);
    expect(toUnits(0.1 + 0.2)).toBe(15);                       // float noise rounds away
    expect(BRZ_UNIT).toBeCloseTo(0.02);
  });
});

// --- scene queries through the pick grid
const U = BRZ_UNIT;
/** a brick from an integer-unit box */
const brick = (b: IBox, grid?: string): Brick => ({
  lo: [b[0] * U, b[1] * U, b[2] * U].map((v) => +v.toFixed(3)) as V3, hi: [b[3] * U, b[4] * U, b[5] * U].map((v) => +v.toFixed(3)) as V3,
  micro: false, color: [1, 0, 0], up: 1, ...(grid ? { grid } : {}),
});
function setScene(list: Brick[], sel = 0, origin: V3 = [0, 0, 0]): void {
  S.bricks.length = 0; for (const b of list) S.bricks.push(b); S.sel = sel; S.histOrigin = origin;
  S.lo = S.bricks[sel].lo; S.hi = S.bricks[sel].hi;
  pickGrid.dirty = true; inst.all = false; inst.dirty.clear(); inst.sel = sel;
}
const hitBox = (b: IBox, grid?: string, ignore?: number[]): number => sceneHit(brick(b).lo, brick(b).hi, { grid, ignore });

describe('scene collision', () => {
  beforeEach(() => setScene([
    brick([0, 0, 0, 20, 20, 12]),          // 0: focus, 2x2 brick
    brick([40, 0, 0, 60, 20, 12]),         // 1: 2x2 two studs away along +X
    brick([0, 40, 0, 20, 60, 12], '5'),    // 2: same spot along +Y, but in another grid
  ]));

  it('finds same-grid overlaps and ignores touching faces', () => {
    expect(hitBox([20, 0, 0, 40, 20, 12])).toBe(-1);   // fills the gap exactly: touches both
    expect(hitBox([20, 0, 0, 41, 20, 12])).toBe(1);
    expect(hitBox([19, 0, 0, 40, 20, 12])).toBe(0);    // the focused brick, tested live
    expect(hitBox([0, 0, 12, 20, 20, 24])).toBe(-1);   // stacked on top
  });

  it('lets a different grid overlap', () => {
    expect(hitBox([0, 40, 0, 20, 60, 12])).toBe(-1);   // main grid vs grid 5
    expect(hitBox([0, 40, 0, 20, 60, 12], '5')).toBe(2);
    expect(hitBox([0, 0, 0, 20, 20, 12], '5')).toBe(-1);
  });

  it('honours ignore and the frame origin', () => {
    expect(hitBox([45, 5, 0, 55, 15, 12], undefined, [1])).toBe(-1);
    setScene(S.bricks.slice(), 0, [0.4, 0, 0]);                  // recentred by 2 studs: boxes are local, abs = local + origin
    expect(sceneHit([0.8, 0, 0], [1.2, 0.4, 0.24])).toBe(1);     // brick 1's own local box
    expect(sceneHit([1.2, 0, 0], [1.6, 0.4, 0.24])).toBe(-1);    // just past it
  });

  it('stops a growing face at the last free step and skips overlaps the brick already had', () => {
    const b = S.bricks[0];
    // grow +X in studs (0.2): the 2-stud gap to brick 1 fills, the third stud is refused
    expect(freeGrowth(b.lo, b.hi, 0, 1, 0.2, 0, 5)).toBe(2);
    expect(freeGrowth(b.lo, b.hi, 0, 1, 0.2, 1, 5)).toBe(2);   // already 1 stud out
    expect(freeGrowth(b.lo, b.hi, 0, -1, 0.2, 0, 5)).toBe(5);  // the -X face: open
    // grow +Y: grid 5's brick doesn't block
    expect(freeGrowth(b.lo, b.hi, 1, 1, 0.2, 0, 5)).toBe(5);
    // a loaded overlap: brick 3 sits inside the focus; growing up past it is still allowed
    setScene([...S.bricks, brick([5, 5, 5, 15, 15, 20])]);
    const f = S.bricks[0];
    expect(freeGrowth(f.lo, f.hi, 2, 1, 0.08, 0, 3)).toBe(0);   // the slab above holds brick 3's top: blocked
    expect(focusChangeHits(f.lo, f.hi, f.lo, [f.hi[0], f.hi[1], f.hi[2]])).toBe(false);   // unchanged box: its old overlap doesn't count
    expect(focusChangeHits(f.lo, f.hi, f.lo, [0.81, f.hi[1], f.hi[2]])).toBe(true);       // grows into brick 1
  });

  it('checks fast on a big save (under 1 ms a query)', () => {
    const list: Brick[] = [];
    for (let x = 0; x < 120; x++) for (let y = 0; y < 120; y++) for (let z = 0; z < 16; z++) list.push(brick([x * 10, y * 10, z * 4, x * 10 + 10, y * 10 + 10, z * 4 + 4]));
    setScene(list);
    sceneHit([0, 0, 0], [0.2, 0.2, 0.08]);              // builds the grid
    // best of 5 batches, so a busy machine doesn't fail it; free spots (a full scan of their cells) too
    let best = Infinity;
    for (let r = 0; r < 5; r++) {
      let hits = 0;
      const t0 = performance.now(), n = 1000;
      for (let i = 0; i < n; i++) {
        const x = (i * 37) % 1100, y = (i * 53) % 1100, z = (i * 7) % 60 + (i & 1 ? 100 : 0);   // odd i: above the build
        const lo = [x, y, z].map((v) => v * U), hi = [x + 20, y + 20, z + 12].map((v) => v * U);
        if (sceneHit(lo, hi, { ignore: [0] }) >= 0) hits++;
      }
      best = Math.min(best, (performance.now() - t0) / n);
      expect(hits).toBe(n / 2);
    }
    console.log(`sceneHit on ${list.length} bricks: ${(best * 1000).toFixed(1)} us a query`);
    expect(best).toBeLessThan(1);
    expect(unitBox([0, 0, 0], [0.2, 0.2, 0.08])).toEqual([0, 0, 0, 10, 10, 4]);
  });
});
