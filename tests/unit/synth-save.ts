// A small synthetic save for component / wire tests: made-up type and port names, laid out the
// way FORMAT 1.7 / 1.8 describes (schemas, GlobalData, components, wires, a microchip grid).
import { ByteBuf, arrayHeader, mapHeader, pack, type Packable } from '../../src/format/msgpack.ts';
import { encodeMps, encodeSoa, parseSchema, type SoaInstance } from '../../src/format/schema.ts';
import type { FileMap } from '../../src/format/brz.ts';

type Plain = Packable | Plain[] | Map<string, Plain>;
/** Plain JS -> MessagePack (Map = msgpack map, in insertion order). */
export function mp(x: Plain, o = new ByteBuf()): Uint8Array {
  if (Array.isArray(x)) { arrayHeader(o, x.length); for (const e of x) mp(e, o); }
  else if (x instanceof Map) { mapHeader(o, x.size); for (const [k, v] of x) { pack(o, k); mp(v, o); } }
  else pack(o, x);
  return o.done();
}
const M = (o: Record<string, Plain>): Map<string, Plain> => new Map(Object.entries(o));
/** A schema file: [enums, variants, structs]. Struct fields given as [name, type] lists. */
export function schemaFile(enums: Record<string, Record<string, number>>, variants: Record<string, Plain[]>, structs: Record<string, [string, Plain][]>): Uint8Array {
  return mp([
    M(Object.fromEntries(Object.entries(enums).map(([k, v]) => [k, M(v)]))),
    M(variants),
    M(Object.fromEntries(Object.entries(structs).map(([k, f]) => [k, new Map(f)]))),
  ]);
}

const W = 'World/0/';
export const TYPES = ['Test_Switch', 'Test_Light', 'Test_Chip', 'Test_MicrochipInput', 'Test_AndGate', 'Test_MicrochipOutput'];
export const STRUCTS = ['Data_Switch', 'Data_Light', 'None', 'Data_ChipIO', 'Data_Gate', 'Data_ChipIO'];
export const PORTS = ['bOn', 'bEnabled', 'RER_Input', 'RER_Output', 'InputA', 'InputB', 'Output'];

const XYZ: [string, Plain][] = [['X', 'i32'], ['Y', 'i32'], ['Z', 'i32']];
const end: [string, Plain][] = [['BrickIndexInChunk', 'u32'], ['ComponentTypeIndex', 'u16'], ['PortIndex', 'u16']];

/**
 * Grid 1, chunk 0_0_0: brick 0 switch, brick 1 light, brick 2 chip (owner 1 for brick 1).
 * Grid 1, chunk 1_0_0: brick 0 light.  Grid 2 (the chip's inside), chunk -1_-1_-1: 0 input, 1 AND gate, 2 output.
 * Wires: switch->light; switch->chip input; input->gate.InputA; gate->output; output->light (chunk 1_0_0).
 */
