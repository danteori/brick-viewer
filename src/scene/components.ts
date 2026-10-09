// Component data of a save as a typed, editable model (backlog C-02, the data side).
//
// A brick chunk's components live in `Grids/<g>/Components/<x>_<y>_<z>.mps`: an SoA root
// (`ComponentTypeCounters`, `ComponentBrickIndices`, joints, microchips) followed by one data
// struct per instance (decodeSoa). Everything here is driven by the save's own schema and
// GlobalData name lists, read at run time: no component, field or enum table is built in.
//
//   const store = loadComponents(files);               // files: path -> bytes (readBrz)
//   for (const c of store.onBrick({ grid: 1, chunk, brick })) describeComponent(store, c);
//   store.setField(c, ['Brightness'], 40);             // validated against the schema
//   const out = store.encode();                        // only edited chunks are re-encoded
//
// A store with no edits encodes to the very same bytes (untouched chunks are copied; a forced
// re-encode is byte-identical too, see the reference tests).

import type { FileMap } from '../format/brz.ts';
import { MsgMap, type MsgValue } from '../format/msgpack.ts';
import { decodeMps, decodeSoa, encodeSoa, parseSchema, schemaPathFor, type MpsObject, type Schema, type SchemaType, type SoaFile, type VariantValue } from '../format/schema.ts';

export const WORLD = 'World/0/';

/** A chunk coordinate, as the save stores it. */
export interface ChunkKey { X: number; Y: number; Z: number }

/** Which brick: grid folder number (= entity persistent index; 1 is the static grid), chunk, index in that chunk. */
export interface BrickRef { grid: number; chunk: ChunkKey; brick: number }

export const chunkName = (k: ChunkKey): string => `${k.X}_${k.Y}_${k.Z}`;
export const brickKey = (r: BrickRef): string => `${r.grid}/${chunkName(r.chunk)}/${r.brick}`;
export const sameBrick = (a: BrickRef, b: BrickRef): boolean => a.grid === b.grid && a.brick === b.brick && a.chunk.X === b.chunk.X && a.chunk.Y === b.chunk.Y && a.chunk.Z === b.chunk.Z;

const CHUNK_FILE = /^World\/0\/Bricks\/Grids\/(\d+)\/(Components|Wires|Chunks)\/(-?\d+)_(-?\d+)_(-?\d+)\.mps$/;

/** Parses a brick-grid chunk path (`.../Grids/<g>/<Components|Wires|Chunks>/<x>_<y>_<z>.mps`). */
export function parseChunkPath(path: string): { grid: number; kind: string; chunk: ChunkKey } | null {
  const m = CHUNK_FILE.exec(path);
  return m ? { grid: +m[1]!, kind: m[2]!, chunk: { X: +m[3]!, Y: +m[4]!, Z: +m[5]! } } : null;
}
export const chunkPath = (grid: number, kind: 'Components' | 'Wires' | 'Chunks', k: ChunkKey): string => `${WORLD}Bricks/Grids/${grid}/${kind}/${chunkName(k)}.mps`;

/** The GlobalData lists components and wires index into (any may be missing in old saves). */
export interface ComponentGlobals extends MpsObject {
  ComponentTypeNames?: string[];
  ComponentDataStructNames?: string[];
  ComponentWirePortNames?: string[];
  EntityTypeNames?: string[];
  EntityDataClassNames?: string[];
  ExternalAssetReferences?: { PrimaryAssetType: string; PrimaryAssetName: string }[];
}

export interface LoadOptions {
  /**
   * Schema for an .mps path. Default: the save's own `.schema` (schemaPathFor). A `.brdb` reader
   * passes the schema that was live when the chunk was written.
   */
  schemaFor?: (mpsPath: string) => Schema;
}

/** Shared by the component and wire models: GlobalData plus cached schemas. */
export interface SaveContext {
  files: FileMap;
  global: ComponentGlobals;
  globalSchema: Schema;
  schemaFor: (mpsPath: string) => Schema;
}

