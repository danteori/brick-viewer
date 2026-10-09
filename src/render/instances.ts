// Instanced bodies (WebGL2 core instancing). Every brick except the focused one is drawn from
// instance buffers: one draw for all the boxes and one per shape mesh. A record is INST_F floats:
// centre (3), size (3), colour (3), flags (4), in GL axes. The box buffer has one slot per brick
// index; shaped bricks and the focused brick leave theirs zero-sized (nothing rasterises). The
// focused brick is drawn on its own from constants, at its index position, so coplanar ties
// resolve as when every brick was its own draw. Positions stay in the frame they were uploaded in
// (local + histOrigin - inst.base); recenter() only changes the uShift uniform.
// Phase 2 replaces this with chunk-relative 24-byte instances.

import { S } from '../app/state.ts';
import { LOC } from './gl.ts';
import { G, meshAttribs } from './draw.ts';
import { brickFlags, type Brick, type V3 } from '../scene/brick.ts';
import { boxVB, shapeBuffer, shapeCount } from './meshes/registry.ts';
import { pickGrid, pickUpdate } from '../scene/spatial.ts';
import { matCode } from './matcode.ts';

export const INST_F = 13;
export const INST_ATTRS: [number, number, number][] = [[LOC.iCenter, 3, 0], [LOC.iScale, 3, 12], [LOC.iColor, 3, 24], [LOC.iFlags, 4, 36]];

interface Group { mesh: WebGLBuffer; buf: WebGLBuffer; data: Float32Array; n: number }
export const inst = {
  n: -1, data: new Float32Array(0), base: [0, 0, 0] as V3, all: true, dirty: new Set<number>(), sel: -1,
  isShaped: new Uint8Array(0), groupsDirty: true, groups: [] as Group[],
  /** glass / translucent / glow bricks (not the focused one): drawn by matpass.ts, not from the buffers */
  isSpecial: new Uint8Array(0), special: [] as number[], specialDirty: true,
  /** lowest brick bottom except the focused one (frame-independent), for the ground grid */
  groundAbs: Infinity,
  /** bumped whenever the instance data changed (hover re-pick key) */
  rev: 0,
};
let boxInstBuf: WebGLBuffer;

export function initInstances(): void { boxInstBuf = G.gl.createBuffer()!; }

/** the brick list itself changed (load / scene undo / add / remove) */
export const instAll = (): void => { inst.all = true; };
/** brick k changed in place */
export const markBrick = (k: number): void => { inst.dirty.add(k); };

/** brick b's record at o in out, with faces l / h shifted by sh (into the upload frame) */
export function writeRecord(out: Float32Array, o: number, b: Brick, l: readonly number[], h: readonly number[], sh: readonly number[]): void {
  const l0 = l[0] + sh[0], l1 = l[1] + sh[1], l2 = l[2] + sh[2], h0 = h[0] + sh[0], h1 = h[1] + sh[1], h2 = h[2] + sh[2];
  out[o] = (l0 + h0) / 2; out[o + 1] = (l2 + h2) / 2; out[o + 2] = (l1 + h1) / 2;
  out[o + 3] = h0 - l0; out[o + 4] = h2 - l2; out[o + 5] = h1 - l1;
  out[o + 6] = b.color[0]; out[o + 7] = b.color[1]; out[o + 8] = b.color[2];
  const f = brickFlags(b); out[o + 9] = f[0]; out[o + 10] = f[1]; out[o + 11] = f[2]; out[o + 12] = f[3];
}
const instShift = (): number[] => [0, 1, 2].map((i) => S.histOrigin[i] - inst.base[i]);

/** box slot k from bricks[k] (zeroed if shaped / focused) */
function writeSlot(k: number, sh: readonly number[]): void {
  const b = S.bricks[k], o = k * INST_F, special = matCode(b) > 0, shaped = !!b.shape && !special;
  if (shaped || special || k === S.sel) inst.data.fill(0, o, o + INST_F); else writeRecord(inst.data, o, b, b.lo, b.hi, sh);
  if (shaped || inst.isShaped[k]) inst.groupsDirty = true;
  if (special || inst.isSpecial[k]) inst.specialDirty = true;
  inst.isShaped[k] = shaped ? 1 : 0; inst.isSpecial[k] = special ? 1 : 0;
}

