// Exact collision shapes for non-box bricks (backlog U-11: "bricks may fill a ramp's empty corner").
//
// Each shaped asset is described here as a union of CONVEX pieces in the brick's local frame
// (Brickadia units around its centre, local +Z = the stud side, as the shape generators in
// render/meshes/shapes.js), a parallel description of the same geometry:
//   - the ramp family (ramps, wedges, corners, crests, crest ends, side wedges) and the micro wedges:
//     the bounding box cut by one to three slope planes; concave ones as a union (inner corners: two
//     ramps; the crest corner: three pieces);
//   - arches: two legs plus one trapezoid prism per arc facet; the rounded cap: its profile prism;
//   - rounds, cones, poles and the micro half / quarter rounds: their faceted prisms and frusta, with
//     the generators' facet counts;
//   - everything else (plain bricks, tiles, plates, lattices, fences, spikes, ...) stays its box.
// tests/unit/hulls.test.ts checks every description against the rendered mesh, in all 24 orientations.
//
// Two bricks collide when their solids share positive volume; touching is fine. Pairs of convex
// pieces are tested with the separating-axis theorem (face normals of both, cross products of their
// edge directions): a pair whose projections only meet (or are apart) on some axis is not overlapping.

import { BrickShapes } from '../render/meshes/shapes.js';

type V3 = [number, number, number];

/** A convex piece: its vertices, face normals and edge directions (any length). */
export interface Piece { v: V3[]; n: V3[]; e: V3[] }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crs = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/** Adds a direction unless a parallel one is there already. */
function addDir(list: V3[], d: V3): void {
  const l = len(d);
  if (l < 1e-12) return;
  const u: V3 = [d[0] / l, d[1] / l, d[2] / l];
  for (const w of list) if (len(crs(w, u)) < 1e-9) return;
  list.push(u);
}

/** A plane n . p <= d (the solid side). */
type Plane = [nx: number, ny: number, nz: number, d: number];

/**
 * The convex piece {box [lo, hi]} cut by planes: vertices by intersecting plane triples, faces and
 * edges from the planes they lie on.
 */
export function cutBox(lo: V3, hi: V3, cuts: readonly Plane[] = []): Piece {
  const P: Plane[] = [[1, 0, 0, hi[0]], [-1, 0, 0, -lo[0]], [0, 1, 0, hi[1]], [0, -1, 0, -lo[1]], [0, 0, 1, hi[2]], [0, 0, -1, -lo[2]], ...cuts];
  const scale = 1 + Math.max(...lo.map(Math.abs), ...hi.map(Math.abs)), eps = 1e-9 * scale;
  const inside = (p: V3): boolean => P.every(([a, b, c, d]) => a * p[0] + b * p[1] + c * p[2] <= d + eps * Math.hypot(a, b, c));
  const v: V3[] = [], on: number[][] = [];
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) for (let k = j + 1; k < P.length; k++) {
    const a = P[i]!, b = P[j]!, c = P[k]!;
    const na: V3 = [a[0], a[1], a[2]], nb: V3 = [b[0], b[1], b[2]], nc: V3 = [c[0], c[1], c[2]];
    const bc = crs(nb, nc), det = dot(na, bc);
    if (Math.abs(det) < 1e-12) continue;
    const ca = crs(nc, na), ab = crs(na, nb);
    const p: V3 = [0, 1, 2].map((t) => (a[3] * bc[t]! + b[3] * ca[t]! + c[3] * ab[t]!) / det) as V3;
    if (!inside(p) || v.some((q) => len(sub(p, q)) < eps)) continue;
    v.push(p);
  }
  for (const p of v) on.push(P.map(([a, b, c, d], i) => (Math.abs(a * p[0] + b * p[1] + c * p[2] - d) <= eps * Math.hypot(a, b, c) ? i : -1)).filter((i) => i >= 0));
  const n: V3[] = [], e: V3[] = [];
  P.forEach((pl, i) => { if (on.filter((s) => s.includes(i)).length >= 3) addDir(n, [pl[0], pl[1], pl[2]]); });
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    if (on.filter((s) => s.includes(i) && s.includes(j)).length >= 2) addDir(e, crs([P[i]![0], P[i]![1], P[i]![2]], [P[j]![0], P[j]![1], P[j]![2]]));
  }
  return { v, n, e };
}