export function saveContext(files: FileMap, opts: LoadOptions = {}): SaveContext {
  const gs = files.get(WORLD + 'GlobalData.schema'), gm = files.get(WORLD + 'GlobalData.mps');
  if (!gs || !gm) throw new Error('save has no World/0/GlobalData');
  const globalSchema = parseSchema(gs);
  const cache = new Map<string, Schema>();
  const schemaFor = opts.schemaFor ?? ((p: string): Schema => {
    const sp = schemaPathFor(p, files);
    if (!sp) throw new Error('no schema for ' + p);
    let s = cache.get(sp);
    if (!s) cache.set(sp, (s = parseSchema(files.get(sp)!)));
    return s;
  });
  return { files, global: decodeMps<ComponentGlobals>(gm, globalSchema), globalSchema, schemaFor };
}

// ---------------------------------------------------------------------------------------------
// Schema types -> editor descriptors

export type EditorKind = 'number' | 'bool' | 'enum' | 'string' | 'asset' | 'colour' | 'vector' | 'rotator' | 'map' | 'variant' | 'struct' | 'array' | 'raw';

export interface FieldDescriptor {
  /** Field name (or, for a variant alternative / map key / array element, a label). */
  name: string;
  /** The schema type as text: `f32`, `Vector`, `[u8]`, `{str: Vector}` … */
  type: string;
  schemaType: SchemaType;
  kind: EditorKind;
  /** number: integer types, their range, and whether the value is stored as float32. */
  number?: { integer: boolean; min: number; max: number; float32: boolean };
  /** enum: the save's own enum table; asset: the save's ExternalAssetReferences (-1 = none). */
  options?: { label: string; value: number }[];
  /** colour: the struct's channel fields in stored order, and whether they're 0..1 floats (linear colour). */
  colour?: { channels: string[]; float: boolean };
  /** vector / rotator / colour / struct: the struct's fields. */
  fields?: FieldDescriptor[];
  /** array: the element; map: key and value. */
  element?: FieldDescriptor;
  key?: FieldDescriptor;
  value?: FieldDescriptor;
  /** array: 'list' ([T]), 'packed' ([T, nil]) or 'fixed' ([T, N], with `length`). */
  array?: 'list' | 'packed' | 'fixed';
  length?: number;
  /** variant: one descriptor per alternative, in tag order. */
  alternatives?: FieldDescriptor[];
}

const INT_RANGE: Record<string, [number, number]> = {
  u8: [0, 255], i8: [-128, 127], u16: [0, 65535], i16: [-32768, 32767],
  u32: [0, 4294967295], i32: [-2147483648, 2147483647],
  u64: [0, Number.MAX_SAFE_INTEGER], i64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};
const BIG_RANGE: Record<string, [bigint, bigint]> = { u64: [0n, 2n ** 64n - 1n], i64: [-(2n ** 63n), 2n ** 63n - 1n] };
const F32_MAX = 3.4028234663852886e38;
/** Asset references stored as an index into GlobalData.ExternalAssetReferences (FORMAT 1.3). */
const ASSET_REF = new Set(['object', 'class']);
const STRINGS = new Set(['str', 'bundle_path_ref']);

/** Structs older schemas use without defining them (same as the format layer's fallback). */
const LEGACY_STRUCTS: Record<string, [string, SchemaType][]> = {
  Vector: [['X', 'f64'], ['Y', 'f64'], ['Z', 'f64']],
  Rotator: [['Pitch', 'f64'], ['Yaw', 'f64'], ['Roll', 'f64']],
  Quat: [['X', 'f64'], ['Y', 'f64'], ['Z', 'f64'], ['W', 'f64']],
  LinearColor: [['R', 'f32'], ['G', 'f32'], ['B', 'f32'], ['A', 'f32']],
  WireGraphExec: [],
};
const LEGACY_VARIANTS: Record<string, SchemaType[]> = {
  wire_graph_variant: ['f64', 'i64', 'bool', 'weak_object', 'WireGraphExec', 'Vector', 'Rotator', 'Quat', 'str', 'LinearColor', 'WireGraphEnumWrapper'],
  wire_graph_prim_math_variant: ['f64', 'i64', 'Vector', 'Rotator', 'Quat', 'LinearColor'],
};
const structFields = (s: Schema, t: string): [string, SchemaType][] | undefined => s.S.get(t) ?? LEGACY_STRUCTS[t];
const variantAlts = (s: Schema, t: string): SchemaType[] | undefined => s.V.get(t) ?? LEGACY_VARIANTS[t];

