// SceneStore rows <-> the editor's brick records.
//
// The store holds save data (store.ts). The editor, the panels and the clipboard work on `Brick`
// objects (scene/brick.ts: world box faces in viewer units plus derived type fields): brickView
// makes one from a row with the same conversion a loaded save brick goes through (viewerBrick),
// and writeBrick puts one back. writeBrick keeps what a Brick can't say exactly: the stored
// orientation byte when the brick's derived fields still match it (a box brick's quarter turns all
// look alike), and the stored colour bytes (also linear ones) when the colour wasn't changed.

import { BrickShapes } from '../render/meshes/shapes.js';
import { BRZ_UNIT } from '../core/units.ts';
import { linearByteToSrgb } from '../core/colour.ts';
import type { PlainBrick } from '../format/world.ts';
import { isFixedAsset, localHalf, rampDir, sideCode, type Brick, type SaveExtras } from './brick.ts';
import { ASSETS, F_ALIVE, F_HAS_FLAGS, F_LINEAR, FLAG_NAMES, GRIDS, Kind, MATERIALS, SAME_OWNER, type SceneStore } from './store.ts';
import { viewerBrick, type SeqBrick } from './load.ts';
import { assetOf } from './save.ts';

// --- shape kinds -----------------------------------------------------------------------------------

export { isFixedAsset };
/** A procedural type drawn as one fixed design stretched to its saved size (PB_Frog, BP_ZoneProjector, the sliders). */
export const isStretchedAsset = (asset: string): boolean => Object.prototype.hasOwnProperty.call(BrickShapes.STRETCHED, asset);
/** A fixed B_* brick's half-extents in units. */
export function fixedHalfOf(asset: string): [number, number, number] {
  return BrickShapes.FIXED_SHAPES[asset]!.half.slice() as [number, number, number];
}
/** Does the save list this asset without a size (a B_* brick with its own fixed box)? */
export const sizelessAsset = (asset: string): boolean => BrickShapes.isRound(asset) || isFixedAsset(asset);

/** Does the viewer draw this asset? `procedural`: the save lists it with a size (PB_*), else a fixed B_* brick. */
export function supportedAsset(asset: string, procedural: boolean): boolean {
  if (!procedural) return BrickShapes.isRound(asset) || isFixedAsset(asset);
  return /MicroBrick$/i.test(asset) || /DefaultBrick$/.test(asset) || /DefaultSmoothTile$/.test(asset) || /DefaultTile$/.test(asset) ||
    BrickShapes.isMicro(asset) || BrickShapes.isSpecial(asset) || isStretchedAsset(asset);
}

/** The shape kind viewerBrick gives an asset at an orientation (upright / upside down or sideways). */
export function kindOfName(asset: string, orient: number): Kind {
  const dir = (orient >> 2) % 6, up = dir === 4 || dir === 5;
  if (BrickShapes.isRound(asset)) return Kind.Round;
  if (up && /DefaultRamp$/.test(asset)) return Kind.Ramp;
  if (up && /DefaultRampCrest$/.test(asset)) return Kind.Crest;
  if (up && /DefaultRampCrestEnd$/.test(asset)) return Kind.CrestEnd;
  if (!/MicroBrick$/i.test(asset) && BrickShapes.isMicro(asset)) return Kind.Micro;
  if (BrickShapes.isSpecial(asset) || isFixedAsset(asset) || isStretchedAsset(asset)) return Kind.Special;
  return Kind.Box;
}
const kindCache: number[][] = [];
/** kindOfName by table indices (cached). */
export function kindOf(asset: number, orient: number): Kind {
  const row = kindCache[asset] ?? (kindCache[asset] = []), up = (orient >> 2) % 6 >= 4 ? 1 : 0;
  return (row[up] ??= kindOfName(ASSETS.name(asset), orient));
}

/** Top style / micro of an asset, for the instance flags: 0 studs, 1 plain, 2 smooth; micro = no studs, no underside. */
export function topOf(asset: string): { top: 0 | 1 | 2; micro: boolean } {
  const micro = /MicroBrick$/i.test(asset) || BrickShapes.isMicro(asset);
  return { top: /DefaultSmoothTile$/.test(asset) ? 2 : /DefaultTile$/.test(asset) ? 1 : 0, micro };
}

const roundHalfs = new Map<string, [number, number, number]>();
/** Round / cone half-extents in units (B_* bricks have no size in the save), from the generator. */
export function roundHalfOf(name: string): [number, number, number] {
  let h = roundHalfs.get(name);
  if (!h) { h = BrickShapes.roundMesh(name).half; roundHalfs.set(name, h); }
  return h;
}

