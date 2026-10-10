// The component / wire synthetic save (synth-save.ts) with real brick chunks for grid 1, shared by
// the save, scene-model and e2e tests. Chunk 0_0_0: brick 0 a switch, brick 1 a light of a type
// the viewer skips, brick 2 a chip; chunk 1_0_0: brick 0 a light. Grid 2 is the chip's grid.
import { readBrz, type FileMap } from '../../src/format/brz.ts';
import { decodeMps, encodeMps, parseSchema } from '../../src/format/schema.ts';
import { schemaFile, synthSave as componentSave } from './synth-save.ts';
import { synthSave as brickSave } from './synthsave.ts';

const W = 'World/0/';

/** The component / wire synthetic save with real brick chunks for grid 1 (brick 1 of chunk 0_0_0 is a type the viewer skips). */
export function save(): FileMap {
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

