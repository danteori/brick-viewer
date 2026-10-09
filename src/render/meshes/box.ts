// The unit cube (-0.5..0.5), GL +Y is the brick's Z (up): 24 vertices (pos3 nrm3), 36 triangle
// indices and 48 edge-line indices. Face order: +X, -X, +Y(top), -Y(bottom), +Z(world +Y), -Z.

const FACES: [number[], number[][]][] = [
  [[1, 0, 0], [[.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5], [.5, -.5, .5]]],
  [[-1, 0, 0], [[-.5, -.5, .5], [-.5, .5, .5], [-.5, .5, -.5], [-.5, -.5, -.5]]],
  [[0, 1, 0], [[-.5, .5, -.5], [-.5, .5, .5], [.5, .5, .5], [.5, .5, -.5]]],
  [[0, -1, 0], [[-.5, -.5, .5], [-.5, -.5, -.5], [.5, -.5, -.5], [.5, -.5, .5]]],
  [[0, 0, 1], [[-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]]],
  [[0, 0, -1], [[.5, -.5, -.5], [-.5, -.5, -.5], [-.5, .5, -.5], [.5, .5, -.5]]],
];

export const BOX_VERTS: Float32Array = (() => {
  const data: number[] = [];
  FACES.forEach(([n, vs4]) => vs4.forEach((v) => data.push(...v, ...n)));
  return new Float32Array(data);
})();

export const BOX_TRIS: Uint16Array = (() => {
  const idx: number[] = [];
  FACES.forEach((_, f) => { const b = f * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3); });
  return new Uint16Array(idx);
})();

export const BOX_EDGES: Uint16Array = (() => {
  const e: number[] = [];
  FACES.forEach((_, f) => { const b = f * 4; e.push(b, b + 1, b + 1, b + 2, b + 2, b + 3, b + 3, b); });
  return new Uint16Array(e);
})();
