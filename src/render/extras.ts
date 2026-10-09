// Read-only extra bricks drawn after the scene: a world's dynamic grids (vehicles, doors), placed at
// their entity transforms. They aren't in S.bricks, so they can't be focused, picked, resized,
// painted or saved. Records are uploaded once in frame-independent coordinates (local + histOrigin)
// and shifted by the current histOrigin at draw time. Nothing is drawn while the set is empty, so
// scenes without extras render exactly as before.

import { S } from '../app/state.ts';
import { G, meshAttribs } from './draw.ts';
import { INST_ATTRS, INST_F, inst, writeRecord } from './instances.ts';
import { boxVB, shapeBuffer, shapeCount } from './meshes/registry.ts';
import type { Brick } from '../scene/brick.ts';

interface Group { mesh: WebGLBuffer | null; buf: WebGLBuffer; n: number }

const extra = {
  bricks: [] as Brick[],
  groups: [] as Group[],
  dirty: false,
  /** a brick of the scene these extras belong to: hidden once it's no longer in S.bricks (undo of the load) */
  owner: null as Brick | null,
  ownerRev: -1,
  ownerHere: false,
};

/** Replaces the extra bricks (faces frame-independent). `owner`: a brick of the scene they go with. */
export function setExtraBricks(bricks: Brick[], owner: Brick | null): void {
  extra.bricks = bricks; extra.owner = owner; extra.dirty = true; extra.ownerRev = -1;
}

export const extraCount = (): number => extra.bricks.length;

function rebuild(): void {
  const gl = G.gl;
  for (const g of extra.groups) gl.deleteBuffer(g.buf);
  const byMesh = new Map<WebGLBuffer | null, Brick[]>();
  for (const b of extra.bricks) {
    const mesh = b.shape ? shapeBuffer(b, [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]]) : null;
    if (!byMesh.has(mesh)) byMesh.set(mesh, []);
    byMesh.get(mesh)!.push(b);
  }
  extra.groups = [...byMesh].map(([mesh, list]) => {
    const data = new Float32Array(list.length * INST_F), zero = [0, 0, 0];
    list.forEach((b, j) => writeRecord(data, j * INST_F, b, b.lo, b.hi, zero));
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return { mesh, buf, n: list.length };
  });
  extra.dirty = false;
}

/** Draws the extras (call with the body uniforms set and the cube's element array bound). */
export function drawExtras(): void {
  if (!extra.bricks.length) return;
  if (extra.ownerRev !== inst.rev) { extra.ownerRev = inst.rev; extra.ownerHere = !extra.owner || S.bricks.includes(extra.owner); }
  if (!extra.ownerHere) return;
  if (extra.dirty) rebuild();
  const gl = G.gl, u = G.u, o = S.histOrigin;
  gl.uniform3f(u.uShift, o[0], o[2], o[1]);
  for (const g of extra.groups) {
    meshAttribs(g.mesh ?? boxVB, !!g.mesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
    for (const [loc, n, off] of INST_ATTRS) {
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, INST_F * 4, off); gl.vertexAttribDivisor(loc, 1);
    }
    if (g.mesh) gl.drawArraysInstanced(gl.TRIANGLES, 0, shapeCount(g.mesh), g.n);
    else gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, g.n);
  }
  for (const [loc] of INST_ATTRS) { gl.disableVertexAttribArray(loc); gl.vertexAttribDivisor(loc, 0); }
  meshAttribs(boxVB, false);
  gl.uniform3f(u.uShift, 0, 0, 0);
}
