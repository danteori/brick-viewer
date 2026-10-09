// Single draws: the per-brick attributes as constants (their arrays are off) and the box in uBox /
// uChunkOffset, and the mesh attribute layouts. Used for the focused brick, the special-material
// bricks, the washes, the ghosts, the ground plate and the grid. Positions are absolute viewer
// units on the CPU; the GPU gets them relative to the render origin S.origin (in doubles here).

import { LOC, type Gfx } from './gl.ts';
import { S } from '../app/state.ts';
import { BRZ_UNIT } from '../core/units.ts';
import type { Brick } from '../scene/brick.ts';
import { assetOf } from '../scene/save.ts';
import { kindOfName, orientMatches, topOf } from '../scene/view.ts';
import { localSize } from '../core/orient.ts';
import { BOX_MESH, boxVB, meshOf, type Mesh } from './meshes/registry.ts';

export let G!: Gfx;
export function initDraw(g: Gfx): void { G = g; }

/** The packed iHalf.w word: orientation byte, top style (0 studs, 1 plain, 2 smooth), micro, linear colour. */
export const packWord = (o: number, top: number, micro: boolean, linear = false): number => o | (top << 5) | (micro ? 128 : 0) | (linear ? 256 : 0);

/** A single draw centred at absolute point (x, y, z) (save axes), local GL size (sx, sy, sz), word w. */
export function setSingle(x: number, y: number, z: number, sx: number, sy: number, sz: number, w: number, misc = 0): void {
  const gl = G.gl, u = G.u, o = S.origin;
  gl.uniform4f(u.uBox, sx, sy, sz, 1);
  gl.uniform3f(u.uChunkOffset, x - o[0], z - o[2], y - o[1]);
  gl.vertexAttribI4i(LOC.iPos, 0, 0, 0, 0);
  gl.vertexAttribI4ui(LOC.iHalf, 0, 0, 0, w);
  gl.vertexAttribI4ui(LOC.iMisc, 0, 0, 0, misc);
}

/** place a unit box at [l, h] (world [X,Y,Z] faces, absolute viewer units), not turned */
export function setBox(l: readonly number[], h: readonly number[]): void {
  setSingle((l[0]! + h[0]!) / 2, (l[1]! + h[1]!) / 2, (l[2]! + h[2]!) / 2, h[0]! - l[0]!, h[2]! - l[2]!, h[1]! - l[1]!, 16);
}

/** How a brick record draws: its orientation byte, local size (GL axes) and mesh. */
export interface BodyShape { o: number; size: [number, number, number]; mesh: Mesh; word: number }

/**
 * The shape of brick b drawn over world faces [l, h]. `orient`: its stored orientation byte, used
 * when it agrees with b (a box brick's quarter turns all look alike, so b alone can't tell them).
 */
export function bodyShape(b: Brick, l: readonly number[], h: readonly number[], orient = -1): BodyShape {
  let o = orient >= 0 && orientMatches(orient, b) ? orient : -1;
  if (o < 0) { o = 16; for (let k = 0; k < 24; k++) if (orientMatches(k, b)) { o = k; break; } }
  if (b.shape === 'special' || b.shape === 'micro' || (b.shape === 'round' && b.o != null)) o = b.o ?? 16;
  const asset = assetOf(b), kind = kindOfName(asset, o);
  const ls = localSize(o, [h[0]! - l[0]!, h[1]! - l[1]!, h[2]! - l[2]!]);         // local X, Y, Z lengths
  const half = ls.map((v) => Math.round(v / 2 / BRZ_UNIT));
  const t = topOf(asset);
  return { o, size: [ls[0], ls[2], ls[1]], mesh: meshOf(kind, asset, half[0]!, half[1]!, half[2]!), word: packWord(o, t.top, t.micro) };
}

/** a single draw of brick b over [l, h]: its colour, flags and turned box (no mesh bound) */
export function setBrick(b: Brick, l: readonly number[], h: readonly number[], shape: BodyShape = bodyShape(b, l, h), misc = 0): BodyShape {
  const gl = G.gl;
  setSingle((l[0]! + h[0]!) / 2, (l[1]! + h[1]!) / 2, (l[2]! + h[2]!) / 2, shape.size[0], shape.size[1], shape.size[2], shape.word, misc);
  gl.vertexAttrib4f(LOC.iColor, b.color[0]!, b.color[1]!, b.color[2]!, (b.intensity ?? 5) / 255);
  return shape;
}

/** aPos / aNrm (/ aSlope, / aPart aCap) from a mesh, on the bound vertex array */
export function bindMesh(m: Mesh): void {
  const gl = G.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, m.buf);
  const st = m.layout === 2 ? 48 : m.layout === 1 ? 28 : 24;
  gl.enableVertexAttribArray(LOC.aPos); gl.vertexAttribPointer(LOC.aPos, 3, gl.FLOAT, false, st, 0);
  gl.enableVertexAttribArray(LOC.aNrm); gl.vertexAttribPointer(LOC.aNrm, 3, gl.FLOAT, false, st, 12);
  if (m.layout) { gl.enableVertexAttribArray(LOC.aSlope); gl.vertexAttribPointer(LOC.aSlope, 1, gl.FLOAT, false, st, 24); }
  else { gl.disableVertexAttribArray(LOC.aSlope); gl.vertexAttrib1f(LOC.aSlope, 0); }
  if (m.layout === 2) {
    gl.enableVertexAttribArray(LOC.aPart); gl.vertexAttribPointer(LOC.aPart, 1, gl.FLOAT, false, 48, 28);
    gl.enableVertexAttribArray(LOC.aCap); gl.vertexAttribPointer(LOC.aCap, 4, gl.FLOAT, false, 48, 32);
  } else {
    gl.disableVertexAttribArray(LOC.aPart); gl.vertexAttrib1f(LOC.aPart, 0);
    gl.disableVertexAttribArray(LOC.aCap); gl.vertexAttrib4f(LOC.aCap, 0, 0, 0, 0);
  }
}

/** one brick body at [l, h] with its real mesh (element array: the cube's triangles bound) */
export function drawBody(b: Brick, l: readonly number[], h: readonly number[], misc = 0, shape?: BodyShape): void {
  const gl = G.gl, s = setBrick(b, l, h, shape, misc);
  if (s.mesh !== BOX_MESH) {
    bindMesh(s.mesh);
    gl.drawArrays(gl.TRIANGLES, 0, s.mesh.count);
    bindMesh(BOX_MESH);
  } else gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
}

export { boxVB };
