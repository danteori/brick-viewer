import type { FileMap } from '../format/brz.ts';
import { ByteBuf, MsgMap, MsgReader, type MsgValue } from '../format/msgpack.ts';
import { decodeMps, encodeMps, parseSchema, type MpsObject, type Schema, type SchemaType } from '../format/schema.ts';
import { extractBricks, forEachRawBrickChunk, rebuildFromLoaded, type BrickChunk, type ChunkIndex, type PlainBrick } from '../format/world.ts';
import { entityLayoutProblem, editEntities, GRID_TYPE, packValue, type NewGridEntity } from '../format/entitywrite.ts';
import { readEntities, type EntityRecord, type Quat, type Vec3 } from '../format/entities.ts';
import { fileMapView } from '../format/saveview.ts';
import { linearToSrgbByte, srgbToLinearByte } from '../format/palette.ts';
import { ComponentEditError, ComponentStore, brickKey, checkValue, cloneValue, defaultValue, saveContext, type BrickRef, type ChunkKey } from './components.ts';
import { WireGraph } from './wires.ts';
import { IDENT, apply3, axisQuat, mul3, quatMul, turnOrient, type Mat3 } from './dyngrids.ts';

export type PartMode = 'replace' | 'add';

export interface ImportParts {
  bricks: number;
  entities: number;
  environment: boolean;
  other: boolean;
}

export interface MergeChoice {
  bricks?: PartMode;
  entities?: PartMode;
  environment?: boolean;
  other?: boolean;
}

export interface Placement {
  turns?: number;
  offset?: readonly number[];
  drop?: ReadonlySet<number>;
}

export interface MergeResult {
  files: FileMap;
  dropped: number;
  warnings: string[];
}

const W = 'World/0/';
const GLOBAL_SCHEMA = W + 'GlobalData.schema', GLOBAL_MPS = W + 'GlobalData.mps';
const OWNERS_SCHEMA = W + 'Owners.schema', OWNERS_MPS = W + 'Owners.mps';
const ENVIRONMENT = [W + 'Environment.bp', 'Meta/World.json'];
const GRID_DIR = (g: number | string): string => `${W}Bricks/Grids/${g}/`;
const SAVE_CHUNK = 2048;
const COUNTER_ROOTS = new Set(['ComponentTypeCounters', 'ComponentBrickIndices']);
const ASSET_REF = new Set(['object', 'class']);

const isOther = (p: string): boolean => p === W + 'Minigame.bp' || p.startsWith('GameMode/') || p.startsWith('Prefabs/');
const isGridFile = (p: string): boolean => p.startsWith(W + 'Bricks/Grids/');

export const zTurn = (turns: number): Mat3 => {
  let m: Mat3 = IDENT;
  for (let k = 0; k < (((turns % 4) + 4) % 4); k++) m = mul3([[0, -1, 0], [1, 0, 0], [0, 0, 1]], m);
  return m;
};

/** A position turned `turns` quarter turns about Z through the origin, then moved by `offset`. */
export function placePos(pos: readonly number[], turns: number, offset: readonly number[] = [0, 0, 0]): Vec3 {
  return apply3(zTurn(turns), pos).map((v, i) => v + (offset[i] ?? 0)) as Vec3;
}

/**
 * The offset (save units) that puts the import's outline, turned `turns` quarter turns about Z,
 * with its low corner at `pose` (viewer units, `unit` viewer units a save unit).
 */
export function prefabOffset(low: readonly number[], size: readonly number[], turns: number, pose: readonly number[], unit: number): Vec3 {
  const R = zTurn(turns), corners = [[0, 0], [size[0]!, 0], [0, size[1]!], [size[0]!, size[1]!]].map(([x, y]) => apply3(R, [x!, y!, 0]));
  const shift = [0, 1].map((i) => -Math.min(...corners.map((c) => c[i]!)));
  const turnedLow = apply3(R, low);
  return [0, 1, 2].map((i) => Math.round(pose[i]! / unit) + (shift[i] ?? 0) - Math.round(turnedLow[i]!)) as Vec3;
}