/** A polygon's normal (Newell's method: fine with collinear runs of points). */
function newell(r: readonly V3[]): V3 {
  const out: V3 = [0, 0, 0];
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!, q = r[(i + 1) % r.length]!;
    out[0] += (p[1] - q[1]) * (p[2] + q[2]); out[1] += (p[2] - q[2]) * (p[0] + q[0]); out[2] += (p[0] - q[0]) * (p[1] + q[1]);
  }
  return out;
}

/** The convex hull of two matching rings (a prism or frustum): ring vertex i of a joins vertex i of b. */
export function ringPiece(a: V3[], b: V3[]): Piece {
  const v = [...a, ...b], n: V3[] = [], e: V3[] = [], N = a.length;
  addDir(n, newell(a)); addDir(n, newell(b));
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    addDir(e, sub(a[j]!, a[i]!)); addDir(e, sub(b[j]!, b[i]!)); addDir(e, sub(b[i]!, a[i]!));
    const side = crs(sub(a[j]!, a[i]!), sub(b[i]!, a[i]!));
    addDir(n, len(side) > 1e-12 ? side : crs(sub(b[j]!, b[i]!), sub(b[i]!, a[i]!)));
  }
  return { v, n, e };
}

/** A prism along local axis `ax` (0 X, 1 Y, 2 Z) over [t0, t1], profile points (u, w) in the other two axes in order. */
function prism(ax: number, t0: number, t1: number, prof: readonly (readonly [number, number])[]): Piece {
  const at = (t: number, [u, w]: readonly [number, number]): V3 => (ax === 0 ? [t, u, w] : ax === 1 ? [u, t, w] : [u, w, t]) as V3;
  return ringPiece(prof.map((q) => at(t0, q)), prof.map((q) => at(t1, q)));
}

/** The plane through two points of the X-Z profile (constant over Y), solid on the side of `inside`. */
function planeXZ(x0: number, z0: number, x1: number, z1: number, inside: readonly [number, number]): Plane {
  let nx = z1 - z0, nz = -(x1 - x0), d = nx * x0 + nz * z0;
  if (nx * inside[0] + nz * inside[1] > d) { nx = -nx; nz = -nz; d = -d; }
  return [nx, 0, nz, d];
}
/** The same in the Y-Z profile (constant over X). */
function planeYZ(y0: number, z0: number, y1: number, z1: number, inside: readonly [number, number]): Plane {
  const [a, , c, d] = planeXZ(y0, z0, y1, z1, inside);
  return [0, a, c, d];
}
/** A plane through three points, solid on the side of `inside`. */
function plane3(p: V3, q: V3, r: V3, inside: V3): Plane {
  let n = crs(sub(q, p), sub(r, p)), d = dot(n, p);
  if (dot(n, inside) > d) { n = [-n[0], -n[1], -n[2]]; d = -d; }
  return [n[0], n[1], n[2], d];
}

const mapPiece = (pc: Piece, f: (p: V3) => V3): Piece => ({ v: pc.v.map(f), n: pc.n.map(f), e: pc.e.map(f) });
const flipZ = (pc: Piece): Piece => mapPiece(pc, ([x, y, z]) => [x, y, -z]);
const swapXY = (pc: Piece): Piece => mapPiece(pc, ([x, y, z]) => [y, x, z]);

