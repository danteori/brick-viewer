// Re-encoding chunks written with an older schema (FORMAT.md 0.2 and 4).
//
// In a multi-revision .brdb an unchanged chunk keeps the bytes it was written with, after later
// saves replaced the shared .schema and GlobalData. Copying the live bytes into one flat tree
// (a new world, a .brz archive) would pair those bytes with the wrong schema. flattenTree
// decodes each stale chunk with its own schema and GlobalData and encodes it with the live ones.
//
// What the conversion knows (and nothing else; an unknown change throws StaleSchemaError so we
// never guess what the game would fill in):
//   - fields present in both schemas are copied (structs recursively, enums by name, variants by
//     alternative type);
//   - fields the current schema dropped are dropped (warned once), e.g. CollisionFlags_Tool and
//     the entity WeldParent* fields;
//   - new fields with a documented meaning get it:
//       OriginalOwnerIndices (bricks, entities)  = OwnerIndices (what the reader assumes)
//       brick CollisionFlags_* (bit flags)      = all set (the game's default, as world.ts writes)
//       bColorsAreLinear (bricks, entities)      chunks without it store linear colour bytes, so
//                                               by default they're converted to sRGB and the
//                                               flag written false, as the game writes today
//                                               ({colours: 'flag'} keeps the bytes, writes true)
//       grid ChunkIndex ChunkSizes / ChunkOffsets = 2048 / 0 for grid 1, 1024 for dynamic grids
//   - GlobalData name lists must have only grown (append-only) since the chunk was written; then
//     every index stays valid, except that procedural brick type indices start after the basic
//     asset list, so they're shifted when that list grew.

import { bytesEqual } from './brz.ts';
import { decodeMps, encodeSoa, MPS_TRAILER, type MpsObject, type Schema, type SchemaType, type SoaFile, type VariantValue } from './schema.ts';
import { decodeWritten, GLOBAL_MPS, GLOBAL_SCHEMA, schemaOf, schemaPathIn, writtenGlobalData, writtenSchema, type SaveView } from './saveview.ts';
import type { FileMap } from './brz.ts';
import type { MsgValue } from './msgpack.ts';
import { MsgMap } from './msgpack.ts';

export interface ReencodeOptions {
  /** Chunks without bColorsAreLinear store linear bytes: 'convert' to sRGB (default) or keep them and 'flag' them linear. */
  colours?: 'convert' | 'flag';
}

/** A chunk can't be brought to the current schema without guessing. */
export class StaleSchemaError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'StaleSchemaError';
  }
}

/** GlobalData lists that chunk, component, wire and entity indices point into. */
const INDEXED_LISTS = ['BasicBrickAssetNames', 'ProceduralBrickAssetNames', 'MaterialAssetNames', 'ComponentTypeNames', 'ComponentDataStructNames',
  'ComponentWirePortNames', 'EntityTypeNames', 'EntityDataClassNames', 'ExternalAssetReferences'];

/** Files whose values index GlobalData. */
const usesGlobal = (p: string): boolean => /^World\/0\/(Bricks\/Grids\/[^/]+\/(Chunks|Components|Wires)|Entities\/Chunks)\/[^/]+\.mps$/.test(p);

const json = (v: unknown): string => JSON.stringify(v, (_, x: unknown) => (x instanceof Map ? [...x] : x instanceof Uint8Array ? [...x] : x));

/** How GlobalData changed between a chunk's write and now: null = indices still valid as they are. */
function globalChange(path: string, then: MpsObject | null, now: MpsObject | null): { basicGrowth: number } | null {
  if (!then || !now) return null;
  let basicGrowth = 0;
  for (const k of INDEXED_LISTS) {
    const a = (then[k] as unknown[] | undefined) ?? [], b = (now[k] as unknown[] | undefined) ?? [];
    if (a.length > b.length || a.some((x, i) => json(x) !== json(b[i]))) {
      throw new StaleSchemaError(path, `GlobalData.${k} changed (not just appended to) since this chunk was written; its indices can't be trusted`);
    }
    if (k === 'BasicBrickAssetNames') basicGrowth = b.length - a.length;
  }
  return basicGrowth ? { basicGrowth } : null;
}

const SRGB = ((): Uint8Array => {
  const t = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const l = v / 255, s = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    t[v] = Math.round(255 * s);
  }
  return t;
})();

