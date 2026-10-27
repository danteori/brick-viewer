import { PLATE } from '../core/units.ts';

/** The X-ray settings: on or off, Hole (cut.size) and Keep (cut.keep). */
export interface XrayState { on: boolean; size: number; keep: number }

/** What a focus needs to show whole: the smallest Hole and the largest Keep. */
export interface XrayNeed { size: number; keep: number }

/** One Keep slider step: a brick (3 plates). */
export const KEEP_STEP = 3 * PLATE;
/** The Keep slider's top, in viewer units (20 bricks). */
export const KEEP_MAX = 20 * KEEP_STEP;
/** The Hole slider's top: a fraction of the view's half-height. */
export const SIZE_MAX = 0.8;

/** The values X-ray starts from, and goes back to when it turns off. */
export const XRAY_DEFAULTS: Readonly<XrayNeed> = { size: 0.2, keep: 15 * PLATE };

/** The fitted Hole is this much larger than needed. */
export const HOLE_MARGIN = 0.1;
/** The fitted Keep stays at least this far under the lowest brick to cut. */
export const KEEP_MARGIN = PLATE;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * The need from the covering bricks: `rise`, how far the lowest one rises past the focus (its top
 * over the focus top, or under its bottom from below); `extra`, the tube radius it needs past Hole 0;
 * `half`, the view's half-height.
 */
export function needFrom(rise: number, extra: number, half: number): XrayNeed {
  const keep = clamp(Math.floor((rise - KEEP_MARGIN) / KEEP_STEP + 1e-9) * KEEP_STEP, 0, KEEP_MAX);
  const size = clamp(Math.max(0, extra) / Math.max(half, 1e-9) + HOLE_MARGIN, 0, SIZE_MAX);
  return { size, keep };
}

/**
 * The next X-ray settings for a newly selected focus with `need` (null: nothing covers it).
 * Off: it turns on with the fit. On: Hole only grows and Keep only drops, so hand edits stay
 * until a focus needs more. Nothing covers it: off, with the defaults back.
 */
export function fitXray(cur: XrayState, need: XrayNeed | null): XrayState {
  if (!need) return xrayOff();
  if (!cur.on) return { on: true, size: need.size, keep: need.keep };
  return { on: true, size: Math.max(cur.size, need.size), keep: Math.min(cur.keep, need.keep) };
}

/** X-ray off, with the default Hole and Keep. */
export const xrayOff = (): XrayState => ({ on: false, ...XRAY_DEFAULTS });
