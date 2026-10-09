import { describe, expect, it } from 'vitest';
import { readBrz, readBrzArchive } from '../../src/format/brz.ts';
import { fileMapSource, openBrzLazy } from '../../src/format/brzlazy.ts';
import { densityMap, estimateChunkBytes, readOverview, suggestLoadMode, suggestLoadOrder, type SaveOverview } from '../../src/format/overview.ts';
import { extractBricks } from '../../src/format/world.ts';
import { hasRefs, readRef, referenceSaves } from './refs.ts';
import { synthSave, type SynthBrick } from './synthsave.ts';

const plate = (x: number, y: number, z: number): SynthBrick => ({ asset: 'PB_DefaultBrick', size: [10, 10, 2], pos: [x, y, z], color: [200, 50, 50] });

// timing and container (compressed) sizes differ between a .brz and a decoded file map
const strip = (ov: SaveOverview): unknown => JSON.parse(JSON.stringify({ ...ov, ms: 0 }, (k, v) => (k === 'storedBytes' ? 0 : v)));

describe('lazy .brz reader', () => {
  const bytes = synthSave([plate(5, 5, 2), plate(3000, 5, 2), plate(5, -100, 2)]);

  it('gives the same files as the eager reader, without decompressing up front', () => {
    const lazy = openBrzLazy(bytes), eager = readBrzArchive(bytes);
    expect([...lazy.paths()]).toEqual([...eager.files.keys()]);
    for (const [p, b] of eager.files) {
      expect(lazy.get(p)).toEqual(b);
      expect(lazy.sizeOf(p)).toBe(b.length);
    }
    expect(lazy.get('nope')).toBeUndefined();
  });
});

describe('overview (synthetic save)', () => {
  const bricks = [plate(5, 5, 2), plate(15, 5, 2), plate(3000, 5, 2), plate(5, -100, 2), plate(5, 5, 4100)];
  const bytes = synthSave(bricks, { components: { '0_0_0': 3 }, wires: { '0_0_0': 2 } });
  const ov = readOverview(openBrzLazy(bytes));

  it('lists grids, chunks and counts from the index alone', () => {
    expect(ov.grids.map((g) => g.id)).toEqual(['1']);
    const byKey = Object.fromEntries(ov.chunks.map((c) => [c.key, c]));
    expect(Object.keys(byKey).sort()).toEqual(['0_-1_0', '0_0_0', '0_0_2', '1_0_0']);
    expect(byKey['0_0_0']).toMatchObject({ bricks: 2, components: 3, wires: 2, present: true, size: 2048, cell: { min: [0, 0, 0], max: [2048, 2048, 2048] } });
    expect(byKey['0_-1_0']!.cell.min).toEqual([0, -2048, 0]);
    expect(ov.totals).toMatchObject({ grids: 1, chunks: 4, bricks: 5, components: 3, wires: 2 });
    expect(ov.bounds).toEqual({ min: [0, -2048, 0], max: [4096, 2048, 6144] });
    expect(ov.names.proceduralBricks).toEqual(['PB_DefaultBrick']);
    expect(ov.names.materials).toEqual(['BMC_Plastic']);
  });

  it('estimates memory per chunk from the counts', () => {
    for (const c of ov.chunks) expect(c.estBytes).toBe(estimateChunkBytes(c.bricks, c.components, c.wires));
    expect(ov.totals.estBytes).toBe(ov.chunks.reduce((s, c) => s + c.estBytes, 0));
    expect(ov.chunks.every((c) => c.storedBytes > 0 && c.rawBytes > 0)).toBe(true);
  });

  it('suggests a load order around the camera, and honours a budget', () => {
    const lo = suggestLoadOrder(ov, [3000, 100, 10]);
    expect(lo.order[0]!.key).toBe('1_0_0');
    expect(lo.distance[0]).toBe(0);
    expect(lo.order[1]!.key).toBe('0_0_0');
    expect(lo.order.at(-1)!.key).toBe('0_0_2');
    for (let i = 1; i < lo.distance.length; i++) expect(lo.distance[i]!).toBeGreaterThanOrEqual(lo.distance[i - 1]!);
    const tight = suggestLoadOrder(ov, [3000, 100, 10], { budgetBytes: lo.order[0]!.estBytes + 1 });
    expect(tight.withinBudget).toBe(1);
    expect(suggestLoadMode(ov)).toBe('full');
    expect(suggestLoadMode(ov, { budgetBytes: 10 })).toBe('stream');
  });

  it('gives a density map per chunk column', () => {
    const d = densityMap(ov)!;
    expect([d.x0, d.y0, d.w, d.h]).toEqual([0, -1, 2, 2]);
    expect(d.bricks[(0 - d.y0) * d.w + 0]).toBe(3);   // (0,0): two at z 0 plus one at z 2
  });

  it('agrees between the lazy reader and a decoded file map', () => {
    expect(strip(readOverview(fileMapSource(readBrz(bytes))))).toEqual(strip(ov));
  });
});

describe.skipIf(!hasRefs)('overview on the reference saves', () => {
  const saves = referenceSaves();
  it.each(saves)('%s', (rel) => {
    const bytes = readRef(rel);
    const files = readBrz(bytes);
    if (!files.has('World/0/Bricks/ChunksShared.schema')) return;
    const ov = readOverview(openBrzLazy(bytes));
    expect(strip(readOverview(fileMapSource(files)))).toEqual(strip(ov));
    // brick counts from the index match a full decode of grid 1
    const g1 = ov.grids.find((g) => g.id === '1');
    if (g1) expect(g1.bricks).toBe(extractBricks(files).bricks.length);
    for (const c of ov.chunks) expect(c.present).toBe(true);
    // every grid other than 1 is dynamic; every chunk shows up in the load order once
    expect(ov.grids.filter((g) => g.dynamic).every((g) => g.id !== '1')).toBe(true);
    const lo = suggestLoadOrder(ov, [0, 0, 0], { skipEmpty: false });
    expect(new Set(lo.order).size).toBe(ov.chunks.length);
  });
});
