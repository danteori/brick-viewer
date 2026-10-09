import { describe, expect, it } from 'vitest';
import { openBrzLazy, type LazyBrz } from '../../src/format/brzlazy.ts';
import { readOverview, transformBox, type SaveOverview } from '../../src/format/overview.ts';
import { parseSchema } from '../../src/format/schema.ts';
import { extractBricks } from '../../src/format/world.ts';
import { readBrz } from '../../src/format/brz.ts';
import { basicHalf, rasteriseChunk, type ChunkContext, type MapTile, type TileOptions } from '../../src/render/tileraster.ts';
import { fitView, screenToWorld, viewRect, worldToScreen } from '../../src/render/maptiles.ts';
import { hasRefs, readRef, referenceSaves } from './refs.ts';
import { synthSave, type SynthBrick } from './synthsave.ts';

function tilesOf(bytes: Uint8Array, opts: TileOptions = { hillshade: 0 }): { ov: SaveOverview; tiles: MapTile[]; save: LazyBrz } {
  const save = openBrzLazy(bytes), ov = readOverview(save);
  const ctx: ChunkContext = { schema: parseSchema(save.get('World/0/Bricks/ChunksShared.schema')!), basicNames: ov.names.basicBricks, proceduralNames: ov.names.proceduralBricks, materialNames: ov.names.materials };
  const tiles = ov.chunks.filter((c) => c.grid === '1').map((c) => rasteriseChunk(save.get(c.path)!, ctx, c, opts));
  return { ov, tiles, save };
}

/** Pixel of world point (x, y) in a tile, or null outside it. */
function px(t: MapTile, x: number, y: number): { rgba: number[]; top: number } | null {
  const ix = Math.floor(x / t.unitsPerPx), iy = Math.floor(y / t.unitsPerPx);
  if (ix < t.ix0 || ix >= t.ix0 + t.nx || iy < t.iy0 || iy >= t.iy0 + t.ny) return null;
  const k = (t.nx - 1 - (ix - t.ix0)) * t.w + (iy - t.iy0);
  return { rgba: [...t.rgba.subarray(k * 4, k * 4 + 4)], top: t.top[k]! };
}

