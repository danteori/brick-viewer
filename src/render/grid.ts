// Ground grid: one cell per stud, lines along GL x and z (world X and Y), y = 0, drawn with the body
// path (aPos*iScale + iCenter) so iCenter places it under the scene. In microbrick mode a micro
// subdivision goes underneath, faded out when its lines get too close on screen.

import { S } from '../app/state.ts';
import { LOC } from './gl.ts';
import { G } from './draw.ts';
import { farOf, studPx } from './camera.ts';
import { inst } from './instances.ts';
import { boxVB } from './meshes/registry.ts';

const GRID_N = 150;                                 // cells each side of the origin
let gb: WebGLBuffer, mgb: WebGLBuffer, gridVerts = 0, microVerts = 0;

export function initGrid(): void {
  const gl = G.gl;
  const gridData: number[] = [];
  for (let k = -GRID_N; k <= GRID_N; k++) {
    const t = k * 0.2, e = GRID_N * 0.2;
    gridData.push(t, 0, -e, 0, 1, 0, t, 0, e, 0, 1, 0, -e, 0, t, 0, 1, 0, e, 0, t, 0, 1, 0);
  }
  gb = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, gb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridData), gl.STATIC_DRAW);
  gridVerts = gridData.length / 6;
  // a line every micro (1/5 stud) over the same area, skipping the ones on stud lines
  const microData: number[] = [];
  for (let k = -GRID_N * 5; k <= GRID_N * 5; k++) {
    if (k % 5 === 0) continue;
    const t = k * 0.04, e = GRID_N * 0.2;
    microData.push(t, 0, -e, 0, 1, 0, t, 0, e, 0, 1, 0, -e, 0, t, 0, 1, 0, e, 0, t, 0, 1, 0);
  }
  mgb = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, mgb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(microData), gl.STATIC_DRAW);
  microVerts = microData.length / 6;
}

/**
 * very light gray, one cell per stud, lined up with the focused brick's far (fixed) corner and
 * sitting under the lowest brick; it fades out with distance (and to nothing from below).
 */
export function drawGrid(half: number, fy: number, canvasHeight: number): void {
  const { gl, u } = G, { dlo, dhi } = S;
  const gx = farOf(0, dlo, dhi), gy = farOf(1, dlo, dhi);
  const groundZ = Math.min(dlo[2], inst.groundAbs - S.histOrigin[2]);
  const gridAt = (x: number, z: number, y: number): void => { gl.vertexAttrib3f(LOC.iScale, 1, 1, 1); gl.vertexAttrib3f(LOC.iCenter, x, z, y); };
  gridAt(gx, groundZ, gy);
  gl.uniform4f(u.uLine, 0.9, 0.9, 0.92, 0.38);
  gl.uniform3f(u.uFadeC, (dlo[0] + dhi[0]) / 2, 0, (dlo[1] + dhi[1]) / 2); gl.uniform1f(u.uFadeR, S.orbit.pitch > 0 ? half * 1.8 : 1e-6);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
  if (S.micro) {
    const a = Math.max(0, Math.min(1, (studPx(0) - 3) / 6)) * 0.7;
    if (a > 0) {
      gl.uniform4f(u.uLine, 0.46, 0.47, 0.52, a);
      gl.bindBuffer(gl.ARRAY_BUFFER, mgb);
      gl.vertexAttribPointer(LOC.aPos, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(LOC.aNrm, 3, gl.FLOAT, false, 24, 12);
      gl.drawArrays(gl.LINES, 0, microVerts);
    }
    gl.uniform4f(u.uLine, 0.9, 0.9, 0.92, 0.3);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, gb);
  gl.vertexAttribPointer(LOC.aPos, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(LOC.aNrm, 3, gl.FLOAT, false, 24, 12);
  if (S.micro) {
    // thicker stud lines over the micro grid: lines are 1px, so draw the stud grid three times,
    // shifted ~0.8px each way diagonally
    const pxPerUnit = canvasHeight / (2 * half * fy) * Math.SQRT2 / Math.sqrt(3);   // ground-plane px per world unit
    const d = 0.8 / pxPerUnit;
    for (const o of [-d, 0, d]) {
      gridAt(gx + o, groundZ, gy + o);
      gl.drawArrays(gl.LINES, 0, gridVerts);
    }
    gridAt(gx, groundZ, gy);
  } else gl.drawArrays(gl.LINES, 0, gridVerts);
  gl.depthMask(true); gl.disable(gl.BLEND);
  gl.bindBuffer(gl.ARRAY_BUFFER, boxVB);
  gl.vertexAttribPointer(LOC.aPos, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(LOC.aNrm, 3, gl.FLOAT, false, 24, 12);
  gl.uniform4f(u.uLine, 0.05, 0.05, 0.08, 1); gl.uniform1f(u.uFadeR, 0);
}
