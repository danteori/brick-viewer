// Top-down map tile rasteriser (backlog S-14, OPTIMIZATION B.5). DOM-free, so it runs in the
// map worker and in unit tests.
//
// One tile per save chunk: for every cell of a square grid (unitsPerPx save units per cell, 10 =
// one pixel per stud) it keeps the top-most brick's colour (sRGB) and the height of that top.
// Footprints use the verified orientation rule (core/orient.ts worldHalf). Dynamic grids are
// placed with their entity's location and rotation, each brick as the axis-aligned box around
// its turned box. A hillshade from the height channel is baked into the colour.
//
// Map orientation: the game's top view, X up and Y right (Unreal axes; see the format notes).
// Pixel (col, row) of a tile covers world cell (ix, iy) = (ix0 + nx - 1 - row, iy0 + col), i.e.
// X from (ix0 + nx - 1 - row) * u to + u and Y from (iy0 + col) * u to + u.

import { worldHalf, type Vec3 } from '../core/orient.ts';
import { decodeMps, type MpsObject, type Schema } from '../format/schema.ts';

export interface TileOptions {
  /** Save units per pixel (10 = 1 px per stud, the default). */
  unitsPerPx?: number;
  /** Hillshade strength 0..1 (default 0.6; 0 = flat colour). */
  hillshade?: number;
  /** Skip bricks whose visibility flag is off (default true). */
  skipHidden?: boolean;
}

/** Everything a chunk decode needs besides its bytes. */
export interface ChunkContext {
  schema: Schema;
  basicNames: readonly string[];
  proceduralNames: readonly string[];
  materialNames: readonly string[];
}

export interface MapTile {
  grid: string;
  key: string;
  unitsPerPx: number;
  /** World cell index of the tile's lowest X row / lowest Y column (see the header). */
  ix0: number;
  iy0: number;
  /** Cells along X (image height) and Y (image width). */
  nx: number;
  ny: number;
  /** Image width (= ny) and height (= nx), RGBA rows from the top (highest X). */
  w: number;
  h: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  /** Top height in units per pixel, NaN where empty. Same layout as rgba. */
  top: Float32Array<ArrayBuffer>;
  minZ: number;
  maxZ: number;
  /** Bricks drawn (visible, with a footprint, and on top somewhere). */
  bricks: number;
  /** Bricks in the chunk. */
  total: number;
  /** Milliseconds spent decoding and rasterising. */
  decodeMs: number;
  rasterMs: number;
}

interface XYZ { X: number; Y: number; Z: number }
interface RGBA { R: number; G: number; B: number; A: number }

/** Half-extents of the fixed-asset (B_*) bricks the map knows; others are guessed from the name. */
const BASIC_HALF: Record<string, Vec3> = {
  B_1x1F_Round: [5, 5, 2], B_1x1_Round: [5, 5, 6], B_1x1_Cone: [5, 5, 6],
  B_2x2F_Round: [10, 10, 2], B_2x2_Round: [10, 10, 6], B_2x2_Cone: [10, 10, 12], B_4x4_Round: [20, 20, 6],
};

/** B_NxM (F = plate height) -> half-extents; anything else is treated as a 1x1 brick. */
export function basicHalf(name: string): Vec3 {
  const known = BASIC_HALF[name];
  if (known) return known;
  const m = /^B_(\d+)x(\d+)(F?)/.exec(name);
  if (m) return [Number(m[1]) * 5, Number(m[2]) * 5, m[3] ? 2 : 6];
  return [5, 5, 6];
}

const SRGB = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB[i] = Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
}

/** Decodes one brick chunk and rasterises it. The decoded chunk is dropped on return. */
/** Where a dynamic grid sits: its entity's location and rotation quaternion [x, y, z, w]. */
export interface GridTransform {
  loc: readonly number[];
  rot: readonly number[] | null;
}

export interface ChunkRef {
  grid: string;
  key: string;
  /** Chunk cell in grid-local units (ChunkInfo.cell). */
  cell: { min: readonly number[]; max: readonly number[] };
  /** Grid-local -> world; omit for the static grid. */
  transform?: GridTransform | null;
}

/** Snaps matrix entries within 1e-9 of -1, 0 or 1 (quaternions of right angles aren't exact). */
const snapUnit = (v: number): number => (Math.abs(v) < 1e-9 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v);

/** Rotation matrix (rows) of a unit quaternion, right angles snapped exact. */
export function quatMatrix(q: readonly number[] | null): number[][] {
  if (!q) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z, w] = q as [number, number, number, number];
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ].map((r) => r.map(snapUnit));
}

