// .brdb reader / writers on synthetic worlds (runs everywhere, no private files needed).
import { beforeAll, describe, expect, it } from 'vitest';
import { appendRevision, BRDB_CREATE, BrdbWorld, isSqlite, writeNewWorld } from '../../src/format/brdb.ts';
import { bytesEqual, readBrz, writeBrz, type FileMap } from '../../src/format/brz.ts';
import { ByteBuf, arrayHeader, mapHeader, pack, utf8 } from '../../src/format/msgpack.ts';
import { decodeWritten, fileMapView } from '../../src/format/saveview.ts';
import { decodeMps, encodeMps, parseSchema } from '../../src/format/schema.ts';
import type { SqlBackend } from '../../src/format/sql.ts';
import { flattenTree, linearToSrgbByte, StaleSchemaError } from '../../src/format/stale.ts';
import { buildWorldModel, gridBricks, gridMatrix, localToWorld, rotate } from '../../src/scene/grids.ts';
import { digest, hasPython, nodeSql, pyDump, tempDir } from './brdb-helpers.ts';

// ---- a tiny MessagePack writer for hand-made schemas: arrays, {map: pairs}, strings, numbers, nil
type Mp = null | string | number | Mp[] | { map: [Mp, Mp][] };
function mp(v: Mp, o = new ByteBuf()): ByteBuf {
  if (v === null || typeof v === 'string' || typeof v === 'number') pack(o, v);
  else if (Array.isArray(v)) { arrayHeader(o, v.length); v.forEach((x) => mp(x, o)); }
  else { mapHeader(o, v.map.length); for (const [k, x] of v.map) { mp(k, o); mp(x, o); } }
  return o;
}
const structs = (s: [string, [string, Mp][]][]): Mp => ({ map: s.map(([n, f]) => [n, { map: f }]) });
const schema3 = (s: [string, [string, Mp][]][]): Uint8Array => mp([{ map: [] }, { map: [] }, structs(s)]).done();
const schema2 = (s: [string, [string, Mp][]][]): Uint8Array => mp([{ map: [] }, structs(s)]).done();

const GLOBAL = schema3([['BRSavedGlobalData', [['BasicBrickAssetNames', ['str']], ['ProceduralBrickAssetNames', ['str']], ['MaterialAssetNames', ['str']]]]]);
const COMMON: [string, [string, Mp][]][] = [
  ['BRSavedBitFlags', [['Flags', ['u8', null]]]],
  ['BRSavedBrickColor', [['R', 'u8'], ['G', 'u8'], ['B', 'u8'], ['A', 'u8']]],
  ['BRSavedBrickSize', [['X', 'u16'], ['Y', 'u16'], ['Z', 'u16']]],
  ['BRSavedBrickSizeCounter', [['AssetIndex', 'u32'], ['NumSizes', 'u32']]],
  ['BRSavedRelativeBrickPosition', [['X', 'i16'], ['Y', 'i16'], ['Z', 'i16']]],
];
// An older brick chunk layout (as 2025 saves) and the current one.
const OLD_FIELDS: [string, Mp][] = [
  ['ProceduralBrickStartingIndex', 'u32'], ['BrickSizeCounters', ['BRSavedBrickSizeCounter']], ['BrickSizes', ['BRSavedBrickSize']],
  ['BrickTypeIndices', ['u32']], ['OwnerIndices', ['u32']], ['RelativePositions', ['BRSavedRelativeBrickPosition', null]], ['Orientations', ['u8', null]],
  ['CollisionFlags_Player', 'BRSavedBitFlags'], ['CollisionFlags_Tool', 'BRSavedBitFlags'], ['VisibilityFlags', 'BRSavedBitFlags'],
  ['MaterialIndices', ['u8', null]], ['ColorsAndAlphas', ['BRSavedBrickColor', null]]];
