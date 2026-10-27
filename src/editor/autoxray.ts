import { S, hasFocus } from '../app/state.ts';
import { baseRadius, tubeFor, tubeHides, tubeReach } from '../render/cutaway.ts';
import { needFrom, type XrayNeed } from '../render/xrayfit.ts';
import { coveringBricks, pickReady } from '../scene/spatial.ts';

/** Auto X-ray (U-33): a new focus that other bricks cover turns X-ray on; one in the clear turns it off. Off in ?test until the test hook turns it on. */
export const xrayAuto = { on: true };

/**
 * What the focus needs to show whole, from the bricks between it and the camera that X-ray can
 * cut (Keep 0, Hole 0); null when no such brick covers it.
 */
export function focusNeed(): XrayNeed | null {
  if (!hasFocus()) return null;
  const covers = coveringBricks();
  if (!covers.length) return null;
  const t = tubeFor(0, 0), base = baseRadius(S.dlo, S.dhi);
  const B = pickReady().box, lo = [0, 0, 0], hi = [0, 0, 0];
  let rise = Infinity, reach = 0;
  for (const k of covers) {
    for (let i = 0; i < 3; i++) { lo[i] = B[k * 6 + i]!; hi[i] = B[k * 6 + 3 + i]!; }
    if (!tubeHides(t, lo, hi)) continue;
    rise = Math.min(rise, t.side > 0 ? hi[2]! - t.hi[2]! : t.lo[2]! - lo[2]!);
    reach = Math.max(reach, tubeReach(t, lo, hi));
  }
  return rise === Infinity ? null : needFrom(rise, reach - base, S.cam.half);
}

let seen: { scene: unknown; sel: number } = { scene: null, sel: -1 };

/** True once for each new focus (brick or scene), false otherwise; no focus never counts as new. */
export function focusChanged(): boolean {
  if (seen.scene === S.scene && seen.sel === S.sel) return false;
  seen = { scene: S.scene, sel: S.sel };
  return hasFocus();
}
