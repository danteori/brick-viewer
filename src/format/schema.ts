// .schema / .mps: data files are MessagePack laid out by a schema, which is itself MessagePack.
//
// A schema decodes to [enums, structs] (before ~CL14860) or [enums, variants, structs] (after);
// structs is a map {StructName: {Field: Type}}. A Type is
//   - a primitive ("u8", "i16", "f32", "f64", "str", "bool", ...) or an asset ref ("object",
//     "class", "weak_object", ...): one MessagePack value;
//   - an enum name: one MessagePack value (its number);
//   - a struct name: its fields follow inline, one value each;
//   - a variant name (tagged union, from the variants table): the alternative index, then a value
//     of that alternative's type;
//   - [T]: a MessagePack array of T;   [T, nil]: one bin of packed little-endian T (nil = empty);
//   - [T, N]: exactly N values of T, no header;   {K: V}: a MessagePack map.
// Component and entity chunk files hold their SoA root struct followed by per-instance data
// structs (see decodeSoa); every other .mps holds just the root.
//
// Encoding follows the game (and brdb, the community's CC0 Rust reference): u8 values are
// written as SIGNED ints (128..255 as 0xd0 / negative fixint, never 0xcc), whole-number floats
// as ints (f32 within (-32768, 65535), f64 within (-2^31, 2^32 - 1)), other f32 as 0xca, and
// f64 as 0xca when f32 holds it exactly, else 0xcb (that last step is where the game differs
// from brdb, which always uses 0xcb). encode(decode(x)) is byte-identical to x for every
// game-written reference save.
//
// Ported from save-viewer.html (parseSchema / decodeMps), tools/brzwriter.js (encodeMps /
// schemaPathFor) and tools/survey_brz.py (variants, maps, fixed arrays, SoA data).

import { ByteBuf, MsgMap, MsgReader, arrayHeader, mapHeader, pack, packFloat64, safeInt, type MsgValue, type Packable } from './msgpack.ts';

export type SchemaType =
  | string
  | { kind: 'array'; of: SchemaType }
  | { kind: 'packed'; of: SchemaType }
  | { kind: 'fixed'; of: SchemaType; n: number }
  | { kind: 'map'; key: SchemaType; value: SchemaType };
export type StructFields = [field: string, type: SchemaType][];

export interface Schema {
  /** Enum name -> raw table as stored. */
  E: Map<string, MsgValue>;
  /** Variant name -> alternative types (empty for 2-part schemas). */
  V: Map<string, SchemaType[]>;
  /** Struct name -> ordered fields. */
  S: Map<string, StructFields>;
  /** The struct an .mps file starts with: a known SoA root if present, else the last struct. */
  root: string;
}

/** Decoded .mps data: plain objects / arrays / numbers / strings / Maps, shaped by the schema. */
export type MpsObject = Record<string, unknown>;

/** A decoded variant value: which alternative, and its value. */
export interface VariantValue {
  variant: number;
  type: string;
  value: unknown;
}

/**
 * Bytes after the root struct that weren't decoded (per-instance SoA data when decodeMps is
 * used instead of decodeSoa). Kept as a non-enumerable property of the root value and written
 * back unchanged by encodeMps.
 */
export const MPS_TRAILER: unique symbol = Symbol('mpsTrailer');
/** Marks a packed array that was stored as nil rather than an empty bin. */
const PACKED_NIL: unique symbol = Symbol('packedNil');

type GetFn = 'getUint8' | 'getInt8' | 'getUint16' | 'getInt16' | 'getUint32' | 'getInt32' | 'getFloat32' | 'getFloat64' | 'getBigUint64' | 'getBigInt64';
type SetFn = 'setUint8' | 'setInt8' | 'setUint16' | 'setInt16' | 'setUint32' | 'setInt32' | 'setFloat32' | 'setFloat64' | 'setBigUint64' | 'setBigInt64';

/** Packed little-endian primitives used inside [T, nil] bins: [size, DataView getter, setter]. */
const PRIM: Record<string, [number, GetFn, SetFn]> = {
  u8: [1, 'getUint8', 'setUint8'], i8: [1, 'getInt8', 'setInt8'],
  u16: [2, 'getUint16', 'setUint16'], i16: [2, 'getInt16', 'setInt16'],
  u32: [4, 'getUint32', 'setUint32'], i32: [4, 'getInt32', 'setInt32'],
  u64: [8, 'getBigUint64', 'setBigUint64'], i64: [8, 'getBigInt64', 'setBigInt64'],
  f32: [4, 'getFloat32', 'setFloat32'], f64: [8, 'getFloat64', 'setFloat64'],
  bool: [1, 'getUint8', 'setUint8'],
};

