// Far level of detail (U-02 / S-13): when a stud is well under a pixel, a block of render chunks
// (BLOCK x BLOCK x BLOCK of them) is drawn from one coarse instance buffer instead of its chunks'
// own groups. Pure data here (no GL): render/instances.ts owns the buffers and draws.
//
// The coarse set, like the game's simplified far clusters:
//   - small bricks (no side longer than a cell) are binned into cells of CELL x CELL x CELL_Z
//     units; each cell becomes one plain box, the union of its bricks' parts inside it, coloured
//     like its biggest part (ties: the higher one). Shape detail (ramps, rounds, studs) is gone,
//     which at this scale is under a pixel;
//   - big bricks stay as they are (their own mesh), so baseplates and long walls don't explode
//     into cells.
// The camera is orthographic, so every chunk is at the same scale: the switch is one zoom
// threshold for the whole view, not a per-chunk distance.

import { F_LINEAR, worldHalfOf, type SceneStore } from '../scene/store.ts';

/** Level-1 cell size, units (4 studs; 4 bricks tall). Each further level is 4x coarser. */
export const CELL = 40, CELL_Z = 48;
/** LOD levels after full detail: cells of 4, 16, 64 and 256 studs. */
export const LOD_LEVELS = 4;
/** Render chunks per block side. */
export const BLOCK = 4;
/** Use level 1 when a stud is narrower than this many device pixels. */
export const LOD_STUD_PX = 0.75;
/** Deeper levels: the coarsest whose cells are at most this many device pixels across. */
export const LOD_CELL_PX = 4;

/**
 * Between LOD_STUD_PX and this stud width (device px) full detail is drawn per chunk as usual, but
 * covered faces are collapsed in the vertex shader (hidesCovered). There used to be merged levels
 * here (each block's chunks merged into one buffer per mesh, rebuilt per block on the main thread):
 * since the shape templates (S-05) a chunk draws one group per template family, so merging no longer
 * saved draws, drew 2-10x the instances (a merged block can't be culled per chunk) and each block's
 * rebuild was one 50-220 ms frame on 3-6 M brick builds.
 */
export const HIDE_STUD_PX = 1.5;
/**
 * Scenes with fewer render chunks than this keep showing covered faces down to LOD_STUD_PX, and
 * merge only runs of consecutive meshes into template family groups (render/instances.ts fill): the
 * draw order decides which of two exactly coplanar faces wins the depth test, so small scenes (their
 * golden pictures) draw exactly as they always did.
 */
export const MERGE_MIN_CHUNKS = 64;
/** The pseudo-level for per-chunk full detail with covered faces dropped. */
export const LOD_HIDE = LOD_LEVELS + 1;

/** The LOD level for a stud this many device pixels wide: 0 = full detail, LOD_HIDE, or 1..LOD_LEVELS (coarse cells). */
export function lodLevel(studPx: number): number {
  if (!(studPx < HIDE_STUD_PX)) return 0;
  if (!(studPx < LOD_STUD_PX)) return LOD_HIDE;
  let L = 1;
  while (L < LOD_LEVELS && 4 * 4 ** L * studPx <= LOD_CELL_PX) L++;
  return L;
}
/**
 * Does this level drop covered faces and fully hidden bricks (render/facecull.ts)? Not at full
 * detail: where bricks of different sizes meet, their outer faces leave sub-pixel slivers
 * (T-junctions), and the covered faces behind are what fills them, so dropping those would let
 * the background sparkle through the seams. From LOD_HIDE on the picture is approximate anyway.
 */
export const hidesCovered = (level: number): boolean => level !== 0;

/** Switches (test hook / bench). */
export const lodSettings = { on: true };

/** The 24-byte instance records of the cells (relative to `c`), and the big rows kept as they are (indexes into ids). */
export interface LodBuild { cells: ArrayBuffer; count: number; keep: number[] }

/** iHalf.w for a cell: upright (16), micro (no studs, no underside); linear colour bit as stored. */
const CELL_WORD = 16 | 128;

/**
 * Bins rows of store `s` into cells, a few rows at a time (render/instances.ts spreads a block's
 * build over frames): add() each row in order, then finish(). `c`: the block centre the records are
 * relative to (units). Rows too big for a cell are kept as they are (add returns false). The
 * result is the same whatever the slices: only the order of the rows counts.
 */
export class LodBuilder {
  private readonly CX: number; private readonly CZ: number;
  private at = new Map<number, number>();
  // per cell (E floats from index * E): lo x y z, hi x y z (union), best volume, best top, colour, flags
  private tab = new Float64Array(1024 * E);
  private n = 0;
  constructor(private readonly s: SceneStore, private readonly c: readonly [number, number, number], level = 1) {
    const sc = 4 ** (level - 1);
    this.CX = CELL * sc; this.CZ = CELL_Z * sc;
  }

