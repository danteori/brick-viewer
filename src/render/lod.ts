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
/** LOD levels after full detail. */
export const LOD_LEVELS = 2;
/** Render chunks per block side. */
export const BLOCK = 8;
/** Use level 1 when a stud is narrower than this many device pixels, level 2 at a quarter of it. */
export const LOD_STUD_PX = 0.75;

/** The LOD level for a stud this many device pixels wide (0 = full detail). */
export function lodLevel(studPx: number): number {
  let L = 0, t = LOD_STUD_PX;
  while (L < LOD_LEVELS && studPx < t) { L++; t /= 4; }
  return L;
}
/** Switches (test hook / bench). */
export const lodSettings = { on: true };

/** The 24-byte instance records of the cells (relative to `c`), and the big rows kept as they are (indexes into ids). */
export interface LodBuild { cells: ArrayBuffer; count: number; keep: number[] }

/** iHalf.w for a cell: upright (16), micro (no studs, no underside); linear colour bit as stored. */
const CELL_WORD = 16 | 128;

/**
 * Bins rows `ids` of store `s` into cells. `c`: the block centre the records are relative to
 * (units). Rows too big for a cell are kept as they are.
 */
export function buildLod(s: SceneStore, ids: readonly number[], c: readonly [number, number, number], level = 1): LodBuild {
  const sc = 4 ** (level - 1), CX = CELL * sc, CZ = CELL_Z * sc;
  // per cell: lo x y z, hi x y z (union), best volume, best top, colour, flags
  const cells = new Map<number, number[]>();
  const keep: number[] = [];
  const key = (x: number, y: number, z: number): number => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
  for (let q = 0; q < ids.length; q++) {
    const id = ids[q]!, h = worldHalfOf(s.orient[id]!, s.hx[id]!, s.hy[id]!, s.hz[id]!);
    if (h[0] * 2 > CX || h[1] * 2 > CX || h[2] * 2 > CZ) { keep.push(q); continue; }
    const x = s.px[id]! - c[0], y = s.py[id]! - c[1], z = s.pz[id]! - c[2];
    const lo = [x - h[0], y - h[1], z - h[2]], hi = [x + h[0], y + h[1], z + h[2]];
    if (!(hi[0]! > lo[0]! && hi[1]! > lo[1]! && hi[2]! > lo[2]!)) continue;
    const size = [CX, CX, CZ];
    const k0 = lo.map((v, i) => Math.floor(v / size[i]!)), k1 = hi.map((v, i) => Math.floor((v - 1) / size[i]!));
    const lin = (s.flags[id]! & F_LINEAR) !== 0 ? 256 : 0;
    for (let a = k0[0]!; a <= k1[0]!; a++) for (let b = k0[1]!; b <= k1[1]!; b++) for (let d = k0[2]!; d <= k1[2]!; d++) {
      const cl = [Math.max(lo[0]!, a * CX), Math.max(lo[1]!, b * CX), Math.max(lo[2]!, d * CZ)];
      const ch = [Math.min(hi[0]!, (a + 1) * CX), Math.min(hi[1]!, (b + 1) * CX), Math.min(hi[2]!, (d + 1) * CZ)];
      const v = (ch[0]! - cl[0]!) * (ch[1]! - cl[1]!) * (ch[2]! - cl[2]!);
      if (v <= 0) continue;
      const k = key(a, b, d);
      const e = cells.get(k);
      if (!e) { cells.set(k, [cl[0]!, cl[1]!, cl[2]!, ch[0]!, ch[1]!, ch[2]!, v, ch[2]!, s.color[id]!, lin]); continue; }
      for (let i = 0; i < 3; i++) { e[i] = Math.min(e[i]!, cl[i]!); e[i + 3] = Math.max(e[i + 3]!, ch[i]!); }
      if (v > e[6]! || (v === e[6]! && ch[2]! > e[7]!)) { e[6] = v; e[7] = ch[2]!; e[8] = s.color[id]!; e[9] = lin; }
    }
  }
  const n = cells.size, data = new ArrayBuffer(n * 24);
  const i16 = new Int16Array(data), u16 = new Uint16Array(data), u32 = new Uint32Array(data);
  let j = 0;
  for (const e of cells.values()) {
    // whole-unit centre and half-extents: an odd span grows by one unit (invisible at this scale)
    const w = j * 12;
    for (let i = 0; i < 3; i++) {
      const l = e[i]!; let hh = e[i + 3]!;
      if ((hh - l) & 1) hh++;
      i16[w + i] = (l + hh) / 2; u16[w + 4 + i] = (hh - l) / 2;
    }
    i16[w + 3] = 0;
    u16[w + 7] = CELL_WORD | e[9]!;
    u32[j * 6 + 4] = e[8]!;
    u32[j * 6 + 5] = 0;
    j++;
  }
  return { cells: data, count: n, keep };
}
