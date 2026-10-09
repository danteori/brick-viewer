// Hand-made save files for the .brdb tests: tiny schemas, an old-layout brick world, a world
// with dynamic grids and entities. Shared by brdb.test.ts and brdblazy.test.ts.
import type { FileMap } from '../../src/format/brz.ts';
import { ByteBuf, arrayHeader, mapHeader, pack, utf8 } from '../../src/format/msgpack.ts';
import { encodeMps, parseSchema } from '../../src/format/schema.ts';

// ---- a tiny MessagePack writer for hand-made schemas: arrays, {map: pairs}, strings, numbers, nil
type Mp = null | string | number | Mp[] | { map: [Mp, Mp][] };
export function mp(v: Mp, o = new ByteBuf()): ByteBuf {
  if (v === null || typeof v === 'string' || typeof v === 'number') pack(o, v);
  else if (Array.isArray(v)) { arrayHeader(o, v.length); v.forEach((x) => mp(x, o)); }
  else { mapHeader(o, v.map.length); for (const [k, x] of v.map) { mp(k, o); mp(x, o); } }
  return o;
}
export const structs = (s: [string, [string, Mp][]][]): Mp => ({ map: s.map(([n, f]) => [n, { map: f }]) });
export const schema3 = (s: [string, [string, Mp][]][]): Uint8Array => mp([{ map: [] }, { map: [] }, structs(s)]).done();
export const schema2 = (s: [string, [string, Mp][]][]): Uint8Array => mp([{ map: [] }, structs(s)]).done();

export const GLOBAL = schema3([['BRSavedGlobalData', [['BasicBrickAssetNames', ['str']], ['ProceduralBrickAssetNames', ['str']], ['MaterialAssetNames', ['str']]]]]);
export const COMMON: [string, [string, Mp][]][] = [
  ['BRSavedBitFlags', [['Flags', ['u8', null]]]],
  ['BRSavedBrickColor', [['R', 'u8'], ['G', 'u8'], ['B', 'u8'], ['A', 'u8']]],
  ['BRSavedBrickSize', [['X', 'u16'], ['Y', 'u16'], ['Z', 'u16']]],
  ['BRSavedBrickSizeCounter', [['AssetIndex', 'u32'], ['NumSizes', 'u32']]],
  ['BRSavedRelativeBrickPosition', [['X', 'i16'], ['Y', 'i16'], ['Z', 'i16']]],
];
// An older brick chunk layout (as 2025 saves) and the current one.
export const OLD_FIELDS: [string, Mp][] = [
  ['ProceduralBrickStartingIndex', 'u32'], ['BrickSizeCounters', ['BRSavedBrickSizeCounter']], ['BrickSizes', ['BRSavedBrickSize']],
  ['BrickTypeIndices', ['u32']], ['OwnerIndices', ['u32']], ['RelativePositions', ['BRSavedRelativeBrickPosition', null]], ['Orientations', ['u8', null]],
  ['CollisionFlags_Player', 'BRSavedBitFlags'], ['CollisionFlags_Tool', 'BRSavedBitFlags'], ['VisibilityFlags', 'BRSavedBitFlags'],
  ['MaterialIndices', ['u8', null]], ['ColorsAndAlphas', ['BRSavedBrickColor', null]]];
export const OLD_CHUNKS = schema2([...COMMON, ['BRSavedBrickChunkSoA', OLD_FIELDS]]);
export const NEW_CHUNKS = schema3([...COMMON, ['BRSavedBrickChunkSoA', [
  ['ProceduralBrickStartingIndex', 'u32'], ['BrickSizeCounters', ['BRSavedBrickSizeCounter']], ['BrickSizes', ['BRSavedBrickSize']],
  ['BrickTypeIndices', ['u32']], ['OwnerIndices', ['u32']], ['OriginalOwnerIndices', ['u32']], ['RelativePositions', ['BRSavedRelativeBrickPosition', null]],
  ['Orientations', ['u8', null]], ['CollisionFlags_Player', 'BRSavedBitFlags'], ['CollisionFlags_Player1', 'BRSavedBitFlags'], ['VisibilityFlags', 'BRSavedBitFlags'],
  ['MaterialIndices', ['u8', null]], ['ColorsAndAlphas', ['BRSavedBrickColor', null]], ['bColorsAreLinear', 'bool']]]]);
export const INDEX = schema3([
  ['BRSavedChunk3DIndex', [['X', 'i16'], ['Y', 'i16'], ['Z', 'i16']]], ['IntVector', [['X', 'i32'], ['Y', 'i32'], ['Z', 'i32']]],
  ['BRSavedBrickChunkIndexSoA', [['Chunk3DIndices', ['BRSavedChunk3DIndex']], ['ChunkOffsets', ['IntVector']], ['ChunkSizes', ['i32']],
    ['NumBricks', ['u32']], ['NumComponents', ['u32']], ['NumWires', ['u32']]]]]);
export const ENTITY_INDEX = schema3([['BRSavedChunk3DIndex', [['X', 'i16'], ['Y', 'i16'], ['Z', 'i16']]],
  ['BRSavedEntityChunkIndexSoA', [['NextPersistentIndex', 'u32'], ['Chunk3DIndices', ['BRSavedChunk3DIndex']], ['NumEntities', ['u32']]]]]);
