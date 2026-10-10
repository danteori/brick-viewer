// Saving keeps components and wires intact (C-02 / C-03 data with F-03 Save .brz): components and
// wires name bricks by their index in a chunk, so the writer must give every loaded brick back its
// index, also when bricks the viewer can't show sit between the ones it shows.
import { describe, expect, it } from 'vitest';
import { bytesEqual, readBrz, type FileMap } from '../../src/format/brz.ts';
import { extractBricks, rebuildFromLoaded } from '../../src/format/world.ts';
import { decodeMps, encodeMps } from '../../src/format/schema.ts';
import { bricksFromFiles } from '../../src/scene/load.ts';
import { plainBrick, saveOrder, shiftedComponentChunks, writeScene } from '../../src/scene/save.ts';
import { loadComponents, saveContext } from '../../src/scene/components.ts';
import { componentSeqs } from '../../src/scene/remap.ts';
import { loadWires } from '../../src/scene/wires.ts';
import { save } from './comp-fixture.ts';
import { synthSave as brickSave } from './synthsave.ts';

const W = 'World/0/';

/** What the viewer writes: its shown bricks in scene order, then the ones it couldn't show (as sceneFiles does). */
function written(files: FileMap, edit?: (bs: ReturnType<typeof bricksFromFiles>['bricks']) => void): ReturnType<typeof plainBrick>[] {
  const { bricks, unsupported } = bricksFromFiles(files);
  edit?.(bricks);
  return bricks.map((b) => plainBrick(b, [0, 0, 0], false)).concat(unsupported);
}

const compSummary = (f: FileMap) => loadComponents(f).instances.map((c) => [c.id, c.type, c.brickRef, c.data]);
const wireSummary = (f: FileMap) => loadWires(f).wires().map((w) => [w.source, w.target]);

