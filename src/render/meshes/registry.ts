// Mesh buffers, all in the brick's LOCAL frame (orientation 16: upright, rot 0); the vertex shader
// turns them by each brick's orientation byte (shaders/brick.ts). One mesh serves every
// orientation of a shape: the cube for every box brick, a ramp / crest / crest end mesh per local
// size (their crest and lip don't scale), one per round asset, and the export-measured local
// shapes ('special' / 'micro') per asset and local size.
// Layouts: the cube 24 bytes (pos3 nrm3, indexed), ramps and crests 28 (+ slope flag), rounds and
// the local shapes 48 (+ part, cap4). Phase 3 makes the ramp family parametric (one mesh per shape).

import { BrickShapes, type ShapeMesh } from './shapes.js';
import { RAMP_VERTS, rampMesh } from './ramp.ts';
import { BOX_EDGES, BOX_TRIS, BOX_VERTS } from './box.ts';
import { LOC } from '../gl.ts';
import { BRZ_UNIT } from '../../core/units.ts';
import { Kind } from '../../scene/store.ts';
import { roundHalfOf } from '../../scene/view.ts';

let gl: WebGL2RenderingContext;
/** the cube: vertex buffer, triangle and edge index buffers */
export let boxVB: WebGLBuffer, boxIB: WebGLBuffer, boxEB: WebGLBuffer;
export const BOX_EDGE_COUNT = BOX_EDGES.length;

/** A mesh: its vertex buffer, vertex count and layout (0 cube, 1 pos+nrm+slope, 2 with part and cap). */
export interface Mesh { buf: WebGLBuffer; count: number; layout: 0 | 1 | 2; key: string }
export let BOX_MESH: Mesh;

const meshes = new Map<string, Mesh>();

export function initMeshes(g: WebGL2RenderingContext): void {
  gl = g;
  meshes.clear();
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
  BOX_MESH = { buf: boxVB, count: 36, layout: 0, key: 'box' };
}

function upload(key: string, data: Float32Array, count: number, layout: 1 | 2): Mesh {
  const buf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const m: Mesh = { buf, count, layout, key };
  meshes.set(key, m);
  return m;
}

function cachedShape(key: string, make: () => ShapeMesh, extras: boolean): Mesh {
  const m = meshes.get(key);
  if (m) return m;
  const mesh = make();
  return upload(key, BrickShapes.interleave(mesh, extras), mesh.count, extras ? 2 : 1);
}

/**
 * The local mesh of a brick of shape kind `kind`, save asset `asset` and local half-extents
 * (hx, hy, hz) in units. The cube for box bricks.
 */
export function meshOf(kind: Kind, asset: string, hx: number, hy: number, hz: number): Mesh {
  if (kind === Kind.Box) return BOX_MESH;
  const size: [number, number, number] = [2 * hx * BRZ_UNIT, 2 * hy * BRZ_UNIT, 2 * hz * BRZ_UNIT], k = `${hx},${hy},${hz}`;
  switch (kind) {
    case Kind.Ramp: {
      const key = 'ramp|' + k;
      return meshes.get(key) ?? upload(key, rampMesh(size, 0, 1, 1), RAMP_VERTS, 1);
    }
    case Kind.Crest: return cachedShape('crest|' + k, () => BrickShapes.crestMesh(size, 0, 1), false);
    case Kind.CrestEnd: return cachedShape('end|' + k, () => BrickShapes.crestEndMesh(size, 0, -1, 1), false);
    case Kind.Round: return cachedShape('round|' + asset, () => BrickShapes.roundMesh(asset, 1), true);
    case Kind.Micro: return cachedShape(`micro|${asset}|${k}`, () => faceRects(BrickShapes.microMesh(asset, [hx, hy, hz], 16)), true);
    default: return cachedShape(`special|${asset}|${k}`, () => faceRects(BrickShapes.specialMesh(asset, [hx, hy, hz], 16)), true);
  }
}

/**
 * Each flat, axis-aligned face of a shape mesh gets its rectangle in the face plane as its cap
 * attribute (u0, v0, u1, v1) in unit-box coords, u / v the face's two other GL axes in x, y, z
 * order (the shader's faceFrame). A face is a run of consecutive triangles with the same part and
 * plane. Slanted and curved faces keep zeros (the box bevel).
 */
export function faceRects(mesh: ShapeMesh): ShapeMesh {
  const P = mesh.positions, N = mesh.normals, K = mesh.parts, C = mesh.caps, T = mesh.count / 3;
  const axisOf = (t: number): number => {
    for (let a = 0; a < 3; a++) {
      let ok = true;
      for (let v = 3 * t; v < 3 * t + 3 && ok; v++) ok = Math.abs(N[3 * v + a]!) > 0.999;
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
    const key = `${a}|${K[v]}|${Math.sign(N[3 * v + a]!)}|${Math.round(P[3 * v + a]! * 1e5)}`, last = polys[polys.length - 1];
    let g: Poly;
    if (last && last.key === key && last.t1 === t) g = last;
    else { g = { key, a, t0: t, t1: t, r: [Infinity, Infinity, -Infinity, -Infinity] }; polys.push(g); }
    const [u, w] = [[1, 2], [0, 2], [0, 1]][a]!;
    for (let k = v; k < v + 3; k++) {
      g.r[0] = Math.min(g.r[0]!, P[3 * k + u!]!); g.r[1] = Math.min(g.r[1]!, P[3 * k + w!]!);
      g.r[2] = Math.max(g.r[2]!, P[3 * k + u!]!); g.r[3] = Math.max(g.r[3]!, P[3 * k + w!]!);
    }
    g.t1 = t + 1;
  }
  // 2. one face = the polygons on a plane whose rectangles touch
  const E = 1e-5, touch = (p: number[], q: number[]): boolean => p[0]! <= q[2]! + E && q[0]! <= p[2]! + E && p[1]! <= q[3]! + E && q[1]! <= p[3]! + E;
  const byKey = new Map<string, Poly[]>();
  for (const g of polys) {
    if (!byKey.has(g.key)) byKey.set(g.key, []);
    byKey.get(g.key)!.push(g);
  }
  for (const list of byKey.values()) {
    const par = list.map((_, i) => i);
    const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i]!)));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (touch(list[i]!.r, list[j]!.r)) par[find(i)] = find(j);
    const rects = new Map<number, number[]>();
    list.forEach((g, i) => {
      const k = find(i), r = rects.get(k) || [Infinity, Infinity, -Infinity, -Infinity];
      rects.set(k, [Math.min(r[0]!, g.r[0]!), Math.min(r[1]!, g.r[1]!), Math.max(r[2]!, g.r[2]!), Math.max(r[3]!, g.r[3]!)]);
    });
    list.forEach((g, i) => { const r = rects.get(find(i))!; for (let v = 3 * g.t0; v < 3 * g.t1; v++) C.set(r, 4 * v); });
  }
  return mesh;
}

/** Round / cone half-extents in Brickadia units (B_* bricks have no size in the save), from the generator. */
export const roundHalf = roundHalfOf;
