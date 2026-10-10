// U-09: curved surfaces get no bevel across their curve. faceRects leaves smooth triangles without a
// rectangle and marks the axis they run straight along; the arch's inner wall keeps a rectangle
// that runs on past its top edge (the arc's strip continues it, so no bevel line there).
import { describe, expect, it } from 'vitest';
import { BrickShapes } from '../../src/render/meshes/shapes.js';
import { faceRects } from '../../src/render/meshes/registry.ts';

const smoothTris = (m: { normals: Float32Array; count: number }): number[] => {
  const out: number[] = [], N = m.normals;
  for (let t = 0; t < m.count / 3; t++) {
    let s = false;
    for (let v = 3 * t + 1; v < 3 * t + 3; v++) for (let a = 0; a < 3; a++) if (Math.abs(N[3 * v + a] - N[9 * t + a]) > 1e-4) s = true;
    if (s) out.push(t);
  }
  return out;
};

describe('curved faces (U-09)', () => {
  it('a wide thin pole: no curved facet gets a bevel rectangle; all run straight along GL y (Z up)', () => {
    const m = faceRects(BrickShapes.microMesh('PB_DefaultPole', [4, 26, 10], 16));
    const ts = smoothTris(m);
    expect(ts.length).toBeGreaterThan(20);
    for (const t of ts) for (let v = 3 * t; v < 3 * t + 3; v++) {
      expect(m.caps[4 * v + 2]).toBe(0);              // no rectangle
      expect(m.caps[4 * v + 3]).toBe(-2);             // straight along GL axis 1 (y = Z up)
    }
  });

  it('an arch: the arc runs straight along X, and the inner wall rectangle reaches past the arc', () => {
    const m = faceRects(BrickShapes.specialMesh('PB_DefaultArch', [10, 20, 30], 16));
    const ts = smoothTris(m);
    expect(ts.length).toBeGreaterThan(10);
    for (const t of ts) expect(m.caps[12 * t + 3]).toBe(-1);   // GL x
    // inner walls: flat faces with a normal along GL z (Y) whose points sit inside the brick (|z| < 0.5)
    let walls = 0;
    const curved = new Set(ts);
    for (let t = 0; t < m.count / 3; t++) {
      const v = 3 * t;
      if (curved.has(t) || Math.abs(m.normals[3 * v + 2]) < 0.999 || Math.abs(m.positions[3 * v + 2]) > 0.49) continue;
      walls++;
      expect(m.caps[4 * v + 3]).toBeGreaterThan(0.5);           // rect top (GL y) beyond the brick top
    }
    expect(walls).toBeGreaterThan(0);
  });

  it('plain flat faces still get their own rectangle', () => {
    const m = faceRects(BrickShapes.microMesh('PB_DefaultMicroWedge', [5, 5, 5], 16));
    let rects = 0;
    for (let t = 0; t < m.count / 3; t++) if (m.caps[12 * t + 2] > m.caps[12 * t]) rects++;
    expect(rects).toBeGreaterThan(0);
  });
});