export function rasteriseChunk(bytes: Uint8Array, ctx: ChunkContext, chunk: ChunkRef, opts: TileOptions = {}): MapTile {
  const t0 = performance.now();
  const ch = decodeMps<MpsObject>(bytes, ctx.schema);
  const t1 = performance.now();
  const u = opts.unitsPerPx ?? 10, skipHidden = opts.skipHidden !== false;
  const types = (ch.BrickTypeIndices as number[] | undefined) ?? [];
  const start = (ch.ProceduralBrickStartingIndex as number | undefined) ?? 0;
  const counters = (ch.BrickSizeCounters as { AssetIndex: number; NumSizes: number }[] | undefined) ?? [];
  const sizes = (ch.BrickSizes as XYZ[] | undefined) ?? [];
  const pos = (ch.RelativePositions as XYZ[] | undefined) ?? [];
  const ori = (ch.Orientations as number[] | undefined) ?? [];
  const cols = (ch.ColorsAndAlphas as RGBA[] | undefined) ?? [];
  const vis = (ch.VisibilityFlags as { Flags: number[] | Uint8Array } | undefined)?.Flags;
  // no flag (pre-CL14860) = linear bytes; false = sRGB (FORMAT 2.3)
  const linear = ch.bColorsAreLinear !== false;
  // procedural type -> local half-extents
  const procHalf: Vec3[] = [];
  let si = 0;
  for (const c of counters) for (let n = 0; n < c.NumSizes; n++) { const s = sizes[si++]!; procHalf.push([s.X, s.Y, s.Z]); }
  const basicCache = new Map<number, Vec3>();
  const halfOf = (t: number): Vec3 | null => {
    if (t >= start && start >= 0 && t - start < procHalf.length) return procHalf[t - start]!;
    let h = basicCache.get(t);
    if (!h) { const name = ctx.basicNames[t]; if (name === undefined) return null; h = basicHalf(name); basicCache.set(t, h); }
    return h;
  };
  const size = chunk.cell.max[0]! - chunk.cell.min[0]!;
  const centre = [0, 1, 2].map((a) => chunk.cell.min[a]! + size / 2);
  // world boxes first, to size the tile (bricks can stick out of their chunk; clamp to 3x3 chunks)
  const n = types.length, box = new Float64Array(n * 4), topZ = new Float64Array(n), keep = new Uint8Array(n);
  // dynamic grids: world = R * local + loc; footprints become the AABB of the turned box
  const tr = chunk.transform ?? null, R = quatMatrix(tr?.rot ?? null), A = R.map((r) => r.map(Math.abs));
  const L = tr ? [tr.loc[0]!, tr.loc[1]!, tr.loc[2]!] : [0, 0, 0];
  const toWorld = (x: number, y: number, z: number, a: number): number => R[a]![0]! * x + R[a]![1]! * y + R[a]![2]! * z + L[a]!;
  const turn = (h: Vec3, a: number): number => A[a]![0]! * h[0] + A[a]![1]! * h[1] + A[a]![2]! * h[2];
  const cc: Vec3 = [toWorld(centre[0]!, centre[1]!, centre[2]!, 0), toWorld(centre[0]!, centre[1]!, centre[2]!, 1), 0];
  const reach = tr ? [turn([size / 2, size / 2, size / 2], 0), turn([size / 2, size / 2, size / 2], 1)] : [size / 2, size / 2];
  const lim = [cc[0] - reach[0]! - size, cc[0] + reach[0]! + size, cc[1] - reach[1]! - size, cc[1] + reach[1]! + size];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    if (skipHidden && vis && !((vis[i >> 3]! >> (i & 7)) & 1)) continue;
    const s = halfOf(types[i]!), p = pos[i];
    if (!s || !p) continue;
    let h = worldHalf(ori[i] ?? 16, s);
    let px = p.X + centre[0]!, py = p.Y + centre[1]!, pz = p.Z + centre[2]!;
    if (tr) {
      h = [turn(h, 0), turn(h, 1), turn(h, 2)];
      [px, py, pz] = [toWorld(px, py, pz, 0), toWorld(px, py, pz, 1), toWorld(px, py, pz, 2)];
    }
    const bx0 = Math.max(px - h[0], lim[0]!), bx1 = Math.min(px + h[0], lim[1]!);
    const by0 = Math.max(py - h[1], lim[2]!), by1 = Math.min(py + h[1], lim[3]!);
    if (bx1 < bx0 || by1 < by0) continue;
    box[i * 4] = bx0; box[i * 4 + 1] = bx1; box[i * 4 + 2] = by0; box[i * 4 + 3] = by1;
    topZ[i] = pz + h[2]; keep[i] = 1;
    if (bx0 < x0) x0 = bx0;
    if (bx1 > x1) x1 = bx1;
    if (by0 < y0) y0 = by0;
    if (by1 > y1) y1 = by1;
    if (pz - h[2] < minZ) minZ = pz - h[2];
    if (pz + h[2] > maxZ) maxZ = pz + h[2];
  }
  if (x0 === Infinity) {
    const empty = { grid: chunk.grid, key: chunk.key, unitsPerPx: u, ix0: 0, iy0: 0, nx: 0, ny: 0, w: 0, h: 0 };
    return { ...empty, rgba: new Uint8ClampedArray(0), top: new Float32Array(0), minZ: 0, maxZ: 0, bricks: 0, total: n, decodeMs: t1 - t0, rasterMs: performance.now() - t1 };
  }
  const ix0 = Math.floor(x0 / u), ix1 = Math.ceil(x1 / u), iy0 = Math.floor(y0 / u), iy1 = Math.ceil(y1 / u);
  const nx = Math.max(1, ix1 - ix0), ny = Math.max(1, iy1 - iy0), w = ny, hgt = nx;
  const top = new Float32Array(w * hgt).fill(NaN), rgba = new Uint8ClampedArray(w * hgt * 4);
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    // cells whose centre lies inside the footprint; a footprint smaller than a cell takes the cell it's in
    let ca = Math.ceil(box[i * 4]! / u - 0.5), cb = Math.ceil(box[i * 4 + 1]! / u - 0.5) - 1;
    let ra = Math.ceil(box[i * 4 + 2]! / u - 0.5), rb = Math.ceil(box[i * 4 + 3]! / u - 0.5) - 1;
    if (cb < ca) ca = cb = Math.floor((box[i * 4]! + box[i * 4 + 1]!) / 2 / u);
    if (rb < ra) ra = rb = Math.floor((box[i * 4 + 2]! + box[i * 4 + 3]!) / 2 / u);
    const z = topZ[i]!, c = cols[i] ?? { R: 255, G: 0, B: 255, A: 5 };
    const r = linear ? SRGB[c.R & 255]! : c.R & 255, g = linear ? SRGB[c.G & 255]! : c.G & 255, b = linear ? SRGB[c.B & 255]! : c.B & 255;
    let any = false;
    for (let ix = Math.max(ca, ix0); ix <= Math.min(cb, ix1 - 1); ix++) {
      const row = nx - 1 - (ix - ix0), base = row * w;
      for (let iy = Math.max(ra, iy0); iy <= Math.min(rb, iy1 - 1); iy++) {
        const k = base + (iy - iy0), cur = top[k]!;
        if (cur >= z) continue;   // NaN (empty) compares false, so it gets drawn
        top[k] = z;
        const q = k * 4;
        rgba[q] = r; rgba[q + 1] = g; rgba[q + 2] = b; rgba[q + 3] = 255;
        any = true;
      }
    }
    if (any) drawn++;
  }
  hillshade(rgba, top, w, hgt, u, opts.hillshade ?? 0.6);
  return { grid: chunk.grid, key: chunk.key, unitsPerPx: u, ix0, iy0, nx, ny, w, h: hgt, rgba, top, minZ, maxZ, bricks: drawn, total: n, decodeMs: t1 - t0, rasterMs: performance.now() - t1 };
}

