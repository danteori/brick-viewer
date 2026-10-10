// Applicator type changes (backlog E-06): which brick types a save brick can become, and what it
// becomes. Pure data on save bricks (PlainBrick), no scene or DOM.
//
//   resizable -> resizable   the size is kept, so only types whose size grid (step, minimum, fixed
//                            axes, in the brick's local frame) holds that size are valid targets
//   -> fixed (B_* rounds, decor, gates)   the target's own fixed size, centred on the old box in X/Y
//                            and standing on its bottom
//   fixed -> resizable       the old box rounded to the target's grid (at least its minimum), centred
//                            and standing on the bottom the same way
// The orientation byte, paint, owners and flags are kept. Collision is the caller's (editor/applicator.ts).

import { BrickShapes } from '../render/meshes/shapes.js';
import type { PlainBrick } from '../format/world.ts';
import { SIZE_RULES } from './brick.ts';
import { worldHalfOf } from './store.ts';
import { fixedHalfOf, roundHalfOf, sizelessAsset, supportedAsset } from './view.ts';

/** A resizable type's size grid: full sizes in units along the brick's local X, Y, Z. */
export interface TypeGrid { step: [number, number, number]; min: [number, number, number]; fix: [boolean, boolean, boolean] }

const PLAIN: TypeGrid = { step: [10, 10, 4], min: [10, 10, 4], fix: [false, false, false] };
const MICRO: TypeGrid = { step: [2, 2, 2], min: [2, 2, 2], fix: [false, false, false] };

/** The size grid of a resizable asset; null for sizeless (fixed) types and assets the viewer doesn't know. */
export function typeGrid(asset: string): TypeGrid | null {
  if (sizelessAsset(asset)) return null;
  if (/^PB_Default(Brick|Tile|SmoothTile)$/.test(asset)) return PLAIN;
  if (/MicroBrick$/i.test(asset)) return MICRO;
  const r = SIZE_RULES[asset];
  if (r) return { step: [r.step[0]!, r.step[1]!, r.step[2]!], min: [r.min[0]!, r.min[1]!, r.min[2]!], fix: [!!r.fix[0], !!r.fix[1], !!r.fix[2]] };
  if (BrickShapes.isMicro(asset)) return MICRO;
  return null;
}

/** Does local half-size `half` sit on grid g? */
export function fitsGrid(half: readonly number[], g: TypeGrid): boolean {
  for (let i = 0; i < 3; i++) {
    const f = 2 * half[i]!;
    if (f < g.min[i]! || f % g.step[i]! !== 0 || (g.fix[i] && f !== g.min[i])) return false;
  }
  return true;
}

/** Local half-size `half` rounded onto grid g (nearest step, at least the minimum, fixed axes at their size). */
export function snapToGrid(half: readonly number[], g: TypeGrid): [number, number, number] {
  return [0, 1, 2].map((i) => {
    if (g.fix[i]) return g.min[i]! / 2;
    const f = Math.max(g.min[i]!, Math.round((2 * half[i]!) / g.step[i]!) * g.step[i]!);
    return f / 2;
  }) as [number, number, number];
}

/** A sizeless asset's local half-extents (rounds and cones, the fixed B_* designs). */
export const sizelessHalf = (asset: string): [number, number, number] => (BrickShapes.isRound(asset) ? roundHalfOf(asset) : fixedHalfOf(asset));

/** The local half-extents a save brick occupies. */
export const halfOf = (b: PlainBrick): [number, number, number] => (b.size ? [b.size[0], b.size[1], b.size[2]] : sizelessHalf(b.asset));

/** Can the viewer draw (and so convert to) this asset? */
export const knownTarget = (asset: string): boolean => (sizelessAsset(asset) ? supportedAsset(asset, false) : !!typeGrid(asset) && supportedAsset(asset, true));

export type ConvertOutcome = { brick: PlainBrick } | { skip: 'same' | 'size' | 'unknown' };

/**
 * Save brick `b` as type `target`, or why not: 'same' (already that type), 'size' (its size is
 * not on the target's grid), 'unknown' (a type the viewer can't draw).
 */
export function convertPlain(b: PlainBrick, target: string): ConvertOutcome {
  if (b.asset === target) return { skip: 'same' };
  if (!knownTarget(target)) return { skip: 'unknown' };
  const g = typeGrid(target);
  if (b.size && g) {
    if (!fitsGrid(b.size, g)) return { skip: 'size' };
    return { brick: { ...b, asset: target, size: [b.size[0], b.size[1], b.size[2]] } };
  }
  // the box changes: centre it on the old one in X / Y and stand it on the old bottom
  const oh = halfOf(b), ow = worldHalfOf(b.orient, oh[0], oh[1], oh[2]).slice();
  const nh = g ? snapToGrid(oh, g) : sizelessHalf(target);
  const nw = worldHalfOf(b.orient, nh[0], nh[1], nh[2]);
  const pos: [number, number, number] = [b.pos[0], b.pos[1], b.pos[2] - ow[2]! + nw[2]];
  return { brick: { ...b, asset: target, size: g ? nh : null, pos } };
}
