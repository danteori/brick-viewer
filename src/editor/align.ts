import { BRZ_UNIT, PLATE, STEP, MICRO, r3 } from '../core/units.ts';
import { debugFlag } from '../app/debugflags.ts';
import { placeholder } from '../ui/placeholder.ts';
import type { V3 } from '../scene/brick.ts';

export type AlignMode = 'plate' | 'half' | 'fifth' | 'tenth' | 'brick';
export const ALIGN_MODES: readonly AlignMode[] = ['plate', 'half', 'fifth', 'tenth', 'brick'];

const U = BRZ_UNIT;
const MODE_STEPS: Record<AlignMode, V3> = {
  plate: [STEP, STEP, PLATE],
  half: [5 * U, 5 * U, 2 * U],
  fifth: [2 * U, 2 * U, 1 * U],
  tenth: [1 * U, 1 * U, 1 * U],
  brick: [STEP, STEP, 3 * PLATE],
};

export const MODE_NAMES: Record<AlignMode, string> = {
  plate: placeholder('Plate'),
  half: placeholder('Half'),
  fifth: placeholder('Fifth'),
  tenth: placeholder('Tenth'),
  brick: placeholder('Brick'),
};
export const ALIGN_HINT = placeholder('V cycles the alignment');
export const LOCK_HINT = placeholder('hold Ctrl to lock the plane (PgUp / PgDn move it)');
export const FLOAT_HINT = placeholder('hold Alt to float the brick (scroll sets the distance)');
export const alignStatus = (m: AlignMode): string => placeholder(`Alignment: ${MODE_NAMES[m]}`);

export const alignKeyC = debugFlag('align-key-c', 'C cycles the placer alignment, precision mode only on G (game binding)');

/** The key that cycles the alignment: V, or C when the debug flag is on. */
export const cyclesAlignment = (key: string, classic: boolean): boolean => {
  const k = key.toLowerCase();
  return alignKeyC.on && !classic ? k === 'c' : k === 'v';
};

export const align = {
  mode: 'plate' as AlignMode,
  ctrl: false,
  alt: false,
};

export const nextMode = (m: AlignMode): AlignMode => ALIGN_MODES[(ALIGN_MODES.indexOf(m) + 1) % ALIGN_MODES.length]!;

/** The step on each axis for the ghost's items. A micro ghost never steps coarser than a micro. */
export function alignSteps(mode: AlignMode, micro: boolean): V3 {
  const s = MODE_STEPS[mode];
  if (!micro) return [s[0], s[1], s[2]];
  return [Math.min(s[0], MICRO), Math.min(s[1], MICRO), Math.min(s[2], MICRO)];
}

/** `value` moved to the nearest multiple of `step` from `ref`. */
export const snapTo = (value: number, ref: number, step: number): number => r3(ref + Math.round((value - ref) / step) * step);

export interface PlaneLock { axis: number; value: number }

/** Where a ray (origin S, direction D) crosses the plane `axis = at`, or null when it runs parallel or behind. */
export function planePoint(S: readonly number[], D: readonly number[], axis: number, at: number): V3 | null {
  if (Math.abs(D[axis]!) < 1e-9) return null;
  const t = (at - S[axis]!) / D[axis]!;
  if (t < 0) return null;
  return [0, 1, 2].map((i) => S[i]! + D[i]! * t) as V3;
}

/**
 * The pose of a ghost of `size` on a locked plane: the ray meets the plane through the ghost's centre,
 * the in-plane axes snap to `steps` from `ref`, and the locked axis sits at the plane value.
 */
export function lockedPose(lock: PlaneLock, S: readonly number[], D: readonly number[], size: V3, steps: V3, ref: V3): V3 | null {
  const P = planePoint(S, D, lock.axis, lock.value + size[lock.axis]! / 2);
  if (!P) return null;
  return [0, 1, 2].map((i) => (i === lock.axis ? r3(lock.value) : snapTo(P[i]! - size[i]! / 2, ref[i]!, steps[i]!))) as V3;
}

/** The pose of a floating ghost of `size`: its centre is `dist` along the ray, then snapped to `steps`. */
export function floatPose(S: readonly number[], D: readonly number[], dist: number, size: V3, steps: V3): V3 {
  return [0, 1, 2].map((i) => snapTo(S[i]! + D[i]! * dist - size[i]! / 2, 0, steps[i]!)) as V3;
}

/** How far along the ray `D` from `S` the point `c` lies. */
export const distanceAlong = (S: readonly number[], D: readonly number[], c: readonly number[]): number =>
  [0, 1, 2].reduce((a, i) => a + (c[i]! - S[i]!) * D[i]!, 0);