/** A schema type as text. */
export function typeText(t: SchemaType): string {
  if (typeof t === 'string') return t;
  switch (t.kind) {
    case 'array': return `[${typeText(t.of)}]`;
    case 'packed': return `[${typeText(t.of)}, nil]`;
    case 'fixed': return `[${typeText(t.of)}, ${t.n}]`;
    case 'map': return `{${typeText(t.key)}: ${typeText(t.value)}}`;
  }
}

/** An enum's options from the save's enum table ({Name: value} map, or a list of names). */
export function enumOptions(schema: Schema, name: string): { label: string; value: number }[] | null {
  const raw = schema.E.get(name);
  if (raw === undefined) return null;
  if (raw instanceof MsgMap) return raw.map(([k, v]) => ({ label: String(k), value: Number(v) }));
  if (Array.isArray(raw)) return (raw as MsgValue[]).map((k, i) => ({ label: String(k), value: i }));
  return [];
}

const fieldSet = (f: [string, SchemaType][]): string => f.map(([n]) => n).sort().join(',');

/** What kind of editor a struct gets, from its field names and types (not its name). */
function structKind(fields: [string, SchemaType][]): 'colour' | 'vector' | 'rotator' | 'struct' {
  const names = fieldSet(fields);
  const prims = fields.every(([, t]) => typeof t === 'string' && (t in INT_RANGE || t === 'f32' || t === 'f64'));
  if (!prims || fields.length === 0) return 'struct';
  if (names === 'A,B,G,R') return 'colour';
  if (names === 'Pitch,Roll,Yaw') return 'rotator';
  if (names === 'X,Y' || names === 'X,Y,Z' || names === 'W,X,Y,Z') return 'vector';
  return 'struct';
}

/** Editor descriptor for one schema type. `assets` labels object/class options. */
export function describeType(schema: Schema, t: SchemaType, name: string, global?: ComponentGlobals, depth = 0): FieldDescriptor {
  const base = { name, type: typeText(t), schemaType: t };
  if (depth > 12) return { ...base, kind: 'raw' };
  if (typeof t !== 'string') {
    switch (t.kind) {
      case 'map':
        return { ...base, kind: 'map', key: describeType(schema, t.key, 'key', global, depth + 1), value: describeType(schema, t.value, 'value', global, depth + 1) };
      case 'array': case 'packed': case 'fixed':
        return {
          ...base, kind: 'array', array: t.kind === 'array' ? 'list' : t.kind, ...(t.kind === 'fixed' ? { length: t.n } : {}),
          element: describeType(schema, t.of, 'element', global, depth + 1),
        };
    }
  }
  const range = INT_RANGE[t];
  if (range) return { ...base, kind: 'number', number: { integer: true, min: range[0], max: range[1], float32: false } };
  if (t === 'f32' || t === 'f64') return { ...base, kind: 'number', number: { integer: false, min: -(t === 'f32' ? F32_MAX : Number.MAX_VALUE), max: t === 'f32' ? F32_MAX : Number.MAX_VALUE, float32: t === 'f32' } };
  if (t === 'bool') return { ...base, kind: 'bool' };
  if (STRINGS.has(t)) return { ...base, kind: 'string' };
  if (ASSET_REF.has(t)) {
    const refs = global?.ExternalAssetReferences ?? [];
    return { ...base, kind: 'asset', options: [{ label: '(none)', value: -1 }, ...refs.map((r, i) => ({ label: `${r.PrimaryAssetType}/${r.PrimaryAssetName}`, value: i }))] };
  }
  const opts = enumOptions(schema, t);
  if (opts) return { ...base, kind: 'enum', options: opts };
  const fields = structFields(schema, t);
  if (fields) {
    const kind = structKind(fields);
    const sub = fields.map(([f, ft]) => describeType(schema, ft, f, global, depth + 1));
    return { ...base, kind, fields: sub, ...(kind === 'colour' ? { colour: { channels: fields.map(([f]) => f), float: fields.some(([, ft]) => ft === 'f32' || ft === 'f64') } } : {}) };
  }
  const alts = variantAlts(schema, t);
  if (alts) return { ...base, kind: 'variant', alternatives: alts.map((a) => describeType(schema, a, typeText(a), global, depth + 1)) };
  return { ...base, kind: 'raw' };   // weak_object and anything this schema doesn't define
}

