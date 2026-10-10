// Writing entities back (W-03 / W-04): a dynamic grid's new transform, new dynamic grids made in
// the viewer, and grids that were deleted. Works on a flat save file tree (a .brz, or a world
// flattened to its live schemas) and changes only what it must:
//
//   World/0/Entities/Chunks/X_Y_Z.mps     moved: Locations / Rotations of those entities
//                                         added: one row in every per-entity column, in its type
//                                         counter's run, plus its data struct; removed: the row out
//   World/0/Entities/ChunkIndex.mps       NumEntities per chunk, NextPersistentIndex
//   World/0/Entities/ChunksShared.schema  gains the BrickGridDynamicActor struct (and its enum) when
//                                         the save has none yet (the game writes data structs only
//                                         for the classes a save uses)
//   World/0/GlobalData.mps                EntityTypeNames / EntityDataClassNames gain the grid type
//   World/0/Owners.mps                    EntityCounts follow the added / removed entities
//
// The layout of a new grid's row is what the game writes for a parked grid (studied on game-written
// worlds of the public release): every entity in chunk 0_0_0, PrefabSpawnInstanceIndices 0,
// owner and original owner the same, velocities 0, all eight colour slots 255, life span 0, and
// PhysicsLockedFlags set (frozen) so it stays where it was put. Columns this writer doesn't know get
// the zero value of their schema type, so newer layouts still write.

import type { FileMap } from './brz.ts';
import { ByteBuf, MsgMap, MsgReader, arrayHeader, mapHeader, pack, type MsgValue, type Packable } from './msgpack.ts';
import { decodeMps, decodeSoa, encodeMps, encodeSoa, parseSchema, type MpsObject, type Schema, type SchemaType, type SoaFile } from './schema.ts';
import type { Quat, Vec3 } from './entities.ts';

const W = 'World/0/';
export const ENTITY_SCHEMA = W + 'Entities/ChunksShared.schema';
export const ENTITY_INDEX = W + 'Entities/ChunkIndex.mps';
export const ENTITY_INDEX_SCHEMA = W + 'Entities/ChunkIndex.schema';
const ENTITY_CHUNK = /^World\/0\/Entities\/Chunks\/(-?\d+)_(-?\d+)_(-?\d+)\.mps$/;
export const GRID_TYPE = 'Entity_DynamicBrickGrid';
export const GRID_CLASS = 'BrickGridDynamicActor';

export interface NewGridEntity {
  persistentIndex: number;
  location: Vec3;
  rotation: Quat;
  owner: number;
  /** PhysicsLockedFlags (frozen); default true */
  locked?: boolean;
  /** the BrickGridDynamicActor settings; missing fields get the defaults (gridDefaults) */
  data?: MpsObject | null;
}

export interface EntityEdit {
  /** new transforms, by persistent index */
  moved?: ReadonlyMap<number, { location: Vec3; rotation: Quat }>;
  /** entities to take out, by persistent index */
  removed?: ReadonlySet<number>;
  /** new dynamic grid entities */
  added?: readonly NewGridEntity[];
}

// --- schema bytes ------------------------------------------------------------------------------------

/** Packs a decoded MessagePack tree (MsgMap = map) with the same encoding choices as the reader's input. */
export function packValue(o: ByteBuf, v: MsgValue): void {
  if (v instanceof MsgMap) { mapHeader(o, v.length); for (const [k, x] of v) { packValue(o, k); packValue(o, x); } return; }
  if (Array.isArray(v)) { arrayHeader(o, v.length); for (const x of v) packValue(o, x); return; }
  pack(o, v as Packable);
}

const pairs = (...p: [MsgValue, MsgValue][]): MsgMap => { const m = new MsgMap(); m.push(...p); return m; };

/** The newest BrickGridDynamicActor layout seen (CL15729-era public worlds), and its enum. */
const GRID_STRUCT_FULL: [string, string][] = [
  ['BouyancyScale', 'f32'], ['MassScale', 'f32'], ['bEnableGravity', 'bool'], ['bUseNewMassCalculation', 'bool'], ['bReceivesDecals', 'bool'],
  ['CollisionQuality', 'EBRGridCollisionQuality'], ['EntityTag', 'str'], ['GameModeTeamName', 'str'], ['bDetectableByAnyone', 'bool'],
];
const QUALITY_ENUM = 'EBRGridCollisionQuality';
const QUALITY_TABLE = (): MsgMap => pairs([`${QUALITY_ENUM}::Coarse`, 0], [`${QUALITY_ENUM}::Fine`, 1], [`${QUALITY_ENUM}::${QUALITY_ENUM}_MAX`, 2]);

