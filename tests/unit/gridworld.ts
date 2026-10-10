// A hand-made world in the current layout (schemas shaped like the game's CL15729-era files, fewer
// brick fields) with a dynamic grid: grid 1 holds three bricks, grid 2 two bricks, its entity
// parked at a fractional location turned a quarter turn about Z. `entityless`: the same world
// before any entity existed (no grid 2, no BrickGridDynamicActor struct, empty type lists), as a
// fresh world's files are.
import type { FileMap } from '../../src/format/brz.ts';
import { utf8 } from '../../src/format/msgpack.ts';
import { encodeMps, encodeSoa, parseSchema } from '../../src/format/schema.ts';
import { INDEX, ENTITY_INDEX, NEW_CHUNKS, mp, structs, W } from './brdb-synth.ts';

type Fields = Parameters<typeof structs>[0];
const schemaWithEnums = (enums: [string, [string, number][]][], s: Fields): Uint8Array =>
  mp([{ map: enums.map(([n, t]) => [n, { map: t }]) }, { map: [] }, structs(s)]).done();

const GRID_ACTOR: Fields[number] = ['BrickGridDynamicActor', [['BouyancyScale', 'f32'], ['MassScale', 'f32'], ['bEnableGravity', 'bool'], ['bUseNewMassCalculation', 'bool'],
  ['bReceivesDecals', 'bool'], ['CollisionQuality', 'EBRGridCollisionQuality'], ['EntityTag', 'str'], ['GameModeTeamName', 'str'], ['bDetectableByAnyone', 'bool']]];
const QUALITY: [string, [string, number][]] = ['EBRGridCollisionQuality', [['EBRGridCollisionQuality::Coarse', 0], ['EBRGridCollisionQuality::Fine', 1], ['EBRGridCollisionQuality::EBRGridCollisionQuality_MAX', 2]]];
const SOA: Fields = [
  ['BRSavedBitFlags', [['Flags', ['u8', null]]]],
  ['BRSavedBrickColor', [['R', 'u8'], ['G', 'u8'], ['B', 'u8'], ['A', 'u8']]],
  ['BRSavedEntityTypeCounter', [['TypeIndex', 'u32'], ['NumEntities', 'u32']]],
  ['Quat4f', [['X', 'f32'], ['Y', 'f32'], ['Z', 'f32'], ['W', 'f32']]], ['Vector3f', [['X', 'f32'], ['Y', 'f32'], ['Z', 'f32']]],
  ['BRSavedEntityColors', [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [`Color${i}`, 'BRSavedBrickColor'] as [string, string])],
  ['BRSavedEntityChunkSoA', [['TypeCounters', ['BRSavedEntityTypeCounter']], ['PersistentIndices', ['u32']], ['PrefabSpawnInstanceIndices', ['u32']], ['OwnerIndices', ['u32']],
    ['OriginalOwnerIndices', ['u32']], ['Locations', ['Vector3f', null]], ['Rotations', ['Quat4f', null]], ['PhysicsLockedFlags', 'BRSavedBitFlags'], ['PhysicsSleepingFlags', 'BRSavedBitFlags'],
    ['LinearVelocities', ['Vector3f', null]], ['AngularVelocities', ['Vector3f', null]], ['ColorsAndAlphas', ['BRSavedEntityColors', null]], ['RemainingLifeSpans', ['f32', null]], ['bColorsAreLinear', 'bool']]],
];
export const ENTITIES_FULL = schemaWithEnums([QUALITY], [GRID_ACTOR, ...SOA]);
export const ENTITIES_BARE = schemaWithEnums([], SOA);
const ENTITY_IDX = ENTITY_INDEX;
const GLOBAL = schemaWithEnums([], [['BRSavedGlobalData', [['BasicBrickAssetNames', ['str']], ['ProceduralBrickAssetNames', ['str']], ['MaterialAssetNames', ['str']],
  ['EntityTypeNames', ['str']], ['EntityDataClassNames', ['str']], ['GlobalGridEntityTypeIndex', 'i32']]]]);
const OWNERS = schemaWithEnums([], [['BRGuid', [['A', 'u32'], ['B', 'u32'], ['C', 'u32'], ['D', 'u32']]],
  ['BRSavedOwnerTableSoA', [['UserIds', ['BRGuid', null]], ['UserNames', ['str']], ['DisplayNames', ['str']], ['EntityCounts', ['u32']], ['BrickCounts', ['u32']], ['ComponentCounts', ['u32']], ['WireCounts', ['u32']]]]]);

const enc = (schema: Uint8Array, v: unknown): Uint8Array => encodeMps(v, parseSchema(schema));
const col = (r: number, g: number, b: number) => ({ R: r, G: g, B: b, A: 5 });

interface B { pos: [number, number, number]; size: [number, number, number]; orient?: number; color: [number, number, number] }
/** One chunk of PB_DefaultBrick bricks (each its own size entry) centred at `centre`. */
function chunk(bricks: B[], centre: readonly number[]): Uint8Array {
  const n = bricks.length;
  return enc(NEW_CHUNKS, {
    ProceduralBrickStartingIndex: 0, BrickSizeCounters: [{ AssetIndex: 0, NumSizes: n }], BrickSizes: bricks.map((b) => ({ X: b.size[0], Y: b.size[1], Z: b.size[2] })),
    BrickTypeIndices: bricks.map((_, i) => i), OwnerIndices: bricks.map(() => 0), OriginalOwnerIndices: bricks.map(() => 0),
    RelativePositions: bricks.map((b) => ({ X: b.pos[0] - centre[0]!, Y: b.pos[1] - centre[1]!, Z: b.pos[2] - centre[2]! })), Orientations: bricks.map((b) => b.orient ?? 16),
    CollisionFlags_Player: { Flags: [(1 << n) - 1] }, CollisionFlags_Player1: { Flags: [(1 << n) - 1] }, VisibilityFlags: { Flags: [(1 << n) - 1] },
    MaterialIndices: bricks.map(() => 0), ColorsAndAlphas: bricks.map((b) => col(...b.color)), bColorsAreLinear: false,
  });
}

