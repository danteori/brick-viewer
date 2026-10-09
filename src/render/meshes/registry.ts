// Mesh buffers for every shaped brick: ramps (rampMesh, a mesh per size and direction), Ramp Crest /
// Crest End (BrickShapes, a mesh per size), rounds (fixed meshes per asset), and the export-measured
// local shapes ('special' / 'micro': BrickShapes.specialMesh / microMesh, all 24 orientations).
// Phase 1 keeps the legacy per-size caches; the ShapeRegistry of ARCHITECTURE.md 3.1 replaces them.

import { BrickShapes, type ShapeMesh, type V3 as SV3 } from './shapes.js';
import { RAMP_VERTS, rampMesh } from './ramp.ts';
import { BOX_EDGES, BOX_TRIS, BOX_VERTS } from './box.ts';
import { LOC } from '../gl.ts';
import { localHalf, type Brick, type V3 } from '../../scene/brick.ts';

let gl: WebGL2RenderingContext;
/** the cube: vertex buffer, triangle and edge index buffers */
export let boxVB: WebGLBuffer, boxIB: WebGLBuffer, boxEB: WebGLBuffer;
export const BOX_EDGE_COUNT = BOX_EDGES.length;

const shapeMeshes = new Map<string, WebGLBuffer>();
const shapeMeshInfo = new Map<WebGLBuffer, { count: number; extras: boolean }>();

export function initMeshes(g: WebGL2RenderingContext): void {
  gl = g;
  boxVB = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, boxVB);
  gl.bufferData(gl.ARRAY_BUFFER, BOX_VERTS, gl.STATIC_DRAW);
  boxIB = gl.createBuffer()!; gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, BOX_TRIS, gl.STATIC_DRAW);
  boxEB = gl.createBuffer()!; gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxEB);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, BOX_EDGES, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.bindBuffer(gl.ARRAY_BUFFER, boxVB);
  gl.enableVertexAttribArray(LOC.aPos); gl.vertexAttribPointer(LOC.aPos, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(LOC.aNrm); gl.vertexAttribPointer(LOC.aNrm, 3, gl.FLOAT, false, 24, 12);
  gl.vertexAttrib1f(LOC.aSlope, 0);               // boxes: the array stays disabled, so the flag reads 0
  gl.vertexAttrib1f(LOC.aPart, 0); gl.vertexAttrib4f(LOC.aCap, 0, 0, 0, 0);   // everything else: plain
}

function upload(key: string, data: Float32Array, count: number, extras: boolean): WebGLBuffer {
  const buf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  shapeMeshes.set(key, buf); shapeMeshInfo.set(buf, { count, extras });
  return buf;
}

function cachedShape(key: string, make: () => ShapeMesh, extras: boolean): WebGLBuffer {
  const buf = shapeMeshes.get(key);
  if (buf) return buf;
  const mesh = make();
  return upload(key, BrickShapes.interleave(mesh, extras), mesh.count, extras);
}

function rampBuffer(size: V3, run: number, lip: number, up: number): WebGLBuffer {
  const key = 'ramp|' + size.map((v) => v.toFixed(3)).join() + `|${run}|${lip}|${up}`;
  return shapeMeshes.get(key) ?? upload(key, rampMesh(size, run, lip, up), RAMP_VERTS, false);
}

export const shapeCount = (buf: WebGLBuffer): number => shapeMeshInfo.get(buf)?.count ?? RAMP_VERTS;
export const shapeExtras = (buf: WebGLBuffer): boolean => !!shapeMeshInfo.get(buf)?.extras;

/**
 * The mesh buffer for a shaped brick b (b.shape set) of world size [X,Y,Z]. The export-measured local
 * shapes take the orientation byte and the local half-extents, so any of the 24 orientations draws;
 * their faces get their rectangles (faceRects). Rounds use their upright mesh turned by b.o when sideways.
 */
export function shapeBuffer(b: Brick, size: V3): WebGLBuffer {
  const up = b.up || 1, k = size.map((v) => v.toFixed(3)).join();
  if (b.shape === 'special' || b.shape === 'micro') {
    const o = b.o!, s = localHalf(o, size);
    return cachedShape(`${b.shape}|${b.asset}|${s.join()}|${o}`,
      () => faceRects(b.shape === 'micro' ? BrickShapes.microMesh(b.asset!, s, o) : BrickShapes.specialMesh(b.asset!, s, o)), true);
  }
  if (b.shape === 'crest') return cachedShape(`crest|${k}|${b.run}|${up}`, () => BrickShapes.crestMesh(size, b.run, up), false);
  if (b.shape === 'crestEnd') return cachedShape(`end|${k}|${b.run}|${b.closed}|${up}`, () => BrickShapes.crestEndMesh(size, b.run, b.closed, up), false);
  if (b.shape === 'round' && !b.up && b.o != null) return cachedShape(`round|${b.round}|o${b.o}`, () => orientMesh(BrickShapes.roundMesh(b.round!, 1), b.o!), true);
  if (b.shape === 'round') return cachedShape(`round|${b.round}|${up}`, () => BrickShapes.roundMesh(b.round!, up), true);
  return rampBuffer(size, b.run!, b.lip!, up);
}

/**
 * Each flat, axis-aligned face of a shape mesh gets its rectangle in the face plane as its cap
 * attribute (u0, v0, u1, v1) in unit-box coords, u / v the face's two other GL axes in x, y, z
 * order (the shader's faceFrame). A face is a run of consecutive triangles with the same part and
 * plane. Slanted faces keep zeros (the box bevel); curved faces get their straight axis (see smooth).
 * Faces whose generator already set a rectangle (localMesh `rect`) keep it.
 */