/** The settings a new grid gets where the save has no grid to copy them from (the values every parked grid seen carries). */
export function gridDefaults(): MpsObject {
  return { BouyancyScale: 0.2, MassScale: 1, bEnableGravity: true, bUseNewMassCalculation: true, bReceivesDecals: true, CollisionQuality: 0, EntityTag: '', GameModeTeamName: '', bDetectableByAnyone: false };
}

/**
 * The entity schema with a BrickGridDynamicActor struct added (before the SoA helper structs, as the
 * game orders them), or the same bytes when it has one. `full`: the current field list (saves from
 * CL14860 on, which carry GlobalGridEntityTypeIndex); else the empty struct of early-2025 saves.
 */
export function withGridStruct(bytes: Uint8Array, full: boolean): Uint8Array {
  const s = parseSchema(bytes);
  if (s.S.has(GRID_CLASS)) return bytes;
  const top = new MsgReader(bytes).next() as MsgValue[];
  const enums = top[0] as MsgMap, structs = top[top.length - 1] as MsgMap;
  const fields = full ? GRID_STRUCT_FULL : [];
  const entry: [MsgValue, MsgValue] = [GRID_CLASS, pairs(...fields)];
  let at = structs.findIndex(([n]) => typeof n === 'string' && (n.startsWith('BRSaved') || n === 'Quat4f' || n === 'Vector3f'));
  if (at < 0) at = structs.length;
  structs.splice(at, 0, entry);
  if (full && !s.E.has(QUALITY_ENUM)) {
    let e = enums.findIndex(([n]) => String(n) > QUALITY_ENUM);
    if (e < 0) e = enums.length;
    enums.splice(e, 0, [QUALITY_ENUM, QUALITY_TABLE()]);
  }
  const o = new ByteBuf();
  packValue(o, top);
  return o.done();
}

// --- values ------------------------------------------------------------------------------------------

/** The zero value of a schema type (a column of a new row the writer has no rule for). */
export function zeroOf(schema: Schema, t: SchemaType): unknown {
  if (typeof t !== 'string') {
    if (t.kind === 'array' || t.kind === 'packed') return [];
    if (t.kind === 'fixed') return Array.from({ length: t.n }, () => zeroOf(schema, t.of));
    return new Map();
  }
  if (t === 'bool') return false;
  if (t === 'str') return '';
  if (/^[iuf](8|16|32|64)$/.test(t)) return 0;
  const fields = schema.S.get(t);
  if (fields) { const o: MpsObject = {}; for (const [f, ft] of fields) o[f] = zeroOf(schema, ft); return o; }
  return 0;                                       // enums, asset refs
}

/** The element type of a root column (array / packed), or null. */
const elementOf = (schema: Schema, field: string): SchemaType | null => {
  const t = schema.S.get(schema.root)?.find(([f]) => f === field)?.[1];
  return t && typeof t !== 'string' && (t.kind === 'array' || t.kind === 'packed') ? t.of : null;
};

const xyz = (v: readonly number[]): MpsObject => ({ X: v[0], Y: v[1], Z: v[2] });
const xyzw = (q: readonly number[]): MpsObject => ({ X: q[0], Y: q[1], Z: q[2], W: q[3] });

/** A new grid's value for root column `field` (element type t). */
function newValue(schema: Schema, field: string, t: SchemaType, e: NewGridEntity): unknown {
  switch (field) {
    case 'PersistentIndices': return e.persistentIndex;
    case 'PrefabSpawnInstanceIndices': return 0;
    case 'OwnerIndices': case 'OriginalOwnerIndices': return e.owner;
    case 'Locations': return xyz(e.location);
    case 'Rotations': return xyzw(e.rotation);
    case 'LinearVelocities': case 'AngularVelocities': return xyz([0, 0, 0]);
    case 'RemainingLifeSpans': return 0;
    case 'ColorsAndAlphas': {
      const z = zeroOf(schema, t) as MpsObject;
      for (const k of Object.keys(z)) z[k] = { R: 255, G: 255, B: 255, A: 255 };
      return z;
    }
    default: return zeroOf(schema, t);
  }
}

