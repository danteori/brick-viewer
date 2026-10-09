// A tiny synthetic save for tests that must run without the private reference saves: hand-written
// schemas (the same shapes as the game's, fewer fields), grid 1 chunked at 2048 units.
import { writeBrz } from '../../src/format/brz.ts';
import { arrayHeader, ByteBuf, mapHeader, pack } from '../../src/format/msgpack.ts';
import { encodeMps, parseSchema } from '../../src/format/schema.ts';

type Plain = null | string | number | Plain[] | { [k: string]: Plain };

function enc(o: ByteBuf, v: Plain): void {
  if (v === null || typeof v === 'string' || typeof v === 'number') return pack(o, v);
  if (Array.isArray(v)) { arrayHeader(o, v.length); v.forEach((x) => enc(o, x)); return; }
  const e = Object.entries(v);
  mapHeader(o, e.length);
  for (const [k, x] of e) { pack(o, k); enc(o, x); }
}
const schemaBytes = (structs: Record<string, Record<string, Plain>>): Uint8Array => {
  const o = new ByteBuf();
  enc(o, [{}, structs]);
  return o.done();
};

const GLOBAL = schemaBytes({ BRSavedGlobalData: { BasicBrickAssetNames: ['str'], ProceduralBrickAssetNames: ['str'], MaterialAssetNames: ['str'] } });
const INDEX = schemaBytes({
  Index3: { X: 'i32', Y: 'i32', Z: 'i32' },
  BRSavedBrickChunkIndexSoA: { Chunk3DIndices: ['Index3'], ChunkOffsets: ['Index3'], ChunkSizes: ['u32'], NumBricks: ['u32'], NumComponents: ['u32'], NumWires: ['u32'] },
});
const CHUNK = schemaBytes({
  Counter: { AssetIndex: 'u32', NumSizes: 'u32' },
  Size16: { X: 'u16', Y: 'u16', Z: 'u16' },
  Pos16: { X: 'i16', Y: 'i16', Z: 'i16' },
  Col: { R: 'u8', G: 'u8', B: 'u8', A: 'u8' },
  BRSavedBitFlags: { Flags: ['u8', null] },
  BRSavedBrickChunkSoA: {
    ProceduralBrickStartingIndex: 'u32', BrickSizeCounters: ['Counter'], BrickSizes: ['Size16', null],
    BrickTypeIndices: ['u32'], OwnerIndices: ['u32'], RelativePositions: ['Pos16', null], Orientations: ['u8', null],
    VisibilityFlags: 'BRSavedBitFlags', MaterialIndices: ['u8', null], ColorsAndAlphas: ['Col', null], bColorsAreLinear: 'bool',
  },
});

export interface SynthBrick {
  /** Procedural asset with a size, or a B_* asset with size null. */
  asset: string;
  size: [number, number, number] | null;
  pos: [number, number, number];
  orient?: number;
  color: [number, number, number];
  hidden?: boolean;
}

/** Bricks -> .brz bytes (grid 1). Component / wire counts per chunk can be faked through extra. */
export function synthSave(bricks: SynthBrick[], extra: { components?: Record<string, number>; wires?: Record<string, number> } = {}): Uint8Array {
  const basic = [...new Set(bricks.filter((b) => !b.size).map((b) => b.asset))];
  const proc = [...new Set(bricks.filter((b) => b.size).map((b) => b.asset))];
  const chunks = new Map<string, SynthBrick[]>();
  for (const b of bricks) {
    const k = b.pos.map((v) => Math.floor(v / 2048)).join('_');
    if (!chunks.has(k)) chunks.set(k, []);
    chunks.get(k)!.push(b);
  }
  const cs = parseSchema(CHUNK), is = parseSchema(INDEX), gs = parseSchema(GLOBAL);
  const files = new Map<string, Uint8Array>();
  files.set('World/0/GlobalData.schema', GLOBAL);
  files.set('World/0/GlobalData.mps', encodeMps({ BasicBrickAssetNames: basic, ProceduralBrickAssetNames: proc, MaterialAssetNames: ['BMC_Plastic'] }, gs));
  files.set('World/0/Bricks/ChunkIndexShared.schema', INDEX);
  files.set('World/0/Bricks/ChunksShared.schema', CHUNK);
  const idx = { Chunk3DIndices: [] as object[], ChunkOffsets: [] as object[], ChunkSizes: [] as number[], NumBricks: [] as number[], NumComponents: [] as number[], NumWires: [] as number[] };
  for (const [key, list] of chunks) {
    const [X, Y, Z] = key.split('_').map(Number) as [number, number, number];
    const centre = [X * 2048 + 1024, Y * 2048 + 1024, Z * 2048 + 1024];
    // one size entry per procedural brick (fine for tests), grouped per asset in first-use order
    const byAsset = new Map<string, SynthBrick[]>();
    for (const b of list) if (b.size) { if (!byAsset.has(b.asset)) byAsset.set(b.asset, []); byAsset.get(b.asset)!.push(b); }
    const start = basic.length, typeOf = new Map<SynthBrick, number>(), sizes: object[] = [], counters: object[] = [];
    for (const [a, bs] of byAsset) {
      counters.push({ AssetIndex: proc.indexOf(a), NumSizes: bs.length });
      for (const b of bs) { typeOf.set(b, start + sizes.length); sizes.push({ X: b.size![0], Y: b.size![1], Z: b.size![2] }); }
    }
    const flags = new Array((list.length + 7) >> 3).fill(0);
    list.forEach((b, i) => { if (!b.hidden) flags[i >> 3] |= 1 << (i & 7); });
    const ch = {
      ProceduralBrickStartingIndex: start, BrickSizeCounters: counters, BrickSizes: sizes,
      BrickTypeIndices: list.map((b) => (b.size ? typeOf.get(b)! : basic.indexOf(b.asset))),
      OwnerIndices: list.map(() => 0),
      RelativePositions: list.map((b) => ({ X: b.pos[0] - centre[0]!, Y: b.pos[1] - centre[1]!, Z: b.pos[2] - centre[2]! })),
      Orientations: list.map((b) => b.orient ?? 16),
      VisibilityFlags: { Flags: flags },
      MaterialIndices: list.map(() => 0),
      ColorsAndAlphas: list.map((b) => ({ R: b.color[0], G: b.color[1], B: b.color[2], A: 5 })),
      bColorsAreLinear: false,
    };
    files.set(`World/0/Bricks/Grids/1/Chunks/${key}.mps`, encodeMps(ch, cs));
    idx.Chunk3DIndices.push({ X, Y, Z }); idx.ChunkOffsets.push({ X: 0, Y: 0, Z: 0 }); idx.ChunkSizes.push(2048);
    idx.NumBricks.push(list.length); idx.NumComponents.push(extra.components?.[key] ?? 0); idx.NumWires.push(extra.wires?.[key] ?? 0);
  }
  files.set('World/0/Bricks/Grids/1/ChunkIndex.mps', encodeMps(idx, is));
  return writeBrz(files);
}