export function synthSave(): FileMap {
  const files: FileMap = new Map();
  const gs = schemaFile({}, {}, {
    AssetRef: [['PrimaryAssetType', 'str'], ['PrimaryAssetName', 'str']],
    BRSavedGlobalData: [['ComponentTypeNames', ['str']], ['ComponentDataStructNames', ['str']], ['ComponentWirePortNames', ['str']], ['EntityTypeNames', ['str']], ['ExternalAssetReferences', ['AssetRef']]],
  });
  files.set(W + 'GlobalData.schema', gs);
  files.set(W + 'GlobalData.mps', encodeMps({
    ComponentTypeNames: TYPES, ComponentDataStructNames: STRUCTS, ComponentWirePortNames: PORTS, EntityTypeNames: ['Entity_TestMicrochipGrid'],
    ExternalAssetReferences: [{ PrimaryAssetType: 'Sound', PrimaryAssetName: 'Click' }],
  }, parseSchema(gs)));
  const os = schemaFile({}, {}, { BRSavedOwnerTableSoA: [['UserNames', ['str']], ['ComponentCounts', ['u32']], ['WireCounts', ['u32']]] });
  files.set(W + 'Owners.schema', os);
  files.set(W + 'Owners.mps', encodeMps({ UserNames: ['a', 'b'], ComponentCounts: [6, 1], WireCounts: [4, 1] }, parseSchema(os)));

  const cs = schemaFile({ ETestMode: { 'ETestMode::Off': 0, 'ETestMode::Blink': 1, 'ETestMode::Pulse': 5 } }, { TestVariant: ['f64', 'i64', 'bool', 'Vector'] }, {
    Counter: [['TypeIndex', 'u32'], ['NumInstances', 'u32']],
    Color: [['B', 'u8'], ['G', 'u8'], ['R', 'u8'], ['A', 'u8']],
    Vector: [['X', 'f64'], ['Y', 'f64'], ['Z', 'f64']],
    Rotator3f: [['Pitch', 'f32'], ['Yaw', 'f32'], ['Roll', 'f32']],
    Data_Switch: [['bEnabled', 'bool'], ['Sound', 'object']],
    Data_Light: [['Brightness', 'f32'], ['Radius', 'f64'], ['Color', 'Color'], ['Rotation', 'Rotator3f'], ['Mode', 'ETestMode'], ['Label', 'str'], ['Value', 'TestVariant'], ['Tags', new Map([['str', 'i32']])], ['Steps', ['u8']]],
    Data_ChipIO: [['PortLabel', 'str']],
    Data_Gate: [['bInputA', 'bool'], ['bInputB', 'bool']],
    BRSavedComponentChunkSoA: [['ComponentTypeCounters', ['Counter']], ['ComponentBrickIndices', ['u32']], ['MicrochipBrickIndices', ['u32']], ['MicrochipBrickGridReferences', ['u32']]],
  });
  files.set(W + 'Bricks/ComponentsShared.schema', cs);
  const csS = parseSchema(cs);
  const light = (b: number): SoaInstance['value'] => ({
    Brightness: 20, Radius: 0.3, Color: { B: 255, G: 128, R: 0, A: 255 }, Rotation: { Pitch: 0, Yaw: 90, Roll: 0 }, Mode: 1, Label: 'lamp' + b,
    Value: { variant: 1, type: 'i64', value: 7 }, Tags: new Map([['a', 1]]), Steps: [1, 2, 200],
  });
  const comp = (grid: number, chunk: string, counters: [number, number][], bricks: number[], data: SoaInstance[], chip: [number[], number[]] = [[], []]): void => {
    files.set(`${W}Bricks/Grids/${grid}/Components/${chunk}.mps`, encodeSoa({
      root: { ComponentTypeCounters: counters.map(([TypeIndex, NumInstances]) => ({ TypeIndex, NumInstances })), ComponentBrickIndices: bricks, MicrochipBrickIndices: chip[0], MicrochipBrickGridReferences: chip[1] },
      data,
    }, csS));
  };
  const inst = (typeIndex: number, value: SoaInstance['value']): SoaInstance => ({ typeIndex, struct: STRUCTS[typeIndex] === 'None' ? null : STRUCTS[typeIndex]!, value });
  comp(1, '0_0_0', [[0, 1], [1, 1], [2, 1]], [0, 1, 2], [inst(0, { bEnabled: true, Sound: 0 }), inst(1, light(1)), inst(2, null)], [[2], [2]]);
  comp(1, '1_0_0', [[1, 1]], [0], [inst(1, light(2))]);
  comp(2, '-1_-1_-1', [[3, 1], [4, 1], [5, 1]], [0, 1, 2], [inst(3, { PortLabel: 'in' }), inst(4, { bInputA: false, bInputB: true }), inst(5, { PortLabel: 'out' })]);

  const ws = schemaFile({}, {}, {
    BRSavedChunk3DIndex: XYZ,
    BRSavedBitFlags: [['Flags', ['u8', null]]],
    LocalEnd: end,
    RemoteEnd: [['GridPersistentIndex', 'u32'], ['ChunkIndex', 'BRSavedChunk3DIndex'], ...end],
    BRSavedWireChunkSoA: [['RemoteWireSources', ['RemoteEnd']], ['LocalWireSources', ['LocalEnd']], ['RemoteWireTargets', ['LocalEnd']], ['LocalWireTargets', ['LocalEnd']], ['PendingPropagationFlags', 'BRSavedBitFlags']],
  });
  files.set(W + 'Bricks/WiresShared.schema', ws);
  const wsS = parseSchema(ws);
  const L = (b: number, t: number, p: number): Record<string, number> => ({ BrickIndexInChunk: b, ComponentTypeIndex: t, PortIndex: p });
  const R = (g: number, c: [number, number, number], b: number, t: number, p: number): Record<string, unknown> => ({ GridPersistentIndex: g, ChunkIndex: { X: c[0], Y: c[1], Z: c[2] }, ...L(b, t, p) });
  files.set(`${W}Bricks/Grids/1/Wires/0_0_0.mps`, encodeMps({ RemoteWireSources: [], LocalWireSources: [L(0, 0, 0)], RemoteWireTargets: [], LocalWireTargets: [L(1, 1, 1)], PendingPropagationFlags: { Flags: [] } }, wsS));
  files.set(`${W}Bricks/Grids/2/Wires/-1_-1_-1.mps`, encodeMps({
    RemoteWireSources: [R(1, [0, 0, 0], 0, 0, 0)], LocalWireSources: [L(0, 3, 3), L(1, 4, 6)],
    RemoteWireTargets: [L(0, 3, 2)], LocalWireTargets: [L(1, 4, 4), L(2, 5, 2)], PendingPropagationFlags: { Flags: [] },
  }, wsS));
  files.set(`${W}Bricks/Grids/1/Wires/1_0_0.mps`, encodeMps({ RemoteWireSources: [R(2, [-1, -1, -1], 2, 5, 3)], LocalWireSources: [], RemoteWireTargets: [L(0, 1, 1)], LocalWireTargets: [], PendingPropagationFlags: { Flags: [] } }, wsS));

  const is = schemaFile({}, {}, { BRSavedChunk3DIndex: XYZ, BRSavedGridChunkIndex: [['Chunk3DIndices', ['BRSavedChunk3DIndex']], ['NumBricks', ['u32']], ['NumComponents', ['u32']], ['NumWires', ['u32']]] });
  files.set(W + 'Bricks/ChunkIndexShared.schema', is);
  const isS = parseSchema(is);
  files.set(`${W}Bricks/Grids/1/ChunkIndex.mps`, encodeMps({ Chunk3DIndices: [{ X: 0, Y: 0, Z: 0 }, { X: 1, Y: 0, Z: 0 }], NumBricks: [3, 1], NumComponents: [3, 1], NumWires: [1, 1] }, isS));
  files.set(`${W}Bricks/Grids/2/ChunkIndex.mps`, encodeMps({ Chunk3DIndices: [{ X: -1, Y: -1, Z: -1 }], NumBricks: [3], NumComponents: [3], NumWires: [3] }, isS));

  const bs = schemaFile({}, {}, { BRSavedBrickChunkSoA: [['OwnerIndices', ['u32']]] });
  files.set(W + 'Bricks/ChunksShared.schema', bs);
  const bsS = parseSchema(bs);
  files.set(`${W}Bricks/Grids/1/Chunks/0_0_0.mps`, encodeMps({ OwnerIndices: [0, 1, 0] }, bsS));
  files.set(`${W}Bricks/Grids/1/Chunks/1_0_0.mps`, encodeMps({ OwnerIndices: [0] }, bsS));
  files.set(`${W}Bricks/Grids/2/Chunks/-1_-1_-1.mps`, encodeMps({ OwnerIndices: [0, 0, 0] }, bsS));

  const es = schemaFile({}, {}, { Counter: [['TypeIndex', 'u32'], ['NumEntities', 'u32']], BRSavedEntityChunkSoA: [['TypeCounters', ['Counter']], ['PersistentIndices', ['u32']]] });
  files.set(W + 'Entities/ChunksShared.schema', es);
  files.set(W + 'Entities/Chunks/0_0_0.mps', encodeMps({ TypeCounters: [{ TypeIndex: 0, NumEntities: 1 }], PersistentIndices: [2] }, parseSchema(es)));
  return files;
}
