// Player reference figure (backlog U-16): a box mannequin of a player's size, standing next to the
// focused brick as a scale reference. Our own design built from 11 boxes; only the overall
// proportions follow the game's player (48 units = 4.8 studs = 4 bricks tall, 23 wide at the arms).
//
// It is NOT a brick: it lives outside the scene store, so it is never saved, picked, selected or
// collided with. It is drawn as an overlay pass (S.hooks.draw) with the brick shader, depth-tested
// against the scene, and follows the focused brick: feet on the brick's base level (its bottom face,
// which is the ground for a brick on the ground), one stud out from the brick's camera-near X face,
// centred on the brick along Y, facing the camera's side. Off by default (P, or the "Figure (P)" button in the Lighting row).

import { S, hasFocus } from '../app/state.ts';
import { BRZ_UNIT } from '../core/units.ts';
import type { Brick, V3 } from '../scene/brick.ts';
import { G, drawBody, setBox } from './draw.ts';
import { boxIB } from './meshes/registry.ts';

/** Total height in Brickadia units (4 bricks). */
export const FIGURE_HEIGHT = 48;
/** Half-width at the arms, in units (the figure's X extent). */
const HALF_WIDTH = 11.7;
/** Gap between the brick and the figure, in units (one stud). */
const GAP = 10;

// part boxes, facing -Y: [centre x, centre y, z bottom, width (X), depth (Y), height (Z), colour]
const PARTS: readonly (readonly [number, number, number, number, number, number, number])[] = [
  [-3.9, -1, 0, 7.2, 10, 5, 0], [3.9, -1, 0, 7.2, 10, 5, 0],              // shoes
  [-3.9, 0, 5, 7.2, 8, 15, 1], [3.9, 0, 5, 7.2, 8, 15, 1],                // legs
  [0, 0, 20, 15, 8, 16.5, 2],                                            // torso
  [-9.6, 0, 22, 4.2, 4.6, 14.5, 2], [9.6, 0, 22, 4.2, 4.6, 14.5, 2],      // arms
  [-9.6, -0.4, 19, 3.6, 3.6, 3, 3], [9.6, -0.4, 19, 3.6, 3.6, 3, 3],      // hands
  [0, 0, 36.5, 6, 5, 0.5, 3],                                            // neck
  [0, 0, 37, 11.5, 11.5, 11, 3],                                         // head
];
/** neutral sRGB colours: shoes, legs, shirt, skin */
const COLOURS: readonly V3[] = [[120, 110, 100], [60, 60, 66], [230, 90, 70], [235, 235, 235]].map((c) => c.map((v) => v / 255) as V3);

export const figure = { on: false };

/** Where the figure stands: feet centre (absolute viewer units) and which way it faces along Y. Null without a focused brick. */
export function figurePlace(): { feet: V3; face: 1 | -1 } | null {
  if (!hasFocus()) return null;
  const lo = S.dlo, hi = S.dhi, sx = S.ns[0] > 0 ? 1 : -1, U = BRZ_UNIT;
  const x = (sx > 0 ? hi[0]! : lo[0]!) + sx * (GAP + HALF_WIDTH) * U;
  return { feet: [x, (lo[1]! + hi[1]!) / 2, lo[2]!], face: S.ns[1] > 0 ? 1 : -1 };
}

/** The figure's part boxes [lo, hi] in absolute viewer units (empty when it isn't shown). */
export function figureBoxes(): [V3, V3][] {
  const p = figure.on ? figurePlace() : null;
  if (!p) return [];
  const U = BRZ_UNIT, f = -p.face;                 // the parts face -Y; facing +Y turns them half way round
  return PARTS.map(([cx, cy, zb, w, d, h]) => {
    const x0 = f * (cx - w / 2), x1 = f * (cx + w / 2), y0 = f * (cy - d / 2), y1 = f * (cy + d / 2);
    return [[p.feet[0] + Math.min(x0, x1) * U, p.feet[1] + Math.min(y0, y1) * U, p.feet[2] + zb * U],
      [p.feet[0] + Math.max(x0, x1) * U, p.feet[1] + Math.max(y0, y1) * U, p.feet[2] + (zb + h) * U]];
  });
}

function drawFigure(): void {
  const boxes = figureBoxes();
  if (!boxes.length) return;
  const { gl, u } = G;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.uniform1f(u.uEdge, 0); gl.uniform1f(u.uFadeR, 0);
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LESS); gl.disable(gl.BLEND);
  boxes.forEach(([l, h], i) => {
    // a plain body: no studs, no underside (the micro-brick look), lit like the bricks
    const b: Brick = { lo: l, hi: h, micro: true, top: 'smooth', up: 1, color: COLOURS[PARTS[i]![6]]!.slice() };
    drawBody(b, l, h);
  });
  gl.uniform1f(u.uEdge, 1);
  gl.uniform4f(u.uLine, 0.05, 0.05, 0.08, 1);
  setBox(S.dlo, S.dhi);
}

export function initFigure(): void {
  S.hooks.draw.push(drawFigure);
}