/**
 * Bakes a simple hillshade into rgba from the height channel: light from the top-left of the map,
 * 45 degrees up; flat ground keeps its colour. Edges and empty neighbours count as flat.
 */
export function hillshade(rgba: Uint8ClampedArray, top: Float32Array, w: number, h: number, unitsPerPx: number, strength: number): void {
  if (strength <= 0 || !w || !h) return;
  const L = [-1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];   // towards the light: up-left in the image, then up
  const at = (c: number, r: number, fallback: number): number => {
    if (c < 0 || r < 0 || c >= w || r >= h) return fallback;
    const v = top[r * w + c]!;
    return Number.isNaN(v) ? fallback : v;
  };
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const k = r * w + c, z = top[k]!;
      if (Number.isNaN(z)) continue;
      // image x = column, image y = row (down); slope per unit
      const dx = (at(c + 1, r, z) - at(c - 1, r, z)) / (2 * unitsPerPx);
      const dy = (at(c, r + 1, z) - at(c, r - 1, z)) / (2 * unitsPerPx);
      const nl = Math.hypot(dx, dy, 1);
      const lambert = (-dx * L[0]! - dy * L[1]! + L[2]!) / nl;
      const shade = 1 + strength * (Math.min(1.6, Math.max(0, lambert / L[2]!)) - 1);
      const q = k * 4;
      rgba[q] = rgba[q]! * shade; rgba[q + 1] = rgba[q + 1]! * shade; rgba[q + 2] = rgba[q + 2]! * shade;
    }
  }
}