/** Linear colour byte -> sRGB byte: round(255 * srgb_oetf(v / 255)) (FORMAT.md 3.2). */
export const linearToSrgbByte = (v: number): number => SRGB[v & 255]!;

interface Ctx {
  path: string;
  os: Schema;
  ns: Schema;
  opts: ReencodeOptions;
  warnings: Set<string>;
  /** Grid folder of a grid ChunkIndex.mps, else null. */
  grid: string | null;
}

const LEGACY: Record<string, string[]> = { Vector: ['X', 'Y', 'Z'], Rotator: ['Pitch', 'Yaw', 'Roll'], Quat: ['X', 'Y', 'Z', 'W'], LinearColor: ['R', 'G', 'B', 'A'], WireGraphExec: [] };
const fieldsOf = (s: Schema, t: string): [string, SchemaType][] | undefined => s.S.get(t) ?? (LEGACY[t] ? LEGACY[t].map((f) => [f, 'f64'] as [string, SchemaType]) : undefined);
const typeKey = (t: SchemaType): string => (typeof t === 'string' ? t : JSON.stringify(t));

function enumNames(table: MsgValue | undefined): Map<number, string> | null {
  if (table instanceof MsgMap) return new Map(table.map(([k, v]) => [Number(v), String(k)]));
  if (Array.isArray(table)) return new Map(table.map((k, i) => [i, String(k)]));
  return null;
}

function allOnes(n: number): number[] {
  const bits = new Array<number>((n + 7) >> 3).fill(0);
  for (let i = 0; i < n; i++) bits[i >> 3]! |= 1 << (i & 7);
  return bits;
}

/** Value of a field the current schema has and the chunk's schema didn't; undefined = unknown. */
function defaultFor(struct: string, field: string, old: MpsObject, ctx: Ctx): unknown {
  if (struct === 'BRSavedBrickChunkSoA') {
    const n = (old.BrickTypeIndices as unknown[]).length;
    if (field === 'OriginalOwnerIndices') return [...(old.OwnerIndices as number[])];
    if (field.startsWith('CollisionFlags_')) return { Flags: allOnes(n) };
    if (field === 'bColorsAreLinear') return ctx.opts.colours === 'flag';
  }
  if (struct === 'BRSavedEntityChunkSoA') {
    if (field === 'OriginalOwnerIndices') return [...(old.OwnerIndices as number[])];
    if (field === 'bColorsAreLinear') return ctx.opts.colours === 'flag';
  }
  if (struct === 'BRSavedBrickChunkIndexSoA' && ctx.grid !== null) {
    const n = (old.Chunk3DIndices as unknown[]).length, o = ctx.grid === '1' ? 0 : 1024;
    if (field === 'ChunkSizes') return new Array<number>(n).fill(2048);
    if (field === 'ChunkOffsets') return Array.from({ length: n }, () => ({ X: o, Y: o, Z: o }));
  }
  return undefined;
}

function convertStruct(v: MpsObject, oname: string, nname: string, ctx: Ctx): MpsObject {
  const of = fieldsOf(ctx.os, oname), nf = fieldsOf(ctx.ns, nname);
  if (!of || !nf) throw new StaleSchemaError(ctx.path, `struct ${nname} is missing from one of the schemas`);
  const oldTypes = new Map(of), out: MpsObject = {};
  for (const [f, nt] of nf) {
    const ot = oldTypes.get(f);
    if (ot !== undefined) { out[f] = convert(v[f], ot, nt, ctx); continue; }
    const d = defaultFor(nname, f, v, ctx);
    if (d === undefined) throw new StaleSchemaError(ctx.path, `${nname}.${f} is new in the current schema and has no known default`);
    out[f] = d;
  }
  for (const [f] of of) if (!nf.some(([g]) => g === f)) ctx.warnings.add(`dropped ${nname}.${f} (not in the current schema)`);
  return out;
}

