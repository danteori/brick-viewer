// Timings on big local saves (S-09 / S-14). Opt-in: point BRICK_BIG_WORLDS at a folder of .brz
// files (e.g. worlds converted with `python tools/brdb.py brdb2brz` into a temp folder). Skipped
// otherwise. Prints one line per save; nothing about the saves is stored.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBrzArchive } from '../../src/format/brz.ts';
import { openBrzLazy } from '../../src/format/brzlazy.ts';
import { readOverview, suggestLoadOrder } from '../../src/format/overview.ts';
import { parseSchema } from '../../src/format/schema.ts';
import { extractBricks } from '../../src/format/world.ts';
import { rasteriseChunk } from '../../src/render/tileraster.ts';

const DIR = process.env.BRICK_BIG_WORLDS;
const worlds = DIR && existsSync(DIR) ? readdirSync(DIR).filter((n) => n.endsWith('.brz')).sort().map((n) => join(DIR, n)) : [];

const ms = (t: number): string => `${t.toFixed(1)} ms`;

describe.skipIf(!worlds.length)('big worlds (BRICK_BIG_WORLDS)', () => {
  it.each(worlds)('%s', (path) => {
    const bytes = new Uint8Array(readFileSync(path));
    let t = performance.now();
    const save = openBrzLazy(bytes);
    const ov = readOverview(save);
    const overviewMs = performance.now() - t;
    t = performance.now();
    suggestLoadOrder(ov, [0, 0, 0], { budgetBytes: 256 << 20 });
    const orderMs = performance.now() - t;

    t = performance.now();
    const archive = readBrzArchive(bytes);
    const eagerMs = performance.now() - t;
    t = performance.now();
    // extractBricks needs ChunkSizes, which saves from before ~2025-09 lack
    let full = -1;
    try { full = extractBricks(archive.files).bricks.length; } catch { /* old save */ }
    const extractMs = performance.now() - t;

    const ctx = { schema: parseSchema(save.get('World/0/Bricks/ChunksShared.schema')!), basicNames: ov.names.basicBricks, proceduralNames: ov.names.proceduralBricks, materialNames: ov.names.materials };
    let decodeMs = 0, rasterMs = 0, px = 0, worst = 0, drawn = 0, tiles = 0, decoded = 0, dyn = 0;
    const grids = new Map(ov.grids.map((g) => [g.id, g]));
    t = performance.now();
    for (const c of ov.chunks) {
      const g = grids.get(c.grid)!;
      if (!c.present || (g.dynamic && !g.location)) continue;
      const transform = g.dynamic ? { loc: g.location!, rot: g.rotation } : null;
      const tile = rasteriseChunk(save.get(c.path)!, ctx, { ...c, transform }, { unitsPerPx: 10 });
      decodeMs += tile.decodeMs; rasterMs += tile.rasterMs; px += tile.w * tile.h; drawn += tile.bricks; tiles++;
      if (g.dynamic) dyn++;
      else decoded += tile.total;
      worst = Math.max(worst, tile.decodeMs + tile.rasterMs);
    }
    const tilesMs = performance.now() - t;
    const g1 = ov.grids.find((g) => g.id === '1');
    expect(g1?.bricks ?? 0).toBe(decoded);
    const placed = ov.grids.filter((g) => g.dynamic && g.location).length, dynGrids = ov.grids.filter((g) => g.dynamic).length;
    if (full >= 0) expect(full).toBe(decoded);
    console.log([
      basename(path), `${(bytes.length / 1e6).toFixed(1)} MB`,
      `grids ${ov.totals.grids}`, `chunks ${ov.totals.chunks}`, `bricks ${ov.totals.bricks}`, `comps ${ov.totals.components}`, `wires ${ov.totals.wires}`,
      `est ${(ov.totals.estBytes / 1e6).toFixed(0)} MB`,
      `overview ${ms(overviewMs)}`, `order ${ms(orderMs)}`,
      `eager read ${ms(eagerMs)}`, `full extract ${full >= 0 ? ms(extractMs) : 'n/a (old save)'}`,
      `dynamic grids placed ${placed}/${dynGrids}`, `tiles ${tiles} (${dyn} dynamic) in ${ms(tilesMs)} (decode ${ms(decodeMs)}, raster ${ms(rasterMs)}, worst chunk ${ms(worst)}, ${(px * 4 / 1e6).toFixed(1)} MB RGBA, ${drawn} bricks drawn)`,
    ].join(' | '));
  });
});