/** Grid-1 bricks of an import, turned and moved as they will be added. */
export function placedBricks(bricks: readonly PlainBrick[], turns = 0, offset: readonly number[] = [0, 0, 0]): PlainBrick[] {
  const R = zTurn(turns);
  return bricks.map((b) => ({ ...b, pos: placePos(b.pos, turns, offset), orient: turns % 4 ? turnOrient(R, b.orient) : b.orient }));
}

function countGridBricks(files: FileMap, grid: string): number {
  let n = 0;
  try { forEachRawBrickChunk(files, (ch) => { n += ch.BrickTypeIndices.length; }, { grid }); } catch { return 0; }
  return n;
}

function entitiesOf(files: FileMap): EntityRecord[] {
  try { return readEntities(fileMapView(files)).entities; } catch { return []; }
}

const hasGrid = (files: FileMap, id: number): boolean => files.has(GRID_DIR(id) + 'ChunkIndex.mps');

function gridEntities(files: FileMap): EntityRecord[] {
  return entitiesOf(files).filter((e) => e.type === GRID_TYPE && hasGrid(files, e.persistentIndex));
}

/** What an import file holds, per part of the dialog. */
export function importParts(files: FileMap): ImportParts {
  return {
    bricks: countGridBricks(files, '1'),
    entities: gridEntities(files).length,
    environment: ENVIRONMENT.some((p) => files.has(p)),
    other: [...files.keys()].some(isOther),
  };
}

// --- schemas -----------------------------------------------------------------------------------------

function topOf(bytes: Uint8Array): MsgValue[] {
  return new MsgReader(bytes).next() as MsgValue[];
}

/** The base schema with the import's missing enums, variants and structs added (and missing root fields, when `rootFields`). */
export function mergeSchemaBytes(base: Uint8Array, add: Uint8Array, rootFields = false): Uint8Array {
  const bs = parseSchema(base), as = parseSchema(add);
  const top = topOf(base), atop = topOf(add);
  let changed = false;
  const enums = top[0] as MsgMap;
  for (const [n, t] of atop[0] as MsgMap) if (!bs.E.has(String(n))) { enums.push([n, t]); changed = true; }
  if (top.length > 2 && atop.length > 2 && atop[1] instanceof MsgMap && atop[1].length) {
    if (!(top[1] instanceof MsgMap)) top[1] = new MsgMap();
    const vars = top[1] as MsgMap;
    for (const [n, a] of atop[1]) if (!bs.V.has(String(n))) { vars.push([n, a]); changed = true; }
  }
  const structs = top[top.length - 1] as MsgMap, astructs = atop[atop.length - 1] as MsgMap;
  let at = structs.findIndex(([n]) => String(n) === bs.root);
  if (at < 0) at = structs.length;
  for (const [n, f] of astructs) {
    if (bs.S.has(String(n))) continue;
    structs.splice(at++, 0, [n, f]);
    changed = true;
  }
  if (rootFields && as.root === bs.root) {
    const mine = structs.find(([n]) => String(n) === bs.root)?.[1] as MsgMap | undefined;
    const theirs = astructs.find(([n]) => String(n) === as.root)?.[1] as MsgMap | undefined;
    const have = new Set((bs.S.get(bs.root) ?? []).map(([f]) => f));
    for (const [f, t] of theirs ?? []) if (mine && !have.has(String(f))) { mine.push([f, t]); changed = true; }
  }
  if (!changed) return base;
  const o = new ByteBuf();
  packValue(o, top);
  return o.done();
}

/** Re-encodes an .mps for a widened schema: fields the old schema lacked get their zero value. */
function widen(out: FileMap, mpsPath: string, oldSchema: Uint8Array, newSchema: Uint8Array): void {
  const bytes = out.get(mpsPath);
  if (!bytes || oldSchema === newSchema) return;
  const ns = parseSchema(newSchema), v = decodeMps<MpsObject>(bytes, parseSchema(oldSchema));
  for (const [f, t] of ns.S.get(ns.root) ?? []) if (!(f in v)) v[f] = defaultValue(ns, t);
  out.set(mpsPath, encodeMps(v, ns));
}