function convert(v: unknown, ot: SchemaType, nt: SchemaType, ctx: Ctx): unknown {
  if (typeof ot !== 'string' || typeof nt !== 'string') {
    if (typeof ot === 'string' || typeof nt === 'string' || ot.kind !== nt.kind) throw new StaleSchemaError(ctx.path, `type changed from ${typeKey(ot)} to ${typeKey(nt)}`);
    switch (nt.kind) {
      case 'array': case 'packed': {
        const of = (ot as { of: SchemaType }).of, list = v as unknown[];
        const out = list.map((x) => convert(x, of, nt.of, ctx));
        // keep markers such as "stored as nil" so unchanged values encode as they were
        for (const sym of Object.getOwnPropertySymbols(list)) Object.defineProperty(out, sym, { value: (list as unknown as Record<symbol, unknown>)[sym] });
        return out;
      }
      case 'fixed': {
        const o = ot as { of: SchemaType; n: number };
        if (o.n !== nt.n) throw new StaleSchemaError(ctx.path, `fixed array length changed (${o.n} -> ${nt.n})`);
        return (v as unknown[]).map((x) => convert(x, o.of, nt.of, ctx));
      }
      case 'map': {
        const o = ot as { key: SchemaType; value: SchemaType }, out = new Map<unknown, unknown>();
        for (const [k, x] of v as Map<unknown, unknown>) out.set(convert(k, o.key, nt.key, ctx), convert(x, o.value, nt.value, ctx));
        return out;
      }
    }
  }
  if (fieldsOf(ctx.ns, nt) && fieldsOf(ctx.os, ot)) return convertStruct(v as MpsObject, ot, nt, ctx);
  if (ctx.ns.E.has(nt) || ctx.os.E.has(ot)) {
    const a = ctx.os.E.get(ot), b = ctx.ns.E.get(nt);
    if (json(a) === json(b)) return v;
    const names = enumNames(a), back = enumNames(b);
    const name = names?.get(v as number);
    const hit = back && name !== undefined ? [...back].find(([, n]) => n === name) : undefined;
    if (!hit) throw new StaleSchemaError(ctx.path, `enum ${nt} value ${String(v)} has no match in the current schema`);
    return hit[0];
  }
  const oa = ctx.os.V.get(ot), na = ctx.ns.V.get(nt);
  if (oa || na) {
    if (!oa || !na) {
      if (json(oa) === json(na) || ot === nt) return v;   // legacy lower-case variants decode by a fixed table on both sides
      throw new StaleSchemaError(ctx.path, `variant ${nt} has no table in one of the schemas`);
    }
    const x = v as VariantValue, alt = oa[x.variant]!, j = na.findIndex((t) => typeKey(t) === typeKey(alt));
    if (j < 0) throw new StaleSchemaError(ctx.path, `variant ${nt} lost the alternative ${typeKey(alt)}`);
    return { variant: j, type: typeKey(na[j]!), value: convert(x.value, alt, na[j]!, ctx) } satisfies VariantValue;
  }
  if (ot !== nt) {
    const ints = /^[ui](8|16|32|64)$/;
    if (ints.test(ot) && ints.test(nt)) return v;
    if (/^f(32|64)$/.test(ot) && /^f(32|64)$/.test(nt)) return v;
    throw new StaleSchemaError(ctx.path, `type changed from ${ot} to ${nt}`);
  }
  return v;
}

function srgbColour(c: Record<string, number>): Record<string, number> {
  return { ...c, R: linearToSrgbByte(c.R!), G: linearToSrgbByte(c.G!), B: linearToSrgbByte(c.B!) };
}

/**
 * The bytes `mpsPath` (from `source`, a tree that knows what each file was written with) should
 * have in `target` (the flat tree being written, whose schemas and GlobalData are the live ones),
 * or null when its bytes already fit. Throws StaleSchemaError when that needs a guess.
 */