/** SoA roots: these files carry per-instance data after the root (FORMAT.md 1.7). */
const SOA_ROOTS = ['BRSavedComponentChunkSoA', 'BRSavedEntityChunkSoA', 'BRSavedBrickChunkSoA', 'BRSavedWireChunkSoA'];

/** Older schemas name variants in lower case and carry no table; the later tables decode them (survey_brz.py). */
const LEGACY_VARIANTS: Record<string, string[]> = {
  wire_graph_variant: ['f64', 'i64', 'bool', 'weak_object', 'WireGraphExec', 'Vector', 'Rotator', 'Quat', 'str', 'LinearColor', 'WireGraphEnumWrapper'],
  wire_graph_prim_math_variant: ['f64', 'i64', 'Vector', 'Rotator', 'Quat', 'LinearColor'],
};
/** Structs older schemas use without defining them. */
const LEGACY_STRUCTS: Record<string, StructFields> = {
  Vector: [['X', 'f64'], ['Y', 'f64'], ['Z', 'f64']],
  Rotator: [['Pitch', 'f64'], ['Yaw', 'f64'], ['Roll', 'f64']],
  Quat: [['X', 'f64'], ['Y', 'f64'], ['Z', 'f64'], ['W', 'f64']],
  LinearColor: [['R', 'f32'], ['G', 'f32'], ['B', 'f32'], ['A', 'f32']],
  WireGraphExec: [],
};

function parseType(t: MsgValue): SchemaType {
  if (typeof t === 'string') return t;
  if (t instanceof MsgMap) {
    if (t.length !== 1) throw new Error('schema: a map type must have exactly one entry');
    const [k, v] = t[0]!;
    return { kind: 'map', key: parseType(k), value: parseType(v) };
  }
  if (Array.isArray(t)) {
    if (t.length === 1) return { kind: 'array', of: parseType(t[0] as MsgValue) };
    if (t.length === 2 && t[1] === null) return { kind: 'packed', of: parseType(t[0] as MsgValue) };
    if (t.length === 2 && typeof t[1] === 'number') return { kind: 'fixed', of: parseType(t[0] as MsgValue), n: t[1] };
  }
  throw new Error(`schema: unsupported type ${JSON.stringify(t)}`);
}

const pairs = (v: MsgValue | undefined, what: string): [MsgValue, MsgValue][] => {
  if (!(v instanceof MsgMap)) throw new Error(`schema: ${what} is not a map`);
  return v;
};

/** Parses a .schema file (both the 2-part and the 3-part layout). */
export function parseSchema(u8: Uint8Array): Schema {
  const top = new MsgReader(u8).next();
  if (!Array.isArray(top) || top.length < 2) throw new Error('schema: unexpected top level');
  const E = new Map<string, MsgValue>(), V = new Map<string, SchemaType[]>(), S = new Map<string, StructFields>();
  for (const [name, table] of pairs(top[0], 'enum table')) E.set(String(name), table);
  if (top.length > 2 && !(Array.isArray(top[1]) && top[1].length === 0 && !(top[1] instanceof MsgMap))) {
    for (const [name, alts] of pairs(top[1], 'variant table')) {
      if (!Array.isArray(alts)) throw new Error(`schema: variant ${String(name)} is not a list`);
      V.set(String(name), (alts as MsgValue[]).map(parseType));
    }
  }
  const structs = pairs(top[top.length - 1], 'struct table');
  for (const [name, fields] of structs) {
    S.set(String(name), pairs(fields, `struct ${String(name)}`).map(([f, t]) => [String(f), parseType(t)]));
  }
  const last = structs[structs.length - 1];
  if (!last) throw new Error('schema: no structs');
  const root = SOA_ROOTS.find((r) => S.has(r)) ?? String(last[0]);
  return { E, V, S, root };
}

function structOf(schema: Schema, t: string): StructFields | undefined {
  return schema.S.get(t) ?? LEGACY_STRUCTS[t];
}

function variantOf(schema: Schema, t: string): SchemaType[] | undefined {
  return schema.V.get(t) ?? LEGACY_VARIANTS[t];
}