export function faceRects(mesh: ShapeMesh): ShapeMesh {
  const P = mesh.positions, N = mesh.normals, K = mesh.parts, C = mesh.caps, T = mesh.count / 3;
  // A curved (smooth-normal) triangle: its normals differ. It gets no rectangle; instead the cap
  // marks the axis its surface runs straight along (the one no normal has a component on) as
  // (0, 0, 0, -(axis + 1)), and the shader bevels only across that axis's ends (U-09).
  const smooth = (t: number): boolean => {
    for (let v = 3 * t + 1; v < 3 * t + 3; v++) for (let a = 0; a < 3; a++) if (Math.abs(N[3 * v + a] - N[9 * t + a]) > 1e-4) return true;
    return false;
  };
  const straightAxis = (t: number): number => {
    for (let a = 0; a < 3; a++) {
      let ok = true;
      for (let v = 3 * t; v < 3 * t + 3 && ok; v++) ok = Math.abs(N[3 * v + a]) < 1e-4;
      if (ok) return a;
    }
    return -1;
  };
  const preset = (t: number): boolean => C[12 * t + 2] > C[12 * t];   // the generator gave a rectangle
  const axisOf = (t: number): number => {
    if (preset(t)) return -1;
    if (smooth(t)) {
      const s = straightAxis(t);
      if (s >= 0) for (let v = 3 * t; v < 3 * t + 3; v++) C.set([0, 0, 0, -(s + 1)], 4 * v);
      return -1;
    }
    for (let a = 0; a < 3; a++) {
      let ok = true;
      for (let v = 3 * t; v < 3 * t + 3 && ok; v++) ok = Math.abs(N[3 * v + a]) > 0.999;
      if (ok) return a;
    }
    return -1;
  };
  interface Poly { key: string; a: number; t0: number; t1: number; r: number[] }
  // 1. polygons: runs of consecutive triangles on one plane with one part, with their rectangles
  const polys: Poly[] = [];
  for (let t = 0; t < T; t++) {
    const a = axisOf(t), v = 3 * t;
    if (a < 0) continue;
    const key = `${a}|${K[v]}|${Math.sign(N[3 * v + a])}|${Math.round(P[3 * v + a] * 1e5)}`, last = polys[polys.length - 1];
    let g: Poly;
    if (last && last.key === key && last.t1 === t) g = last;
    else { g = { key, a, t0: t, t1: t, r: [Infinity, Infinity, -Infinity, -Infinity] }; polys.push(g); }
    const [u, w] = [[1, 2], [0, 2], [0, 1]][a];
    for (let k = v; k < v + 3; k++) {
      g.r[0] = Math.min(g.r[0], P[3 * k + u]); g.r[1] = Math.min(g.r[1], P[3 * k + w]);
      g.r[2] = Math.max(g.r[2], P[3 * k + u]); g.r[3] = Math.max(g.r[3], P[3 * k + w]);
    }
    g.t1 = t + 1;
  }
  // 2. one face = the polygons on a plane whose rectangles touch
  const E = 1e-5, touch = (p: number[], q: number[]): boolean => p[0] <= q[2] + E && q[0] <= p[2] + E && p[1] <= q[3] + E && q[1] <= p[3] + E;
  const byKey = new Map<string, Poly[]>();
  for (const g of polys) {
    if (!byKey.has(g.key)) byKey.set(g.key, []);
    byKey.get(g.key)!.push(g);
  }
  for (const list of byKey.values()) {
    const par = list.map((_, i) => i);
    const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (touch(list[i].r, list[j].r)) par[find(i)] = find(j);
    const rects = new Map<number, number[]>();
    list.forEach((g, i) => {
      const k = find(i), r = rects.get(k) || [Infinity, Infinity, -Infinity, -Infinity];
      rects.set(k, [Math.min(r[0], g.r[0]), Math.min(r[1], g.r[1]), Math.max(r[2], g.r[2]), Math.max(r[3], g.r[3])]);
    });
    list.forEach((g, i) => { const r = rects.get(find(i))!; for (let v = 3 * g.t0; v < 3 * g.t1; v++) C.set(r, 4 * v); });
  }
  return mesh;
}

/** An upright mesh (unit box of its world size m.size, local = world) turned by orientation byte o. */
function orientMesh(m: ShapeMesh & { size: SV3 }, o: number): ShapeMesh {
  const M = BrickShapes.brickOrient(o), S = m.size;
  const rot = (v: number[]): number[] => [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]);
  const size = [0, 1, 2].map((i) => Math.abs(M[i][0]) * S[0] + Math.abs(M[i][1]) * S[1] + Math.abs(M[i][2]) * S[2]);
  const P = new Float32Array(m.positions.length), N = new Float32Array(m.normals.length);
  for (let v = 0; v < m.count; v++) {
    const p = m.positions, n = m.normals, o3 = 3 * v;
    const w = rot([p[o3] * S[0], p[o3 + 2] * S[1], p[o3 + 1] * S[2]]), d = rot([n[o3], n[o3 + 2], n[o3 + 1]]);   // GL -> save axes, turned
    P[o3] = w[0] / size[0]; P[o3 + 1] = w[2] / size[2]; P[o3 + 2] = w[1] / size[1];
    N[o3] = d[0]; N[o3 + 1] = d[2]; N[o3 + 2] = d[1];
  }
  return Object.assign({}, m, { positions: P, normals: N, size: size as SV3 });
}

/** Round / cone half-extents in Brickadia units (B_* bricks have no size in the save), from the generator. */
const roundHalfs = new Map<string, SV3>();
export function roundHalf(name: string): SV3 {
  let h = roundHalfs.get(name);
  if (!h) { h = BrickShapes.roundMesh(name).half; roundHalfs.set(name, h); }
  return h;
}