// ---------------------------------------------------------------------------------------------
// Validation and defaults

/** Why a value doesn't fit its schema type, or null when it does. */
export function checkValue(schema: Schema, t: SchemaType, x: unknown, at = 'value', depth = 0): string | null {
  if (depth > 64) return `${at}: nested too deeply`;
  if (typeof t !== 'string') {
    switch (t.kind) {
      case 'map': {
        if (!(x instanceof Map)) return `${at}: expected a Map`;
        for (const [k, v] of x) {
          const e = checkValue(schema, t.key, k, `${at} key`, depth + 1) ?? checkValue(schema, t.value, v, `${at}[${String(k)}]`, depth + 1);
          if (e) return e;
        }
        return null;
      }
      case 'array': case 'packed': case 'fixed': {
        if (!Array.isArray(x)) return `${at}: expected an array`;
        if (t.kind === 'fixed' && x.length !== t.n) return `${at}: expected exactly ${t.n} elements`;
        for (let i = 0; i < x.length; i++) {
          const e = checkValue(schema, t.of, x[i], `${at}[${i}]`, depth + 1);
          if (e) return e;
        }
        return null;
      }
    }
  }
  const range = INT_RANGE[t];
  if (range) {
    if (typeof x === 'bigint') {
      // 64-bit values beyond 2^53 stay bigints so they round-trip exactly
      const [lo, hi] = BIG_RANGE[t] ?? [0n, -1n];
      return x >= lo && x <= hi ? null : `${at}: ${t} out of range`;
    }
    if (typeof x !== 'number' || !Number.isInteger(x)) return `${at}: ${t} needs a whole number`;
    if (x < range[0] || x > range[1]) return `${at}: ${t} must be in ${range[0]}..${range[1]}`;
    return null;
  }
  if (t === 'f32' || t === 'f64') {
    if (typeof x !== 'number' || !Number.isFinite(x)) return `${at}: ${t} needs a finite number`;
    if (t === 'f32' && Math.abs(x) > F32_MAX) return `${at}: out of f32 range`;
    return null;
  }
  if (t === 'bool') return typeof x === 'boolean' ? null : `${at}: expected true/false`;
  if (STRINGS.has(t)) return typeof x === 'string' ? null : `${at}: expected a string`;
  if (ASSET_REF.has(t)) return typeof x === 'number' && Number.isInteger(x) && x >= -1 ? null : `${at}: expected an asset index (-1 = none)`;
  const opts = enumOptions(schema, t);
  if (opts) {
    if (typeof x !== 'number') return `${at}: expected an enum value`;
    return opts.length === 0 || opts.some((o) => o.value === x) ? null : `${at}: ${x} is not a value of ${t}`;
  }
  const fields = structFields(schema, t);
  if (fields) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return `${at}: expected a ${t} struct`;
    const rec = x as MpsObject;
    for (const [f, ft] of fields) {
      if (!(f in rec)) return `${at}.${f}: missing`;
      const e = checkValue(schema, ft, rec[f], `${at}.${f}`, depth + 1);
      if (e) return e;
    }
    return null;
  }
  const alts = variantAlts(schema, t);
  if (alts) {
    const v = x as VariantValue;
    if (!v || typeof v !== 'object' || typeof v.variant !== 'number' || !alts[v.variant]) return `${at}: expected a ${t} variant {variant, value}`;
    return checkValue(schema, alts[v.variant]!, v.value, `${at}<${typeText(alts[v.variant]!)}>`, depth + 1);
  }
  return null;   // raw types (weak_object, …): anything the encoder can pack
}