/** Byte size of one packed value of type t (primitives and structs of primitives). */
function sizer(schema: Schema): (t: SchemaType) => number {
  const cache = new Map<string, number>();
  const size = (t: SchemaType): number => {
    if (typeof t !== 'string') throw new Error('schema: container type inside a packed bin');
    const p = PRIM[t];
    if (p) return p[0];
    let n = cache.get(t);
    if (n === undefined) {
      const fields = structOf(schema, t);
      if (!fields) throw new Error(`schema: unknown packed type ${t}`);
      n = fields.reduce((s, [, ft]) => s + size(ft), 0);
      cache.set(t, n);
    }
    return n;
  };
  return size;
}

/**
 * A packed array of structs left as its bytes (decodeMps with `rawStructs`): element i's field f
 * is at i * k + fields.get(f)[0], of primitive type fields.get(f)[1]. Saves one object per element
 * on hot paths (millions of brick positions and colours).
 */
export interface PackedStructs { raw: true; bin: Uint8Array; dv: DataView; k: number; n: number; fields: Map<string, [offset: number, type: string]> }

/** A reader for field f of a PackedStructs (undefined when it has no such primitive field). */
export function packedField(p: PackedStructs, f: string): ((i: number) => number) | undefined {
  const e = p.fields.get(f);
  if (!e) return undefined;
  const [o, t] = e, dv = p.dv, k = p.k;
  switch (t) {
    case 'u8': case 'bool': return (i) => dv.getUint8(i * k + o);
    case 'i8': return (i) => dv.getInt8(i * k + o);
    case 'u16': return (i) => dv.getUint16(i * k + o, true);
    case 'i16': return (i) => dv.getInt16(i * k + o, true);
    case 'u32': return (i) => dv.getUint32(i * k + o, true);
    case 'i32': return (i) => dv.getInt32(i * k + o, true);
    case 'f32': return (i) => dv.getFloat32(i * k + o, true);
    case 'f64': return (i) => dv.getFloat64(i * k + o, true);
    default: return undefined;
  }
}

/** Schema-driven reader over one .mps byte array. */
export class MpsDecoder {
  readonly r: MsgReader;
  private readonly packedSize: (t: SchemaType) => number;

  /** `rawStructs`: packed arrays of flat structs come back as PackedStructs, not objects. */
  constructor(readonly schema: Schema, readonly bytes: Uint8Array, readonly rawStructs = false) {
    this.r = new MsgReader(bytes);
    this.packedSize = sizer(schema);
  }

  /** The flat layout of struct t (field -> offset, primitive type), or null if a field isn't primitive. */
  private flat(t: string): Map<string, [number, string]> | null {
    const out = new Map<string, [number, string]>();
    let o = 0;
    for (const [f, ft] of structOf(this.schema, t) ?? []) {
      if (typeof ft !== 'string' || !PRIM[ft]) return null;
      out.set(f, [o, ft]); o += PRIM[ft][0];
    }
    return out;
  }

  get done(): boolean {
    return this.r.p >= this.bytes.length;
  }

  private unpack(t: string, dv: DataView, o: number): unknown {
    const p = PRIM[t];
    if (p) {
      const x = dv[p[1]](o, true);
      return typeof x === 'bigint' ? safeInt(x) : x;
    }
    const out: MpsObject = {};
    for (const [f, ft] of structOf(this.schema, t)!) {
      out[f] = this.unpack(ft as string, dv, o);
      o += this.packedSize(ft);
    }
    return out;
  }

  value(t: SchemaType): unknown {
    const r = this.r;
    if (typeof t !== 'string') {
      switch (t.kind) {
        case 'packed': {
          const bin = r.next();
          if (bin === null) return Object.defineProperty([], PACKED_NIL, { value: true });
          if (!(bin instanceof Uint8Array)) throw new Error('mps: expected a bin for a packed array');
          const k = this.packedSize(t.of), n = bin.length / k;
          const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
          if (this.rawStructs && typeof t.of === 'string' && !PRIM[t.of]) {
            const fields = this.flat(t.of);
            if (fields) return { raw: true, bin, dv, k, n, fields } satisfies PackedStructs;
          }
          const out: unknown[] = new Array(n);
          for (let i = 0; i < n; i++) out[i] = this.unpack(t.of as string, dv, i * k);
          return out;
        }
        case 'array': {
          const n = r.arrayLen(), out: unknown[] = new Array(n);
          for (let i = 0; i < n; i++) out[i] = this.value(t.of);
          return out;
        }
        case 'fixed': {
          const out: unknown[] = new Array(t.n);
          for (let i = 0; i < t.n; i++) out[i] = this.value(t.of);
          return out;
        }
        case 'map': {
          const n = r.mapLen(), out = new Map<unknown, unknown>();
          for (let i = 0; i < n; i++) {
            const k = this.value(t.key);
            out.set(k, this.value(t.value));
          }
          return out;
        }
      }
    }
    const fields = structOf(this.schema, t);
    if (fields) {
      const out: MpsObject = {};
      for (const [f, ft] of fields) out[f] = this.value(ft);
      return out;
    }
    const alts = variantOf(this.schema, t);
    if (alts) {
      const tag = r.next();
      if (typeof tag !== 'number' || !alts[tag]) throw new Error(`mps: bad ${t} tag ${String(tag)} at ${r.p}`);
      const alt = alts[tag]!;
      return { variant: tag, type: typeof alt === 'string' ? alt : JSON.stringify(alt), value: this.value(alt) } satisfies VariantValue;
    }
    const x = r.next();   // primitives, str, enums and asset refs
    // u8 is signed on the wire (255 is stored as -1): give back the byte value
    return t === 'u8' && typeof x === 'number' && x < 0 && x >= -128 ? x + 256 : x;
  }
}

