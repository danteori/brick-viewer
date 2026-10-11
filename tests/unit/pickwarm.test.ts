// The pick grid built in idle slices equals the one built in one go (first-hover hitch fix).
import { describe, expect, it } from 'vitest';
import { S } from '../../src/app/state.ts';
import { pickBuild, pickGrid, pickWarm } from '../../src/scene/spatial.ts';
import { storeFromFilesPlain } from '../../src/scene/load.ts';
import { readBrz } from '../../src/format/brz.ts';
import { synthSave } from './synthsave.ts';

const snap = () => JSON.stringify({ cs: pickGrid.cs, org: pickGrid.org, dim: pickGrid.dim, dirty: pickGrid.dirty, box: [...pickGrid.box], cells: Array.from(pickGrid.cells, (c) => c ?? null) });

describe('pick grid warm-up', () => {
  it('sliced build equals the one-shot build', async () => {
    const bricks = Array.from({ length: 300 }, (_, i) => ({ asset: 'PB_DefaultBrick', size: [5 + (i % 4), 5, 3] as [number, number, number], pos: [(i % 20) * 24, Math.floor(i / 20) * 24, 3 + (i % 3) * 6] as [number, number, number], color: [200, 50, 50] as [number, number, number] }));
    S.scene = storeFromFilesPlain(readBrz(synthSave(bricks))).store;
    pickBuild();
    const once = snap();
    expect(JSON.parse(once).dirty).toBe(false);
    pickGrid.dirty = true; pickGrid.cells = []; pickGrid.box = new Float64Array(0);
    pickWarm(7, 1000);                                   // 7 bricks per slice: many steps
    expect(pickGrid.dirty).toBe(true);                   // not built yet
    await new Promise((r) => setTimeout(r, 400));
    expect(snap()).toBe(once);
  });
});
