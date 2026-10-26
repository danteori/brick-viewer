import { MAX, r3 } from '../core/units.ts';
import { brickType, fixedSize, lockedType, sizeRule, type Brick } from '../scene/brick.ts';
import { initAudio, playClick, playResize } from '../ui/audio.ts';
import { ed, ghostItemsChanged } from './ghost.ts';

/** The ghost's one brick when the size and type controls can change it: a single item, not an import. */
export function ghostBrick(): Brick | null {
  const g = ed.ghost;
  return g && g.items.length === 1 && !g.onPlace ? g.items[0]! : null;
}

const stepOf = (t: Brick, i: number): number => sizeRule(t).steps[i]!;

/** Grid steps of brick `t` along axis i. */
export const ghostUnits = (t: Brick, i: number): number => Math.round((t.hi[i]! - t.lo[i]!) / stepOf(t, i) + 1e-9);
export const ghostFixedAxis = (t: Brick, i: number): boolean => fixedSize(t) || !!sizeRule(t).fix[i];
export const ghostMinUnits = (t: Brick, i: number): number => (ghostFixedAxis(t, i) ? ghostUnits(t, i) : sizeRule(t).min[i]!);
export const ghostMaxUnits = (t: Brick, i: number): number => (ghostFixedAxis(t, i) ? ghostUnits(t, i) : Math.round(MAX / stepOf(t, i)));

const clampUnits = (t: Brick, i: number, n: number): number => Math.max(ghostMinUnits(t, i), Math.min(ghostMaxUnits(t, i), n));

/** Sets the ghost brick's size along axis i to n grid steps; false when nothing changed. */
export function setGhostSize(i: number, n: number): boolean {
  const t = ghostBrick();
  if (!t || !(n > 0) || ghostFixedAxis(t, i)) return false;
  const to = clampUnits(t, i, Math.round(n));
  if (to === ghostUnits(t, i)) return false;
  t.hi[i] = r3(t.lo[i]! + to * stepOf(t, i));
  ghostItemsChanged();
  initAudio(); playResize(to);
  return true;
}

/** Brick / Tile / Smooth Tile / Microbrick for the ghost brick. It keeps its size, rounded to the new grid. */
export function setGhostType(mode: string): boolean {
  const t = ghostBrick();
  if (!t || lockedType(t) || mode === brickType(t)) return false;
  const len = [0, 1, 2].map((i) => t.hi[i]! - t.lo[i]!);
  if (t.shape === 'ramp') { delete t.shape; delete t.run; delete t.lip; }
  if (t.shape === 'crest' || t.shape === 'crestEnd') { delete t.shape; delete t.run; delete t.closed; }
  t.top = mode === 'tile' ? 'smooth' : mode === 'plain' ? 'plain' : 'studs';
  t.tile = t.top === 'smooth';
  t.micro = mode === 'micro';
  for (let i = 0; i < 3; i++) t.hi[i] = r3(t.lo[i]! + clampUnits(t, i, Math.max(1, Math.round(len[i]! / stepOf(t, i) + 1e-9))) * stepOf(t, i));
  ghostItemsChanged();
  initAudio(); playClick();
  return true;
}