// --- rows <-> plain save bricks ------------------------------------------------------------------

/** Row `id` as a save brick, colour bytes as stored (see F_LINEAR), with its load order as seq. */
export function plainOf(s: SceneStore, id: number): SeqBrick & { linear: boolean } {
  const c = s.color[id]!, asset = ASSETS.name(s.asset[id]!);
  const pb: SeqBrick & { linear: boolean } = {
    asset, size: s.shape[id] === Kind.Round || isFixedAsset(asset) ? null : [s.hx[id]!, s.hy[id]!, s.hz[id]!],
    pos: [s.px[id]!, s.py[id]!, s.pz[id]!], orient: s.orient[id]!,
    color: [c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24],
    material: MATERIALS.name(s.material[id]!), linear: (s.flags[id]! & F_LINEAR) !== 0,
  };
  if (s.owner[id]) pb.owner = s.owner[id];
  pb.originalOwner = s.origOwner[id] === SAME_OWNER ? s.owner[id]! : s.origOwner[id]!;
  if (s.flags[id]! & F_HAS_FLAGS) pb.flags = flagsOf(s, id);
  if (s.srcOrder[id]! >= 0) pb.seq = s.srcOrder[id];
  return pb;
}

function flagsOf(s: SceneStore, id: number): Record<string, number> {
  const out: Record<string, number> = {}, bits = s.collision[id]!;
  for (const f of s.flagFields) out[FLAG_NAMES.name(f)] = bits & (1 << f) ? 0 : 1;
  for (let f = 0; f < 16; f++) if (bits & (1 << f)) out[FLAG_NAMES.name(f)] = 0;
  return out;
}

/**
 * Fills row `id` from a save brick. `linear`: its colour bytes are linear (bColorsAreLinear, or a
 * save from before CL14860). The row must be live (alloc / revive).
 */
export function putPlain(s: SceneStore, id: number, pb: PlainBrick & { seq?: number }, linear: boolean, grid = '1'): void {
  const a = ASSETS.id(pb.asset), o = pb.orient ?? 16, kind = kindOf(a, o);
  const h = pb.size ?? (kind === Kind.Round ? roundHalfOf(pb.asset) : isFixedAsset(pb.asset) ? fixedHalfOf(pb.asset) : [0, 0, 0]);
  s.px[id] = pb.pos[0]; s.py[id] = pb.pos[1]; s.pz[id] = pb.pos[2];
  s.hx[id] = h[0]; s.hy[id] = h[1]; s.hz[id] = h[2];
  s.orient[id] = o; s.asset[id] = a; s.shape[id] = kind;
  const col = pb.color;
  s.color[id] = ((col[0] & 255) | ((col[1] & 255) << 8) | ((col[2] & 255) << 16) | (((col[3] ?? 5) & 255) << 24)) >>> 0;
  s.material[id] = MATERIALS.id(pb.material ?? 'BMC_Plastic');
  s.owner[id] = pb.owner ?? 0;
  s.origOwner[id] = pb.originalOwner === undefined || pb.originalOwner === (pb.owner ?? 0) ? SAME_OWNER : pb.originalOwner;
  let f = F_ALIVE | (linear ? F_LINEAR : 0), bits = 0;
  if (pb.flags) {
    f |= F_HAS_FLAGS;
    for (const [k, v] of Object.entries(pb.flags)) if (!v) { const i = FLAG_NAMES.id(k); if (i < 16) bits |= 1 << i; }
  }
  s.flags[id] = f; s.collision[id] = bits;
  s.grid[id] = GRIDS.id(grid);
  s.srcOrder[id] = pb.seq ?? -1;
  s.touch(id);
}

// --- rows <-> editor bricks ----------------------------------------------------------------------

/** Row `id` as an editor brick (absolute faces in viewer units), exactly as a loaded save brick reads. */
export function brickView(s: SceneStore, id: number): Brick {
  const pb = plainOf(s, id), b = viewerBrick(pb, pb.linear);
  if ('skip' in b) throw new Error(`row ${id} holds an unsupported brick ${pb.asset}`);
  if (pb.seq !== undefined) (b.save ??= {}).seq = pb.seq;
  const g = GRIDS.name(s.grid[id]!);
  if (g !== '1') b.grid = g;
  return b;
}

