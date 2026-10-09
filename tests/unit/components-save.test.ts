// Saving keeps components and wires intact (C-02 / C-03 data with F-03 Save .brz): components and
// wires name bricks by their index in a chunk, so the writer must give every loaded brick back its
// index, also when bricks the viewer can't show sit between the ones it shows.
import { describe, expect, it } from 'vitest';
import { bytesEqual, readBrz, type FileMap } from '../../src/format/brz.ts';
import { extractBricks, rebuildFromLoaded } from '../../src/format/world.ts';
import { decodeMps, encodeMps, parseSchema } from '../../src/format/schema.ts';
import { bricksFromFiles } from '../../src/scene/load.ts';
import { plainBrick, saveOrder, shiftedComponentChunks } from '../../src/scene/save.ts';
import { loadComponents } from '../../src/scene/components.ts';
import { loadWires } from '../../src/scene/wires.ts';
import { schemaFile, synthSave as componentSave } from './synth-save.ts';
import { synthSave as brickSave } from './synthsave.ts';

const W = 'World/0/';

/** The component / wire synthetic save with real brick chunks for grid 1 (brick 1 of chunk 0_0_0 is a type the viewer skips). */
function save(): FileMap {
  const files = componentSave();
  const bricks = readBrz(brickSave([
    { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [5, 5, 6], color: [200, 30, 30] },
    { asset: 'PB_NotARealBrickType', size: [10, 10, 6], pos: [25, 5, 6], color: [30, 200, 30] },
    { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [45, 5, 6], color: [30, 30, 200] },
    { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [2100, 5, 6], color: [90, 90, 90] },
  ], { components: { '0_0_0': 3, '1_0_0': 1 }, wires: { '0_0_0': 1, '1_0_0': 1 } }));
  // grid 2 keeps its own index, re-encoded with the brick save's index schema
  const g2 = decodeMps<Record<string, unknown[]>>(files.get(`${W}Bricks/Grids/2/ChunkIndex.mps`)!, parseSchema(files.get(`${W}Bricks/ChunkIndexShared.schema`)!));
  for (const p of [`${W}Bricks/ChunkIndexShared.schema`, `${W}Bricks/ChunksShared.schema`, `${W}Bricks/Grids/1/ChunkIndex.mps`, `${W}Bricks/Grids/1/Chunks/0_0_0.mps`, `${W}Bricks/Grids/1/Chunks/1_0_0.mps`]) files.set(p, bricks.get(p)!);
  files.set(`${W}Bricks/Grids/2/ChunkIndex.mps`, encodeMps({ ...g2, ChunkOffsets: [{ X: 0, Y: 0, Z: 0 }], ChunkSizes: [2048] }, parseSchema(bricks.get(`${W}Bricks/ChunkIndexShared.schema`)!)));
  // one GlobalData with the brick and the component name lists
  const gb = decodeMps<Record<string, unknown>>(bricks.get(`${W}GlobalData.mps`)!, parseSchema(bricks.get(`${W}GlobalData.schema`)!));
  const gc = decodeMps<Record<string, unknown>>(files.get(`${W}GlobalData.mps`)!, parseSchema(files.get(`${W}GlobalData.schema`)!));
  const gs = schemaFile({}, {}, {
    AssetRef: [['PrimaryAssetType', 'str'], ['PrimaryAssetName', 'str']],
    BRSavedGlobalData: [['BasicBrickAssetNames', ['str']], ['ProceduralBrickAssetNames', ['str']], ['MaterialAssetNames', ['str']],
      ['ComponentTypeNames', ['str']], ['ComponentDataStructNames', ['str']], ['ComponentWirePortNames', ['str']], ['EntityTypeNames', ['str']], ['ExternalAssetReferences', ['AssetRef']]],
  });
  files.set(`${W}GlobalData.schema`, gs);
  files.set(`${W}GlobalData.mps`, encodeMps({ ...gb, ...gc }, parseSchema(gs)));
  return files;
}

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
