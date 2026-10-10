// Mirroring bricks across a world axis (backlog E-14). A reflection isn't a rotation, so a mirrored
// brick is a brick of the same (or its mirror-twin) asset at another orientation byte:
//
//   - box-like bricks (bricks, tiles, microbricks, plates) and the round family are symmetric about
//     their stud axis: the new byte points local +Z where the mirror sends it, and that's exact;
//   - shaped bricks (ramps, wedges, corners, arches, the micro family ...) are compared by their
//     rendered mesh: the mirrored mesh (vertices with their face parts, plus a marker on the stud
//     side) is searched for among the 24 orientations of the asset and of its mirror twin (e.g. the
//     micro half inner corner and its Inverted twin). A match is exact;
//   - with no match the closest orientation of the same asset is used (the smallest mean distance
//     between the two vertex sets) and the asset is reported as not mirrored exactly.
//
// Results are cached per (asset, local half-extents, byte, axis).

import { BrickShapes } from '../render/meshes/shapes.js';
import { r3 } from '../core/units.ts';
import { cloneBrick, type Brick, type V3 } from './brick.ts';
import { AXIS, worldHalfOf } from './store.ts';
import { plainBrick } from './save.ts';
import { viewerBrick } from './load.ts';

/** World axis to mirror across: 0 = X (x -> -x), 1 = Y, 2 = Z. */
export type MirrorAxis = 0 | 1 | 2;

/** Mirror twins: each is the other reflected (both ways). */
export const MIRROR_TWINS: Readonly<Record<string, string>> = {
  PB_DefaultMicroWedgeHalfInnerCorner: 'PB_DefaultMicroWedgeHalfInnerCornerInverted',
  PB_DefaultMicroWedgeHalfInnerCornerInverted: 'PB_DefaultMicroWedgeHalfInnerCorner',
};

export interface MirrorResult { asset: string; o: number; half: V3; exact: boolean }

/** The mesh positions are in GL axes (x = X, y = Z, z = Y): the GL index of each world axis. */
const GL = [0, 2, 1];

const meshed = (asset: string): 'micro' | 'special' | null =>
  BrickShapes.isMicro(asset) && BrickShapes.MICRO_TYPES[asset] !== 'box' ? 'micro' : BrickShapes.isSpecial(asset) ? 'special' : null;

/** Local half-extents that give world half-extents wh at byte o. */
function halfFor(o: number, wh: readonly number[]): V3 {
  const h: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) h[AXIS[o * 3 + i]!] = wh[i]!;
  return h;
}

interface Sig { keys: Set<string>; pts: number[][] }