  /** Bins row id; false when it is too big for a cell (the caller keeps it as it is). */
  add(id: number): boolean {
    const s = this.s, c = this.c, CX = this.CX, CZ = this.CZ, at = this.at;
    const h = worldHalfOf(s.orient[id]!, s.hx[id]!, s.hy[id]!, s.hz[id]!);
    const hx = h[0], hy = h[1], hz = h[2];
    if (hx * 2 > CX || hy * 2 > CX || hz * 2 > CZ) return false;
    if (!(hx > 0 && hy > 0 && hz > 0)) return true;
    const x = s.px[id]! - c[0], y = s.py[id]! - c[1], z = s.pz[id]! - c[2];
    const x0 = x - hx, y0 = y - hy, z0 = z - hz, x1 = x + hx, y1 = y + hy, z1 = z + hz;
    const col = s.color[id]!, lin = (s.flags[id]! & F_LINEAR) !== 0 ? 256 : 0;
    const a1 = Math.floor((x1 - 1) / CX), b1 = Math.floor((y1 - 1) / CX), d1 = Math.floor((z1 - 1) / CZ);
    for (let a = Math.floor(x0 / CX); a <= a1; a++) for (let b = Math.floor(y0 / CX); b <= b1; b++) for (let d = Math.floor(z0 / CZ); d <= d1; d++) {
      const lx = Math.max(x0, a * CX), ly = Math.max(y0, b * CX), lz = Math.max(z0, d * CZ);
      const ux = Math.min(x1, (a + 1) * CX), uy = Math.min(y1, (b + 1) * CX), uz = Math.min(z1, (d + 1) * CZ);
      const v = (ux - lx) * (uy - ly) * (uz - lz);
      if (v <= 0) continue;
      const k = ((a + 512) * 1024 + (b + 512)) * 1024 + (d + 512);
      const i = at.get(k);
      let tab = this.tab;
      if (i === undefined) {
        if ((this.n + 1) * E > tab.length) { const t = new Float64Array(tab.length * 2); t.set(tab); this.tab = tab = t; }
        const o = this.n * E;
        tab[o] = lx; tab[o + 1] = ly; tab[o + 2] = lz; tab[o + 3] = ux; tab[o + 4] = uy; tab[o + 5] = uz;
        tab[o + 6] = v; tab[o + 7] = uz; tab[o + 8] = col; tab[o + 9] = lin;
        at.set(k, this.n++);
        continue;
      }
      const o = i * E;
      if (lx < tab[o]!) tab[o] = lx;
      if (ly < tab[o + 1]!) tab[o + 1] = ly;
      if (lz < tab[o + 2]!) tab[o + 2] = lz;
      if (ux > tab[o + 3]!) tab[o + 3] = ux;
      if (uy > tab[o + 4]!) tab[o + 4] = uy;
      if (uz > tab[o + 5]!) tab[o + 5] = uz;
      if (v > tab[o + 6]! || (v === tab[o + 6]! && uz > tab[o + 7]!)) { tab[o + 6] = v; tab[o + 7] = uz; tab[o + 8] = col; tab[o + 9] = lin; }
    }
    return true;
  }

  /** The cells' 24-byte instance records (relative to `c`) and their count. */
  finish(): { cells: ArrayBuffer; count: number } {
    const n = this.n, tab = this.tab;
    const data = new ArrayBuffer(n * 24);
    const i16 = new Int16Array(data), u16 = new Uint16Array(data), u32 = new Uint32Array(data);
    for (let j = 0; j < n; j++) {
      // whole-unit centre and half-extents: an odd span grows by one unit (invisible at this scale)
      const w = j * 12, o = j * E;
      for (let i = 0; i < 3; i++) {
        const l = tab[o + i]!; let hh = tab[o + 3 + i]!;
        if ((hh - l) & 1) hh++;
        i16[w + i] = (l + hh) / 2; u16[w + 4 + i] = (hh - l) / 2;
      }
      i16[w + 3] = 0;
      u16[w + 7] = CELL_WORD | tab[o + 9]!;
      u32[j * 6 + 4] = tab[o + 8]!;
      u32[j * 6 + 5] = 0;
    }
    return { cells: data, count: n };
  }
}
/** Floats per cell in LodBuilder's table. */
const E = 10;

/**
 * Bins rows `ids` of store `s` into cells in one go (LodBuilder). `c`: the block centre the records
 * are relative to (units). Rows too big for a cell are kept as they are.
 */
export function buildLod(s: SceneStore, ids: readonly number[], c: readonly [number, number, number], level = 1): LodBuild {
  const B = new LodBuilder(s, c, level), keep: number[] = [];
  for (let q = 0; q < ids.length; q++) if (!B.add(ids[q]!)) keep.push(q);
  return { ...B.finish(), keep };
}