const { RAMP_CREST, RAMP_LIP, ARCH_LEG, ARCH_CROWN, CAP_SEGMENTS, ROUND_TYPES, ROUND_SEGMENTS, ROUND_STUD_DIAMETER } = BrickShapes as unknown as {
  RAMP_CREST: number; RAMP_LIP: number; ARCH_LEG: number; ARCH_CROWN: number; CAP_SEGMENTS: number; ROUND_SEGMENTS: number; ROUND_STUD_DIAMETER: number;
  ROUND_TYPES: Record<string, { n: number; h: number; cone: boolean; stud?: number; top?: number; base?: number }>;
};
const microRoundSegments = (BrickShapes as unknown as { microRoundSegments(R: number): number }).microRoundSegments;
const CAP_ARC = 1.25;                                 // shapes.js PB_RoundedCap: vertical semi-axis / half height
const archSegments = (r: number): number => Math.round(14 + 0.4 * r);   // shapes.js archSegments

type Gen = (h: V3) => Piece[];

// --- the ramp family (shapes.js rampFaces & co.)
function ramp(h: V3, wedge: boolean): Piece[] {
  const [hx, hy, hz] = h, c = wedge ? 0 : Math.min(RAMP_CREST, 2 * hx), m = Math.min(RAMP_LIP, 2 * hz);
  return [cutBox([-hx, -hy, -hz], [hx, hy, hz], [planeXZ(-hx + c, hz, hx, -hz + m, [-hx, -hz])])];
}
const slopes = (h: V3): { zl: number; xc: number; yc: number; px: Plane; py: Plane } => {
  const [hx, hy, hz] = h, zl = -hz + Math.min(RAMP_LIP, 2 * hz);
  const xc = -hx + Math.min(RAMP_CREST, 2 * hx), yc = -hy + Math.min(RAMP_CREST, 2 * hy);
  return { zl, xc, yc, px: planeXZ(xc, hz, hx, zl, [-hx, -hz]), py: planeYZ(yc, hz, hy, zl, [-hy, -hz]) };
};
function rampCorner(h: V3): Piece[] {
  const [hx, hy, hz] = h, s = slopes(h);
  return [cutBox([-hx, -hy, -hz], [hx, hy, hz], [s.px, s.py])];
}
function rampInnerCorner(h: V3): Piece[] {
  const [hx, hy, hz] = h, s = slopes(h);
  return [cutBox([-hx, -hy, -hz], [hx, hy, hz], [s.px]), cutBox([-hx, -hy, -hz], [hx, hy, hz], [s.py])];
}
function crest(h: V3): Piece[] {
  const [hx, hy, hz] = h, zl = -hz + Math.min(RAMP_LIP, 2 * hz);
  return [cutBox([-hx, -hy, -hz], [hx, hy, hz], [planeXZ(-hx, zl, 0, hz, [0, -hz]), planeXZ(hx, zl, 0, hz, [0, -hz])])];
}
function crestEnd(h: V3): Piece[] {
  const [hx, hy, hz] = h, zl = -hz + Math.min(RAMP_LIP, 2 * hz), ER = Math.min(hx, 2 * hy), ya = -hy + ER;   // CREST_END_PITCH 'match'
  return [cutBox([-hx, -hy, -hz], [hx, hy, hz], [planeXZ(-hx, zl, 0, hz, [0, -hz]), planeXZ(hx, zl, 0, hz, [0, -hz]), planeYZ(-hy, zl, ya, hz, [hy, -hz])])];
}
function crestCorner(h: V3): Piece[] {
  const [hx, hy, hz] = h, zl = -hz + Math.min(RAMP_LIP, 2 * hz);
  const s1 = planeXZ(-hx, zl, 0, hz, [0, -hz]), s2 = planeXZ(0, hz, hx, zl, [0, -hz]);
  const s3 = planeYZ(0, hz, hy, zl, [0, -hz]), s4 = planeYZ(-hy, zl, 0, hz, [0, -hz]);
  // surface: s1 on (-X,-Y), s3 on (+X,+Y), min(s1, s3) on (-X,+Y) (a hip), max(s2, s4) on (+X,-Y) (a valley)
  return [
    cutBox([-hx, -hy, -hz], [0, hy, hz], [s1, s3]),                   // the -X half
    cutBox([0, -hy, -hz], [hx, 0, hz], [s2]),                         // the valley's +X side
    cutBox([0, -hy, -hz], [hx, hy, hz], [s3, s4]),                    // the valley's other side and the (+X,+Y) quarter
  ];
}
function sideWedge(h: V3): Piece[] {
  const [hx, hy, hz] = h;
  return [cutBox([-hx, -hy, -hz], [hx, hy, hz], [[hy, hx, 0, 0]])];
}
function arch(h: V3): Piece[] {
  const [hx, hy, hz] = h, r = Math.max(0, hy - ARCH_LEG), b = Math.max(0, Math.min(r, 2 * hz - ARCH_CROWN));
  const zc = hz - ARCH_CROWN - b, n = archSegments(r), out: Piece[] = [];
  out.push(cutBox([-hx, -hy, -hz], [hx, -r, hz]), cutBox([-hx, r, -hz], [hx, hy, hz]));
  if (r <= 0) return out.filter((p) => p.v.length);
  for (let i = 0; i < n; i++) {
    const t0 = Math.PI * (1 - i / n), t1 = Math.PI * (1 - (i + 1) / n);
    const ya = r * Math.cos(t0), za = zc + b * Math.sin(t0), yb = r * Math.cos(t1), zb = zc + b * Math.sin(t1);
    out.push(prism(0, -hx, hx, [[ya, za], [yb, zb], [yb, hz], [ya, hz]]));
  }
  return out;
}
function roundedCap(h: V3): Piece[] {
  const [hx, hy, hz] = h, b = Math.min(CAP_ARC * hz, 2 * hz), zc = hz - b;
  const prof: [number, number][] = [[hy, -hz]];
  for (let i = 0; i <= CAP_SEGMENTS; i++) { const t = Math.PI * i / CAP_SEGMENTS; prof.push([hy * Math.cos(t), zc + b * Math.sin(t)]); }
  prof.push([-hy, -hz]);
  return [prism(0, -hx, hx, prof.filter((q, i, a) => i === 0 || Math.hypot(q[0] - a[i - 1]![0], q[1] - a[i - 1]![1]) > 1e-9))];
}

