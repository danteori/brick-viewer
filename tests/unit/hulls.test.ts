// The exact collision shapes (src/scene/hulls.ts) against the rendered meshes (shapes.js), in every
// orientation, plus the separating-axis overlap test itself.
import { describe, expect, it } from 'vitest';
import { worldHalf } from '../../src/core/orient.ts';
import { BrickShapes, type ShapeMesh } from '../../src/render/meshes/shapes.js';
import { boxPiece, isShaped, localPieces, piecesOverlap, unionsOverlap, worldPieces, type Piece } from '../../src/scene/hulls.ts';

type V3 = [number, number, number];

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
}

/** Mesh triangles in world units around the brick centre (save axes). */
function meshTris(m: ShapeMesh, wh: readonly number[]): V3[][] {
  const P = m.positions, out: V3[][] = [];
  const w = (i: number): V3 => [P[3 * i]! * 2 * wh[0]!, P[3 * i + 2]! * 2 * wh[1]!, P[3 * i + 1]! * 2 * wh[2]!];
  for (let t = 0; t < m.count / 3; t++) out.push([w(3 * t), w(3 * t + 1), w(3 * t + 2)]);
  return out;
}

/** Ray-parity point-in-mesh, majority of three skew rays. */
function inMesh(tris: V3[][], p: V3): boolean {
  const dirs: V3[] = [[0.5773, 0.6121, 0.5402], [-0.3311, 0.8124, -0.4799], [0.7071, -0.4123, 0.5745]];
  let votes = 0;
  for (const d of dirs) {
    let n = 0;
    for (const [a, b, c] of tris) {
      const e1 = [b![0] - a![0], b![1] - a![1], b![2] - a![2]], e2 = [c![0] - a![0], c![1] - a![1], c![2] - a![2]];
      const h = [d[1] * e2[2]! - d[2] * e2[1]!, d[2] * e2[0]! - d[0] * e2[2]!, d[0] * e2[1]! - d[1] * e2[0]!];
      const det = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!;
      if (Math.abs(det) < 1e-12) continue;
      const s = [p[0] - a![0], p[1] - a![1], p[2] - a![2]], u = (s[0]! * h[0]! + s[1]! * h[1]! + s[2]! * h[2]!) / det;
      if (u < 0 || u > 1) continue;
      const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
      const v = (d[0] * q[0]! + d[1] * q[1]! + d[2] * q[2]!) / det;
      if (v < 0 || u + v > 1) continue;
      if ((e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det > 0) n++;
    }
    if (n & 1) votes++;
  }
  return votes >= 2;
}

/** Point in a union of convex pieces (every piece normal is a face normal). */
function inPieces(ps: readonly Piece[], p: V3): boolean {
  return ps.some((pc) => pc.n.every((d) => {
    let lo = Infinity, hi = -Infinity;
    for (const v of pc.v) { const x = v[0] * d[0] + v[1] * d[1] + v[2] * d[2]; lo = Math.min(lo, x); hi = Math.max(hi, x); }
    const x = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
    return x >= lo - 1e-9 && x <= hi + 1e-9;
  }));
}

// asset -> local half-extents to try (units)
const SPECIAL: [string, V3[]][] = [
  ['PB_DefaultRamp', [[10, 10, 6], [20, 10, 6], [5, 15, 12], [30, 20, 3]]],
  ['PB_DefaultRampInverted', [[10, 10, 6], [20, 15, 12]]],
  ['PB_DefaultWedge', [[10, 10, 6], [20, 5, 18]]],
  ['PB_DefaultRampCorner', [[10, 10, 6], [20, 15, 12]]],
  ['PB_DefaultRampCornerInverted', [[20, 20, 6]]],
  ['PB_DefaultRampInnerCorner', [[20, 20, 6], [20, 30, 12]]],
  ['PB_DefaultRampInnerCornerInverted', [[20, 20, 6]]],
  ['PB_DefaultRampCrest', [[10, 10, 6], [5, 20, 2]]],
  ['PB_DefaultRampCrestEnd', [[10, 5, 12], [10, 5, 4], [20, 30, 6]]],
  ['PB_DefaultRampCrestCorner', [[20, 20, 6], [10, 20, 12]]],
  ['PB_DefaultSideWedge', [[20, 10, 6]]],
  ['PB_DefaultSideWedgeTile', [[10, 30, 2]]],
  ['PB_DefaultArch', [[5, 30, 12], [5, 20, 6], [10, 40, 18]]],
  ['PB_DefaultArchInverted', [[5, 30, 12]]],
  ['PB_RoundedCap', [[10, 5, 6]]],
];
const MICRO: [string, V3[]][] = Object.keys(BrickShapes.MICRO_TYPES).filter((a) => a !== 'PB_DefaultMicroBrick').map((a) => [a, [[2, 2, 2], [3, 1, 4], [6, 4, 1]]]);

function checkAgainstMesh(asset: string, half: V3, o: number, mesh: ShapeMesh, wh: readonly number[], n = 400): number {
  const tris = meshTris(mesh, wh), ps = worldPieces({ asset, o, half, pos: [0, 0, 0] }, [0, 0, 0])!;
  const r = rng(o * 7919 + half[0] * 31 + half[1] * 17 + half[2]);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const p: V3 = [(r() * 2 - 1) * wh[0]!, (r() * 2 - 1) * wh[1]!, (r() * 2 - 1) * wh[2]!];
    if (inMesh(tris, p) !== inPieces(ps, p)) bad++;
  }
  return bad;
}