/** Does orientation byte o give brick b's derived orientation fields? (the test orientOf runs) */
export function orientMatches(o: number, b: Brick): boolean {
  if (b.shape === 'special' || b.shape === 'micro') return o === (b.o ?? 16);
  if (b.shape === 'round' && b.o != null) return o === b.o;
  const up = b.up ?? 1, dir = o >> 2, u = dir === 4 ? 1 : dir === 5 ? -1 : 0;
  if (u !== up) return false;
  if (!u && sideCode(o) !== (b.side || 1)) return false;
  if (b.shape === 'ramp') { const r = rampDir(o); if (r.run !== b.run || r.lip !== b.lip) return false; }
  if (b.shape === 'crest' && BrickShapes.crestDir(o).run !== b.run) return false;
  if (b.shape === 'crestEnd') { const c = BrickShapes.crestEndDir(o); if (c.run !== b.run || c.closed !== b.closed) return false; }
  return true;
}

const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * Writes editor brick b into row `id` (live, or made live). `keep`: the row still holds the brick
 * b was read from, so its orientation byte and colour bytes are kept where b agrees with them.
 * `orient`: the orientation byte to store (a turn), when b agrees with it.
 */
export function writeBrick(s: SceneStore, id: number, b: Brick, keep = s.alive(id), orient = -1): void {
  const prevO = s.orient[id]!, prevC = s.color[id]!, prevLin = (s.flags[id]! & F_LINEAR) !== 0;
  if (!s.alive(id)) s.revive(id);
  const asset = assetOf(b);
  let o = orient >= 0 && orientMatches(orient, b) ? orient : keep && orientMatches(prevO, b) ? prevO : -1;
  if (o < 0) { o = 16; for (let k = 0; k < 24; k++) if (orientMatches(k, b)) { o = k; break; } if (!orientMatches(o, b)) o = (b.up ?? 1) < 0 ? 20 : 16; }
  const size = [0, 1, 2].map((i) => b.hi[i]! - b.lo[i]!);
  const kind = kindOfName(asset, o);
  const half = kind === Kind.Round ? roundHalfOf(asset) : isFixedAsset(asset) ? fixedHalfOf(asset) : localHalf(o, size).map(Math.round);
  const pos = [0, 1, 2].map((i) => Math.round((b.lo[i]! + b.hi[i]!) / 2 / BRZ_UNIT));
  // colour: unchanged (it reads back the same) keeps the stored bytes, linear or not
  const show = (c: number, i: number, lin: boolean): number => { const v = (c >>> (8 * i)) & 255; return lin ? linearByteToSrgb(v) : v / 255; };
  const same = keep && [0, 1, 2].every((i) => Math.abs(show(prevC, i, prevLin) - b.color[i]!) < 1e-9);
  const inten = Math.max(0, Math.min(255, Math.round(b.intensity ?? 5)));
  const rgb = same ? prevC & 0xffffff : byte(b.color[0]!) | (byte(b.color[1]!) << 8) | (byte(b.color[2]!) << 16);
  const ex: SaveExtras = b.save ?? {};
  putPlainRaw(s, id, asset, pos, half, o, kind);
  s.color[id] = (rgb | (inten << 24)) >>> 0;
  s.material[id] = MATERIALS.id(b.material ?? 'BMC_Plastic');
  s.owner[id] = ex.owner ?? 0;
  s.origOwner[id] = ex.originalOwner === undefined || ex.originalOwner === (ex.owner ?? 0) ? SAME_OWNER : ex.originalOwner;
  let fl = F_ALIVE | (same && prevLin ? F_LINEAR : 0), bits = 0;
  if (ex.flags) {
    fl |= F_HAS_FLAGS;
    for (const [k, v] of Object.entries(ex.flags)) if (!v) { const i = FLAG_NAMES.id(k); if (i < 16) bits |= 1 << i; }
  }
  s.flags[id] = fl; s.collision[id] = bits;
  s.grid[id] = GRIDS.id(b.grid ?? '1');
  s.srcOrder[id] = ex.seq ?? -1;
  s.touch(id);
}

function putPlainRaw(s: SceneStore, id: number, asset: string, pos: number[], half: readonly number[], o: number, kind: Kind): void {
  s.px[id] = pos[0]!; s.py[id] = pos[1]!; s.pz[id] = pos[2]!;
  s.hx[id] = half[0]!; s.hy[id] = half[1]!; s.hz[id] = half[2]!;
  s.orient[id] = o; s.asset[id] = ASSETS.id(asset); s.shape[id] = kind;
}

/** A new row holding editor brick b; returns its id. */
export function addBrick(s: SceneStore, b: Brick): number {
  const id = s.alloc();
  writeBrick(s, id, b, false);
  return id;
}

/** Centre of row `id` in viewer units. */
export const centreOf = (s: SceneStore, id: number): [number, number, number] => [s.px[id]! * BRZ_UNIT, s.py[id]! * BRZ_UNIT, s.pz[id]! * BRZ_UNIT];