// --- bit flags ---------------------------------------------------------------------------------------

const getBit = (f: number[], i: number): number => ((f[i >> 3] ?? 0) >> (i & 7)) & 1;
function bitsOf(f: number[], n: number): number[] { return Array.from({ length: n }, (_, i) => getBit(f, i)); }
function packBits(bits: number[], target: number[]): void {
  const out = new Array<number>((bits.length + 7) >> 3).fill(0);
  bits.forEach((b, i) => { if (b) out[i >> 3]! |= 1 << (i & 7); });
  target.splice(0, target.length, ...out);
}
const isFlags = (v: unknown): v is { Flags: number[] } => !!v && typeof v === 'object' && Array.isArray((v as { Flags?: unknown }).Flags) && Object.keys(v).length === 1;

// --- one chunk ---------------------------------------------------------------------------------------

/** The per-entity columns of a chunk root: arrays as long as the entity count, and bit flag fields. */
function columns(root: MpsObject, n: number): { arrays: string[]; flags: string[] } {
  const arrays: string[] = [], flags: string[] = [];
  for (const [k, v] of Object.entries(root)) {
    if (k === 'TypeCounters') continue;
    if (Array.isArray(v) && v.length === n) arrays.push(k);
    else if (isFlags(v)) flags.push(k);
  }
  return { arrays, flags };
}

function removeRows(file: SoaFile, gone: (i: number) => boolean): number {
  const root = file.root, ids = (root.PersistentIndices as number[] | undefined) ?? [], n = ids.length;
  const drop = ids.map((_, i) => gone(i));
  const k = drop.filter(Boolean).length;
  if (!k) return 0;
  const { arrays, flags } = columns(root, n);
  for (const f of arrays) { const a = root[f] as unknown[]; for (let i = n - 1; i >= 0; i--) if (drop[i]) a.splice(i, 1); }
  for (const f of flags) {
    const fl = (root[f] as { Flags: number[] }).Flags;
    if (!fl.length) continue;                       // never written (e.g. WeldParentFlags): stays empty
    packBits(bitsOf(fl, n).filter((_, i) => !drop[i]), fl);
  }
  for (let i = n - 1; i >= 0; i--) if (drop[i]) file.data.splice(i, 1);
  const counters = root.TypeCounters as { TypeIndex: number; NumEntities: number }[];
  let at = 0;
  for (const c of counters) { let m = 0; for (let j = 0; j < c.NumEntities; j++) if (drop[at + j]) m++; at += c.NumEntities; c.NumEntities -= m; }
  root.TypeCounters = counters.filter((c) => c.NumEntities > 0);
  return k;
}

function insertRow(file: SoaFile, schema: Schema, typeIndex: number, struct: string | null, data: MpsObject | null, e: NewGridEntity): void {
  const root = file.root, n = ((root.PersistentIndices as number[] | undefined) ?? []).length;
  const counters = (root.TypeCounters as { TypeIndex: number; NumEntities: number }[] | undefined) ?? (root.TypeCounters = []) as { TypeIndex: number; NumEntities: number }[];
  // the row goes at the end of its type's run; a new run goes in type-index order
  let at = 0, c = counters.find((x) => x.TypeIndex === typeIndex);
  if (c) { for (const x of counters) { at += x.NumEntities; if (x === c) break; } }
  else {
    const j = counters.findIndex((x) => x.TypeIndex > typeIndex);
    c = { TypeIndex: typeIndex, NumEntities: 0 };
    if (j < 0) { counters.push(c); at = n; } else { counters.splice(j, 0, c); for (let q = 0; q < j; q++) at += counters[q]!.NumEntities; }
  }
  const { arrays, flags } = columns(root, n);
  for (const [f, t] of schema.S.get(schema.root) ?? []) {
    if (f === 'TypeCounters') continue;
    const el = elementOf(schema, f);
    if (el && (arrays.includes(f) || n === 0)) {
      if (!Array.isArray(root[f])) root[f] = [];
      (root[f] as unknown[]).splice(at, 0, newValue(schema, f, el, e));
    } else if (typeof t === 'string' && (flags.includes(f) || (n === 0 && isFlags(root[f])))) {
      const fl = (root[f] as { Flags: number[] }).Flags, bit = f === 'PhysicsLockedFlags' ? (e.locked === false ? 0 : 1) : 0;
      if (!fl.length && !bit && n > 0) continue;     // a column the game leaves empty stays empty
      const bits = bitsOf(fl, n);
      bits.splice(at, 0, bit);
      packBits(bits, fl);
    }
  }
  c.NumEntities++;
  file.data.splice(at, 0, { typeIndex, struct, value: data });
}

