// Hover picking: a ray from the cursor into the view; the nearest brick box it hits and the face it
// enters through (0 = near X, 1 = near Y, 2 = top, or bottom from below). On the focused brick that
// gives a grab face (hoverAxis); on any other brick a focus target (hoverBrick). Only re-picked when
// the cursor, the camera or the scene changed.

import { S } from '../app/state.ts';
import { fixedSize } from '../scene/brick.ts';
import { pickRay } from '../scene/spatial.ts';
import { sceneRev } from '../scene/sync.ts';
import { isFixedAxis } from './resize.ts';
import { cutKey } from '../render/cutaway.ts';

export function updateHover(canvas: HTMLCanvasElement, sx: number, sy: number): void {
  const live = !S.noOverlay && !S.held && !S.orbit.dragging && S.mouse && S.mouseOnCanvas && !S.hooks.placing();   // no hover while placing a ghost
  const { cam, orbit } = S;
  const key = live ? [S.mouse![0], S.mouse![1], cam.x, cam.y, sx, sy, orbit.yaw, orbit.pitch, S.sel, sceneRev, S.hidden.size, ...S.dlo, ...S.dhi, cutKey()].join() : '';
  if (key !== S.pickKey) {
    S.pickKey = key;
    S.hoverAxis = -1; S.hoverBrick = -1; S.hoverFace = -1;
    if (live) {
      const cw = canvas.clientWidth, ch = canvas.clientHeight, m = S.mouse!;
      const hit = pickRay((2 * m[0] / cw - 1) / sx + cam.x, (1 - 2 * m[1] / ch) / sy + cam.y);
      if (hit) { S.hoverBrick = hit.k; S.hoverFace = hit.ax >= 0 ? hit.ax : 2; }
      if (S.tool === 'resize' && S.hoverBrick === S.sel && !fixedSize(S.focus) && !isFixedAxis(S.hoverFace)) S.hoverAxis = S.hoverFace;   // fixed rounds / axes, other tools: no grab faces
    }
  }
  canvas.style.cursor = orbit.dragging ? 'move' : S.held ? (S.lockAxis >= 0 ? 'grabbing' : 'default')
    : S.hoverAxis >= 0 ? 'grab' : S.hoverBrick >= 0 && S.hoverBrick !== S.sel ? 'pointer' : 'default';
}
