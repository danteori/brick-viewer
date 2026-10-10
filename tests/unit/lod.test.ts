// Far LOD cells (render/lod.ts): small bricks bin into coarse boxes, big ones are kept.
import { describe, expect, it } from 'vitest';
import { SceneStore } from '../../src/scene/store.ts';
import { putPlain } from '../../src/scene/view.ts';
import { buildLod, CELL, lodLevel } from '../../src/render/lod.ts';

const add = (s: SceneStore, pos: [number, number, number], size: [number, number, number], color: [number, number, number, number] = [10, 20, 30, 5]): number => {
  const id = s.alloc();
  putPlain(s, id, { asset: 'PB_DefaultBrick', size, pos, orient: 16, color, material: 'BMC_Plastic' }, false);
  return id;
};

describe('far LOD cells', () => {
  it('merges the small bricks of one cell into a box around them and keeps big ones', () => {
    const s = new SceneStore();
    const ids = [add(s, [5, 5, 6], [5, 5, 6]), add(s, [15, 5, 6], [5, 5, 6], [200, 0, 0, 5]), add(s, [15, 5, 18], [5, 5, 6], [200, 0, 0, 5]), add(s, [500, 500, 2], [400, 400, 2])];
    const L = buildLod(s, ids, [0, 0, 0]);
    expect(L.keep).toEqual([3]);
    expect(L.count).toBe(1);
    const i16 = new Int16Array(L.cells), u16 = new Uint16Array(L.cells), u32 = new Uint32Array(L.cells);
    expect([i16[0], i16[1], i16[2]]).toEqual([10, 5, 12]);       // x 0..20, y 0..10, z 0..24
    expect([u16[4], u16[5], u16[6]]).toEqual([10, 5, 12]);
    expect(u32[4]! & 0xffffff).toBe(200);                        // the red parts are the bigger share
  });

  it('splits a brick across the cells it crosses', () => {
    const s = new SceneStore();
    const id = add(s, [CELL, 5, 6], [10, 5, 6]);                 // x CELL-10 .. CELL+10
    const L = buildLod(s, [id], [0, 0, 0]);
    expect(L.count).toBe(2);
  });

  it('picks coarser levels as studs shrink', () => {
    expect(lodLevel(2)).toBe(0);
    expect(lodLevel(0.75)).toBe(0);
    expect(lodLevel(0.7)).toBe(1);
    expect(lodLevel(0.25)).toBe(2);
    expect(lodLevel(0.06)).toBe(3);
    expect(lodLevel(0.001)).toBe(4);
  });
});