export const MAIN: B[] = [
  { pos: [0, 0, 6], size: [10, 10, 6], color: [200, 30, 30] },
  { pos: [40, 0, 6], size: [20, 10, 6], color: [30, 200, 30] },
  { pos: [0, 60, 2], size: [10, 20, 2], color: [30, 30, 200] },
];
/** grid 2, grid-local */
export const DYN: B[] = [
  { pos: [0, 0, 0], size: [10, 20, 6], color: [250, 200, 0] },
  { pos: [30, 0, 0], size: [20, 10, 6], orient: 17, color: [0, 200, 250] },
];
export const DYN_LOCATION: [number, number, number] = [500.25, -300, 30];
export const DYN_ROTATION: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

export function gridWorld(opts: { entityless?: boolean } = {}): FileMap {
  const bare = !!opts.entityless;
  const files: FileMap = new Map();
  files.set('Meta/World.json', utf8('{"environment": "Plate"}'));
  files.set(W + 'GlobalData.schema', GLOBAL);
  files.set(W + 'GlobalData.mps', enc(GLOBAL, { BasicBrickAssetNames: [], ProceduralBrickAssetNames: ['PB_DefaultBrick'], MaterialAssetNames: ['BMC_Plastic'],
    EntityTypeNames: bare ? [] : ['Entity_DynamicBrickGrid'], EntityDataClassNames: bare ? [] : ['BrickGridDynamicActor'], GlobalGridEntityTypeIndex: -1 }));
  files.set(W + 'Owners.schema', OWNERS);
  files.set(W + 'Owners.mps', enc(OWNERS, { UserIds: [{ A: 1, B: 2, C: 3, D: 4 }], UserNames: ['tester'], DisplayNames: ['Tester'], EntityCounts: [bare ? 0 : 1],
    BrickCounts: [MAIN.length + (bare ? 0 : DYN.length)], ComponentCounts: [0], WireCounts: [0] }));
  files.set(W + 'Bricks/ChunkIndexShared.schema', INDEX);
  files.set(W + 'Bricks/ChunksShared.schema', NEW_CHUNKS);
  files.set(W + 'Bricks/Grids/1/ChunkIndex.mps', enc(INDEX, { Chunk3DIndices: [{ X: 0, Y: 0, Z: 0 }], ChunkOffsets: [{ X: 0, Y: 0, Z: 0 }], ChunkSizes: [2048], NumBricks: [MAIN.length], NumComponents: [0], NumWires: [0] }));
  files.set(W + 'Bricks/Grids/1/Chunks/0_0_0.mps', chunk(MAIN, [1024, 1024, 1024]));
  files.set(W + 'Entities/ChunkIndex.schema', ENTITY_IDX);
  files.set(W + 'Entities/ChunksShared.schema', bare ? ENTITIES_BARE : ENTITIES_FULL);
  if (bare) {
    files.set(W + 'Entities/ChunkIndex.mps', enc(ENTITY_IDX, { NextPersistentIndex: 2, Chunk3DIndices: [], NumEntities: [] }));
    return files;
  }
  files.set(W + 'Bricks/Grids/2/ChunkIndex.mps', enc(INDEX, { Chunk3DIndices: [{ X: -1, Y: -1, Z: -1 }], ChunkOffsets: [{ X: 1024, Y: 1024, Z: 1024 }], ChunkSizes: [2048], NumBricks: [DYN.length], NumComponents: [0], NumWires: [0] }));
  files.set(W + 'Bricks/Grids/2/Chunks/-1_-1_-1.mps', chunk(DYN, [0, 0, 0]));
  files.set(W + 'Entities/ChunkIndex.mps', enc(ENTITY_IDX, { NextPersistentIndex: 3, Chunk3DIndices: [{ X: 0, Y: 0, Z: 0 }], NumEntities: [1] }));
  const es = parseSchema(ENTITIES_FULL), white = { R: 255, G: 255, B: 255, A: 255 };
  files.set(W + 'Entities/Chunks/0_0_0.mps', encodeSoa({
    root: {
      TypeCounters: [{ TypeIndex: 0, NumEntities: 1 }], PersistentIndices: [2], PrefabSpawnInstanceIndices: [0], OwnerIndices: [0], OriginalOwnerIndices: [0],
      Locations: [{ X: DYN_LOCATION[0], Y: DYN_LOCATION[1], Z: DYN_LOCATION[2] }], Rotations: [{ X: DYN_ROTATION[0], Y: DYN_ROTATION[1], Z: DYN_ROTATION[2], W: DYN_ROTATION[3] }],
      PhysicsLockedFlags: { Flags: [1] }, PhysicsSleepingFlags: { Flags: [0] }, LinearVelocities: [{ X: 0, Y: 0, Z: 0 }], AngularVelocities: [{ X: 0, Y: 0, Z: 0 }],
      ColorsAndAlphas: [Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [`Color${i}`, white]))], RemainingLifeSpans: [0], bColorsAreLinear: false,
    },
    data: [{ typeIndex: 0, struct: 'BrickGridDynamicActor', value: { BouyancyScale: 0.5, MassScale: 2, bEnableGravity: true, bUseNewMassCalculation: true, bReceivesDecals: true, CollisionQuality: 1, EntityTag: 'door', GameModeTeamName: '', bDetectableByAnyone: false } }],
  }, es));
  return files;
}