// --- the micro family (shapes.js MICRO_SHAPES / MICRO_ARCS), normalised -1..1 then scaled
function micro(shape: string): Gen | null {
  const B = (h: V3, cuts: Plane[]): Piece => {
    const [hx, hy, hz] = h;
    // planes given in normalised coords: n . (p / h) <= d  ->  (n / h) . p <= d
    return cutBox([-hx, -hy, -hz], [hx, hy, hz], cuts.map(([a, b, c, d]) => [a / hx, b / hy, c / hz, d]));
  };
  const P = (x: number, y: number, z: number): V3 => [x, y, z];
  const C: V3 = [-0.2, -0.2, -0.6];                                   // a point inside every shape below
  const pl = (p: V3, q: V3, r: V3, inside: V3 = C): Plane => plane3(p, q, r, inside);
  const hyp: Plane = [1, 1, 0, 0];                                      // the footprint triangle's hypotenuse
  switch (shape) {
    case 'wedge': return (h) => [B(h, [hyp])];
    case 'ramp': return (h) => [B(h, [[1, 0, 1, 0]])];
    case 'corner': return (h) => [B(h, [[1, 0, 1, 0], [0, 1, 1, 0]])];
    case 'innerCorner': return (h) => [B(h, [[1, 0, 1, 0]]), B(h, [[0, 1, 1, 0]])];
    case 'outerCorner': return (h) => [B(h, [pl(P(1, -1, 1), P(-1, 1, 1), P(1, 1, -1))])];
    case 'triangleCorner': return (h) => [B(h, [hyp, pl(P(1, -1, -1), P(-1, 1, -1), P(-1, -1, 1), P(-0.9, -0.9, -0.9))])];
    case 'halfInnerCorner': return (h) => [B(h, [hyp, pl(P(-1, -1, -1), P(1, -1, -1), P(-1, 1, 1), P(-0.9, 0.5, -0.9))])];
    case 'halfInnerCornerInverted': return (h) => [swapXY(B([h[1], h[0], h[2]], [hyp, pl(P(-1, -1, -1), P(1, -1, -1), P(-1, 1, 1), P(-0.9, 0.5, -0.9))]))];
    case 'halfOuterCorner': return (h) => [B(h, [hyp, pl(P(-1, -1, -1), P(1, -1, 1), P(-1, 1, 1), P(0, 0, 0.9))])];
    case 'roundHalf': case 'roundCorner': case 'pole': return (h) => [microArc(shape, h)];
    default: return null;                                             // 'box' and unknown
  }
}
function microArc(shape: 'roundHalf' | 'roundCorner' | 'pole', h: V3): Piece {
  // shapes.js MICRO_ARCS: centre (cx, cy), semi-axes (a, b), from angle t0 over `frac` of a turn
  const [cx, cy, a, b, t0, frac] = shape === 'roundHalf' ? [-1, 0, 2, 1, -Math.PI / 2, 0.5] : shape === 'roundCorner' ? [-1, -1, 2, 2, 0, 0.25] : [0, 0, 1, 1, 0, 1];
  const R = Math.max(a * h[0], b * h[1]), seg = Math.max(2, Math.round(microRoundSegments(R) * frac));
  const pts: [number, number][] = [];
  for (let i = 0; i < seg + (frac < 1 ? 1 : 0); i++) {
    const t = t0 + 2 * Math.PI * frac * i / seg;
    pts.push([(cx + a * Math.cos(t)) * h[0], (cy + b * Math.sin(t)) * h[1]]);
  }
  if (shape === 'roundCorner') pts.push([-h[0], -h[1]]);              // back to the corner (the half round closes on its flat face)
  return prism(2, -h[2], h[2], pts);
}