const OLD_CHUNKS = schema2([...COMMON, ['BRSavedBrickChunkSoA', OLD_FIELDS]]);
const NEW_CHUNKS = schema3([...COMMON, ['BRSavedBrickChunkSoA', [
  ['ProceduralBrickStartingIndex', 'u32'], ['BrickSizeCounters', ['BRSavedBrickSizeCounter']], ['BrickSizes', ['BRSavedBrickSize']],
  ['BrickTypeIndices', ['u32']], ['OwnerIndices', ['u32']], ['OriginalOwnerIndices', ['u32']], ['RelativePositions', ['BRSavedRelativeBrickPosition', null]],
  ['Orientations', ['u8', null]], ['CollisionFlags_Player', 'BRSavedBitFlags'], ['CollisionFlags_Player1', 'BRSavedBitFlags'], ['VisibilityFlags', 'BRSavedBitFlags'],
  ['MaterialIndices', ['u8', null]], ['ColorsAndAlphas', ['BRSavedBrickColor', null]], ['bColorsAreLinear', 'bool']]]]);
const INDEX = schema3([
  ['BRSavedChunk3DIndex', [['X', 'i16'], ['Y', 'i16'], ['Z', 'i16']]], ['IntVector', [['X', 'i32'], ['Y', 'i32'], ['Z', 'i32']]],
  ['BRSavedBrickChunkIndexSoA', [['Chunk3DIndices', ['BRSavedChunk3DIndex']], ['ChunkOffsets', ['IntVector']], ['ChunkSizes', ['i32']],
    ['NumBricks', ['u32']], ['NumComponents', ['u32']], ['NumWires', ['u32']]]]]);
const ENTITY_INDEX = schema3([['BRSavedChunk3DIndex', [['X', 'i16'], ['Y', 'i16'], ['Z', 'i16']]],
  ['BRSavedEntityChunkIndexSoA', [['NextPersistentIndex', 'u32'], ['Chunk3DIndices', ['BRSavedChunk3DIndex']], ['NumEntities', ['u32']]]]]);
const ENTITIES = schema3([
  ['BrickGridDynamicActor', []], ['BRSavedBitFlags', [['Flags', ['u8', null]]]],
  ['BRSavedEntityTypeCounter', [['TypeIndex', 'u32'], ['NumEntities', 'u32']]],
  ['Quat4f', [['X', 'f32'], ['Y', 'f32'], ['Z', 'f32'], ['W', 'f32']]], ['Vector3f', [['X', 'f32'], ['Y', 'f32'], ['Z', 'f32']]],
  ['BRSavedEntityChunkSoA', [['TypeCounters', ['BRSavedEntityTypeCounter']], ['PersistentIndices', ['u32']], ['OwnerIndices', ['u32']],
    ['Locations', ['Vector3f', null]], ['Rotations', ['Quat4f', null]], ['PhysicsLockedFlags', 'BRSavedBitFlags'], ['PhysicsSleepingFlags', 'BRSavedBitFlags']]]]);
const GLOBAL_E = schema3([['BRSavedGlobalData', [['BasicBrickAssetNames', ['str']], ['ProceduralBrickAssetNames', ['str']], ['MaterialAssetNames', ['str']],
  ['EntityTypeNames', ['str']], ['EntityDataClassNames', ['str']]]]]);

const enc = (schema: Uint8Array, v: unknown): Uint8Array => encodeMps(v, parseSchema(schema));
const W = 'World/0/';

