import { S, hasFocus } from '../app/state.ts';
import { baseRadius, tubeFor, tubeHides, tubeReach } from '../render/cutaway.ts';
import { needFrom, type XrayNeed } from '../render/xrayfit.ts';
import { boxQuery, coveringBricks, pickReady } from '../scene/spatial.ts';
import { cut } from '../render/cutaway.ts';
import { findRoom, ROOM_REACH } from '../scene/room.ts';
import { sceneRev } from '../scene/sync.ts';
import { PLATE, STEP } from '../core/units.ts';

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

const ROOM_REFRESH_MS = 400;
let roomFor: { scene: unknown; sel: number; mode: string; rev: number; at: number } | null = null;

/** Finds the room around the focus for the Room mode (when it is on): on a new focus at once, after edits at most every ROOM_REFRESH_MS. */
export function refreshRoom(force: boolean): void {
  if (!cut.on || cut.mode !== 'room' || !hasFocus()) { if (cut.room && cut.mode !== 'room') cut.room = null; return; }
  const now = performance.now(), r = roomFor;
  const same = r && r.scene === S.scene && r.sel === S.sel && r.mode === cut.mode;
  if (!force && same && (r.rev === sceneRev || now - r.at < ROOM_REFRESH_MS)) return;
  roomFor = { scene: S.scene, sel: S.sel, mode: cut.mode, rev: sceneRev, at: now };
  const pad = [ROOM_REACH.side * STEP, ROOM_REACH.side * STEP, ROOM_REACH.below * 3 * PLATE];
  const lo = S.dlo.map((v, i) => v - pad[i]!), hi = S.dhi.map((v, i) => v + (i === 2 ? ROOM_REACH.above * 3 * PLATE : pad[i]!));
  const ids = boxQuery(lo, hi), B = pickReady().box, flat = new Float64Array(ids.length * 6);
  ids.forEach((k, n) => { for (let i = 0; i < 6; i++) flat[n * 6 + i] = B[k * 6 + i]!; });
  cut.room = findRoom(flat, S.dlo, S.dhi);
}