function mergeSchemas(out: FileMap, add: FileMap): void {
  for (const [p, bytes] of add) {
    if (!p.endsWith('.schema') || isGridFile(p)) continue;
    const mine = out.get(p);
    if (!mine) { out.set(p, bytes); continue; }
    if (mine === bytes) continue;
    const wide = p === GLOBAL_SCHEMA || p === OWNERS_SCHEMA;
    const merged = mergeSchemaBytes(mine, bytes, wide);
    if (merged === mine) continue;
    out.set(p, merged);
    if (wide) widen(out, p.replace(/\.schema$/, '.mps'), mine, merged);
  }
}

// --- owners and global names -------------------------------------------------------------------------

const keyOf = (x: unknown): string => JSON.stringify(x, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)) ?? '';

function elementType(s: Schema, field: string): SchemaType | null {
  const t = s.S.get(s.root)?.find(([f]) => f === field)?.[1];
  return t && typeof t !== 'string' && (t.kind === 'array' || t.kind === 'packed') ? t.of : null;
}

/** Owner rows of the import -> rows of the base (matched by user id, else by name; new rows appended with zero counts). */
function mergeOwners(out: FileMap, add: FileMap): (i: number | undefined) => number {
  const bs = out.get(OWNERS_SCHEMA), bm = out.get(OWNERS_MPS), as = add.get(OWNERS_SCHEMA), am = add.get(OWNERS_MPS);
  if (!bs || !bm || !as || !am) return () => 0;
  const bschema = parseSchema(bs), mine = decodeMps<MpsObject>(bm, bschema), theirs = decodeMps<MpsObject>(am, parseSchema(as));
  const ids = (o: MpsObject): unknown[] | null => (Array.isArray(o.UserIds) ? o.UserIds : null);
  const names = (o: MpsObject): unknown[] | null => (Array.isArray(o.UserNames) ? o.UserNames : null);
  const rowsOf = (o: MpsObject): number => Math.max(0, ...Object.values(o).map((v) => (Array.isArray(v) ? v.length : 0)));
  const useIds = !!ids(mine) && !!ids(theirs);
  const index = new Map<string, number>();
  const keyAt = (o: MpsObject, i: number): string | null => {
    const l = useIds ? ids(o) : names(o);
    return l && i < l.length ? keyOf(l[i]) : null;
  };
  for (let i = 0; i < rowsOf(mine); i++) { const k = keyAt(mine, i); if (k !== null && !index.has(k)) index.set(k, i); }
  const map: number[] = [];
  let grew = false;
  for (let i = 0; i < rowsOf(theirs); i++) {
    const k = keyAt(theirs, i), hit = k === null ? undefined : index.get(k);
    if (hit !== undefined) { map.push(hit); continue; }
    const row = rowsOf(mine);
    for (const [f] of bschema.S.get(bschema.root) ?? []) {
      const list = mine[f];
      if (!Array.isArray(list)) continue;
      const from = theirs[f];
      if (/Counts$/.test(f)) list.push(0);
      else if (Array.isArray(from) && i < from.length) list.push(cloneValue(from[i]));
      else { const t = elementType(bschema, f); list.push(t ? defaultValue(bschema, t) : 0); }
    }
    if (k !== null) index.set(k, row);
    map.push(row);
    grew = true;
  }
  if (grew) out.set(OWNERS_MPS, encodeMps(mine, bschema));
  return (i) => map[i ?? 0] ?? 0;
}

interface AssetRef { PrimaryAssetType: string; PrimaryAssetName: string }

