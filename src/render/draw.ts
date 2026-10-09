// Single draws: the per-brick attributes as constants (their arrays are off), and the mesh
// attribute layouts. Used for the focused brick, the washes, the ghosts and the grid.

import { LOC, type Gfx } from './gl.ts';
import { brickFlags, type Brick } from '../scene/brick.ts';
import { boxVB, shapeBuffer, shapeCount, shapeExtras } from './meshes/registry.ts';

export let G!: Gfx;
export function initDraw(g: Gfx): void { G = g; }

/** place a unit box at [l, h] (world [X,Y,Z] faces, current frame) */
export function setBox(l: readonly number[], h: readonly number[]): void {
  const gl = G.gl;
  gl.vertexAttrib3f(LOC.iScale, h[0] - l[0], h[2] - l[2], h[1] - l[1]);
  gl.vertexAttrib3f(LOC.iCenter, (l[0] + h[0]) / 2, (l[2] + h[2]) / 2, (l[1] + h[1]) / 2);
}

/** setBox plus the brick's colour and flags */
export function setBrick(b: Brick, l: readonly number[], h: readonly number[]): void {
  const gl = G.gl;
  setBox(l, h);
  gl.vertexAttrib3f(LOC.iColor, b.color[0], b.color[1], b.color[2]);
  const f = brickFlags(b); gl.vertexAttrib4f(LOC.iFlags, f[0], f[1], f[2], f[3]);
}

/** aPos / aNrm (/ aSlope, / aPart aCap) from the cube or a shape mesh */
export function meshAttribs(buf: WebGLBuffer, shaped: boolean): void {
  const gl = G.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const ex = shaped && shapeExtras(buf);   // stride 48 with part + cap
  const st = ex ? 48 : shaped ? 28 : 24;
  gl.vertexAttribPointer(LOC.aPos, 3, gl.FLOAT, false, st, 0); gl.vertexAttribPointer(LOC.aNrm, 3, gl.FLOAT, false, st, 12);
  if (shaped) { gl.enableVertexAttribArray(LOC.aSlope); gl.vertexAttribPointer(LOC.aSlope, 1, gl.FLOAT, false, st, 24); }
  else { gl.disableVertexAttribArray(LOC.aSlope); gl.vertexAttrib1f(LOC.aSlope, 0); }
  if (ex) {
    gl.enableVertexAttribArray(LOC.aPart); gl.vertexAttribPointer(LOC.aPart, 1, gl.FLOAT, false, 48, 28);
    gl.enableVertexAttribArray(LOC.aCap); gl.vertexAttribPointer(LOC.aCap, 4, gl.FLOAT, false, 48, 32);
  } else {
    gl.disableVertexAttribArray(LOC.aPart); gl.vertexAttrib1f(LOC.aPart, 0);
    gl.disableVertexAttribArray(LOC.aCap); gl.vertexAttrib4f(LOC.aCap, 0, 0, 0, 0);
  }
}

/** one brick body at [l, h] with its real mesh (element array: the cube's triangles bound) */
export function drawBody(b: Brick, l: readonly number[], h: readonly number[]): void {
  const gl = G.gl;
  setBrick(b, l, h);
  if (b.shape) {
    const m = shapeBuffer(b, [h[0] - l[0], h[1] - l[1], h[2] - l[2]]);
    meshAttribs(m, true);
    gl.drawArrays(gl.TRIANGLES, 0, shapeCount(m));
    meshAttribs(boxVB, false);
  } else gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
}