/** A zero value of a schema type (new variant alternatives, map entries, array elements). */
export function defaultValue(schema: Schema, t: SchemaType, depth = 0): unknown {
  if (typeof t !== 'string') {
    switch (t.kind) {
      case 'map': return new Map();
      case 'array': case 'packed': return [];
      case 'fixed': return Array.from({ length: t.n }, () => defaultValue(schema, t.of, depth + 1));
    }
  }
  if (t in INT_RANGE || t === 'f32' || t === 'f64') return 0;
  if (t === 'bool') return false;
  if (STRINGS.has(t)) return '';
  if (ASSET_REF.has(t)) return -1;
  const opts = enumOptions(schema, t);
  if (opts) return opts[0]?.value ?? 0;
  const fields = structFields(schema, t);
  if (fields) return Object.fromEntries(fields.map(([f, ft]) => [f, depth > 32 ? null : defaultValue(schema, ft, depth + 1)]));
  const alts = variantAlts(schema, t);
  if (alts?.length) {
    const a = alts[0]!;
    return { variant: 0, type: altLabel(a), value: defaultValue(schema, a, depth + 1) } satisfies VariantValue;
  }
  return 0;
}

/** The `type` label decodeSoa gives a variant alternative. */
const altLabel = (a: SchemaType): string => (typeof a === 'string' ? a : JSON.stringify(a));

/** Stores a number the way it will read back (f32 fields hold float32 values). */
function normalise(t: SchemaType, x: unknown): unknown {
  return t === 'f32' && typeof x === 'number' ? Math.fround(x) : x;
}

// ---------------------------------------------------------------------------------------------
// The store

export interface ComponentChunk {
  path: string;
  grid: number;
  chunk: ChunkKey;
  schema: Schema;
  file: SoaFile;
  original: Uint8Array;
  dirty: boolean;
}

export interface ComponentInstance {
  /** Stable while the store lives: `<grid>/<x_y_z>/<slot>`. */
  id: string;
  brickRef: BrickRef;
  /** Component type name (GlobalData ComponentTypeNames), e.g. a light or a gate. */
  type: string;
  typeIndex: number;
  /** Data struct name, or null when the type carries no data ("None"). */
  struct: string | null;
  /** The typed fields (the decoded struct, edited in place through setField). */
  data: MpsObject | null;
  chunk: ComponentChunk;
  /** Position in the chunk's per-instance data. */
  slot: number;
}

export class ComponentEditError extends Error {}

export class ComponentStore {
  readonly chunks: ComponentChunk[] = [];
  readonly instances: ComponentInstance[] = [];
  private readonly byBrick = new Map<string, ComponentInstance[]>();
  private readonly byId = new Map<string, ComponentInstance>();

  constructor(readonly ctx: SaveContext) {
    const names = ctx.global.ComponentTypeNames ?? [];
    for (const [path, bytes] of ctx.files) {
      const at = parseChunkPath(path);
      if (!at || at.kind !== 'Components') continue;
      const schema = ctx.schemaFor(path);
      const file = decodeSoa(bytes, schema, ctx.global);
      const ch: ComponentChunk = { path, grid: at.grid, chunk: at.chunk, schema, file, original: bytes, dirty: false };
      this.chunks.push(ch);
      // ComponentBrickIndices: one brick index per instance, in type-counter order. (Game saves
      // often store the list twice over; the first run is the one that pairs with the data.)
      const bi = (file.root.ComponentBrickIndices as number[] | undefined) ?? [];
      file.data.forEach((d, slot) => {
        const inst: ComponentInstance = {
          id: `${at.grid}/${chunkName(at.chunk)}/${slot}`,
          brickRef: { grid: at.grid, chunk: at.chunk, brick: bi[slot] ?? -1 },
          type: names[d.typeIndex] ?? `#${d.typeIndex}`, typeIndex: d.typeIndex, struct: d.struct, data: d.value, chunk: ch, slot,
        };
        this.instances.push(inst);
        this.byId.set(inst.id, inst);
        const k = brickKey(inst.brickRef);
        let list = this.byBrick.get(k);
        if (!list) this.byBrick.set(k, (list = []));
        list.push(inst);
      });
    }
  }

  get global(): ComponentGlobals {
    return this.ctx.global;
  }

  get(id: string): ComponentInstance | undefined {
    return this.byId.get(id);
  }

  /** Components on one brick (a brick can carry several, e.g. a light and a switch). */
  onBrick(ref: BrickRef): ComponentInstance[] {
    return this.byBrick.get(brickKey(ref)) ?? [];
  }