/** Component type names and asset references of the import added to the base GlobalData; returns the asset index map. */
function mergeGlobalNames(out: FileMap, add: FileMap): Map<number, number> {
  const assets = new Map<number, number>();
  const gs = out.get(GLOBAL_SCHEMA), gm = out.get(GLOBAL_MPS), as = add.get(GLOBAL_SCHEMA), am = add.get(GLOBAL_MPS);
  if (!gs || !gm || !as || !am) return assets;
  const schema = parseSchema(gs), g = decodeMps<MpsObject>(gm, schema), a = decodeMps<MpsObject>(am, parseSchema(as));
  let changed = false;
  const types = g.ComponentTypeNames, structs = g.ComponentDataStructNames;
  if (Array.isArray(types) && Array.isArray(a.ComponentTypeNames)) {
    (a.ComponentTypeNames as string[]).forEach((t, i) => {
      if (types.includes(t)) return;
      types.push(t);
      if (Array.isArray(structs)) structs.push((a.ComponentDataStructNames as string[] | undefined)?.[i] ?? 'None');
      changed = true;
    });
  }
  const refs = g.ExternalAssetReferences as AssetRef[] | undefined, theirs = a.ExternalAssetReferences as AssetRef[] | undefined;
  if (Array.isArray(refs) && Array.isArray(theirs)) {
    const t = elementType(schema, 'ExternalAssetReferences');
    theirs.forEach((r, i) => {
      let j = refs.findIndex((x) => x.PrimaryAssetType === r.PrimaryAssetType && x.PrimaryAssetName === r.PrimaryAssetName);
      if (j < 0) {
        const row = (t ? defaultValue(schema, t) : {}) as AssetRef;
        j = refs.push({ ...row, PrimaryAssetType: r.PrimaryAssetType, PrimaryAssetName: r.PrimaryAssetName }) - 1;
        changed = true;
      }
      assets.set(i, j);
    });
  }
  if (changed) out.set(GLOBAL_MPS, encodeMps(g, schema));
  return assets;
}

// --- removing a part ---------------------------------------------------------------------------------

function deletePrefix(out: FileMap, prefix: string): void {
  for (const p of [...out.keys()]) if (p.startsWith(prefix)) out.delete(p);
}