/** Schema-driven writer. */
export class MpsEncoder {
  readonly o = new ByteBuf();
  private readonly packedSize: (t: SchemaType) => number;

  constructor(readonly schema: Schema) {
    this.packedSize = sizer(schema);
  }

  private put(t: string, x: unknown, dv: DataView, p: number): number {
    const prim = PRIM[t];
    if (prim) {
      const [k, , set] = prim;
      if (set === 'setBigUint64' || set === 'setBigInt64') dv[set](p, BigInt(x as number | bigint), true);
      else dv[set](p, typeof x === 'boolean' ? +x : (x as number), true);
      return p + k;
    }
    const rec = x as MpsObject;
    for (const [f, ft] of structOf(this.schema, t)!) p = this.put(ft as string, rec[f], dv, p);
    return p;
  }

  /** One scalar by its schema type (the game's / brdb's encoding rules). */
  private scalar(t: string, x: unknown): void {
    const o = this.o;
    if (typeof x === 'number') {
      if (t === 'u8' && x > 127 && x <= 255) return pack(o, x - 256);   // signed on the wire, never 0xcc
      if (t === 'f32') {
        if (Number.isInteger(x) && x > -32768 && x < 65535) return pack(o, x);
        return pack(o, x, true);
      }
      if (t === 'f64') {
        if (Number.isInteger(x) && x > -2147483648 && x < 4294967295) return pack(o, x);
        // The game writes an f64 that f32 holds exactly as 0xca (CL12560 component data: a
        // Vector's 1.5); brdb would write 0xcb. The game's bytes win.
        if (Math.fround(x) === x) return pack(o, x, true);
        return packFloat64(o, x);
      }
    }
    pack(o, x as Packable);
  }

  value(t: SchemaType, x: unknown): void {
    const o = this.o;
    if (typeof t !== 'string') {
      switch (t.kind) {
        case 'packed': {
          const list = x as unknown[];
          if (list.length === 0 && (list as { [PACKED_NIL]?: boolean })[PACKED_NIL]) return pack(o, null);
          const k = this.packedSize(t.of), bin = new Uint8Array(list.length * k), dv = new DataView(bin.buffer);
          for (let i = 0; i < list.length; i++) this.put(t.of as string, list[i], dv, i * k);
          return pack(o, bin);
        }
        case 'array': {
          const list = x as unknown[];
          arrayHeader(o, list.length);
          for (const e of list) this.value(t.of, e);
          return;
        }
        case 'fixed': {
          const list = x as unknown[];
          for (let i = 0; i < t.n; i++) this.value(t.of, list[i]);
          return;
        }
        case 'map': {
          const m = x as Map<unknown, unknown>;
          mapHeader(o, m.size);
          for (const [k, v] of m) { this.value(t.key, k); this.value(t.value, v); }
          return;
        }
      }
    }
    const fields = structOf(this.schema, t);
    if (fields) {
      const rec = x as MpsObject;
      for (const [f, ft] of fields) this.value(ft, rec[f]);
      return;
    }
    const alts = variantOf(this.schema, t);
    if (alts) {
      const v = x as VariantValue;
      pack(o, v.variant);
      return this.value(alts[v.variant]!, v.value);
    }
    this.scalar(t, x);
  }

  done(): Uint8Array {
    return this.o.done();
  }
}

/** Decodes an .mps file's root struct. Anything after it is kept (see MPS_TRAILER). */
export function decodeMps<T = MpsObject>(u8: Uint8Array, schema: Schema, rawStructs = false): T {
  const d = new MpsDecoder(schema, u8, rawStructs);
  const root = d.value(schema.root);
  if (!d.done && root && typeof root === 'object') {
    Object.defineProperty(root, MPS_TRAILER, { value: u8.slice(d.r.p), enumerable: false, writable: true, configurable: true });
  }
  return root as T;
}

