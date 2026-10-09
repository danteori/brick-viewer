// Save overview from the chunk indexes alone (backlog S-09, OPTIMIZATION B.2a).
//
// Reads GlobalData, every grid's ChunkIndex.mps and the container's per-file sizes; never a brick,
// component or wire chunk. From that it gives the grids and chunks with their counts, the world
// bounds, the name tables, an estimated memory cost per chunk and a load order around a camera.
// Dynamic grids are placed with their entity's location and rotation when the entity chunks
// decode (they are small); that is the only other file read. Grid folders with no entity row
// (seen in older worlds) stay unplaced: location null.
//
//   const src = openBrzLazy(bytes);                 // or fileMapSource(readBrz(bytes))
//   const ov = readOverview(src);
//   const order = suggestLoadOrder(ov, [x, y, z], { budgetBytes: 512 << 20 });
//
// Units are save units (1 stud = 10, 1 plate = 4), Unreal axes (Z up). DOM-free.

import type { FileSource } from './brzlazy.ts';
import { decodeMps, parseSchema, type MpsObject, type Schema } from './schema.ts';

export type Vec3 = [number, number, number];
export interface Box { min: Vec3; max: Vec3 }

export interface ChunkInfo {
  grid: string;
  /** "X_Y_Z", as in the chunk file name. */
  key: string;
  coord: Vec3;
  /** Edge length in units (2048 in every save seen). */
  size: number;
  offset: Vec3;
  /** Chunk cell in grid-local units: [coord*size + offset, +size]. Bricks can stick out of it. */
  cell: Box;
  bricks: number;
  components: number;
  wires: number;
  /** Path of the brick chunk file. */
  path: string;
  /** False when the index lists the chunk but the file is missing. */
  present: boolean;
  /** Container bytes of the chunk's brick, component and wire files. */
  storedBytes: number;
  /** Uncompressed bytes of those files (what a decode has to read). */
  rawBytes: number;
  /** Estimated memory of the decoded chunk (see MEMORY_MODEL). */
  estBytes: number;
}

export interface GridInfo {
  id: string;
  /** Grid 1 is the static world grid; any other is a dynamic grid (an entity). */
  dynamic: boolean;
  chunks: ChunkInfo[];
  bricks: number;
  components: number;
  wires: number;
  /** Union of the chunk cells, grid-local. Null when the grid has no chunks. */
  localBounds: Box | null;
  /** The entity's location (dynamic grids), when the entity chunks could be read. */
  location: Vec3 | null;
  /** The entity's rotation quaternion [x, y, z, w], when known. */
  rotation: [number, number, number, number] | null;
}

export interface NameTables {
  basicBricks: string[];
  proceduralBricks: string[];
  materials: string[];
  components: string[];
  componentStructs: string[];
  ports: string[];
  entities: string[];
  entityClasses: string[];
}

export interface SaveOverview {
  grids: GridInfo[];
  /** Every chunk of every grid, grid by grid in index order. */
  chunks: ChunkInfo[];
  totals: { grids: number; chunks: number; bricks: number; components: number; wires: number; storedBytes: number; rawBytes: number; estBytes: number };
  /** Static grid (grid 1) chunk cells, world units. Null when it has none. */
  bounds: Box | null;
  /** bounds plus the turned and moved cells of every placed dynamic grid's non-empty chunks. */
  boundsAll: Box | null;
  names: NameTables;
  /** Wall time of readOverview, ms. */
  ms: number;
}

/**
 * Bytes per item for the memory estimate. Brick: the SceneStore row (ARCHITECTURE section 4,
 * ~48 B), one GPU instance (~32 B) and the spatial index entry (~8 B), rounded up. Component and
 * wire: decoded JS objects, rough. Tunable; S-07 benchmarks should calibrate it.
 */
export const MEMORY_MODEL = { brick: 96, component: 160, wire: 48, perChunk: 4096 };

const W = 'World/0/';
const GRID_RE = /^World\/0\/Bricks\/Grids\/([^/]+)\/ChunkIndex\.mps$/;

interface XYZ { X: number; Y: number; Z: number }