/** A fresh entity chunk root for `schema` (every column empty, bit flags {Flags: []}). */
function emptyChunk(schema: Schema): SoaFile {
  const root: MpsObject = {};
  for (const [f, t] of schema.S.get(schema.root) ?? []) root[f] = zeroOf(schema, t);
  return { root, data: [] };
}

// --- the whole edit ----------------------------------------------------------------------------------

interface GlobalNames extends MpsObject { EntityTypeNames?: string[]; EntityDataClassNames?: string[]; GlobalGridEntityTypeIndex?: number }

/** Can this save take new dynamic grids? Null when it can, else why not. */
export function entityLayoutProblem(files: ReadonlyMap<string, Uint8Array>): string | null {
  if (!files.has(ENTITY_SCHEMA) || !files.has(ENTITY_INDEX_SCHEMA)) return 'this save has no entity layout (it is too old, or not a world or a recent save)';
  const gs = files.get(W + 'GlobalData.schema');
  if (!gs) return 'this save has no GlobalData';
  const g = parseSchema(gs), fields = g.S.get(g.root)?.map(([f]) => f) ?? [];
  if (!fields.includes('EntityTypeNames')) return "this save's GlobalData has no entity type list (too old a layout)";
  return null;
}

/**
 * The save with the entity edit applied: a new file map (untouched files shared) and notes. Throws
 * when the save can't hold the edit (no entity layout, an entity named that isn't there).
 */