/** Inverse of decodeMps: a value shaped like its output -> .mps bytes. */
export function encodeMps(value: unknown, schema: Schema): Uint8Array {
  const e = new MpsEncoder(schema);
  e.value(schema.root, value);
  const trailer = value && typeof value === 'object' ? (value as { [MPS_TRAILER]?: Uint8Array })[MPS_TRAILER] : undefined;
  if (trailer) e.o.bytes(trailer);
  return e.done();
}

/** One instance of SoA per-instance data. */
export interface SoaInstance {
  typeIndex: number;
  /** Data struct name, or null when the type has none ("None" / missing). */
  struct: string | null;
  value: MpsObject | null;
}

export interface SoaFile {
  root: MpsObject;
  data: SoaInstance[];
}

/** Names GlobalData gives a component / entity type's data struct. */
interface SoaNames {
  ComponentTypeNames?: string[];
  ComponentDataStructNames?: string[];
  EntityTypeNames?: string[];
  EntityDataClassNames?: string[];
}

function soaRuns(root: MpsObject, schema: Schema, global: SoaNames): { typeIndex: number; n: number; struct: string | null }[] | null {
  const comp = schema.root === 'BRSavedComponentChunkSoA';
  if (!comp && schema.root !== 'BRSavedEntityChunkSoA') return null;
  const counters = root[comp ? 'ComponentTypeCounters' : 'TypeCounters'] as Record<string, number>[] | undefined;
  const names = comp ? (global.ComponentDataStructNames ?? global.ComponentTypeNames) : (global.EntityDataClassNames ?? global.EntityTypeNames);
  if (!counters || !names) return null;
  return counters.map((c) => {
    const ti = c.TypeIndex!, n = c[comp ? 'NumInstances' : 'NumEntities']!;
    const st = names[ti];
    return { typeIndex: ti, n, struct: st && st !== 'None' && structOf(schema, st) ? st : null };
  });
}

/**
 * Decodes a component / entity chunk fully: the SoA root, then one data struct per instance, in
 * type-counter order, with struct names from GlobalData (Component/EntityDataClassNames).
 * Other roots decode as decodeMps with an empty data list. Leftover bytes stay in MPS_TRAILER.
 */
export function decodeSoa(u8: Uint8Array, schema: Schema, global: SoaNames): SoaFile {
  const d = new MpsDecoder(schema, u8);
  const root = d.value(schema.root) as MpsObject, data: SoaInstance[] = [];
  for (const run of soaRuns(root, schema, global) ?? []) {
    for (let i = 0; i < run.n; i++) data.push({ typeIndex: run.typeIndex, struct: run.struct, value: run.struct ? (d.value(run.struct) as MpsObject) : null });
  }
  if (!d.done) Object.defineProperty(root, MPS_TRAILER, { value: u8.slice(d.r.p), enumerable: false, writable: true, configurable: true });
  return { root, data };
}

/** Inverse of decodeSoa. */
export function encodeSoa(file: SoaFile, schema: Schema): Uint8Array {
  const e = new MpsEncoder(schema);
  e.value(schema.root, file.root);
  for (const inst of file.data) if (inst.struct) e.value(inst.struct, inst.value);
  const trailer = (file.root as { [MPS_TRAILER]?: Uint8Array })[MPS_TRAILER];
  if (trailer) e.o.bytes(trailer);
  return e.done();
}

/**
 * The schema file for an .mps path: "<name>.schema" in the same folder, else the nearest
 * ancestor's "<folder>Shared.schema" / "<name>Shared.schema"
 * (Grids/1/Chunks/x.mps -> Bricks/ChunksShared.schema, Grids/1/ChunkIndex.mps -> Bricks/ChunkIndexShared.schema).
 */
export function schemaPathFor(path: string, files: ReadonlyMap<string, unknown>): string | null {
  const parts = path.split('/'), name = parts.pop()!.replace(/\.mps$/, ''), folder = parts[parts.length - 1] ?? '';
  const own = [...parts, name + '.schema'].join('/');
  if (files.has(own)) return own;
  for (let d = parts.length - 1; d >= 0; d--) {
    for (const n of [folder, name]) {
      const p = [...parts.slice(0, d), n + 'Shared.schema'].join('/');
      if (files.has(p)) return p;
    }
  }
  return null;
}
