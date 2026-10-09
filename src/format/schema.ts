// .schema / .mps: data files are MessagePack laid out by a schema, which is itself MessagePack.
//
// A schema decodes to [enums, structs] (older saves) or [enums, ?, structs] (newer saves);
// structs is a map {StructName: {Field: Type}} and the .mps file holds the LAST struct.
// A Type is a primitive ("u8", "i16", "f32", "str", "bool", ...), a struct name (its fields follow
// inline, one MessagePack value each), [T] (a MessagePack array of T) or [T, nil] (one bin of
// packed little-endian T).
//
// Ported from save-viewer.html (parseSchema / decodeMps) and tools/brzwriter.js (encodeMps /
// schemaPathFor). encodeMps(decodeMps(x)) is byte-identical to x for every reference save.

import { ByteBuf, MsgReader, arrayHeader, pack, type MsgValue, type Packable } from './msgpack.ts';

export type SchemaType = string | [SchemaType] | [SchemaType, null];
export type StructFields = [field: string, type: SchemaType][];
export interface Schema {
  /** Struct name -> ordered fields. */
  S: Map<string, StructFields>;
  /** The struct an .mps file holds (the schema's last one). */
  root: string;
}

/** Decoded .mps data: plain objects / arrays / numbers / strings, shaped by the schema. */
export type MpsObject = Record<string, unknown>;

/**
 * Bytes after the root struct. Component chunk files (Grids/N/Components/*.mps) follow their
 * root struct with per-component-type instance data that isn't decoded yet; decodeMps keeps it
 * here (a non-enumerable property of the root value) and encodeMps writes it back unchanged.
 */
export const MPS_TRAILER: unique symbol = Symbol('mpsTrailer');

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

const asPairs = (v: MsgValue, what: string): [MsgValue, MsgValue][] => {
  if (!Array.isArray(v)) throw new Error(`schema: ${what} is not a map`);
  return v as [MsgValue, MsgValue][];
};

/** Parses a .schema file (both the 2-part and the 3-part layout). */
export function parseSchema(u8: Uint8Array): Schema {
  const top = new MsgReader(u8).next();
  if (!Array.isArray(top) || top.length < 2) throw new Error('schema: unexpected top level');
  const structs = asPairs(top[top.length - 1] as MsgValue, 'struct table');
  const S = new Map<string, StructFields>();
  for (const [name, fields] of structs) S.set(String(name), asPairs(fields, `struct ${String(name)}`) as StructFields);
  const last = structs[structs.length - 1];
  if (!last) throw new Error('schema: no structs');
  return { S, root: String(last[0]) };
}

/** Byte size of one packed value of type t (primitives and structs of primitives). */
function sizer(S: Map<string, StructFields>): (t: SchemaType) => number {
  const cache = new Map<string, number>();
  const size = (t: SchemaType): number => {
    if (typeof t !== 'string') throw new Error('schema: array type inside a packed bin');
    const p = PRIM[t];
    if (p) return p[0];
    let n = cache.get(t);
    if (n === undefined) {
      const fields = S.get(t);
      if (!fields) throw new Error(`schema: unknown type ${t}`);
      n = fields.reduce((s, [, ft]) => s + size(ft), 0);
      cache.set(t, n);
    }
    return n;
  };
  return size;
}

/** Decodes an .mps file with its schema. */
export function decodeMps<T = MpsObject>(u8: Uint8Array, schema: Schema): T {
  const { S } = schema, r = new MsgReader(u8), packedSize = sizer(S);
  const unpack = (t: SchemaType, dv: DataView, o: number): unknown => {
    const name = t as string, p = PRIM[name];
    if (p) {
      const x = dv[p[1]](o, true);
      return typeof x === 'bigint' ? Number(x) : x;
    }
    const out: MpsObject = {};
    for (const [f, ft] of S.get(name)!) {
      out[f] = unpack(ft, dv, o);
      o += packedSize(ft);
    }
    return out;
  };
  const value = (t: SchemaType): unknown => {
    if (Array.isArray(t)) {
      if (t.length === 2) {
        const bin = r.next();
        if (!(bin instanceof Uint8Array)) throw new Error('mps: expected a bin for a packed array');
        const k = packedSize(t[0]), n = bin.length / k, out: unknown[] = new Array(n);
        const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
        for (let i = 0; i < n; i++) out[i] = unpack(t[0], dv, i * k);
        return out;
      }
      const n = r.arrayLen(), out: unknown[] = new Array(n);
      for (let i = 0; i < n; i++) out[i] = value(t[0]);
      return out;
    }
    const fields = S.get(t);
    if (fields) {
      const out: MpsObject = {};
      for (const [f, ft] of fields) out[f] = value(ft);
      return out;
    }
    return r.next();
  };
  const root = value(schema.root);
  if (r.p < u8.length && root && typeof root === 'object') {
    Object.defineProperty(root, MPS_TRAILER, { value: u8.slice(r.p), enumerable: false, writable: true, configurable: true });
  }
  return root as T;
}

/** Inverse of decodeMps: a value shaped like its output -> .mps bytes. */
export function encodeMps(value: unknown, schema: Schema): Uint8Array {
  const { S } = schema, o = new ByteBuf(), packedSize = sizer(S);
  const put = (t: SchemaType, x: unknown, dv: DataView, p: number): number => {
    const name = t as string, prim = PRIM[name];
    if (prim) {
      const [k, , set] = prim;
      if (set === 'setBigUint64' || set === 'setBigInt64') dv[set](p, BigInt(x as number | bigint), true);
      else dv[set](p, typeof x === 'boolean' ? +x : (x as number), true);
      return p + k;
    }
    const rec = x as MpsObject;
    for (const [f, ft] of S.get(name)!) p = put(ft, rec[f], dv, p);
    return p;
  };
  const val = (t: SchemaType, x: unknown): void => {
    if (Array.isArray(t)) {
      const list = x as unknown[];
      if (t.length === 2) {
        const k = packedSize(t[0]), bin = new Uint8Array(list.length * k), dv = new DataView(bin.buffer);
        for (let i = 0; i < list.length; i++) put(t[0], list[i], dv, i * k);
        return pack(o, bin);
      }
      arrayHeader(o, list.length);
      for (const e of list) val(t[0], e);
      return;
    }
    const fields = S.get(t);
    if (fields) {
      const rec = x as MpsObject;
      for (const [f, ft] of fields) val(ft, rec[f]);
      return;
    }
    pack(o, x as Packable, t === 'f32' || t === 'f64');
  };
  val(schema.root, value);
  const trailer = value && typeof value === 'object' ? (value as { [MPS_TRAILER]?: Uint8Array })[MPS_TRAILER] : undefined;
  if (trailer) o.bytes(trailer);
  return o.done();
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