export const ENTITIES = schema3([
  ['BrickGridDynamicActor', []], ['BRSavedBitFlags', [['Flags', ['u8', null]]]],
  ['BRSavedEntityTypeCounter', [['TypeIndex', 'u32'], ['NumEntities', 'u32']]],
  ['Quat4f', [['X', 'f32'], ['Y', 'f32'], ['Z', 'f32'], ['W', 'f32']]], ['Vector3f', [['X', 'f32'], ['Y', 'f32'], ['Z', 'f32']]],
  ['BRSavedEntityChunkSoA', [['TypeCounters', ['BRSavedEntityTypeCounter']], ['PersistentIndices', ['u32']], ['OwnerIndices', ['u32']],
    ['Locations', ['Vector3f', null]], ['Rotations', ['Quat4f', null]], ['PhysicsLockedFlags', 'BRSavedBitFlags'], ['PhysicsSleepingFlags', 'BRSavedBitFlags']]]]);
export const GLOBAL_E = schema3([['BRSavedGlobalData', [['BasicBrickAssetNames', ['str']], ['ProceduralBrickAssetNames', ['str']], ['MaterialAssetNames', ['str']],
  ['EntityTypeNames', ['str']], ['EntityDataClassNames', ['str']]]]]);

export const enc = (schema: Uint8Array, v: unknown): Uint8Array => encodeMps(v, parseSchema(schema));
export const W = 'World/0/';

/** One brick chunk (old layout): a fixed B_1x1 and a procedural brick, colours stored linear. */
export function oldWorld(): FileMap {
  return new Map<string, Uint8Array>([
    ['Meta/World.json', utf8('{"environment": "Plate"}')],
    [W + 'GlobalData.schema', GLOBAL],
    [W + 'GlobalData.mps', enc(GLOBAL, { BasicBrickAssetNames: ['B_1x1'], ProceduralBrickAssetNames: ['PB_DefaultBrick'], MaterialAssetNames: ['BMC_Plastic'] })],
    [W + 'Bricks/ChunksShared.schema', OLD_CHUNKS],
    [W + 'Bricks/Grids/1/Chunks/0_0_0.mps', enc(OLD_CHUNKS, {
      ProceduralBrickStartingIndex: 1, BrickSizeCounters: [{ AssetIndex: 0, NumSizes: 1 }], BrickSizes: [{ X: 5, Y: 5, Z: 6 }],
      BrickTypeIndices: [0, 1], OwnerIndices: [0, 0], RelativePositions: [{ X: -1019, Y: -1019, Z: -1018 }, { X: 10, Y: 0, Z: 6 }], Orientations: [16, 16],
      CollisionFlags_Player: { Flags: [3] }, CollisionFlags_Tool: { Flags: [1] }, VisibilityFlags: { Flags: [3] },
      MaterialIndices: [0, 0], ColorsAndAlphas: [{ R: 0, G: 50, B: 255, A: 5 }, { R: 1, G: 2, B: 128, A: 10 }],
    })],
    ['Meta/Copy.json', utf8('{"environment": "Plate"}')],   // same bytes as World.json: one shared blob
  ]);
}

export function gridWorld(): FileMap {
  const files = oldWorld();
  files.set(W + 'GlobalData.schema', GLOBAL_E);
  files.set(W + 'GlobalData.mps', enc(GLOBAL_E, { BasicBrickAssetNames: ['B_1x1'], ProceduralBrickAssetNames: ['PB_DefaultBrick'], MaterialAssetNames: ['BMC_Plastic'],
    EntityTypeNames: ['Entity_DynamicBrickGrid'], EntityDataClassNames: ['BrickGridDynamicActor'] }));
  files.set(W + 'Bricks/ChunkIndexShared.schema', INDEX);
  files.set(W + 'Bricks/Grids/1/ChunkIndex.mps', enc(INDEX, { Chunk3DIndices: [{ X: 0, Y: 0, Z: 0 }], ChunkOffsets: [{ X: 0, Y: 0, Z: 0 }], ChunkSizes: [2048], NumBricks: [2], NumComponents: [0], NumWires: [0] }));
  files.set(W + 'Bricks/Grids/7/ChunkIndex.mps', enc(INDEX, { Chunk3DIndices: [{ X: -1, Y: -1, Z: -1 }], ChunkOffsets: [{ X: 1024, Y: 1024, Z: 1024 }], ChunkSizes: [2048], NumBricks: [2], NumComponents: [0], NumWires: [0] }));
  files.set(W + 'Bricks/Grids/7/Chunks/-1_-1_-1.mps', files.get(W + 'Bricks/Grids/1/Chunks/0_0_0.mps')!);
  files.set(W + 'Bricks/Grids/9/ChunkIndex.mps', enc(INDEX, { Chunk3DIndices: [{ X: -1, Y: -1, Z: -1 }], ChunkOffsets: [{ X: 1024, Y: 1024, Z: 1024 }], ChunkSizes: [2048], NumBricks: [4], NumComponents: [0], NumWires: [0] }));
  files.set(W + 'Entities/ChunkIndex.schema', ENTITY_INDEX);
  files.set(W + 'Entities/ChunkIndex.mps', enc(ENTITY_INDEX, { NextPersistentIndex: 10, Chunk3DIndices: [{ X: 0, Y: 0, Z: 0 }], NumEntities: [1] }));
  files.set(W + 'Entities/ChunksShared.schema', ENTITIES);
  const s = Math.SQRT1_2;
  files.set(W + 'Entities/Chunks/0_0_0.mps', enc(ENTITIES, { TypeCounters: [{ TypeIndex: 0, NumEntities: 1 }], PersistentIndices: [7], OwnerIndices: [0],
    Locations: [{ X: 100, Y: -50, Z: 25 }], Rotations: [{ X: 0, Y: 0, Z: s, W: s }], PhysicsLockedFlags: { Flags: [1] }, PhysicsSleepingFlags: { Flags: [0] } }));
  return files;
}