  /** Component types in this save: name, data struct and instance count. */
  types(): { type: string; struct: string | null; count: number }[] {
    const m = new Map<string, { type: string; struct: string | null; count: number }>();
    for (const c of this.instances) {
      const e = m.get(c.type) ?? { type: c.type, struct: c.struct, count: 0 };
      e.count++;
      m.set(c.type, e);
    }
    return [...m.values()];
  }

  /** Editor descriptors for an instance's fields, in schema order (empty for data-less types). */
  describe(c: ComponentInstance): FieldDescriptor[] {
    if (!c.struct) return [];
    return (structFields(c.chunk.schema, c.struct) ?? []).map(([f, t]) => describeType(c.chunk.schema, t, f, this.global));
  }

  /** The schema type at a field path (struct field names, array indices, map keys, 'value' into a variant). */
  typeAt(c: ComponentInstance, path: readonly (string | number)[]): SchemaType {
    if (!c.struct) throw new ComponentEditError(`${c.type} has no data`);
    const s = c.chunk.schema;
    let t: SchemaType = c.struct, x: unknown = c.data;
    for (const step of path) {
      [t, x] = stepInto(s, t, x, step);
    }
    return t;
  }

  /** Reads a value by field path. */
  getField(c: ComponentInstance, path: readonly (string | number)[]): unknown {
    if (!c.struct) return undefined;
    let t: SchemaType = c.struct, x: unknown = c.data;
    for (const step of path) [t, x] = stepInto(c.chunk.schema, t, x, step);
    return x;
  }

  /**
   * Sets a value by field path, after checking it against the field's schema type (throws
   * ComponentEditError otherwise). An empty path replaces the whole data struct.
   */
  setField(c: ComponentInstance, path: readonly (string | number)[], value: unknown): void {
    if (!c.struct || !c.data) throw new ComponentEditError(`${c.type} has no data to edit`);
    const s = c.chunk.schema;
    if (path.length === 0) {
      const e = checkValue(s, c.struct, value, c.struct);
      if (e) throw new ComponentEditError(e);
      const v = deepNormalise(s, c.struct, value) as MpsObject;
      c.data = v;
      c.chunk.file.data[c.slot]!.value = v;
      c.chunk.dirty = true;
      return;
    }
    let t: SchemaType = c.struct, parent: unknown = c.data;
    for (const step of path.slice(0, -1)) [t, parent] = stepInto(s, t, parent, step);
    const last = path[path.length - 1]!;
    const [ft] = stepInto(s, t, parent, last);
    if (typeof t === 'string' && variantAlts(s, t) && last !== 'value') throw new ComponentEditError('a variant can only be set whole, or through "value"; use setVariant to switch alternatives');
    const e = checkValue(s, ft, value, path.join('.'));
    if (e) throw new ComponentEditError(e);
    const v = deepNormalise(s, ft, value);
    if (parent instanceof Map) parent.set(mapKey(parent, last), v);
    else (parent as Record<string | number, unknown>)[last] = v;
    c.chunk.dirty = true;
  }

  /** Switches a variant field to another alternative, with that alternative's zero value (or `value`). */
  setVariant(c: ComponentInstance, path: readonly (string | number)[], alternative: number, value?: unknown): void {
    const t = this.typeAt(c, path);
    const alts = typeof t === 'string' ? variantAlts(c.chunk.schema, t) : undefined;
    if (!alts) throw new ComponentEditError(`${path.join('.')} is not a variant`);
    const a = alts[alternative];
    if (a === undefined) throw new ComponentEditError(`${typeText(t)} has no alternative ${alternative}`);
    this.setField(c, path, { variant: alternative, type: altLabel(a), value: value === undefined ? defaultValue(c.chunk.schema, a) : value } satisfies VariantValue);
  }

  /** Adds or replaces a Map entry (path points at the map). */
  setMapEntry(c: ComponentInstance, path: readonly (string | number)[], key: unknown, value: unknown): void {
    const t = this.typeAt(c, path), m = this.getField(c, path);
    if (typeof t === 'string' || t.kind !== 'map' || !(m instanceof Map)) throw new ComponentEditError(`${path.join('.')} is not a map`);
    const e = checkValue(c.chunk.schema, t.key, key, 'key') ?? checkValue(c.chunk.schema, t.value, value, `[${String(key)}]`);
    if (e) throw new ComponentEditError(e);
    m.set(normalise(t.key, key), deepNormalise(c.chunk.schema, t.value, value));
    c.chunk.dirty = true;
  }

