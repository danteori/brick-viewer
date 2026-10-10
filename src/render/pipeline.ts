// The forward pipeline (lite, and the full build's Low tier): bodies with the tone map in the
// shader, then the overlays after it, sharing scene depth: hover wash, grab glow, ground grid,
// resize ghost and the editor ghost. Draw order and state match the legacy frame() exactly.

import { S, hasFocus } from '../app/state.ts';
import { mul } from '../core/math.ts';
import { BEVEL, BEVEL_FIT, SHADE, STEP } from '../core/units.ts';
import type { V3 } from '../scene/brick.ts';
import { G, bodyShape, drawBody, setBox } from './draw.ts';
import { drawInstances, inst, setFarLod, syncInstances, type ViewCull } from './instances.ts';
import { hidesCovered, lodLevel, lodSettings } from './lod.ts';
import { syncScene } from '../scene/sync.ts';
import { drawGrid } from './grid.ts';
import { drawExtras, extrasDepth } from './extras.ts';
import { drawGround, drawGroundBackdrop } from './ground.ts';
import { bloomPass, drawGlow, drawMaterials, focusIsSpecial, hasGlow } from './matpass.ts';
import { LIGHTING, lightDir } from './lighting.ts';
import { nearOf, studPx } from './camera.ts';
import { BOX_EDGE_COUNT, boxEB, boxIB } from './meshes/registry.ts';
import { proposedBox } from '../editor/resize.ts';
import { perfBegin, perfEnd, perfMark } from './perf.ts';
import { useBrickVariant } from './gl.ts';
import { cutActive, setCutUniforms } from './cutaway.ts';
import { movedBox } from '../editor/move.ts';

/** index in the cube's faces of the near face for X (+-x), Y (+-GL z), Z (top +y, bottom -y) */
export const faceOf = (i: number): number => (i === 0 ? (S.ns[0] > 0 ? 0 : 1) : i === 1 ? (S.ns[1] > 0 ? 4 : 5) : (S.ns[2] > 0 ? 2 : 3));

