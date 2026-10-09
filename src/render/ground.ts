// Ground plate (backlog W-02; spec in src/env/ground-plate.ts): a plate whose top is world Z = 0,
// drawn with the brick shader as one wide, thin box under the focused brick, so it gets the same
// lighting, tone map and stud texture as a brick top. Endless in effect: the box is re-placed
// under the view every frame, snapped to the stud grid so the studs line up with the bricks.
// Variance (accent-coloured cells) isn't drawn yet: it needs per-cell colour in the shader.
// Two passes (see drawGroundBackdrop). Hidden from below (the game's plate has no underside) and
// whenever S.ground is null, which is the default: only an applied environment turns it on, so
// scenes without one render as before.

import { S } from '../app/state.ts';
import { PLATE, STEP } from '../core/units.ts';
import { linearToSrgb } from '../format/environment.ts';
import type { Brick, V3 } from '../scene/brick.ts';
import { G, drawBody } from './draw.ts';
import { mul } from '../core/math.ts';

const visible = (): boolean => !!S.ground?.visible && S.orbit.pitch >= 0;

/** The plate box `reach` view units each way around the focused brick, snapped to the stud grid. */
function drawPlate(reach: number): void {
  const g = S.ground!, E = Math.ceil(reach / STEP) * STEP;
  const c = [0, 1].map((i) => Math.round(((S.dlo[i]! + S.dhi[i]!) / 2) / STEP) * STEP);
  const top = 0;
  const lo: V3 = [c[0]! - E, c[1]! - E, top - PLATE], hi: V3 = [c[0]! + E, c[1]! + E, top];
  const plate: Brick = {
    lo, hi, micro: false, up: 1, top: g.studTexture ? 'studs' : 'smooth',
    color: g.color.map((v) => linearToSrgb(Math.max(0, v))),
  };
  drawBody(plate, lo, hi);
}

/**
 * Pass 1, before the bricks: the far plate as a backdrop, out to the horizon. The view's depth
 * range is only +-60 units, so this pass uses a much deeper projection, then clears the depth it
 * wrote; pass 2 redraws the near part with real depth.
 */
export function drawGroundBackdrop(ortho: Float32Array, view: Float32Array): void {
  if (!visible()) return;
  const { gl, u } = G, deep = ortho.slice();
  deep[10] = -1 / 1e6;
  gl.uniformMatrix4fv(u.uMVP, false, mul(deep, view));
  drawPlate(S.cam.half * 40);
  gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.uniformMatrix4fv(u.uMVP, false, mul(ortho, view));
}

/** Pass 2, after the bricks: the near plate with depth, so it hides what's below Z = 0. */
export function drawGround(): void {
  if (!visible()) return;
  drawPlate(Math.min(S.cam.half * 3, 60));
}