function schemaAt(src: FileSource, ...paths: string[]): Schema | null {
  for (const p of paths) {
    const b = src.get(p);
    if (b) return parseSchema(b);
  }
  return null;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function estimateChunkBytes(bricks: number, components: number, wires: number): number {
  return MEMORY_MODEL.perChunk + bricks * MEMORY_MODEL.brick + components * MEMORY_MODEL.component + wires * MEMORY_MODEL.wire;
}

const union = (a: Box | null, b: Box): Box => (a
  ? { min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])], max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] }
  : { min: [...b.min], max: [...b.max] });

/** Grid persistent index -> entity location / rotation, from the entity chunks. Best effort. */
function entityPlacements(src: FileSource): Map<string, { loc: Vec3; rot: [number, number, number, number] | null }> {
  const out = new Map<string, { loc: Vec3; rot: [number, number, number, number] | null }>();
  let schema: Schema | null = null;
  try { schema = schemaAt(src, W + 'Entities/ChunksShared.schema'); } catch { /* unknown layout */ }
  if (!schema) return out;
  for (const p of src.paths()) {
    if (!/^World\/0\/Entities\/Chunks\/[^/]+\.mps$/.test(p)) continue;
    try {
      const ch = decodeMps<MpsObject>(src.get(p)!, schema);
      const ids = ch.PersistentIndices as number[] | undefined, locs = ch.Locations as XYZ[] | undefined;
      const rots = ch.Rotations as (XYZ & { W: number })[] | undefined;
      if (!ids || !locs) continue;
      ids.forEach((id, i) => {
        const l = locs[i], r = rots?.[i];
        if (l) out.set(String(id), { loc: [l.X, l.Y, l.Z], rot: r ? [r.X, r.Y, r.Z, r.W] : null });
      });
    } catch {
      // an entity chunk that doesn't decode: its grids stay unplaced
    }
  }
  return out;
}

export interface OverviewOptions {
  /** Read entity chunks to place dynamic grids (default true). */
  placeDynamicGrids?: boolean;
}