/** Draws one frame into a w x h drawing buffer; returns the ortho scale (sx, sy) for the DOM overlays. */
export function renderFrame(w: number, h: number, canvas: HTMLCanvasElement): { sx: number; sy: number } {
  const cutOn = cutActive();
  useBrickVariant(G, cutOn);                 // the X-ray cutaway's program only while it's on
  const { gl, u } = G, { cam, dlo, dhi } = S;
  perfBegin(); perfMark('setup');
  gl.viewport(0, 0, w, h);
  const asp = w / h, fx = Math.max(asp, 1), fy = Math.max(1 / asp, 1);
  const [pl, ph] = proposedBox();
  const half = cam.half;
  const sx = 1 / (half * fx), sy = 1 / (half * fy);
  // the GPU sees positions relative to the render origin, the frame the camera lives in
  const cx = cam.x, cy = cam.y;
  const ortho = new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, -1 / 60, 0, -cx * sx, -cy * sy, 0, 1]);
  const view = S.view;
  const cull: ViewCull = { x0: cx - half * fx, x1: cx + half * fx, y0: cy - half * fy, y1: cy + half * fy, depth: 60 };
  gl.uniformMatrix4fv(u.uMVP, false, mul(ortho, view));
  gl.uniform3f(u.uEye, view[2], view[6], view[10]);   // view-space +z (toward the camera) in world/GL space
  if (cutOn) setCutUniforms(G);
  { const P = LIGHTING[S.lighting]; gl.uniform3fv(u.uSun, P.sun); gl.uniform3fv(u.uSky, P.sky); gl.uniform3fv(u.uFloor, P.floor); gl.uniform1f(u.uExposure, P.exposure); }
  { const L = lightDir(); gl.uniform3f(u.uLight, L[0], L[1], L[2]); }
  gl.clearColor(0.169, 0.173, 0.188, 1);          // #2b2c30, matches --bg
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // bodies: all but the focused one come from the instance buffers; the focused one is drawn live
  perfMark('sync');
  syncScene();
  syncInstances();
  // depth range: +-60 view units as before, or enough to hold the whole scene (big builds zoomed out)
  const reach = Math.max(inst.set!.depthReach(), extrasDepth(), Math.abs(view[2]! * (dlo[0]! - S.origin[0]) + view[6]! * (dlo[2]! - S.origin[2]) + view[10]! * (dlo[1]! - S.origin[1])));
  const zr = reach * 1.05 + 1 > 60 ? reach * 1.05 + 1 : 60;
  if (zr !== 60) { ortho[10] = -1 / zr; cull.depth = zr; gl.uniformMatrix4fv(u.uMVP, false, mul(ortho, view)); }
  // far LOD (render/lod.ts) by how many device pixels a stud (0.2 view units) is
  const level = lodSettings.on ? lodLevel(0.2 * h / (2 * half * fy)) : 0;
  setFarLod(level);
  // covered faces are dropped only from the approximate levels on, and never in the X-ray cutaway
  // (its hole exposes them)
  gl.uniform1f(u.uShowHidden, cutOn || !hidesCovered(level) ? 1 : 0);
  perfMark('opaque');
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
  gl.uniform1f(u.uEdge, 0); gl.uniform1f(u.uBevelMax, BEVEL); gl.uniform1f(u.uBevelFit, BEVEL_FIT ? 1 : 0);
  // studs / underside fade out when a stud is only a few px
  gl.uniform1f(u.uStudFade, Math.max(0, Math.min(1, (studPx(0) - 6) / 8)));
  // stud-crease specular AA (U-10): full strength below SPEC_AA_PX_LO px a stud, off from SPEC_AA_PX_HI
  const realStudPx = studPx(0) * STEP / S.STEPS[0];   // a real stud, whatever grid the focused brick uses
  gl.uniform1f(u.uSpecAA, Math.max(0, Math.min(1, (SHADE.SPEC_AA_PX_HI - realStudPx) / (SHADE.SPEC_AA_PX_HI - SHADE.SPEC_AA_PX_LO))));
  // slope texture: one bump is 1/SHADE.BUMPS stud; fade it out between ~1.5 and 4 px
  const bumpFade = Math.max(0, Math.min(1, (studPx(0) * STEP / S.STEPS[0] / SHADE.BUMPS - 1.5) / 2.5));
  gl.uniform1f(u.uBump, SHADE.BUMP_STRENGTH * bumpFade);
  drawGroundBackdrop(ortho, view);           // the far ground plate, if an environment shows one
  const drawFocus = (): void => {
    const b = S.focus;
    if (!hasFocus() || !b || focusIsSpecial() || S.hidden.has(S.sel)) return;   // empty scene, glass / glow (drawMaterials has it), or being moved
    drawBody(b, dlo, dhi, S.selection.has(S.sel) ? 1 : 0, bodyShape(b, dlo, dhi, S.scene.orient[S.sel]));
  };
  drawInstances(drawFocus, cull);
  perfMark('extras');
  drawExtras(cull);                          // read-only dynamic grids (none unless a world placed some)
  drawGround();                              // the ground plate (off unless an environment is applied)
  perfMark('materials');
  drawMaterials(dlo, dhi);                   // glow, then glass / translucent back to front (if any)
  perfMark('bloom');
  if (bloomPass && hasGlow()) {              // full build: the glow halo
    // the depth-only pass takes the shader's early exit (uEdge): its colour is masked off anyway
    bloomPass(w, h, () => { gl.uniform1f(u.uEdge, 1); drawInstances(drawFocus, cull); drawExtras(cull); drawGround(); gl.uniform1f(u.uEdge, 0); }, () => drawGlow(dlo, dhi, 2));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  }
  perfMark('overlays');
  gl.uniform1f(u.uEdge, 1); gl.uniform1f(u.uFadeR, 0);
  // hovering another brick: a faint wash on the face under the cursor (click = focus it)
  if (!S.held && S.hoverBrick >= 0 && S.hoverBrick !== S.sel && S.scene.alive(S.hoverBrick)) {
    const bx = S.scene.box(S.hoverBrick), U = 0.02;
    setBox([bx[0]! * U, bx[1]! * U, bx[2]! * U], [bx[3]! * U, bx[4]! * U, bx[5]! * U]);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
    gl.uniform4f(u.uLine, 1, 1, 1, 0.07);
    gl.uniform1f(u.uCutEdge, 1);             // the X-ray cutaway cuts the wash like the face under it
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, faceOf(S.hoverFace) * 6 * 2);
    gl.uniform1f(u.uCutEdge, 0);
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
    const i = S.pendAxis, mb = movedBox(), shrink = !mb && S.pendUnits < 0;
    let gL = dlo.slice() as V3, gH = dhi.slice() as V3;
    if (mb) { gL = mb[0] as V3; gH = mb[1] as V3; }        // Move tool: where the bricks (their box) would go
    else {
      const cn = nearOf(i, dlo, dhi), pn = nearOf(i, pl, ph);
      gL[i] = Math.min(cn, pn); gH[i] = Math.max(cn, pn);
    }
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
  perfEnd();
  return { sx, sy };
}