  deleteMapEntry(c: ComponentInstance, path: readonly (string | number)[], key: unknown): boolean {
    const m = this.getField(c, path);
    if (!(m instanceof Map)) throw new ComponentEditError(`${path.join('.')} is not a map`);
    const ok = m.delete(mapKey(m, key as string | number));
    if (ok) c.chunk.dirty = true;
    return ok;
  }

  /** True when any chunk was edited. */
  get dirty(): boolean {
    return this.chunks.some((c) => c.dirty);
  }

  /** Bytes of one chunk as it stands now. */
  encodeChunk(ch: ComponentChunk): Uint8Array {
    return encodeSoa(ch.file, ch.schema);
  }

  /**
   * The save's files with edited component chunks re-encoded (encodeSoa); everything else is
   * the original bytes. `force` re-encodes every chunk (round-trip checks).
   */
  encode(opts: { force?: boolean; into?: FileMap } = {}): FileMap {
    const out: FileMap = opts.into ?? new Map(this.ctx.files);
    for (const ch of this.chunks) if (ch.dirty || opts.force) out.set(ch.path, this.encodeChunk(ch));
    return out;
  }
}

function mapKey(m: Map<unknown, unknown>, k: unknown): unknown {
  if (m.has(k)) return k;
  // map keys given as text from a UI: match a number key by its string form
  for (const key of m.keys()) if (String(key) === String(k)) return key;
  return k;
}

function stepInto(s: Schema, t: SchemaType, x: unknown, step: string | number): [SchemaType, unknown] {
  if (typeof t !== 'string') {
    if (t.kind === 'map') {
      if (!(x instanceof Map)) throw new ComponentEditError('expected a map');
      return [t.value, x.get(mapKey(x, step))];
    }
    const i = Number(step);
    if (!Array.isArray(x) || !Number.isInteger(i) || i < 0 || i >= (t.kind === 'fixed' ? t.n : x.length)) throw new ComponentEditError(`bad index ${String(step)}`);
    return [t.of, x[i]];
  }
  const fields = structFields(s, t);
  if (fields) {
    const f = fields.find(([n]) => n === step);
    if (!f) throw new ComponentEditError(`${t} has no field ${String(step)}`);
    return [f[1], (x as MpsObject)[f[0]]];
  }
  const alts = variantAlts(s, t);
  if (alts) {
    const v = x as VariantValue;
    if (step !== 'value' && step !== 'variant') throw new ComponentEditError(`step into a variant with "value", not ${String(step)}`);
    return step === 'value' ? [alts[v.variant]!, v.value] : ['u32', v.variant];
  }
  throw new ComponentEditError(`${t} has no fields`);
}

/** Copies a value into the model's shape: f32 values rounded to float32, variant `type` filled in. */
function deepNormalise(s: Schema, t: SchemaType, x: unknown): unknown {
  if (typeof t !== 'string') {
    if (t.kind === 'map') return new Map([...(x as Map<unknown, unknown>)].map(([k, v]) => [deepNormalise(s, t.key, k), deepNormalise(s, t.value, v)]));
    return (x as unknown[]).map((e) => deepNormalise(s, t.of, e));
  }
  const fields = structFields(s, t);
  if (fields) return Object.fromEntries(fields.map(([f, ft]) => [f, deepNormalise(s, ft, (x as MpsObject)[f])]));
  const alts = variantAlts(s, t);
  if (alts) {
    const v = x as VariantValue, a = alts[v.variant]!;
    return { variant: v.variant, type: altLabel(a), value: deepNormalise(s, a, v.value) } satisfies VariantValue;
  }
  return normalise(t, x);
}

/** Reads every component chunk of a save (all grids). */
export function loadComponents(files: FileMap, opts: LoadOptions = {}): ComponentStore {
  return new ComponentStore(saveContext(files, opts));
}

/** Shorthand: editor descriptors for an instance. */
export function describeComponent(store: ComponentStore, c: ComponentInstance): FieldDescriptor[] {
  return store.describe(c);
}