const key = (x: number, y: number, z: number, tag: number | string): string => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}|${tag}`;

/** The shape's signature at byte o: mesh vertices (unit box of the world bounds, GL axes) with parts, and the stud marker. */
function signature(asset: string, kind: 'micro' | 'special', half: V3, o: number, flip = -1): Sig {
  const m = kind === 'micro' ? BrickShapes.microMesh(asset, half, o) : BrickShapes.specialMesh(asset, half, o);
  const P = m.positions, n = m.count, per = n ? Math.max(1, Math.round(m.parts.length / n)) : 1, keys = new Set<string>(), pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p = [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
    if (flip >= 0) p[flip] = -p[flip]!;
    keys.add(key(p[0]!, p[1]!, p[2]!, m.parts[i * per]!));
    pts.push(p);
  }
  const M = BrickShapes.brickOrient(o), z = [M[0][2] * 0.75, M[2][2] * 0.75, M[1][2] * 0.75];   // local +Z, GL axes
  if (flip >= 0) z[flip] = -z[flip]!;
  keys.add(key(z[0]!, z[1]!, z[2]!, 'studs'));
  return { keys, pts };
}

const sameKeys = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((k) => b.has(k));

/** Mean nearest-point distance, both ways. */
function chamfer(a: number[][], b: number[][]): number {
  const one = (x: number[][], y: number[][]): number => {
    let s = 0;
    for (const p of x) {
      let best = Infinity;
      for (const q of y) best = Math.min(best, (p[0]! - q[0]!) ** 2 + (p[1]! - q[1]!) ** 2 + (p[2]! - q[2]!) ** 2);
      s += Math.sqrt(best);
    }
    return s / Math.max(1, x.length);
  };
  return one(a, b) + one(b, a);
}

/** The byte whose local +Z is world direction z (a box-like brick), keeping the turn closest to o's. */
function byteForUp(o: number, axis: MirrorAxis): number {
  const M = BrickShapes.brickOrient(o), want = [M[0][2], M[1][2], M[2][2]], x = [M[0][0], M[1][0], M[2][0]];
  want[axis] = -want[axis]!; x[axis] = -x[axis]!;
  let best = o, score = -Infinity;
  for (let k = 0; k < 24; k++) {
    const N = BrickShapes.brickOrient(k);
    if (N[0][2] !== want[0] || N[1][2] !== want[1] || N[2][2] !== want[2]) continue;
    const s = N[0][0] * x[0]! + N[1][0] * x[1]! + N[2][0] * x[2]! + (k === o ? 3 : 0);   // symmetric: keep the byte when it fits
    if (s > score) { score = s; best = k; }
  }
  return best;
}

const cache = new Map<string, MirrorResult>();

/**
 * A brick of asset `asset` at byte `o` with local half-extents `half` (Brickadia units), mirrored
 * across world `axis` about its own centre: the asset, byte and local half-extents to use, and
 * whether that's an exact mirror image.
 */
export function mirrorOrient(asset: string, half: readonly number[], o: number, axis: MirrorAxis): MirrorResult {
  const ck = `${asset}|${half.join(',')}|${o}|${axis}`;
  const hit = cache.get(ck);
  if (hit) return { ...hit, half: [...hit.half] as V3 };
  const wh = [...worldHalfOf(o, half[0]!, half[1]!, half[2]!)];
  let out: MirrorResult;
  const kind = meshed(asset);
  if (!kind) {
    const k = byteForUp(o, axis);
    out = { asset, o: k, half: halfFor(k, wh), exact: true };
  } else {
    const want = signature(asset, kind, [half[0]!, half[1]!, half[2]!], o, GL[axis]!);
    out = { asset, o, half: [half[0]!, half[1]!, half[2]!], exact: false };
    let found = false;
    for (const a of [asset, MIRROR_TWINS[asset]].filter((x): x is string => !!x)) {
      const ka = meshed(a);
      if (!ka) continue;
      for (let k = 0; k < 24 && !found; k++) {
        const h = halfFor(k, wh);
        if (sameKeys(signature(a, ka, h, k).keys, want.keys)) { out = { asset: a, o: k, half: h, exact: true }; found = true; }
      }
      if (found) break;
    }
    if (!found) {
      let best = Infinity;
      for (let k = 0; k < 24; k++) {
        const h = halfFor(k, wh), d = chamfer(signature(asset, kind, h, k).pts, want.pts) + (k === o ? 0 : 1e-6);
        if (d < best) { best = d; out = { asset, o: k, half: h, exact: false }; }
      }
    }
  }
  if (cache.size > 4096) cache.clear();
  cache.set(ck, out);
  return { ...out, half: [...out.half] as V3 };
}

/** The fields that describe a brick's orientation (rotate.ts keeps the same list). */
const ORIENT_KEYS = ['up', 'side', 'shape', 'run', 'lip', 'closed', 'o', 'asset', 'round', 'micro', 'tile', 'top'] as const;

/**
 * Brick b mirrored across world `axis` inside the span [0, width] of that axis (its faces are in the
 * same frame): the box is reflected and the orientation follows mirrorOrient. `inexact` collects the
 * assets that couldn't be mirrored exactly. Returns the brick and the byte it was given.
 */
export function mirrorBrick(b: Brick, axis: MirrorAxis, width: number, inexact?: Set<string>): { brick: Brick; o: number } {
  const pb = plainBrick(b, [0, 0, 0], false);
  const m = pb.size === null
    ? { ...mirrorOrient(pb.asset, [0, 0, 0], pb.orient, axis), exact: true }
    : mirrorOrient(pb.asset, pb.size, pb.orient, axis);
  if (!m.exact) inexact?.add(pb.asset);
  const vb = viewerBrick({ ...pb, asset: m.asset, orient: m.o, size: pb.size === null ? null : m.half }, false);
  const out = cloneBrick(b) as unknown as Record<string, unknown>;
  if (!('skip' in vb)) {
    const src = vb as unknown as Record<string, unknown>;
    for (const k of ORIENT_KEYS) { delete out[k]; if (src[k] !== undefined) out[k] = src[k]; }
  }
  const nb = out as unknown as Brick, lo = b.lo[axis], hi = b.hi[axis];
  nb.lo = [...b.lo] as V3; nb.hi = [...b.hi] as V3;
  nb.lo[axis] = r3(width - hi); nb.hi[axis] = r3(width - lo);
  return { brick: nb, o: 'skip' in vb ? pb.orient : m.o };
}

/** A group of bricks (faces from the group's low corner) mirrored in place across `axis`. */
export function mirrorGroup(items: readonly Brick[], axis: MirrorAxis, inexact?: Set<string>): { bricks: Brick[]; orients: number[] } {
  let w = 0;
  for (const t of items) w = Math.max(w, t.hi[axis]);
  const bricks: Brick[] = [], orients: number[] = [];
  for (const t of items) { const r = mirrorBrick(t, axis, w, inexact); bricks.push(r.brick); orients.push(r.o); }
  return { bricks, orients };
}