/** Builds the overview. Reads GlobalData, the chunk indexes and (optionally) the entity chunks. */
export function readOverview(src: FileSource, opts: OverviewOptions = {}): SaveOverview {
  const t0 = performance.now();
  const gSchema = schemaAt(src, W + 'GlobalData.schema');
  const gBytes = src.get(W + 'GlobalData.mps');
  const g = gSchema && gBytes ? decodeMps<MpsObject>(gBytes, gSchema) : {};
  const names: NameTables = {
    basicBricks: strs(g.BasicBrickAssetNames),
    proceduralBricks: strs(g.ProceduralBrickAssetNames),
    materials: strs(g.MaterialAssetNames),
    components: strs(g.ComponentTypeNames),
    componentStructs: strs(g.ComponentDataStructNames),
    ports: strs(g.ComponentWirePortNames),
    entities: strs(g.EntityTypeNames),
    entityClasses: strs(g.EntityDataClassNames),
  };
  const idxSchema = schemaAt(src, W + 'Bricks/ChunkIndexShared.schema');
  const gridIds: string[] = [];
  for (const p of src.paths()) { const m = GRID_RE.exec(p); if (m) gridIds.push(m[1]!); }
  gridIds.sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
  const placements = gridIds.some((id) => id !== '1') && opts.placeDynamicGrids !== false ? entityPlacements(src) : new Map();

  const grids: GridInfo[] = [], all: ChunkInfo[] = [];
  const stored = (p: string): number => src.storedSizeOf(p) ?? 0, raw = (p: string): number => src.sizeOf(p) ?? 0;
  for (const id of gridIds) {
    const GP = `${W}Bricks/Grids/${id}/`, dynamic = id !== '1';
    const ci = idxSchema ? decodeMps<MpsObject>(src.get(GP + 'ChunkIndex.mps')!, idxSchema) : {};
    const keys = (ci.Chunk3DIndices as XYZ[] | undefined) ?? [];
    const sizes = ci.ChunkSizes as number[] | undefined, offs = ci.ChunkOffsets as XYZ[] | undefined;
    const nb = (ci.NumBricks as number[] | undefined) ?? [], nc = (ci.NumComponents as number[] | undefined) ?? [], nw = (ci.NumWires as number[] | undefined) ?? [];
    const grid: GridInfo = { id, dynamic, chunks: [], bricks: 0, components: 0, wires: 0, localBounds: null, location: null, rotation: null };
    keys.forEach((k, j) => {
      const size = sizes?.[j] ?? 2048;
      // Older saves have no offsets; dynamic grids still centre on their origin (FORMAT 1.4, inferred).
      const off = offs?.[j] ?? (dynamic ? { X: size / 2, Y: size / 2, Z: size / 2 } : { X: 0, Y: 0, Z: 0 });
      const key = `${k.X}_${k.Y}_${k.Z}`, path = `${GP}Chunks/${key}.mps`;
      const min: Vec3 = [k.X * size + off.X, k.Y * size + off.Y, k.Z * size + off.Z];
      const files = [path, `${GP}Components/${key}.mps`, `${GP}Wires/${key}.mps`];
      const c: ChunkInfo = {
        grid: id, key, coord: [k.X, k.Y, k.Z], size, offset: [off.X, off.Y, off.Z],
        cell: { min, max: [min[0] + size, min[1] + size, min[2] + size] },
        bricks: nb[j] ?? 0, components: nc[j] ?? 0, wires: nw[j] ?? 0,
        path, present: src.has(path),
        storedBytes: files.reduce((s, p) => s + stored(p), 0),
        rawBytes: files.reduce((s, p) => s + raw(p), 0),
        estBytes: estimateChunkBytes(nb[j] ?? 0, nc[j] ?? 0, nw[j] ?? 0),
      };
      grid.chunks.push(c);
      grid.bricks += c.bricks; grid.components += c.components; grid.wires += c.wires;
      grid.localBounds = union(grid.localBounds, c.cell);
    });
    const pl = placements.get(id);
    if (pl) { grid.location = pl.loc; grid.rotation = pl.rot; }
    grids.push(grid);
    all.push(...grid.chunks);
  }

  const totals = { grids: grids.length, chunks: all.length, bricks: 0, components: 0, wires: 0, storedBytes: 0, rawBytes: 0, estBytes: 0 };
  for (const c of all) {
    totals.bricks += c.bricks; totals.components += c.components; totals.wires += c.wires;
    totals.storedBytes += c.storedBytes; totals.rawBytes += c.rawBytes; totals.estBytes += c.estBytes;
  }
  const staticGrid = grids.find((x) => !x.dynamic);
  const bounds = staticGrid?.localBounds ?? null;
  let boundsAll = bounds;
  for (const gr of grids) {
    if (!gr.dynamic || !gr.location) continue;
    for (const c of gr.chunks) if (c.bricks) boundsAll = union(boundsAll, transformBox(c.cell, gr.location, gr.rotation));
  }
  return { grids, chunks: all, totals, bounds, boundsAll, names, ms: performance.now() - t0 };
}

/** Squared distance from a point to a box (0 inside). */
export function distSqToBox(p: readonly number[], b: Box): number {
  let d = 0;
  for (let i = 0; i < 3; i++) {
    const v = p[i]!, lo = b.min[i]!, hi = b.max[i]!;
    const e = v < lo ? lo - v : v > hi ? v - hi : 0;
    d += e * e;
  }
  return d;
}

/** Snaps matrix entries within 1e-9 of -1, 0 or 1 (quaternions of right angles aren't exact). */
const snapUnit = (v: number): number => (Math.abs(v) < 1e-9 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v);

/** Box around a grid-local box after rotating by quaternion q = [x, y, z, w] and moving by l. */
export function transformBox(b: Box, l: readonly number[], q: readonly number[] | null): Box {
  const [x, y, z, w] = (q ?? [0, 0, 0, 1]) as [number, number, number, number];
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ].map((r) => r.map(snapUnit));
  const c = [0, 1, 2].map((i) => (b.min[i]! + b.max[i]!) / 2), h = [0, 1, 2].map((i) => (b.max[i]! - b.min[i]!) / 2);
  const min = [0, 0, 0] as Vec3, max = [0, 0, 0] as Vec3;
  for (let i = 0; i < 3; i++) {
    const r = R[i]!, ci = r[0]! * c[0]! + r[1]! * c[1]! + r[2]! * c[2]! + l[i]!;
    const hi = Math.abs(r[0]!) * h[0]! + Math.abs(r[1]!) * h[1]! + Math.abs(r[2]!) * h[2]!;
    min[i] = ci - hi; max[i] = ci + hi;
  }
  return { min, max };
}