// --- B_* rounds and cones (shapes.js roundMesh): local Z up, centred, half (5n, 5n, h / 2)
function round(name: string): Piece[] {
  const T = ROUND_TYPES[name]!, N = T.n, H = T.h, seg = ROUND_SEGMENTS;
  const rb = 5 * N, rt = T.cone ? 5 * T.top! : rb, hasStud = (T.stud ?? 0) > 0;
  const rs = hasStud ? rb * ROUND_STUD_DIAMETER : rb, hs = hasStud ? Math.min(T.stud!, H * 0.75) : 0;
  const z0 = -H / 2, z1 = z0 + hs, z2 = H / 2, zb = Math.min(z2, z1 + (T.base ?? 0));
  const ring = (r: number, z: number): V3[] => Array.from({ length: seg }, (_, i) => { const a = 2 * Math.PI * i / seg; return [r * Math.cos(a), r * Math.sin(a), z] as V3; });
  const out: Piece[] = [];
  if (hasStud) out.push(ringPiece(ring(rs, z0), ring(rs, z1)));
  if (zb > z1) out.push(ringPiece(ring(rb, z1), ring(rb, zb)));
  if (z2 > zb) out.push(ringPiece(ring(rb, zb), ring(rt, z2)));
  return out;
}

const SHAPED: Record<string, Gen> = {
  PB_DefaultRamp: (h) => ramp(h, false),
  PB_DefaultRampInverted: (h) => ramp(h, false).map(flipZ),
  PB_DefaultWedge: (h) => ramp(h, true),
  PB_DefaultRampCorner: rampCorner,
  PB_DefaultRampCornerInverted: (h) => rampCorner(h).map(flipZ),
  PB_DefaultRampInnerCorner: rampInnerCorner,
  PB_DefaultRampInnerCornerInverted: (h) => rampInnerCorner(h).map(flipZ),
  PB_DefaultRampCrest: crest,
  PB_DefaultRampCrestEnd: crestEnd,
  PB_DefaultRampCrestCorner: crestCorner,
  PB_DefaultSideWedge: sideWedge,
  PB_DefaultSideWedgeTile: sideWedge,
  PB_DefaultArch: arch,
  PB_DefaultArchInverted: (h) => arch(h).map(flipZ),
  PB_RoundedCap: roundedCap,
};
for (const [asset, shape] of Object.entries(BrickShapes.MICRO_TYPES)) { const g = micro(shape); if (g) SHAPED[asset] = g; }