describe('saving a save with components and wires', () => {
  it('the fixture loads: 3 shown bricks, 1 skipped between them, components and wires on grid 1', () => {
    const f = save(), r = bricksFromFiles(f);
    expect(r.bricks.length).toBe(3);
    expect(r.unsupported.map((b) => b.seq)).toEqual([1]);
    expect(r.bricks.map((b) => b.save?.seq)).toEqual([0, 2, 3]);
    expect(loadComponents(f).instances.length).toBeGreaterThan(0);
    expect(loadWires(f).size).toBeGreaterThan(0);
  });

  it('an unedited round trip keeps every brick at its index and the component / wire files byte-identical', () => {
    const f = save(), out = rebuildFromLoaded(f, saveOrder(written(f))).files;
    const key = (b: { asset: string; pos: number[]; size: number[] | null }) => [b.asset, b.pos.join(), b.size?.join()].join(' ');
    expect(extractBricks(out).bricks.map(key)).toEqual(extractBricks(f).bricks.map(key));
    for (const [p, b] of f) if (/\/(Components|Wires)\//.test(p)) expect(bytesEqual(out.get(p)!, b), p).toBe(true);
    expect(compSummary(out)).toEqual(compSummary(f));
    expect(wireSummary(out)).toEqual(wireSummary(f));
    expect(shiftedComponentChunks(f, extractBricks(f).bricks, written(f))).toEqual([]);
  });

  it('without the load order the skipped brick would move and components would point at other bricks', () => {
    const f = save(), naive = rebuildFromLoaded(f, written(f).map(({ seq: _s, ...b }) => b)).files;
    expect(extractBricks(naive).bricks[1]!.asset).not.toBe(extractBricks(f).bricks[1]!.asset);
  });

  it('a recolour keeps the indices; a delete in a component chunk is reported', () => {
    const f = save();
    const recol = written(f, (bs) => { bs[0]!.color = [0.1, 0.9, 0.1]; });
    expect(shiftedComponentChunks(f, extractBricks(f).bricks, recol)).toEqual([]);
    expect(compSummary(rebuildFromLoaded(f, saveOrder(recol)).files)).toEqual(compSummary(f));
    const del = written(f, (bs) => { bs.splice(0, 1); });
    expect(shiftedComponentChunks(f, extractBricks(f).bricks, del)).toEqual(['0_0_0']);
  });
});

// E-02 follow-up: components and wires follow their bricks when a save is written.
describe('components and wires follow their bricks (scene/remap.ts)', () => {
  /** save() with one more plain brick at the FRONT of chunk 0_0_0, every grid-1 index there shifted by one */
  function shifted(): FileMap {
    const f = save(), out = new Map(f);
    const bricks = readBrz(brickSave([
      { asset: 'PB_DefaultBrick', size: [5, 5, 6], pos: [100, 100, 6], color: [1, 2, 3] },
      { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [5, 5, 6], color: [200, 30, 30] },
      { asset: 'PB_NotARealBrickType', size: [10, 10, 6], pos: [25, 5, 6], color: [30, 200, 30] },
      { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [45, 5, 6], color: [30, 30, 200] },
      { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [2100, 5, 6], color: [90, 90, 90] },
    ], { components: { '0_0_0': 3, '1_0_0': 1 }, wires: { '0_0_0': 1, '1_0_0': 1 } }));
    for (const p of [`${W}Bricks/Grids/1/ChunkIndex.mps`, `${W}Bricks/Grids/1/Chunks/0_0_0.mps`, `${W}Bricks/Grids/1/Chunks/1_0_0.mps`]) out.set(p, bricks.get(p)!);
    const ctx = saveContext(out);
    const bump = (path: string, fn: (root: Record<string, unknown>) => void): void => {
      const s = ctx.schemaFor(path), root = decodeMps<Record<string, unknown>>(out.get(path)!, s);
      fn(root); out.set(path, encodeMps(root, s));
    };
    bump(`${W}Bricks/Grids/1/Components/0_0_0.mps`, (r) => { r.ComponentBrickIndices = (r.ComponentBrickIndices as number[]).map((i) => i + 1); r.MicrochipBrickIndices = (r.MicrochipBrickIndices as number[]).map((i) => i + 1); });
    const plus = (l: unknown): void => { for (const e of l as { BrickIndexInChunk: number }[]) e.BrickIndexInChunk++; };
    bump(`${W}Bricks/Grids/1/Wires/0_0_0.mps`, (r) => { plus(r.LocalWireSources); plus(r.LocalWireTargets); });
    bump(`${W}Bricks/Grids/2/Wires/-1_-1_-1.mps`, (r) => { plus(r.RemoteWireSources); });
    return out;
  }

  it('deleting a plain brick before component bricks re-indexes them to the same bricks', () => {
    const before = shifted(), base = save();
    expect(compSummary(before)).not.toEqual(compSummary(base));
    // the viewer deletes the extra brick (seq 0): the rest keep their load order
    const scene = written(before, (bs) => { bs.splice(0, 1); });
    const out = writeScene(before, scene);
    expect(out.warnings.filter((w) => /could not follow/.test(w))).toEqual([]);
    // same bricks as the save without the extra one, and the components / wires point at them again
    const key = (b: { asset: string; pos: number[] }) => b.asset + b.pos.join();
    expect(extractBricks(out.files).bricks.map(key)).toEqual(extractBricks(base).bricks.map(key));
    expect(compSummary(out.files).map((c) => c[2])).toEqual(compSummary(base).map((c) => c[2]));
    expect(wireSummary(out.files)).toEqual(wireSummary(base));
    expect(componentSeqs(before)).toEqual(new Set([1, 2, 3, 4]));
  });

  it('reports (never guesses) a reference to a deleted brick', () => {
    const f = save();
    const out = writeScene(f, written(f, (bs) => { bs.splice(0, 1); }));
    expect(out.warnings.some((w) => /could not follow/.test(w))).toBe(true);
  });
});