describe('map tile rasteriser', () => {
  it('keeps the top-most brick per cell, in sRGB, with heights', () => {
    const b: SynthBrick[] = [
      { asset: 'PB_DefaultBrick', size: [40, 40, 2], pos: [40, 40, 2], color: [10, 20, 30] },        // 8x8 plate, top z 4
      { asset: 'PB_DefaultBrick', size: [5, 5, 6], pos: [45, 45, 10], color: [200, 100, 0] },         // 1x1 brick on it, top z 16
      { asset: 'PB_DefaultBrick', size: [5, 5, 6], pos: [65, 65, 10], color: [0, 255, 0], hidden: true },
    ];
    const [t] = tilesOf(synthSave(b)).tiles;
    expect([t!.ix0, t!.iy0, t!.nx, t!.ny, t!.w, t!.h]).toEqual([0, 0, 8, 8, 8, 8]);
    expect(px(t!, 45, 45)).toEqual({ rgba: [200, 100, 0, 255], top: 16 });
    expect(px(t!, 5, 5)).toEqual({ rgba: [10, 20, 30, 255], top: 4 });
    expect(px(t!, 65, 65)!.top).toBe(4);          // hidden brick skipped
    expect(t!.bricks).toBe(2);
    // image row 0 is the highest X: world (75, 5) is the top-left pixel
    expect([...t!.rgba.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
  });

  it('rotates footprints with the orientation byte (core/orient.ts)', () => {
    // a 1x4 brick (half 5 x 20 x 6) turned 90 degrees about Z (orient 17) lies along X
    const b: SynthBrick[] = [{ asset: 'PB_DefaultBrick', size: [5, 20, 6], pos: [100, 105, 6], orient: 17, color: [255, 255, 255] }];
    const [t] = tilesOf(synthSave(b)).tiles;
    expect([t!.nx, t!.ny]).toEqual([4, 1]);
    // lying on its side with studs +X (orient 0): local Z (6) goes to X, local X (5) to Z
    const side: SynthBrick[] = [{ asset: 'PB_DefaultBrick', size: [5, 20, 6], pos: [100, 100, 5], orient: 0, color: [255, 255, 255] }];
    const [s] = tilesOf(synthSave(side)).tiles;
    expect(s!.ny).toBe(4);
    expect(s!.maxZ).toBe(10);   // local X (half 5) is now up
  });

  it('places dynamic grids with their entity transform', () => {
    const b: SynthBrick[] = [{ asset: 'PB_DefaultBrick', size: [5, 20, 6], pos: [100, 105, 6], color: [9, 9, 9] }];
    const save = openBrzLazy(synthSave(b)), ov = readOverview(save), c = ov.chunks[0]!;
    const ctx: ChunkContext = { schema: parseSchema(save.get('World/0/Bricks/ChunksShared.schema')!), basicNames: [], proceduralNames: ov.names.proceduralBricks, materialNames: [] };
    // 90 degrees about Z: local +X -> world +Y, local +Y -> world -X; then moved by (1005, 5, 50)
    const s = Math.SQRT1_2;
    const t = rasteriseChunk(save.get(c.path)!, ctx, { ...c, transform: { loc: [1005, 5, 50], rot: [0, 0, s, s] } }, { hillshade: 0 });
    expect([t.nx, t.ny]).toEqual([4, 1]);                 // the 1x4 now runs along X
    expect(px(t, 1005 - 105, 105 + 3)!.top).toBe(62);   // centre (-105, 100, 6) + loc; top 56 + 6
    expect(transformBox({ min: [0, 0, 0], max: [10, 20, 30] }, [1, 2, 3], [0, 0, s, s])).toEqual({ min: [-19, 2, 3], max: [1, 12, 33] });
  });

  it('sizes fixed-asset bricks from their name', () => {
    expect(basicHalf('B_2x2_Round')).toEqual([10, 10, 6]);
    expect(basicHalf('B_2x4F_Something')).toEqual([10, 20, 2]);
    expect(basicHalf('B_Spike')).toEqual([5, 5, 6]);
  });

  it('makes one cell for footprints smaller than a cell, and hillshades slopes only', () => {
    const b: SynthBrick[] = [
      { asset: 'PB_DefaultMicroBrick', size: [1, 1, 1], pos: [2, 2, 1], color: [100, 100, 100] },
      { asset: 'PB_DefaultBrick', size: [50, 50, 2], pos: [200, 200, 2], color: [100, 100, 100] },
    ];
    const save = synthSave(b);
    const flat = tilesOf(save, { hillshade: 0 }).tiles[0]!, shaded = tilesOf(save, { hillshade: 1 }).tiles[0]!;
    expect(px(flat, 2, 2)!.top).toBe(2);
    expect(px(shaded, 200, 200)!.rgba).toEqual([100, 100, 100, 255]);   // flat ground keeps its colour
  });

  it('coarser resolutions give smaller tiles', () => {
    const b: SynthBrick[] = [{ asset: 'PB_DefaultBrick', size: [400, 400, 2], pos: [1000, 1000, 2], color: [1, 2, 3] }];
    const t = tilesOf(synthSave(b), { unitsPerPx: 40 }).tiles[0]!;
    expect([t.w, t.h]).toEqual([20, 20]);
  });
});

describe('map view maths', () => {
  it('maps world X up and Y right, and round-trips', () => {
    const v = { x: 100, y: 200, pxPerUnit: 0.5 };
    expect(worldToScreen(v, 800, 600, 100, 200)).toEqual([400, 300]);
    expect(worldToScreen(v, 800, 600, 110, 200)[1]).toBeLessThan(300);   // +X is up
    expect(worldToScreen(v, 800, 600, 100, 210)[0]).toBeGreaterThan(400); // +Y is right
    expect(screenToWorld(v, 800, 600, ...worldToScreen(v, 800, 600, 37, -12))).toEqual([37, -12]);
    expect(viewRect(v, 800, 600)).toEqual([-500, 700, -600, 1000]);
    const f = fitView({ min: [0, 0], max: [1000, 2000] }, 800, 600, 0);
    expect(f).toEqual({ x: 500, y: 1000, pxPerUnit: 0.4 });
  });
});

describe.skipIf(!hasRefs)('map tiles on the reference saves', () => {
  it.each(referenceSaves())('%s', (rel) => {
    const bytes = readRef(rel);
    const files = readBrz(bytes);
    if (!files.has('World/0/Bricks/ChunksShared.schema')) return;
    const { tiles } = tilesOf(bytes, {});
    const total = extractBricks(files).bricks.length;
    const drawn = tiles.reduce((s, t) => s + t.bricks, 0);
    // every grid-1 brick is drawn unless hidden or fully covered by a taller one
    expect(drawn).toBeLessThanOrEqual(total);
    if (total) expect(drawn).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(t.rgba.length).toBe(t.w * t.h * 4);
      expect(t.w * t.h).toBeLessThanOrEqual((3 * 2048 / 10 + 2) ** 2);
    }
  });
});