/** Takes the components and wires of `grids` out (with their counts), and empties or deletes those grids. */
function clearGrids(files: FileMap, grids: ReadonlySet<number>, deleteGrids: ReadonlySet<number>): FileMap {
  let out: FileMap = new Map(files);
  if ([...files.keys()].some((p) => /\/Grids\/\d+\/(Components|Wires)\//.test(p))) {
    const ctx = saveContext(out), store = new ComponentStore(ctx), graph = new WireGraph(ctx, { components: store });
    for (const w of graph.wires()) if (grids.has(w.source.grid) || grids.has(w.target.grid)) graph.removeWire(w.id);
    for (const c of [...store.instances]) if (grids.has(c.brickRef.grid)) store.removeInstance(c);
    out = store.encode({ counts: true });
    graph.encode({ into: out });
  }
  for (const g of grids) {
    deletePrefix(out, GRID_DIR(g) + 'Components/');
    deletePrefix(out, GRID_DIR(g) + 'Wires/');
    if (!hasGrid(out, g)) continue;
    out = rebuildFromLoaded(out, [], { grid: String(g) }).files;
    if (deleteGrids.has(g)) deletePrefix(out, GRID_DIR(g));
  }
  return out;
}

function chipParents(files: FileMap): Map<number, number | null> {
  const m = new Map<number, number | null>();
  try {
    const ctx = saveContext(files), graph = new WireGraph(ctx);
    for (const c of graph.chips.values()) m.set(c.grid, c.parent);
  } catch { return m; }
  return m;
}

function removeParts(files: FileMap, choice: MergeChoice, warnings: string[]): FileMap {
  const grids = new Set<number>(), gone = new Set<number>(), entities = new Set<number>();
  const drop = (g: number): void => { entities.add(g); if (hasGrid(files, g)) { grids.add(g); gone.add(g); } };
  if (choice.bricks === 'replace') grids.add(1);
  if (choice.entities === 'replace') for (const e of entitiesOf(files)) if (!/Microchip/.test(e.type)) drop(e.persistentIndex);
  const chips = chipParents(files);
  for (let grew = true; grew;) {
    grew = false;
    for (const [g, parent] of chips) if (parent !== null && grids.has(parent) && !entities.has(g)) { drop(g); grew = true; }
  }
  if (!grids.size && !entities.size) return files;
  let out = clearGrids(files, grids, gone);
  if (entities.size) {
    const r = editEntities(out, { removed: entities });
    out = r.files;
    warnings.push(...r.warnings);
  }
  return out;
}

// --- adding bricks -----------------------------------------------------------------------------------

/** The chunk key and in-chunk index of each brick of a grid, in extractBricks order. */
function brickRefs(files: FileMap, grid: number): BrickRef[] {
  const refs: BrickRef[] = [];
  let keys: ChunkKey[] = [], at = 0;
  forEachRawBrickChunk(files, (ch) => {
    const k = keys[at++]!;
    for (let i = 0; i < ch.BrickTypeIndices.length; i++) refs.push({ grid, chunk: k, brick: i });
  }, { grid: String(grid) }, (c) => {
    keys = (c.ci?.Chunk3DIndices ?? []).filter((k) => files.has(`${c.GP}Chunks/${k.X}_${k.Y}_${k.Z}.mps`));
  });
  return refs;
}

/** Where each brick of a list lands when the list is written (buildChunks: key by position, index by order). */
function landingRefs(bricks: readonly PlainBrick[], grid: number, from: number): BrickRef[] {
  const off = grid === 1 ? 0 : 1024, seen = new Map<string, number>(), refs: BrickRef[] = [];
  bricks.forEach((b, i) => {
    const p = b.pos.map(Math.round), chunk = { X: Math.floor((p[0]! - off) / SAVE_CHUNK), Y: Math.floor((p[1]! - off) / SAVE_CHUNK), Z: Math.floor((p[2]! - off) / SAVE_CHUNK) };
    const key = `${chunk.X}_${chunk.Y}_${chunk.Z}`, n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (i >= from) refs.push({ grid, chunk, brick: n });
  });
  return refs;
}

function firstChunkLinear(files: FileMap, grid: string): boolean | null {
  const ci = files.get(GRID_DIR(grid) + 'ChunkIndex.mps'), is = files.get(W + 'Bricks/ChunkIndexShared.schema'), cs = files.get(W + 'Bricks/ChunksShared.schema');
  if (!ci || !is || !cs) return null;
  const chunkSchema = parseSchema(cs);
  for (const k of decodeMps<ChunkIndex>(ci, parseSchema(is)).Chunk3DIndices) {
    const f = files.get(`${GRID_DIR(grid)}Chunks/${k.X}_${k.Y}_${k.Z}.mps`);
    if (f) return !!decodeMps<BrickChunk>(f, chunkSchema, true).bColorsAreLinear;
  }
  return null;
}

function recolour(b: PlainBrick, from: boolean, to: boolean): PlainBrick {
  if (from === to) return b;
  const f = to ? srgbToLinearByte : linearToSrgbByte;
  return { ...b, color: [f(b.color[0]), f(b.color[1]), f(b.color[2]), b.color[3]] };
}

const RELAYOUT = /components \/ wires: they index bricks/;

interface RefMap { map: Map<string, BrickRef>; grids: Set<number> }

function addGridOne(out: FileMap, add: FileMap, choice: MergeChoice, place: Placement, owner: (i: number | undefined) => number, refs: RefMap, warnings: string[]): { files: FileMap; dropped: number } {
  const imp = extractBricks(add);
  const from = brickRefs(add, 1);
  const target = firstChunkLinear(out, '1') ?? imp.linear[0] ?? false;
  const base = choice.bricks === 'add' ? extractBricks(out).bricks : [];
  const placed = placedBricks(imp.bricks, place.turns ?? 0, place.offset);
  const kept: PlainBrick[] = [], keptFrom: BrickRef[] = [];
  let dropped = 0;
  placed.forEach((b, i) => {
    if (place.drop?.has(i)) { dropped++; return; }
    kept.push(recolour({ ...b, owner: owner(b.owner), originalOwner: owner(b.originalOwner ?? b.owner) }, imp.linear[i] ?? target, target));
    keptFrom.push(from[i]!);
  });
  const all = base.concat(kept);
  const r = rebuildFromLoaded(out, all, { linear: target });
  warnings.push(...r.warnings.filter((w) => !RELAYOUT.test(w)));
  landingRefs(all, 1, base.length).forEach((to, j) => refs.map.set(brickKey(keptFrom[j]!), to));
  refs.grids.add(1);
  return { files: r.files, dropped };
}

function nextGridIndex(files: FileMap): number {
  let n = 2;
  try {
    const table = readEntities(fileMapView(files));
    n = Math.max(n, table.nextPersistentIndex ?? 2, ...table.entities.map((e) => e.persistentIndex + 1));
  } catch {
    n = 2;
  }
  for (const p of files.keys()) {
    const m = /^World\/0\/Bricks\/Grids\/(\d+)\//.exec(p);
    if (m) n = Math.max(n, +m[1]! + 1);
  }
  return n;
}

function addDynamicGrids(files: FileMap, add: FileMap, place: Placement, owner: (i: number | undefined) => number, refs: RefMap, warnings: string[]): FileMap {
  const grids = gridEntities(add);
  const others = entitiesOf(add).filter((e) => !grids.includes(e) && !/Microchip/.test(e.type)).length;
  if (others) warnings.push(`${others} entities of other kinds were not added`);
  if (!grids.length) return files;
  const why = entityLayoutProblem(files);
  if (why) { warnings.push('dynamic grids were not added: ' + why); return files; }
  let out = files, next = nextGridIndex(files);
  const turns = place.turns ?? 0, spin = axisQuat([0, 0, 1], 90 * (((turns % 4) + 4) % 4));
  const added: NewGridEntity[] = [];
  for (const e of grids) {
    const n = next++, grid = String(e.persistentIndex);
    const imp = extractBricks(add, { grid }), from = brickRefs(add, e.persistentIndex);
    const bricks = imp.bricks.map((b) => ({ ...b, owner: owner(b.owner), originalOwner: owner(b.originalOwner ?? b.owner) }));
    const r = rebuildFromLoaded(out, bricks, { grid: String(n), linear: imp.linear[0] ?? false });
    out = r.files;
    warnings.push(...r.warnings.filter((w) => !RELAYOUT.test(w)));
    landingRefs(bricks, n, 0).forEach((to, j) => refs.map.set(brickKey(from[j]!), to));
    refs.grids.add(e.persistentIndex);
    added.push({
      persistentIndex: n, location: placePos(e.location, turns, place.offset), rotation: quatMul(spin, e.rotation) as Quat,
      owner: owner(e.owner ?? 0), locked: e.physicsLocked, data: e.data ? cloneValue(e.data) : null,
    });
  }
  const r = editEntities(out, { added });
  warnings.push(...r.warnings);
  return r.files;
}

// --- components and wires ----------------------------------------------------------------------------

function remapAssets(s: Schema, t: SchemaType, x: unknown, assets: ReadonlyMap<number, number>, depth = 0): unknown {
  if (depth > 64 || x === null || x === undefined) return x;
  if (typeof t !== 'string') {
    if (t.kind === 'map' && x instanceof Map) return new Map([...x].map(([k, v]) => [remapAssets(s, t.key, k, assets, depth + 1), remapAssets(s, t.value, v, assets, depth + 1)]));
    if (t.kind !== 'map' && Array.isArray(x)) return x.map((v) => remapAssets(s, t.of, v, assets, depth + 1));
    return x;
  }
  if (ASSET_REF.has(t)) return typeof x === 'number' && x >= 0 ? assets.get(x) ?? -1 : x;
  const fields = s.S.get(t);
  if (fields && typeof x === 'object') {
    const o = { ...(x as MpsObject) };
    for (const [f, ft] of fields) if (f in o) o[f] = remapAssets(s, ft, o[f], assets, depth + 1);
    return o;
  }
  const alts = s.V.get(t), v = x as { variant?: number; value?: unknown };
  if (alts && typeof v.variant === 'number' && alts[v.variant]) return { ...v, value: remapAssets(s, alts[v.variant]!, v.value, assets, depth + 1) };
  return x;
}

/** Import component data fitted to the base's struct: fields kept when they check, else the zero value. */
function fitData(target: Schema, struct: string, from: Schema, fromStruct: string | null, data: MpsObject | null, assets: ReadonlyMap<number, number>): MpsObject {
  const src = (data && fromStruct ? remapAssets(from, fromStruct, data, assets) : {}) as MpsObject;
  const out: MpsObject = {};
  for (const [f, t] of target.S.get(struct) ?? []) out[f] = f in src && !checkValue(target, t, src[f]) ? src[f] : defaultValue(target, t);
  return out;
}

function carryComponents(files: FileMap, add: FileMap, refs: RefMap, assets: ReadonlyMap<number, number>, warnings: string[]): FileMap {
  const carried = (g: number): boolean => refs.grids.has(g);
  const relevant = [...add.keys()].some((p) => { const m = /\/Grids\/(\d+)\/(Components|Wires)\//.exec(p); return !!m && carried(+m[1]!); });
  if (!relevant) return files;
  const actx = saveContext(add), astore = new ComponentStore(actx), agraph = new WireGraph(actx, { components: astore });
  const ctx = saveContext(files), store = new ComponentStore(ctx), graph = new WireGraph(ctx, { components: store });
  let lost = 0, failed = 0, links = 0, cut = 0;
  for (const c of astore.instances) {
    if (!carried(c.brickRef.grid)) continue;
    const to = refs.map.get(brickKey(c.brickRef));
    if (!to) { lost++; continue; }
    try {
      const struct = store.structOf(c.type);
      const schema = struct ? (store.chunkOf(to)?.schema ?? ctx.schemaFor(`${W}Bricks/Grids/${to.grid}/Components/${to.chunk.X}_${to.chunk.Y}_${to.chunk.Z}.mps`)) : null;
      store.addInstance(to, c.type, struct && schema ? fitData(schema, struct, c.chunk.schema, c.struct, c.data, assets) : null);
    } catch (e) {
      if (!(e instanceof ComponentEditError)) throw e;
      failed++;
    }
  }
  for (const ch of astore.chunks) {
    if (!carried(ch.grid)) continue;
    for (const [f, v] of Object.entries(ch.file.root)) if (!COUNTER_ROOTS.has(f) && Array.isArray(v) && v.length) links++;
  }
  for (const w of agraph.wires()) {
    if (!carried(w.source.grid) && !carried(w.target.grid)) continue;
    const s = refs.map.get(brickKey(w.source)), t = refs.map.get(brickKey(w.target));
    if (!s || !t) { cut++; continue; }
    graph.addWire({ ...w.source, ...s }, { ...w.target, ...t }, { force: true, pending: w.pending });
  }
  if (lost) warnings.push(`${lost} components were on bricks that were not added`);
  if (failed) warnings.push(`${failed} components could not be added`);
  if (links) warnings.push('joint and microchip links of the import were not carried');
  if (cut) warnings.push(`${cut} wires lost an end and were not added`);
  const out = store.encode({ into: new Map(files), counts: true });
  return graph.encode({ into: out });
}

// --- the merge ---------------------------------------------------------------------------------------

function copyWhere(out: FileMap, add: FileMap, keep: (p: string) => boolean, replace: boolean): void {
  if (replace) for (const p of [...out.keys()]) if (keep(p)) out.delete(p);
  for (const [p, b] of add) if (keep(p) && (replace || !out.has(p))) out.set(p, b);
}

/**
 * The base save with parts of an import merged in: bricks of grid 1 and dynamic grids replace or
 * join the base ones (turned and moved by `place`, the `drop` indices of the import's grid-1 bricks
 * left out); owners, names, components and wires are remapped; the environment and other world data
 * replace the base files.
 */
export function mergeImport(base: FileMap, add: FileMap, choice: MergeChoice, place: Placement = {}): MergeResult {
  const warnings: string[] = [];
  let out: FileMap = new Map(base);
  mergeSchemas(out, add);
  const owner = mergeOwners(out, add);
  const assets = mergeGlobalNames(out, add);
  out = removeParts(out, choice, warnings);
  const refs: RefMap = { map: new Map(), grids: new Set() };
  let dropped = 0;
  if (choice.bricks) {
    const r = addGridOne(out, add, choice, place, owner, refs, warnings);
    out = r.files;
    dropped = r.dropped;
  }
  if (choice.entities) out = addDynamicGrids(out, add, place, owner, refs, warnings);
  if (refs.grids.size) {
    out = carryComponents(out, add, refs, assets, warnings);
    copyWhere(out, add, (p) => p.startsWith('Prefabs/'), false);
  }
  if (choice.environment) for (const p of ENVIRONMENT) { const b = add.get(p); if (b) out.set(p, b); }
  if (choice.other) {
    copyWhere(out, add, (p) => p === W + 'Minigame.bp' || p.startsWith('GameMode/'), true);
    copyWhere(out, add, (p) => p.startsWith('Prefabs/'), false);
  }
  return { files: out, dropped, warnings };
}
