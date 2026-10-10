// Loading and culling off the main thread (scene/parsecore.ts, S-01): the tiled face culling gives
// exactly the masks of one culler over the whole store, and a store posted from a worker's name
// tables comes back renumbered into this thread's tables, column for column.
import { describe, expect, it } from 'vitest';
import { readBrz } from '../../src/format/brz.ts';
import { storeFromFiles } from '../../src/scene/load.ts';
import { adoptParsed, CULL_TILE, cullColumnsOf, parseForPost, regionMasks } from '../../src/scene/parsecore.ts';
import { FaceCuller, FULL_BOX_ASSETS, type CullBrick } from '../../src/scene/cull.ts';
import { ASSETS, F_ALIVE, Kind, MATERIALS, SceneStore, worldHalfOf } from '../../src/scene/store.ts';
import { hasRefs, readRef, referenceSaves } from './refs.ts';
import { synthSave } from './synthsave.ts';

/** The masks of one FaceCuller over every row (as render/facecull.ts builds it). */
function globalMasks(s: SceneStore): Uint8Array {
  const bricks: CullBrick[] = [];
  for (let id = 0; id < s.n; id++) {
    if (!(s.flags[id]! & F_ALIVE)) { bricks.push({ pos: [0, 0, 0], half: [0, 0, 0], shape: 'none', fullBox: false }); continue; }
    const box = s.shape[id] === Kind.Box && FULL_BOX_ASSETS.has(ASSETS.name(s.asset[id]!)), h = worldHalfOf(s.orient[id]!, s.hx[id]!, s.hy[id]!, s.hz[id]!);
    bricks.push({ pos: [s.px[id]!, s.py[id]!, s.pz[id]!], half: [h[0], h[1], h[2]], shape: box ? 'box' : 'other', material: MATERIALS.name(s.material[id]!), grid: s.grid[id]!, fullBox: box });
  }
  return new FaceCuller(bricks).masks;
}

const tiled = (s: SceneStore): Uint8Array => regionMasks(cullColumnsOf(s), ASSETS.list, MATERIALS.list);

/** A dense block of bricks straddling several culling tiles, with a baseplate under it, a hole and a glass brick. */
function blockScene(): SceneStore {
  const s = new SceneStore();
  const put = (x: number, y: number, z: number, hx: number, hy: number, hz: number, mat = 'BMC_Plastic'): void => {
    const id = s.alloc();
    s.px[id] = x; s.py[id] = y; s.pz[id] = z; s.hx[id] = hx; s.hy[id] = hy; s.hz[id] = hz;
    s.orient[id] = 16; s.asset[id] = ASSETS.id('PB_DefaultBrick'); s.material[id] = MATERIALS.id(mat);
  };
  put(CULL_TILE, CULL_TILE, -6, 3 * CULL_TILE, 3 * CULL_TILE, 6);       // a baseplate across 36 tiles
  for (let x = 0; x < 30; x++) for (let y = 0; y < 30; y++) for (let z = 0; z < 4; z++) {
    if (x === 14 && y === 14 && z === 2) continue;                   // a hole: its neighbours' faces show
    put(CULL_TILE - 300 + x * 20 + 10, CULL_TILE - 300 + y * 20 + 10, z * 12 + 6, 10, 10, 6, x === 3 && y === 3 && z === 1 ? 'BMC_Glass' : 'BMC_Plastic');
  }
  s.drain();
  return s;
}

describe('tiled face culling', () => {
  it('matches one culler on a block across tile borders', () => {
    const s = blockScene(), a = globalMasks(s), b = tiled(s);
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(a.some((m) => m)).toBe(true);
  });
  it.skipIf(!hasRefs).each(referenceSaves())('matches one culler on %s', (rel) => {
    const { store } = storeFromFiles(readBrz(readRef(rel)));
    expect(Array.from(tiled(store))).toEqual(Array.from(globalMasks(store)));
  });
});

describe('posting a parsed save', () => {
  it('renumbers names into this thread\'s tables', () => {
    const bytes = synthSave([
      { asset: 'PB_DefaultBrick', size: [20, 20, 12], pos: [0, 0, 12], color: [255, 240, 200], material: 'BMC_Glow', intensity: 10 },
      { asset: 'PB_DefaultTile', size: [10, 10, 2], pos: [400, 0, 2], color: [120, 180, 255], material: 'BMC_Glass', intensity: 0 },
    ]);
    const ref = storeFromFiles(readBrz(bytes)).store;
    const { msg } = parseForPost({ bytes });
    // pretend the worker numbered its names differently: reverse its tables and the columns
    const rev = (list: string[], col: Uint16Array | Uint8Array): string[] => { const L = list.length; for (let i = 0; i < msg.cols.n; i++) col[i] = L - 1 - col[i]!; return list.slice().reverse(); };
    msg.names.assets = rev(msg.names.assets, msg.cols.asset);
    msg.names.materials = rev(msg.names.materials, msg.cols.material);
    const got = adoptParsed(msg, new Map(msg.files)).store;
    expect(got.count).toBe(ref.count);
    for (const c of ['px', 'asset', 'material', 'color', 'shape', 'flags', 'collision', 'grid'] as const) expect(Array.from(got[c].subarray(0, got.n)), c).toEqual(Array.from(ref[c].subarray(0, ref.n)));
  });
});
