// The forward pipeline (lite, and the full build's Low tier): bodies with the tone map in the
// shader, then the overlays after it, sharing scene depth: hover wash, grab glow, ground grid,
// resize ghost and the editor ghost. Draw order and state match the legacy frame() exactly.

import { S } from '../app/state.ts';
import { mul } from '../core/math.ts';
import { BEVEL, BEVEL_FIT, SHADE, STEP } from '../core/units.ts';
import type { V3 } from '../scene/brick.ts';
import { G, drawBody, setBox } from './draw.ts';
import { drawInstances, syncInstances } from './instances.ts';
import { drawGrid } from './grid.ts';
import { drawExtras } from './extras.ts';
import { drawGround, drawGroundBackdrop } from './ground.ts';
import { bloomPass, drawGlow, drawMaterials, focusIsSpecial, hasGlow } from './matpass.ts';
import { LIGHTING, lightDir } from './lighting.ts';
import { nearOf, studPx } from './camera.ts';
import { BOX_EDGE_COUNT, boxEB, boxIB } from './meshes/registry.ts';
import { proposedBox } from '../editor/resize.ts';

/** index in the cube's faces of the near face for X (+-x), Y (+-GL z), Z (top +y, bottom -y) */
export const faceOf = (i: number): number => (i === 0 ? (S.ns[0] > 0 ? 0 : 1) : i === 1 ? (S.ns[1] > 0 ? 4 : 5) : (S.ns[2] > 0 ? 2 : 3));

/** Draws one frame into a w x h drawing buffer; returns the ortho scale (sx, sy) for the DOM overlays. */
export function renderFrame(w: number, h: number, canvas: HTMLCanvasElement): { sx: number; sy: number } {
  const { gl, u } = G, { cam, dlo, dhi } = S;
  gl.viewport(0, 0, w, h);
  const asp = w / h, fx = Math.max(asp, 1), fy = Math.max(1 / asp, 1);
  const [pl, ph] = proposedBox();
  const half = cam.half;
  const sx = 1 / (half * fx), sy = 1 / (half * fy);
  const ortho = new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, -1 / 60, 0, -cam.x * sx, -cam.y * sy, 0, 1]);
  const view = S.view;
  gl.uniformMatrix4fv(u.uMVP, false, mul(ortho, view));
  gl.uniform3f(u.uEye, view[2], view[6], view[10]);   // view-space +z (toward the camera) in world/GL space
  { const P = LIGHTING[S.lighting]; gl.uniform3fv(u.uSun, P.sun); gl.uniform3fv(u.uSky, P.sky); gl.uniform3fv(u.uFloor, P.floor); gl.uniform1f(u.uExposure, P.exposure); }
  { const L = lightDir(); gl.uniform3f(u.uLight, L[0], L[1], L[2]); }
  gl.clearColor(0.169, 0.173, 0.188, 1);          // #2b2c30, matches --bg
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // bodies: all but the focused one come from the instance buffers; the focused one is drawn live
  syncInstances();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
  gl.uniform1f(u.uEdge, 0); gl.uniform1f(u.uBevelMax, BEVEL); gl.uniform1f(u.uBevelFit, BEVEL_FIT ? 1 : 0);
  // studs / underside fade out when a stud is only a few px
  gl.uniform1f(u.uStudFade, Math.max(0, Math.min(1, (studPx(0) - 6) / 8)));
  // slope texture: one bump is 1/SHADE.BUMPS stud; fade it out between ~1.5 and 4 px
  const bumpFade = Math.max(0, Math.min(1, (studPx(0) * STEP / S.STEPS[0] / SHADE.BUMPS - 1.5) / 2.5));
  gl.uniform1f(u.uBump, SHADE.BUMP_STRENGTH * bumpFade);
  drawGroundBackdrop(ortho, view);           // the far ground plate, if an environment shows one
  const drawFocus = (): void => {
    const b = S.bricks[S.sel];
    if (!b || focusIsSpecial()) return;      // empty scene, or glass / glow: drawMaterials has it
    drawBody(b, dlo, dhi);
  };
  drawInstances(drawFocus);
  drawExtras();                              // read-only dynamic grids (none unless a world placed some)
  drawGround();                              // the ground plate (off unless an environment is applied)
  drawMaterials(dlo, dhi);                   // glow, then glass / translucent back to front (if any)
  if (bloomPass && hasGlow()) {              // full build: the glow halo
    bloomPass(w, h, () => { drawInstances(drawFocus); drawExtras(); drawGround(); }, () => drawGlow(dlo, dhi, 2));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  }
  gl.uniform1f(u.uEdge, 1); gl.uniform1f(u.uFadeR, 0);
  // hovering another brick: a faint wash on the face under the cursor (click = focus it)
  if (!S.held && S.hoverBrick >= 0 && S.hoverBrick !== S.sel) {
    const b = S.bricks[S.hoverBrick]; setBox(b.lo, b.hi);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
    gl.uniform4f(u.uLine, 1, 1, 1, 0.07);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, faceOf(S.hoverFace) * 6 * 2);
    gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND);
  }
  setBox(dlo, dhi);                          // back to the focused brick for the glow / ghost
  // grab glow: a light wash + soft rim on the face you can grab (hover), or the one being dragged
  const glowAxis = S.held ? S.lockAxis : S.hoverAxis;
  if (glowAxis >= 0) {
    const f = faceOf(glowAxis);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
    gl.uniform4f(u.uLine, 1, 1, 1, 0.13);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, f * 6 * 2);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.uniform4f(u.uLine, 1, 1, 1, 0.45);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxEB);
    gl.drawElements(gl.LINES, 8, gl.UNSIGNED_SHORT, f * 8 * 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
    gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND);
  }
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.uniform4f(u.uLine, 0.05, 0.05, 0.08, 1);

  drawGrid(half, fy, canvas.clientHeight);
  setBox(dlo, dhi);

  // resize ghost: the slab between the committed face and where it would go. Growing: translucent
  // white beyond the solid brick; shrinking: the part to be removed, darkened, seen through it.
  // Edges go on top of everything.
  if (S.pendAxis >= 0 && S.pendUnits) {
    const i = S.pendAxis, gL = dlo.slice() as V3, gH = dhi.slice() as V3, shrink = S.pendUnits < 0;
    const cn = nearOf(i, dlo, dhi), pn = nearOf(i, pl, ph);
    gL[i] = Math.min(cn, pn); gH[i] = Math.max(cn, pn);
    setBox(gL, gH);
    gl.uniform1f(u.uEdge, 1); gl.uniform1f(u.uFadeR, 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    if (shrink) { gl.disable(gl.DEPTH_TEST); gl.uniform4f(u.uLine, 0.08, 0.08, 0.1, 0.32); }
    else gl.uniform4f(u.uLine, 0.92, 0.95, 1, 0.13);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
    gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.uniform4f(u.uLine, 1, 1, 1, 0.9);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxEB);
    gl.drawElements(gl.LINES, BOX_EDGE_COUNT, gl.UNSIGNED_SHORT, 0);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    gl.uniform4f(u.uLine, 0.05, 0.05, 0.08, 1);
  }

  if (!S.noOverlay) for (const f of S.hooks.draw) f();   // the placement ghost (editor)
  return { sx, sy };
}