export function editEntities(files: FileMap, edit: EntityEdit): { files: FileMap; warnings: string[] } {
  const moved = edit.moved ?? new Map(), removed = edit.removed ?? new Set<number>(), added = edit.added ?? [];
  const warnings: string[] = [];
  if (!moved.size && !removed.size && !added.length) return { files, warnings };
  const out: FileMap = new Map(files);
  const gsBytes = out.get(W + 'GlobalData.schema'), gmBytes = out.get(W + 'GlobalData.mps');
  if (!gsBytes || !gmBytes) throw new Error('no GlobalData');
  const gSchema = parseSchema(gsBytes), global = decodeMps<GlobalNames>(gmBytes, gSchema);
  let typeIndex = -1, struct: string | null = null, eSchemaBytes = out.get(ENTITY_SCHEMA);
  if (added.length) {
    const why = entityLayoutProblem(out);
    if (why) throw new Error(why);
    const types = (global.EntityTypeNames ??= []), classes = global.EntityDataClassNames;
    typeIndex = types.indexOf(GRID_TYPE);
    if (typeIndex < 0) {
      typeIndex = types.length; types.push(GRID_TYPE);
      if (classes) classes.push(GRID_CLASS);
      out.set(W + 'GlobalData.mps', encodeMps(global, gSchema));
    }
    if (classes && classes[typeIndex] !== GRID_CLASS) throw new Error(`entity type ${GRID_TYPE} has data class ${classes[typeIndex]}`);
    const full = (gSchema.S.get(gSchema.root) ?? []).some(([f]) => f === 'GlobalGridEntityTypeIndex');
    eSchemaBytes = withGridStruct(eSchemaBytes!, full);
    out.set(ENTITY_SCHEMA, eSchemaBytes);
    struct = classes ? GRID_CLASS : null;
  }
  if (!eSchemaBytes) throw new Error('no entity schema');
  const eSchema = parseSchema(eSchemaBytes);
  if (struct && !eSchema.S.has(struct)) struct = null;
  const names = { EntityTypeNames: global.EntityTypeNames ?? [], ...(global.EntityDataClassNames && { EntityDataClassNames: global.EntityDataClassNames }) };

  // the chunks, decoded
  const chunks = new Map<string, SoaFile>();
  for (const [p, b] of out) if (ENTITY_CHUNK.test(p)) chunks.set(p, decodeSoa(b, eSchema, names));
  const ownerDelta = new Map<number, number>(), touched = new Set<string>();
  let template: MpsObject | null = null;           // a parked grid's settings to copy for new ones
  const found = new Set<number>();
  for (const [p, f] of chunks) {
    const ids = (f.root.PersistentIndices as number[] | undefined) ?? [];
    const owners = f.root.OwnerIndices as number[] | undefined;
    for (const d of f.data) if (!template && d.typeIndex === typeIndex && d.value) template = d.value;
    ids.forEach((id, i) => {
      const m = moved.get(id);
      if (m) {
        (f.root.Locations as MpsObject[])[i] = xyz(m.location);
        (f.root.Rotations as MpsObject[])[i] = xyzw(m.rotation);
        touched.add(p); found.add(id);
      }
      if (removed.has(id)) { const o = owners?.[i] ?? 0; ownerDelta.set(o, (ownerDelta.get(o) ?? 0) - 1); found.add(id); }
    });
    if (removed.size && removeRows(f, (i) => removed.has(ids[i]!))) touched.add(p);
  }
  for (const id of [...moved.keys(), ...removed]) if (!found.has(id)) warnings.push(`entity ${id} is not in this save`);
  if (added.length) {
    const p = W + 'Entities/Chunks/0_0_0.mps';
    let f = chunks.get(p);
    if (!f) { f = emptyChunk(eSchema); chunks.set(p, f); }
    for (const e of added) {
      const fields = struct ? eSchema.S.get(struct)! : [];
      const base: MpsObject = { ...gridDefaults(), ...(template ?? {}), ...(e.data ?? {}) };
      const value: MpsObject | null = struct ? Object.fromEntries(fields.map(([k, t]) => [k, k in base ? base[k] : zeroOf(eSchema, t)])) : null;
      insertRow(f, eSchema, typeIndex, struct, value, e);
      ownerDelta.set(e.owner, (ownerDelta.get(e.owner) ?? 0) + 1);
    }
    touched.add(p);
  }
  for (const p of touched) out.set(p, encodeSoa(chunks.get(p)!, eSchema));   // (an emptied chunk is dropped below)

  // the chunk index
  const ciSchemaBytes = out.get(ENTITY_INDEX_SCHEMA);
  if ((removed.size || added.length) && ciSchemaBytes) {
    const cs = parseSchema(ciSchemaBytes), ci = (out.has(ENTITY_INDEX) ? decodeMps(out.get(ENTITY_INDEX)!, cs) : { NextPersistentIndex: 2, Chunk3DIndices: [], NumEntities: [] }) as MpsObject;
    const idx = (ci.Chunk3DIndices as { X: number; Y: number; Z: number }[]) ?? [], num = (ci.NumEntities as number[]) ?? [];
    let next = (ci.NextPersistentIndex as number | undefined) ?? 2;
    for (const e of added) next = Math.max(next, e.persistentIndex + 1);
    for (const [p, f] of chunks) {
      const m = ENTITY_CHUNK.exec(p)!, k = { X: +m[1]!, Y: +m[2]!, Z: +m[3]! }, n = ((f.root.PersistentIndices as number[] | undefined) ?? []).length;
      const j = idx.findIndex((x) => x.X === k.X && x.Y === k.Y && x.Z === k.Z);
      if (!n) {                                     // emptied: the game lists no chunk without entities
        out.delete(p);
        if (j >= 0) { idx.splice(j, 1); num.splice(j, 1); }
        continue;
      }
      if (j < 0) { idx.push(k); num.push(n); } else num[j] = n;
      for (const id of (f.root.PersistentIndices as number[] | undefined) ?? []) next = Math.max(next, id + 1);
    }
    ci.Chunk3DIndices = idx; ci.NumEntities = num; ci.NextPersistentIndex = next;
    out.set(ENTITY_INDEX, encodeMps(ci, cs));
  }

  // owners
  const os = out.get(W + 'Owners.schema'), om = out.get(W + 'Owners.mps');
  if (ownerDelta.size && os && om) {
    const schema = parseSchema(os), ow = decodeMps(om, schema), counts = ow.EntityCounts as number[] | undefined;
    if (Array.isArray(counts)) {
      for (const [i, d] of ownerDelta) {
        if (i >= counts.length) { warnings.push(`entity owner ${i} not in Owners`); continue; }
        counts[i] = Math.max(0, counts[i]! + d);
      }
      out.set(W + 'Owners.mps', encodeMps(ow, schema));
    }
  }
  return { files: out, warnings };
}