/** A chunk's cell in world units: grid 1 as is; a placed dynamic grid turned and moved by its entity. Null when unplaced. */
export function worldCell(ov: SaveOverview, c: ChunkInfo): Box | null {
  if (c.grid === '1') return c.cell;
  const g = ov.grids.find((x) => x.id === c.grid);
  if (!g?.location) return null;
  return transformBox(c.cell, g.location, g.rotation);
}

export interface LoadOrderOptions {
  /** Stop counting chunks as "within budget" once their estimates add up past this. */
  budgetBytes?: number;
  /** Only these grids (default: all). */
  grids?: string[];
  /** Skip empty chunks (default true). */
  skipEmpty?: boolean;
}

export interface LoadOrder {
  /** Chunks, nearest (and densest among equals) first. */
  order: ChunkInfo[];
  /** Distance from the camera to each chunk's cell, parallel to order (Infinity = unplaced grid). */
  distance: number[];
  /** order.slice(0, withinBudget) fits budgetBytes (all of them when no budget is given). */
  withinBudget: number;
}

/**
 * Suggested decode order around a camera point: by distance from the camera to the chunk cell
 * (the camera's own chunk first), then by brick count, densest first. Dynamic grids without a
 * known location go last. This is the input to S-10's residency manager; it doesn't look at
 * the view direction (that needs the frustum, S-03).
 */
export function suggestLoadOrder(ov: SaveOverview, camera: readonly number[], opts: LoadOrderOptions = {}): LoadOrder {
  const skipEmpty = opts.skipEmpty !== false;
  const items = ov.chunks
    .filter((c) => (!opts.grids || opts.grids.includes(c.grid)) && (!skipEmpty || c.bricks > 0) && c.present)
    .map((c) => {
      const cell = worldCell(ov, c);
      return { c, d: cell ? Math.sqrt(distSqToBox(camera, cell)) : Infinity };
    });
  items.sort((a, b) => a.d - b.d || b.c.bricks - a.c.bricks);
  let withinBudget = items.length;
  if (opts.budgetBytes !== undefined) {
    let sum = 0;
    withinBudget = 0;
    for (const it of items) { sum += it.c.estBytes; if (sum > opts.budgetBytes) break; withinBudget++; }
  }
  return { order: items.map((i) => i.c), distance: items.map((i) => i.d), withinBudget };
}

/** Full load vs streaming (OPTIMIZATION B.0: stream above about 2.5 M bricks or past the budget). */
export function suggestLoadMode(ov: SaveOverview, opts: { budgetBytes?: number; streamAboveBricks?: number } = {}): 'full' | 'stream' {
  const bricksCap = opts.streamAboveBricks ?? 2_500_000;
  if (ov.totals.bricks > bricksCap) return 'stream';
  if (opts.budgetBytes !== undefined && ov.totals.estBytes > opts.budgetBytes) return 'stream';
  return 'full';
}

/** Brick density per static-grid chunk column (X, Y), summed over Z: a heat map before any decode. */
export function densityMap(ov: SaveOverview, grid = '1'): { x0: number; y0: number; w: number; h: number; size: number; bricks: Float64Array } | null {
  const cs = ov.chunks.filter((c) => c.grid === grid);
  if (!cs.length) return null;
  const xs = cs.map((c) => c.coord[0]), ys = cs.map((c) => c.coord[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 + 1, h = Math.max(...ys) - y0 + 1;
  const bricks = new Float64Array(w * h);
  for (const c of cs) bricks[(c.coord[1] - y0) * w + (c.coord[0] - x0)]! += c.bricks;
  return { x0, y0, w, h, size: cs[0]!.size, bricks };
}