/** One brick chunk (old layout): a fixed B_1x1 and a procedural brick, colours stored linear. */
function oldWorld(): FileMap {
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

let sql: SqlBackend;
beforeAll(async () => { sql = await nodeSql(); });

describe('writeNewWorld', () => {
  it('writes the game CREATE statements verbatim, two revisions, one row per file, shared blobs', () => {
    const files = oldWorld(), bytes = writeNewWorld(sql, files, { when: 1000 });
    expect(isSqlite(bytes)).toBe(true);
    const db = sql.open(bytes);
    expect(db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").map((r) => r[0])).toEqual([...BRDB_CREATE]);
    expect(db.query('PRAGMA page_size')[0]![0]).toBe(4096);
    expect(db.query('PRAGMA user_version')[0]![0]).toBe(0);
    expect(db.query('SELECT COUNT(*) FROM blobs')[0]![0]).toBe(files.size - 1);
    expect(db.query('SELECT COUNT(*) FROM files')[0]![0]).toBe(files.size);
    db.close();
    const w = BrdbWorld.open(sql, bytes, { verify: true });
    expect(w.revisions).toEqual([{ id: 1, description: 'Initial Revision', createdAt: 1000 }, { id: 2, description: 'Manual Save', createdAt: 1000 }]);
    const tree = w.tree().files();
    expect([...tree.keys()]).toEqual([...files.keys()]);
    for (const [p, b] of files) expect(bytesEqual(tree.get(p)!, b), p).toBe(true);
    expect(w.tree(1).paths()).toEqual(w.tree().paths());
    w.close();
  });

  it('compresses blobs only when the encoder makes them smaller', () => {
    const fakeZ = (b: Uint8Array): Uint8Array => (b.length > 40 ? b.slice(0, 8) : new Uint8Array(b.length + 4));
    const bytes = writeNewWorld(sql, oldWorld(), { when: 5, zstd: fakeZ });
    const db = sql.open(bytes);
    for (const [c, us, cs] of db.query('SELECT compression, size_uncompressed, size_compressed FROM blobs')) {
      expect(c).toBe((us as number) > 40 ? 1 : 0);
      expect(cs).toBe((us as number) > 40 ? 8 : us);
    }
    db.close();
  });

  it.skipIf(!hasPython)('reads back identically with Python sqlite3', () => {
    const files = oldWorld(), t = tempDir();
    try {
      const py = pyDump(t.file('new.brdb', writeNewWorld(sql, files, { when: 1234 })), { rows: true });
      expect(py.live).toEqual(digest(files));
      expect(py.revisions).toEqual([[1, 'Initial Revision', 1234], [2, 'Manual Save', 1234]]);
      expect(py.master.filter((m) => m[3]).map((m) => m[3])).toEqual([...BRDB_CREATE]);
      expect(py.pragmas.page_size).toBe(4096);
      expect(py.pragmas.encoding).toBe('UTF-8');
    } finally {
      t.done();
    }
  });
});

describe('appendRevision', () => {
  it('adds a revision, marks replaced rows deleted, inserts only changed files, reuses blobs', () => {
    const v1 = writeNewWorld(sql, oldWorld(), { when: 1000 }), w1 = BrdbWorld.open(sql, v1);
    const next = new Map(w1.tree().files());
    next.set('Meta/World.json', utf8('{"environment": "Space"}'));
    next.delete('Meta/Copy.json');
    next.set('Meta/Again.json', utf8('{"environment": "Plate"}'));   // content already stored
    expect(() => appendRevision(w1, next, { when: 1000 })).toThrow(/after the latest/);
    const r = appendRevision(w1, next, { when: 2000 });
    expect(r.revision).toEqual({ id: 3, description: 'Manual Save', createdAt: 2000 });
    expect(r.written.sort()).toEqual(['Meta/Again.json', 'Meta/World.json']);
    expect(r.deleted).toEqual(['Meta/Copy.json']);
    const w2 = BrdbWorld.open(sql, r.bytes, { verify: true });
    expect(w2.revisions.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(w2.blobs.size).toBe(w1.blobs.size + 1);   // only the new World.json
    expect(digest(w2.tree().files())).toEqual(digest(next));
    expect(digest(w2.tree(2).files())).toEqual(digest(oldWorld()));
    expect(w2.diff(2, 3)).toEqual({ added: ['Meta/Again.json'], removed: ['Meta/Copy.json'], changed: ['Meta/World.json'] });
    expect(w2.revisionStats().map((s) => [s.revision.id, s.written, s.deleted])).toEqual([[1, 6, 0], [2, 6, 0], [3, 2, 2]]);
    expect(w2.history('Meta/World.json').map((x) => [x.createdAt, x.deletedAt])).toEqual([[1000, 2000], [2000, null]]);
    // folders are reused, not duplicated
    expect(w2.folders.size).toBe(w1.folders.size);
    w1.close(); w2.close();
  });

  it.skipIf(!hasPython)('Python sees every revision the same way', () => {
    const w1 = BrdbWorld.open(sql, writeNewWorld(sql, oldWorld(), { when: 10 }));
    const next = new Map(w1.tree().files());
    next.set('Meta/World.json', utf8('changed'));
    const bytes = appendRevision(w1, next, { when: 20 }).bytes, w2 = BrdbWorld.open(sql, bytes), t = tempDir();
    try {
      const py = pyDump(t.file('a.brdb', bytes), { at: [1, 2, 3] });
      expect(py.stats).toEqual(w2.revisionStats().map((s) => [s.revision.id, s.written, s.deleted]));
      for (const r of [1, 2, 3]) expect(py.at[String(r)]).toEqual(digest(w2.tree(r).files()));
      expect(py.live).toEqual(digest(w2.tree().files()));
    } finally {
      t.done(); w1.close(); w2.close();
    }
  });
});

describe('stale-schema chunks', () => {
  /** A world whose brick chunk was written before the chunk schema (and GlobalData) changed. */
  function staleWorld(): BrdbWorld {
    const w1 = BrdbWorld.open(sql, writeNewWorld(sql, oldWorld(), { when: 1000 }));
    const next = new Map(w1.tree().files());
    next.set(W + 'Bricks/ChunksShared.schema', NEW_CHUNKS);
    next.set(W + 'GlobalData.mps', enc(GLOBAL, { BasicBrickAssetNames: ['B_1x1', 'B_2x2'], ProceduralBrickAssetNames: ['PB_DefaultBrick', 'PB_DefaultTile'], MaterialAssetNames: ['BMC_Plastic'] }));
    const r = appendRevision(w1, next, { when: 2000, reencodeStale: false });   // what the game does: keep the old bytes
    w1.close();
    return BrdbWorld.open(sql, r.bytes);
  }
  const CHUNK = W + 'Bricks/Grids/1/Chunks/0_0_0.mps';

  it('decodes a stale chunk with the schema live when it was written', () => {
    const w = staleWorld(), tree = w.tree();
    expect(tree.isStale(W + 'Bricks/ChunksShared.schema', CHUNK)).toBe(true);
    const f = decodeWritten(tree, CHUNK);
    expect(f.root.CollisionFlags_Tool).toEqual({ Flags: [1] });
    expect(f.root.OriginalOwnerIndices).toBeUndefined();
    // the flat .brz view pairs it with the new schema, which is exactly the bug flattening avoids
    expect(() => decodeWritten(fileMapView(tree.files()), CHUNK)).toThrow();
    w.close();
  });

  it('flattening re-encodes it to the live schema, with documented defaults only', () => {
    const w = staleWorld(), flat = flattenTree(w.tree());
    expect(flat.reencoded).toEqual([CHUNK]);
    expect(flat.warnings).toEqual(['dropped BRSavedBrickChunkSoA.CollisionFlags_Tool (not in the current schema)']);
    const v = decodeMps(flat.files.get(CHUNK)!, parseSchema(NEW_CHUNKS));
    expect(v.OriginalOwnerIndices).toEqual([0, 0]);
    expect(v.CollisionFlags_Player1).toEqual({ Flags: [3] });
    expect(v.bColorsAreLinear).toBe(false);
    expect(v.ColorsAndAlphas).toEqual([{ R: 0, G: linearToSrgbByte(50), B: 255, A: 5 }, { R: linearToSrgbByte(1), G: linearToSrgbByte(2), B: linearToSrgbByte(128), A: 10 }]);
    // GlobalData's basic list grew by one: procedural type indices move up with it
    expect(v.ProceduralBrickStartingIndex).toBe(2);
    expect(v.BrickTypeIndices).toEqual([0, 2]);
    // ... and the flat tree is self-consistent: it round-trips through a .brz and a new world
    const back = BrdbWorld.open(sql, writeNewWorld(sql, readBrz(writeBrz(flat.files)), { when: 3000 }));
    expect(back.tree().isStale(W + 'Bricks/ChunksShared.schema', CHUNK)).toBe(false);
    expect(decodeWritten(back.tree(), CHUNK).root.BrickTypeIndices).toEqual([0, 2]);
    back.close(); w.close();
  });

  it("keeps the colour bytes and flags them linear with {colours: 'flag'}", () => {
    const w = staleWorld(), flat = flattenTree(w.tree(), { colours: 'flag' });
    const v = decodeMps(flat.files.get(CHUNK)!, parseSchema(NEW_CHUNKS));
    expect(v.bColorsAreLinear).toBe(true);
    expect((v.ColorsAndAlphas as unknown[])[0]).toEqual({ R: 0, G: 50, B: 255, A: 5 });
    w.close();
  });

  it('appendRevision re-encodes unchanged stale chunks by default', () => {
    const w = staleWorld(), r = appendRevision(w, w.tree().files(), { when: 3000 });
    expect(r.reencoded).toEqual([CHUNK]);
    expect(r.written).toEqual([CHUNK]);
    const w2 = BrdbWorld.open(sql, r.bytes);
    expect(w2.tree().isStale(W + 'Bricks/ChunksShared.schema', CHUNK)).toBe(false);
    w.close(); w2.close();
  });

  it('refuses to guess a new field it has no default for, and a GlobalData list that was reordered', () => {
    const w1 = BrdbWorld.open(sql, writeNewWorld(sql, oldWorld(), { when: 1000 }));
    const odd = schema3([...COMMON, ['BRSavedBrickChunkSoA', [...OLD_FIELDS, ['Mystery', 'u32']]]]);
    const next = new Map(w1.tree().files());
    next.set(W + 'Bricks/ChunksShared.schema', odd);
    const stale = BrdbWorld.open(sql, appendRevision(w1, next, { when: 2000, reencodeStale: false }).bytes);
    expect(() => flattenTree(stale.tree())).toThrow(StaleSchemaError);
    expect(() => flattenTree(stale.tree())).toThrow(/Mystery is new/);
    const next2 = new Map(w1.tree().files());
    next2.set(W + 'GlobalData.mps', enc(GLOBAL, { BasicBrickAssetNames: ['B_2x2', 'B_1x1'], ProceduralBrickAssetNames: ['PB_DefaultBrick'], MaterialAssetNames: ['BMC_Plastic'] }));
    expect(() => appendRevision(w1, next2, { when: 2000 })).toThrow(/BasicBrickAssetNames changed/);
    w1.close(); stale.close();
  });
});

describe('dynamic grids', () => {
  function gridWorld(): FileMap {
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

  it('maps Grids/<N> to entity N and places its bricks in world space', () => {
    const view = fileMapView(gridWorld()), m = buildWorldModel(view);
    expect(m.grids.map((g) => [g.id, g.kind])).toEqual([[1, 'global'], [7, 'dynamic'], [9, 'orphan']]);
    expect(m.entities.nextPersistentIndex).toBe(10);
    const g7 = m.grids[1]!;
    expect(g7.entity?.type).toBe('Entity_DynamicBrickGrid');
    expect(g7.entity?.physicsLocked).toBe(true);
    expect(g7.entity?.colorsAreLinear).toBeNull();
    expect(g7.transform.pos).toEqual([100, -50, 25]);
    expect(g7.chunks[0]!.centre).toEqual([0, 0, 0]);
    expect(m.grids[2]!.missingChunks).toBe(1);
    expect(m.warnings).toContain('grid 9 has no entity and no chunk files');
    const b = gridBricks(view, g7);
    // local = centre (0) + relative; the entity turns +90 degrees about Z (Math.fround'ed): (x, y) -> (-y, x)
    expect(b[1]!.pos).toEqual([10, 0, 6]);
    expect(b[1]!.world.map((x) => Math.round(x * 1e4) / 1e4)).toEqual([100, -40, 31]);
    const g1 = gridBricks(view, m.grids[0]!);
    expect(g1[0]!.pos).toEqual([5, 5, 6]);
    expect(g1[0]!.world).toEqual([5, 5, 6]);
  });

  it('rotate / localToWorld / gridMatrix agree', () => {
    const t = { pos: [1, 2, 3] as [number, number, number], quat: [0.1, -0.3, 0.2, 0.927] as [number, number, number, number] };
    const n = Math.hypot(...t.quat);
    t.quat = t.quat.map((x) => x / n) as typeof t.quat;
    const m = gridMatrix(t), p: [number, number, number] = [7, -4, 9], w = localToWorld(t, p);
    const viaM = [0, 1, 2].map((r) => m[r]! * p[0] + m[4 + r]! * p[1] + m[8 + r]! * p[2] + m[12 + r]!);
    viaM.forEach((x, i) => expect(x).toBeCloseTo(w[i]!, 9));
    expect(Math.hypot(...rotate(t.quat, p))).toBeCloseTo(Math.hypot(...p), 9);
  });
});
