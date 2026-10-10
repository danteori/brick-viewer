import { beforeEach, describe, expect, it } from 'vitest';
import { S } from '../../src/app/state.ts';
import { worldHalf } from '../../src/core/orient.ts';
import { BRZ_UNIT } from '../../src/core/units.ts';
import type { Brick, V3 } from '../../src/scene/brick.ts';
import { pickGrid } from '../../src/scene/spatial.ts';
import { SceneStore } from '../../src/scene/store.ts';
import { addBrick, brickView, putPlain } from '../../src/scene/view.ts';
import type { PlainBrick } from '../../src/format/world.ts';
import {
  boxesOverlap, bricksCollide, focusChangeHits, freeGrowth, gridOf, itemHits, orientedBox, sceneHit, toUnits, touching, unitBox, type IBox,
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

describe('connected (select connected)', () => {
  it('counts face contact and overlap, not edges, corners or gaps', () => {
    const a: IBox = [0, 0, 0, 20, 20, 12];
    expect(touching(a, [20, 0, 0, 40, 20, 12])).toBe(true);      // side by side
    expect(touching(a, [10, 10, 12, 30, 30, 24])).toBe(true);    // stacked, half over
    expect(touching(a, [10, 10, 6, 30, 30, 18])).toBe(true);     // overlapping
    expect(touching(a, [20, 20, 0, 40, 40, 12])).toBe(false);    // only an edge
    expect(touching(a, [20, 20, 12, 40, 40, 24])).toBe(false);   // only a corner
    expect(touching(a, [22, 0, 0, 40, 20, 12])).toBe(false);     // a gap
  });
});

// --- scene queries through the pick grid
const U = BRZ_UNIT;
/** a brick from an integer-unit box */
const brick = (b: IBox, grid?: string): Brick => ({
  lo: [b[0] * U, b[1] * U, b[2] * U].map((v) => +v.toFixed(3)) as V3, hi: [b[3] * U, b[4] * U, b[5] * U].map((v) => +v.toFixed(3)) as V3,
  micro: false, color: [1, 0, 0], up: 1, ...(grid ? { grid } : {}),
});
let bricks: Brick[] = [];
function setScene(list: Brick[], sel = 0, origin: V3 = [0, 0, 0]): void {
  const s = new SceneStore();
  for (const b of list) addBrick(s, b);
  S.scene = s; S.sel = sel; S.origin = origin; S.hidden = new Set();
  S.focus = brickView(s, sel); S.lo = S.focus.lo; S.hi = S.focus.hi;
  bricks = list.map((_, k) => (k === sel ? S.focus! : brickView(s, k)));
  pickGrid.dirty = true;
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

  it('honours ignore, hidden rows, and not the render origin', () => {
    expect(hitBox([45, 5, 0, 55, 15, 12], undefined, [1])).toBe(-1);
    setScene(bricks.slice(), 0, [0.4, 0, 0]);                    // the render origin moved: queries are absolute
    expect(sceneHit([0.8, 0, 0], [1.2, 0.4, 0.24])).toBe(1);     // brick 1's box
    expect(sceneHit([1.2, 0, 0], [1.6, 0.4, 0.24])).toBe(-1);    // just past it
    S.hidden = new Set([1]);                                     // being moved: it doesn't block
    expect(sceneHit([0.8, 0, 0], [1.2, 0.4, 0.24])).toBe(-1);
    S.hidden = new Set();
  });

  it('stops a growing face at the last free step and skips overlaps the brick already had', () => {
    const b = bricks[0]!;
    // grow +X in studs (0.2): the 2-stud gap to brick 1 fills, the third stud is refused
    expect(freeGrowth(b.lo, b.hi, 0, 1, 0.2, 0, 5)).toBe(2);
    expect(freeGrowth(b.lo, b.hi, 0, 1, 0.2, 1, 5)).toBe(2);   // already 1 stud out
    expect(freeGrowth(b.lo, b.hi, 0, -1, 0.2, 0, 5)).toBe(5);  // the -X face: open
    // grow +Y: grid 5's brick doesn't block
    expect(freeGrowth(b.lo, b.hi, 1, 1, 0.2, 0, 5)).toBe(5);
    // a loaded overlap: brick 3 sits inside the focus; growing up past it is still allowed
    setScene([...bricks, brick([5, 5, 5, 15, 15, 20])]);
    const f = bricks[0]!;
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

// --- U-11: shaped bricks collide by their real shape
describe('scene collision with real shapes', () => {
  const plain = (asset: string, half: V3, pos: V3, orient: number): PlainBrick => ({ asset, size: half, pos, orient, color: [200, 30, 30, 5], material: 'BMC_Plastic' });
  /** rows from save bricks; the focus is row `sel` */
  function shapedScene(list: PlainBrick[], sel: number): void {
    const s = new SceneStore();
    for (const pb of list) putPlain(s, s.alloc(), pb, false);
    S.scene = s; S.sel = sel; S.origin = [0, 0, 0]; S.hidden = new Set();
    S.focus = brickView(s, sel); S.lo = S.focus.lo; S.hi = S.focus.hi;
    pickGrid.dirty = true;
  }
  // 4x2 ramp, 1 brick tall: crest x -20..-10 full height (z 0..12), slope from (-10, 12) down to (20, 2), lip 0..2
  const RAMP = plain('PB_DefaultRamp', [20, 10, 6], [0, 0, 6], 16);
  const FAR = plain('PB_DefaultBrick', [10, 10, 6], [500, 500, 6], 16);
  // an inverted ramp turned half-way, hanging on the ramp: slopes touching, boxes overlapping
  const HANG = plain('PB_DefaultRampInverted', [20, 10, 6], [10, 0, 8], 18);

  for (const [label, sel] of [['as a scene row', 1], ['as the focused brick', 0]] as const) {
    it(`a box may fill a ramp's empty corner, not its solid part (${label})`, () => {
      shapedScene([RAMP, FAR], sel);
      expect(hitBox([10, -5, 6, 20, 5, 10])).toBe(-1);         // 1x1 plate above the slope near the lip
      expect(hitBox([10, -5, 4, 20, 5, 8])).toBe(0);           // two units lower: into the slope
      expect(hitBox([-20, -5, 4, -10, 5, 8])).toBe(0);         // inside the crest
      expect(hitBox([-20, -5, 12, -10, 5, 16])).toBe(-1);      // resting on the crest
      expect(hitBox([20, -5, 0, 30, 5, 12])).toBe(-1);         // against the lip face
    });
  }

  it('two ramps interlock their empty corners (placing and moving a shaped brick)', () => {
    shapedScene([FAR, RAMP, HANG], 0);
    const hang = brickView(S.scene, 2);
    expect(itemHits([0, 0, 0], hang, [2])).toBe(false);          // where it is: slopes only touch
    expect(itemHits([0, 0, -U], hang, [2])).toBe(true);          // one unit lower
    expect(itemHits([-U, 0, 0], hang, [2])).toBe(true);          // one unit toward the crest
    expect(itemHits([U, 0, 0], hang, [2])).toBe(false);          // one unit away
  });

  it('resizing a box into a ramp\'s empty corner stops at the slope', () => {
    shapedScene([plain('PB_DefaultBrick', [5, 5, 2], [15, 0, 8], 16), RAMP], 0);   // a 1x1 plate z 6..10 over the lip end
    const f = S.focus!;
    expect(freeGrowth(f.lo, f.hi, 2, -1, 0.04, 0, 3)).toBe(0);   // down one micro (z 4): the slope is 5.33 at x 10
    expect(freeGrowth(f.lo, f.hi, 0, 1, 0.2, 0, 3)).toBe(3);     // +X: past the ramp's end, free
    expect(freeGrowth(f.lo, f.hi, 0, -1, 0.2, 0, 3)).toBe(0);    // -X: the slope rises
  });

  it('turning or resizing a ramp checks its new shape, ignoring overlaps it already had', () => {
    shapedScene([RAMP, plain('PB_DefaultBrick', [5, 5, 2], [15, 0, 8], 16)], 0);   // the plate in the ramp's empty corner
    const f = S.focus!;
    expect(focusChangeHits(f.lo, f.hi, f.lo, f.hi)).toBe(false);
    // the ramp grows one plate taller: its slope rises into the plate
    expect(focusChangeHits(f.lo, f.hi, f.lo, [f.hi[0], f.hi[1], f.hi[2] + 0.08])).toBe(true);
    expect(freeGrowth(f.lo, f.hi, 2, 1, 0.08, 0, 2)).toBe(0);
    // turned half-way about Z the crest lands on the plate
    const turned: Brick = { ...f, lip: -(f.lip ?? 1) };
    expect(focusChangeHits(f.lo, f.hi, f.lo, f.hi, f, turned)).toBe(true);
  });

  it('stays fast on a field of ramps (under 1 ms a query)', () => {
    const list: PlainBrick[] = [FAR];
    for (let x = 0; x < 60; x++) for (let y = 0; y < 60; y++) for (let z = 0; z < 4; z++) list.push(plain('PB_DefaultRamp', [10, 10, 6], [x * 20 + 10, y * 20 + 10, z * 12 + 6], 16 + ((x + y) & 3)));
    shapedScene(list, 0);
    sceneHit([0, 0, 0], [0.2, 0.2, 0.08]);
    let best = Infinity;
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now(), n = 1000;
      for (let i = 0; i < n; i++) {
        const x = (i * 37) % 1180, y = (i * 53) % 1180, z = (i * 7) % 44;
        sceneHit([x * U, y * U, z * U], [(x + 10) * U, (y + 10) * U, (z + 4) * U], { ignore: [0] });
      }
      best = Math.min(best, (performance.now() - t0) / n);
    }
    console.log(`sceneHit on ${list.length} ramps: ${(best * 1000).toFixed(1)} us a query`);
    expect(best).toBeLessThan(1);
  });
});
