// Frame rows (W-10 outliner): focus the brick nearest the middle of the rows and fit their box.

import { S } from '../app/state.ts';
import { isFree } from '../app/mode.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { extents, fitHalf, ZOOM_MAX, ZOOM_MIN } from '../render/camera.ts';
import { selectBrick } from './resize.ts';

/** Focuses the row nearest the middle of `rows` and zooms to fit all of them. False when no row is alive. */
export function frameRows(rows: readonly number[]): boolean {
  const s = S.scene, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const live = rows.filter((id) => s.alive(id));
  if (!live.length) return false;
  for (const id of live) {
    const p = [s.px[id]!, s.py[id]!, s.pz[id]!], r = Math.max(s.hx[id]!, s.hy[id]!, s.hz[id]!);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, (p[i]! - r) * BRZ_UNIT); hi[i] = Math.max(hi[i]!, (p[i]! + r) * BRZ_UNIT); }
  }
  const mid = lo.map((v, i) => (v + hi[i]!) / 2 / BRZ_UNIT);
  let best = live[0]!, bestD = Infinity;
  for (const id of live) {
    const d = (s.px[id]! - mid[0]!) ** 2 + (s.py[id]! - mid[1]!) ** 2 + (s.pz[id]! - mid[2]!) ** 2;
    if (d < bestD) { bestD = d; best = id; }
  }
  selectBrick(best);
  const own = fitHalf(S.lo, S.hi);
  S.zoomMul = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, fitHalf(lo, hi) / own));
  if (isFree()) {
    const [x0, x1, y0, y1] = extents(lo, hi);
    S.cam.x = (x0 + x1) / 2; S.cam.y = (y0 + y1) / 2;
    S.cam.half = S.zoomMul * own;
  }
  return true;
}