export function reencodeForTarget(source: SaveView, mpsPath: string, target: SaveView, opts: ReencodeOptions = {}, warnings = new Set<string>()): Uint8Array | null {
  const ws = writtenSchema(source, mpsPath);
  if (!ws) return null;
  const tPath = schemaPathIn(target, mpsPath), tBytes = tPath ? target.get(tPath) : undefined;
  if (!tBytes) return null;
  const sameSchema = bytesEqual(ws.bytes, tBytes);
  let shift: { basicGrowth: number } | null = null;
  if (usesGlobal(mpsPath)) {
    const tg = target.get(GLOBAL_MPS), tgs = target.get(GLOBAL_SCHEMA);
    shift = globalChange(mpsPath, writtenGlobalData(source, mpsPath), tg && tgs ? decodeMps(tg, schemaOf(tgs)) : null);
  }
  if (sameSchema && !shift) return null;
  const ns = schemaOf(tBytes);
  let file: ReturnType<typeof decodeWritten>;
  try {
    file = decodeWritten(source, mpsPath);
  } catch (e) {
    throw new StaleSchemaError(mpsPath, `can't be decoded with the schema it was written with (${(e as Error).message})`);
  }
  if ((file.root as { [MPS_TRAILER]?: Uint8Array })[MPS_TRAILER]?.length) throw new StaleSchemaError(mpsPath, 'has bytes the old schema does not describe');
  const grid = /^World\/0\/Bricks\/Grids\/([^/]+)\/ChunkIndex\.mps$/.exec(mpsPath)?.[1] ?? null;
  const ctx: Ctx = { path: mpsPath, os: file.schema, ns, opts, warnings, grid };
  if (file.schema.root !== ns.root) throw new StaleSchemaError(mpsPath, `root struct changed (${file.schema.root} -> ${ns.root})`);
  const root = convertStruct(file.root, file.schema.root, ns.root, ctx);
  const oldRoot = new Set(file.schema.S.get(file.schema.root)!.map(([f]) => f));
  if (!oldRoot.has('bColorsAreLinear') && root.bColorsAreLinear === false && Array.isArray(root.ColorsAndAlphas)) {
    if (ns.root === 'BRSavedBrickChunkSoA') root.ColorsAndAlphas = (root.ColorsAndAlphas as Record<string, number>[]).map(srgbColour);
    else if (ns.root === 'BRSavedEntityChunkSoA') {
      root.ColorsAndAlphas = (root.ColorsAndAlphas as Record<string, Record<string, number>>[]).map((slots) =>
        Object.fromEntries(Object.entries(slots).map(([k, c]) => [k, srgbColour(c)])));
    }
  }
  if (shift && ns.root === 'BRSavedBrickChunkSoA') {
    const start = root.ProceduralBrickStartingIndex as number;
    if (start > 0) {
      root.BrickTypeIndices = (root.BrickTypeIndices as number[]).map((t) => (t >= start ? t + shift.basicGrowth : t));
      root.ProceduralBrickStartingIndex = start + shift.basicGrowth;
    }
  }
  const data: SoaFile['data'] = file.data.map((d) => ({ ...d, value: d.struct && d.value ? convertStruct(d.value, d.struct, d.struct, ctx) : d.value }));
  for (const d of file.data) if (d.struct && !ns.S.has(d.struct)) throw new StaleSchemaError(mpsPath, `data struct ${d.struct} is missing from the current schema`);
  const out = encodeSoa({ root, data }, ns);
  // a schema that only gained unrelated structs (ComponentsShared lists what the save uses) leaves the bytes as they were
  return bytesEqual(out, source.get(mpsPath)!) ? null : out;
}

export interface FlattenResult {
  /** The tree with every file matching the live schemas, in the source's order. */
  files: FileMap;
  /** Paths whose bytes were re-encoded. */
  reencoded: string[];
  warnings: string[];
  /** With `skipStale`: files left out because they can't be converted without a guess. */
  skipped: string[];
}

export interface FlattenOptions extends ReencodeOptions {
  /**
   * Leave out (instead of throwing on) the files that can't be converted to the live schemas
   * without a guess, listing them in `skipped`. Only for showing a world: a save written from such
   * a tree would lose those files, so a save template is flattened without it.
   */
  skipStale?: boolean;
}

/**
 * One self-consistent flat tree from a versioned one (a BrdbTree, live or at a revision): what
 * "save as new world" and the world archive .brz are written from. Files that already match the
 * live schemas keep their bytes.
 */
export function flattenTree(tree: SaveView, opts: FlattenOptions = {}): FlattenResult {
  const files: FileMap = new Map(), reencoded: string[] = [], warnings = new Set<string>(), skipped: string[] = [];
  for (const p of tree.paths()) files.set(p, tree.get(p)!);
  const target: SaveView = { paths: () => [...files.keys()], has: (p) => files.has(p), get: (p) => files.get(p), asWrittenWith: (p) => files.get(p) };
  for (const p of tree.paths()) {
    if (!p.endsWith('.mps')) continue;
    let again: Uint8Array | null;
    try { again = reencodeForTarget(tree, p, target, opts, warnings); }
    catch (e) {
      if (!opts.skipStale || !(e instanceof StaleSchemaError)) throw e;
      files.delete(p); skipped.push(p);
      continue;
    }
    if (again) { files.set(p, again); reencoded.push(p); }
  }
  return { files, reencoded, warnings: [...warnings], skipped };
}