/** Does this asset collide by a shape other than its box? */
export const isShaped = (asset: string): boolean => asset in SHAPED || asset in ROUND_TYPES;

const localCache = new Map<string, Piece[] | null>();
/** The local convex pieces of an asset at local half-extents h (units), or null for a box. Cached. */
export function localPieces(asset: string, h: readonly number[]): Piece[] | null {
  const key = `${asset}|${h[0]},${h[1]},${h[2]}`;
  let p = localCache.get(key);
  if (p === undefined) {
    const g = SHAPED[asset];
    p = g ? g([h[0]!, h[1]!, h[2]!]).filter((q) => q.v.length >= 4) : asset in ROUND_TYPES ? round(asset) : null;
    if (localCache.size > 4096) localCache.clear();
    localCache.set(key, p);
  }
  return p;
}

/** A brick's solid: its save asset, orientation byte, local half-extents and centre (units). */
export interface Solid { asset: string; o: number; half: readonly number[]; pos: readonly number[] }

/** The world pieces of a solid, relative to `origin` (keeps the numbers small), or null for a box. */
export function worldPieces(s: Solid, origin: readonly number[]): Piece[] | null {
  const local = localPieces(s.asset, s.half);
  if (!local) return null;
  const M = BrickShapes.brickOrient(s.o), t: V3 = [s.pos[0]! - origin[0]!, s.pos[1]! - origin[1]!, s.pos[2]! - origin[2]!];
  const rot = (p: V3): V3 => [M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2], M[2][0] * p[0] + M[2][1] * p[1] + M[2][2] * p[2]];
  return local.map((pc) => ({ v: pc.v.map((p) => { const r = rot(p); return [r[0] + t[0], r[1] + t[1], r[2] + t[2]] as V3; }), n: pc.n.map(rot), e: pc.e.map(rot) }));
}

/** An axis-aligned box as a piece. */
export function boxPiece(b: ArrayLike<number>, origin: readonly number[]): Piece {
  const lo: V3 = [b[0]! - origin[0]!, b[1]! - origin[1]!, b[2]! - origin[2]!], hi: V3 = [b[3]! - origin[0]!, b[4]! - origin[1]!, b[5]! - origin[2]!];
  const v: V3[] = [];
  for (let i = 0; i < 8; i++) v.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
  const ax: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return { v, n: ax, e: ax };
}

/** Positive-volume overlap of two convex pieces (separating axes; touching is not overlap). */
export function piecesOverlap(a: Piece, b: Piece): boolean {
  let scale = 1;
  for (const p of a.v) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const test = (d: V3): boolean => {                                  // true: separated (or only touching) along d
    const l = len(d);
    if (l < 1e-9) return false;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of a.v) { const x = dot(p, d); if (x < a0) a0 = x; if (x > a1) a1 = x; }
    for (const p of b.v) { const x = dot(p, d); if (x < b0) b0 = x; if (x > b1) b1 = x; }
    const eps = 1e-7 * l * scale;
    return a1 <= b0 + eps || b1 <= a0 + eps;
  };
  for (const d of a.n) if (test(d)) return false;
  for (const d of b.n) if (test(d)) return false;
  for (const x of a.e) for (const y of b.e) if (test(crs(x, y))) return false;
  return true;
}

/** Do two piece unions share positive volume? */
export function unionsOverlap(a: readonly Piece[], b: readonly Piece[]): boolean {
  for (const p of a) for (const q of b) if (piecesOverlap(p, q)) return true;
  return false;
}
