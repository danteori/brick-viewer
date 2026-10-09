// Saving the scene: viewer bricks -> save bricks -> viewer bricks must give the same bricks (box,
// type, shape fields, colour, material, intensity), and a rebuilt save must reload to the same scene.
import { describe, expect, it } from 'vitest';
import { readBrz, writeBrz } from '../../src/format/brz.ts';
import { extractBricks, rebuildFromLoaded } from '../../src/format/world.ts';
import { bricksFromFiles, viewerBrick } from '../../src/scene/load.ts';
import { orientOf, plainBrick } from '../../src/scene/save.ts';
import { orientOfMatrix, quatColumns, snapRotation } from '../../src/scene/worldgrids.ts';
import { BrickShapes } from '../../src/render/meshes/shapes.js';
import type { Brick } from '../../src/scene/brick.ts';
import { synthSave } from './synthsave.ts';
import { readRef, referenceSaves } from './refs.ts';

const ORIGIN = [0, 0, 0];
const near = (a: Brick, b: Brick, tol: number): void => {
  const { color: ca, ...ra } = a, { color: cb, ...rb } = b;
  expect(rb).toEqual(ra);
  ca.forEach((v, i) => expect(Math.abs(v - cb[i]!)).toBeLessThanOrEqual(tol));
};

function roundTrip(files: Map<string, Uint8Array>): number {
  const { bricks, linear } = extractBricks(files);
  let n = 0;
  bricks.forEach((pb, i) => {
    const vb = viewerBrick(pb, linear[i]!);
    if ('skip' in vb) return;
    const back = viewerBrick(plainBrick(vb, ORIGIN, linear[i]!), linear[i]!);
    if ('skip' in back) throw new Error('round trip lost the type of ' + pb.asset);
    near(back, vb, linear[i] ? 2.5 / 255 : 0);
    n++;
  });
  return n;
}

const SYNTH = [
  { asset: 'PB_DefaultBrick', size: [10, 20, 6], pos: [5, 10, 6], color: [250, 64, 64] },
  { asset: 'PB_DefaultMicroBrick', size: [1, 1, 1], pos: [101, 101, 1], orient: 20, color: [1, 2, 3] },
  { asset: 'PB_DefaultRamp', size: [20, 10, 6], pos: [200, 0, 6], orient: 18, color: [9, 99, 199] },
  { asset: 'PB_DefaultSmoothTile', size: [5, 5, 2], pos: [5, 205, 2], orient: 2, color: [77, 77, 77] },
  { asset: 'PB_DefaultTile', size: [5, 5, 2], pos: [5, 405, 2], orient: 9, color: [77, 7, 77] },
  { asset: 'B_1x1_Round', size: null, pos: [3005, 5, 6], color: [0, 255, 0] },
] as const;

describe('scene -> save', () => {
  it('round-trips every supported brick of a synthetic save', () => {
    const files = readBrz(synthSave(SYNTH.map((b) => ({ ...b, size: b.size && [...b.size], pos: [...b.pos], color: [...b.color] })) as never));
    expect(roundTrip(files)).toBeGreaterThan(3);
  });

  it('picks orientations that draw the same', () => {
    expect(orientOf({ lo: [0, 0, 0], hi: [1, 1, 1], micro: false, color: [0, 0, 0], up: 1 })).toBe(16);
    expect(orientOf({ lo: [0, 0, 0], hi: [1, 1, 1], micro: false, color: [0, 0, 0], up: -1 })).toBe(20);
  });

  it('rebuilds a save that reloads to the same scene, intensity included', () => {
    const files = readBrz(synthSave(SYNTH.map((b) => ({ ...b, size: b.size && [...b.size], pos: [...b.pos], color: [...b.color] })) as never));
    const { bricks } = bricksFromFiles(files);
    bricks[0]!.intensity = 9;
    bricks[1]!.color = [0.5, 0.25, 1];
    const out = rebuildFromLoaded(files, bricks.map((b) => plainBrick(b, ORIGIN, false)));
    const again = bricksFromFiles(readBrz(writeBrz(out.files))).bricks;
    expect(again.length).toBe(bricks.length);
    const key = (b: Brick): string => b.lo.join() + b.hi.join();
    const byKey = new Map(again.map((b) => [key(b), b]));
    for (const b of bricks) {
      const c = byKey.get(key(b))!;
      near(c, { ...b, intensity: b.intensity ?? 5 }, 0.5 / 255);
    }
    expect(byKey.get(key(bricks[0]!))!.intensity).toBe(9);
  });

  for (const rel of referenceSaves()) {
    it(`round-trips ${rel.replace(/^.*\//, '')}`, () => { roundTrip(readBrz(readRef(rel))); });
  }
});

describe('dynamic grid rotation', () => {
  it('composes quarter turns with orientation bytes', () => {
    const q = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number];   // 90 degrees about Z
    const { m, error } = snapRotation(quatColumns(q));
    expect(error).toBeLessThan(1e-9);
    const o = orientOfMatrix(m.map((r) => r.slice()));
    expect(o).toBeGreaterThanOrEqual(0);
    expect(BrickShapes.brickOrient(o).every((r: number[], i: number) => r.every((v, j) => Math.round(v) === m[i]![j]))).toBe(true);
    expect(snapRotation(quatColumns([0, 0, 0.2, Math.sqrt(1 - 0.04)])).error).toBeGreaterThan(1e-3);
  });
});