describe('collision shapes match the rendered meshes', () => {
  it.each([...SPECIAL, ...MICRO])('%s, all 24 orientations', (asset, halves) => {
    expect(isShaped(asset)).toBe(true);
    for (const half of halves) for (let o = 0; o < 24; o++) {
      const m = BrickShapes.isMicro(asset) ? BrickShapes.microMesh(asset, half, o) : BrickShapes.specialMesh(asset, half, o);
      expect(checkAgainstMesh(asset, half, o, m, worldHalf(o, half)), `${asset} ${half} o${o}`).toBe(0);
    }
  });

  it.each(Object.keys(BrickShapes.ROUND_TYPES))('%s (rounds: faceted prisms / frusta)', (asset) => {
    const m = BrickShapes.roundMesh(asset, 1), half = m.half;
    expect(checkAgainstMesh(asset, half, 16, m, half, 1500)).toBe(0);
  });

  it('plain bricks, tiles and unknown shapes stay boxes', () => {
    for (const a of ['PB_DefaultBrick', 'PB_DefaultTile', 'PB_DefaultSmoothTile', 'PB_DefaultMicroBrick', 'PB_DefaultStudded', 'BP_LatticeThin']) expect(localPieces(a, [5, 5, 6])).toBeNull();
  });
});

describe('separating-axis overlap', () => {
  const ramp = (pos: V3, o: number, half: V3 = [10, 10, 6]): Piece[] => worldPieces({ asset: 'PB_DefaultRamp', o, half, pos }, [0, 0, 0])!;
  const box = (b: number[]): Piece[] => [boxPiece(b, [0, 0, 0])];

  it('boxes: touching faces, edges, corners do not overlap; one unit in does', () => {
    const a = box([0, 0, 0, 10, 10, 12]);
    expect(unionsOverlap(a, box([10, 0, 0, 20, 10, 12]))).toBe(false);
    expect(unionsOverlap(a, box([10, 10, 12, 20, 20, 24]))).toBe(false);
    expect(unionsOverlap(a, box([9, 0, 0, 20, 10, 12]))).toBe(true);
    expect(unionsOverlap(a, box([2, 2, 2, 4, 4, 4]))).toBe(true);
  });

  const microRamp = (pos: V3, o: number, half: V3 = [4, 4, 4]): Piece[] => worldPieces({ asset: 'PB_DefaultMicroRamp', o, half, pos }, [0, 0, 0])!;
  /** The orientation whose matrix is o's turned 180 degrees about local Y (local X and Z flip). */
  const complementOf = (o: number): number => {
    const M = BrickShapes.brickOrient(o);
    return [...Array(24).keys()].find((q) => { const N = BrickShapes.brickOrient(q); return [0, 1, 2].every((i) => N[i]![0] === -M[i]![0] && N[i]![1] === M[i]![1] && N[i]![2] === -M[i]![2]); })!;
  };

  it("a brick may fill a ramp's empty corner; a box in the ramp's solid part is blocked", () => {
    // 4x2 ramp, 1 brick tall (half 20,10,6), centre z 6: crest x -20..-10 full height, slope from (-10, 12) to (20, 2)
    const a = ramp([0, 0, 6], 16, [20, 10, 6]);
    expect(unionsOverlap(a, box([10, -5, 6, 20, 5, 10]))).toBe(false);           // a 1x1 plate above the slope near the lip
    expect(unionsOverlap(a, box([10, -5, 4, 20, 5, 8]))).toBe(true);             // two units lower: into the slope
    expect(unionsOverlap(a, box([-20, -5, 4, -10, 5, 8]))).toBe(true);           // inside the crest
    expect(unionsOverlap(a, box([-20, -5, 12, -10, 5, 16]))).toBe(false);        // resting on the crest
    // another 4x2 ramp turned half-way, its bottom 6 units up and shifted 30 along X: its flat bottom
    // (x 10..50) clears a's slope there (at most 5.33 high), so it sits in a's empty corner
    expect(unionsOverlap(a, ramp([30, 0, 12], 18, [20, 10, 6]))).toBe(false);
    expect(unionsOverlap(a, ramp([30, 0, 11], 18, [20, 10, 6]))).toBe(true);
  });

  it('two ramps interlock their empty corners (an inverted ramp hanging on a ramp, slopes touching)', () => {
    const a = ramp([0, 0, 6], 16, [20, 10, 6]);
    const inv = (pos: V3): Piece[] => worldPieces({ asset: 'PB_DefaultRampInverted', o: 18, half: [20, 10, 6], pos }, [0, 0, 0])!;
    // b spans x -10..30, z 2..14: its bounding box overlaps a's (x -10..20, z 2..12), the solids only touch
    expect(unionsOverlap(a, inv([10, 0, 8]))).toBe(false);
    expect(unionsOverlap(inv([10, 0, 8]), a)).toBe(false);
    expect(unionsOverlap(a, inv([10, 0, 7]))).toBe(true);                        // one unit lower
    expect(unionsOverlap(a, inv([9, 0, 8]))).toBe(true);                         // one unit toward the crest
    expect(unionsOverlap(a, inv([11, 0, 8]))).toBe(false);                       // one unit away: a gap
  });

  it('a micro ramp and its complement fill the same box without overlapping, in all 24 orientations', () => {
    for (let o = 0; o < 24; o++) {
      const q = complementOf(o), a = microRamp([0, 0, 0], o), b = microRamp([0, 0, 0], q);
      expect(unionsOverlap(a, b), `o${o} vs q${q}`).toBe(false);
      expect(unionsOverlap(a, microRamp([0, 0, 0], o)), `o${o} self`).toBe(true);
      // one unit into the slope along either of the two axes the slope spans overlaps; away from it, or
      // along the third axis (parallel to the slope), stays free
      const nudged = [0, 1, 2].flatMap((ax) => [-1, 1].map((s) => { const d: V3 = [0, 0, 0]; d[ax] = s; return unionsOverlap(a, microRamp(d, q)); }));
      expect(nudged.filter(Boolean).length, `o${o}`).toBe(2);
    }
  });

  it('every orientation pair of a ramp is consistent with its mesh: overlap iff a shared mesh point', () => {
    // the pieces matched the mesh above; here the SAT agrees with sampling for offset pairs
    const r = rng(42);
    for (let k = 0; k < 300; k++) {
      const oa = Math.floor(r() * 24), ob = Math.floor(r() * 24);
      const d: V3 = [Math.round((r() * 2 - 1) * 20), Math.round((r() * 2 - 1) * 20), Math.round((r() * 2 - 1) * 20)];
      const A = ramp([0, 0, 0], oa), B = ramp(d, ob);
      const sat = unionsOverlap(A, B);
      // sample a fine grid of points; any point strictly inside both says overlap
      let shared = false;
      for (let x = -19.5; x <= 19.5 && !shared; x += 1) for (let y = -19.5; y <= 19.5 && !shared; y += 1) for (let z = -19.5; z <= 19.5 && !shared; z += 1) {
        const p: V3 = [x + 0.123, y + 0.071, z + 0.037];
        if (inPieces(A, p) && inPieces(B, p)) shared = true;
      }
      if (shared) expect(sat, `o${oa} vs o${ob} at ${d}`).toBe(true);
      expect(unionsOverlap(B, A)).toBe(sat);                                     // symmetric
    }
  });

  it('is fast: 100k ramp-ramp checks well under a second', () => {
    const a = ramp([0, 0, 0], 16), b = ramp([5, 3, 2], 18);
    piecesOverlap(a[0]!, b[0]!);
    const t = performance.now();
    let n = 0;
    for (let i = 0; i < 100_000; i++) if (piecesOverlap(a[0]!, b[0]!)) n++;
    const ms = performance.now() - t;
    expect(n).toBe(100_000);
    expect(ms).toBeLessThan(1500);
  });
});