function rebuildGroups(sh: readonly number[]): void {
  const gl = G.gl;
  for (const g of inst.groups) gl.deleteBuffer(g.buf);
  const groups = new Map<WebGLBuffer, number[]>();           // mesh buffer -> brick indices
  for (let k = 0; k < S.bricks.length; k++) {
    const b = S.bricks[k];
    if (!b.shape || k === S.sel || inst.isSpecial[k]) continue;
    const mesh = shapeBuffer(b, [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]]);
    if (!groups.has(mesh)) groups.set(mesh, []);
    groups.get(mesh)!.push(k);
  }
  inst.groups = [...groups].map(([mesh, ks]) => {
    const data = new Float32Array(ks.length * INST_F);
    ks.forEach((k, j) => writeRecord(data, j * INST_F, S.bricks[k], S.bricks[k].lo, S.bricks[k].hi, sh));
    const buf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return { mesh, buf, data, n: ks.length };
  });
  inst.groupsDirty = false;
}

/** bring the buffers up to date with S.bricks (once a frame, before drawing) */
export function syncInstances(): void {
  const gl = G.gl, N = S.bricks.length;
  let changed = false;
  if (inst.all || N !== inst.n) {
    inst.base = S.histOrigin.slice() as V3; inst.n = N; inst.sel = S.sel; inst.all = false; inst.dirty.clear();
    inst.data = new Float32Array(N * INST_F); inst.isShaped = new Uint8Array(N); inst.isSpecial = new Uint8Array(N); inst.specialDirty = true;
    const sh = [0, 0, 0];
    for (let k = 0; k < N; k++) writeSlot(k, sh);
    gl.bindBuffer(gl.ARRAY_BUFFER, boxInstBuf);
    gl.bufferData(gl.ARRAY_BUFFER, inst.data, gl.DYNAMIC_DRAW);
    inst.groupsDirty = true; pickGrid.dirty = true; changed = true;
  } else {
    if (inst.sel !== S.sel) { inst.dirty.add(inst.sel); inst.dirty.add(S.sel); inst.sel = S.sel; }
    if (inst.dirty.size) {
      const sh = instShift();
      gl.bindBuffer(gl.ARRAY_BUFFER, boxInstBuf);
      for (const k of inst.dirty) {
        if (!(k >= 0 && k < N)) continue;
        writeSlot(k, sh);
        gl.bufferSubData(gl.ARRAY_BUFFER, k * INST_F * 4, inst.data.subarray(k * INST_F, (k + 1) * INST_F));
        pickUpdate(k);
      }
      inst.dirty.clear(); changed = true;
    }
  }
  if (inst.groupsDirty) rebuildGroups(instShift());
  if (inst.specialDirty) {
    inst.special = [];
    for (let k = 0; k < N; k++) if (inst.isSpecial[k] && k !== S.sel) inst.special.push(k);
    inst.specialDirty = false;
  }
  if (changed) {
    let m = Infinity;
    for (let k = 0; k < N; k++) if (k !== S.sel) m = Math.min(m, S.bricks[k].lo[2] + S.histOrigin[2]);
    inst.groundAbs = m; inst.rev++;
  }
}

/** per-instance arrays from buf (on) or back to constants */
function instAttribs(buf: WebGLBuffer | null, on: boolean): void {
  const gl = G.gl;
  if (on) gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  for (const [loc, n, off] of INST_ATTRS) {
    if (on) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, INST_F * 4, off); }
    else gl.disableVertexAttribArray(loc);
    gl.vertexAttribDivisor(loc, on ? 1 : 0);
  }
}

/**
 * Draw every brick (element array: the cube's triangles bound, body uniforms set). The boxes go in
 * index order with the focused brick (drawFocus, from constants) at its own place; the shape groups follow.
 */
export function drawInstances(drawFocus: () => void): void {
  const gl = G.gl, u = G.u, sh = instShift(), F = Math.min(S.sel, inst.n);
  const shifted = (on: boolean): void => gl.uniform3f(u.uShift, on ? sh[0] : 0, on ? sh[2] : 0, on ? sh[1] : 0);
  shifted(true);
  meshAttribs(boxVB, false);
  // a range of box slots: there's no base instance, so offset the instance pointers instead
  const boxes = (k0: number, k1: number): void => {
    if (k1 <= k0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, boxInstBuf);
    for (const [loc, n, off] of INST_ATTRS) {
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, INST_F * 4, k0 * INST_F * 4 + off);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, k1 - k0);
  };
  boxes(0, F);
  instAttribs(null, false); shifted(false); drawFocus(); shifted(true); meshAttribs(boxVB, false);
  boxes(F + 1, inst.n);
  for (const g of inst.groups) {
    meshAttribs(g.mesh, true); instAttribs(g.buf, true);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, shapeCount(g.mesh), g.n);
  }
  instAttribs(null, false);
  meshAttribs(boxVB, false);
  shifted(false);
}
