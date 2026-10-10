// Brick shapes: every procedural and fixed shape the viewer draws beyond plain boxes. A verbatim
// port of the legacy viewer's inlined shapes.js (legacy/save-viewer.html), as an ES module.
// Brickadia brick shapes the viewer doesn't draw yet: rounds / cones (fixed B_* meshes), Ramp Crest,
// Ramp Crest End and the micro family (PB_DefaultMicro* wedges / corners / rounds, PB_DefaultPole). Framework-agnostic: pure functions that return typed
// arrays, no WebGL calls, so the code can be pasted into save-viewer.html later.
//
// Procedural only (no game meshes or textures are embedded or extracted). The numbers below were
// MEASURED from the game's own player-facing glTF export (Bricks.ExportModel, CL15729) of our test
// save, used as a private reference (references/exports/EXPORT_ANALYSIS.md; check with
// tools/compare_export.py). Values the export can't show sit behind named constants and are listed
// in OPEN_QUESTIONS.
//
// --- Convention (same as rampBuffer in save-viewer.html) ---
// * Positions are in the UNIT BOX (-0.5..0.5 on every axis), GL axes: x = world X, y = world Z (up),
//   z = world Y. The viewer scales them with uScale = the brick's world size and moves them with
//   uCenter, so vL / uHalf / bevel maths work unchanged.
// * Normals are the REAL world normals (computed from the real proportions, not the unit box), because
//   the viewer's shader does not rescale normals.
// * Meshes are NON-INDEXED triangle lists, wound counter-clockwise seen from outside (the viewer
//   doesn't cull, but this keeps culling possible).
// * Viewer units: 1 stud = 0.2, 1 Brickadia unit = 0.02 (stud = 10 units, plate = 4, micro = 2).
//
// --- Mesh object returned by every generator ---
//   positions  Float32Array, 3 per vertex (unit box)
//   normals    Float32Array, 3 per vertex
//   flags      Float32Array, 1 per vertex: the viewer's aSlope flag (1 = sloped ramp-style face:
//              no studs / underside / bevel, gets the slope bump texture)
//   parts      Float32Array, 1 per vertex: PART code, tells the shader which detail to draw (below)
//   caps       Float32Array, 4 per vertex: (u, v, R, n) on round caps and the ledge ring, zeros elsewhere:
//                u, v = position on the cap from the round's axis, in stud-pattern cells
//                       (u along world X, v along world Y = GL z)
//                R    = the cap's clip radius, same units
//                n    = top cap: stud cells across the pattern (1 for 1x1 and both cones, 2 for 2x2, 4 for 4x4);
//                       bottom cap: footprint + 1, so the underside grid's corners (sockets) land on the
//                       CENTRE of every stud cell: 2 for 1x1 (1 socket), 3 for 2x2 (4), 5 for 4x4 (16)
//              Stud cell coordinate:   c = fract(vec2(u, v) + n*0.5) - 0.5     (-0.5..0.5, like the viewer)
//              Underside coordinate:   q = vec2(u, v) + n*0.5, brick size sz = vec2(n)  (0..n, like the viewer),
//                but the rim follows the circle: e = R - length(vec2(u, v)), rim width ROUND_UNDER_RIM.
//   count      vertex count
//   size       world size [X, Y, Z] in viewer units (rounds only; the caller gives it for procedural shapes)
//   half       half-extents [X, Y, Z] in Brickadia units (rounds only: B_* bricks have no size in the save)
// interleave(mesh) packs them for one ARRAY_BUFFER (stride 28: pos3 nrm3 flag1, rampBuffer's layout), or
// interleave(mesh, true) for stride 48: pos3 nrm3 flag1 part1 cap4.
export const BrickShapes = (function () {
'use strict';

// --- Units ---
const STUD = 0.2, UNIT = STUD / 10, MICRO = 2 * UNIT, PLATE = 4 * UNIT;

// --- Part codes (the per-vertex `parts` attribute) ---
const PART = {
  PLAIN: 0,        // a box-like face: the viewer's existing logic (studs on top, underside below, box bevel)
  ROUND_TOP: 1,    // round / cone top cap: stud pattern from `caps`, clipped by the cap's circle
  ROUND_BOTTOM: 2, // round bottom (stud cylinder's end + the ledge ring): underside pattern from `caps`
  ROUND_SIDE: 3,   // curved side (smooth normals): no studs, no underside
  SLOPE: 4,        // ramp-style sloped face (same faces as flags = 1)
  PLAIN_TOP: 5,    // a flat upward face that must NOT get studs (only the optional flat crest peak)
  ROUND_LEDGE: 6,  // the downward ring between the stud cylinder and the body: plain, radial bevel on its outer edge
  // Codes used by the export-measured generators (specialMesh / rampMesh, micro shapes). They name the
  // game's export material part of each face (EXPORT_ANALYSIS.md "Parts"):
  FACET: 7,        // Bevel material: flat or curved face with only the edge bevel (no studs, no underside, no bump)
  STUDS: 8,        // Stud material: the stud pattern in the face's own plane, any direction (Studded has 5 such faces)
  INLET: 9,        // InletBorder / InletCenter: the brick underside pattern, in the face's own plane
  RECESS: 10,      // InletCenter material used as a dark recess (spike-plate pits, aerodynamic arrows): no pattern
};

// --- Rounds (B_* fixed meshes; measured from the export, EXPORT_ANALYSIS.md "Rounds") ---
const ROUND_SEGMENTS = 32;          // facets around EVERY round and cone (1x1, 2x2 and 4x4 alike), smooth normals
const ROUND_SEGMENTS_2X2 = 32;      // kept for API compatibility: same as ROUND_SEGMENTS
const ROUND_SEGMENTS_4X4 = 32;
const ROUND_STUD_DIAMETER = 0.8;    // 1x1 types' bottom stud cylinder: radius 4 units on a 5-unit body (0.8 x footprint)
const ROUND_STUD_HEIGHT = MICRO;    // ... 2 units tall on B_1x1_Round / B_1x1_Cone; B_1x1F_Round uses 2.5 (ROUND_TYPES .stud)
// Cone top diameter is per type (ROUND_TYPES[..].top, in studs): 0.6 on the 1x1, 1.0 on the 2x2 (both exact
// in the export). The stud texture on the cone's top keeps the normal stud size, clipped by the circle
// (the export's stud UVs run 0.15..0.85 across the 1x1 cone's 0.6-stud top).
const CONE_TOP_STUD_SCALE = 1.0;
// Round bottoms (in-game shots of round bricks): a round rim wall following the stud cylinder's
// circle, then the recess with one socket square per stud cell (at the cell's centre) and skeleton
// lines through the sockets (the viewer's underside pattern shifted half a cell). Wall width in
// studs, ~36 px against a ~465 px (0.78 stud) cylinder on the 1x1.
const ROUND_UNDER_RIM = 0.06;
// n = footprint in studs, h = full height in Brickadia units, top = cone top diameter in studs,
// stud = bottom stud cylinder height in units (0 = none; radius ROUND_STUD_DIAMETER x body radius),
// base = height of a straight cylinder at the bottom of a cone body before it starts to narrow.
// Round tops show an n x n stud grid clipped by the circle; cone tops a single stud cell clipped by
// their small circle. Every value here is exact in the export (EXPORT_ANALYSIS.md "Rounds").
const ROUND_TYPES = {
  B_1x1F_Round: { n: 1, h: 4,  cone: false, stud: 2.5 },          // half (5,5,2): stud cylinder -2..0.5, body 0.5..2
  B_1x1_Round:  { n: 1, h: 12, cone: false, stud: 2 },            // half (5,5,6)
  B_1x1_Cone:   { n: 1, h: 12, cone: true, top: 0.6, stud: 2 },   // half (5,5,6)
  B_2x2F_Round: { n: 2, h: 4,  cone: false, stud: 0 },            // plain cylinder r 10
  B_2x2_Round:  { n: 2, h: 12, cone: false, stud: 0 },            // plain cylinder r 10
  B_2x2_Cone:   { n: 2, h: 24, cone: true, top: 1.0, stud: 0, base: 2 },   // half (10,10,12): r 10 cylinder 2 units, then frustum to r 5
  B_4x4_Round:  { n: 4, h: 12, cone: false, stud: 0 },            // plain cylinder r 20
};

// --- Ramp Crest / Crest End ---
const CREST_LIP = MICRO;            // A5: vertical lip at the crest's low edges: 1 micro, like the regular ramp
const CREST_PEAK_FLAT = 0;          // A6: width of a flat strip at the peak (viewer units); 0 = sharp ridge
// A7: Crest End's end face. 'match' = same pitch as the side slopes (a true hip roof: the ridge carries
// on when the brick is wider than half its run); 'width' = the end face always rises across the whole
// width to an apex at the open end. Identical for every size seen so far (width 1 stud, run 2 studs).
const CREST_END_PITCH = 'match';

// --- Micro family (PB_DefaultMicro*, PB_DefaultPole): read from in-game shots of a
// micro-brick test grid (private reference notes) ---
// Facets around a FULL circle for the pole, half round and quarter round depend on the size (export,
// EXPORT_ANALYSIS.md "Micro rounds"): n = min(36, 8 + 8*ceil(R/2)) with R the arc's larger semi-axis in
// micros (pole max(hx,hy); half round max(2hx,hy); quarter round max(2hx,2hy); half-extents in units =
// micros here). So 16 / 24 / 32 / 36; the half round uses n/2 of them, the quarter round n/4, evenly in the
// ellipse's parameter angle, smooth normals. MICRO_ROUND_SEGMENTS is only the fallback for an unknown size.
const MICRO_ROUND_SEGMENTS = 32;
const MICRO_ROUND_MAX = 36;
function microRoundSegments(R) { return Math.min(MICRO_ROUND_MAX, 8 + 8 * Math.ceil(R / 2)); }
// Micro slope faces use the plain Bevel material in the export (no Bumpy pebble texture), with the edge
// bevel on the axis-aligned edges of each face's UV box. They are PART.FACET with flags = 0.
const MICRO_SLOPE_TEXTURE = false;
// Local shape per asset. Every shape spans the full local box (-hx..hx, -hy..hy, -hz..hz).
const MICRO_TYPES = {
  PB_DefaultMicroBrick: 'box',
  PB_DefaultMicroWedge: 'wedge',
  PB_DefaultMicroRamp: 'ramp',
  PB_DefaultMicroWedgeCorner: 'corner',
  PB_DefaultMicroWedgeInnerCorner: 'innerCorner',
  PB_DefaultMicroWedgeOuterCorner: 'outerCorner',
  PB_DefaultMicroWedgeTriangleCorner: 'triangleCorner',
  PB_DefaultMicroWedgeHalfInnerCorner: 'halfInnerCorner',
  PB_DefaultMicroWedgeHalfInnerCornerInverted: 'halfInnerCornerInverted',
  PB_DefaultMicroWedgeHalfOuterCorner: 'halfOuterCorner',
  PB_DefaultMicroRoundHalf: 'roundHalf',
  PB_DefaultMicroRoundCorner: 'roundCorner',
  PB_DefaultPole: 'pole',
};

// Settled by the glTF export (CL15729): M1 (micro round facets: microRoundSegments), M2 (micro slopes
// are plain Bevel faces), M3 (no bevel geometry anywhere: the bevel is a normal map; diagonal edges
// get none), M4 (1-micro sizes are the same shapes scaled), A2/A4c/A4d (rounds: ROUND_TYPES), A5/A6
// (crest lip 2 units, sharp ridge), A8 (crest-end closed side = local -Y). What the export can't show:
const OPEN_QUESTIONS = [
  'A7: Crest End end face: every crest end exported has width = half its run, so "match" (hip pitch) and "width" give the same mesh. Needs a crest end wider than half its run.',
  'A9: crest / crest-end / 2x2-4x4 round bottoms were culled in the export (they sat on a floor); the ramp, wedge and corner bottoms use the normal underside (InletBorder/InletCenter), the 1x1 round bottoms a plain face.',
  'X1: Arch / ArchInverted heights lower than radius + 4 units (an arch flatter than a semicircle) were not in the export; archMesh squashes the arc to an ellipse then (guess).',
  'X2: Baguette is an organic loaf (562 triangles, scored every stud); baguetteMesh is a smooth stand-in, about 0.5 unit off.',
  'X3: SpikePlate / LatticeThin / Spike / PicketFence repeat per 10-unit stud cell; sizes that are not whole studs were not in the export.',
  'X4: the aerodynamic surfaces were only seen at (10,20,1) / (10,5,10); the arrow and taper are fixed-size in units here.',
];

// --- Builder: collects triangles in real (viewer-unit) coordinates around the box centre ---
function Builder(up) { this.up = up < 0 ? -1 : 1; this.p = []; this.n = []; this.f = []; this.k = []; this.c = []; }
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
const ZERO4 = [0, 0, 0, 0];
// one triangle; ns = one normal or three; cs = one cap tuple or three. Winding is fixed so the
// triangle faces along its (average) normal.
Builder.prototype.tri = function (a, b, c, ns, flag, part, cs) {
  const n3 = Array.isArray(ns[0]) ? ns : [ns, ns, ns];
  const c3 = cs ? (Array.isArray(cs[0]) ? cs : [cs, cs, cs]) : [ZERO4, ZERO4, ZERO4];
  const avg = [n3[0][0]+n3[1][0]+n3[2][0], n3[0][1]+n3[1][1]+n3[2][1], n3[0][2]+n3[1][2]+n3[2][2]];
  let order = [0, 1, 2];
  const fn = cross(sub(b, a), sub(c, a));
  if (Math.hypot(fn[0], fn[1], fn[2]) < 1e-12) return;   // degenerate
  if (dot(fn, avg) < 0) order = [0, 2, 1];
  if (this.up < 0) order = [order[0], order[2], order[1]];   // the vertical mirror flips the winding
  const v = [a, b, c];
  for (const i of order) {
    this.p.push(v[i][0], this.up*v[i][1], v[i][2]);
    this.n.push(n3[i][0], this.up*n3[i][1], n3[i][2]);
    this.f.push(flag); this.k.push(part); this.c.push(...c3[i]);
  }
};
// flat convex polygon (fan); the normal comes from the points, flipped to point away from `inside`
Builder.prototype.poly = function (pts, inside, flag, part) {
  let n = [0, 0, 0];
  for (let i = 1; i + 1 < pts.length; i++) { const t = cross(sub(pts[i], pts[0]), sub(pts[i+1], pts[0])); n = [n[0]+t[0], n[1]+t[1], n[2]+t[2]]; }
  n = norm(n);
  if (dot(n, sub(pts[0], inside)) < 0) n = [-n[0], -n[1], -n[2]];
  for (let i = 1; i + 1 < pts.length; i++) this.tri(pts[0], pts[i], pts[i+1], n, flag, part);
};
// real coords -> unit box, typed arrays
Builder.prototype.finish = function (size, extra) {
  const P = new Float32Array(this.p);
  for (let i = 0; i < P.length; i++) P[i] /= size[[0, 2, 1][i % 3]];   // GL x = X, y = Z, z = Y
  return Object.assign({
    positions: P, normals: new Float32Array(this.n), flags: new Float32Array(this.f),
    parts: new Float32Array(this.k), caps: new Float32Array(this.c), count: this.f.length,
  }, extra || {});
};

// --- Rounds ---
// name: one of ROUND_TYPES; up: +1 upright, -1 upside down. Returns the mesh plus `size` (world
// [X,Y,Z] in viewer units, for uScale) and `half` (Brickadia half-extents, for placing the brick).
// Bottom to top: on the 1x1 types a stud cylinder (ROUND_STUD_DIAMETER, T.stud units) and the downward
// ledge ring; the body (cylinder, or a frustum for cones, with an optional straight T.base first);
// the top cap.
function roundMesh(name, up = 1) {
  const T = ROUND_TYPES[name];
  if (!T) throw new Error('unknown round ' + name);
  const N = T.n, H = T.h * UNIT, seg = ROUND_SEGMENTS;
  const rb = 0.5 * N * STUD;                                  // body radius at the bottom
  const rt = T.cone ? 0.5 * T.top * STUD : rb;                // body radius at the top
  const hasStud = (T.stud || 0) > 0;
  const rs = hasStud ? rb * ROUND_STUD_DIAMETER : rb;         // bottom disc radius
  const hs = hasStud ? Math.min(T.stud * UNIT, H * 0.75) : 0;
  const y0 = -H / 2, y1 = y0 + hs, y2 = H / 2;
  const yb = Math.min(y2, y1 + (T.base || 0) * UNIT);         // top of the straight part of the body
  const B = new Builder(up);
  const ring = (r, y, a) => [r * Math.cos(a), y, r * Math.sin(a)];
  const capOf = (x, z, R, s, n = N) => [x / STUD / s, z / STUD / s, R / STUD / s, n];
  const un = N + 1;                                           // underside grid: sockets at every cell centre
  const tn = T.cone ? 1 : N;                                  // top: stud cells across
  const ts = T.cone ? CONE_TOP_STUD_SCALE : 1;                // stud pattern scale on the top
  const hb = y2 - yb, side = [hb, rb - rt];                   // frustum side normal (radial, up) before normalising
  const sl = Math.hypot(side[0], side[1]);
  const down = [0, -1, 0];
  for (let i = 0; i < seg; i++) {
    const a0 = 2 * Math.PI * i / seg, a1 = 2 * Math.PI * (i + 1) / seg;
    const r0 = [Math.cos(a0), 0, Math.sin(a0)], r1 = [Math.cos(a1), 0, Math.sin(a1)];
    // bottom disc: underside pattern from `caps`. The export gives it the plain Bevel material, but the
    // in-game shots of round bricks show a rim + sockets there, so the game's own
    // renderer wins; see EXPORT_ANALYSIS.md "Rounds".
    const p0 = ring(rs, y0, a0), p1 = ring(rs, y0, a1);
    B.tri([0, y0, 0], p0, p1, down, 0, PART.ROUND_BOTTOM, [capOf(0, 0, rs, 1, un), capOf(p0[0], p0[2], rs, 1, un), capOf(p1[0], p1[2], rs, 1, un)]);
    if (hasStud) {
      // stud cylinder side (smooth)
      B.tri(ring(rs, y0, a0), ring(rs, y0, a1), ring(rs, y1, a1), [r0, r1, r1], 0, PART.ROUND_SIDE);
      B.tri(ring(rs, y0, a0), ring(rs, y1, a1), ring(rs, y1, a0), [r0, r1, r0], 0, PART.ROUND_SIDE);
      // ledge ring facing down, between the stud cylinder and the body
      const l0 = ring(rs, y1, a0), l1 = ring(rs, y1, a1), o0 = ring(rb, y1, a0), o1 = ring(rb, y1, a1);
      const lc = p => capOf(p[0], p[2], rb, 1);
      B.tri(l0, o0, o1, down, 0, PART.ROUND_LEDGE, [lc(l0), lc(o0), lc(o1)]);
      B.tri(l0, o1, l1, down, 0, PART.ROUND_LEDGE, [lc(l0), lc(o1), lc(l1)]);
    }
    if (yb > y1) {                                            // straight part of the body
      B.tri(ring(rb, y1, a0), ring(rb, y1, a1), ring(rb, yb, a1), [r0, r1, r1], 0, PART.ROUND_SIDE);
      B.tri(ring(rb, y1, a0), ring(rb, yb, a1), ring(rb, yb, a0), [r0, r1, r0], 0, PART.ROUND_SIDE);
    }
    if (y2 > yb) {                                            // body side (smooth; tilted for the cone)
      const n0 = [r0[0]*side[0]/sl, side[1]/sl, r0[2]*side[0]/sl], n1 = [r1[0]*side[0]/sl, side[1]/sl, r1[2]*side[0]/sl];
      B.tri(ring(rb, yb, a0), ring(rb, yb, a1), ring(rt, y2, a1), [n0, n1, n1], 0, PART.ROUND_SIDE);
      B.tri(ring(rb, yb, a0), ring(rt, y2, a1), ring(rt, y2, a0), [n0, n1, n0], 0, PART.ROUND_SIDE);
    }
    // top cap (studs)
    const t0 = ring(rt, y2, a0), t1 = ring(rt, y2, a1);
    B.tri([0, y2, 0], t0, t1, [0, 1, 0], 0, PART.ROUND_TOP, [capOf(0, 0, rt, ts, tn), capOf(t0[0], t0[2], rt, ts, tn), capOf(t1[0], t1[2], rt, ts, tn)]);
  }
  const size = [N * STUD, N * STUD, H];
  return B.finish(size, { size, half: [5 * N, 5 * N, T.h / 2], name });
}

// --- Ramp Crest (PB_DefaultRampCrest) ---
// Two mirrored ramp wedges peaking in the middle of the run, no studded crest. Profile along the
// run (u from 0 to R, v up): lip 1 micro at both low edges, slopes up to the peak at R/2.
// size: world [X, Y, Z] lengths (viewer units); run: world axis of the run (0 = X, 1 = Y, i.e. the
// brick's local X; the shape is symmetric so its sign doesn't matter); up: +1 / -1.
function crestMesh(size, run = 0, up = 1) {
  const R = size[run], W = size[1 - run], H = size[2];
  const m = Math.min(CREST_LIP, H), f = Math.min(CREST_PEAK_FLAT / 2, R / 2);
  const P = (u, v, w) => {                                    // (run, up, width) -> centred GL coords
    const p = [0, v - H / 2, 0];
    p[run === 0 ? 0 : 2] = u - R / 2;
    p[run === 0 ? 2 : 0] = w - W / 2;
    return p;
  };
  const B = new Builder(up), inside = P(R / 2, m / 2, W / 2);
  const prof = [[0, 0], [R, 0], [R, m], [R / 2 + f, H], [R / 2 - f, H], [0, m]].filter((q, i, a) => i === 0 || q[0] !== a[i-1][0] || q[1] !== a[i-1][1]);
  for (const w of [0, W]) B.poly(prof.map(([u, v]) => P(u, v, w)), inside, 0, PART.PLAIN);    // the two ends
  B.poly([P(0, 0, 0), P(R, 0, 0), P(R, 0, W), P(0, 0, W)], inside, 0, PART.PLAIN);           // bottom
  if (m > 0) {
    B.poly([P(0, 0, 0), P(0, m, 0), P(0, m, W), P(0, 0, W)], inside, 0, PART.PLAIN);         // lips
    B.poly([P(R, 0, 0), P(R, m, 0), P(R, m, W), P(R, 0, W)], inside, 0, PART.PLAIN);
  }
  if (H > m) {
    B.poly([P(0, m, 0), P(R / 2 - f, H, 0), P(R / 2 - f, H, W), P(0, m, W)], inside, 1, PART.SLOPE);   // slopes
    B.poly([P(R, m, 0), P(R / 2 + f, H, 0), P(R / 2 + f, H, W), P(R, m, W)], inside, 1, PART.SLOPE);
  }
  if (f > 0) B.poly([P(R / 2 - f, H, 0), P(R / 2 + f, H, 0), P(R / 2 + f, H, W), P(R / 2 - f, H, W)], inside, 0, PART.PLAIN_TOP);
  return B.finish(size);
}

// --- Ramp Crest End (PB_DefaultRampCrestEnd) ---
// A crest whose ridge is closed at one end by a third sloped face (a hip-roof end). The other end
// is open (a vertical crest profile). Always a sharp ridge (CREST_PEAK_FLAT is ignored here).
// size, run, up: as crestMesh. closed: +1 / -1, which way along the OTHER horizontal axis (the
// width) the closed end is.
function crestEndMesh(size, run = 0, closed = -1, up = 1) {
  const R = size[run], W = size[1 - run], H = size[2];
  const m = Math.min(CREST_LIP, H);
  const ER = CREST_END_PITCH === 'width' ? W : Math.min(R / 2, W);   // the end face's horizontal run
  const P = (u, v, w) => {                                    // w = 0 at the closed end
    const p = [0, v - H / 2, 0];
    p[run === 0 ? 0 : 2] = u - R / 2;
    p[run === 0 ? 2 : 0] = closed > 0 ? W / 2 - w : w - W / 2;
    return p;
  };
  const B = new Builder(up), inside = P(R / 2, m / 2, W / 2);
  B.poly([P(0, 0, 0), P(R, 0, 0), P(R, 0, W), P(0, 0, W)], inside, 0, PART.PLAIN);           // bottom
  B.poly([[0, 0], [R, 0], [R, m], [R / 2, H], [0, m]].map(([u, v]) => P(u, v, W)), inside, 0, PART.PLAIN);   // open end
  if (m > 0) {
    B.poly([P(0, 0, 0), P(0, m, 0), P(0, m, W), P(0, 0, W)], inside, 0, PART.PLAIN);         // lips: both sides
    B.poly([P(R, 0, 0), P(R, m, 0), P(R, m, W), P(R, 0, W)], inside, 0, PART.PLAIN);
    B.poly([P(0, 0, 0), P(0, m, 0), P(R, m, 0), P(R, 0, 0)], inside, 0, PART.PLAIN);         // and the closed end
  }
  if (H > m) {
    // side slopes: quads bounded by the hip lines (0,0,m)-(R/2,ER,H); triangles when ER = W
    const sideA = [P(0, m, 0), P(0, m, W), P(R / 2, H, W), P(R / 2, H, ER)];
    const sideB = [P(R, m, 0), P(R, m, W), P(R / 2, H, W), P(R / 2, H, ER)];
    const dedupe = q => (ER >= W - 1e-9 ? q.slice(0, 3) : q);
    B.poly(dedupe(sideA), inside, 1, PART.SLOPE);
    B.poly(dedupe(sideB), inside, 1, PART.SLOPE);
    B.poly([P(0, m, 0), P(R, m, 0), P(R / 2, H, ER)], inside, 1, PART.SLOPE);                // end face
  }
  return B.finish(size);
}

// --- Orientation byte -> rotation (same rule as tools/orient.js, verified in ORIENT_TEST.md) ---
// o = dir << 2 | rot. Returns M as 3 rows, M[i][j] = world component i of local axis j (save axes:
// X, Y, Z up). dir sends local +Z to +X -X +Y -Y +Z -Z; each rot step turns local +X onto local +Y.
function brickOrient(o) {
  const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1], n = v => v.map(c => -c);
  const D = [[Z, n(Y), X], [Z, Y, n(X)], [Z, X, Y], [Z, n(X), n(Y)], [X, Y, Z], [n(X), Y, n(Z)]][(o >> 2) % 6];
  const cols = [[D[0], D[1]], [D[1], n(D[0])], [n(D[0]), n(D[1])], [n(D[1]), D[0]]][o & 3];
  const c = [cols[0], cols[1], D[2]];
  return [0, 1, 2].map(i => [c[0][i], c[1][i], c[2][i]]);
}

// --- Micro family meshes ---
// Every shape is described in LOCAL normalised coordinates (each axis -1..1 = -half..+half) at
// orientation 16. Corner names below: (-X,-Y) is the local corner nearest -X and -Y.
//   box            plain box
//   wedge          vertical triangular prism: footprint = right triangle with the right angle at (-X,-Y),
//                  corner (+X,+Y) cut off; the hypotenuse face is VERTICAL (normal +X+Y); full height.
//   ramp           triangle in the X-Z plane extruded along Y: full height at -X, slope down to the
//                  bottom edge at +X (normal +X up). No lip, no crest.
//   corner         pyramid: full rectangular base, apex above (-X,-Y) at the top; vertical triangles
//                  on -X and -Y, slopes facing +X and +Y meeting along the diagonal (-X,-Y)-(+X,+Y).
//   innerCorner    box whose top is two slopes (facing +X and +Y) meeting in a valley from (-X,-Y,top)
//                  down to (+X,+Y,bottom); full walls on -X and -Y, triangles on +X and +Y.
//   outerCorner    box with the (+X,+Y,top) corner cut off by the plane through (+X,-Y,top),
//                  (-X,+Y,top), (+X,+Y,bottom): flat top triangle + one slope triangle.
//   triangleCorner tetrahedron: footprint triangle as the wedge, apex above (-X,-Y).
//   halfInnerCorner          tetrahedron: footprint triangle as the wedge, apex above (-X,+Y);
//                            -X triangle and hypotenuse triangle vertical, slope faces -Y (and up).
//   halfInnerCornerInverted  its mirror image (local X <-> Y): apex above (+X,-Y); slope faces -X.
//   halfOuterCorner  footprint triangle as the wedge; vertical rectangle on the hypotenuse, high at
//                    both acute corners, low (zero height) at (-X,-Y): one slope facing -X-Y.
//   roundHalf      half elliptic cylinder along Z: flat face at -X, curved side from -Y through +X to +Y
//                  (semi-axes 2*hx along X, hy along Y).
//   roundCorner    quarter elliptic cylinder along Z: flat faces -X and -Y, arc centred on the (-X,-Y)
//                  edge with semi-axes 2*hx, 2*hy.
//   pole           elliptic cylinder along Z filling the box (X != Y gives an ellipse).
// Every shape above matches the export exactly (EXPORT_ANALYSIS.md "Micro family"). Planar faces that
// are not axis-aligned are PART.FACET with flags = 0 (the export's plain Bevel material, no slope bump);
// curved sides are PART.ROUND_SIDE with smooth normals; flat axis-aligned faces are PART.PLAIN.
const MICRO_SHAPES = (function () {
  const P = (x, y, z) => [x, y, z];
  const b = (x, y) => P(x, y, -1), t = (x, y) => P(x, y, 1);
  const tri = [[-1, -1], [1, -1], [-1, 1]];                       // the footprint triangle
  const F = (pts, out, slope) => ({ pts, out, slope: !!slope });
  const box = [
    F([b(-1,-1), b(1,-1), b(1,1), b(-1,1)], [0,0,-1]), F([t(-1,-1), t(1,-1), t(1,1), t(-1,1)], [0,0,1]),
    F([b(-1,-1), b(-1,1), t(-1,1), t(-1,-1)], [-1,0,0]), F([b(1,-1), b(1,1), t(1,1), t(1,-1)], [1,0,0]),
    F([b(-1,-1), b(1,-1), t(1,-1), t(-1,-1)], [0,-1,0]), F([b(-1,1), b(1,1), t(1,1), t(-1,1)], [0,1,0]),
  ];
  return {
    box,
    wedge: [
      F(tri.map(([x, y]) => b(x, y)), [0,0,-1]), F(tri.map(([x, y]) => t(x, y)), [0,0,1]),
      F([b(-1,-1), b(-1,1), t(-1,1), t(-1,-1)], [-1,0,0]), F([b(-1,-1), b(1,-1), t(1,-1), t(-1,-1)], [0,-1,0]),
      F([b(1,-1), b(-1,1), t(-1,1), t(1,-1)], [1,1,0], true),
    ],
    ramp: [
      F([b(-1,-1), b(1,-1), b(1,1), b(-1,1)], [0,0,-1]),
      F([b(-1,-1), b(-1,1), t(-1,1), t(-1,-1)], [-1,0,0]),
      F([b(-1,-1), b(1,-1), t(-1,-1)], [0,-1,0]), F([b(-1,1), b(1,1), t(-1,1)], [0,1,0]),
      F([b(1,-1), b(1,1), t(-1,1), t(-1,-1)], [1,0,1], true),
    ],
    corner: [
      F([b(-1,-1), b(1,-1), b(1,1), b(-1,1)], [0,0,-1]),
      F([b(-1,-1), b(-1,1), t(-1,-1)], [-1,0,0]), F([b(-1,-1), b(1,-1), t(-1,-1)], [0,-1,0]),
      F([t(-1,-1), b(1,-1), b(1,1)], [1,0,1], true), F([t(-1,-1), b(-1,1), b(1,1)], [0,1,1], true),
    ],
    innerCorner: [
      F([b(-1,-1), b(1,-1), b(1,1), b(-1,1)], [0,0,-1]),
      F([b(-1,-1), b(-1,1), t(-1,1), t(-1,-1)], [-1,0,0]), F([b(-1,-1), b(1,-1), t(1,-1), t(-1,-1)], [0,-1,0]),
      F([b(1,-1), b(1,1), t(1,-1)], [1,0,0]), F([b(-1,1), b(1,1), t(-1,1)], [0,1,0]),
      F([t(-1,-1), t(-1,1), b(1,1)], [1,0,1], true), F([t(-1,-1), t(1,-1), b(1,1)], [0,1,1], true),
    ],
    outerCorner: [
      F([b(-1,-1), b(1,-1), b(1,1), b(-1,1)], [0,0,-1]),
      F([b(-1,-1), b(-1,1), t(-1,1), t(-1,-1)], [-1,0,0]), F([b(-1,-1), b(1,-1), t(1,-1), t(-1,-1)], [0,-1,0]),
      F([b(1,-1), b(1,1), t(1,-1)], [1,0,0]), F([b(-1,1), b(1,1), t(-1,1)], [0,1,0]),
      F([t(-1,-1), t(1,-1), t(-1,1)], [0,0,1]),
      F([t(1,-1), t(-1,1), b(1,1)], [1,1,1], true),
    ],
    triangleCorner: [
      F(tri.map(([x, y]) => b(x, y)), [0,0,-1]),
      F([b(-1,-1), b(-1,1), t(-1,-1)], [-1,0,0]), F([b(-1,-1), b(1,-1), t(-1,-1)], [0,-1,0]),
      F([b(1,-1), b(-1,1), t(-1,-1)], [1,1,1], true),
    ],
    halfInnerCorner: [
      F(tri.map(([x, y]) => b(x, y)), [0,0,-1]),
      F([b(-1,-1), b(-1,1), t(-1,1)], [-1,0,0]),
      F([b(1,-1), b(-1,1), t(-1,1)], [1,1,0], true),
      F([b(-1,-1), b(1,-1), t(-1,1)], [0,-1,1], true),
    ],
    halfInnerCornerInverted: [
      F(tri.map(([x, y]) => b(x, y)), [0,0,-1]),
      F([b(-1,-1), b(1,-1), t(1,-1)], [0,-1,0]),
      F([b(1,-1), b(-1,1), t(1,-1)], [1,1,0], true),
      F([b(-1,-1), b(-1,1), t(1,-1)], [-1,0,1], true),
    ],
    halfOuterCorner: [
      F(tri.map(([x, y]) => b(x, y)), [0,0,-1]),
      F([b(-1,-1), b(-1,1), t(-1,1)], [-1,0,0]), F([b(-1,-1), b(1,-1), t(1,-1)], [0,-1,0]),
      F([b(1,-1), b(-1,1), t(-1,1), t(1,-1)], [1,1,0], true),
      F([b(-1,-1), t(1,-1), t(-1,1)], [-1,-1,1], true),
    ],
  };
})();
// Curved shapes: an elliptic arc in the local X-Y plane, extruded over Z.
// c = centre (normalised), a / b = semi-axes (normalised), t0..t1 = arc angles, frac = share of a
// full circle (sets the facet count with microRoundSegments). Partial arcs get flat side faces closing
// back to the centre. The caps are fans from the centre, as in the export.
const MICRO_ARCS = {
  roundHalf:   { c: [-1, 0],  a: 2, b: 1, t0: -Math.PI / 2, t1: Math.PI / 2, frac: 0.5 },
  roundCorner: { c: [-1, -1], a: 2, b: 2, t0: 0, t1: Math.PI / 2, frac: 0.25 },
  pole:        { c: [0, 0],   a: 1, b: 1, t0: 0, t1: 2 * Math.PI, frac: 1 },
};
function isMicro(name) { return Object.prototype.hasOwnProperty.call(MICRO_TYPES, name); }
// asset: a MICRO_TYPES name (or a shape key such as 'wedge'); half: local half-extents [X, Y, Z] in
// Brickadia units (= micros for this family); o: orientation byte (all 24 work; 16 = upright rot 0).
// Returns the mesh in the unit box of its WORLD bounds, plus size (world [X,Y,Z] in viewer units, for
// uScale), worldHalf (world half-extents in Brickadia units) and shape.
function microMesh(asset, half, o = 16) {
  const shape = MICRO_TYPES[asset] || asset;
  const M = brickOrient(o);
  const L = half.map(h => h * UNIT);                                          // local half-extents, viewer units
  const toWorld = p => [0, 1, 2].map(i => M[i][0]*p[0]*L[0] + M[i][1]*p[1]*L[1] + M[i][2]*p[2]*L[2]);
  const dirWorld = d => [0, 1, 2].map(i => M[i][0]*d[0] + M[i][1]*d[1] + M[i][2]*d[2]);
  const gl = w => [w[0], w[2], w[1]];                                         // save axes -> GL (x = X, y = Z, z = Y)
  const B = new Builder(1);
  const face = (pts, out, flag, part) => {
    const w = pts.map(p => gl(toWorld(p)));
    let n = [0, 0, 0];
    for (let i = 1; i + 1 < w.length; i++) { const c = cross(sub(w[i], w[0]), sub(w[i+1], w[0])); n = [n[0]+c[0], n[1]+c[1], n[2]+c[2]]; }
    n = norm(n);
    if (dot(n, gl(dirWorld(out))) < 0) n = [-n[0], -n[1], -n[2]];
    for (let i = 1; i + 1 < w.length; i++) B.tri(w[0], w[i], w[i+1], n, flag, part);
  };
  if (MICRO_SHAPES[shape]) {
    for (const f of MICRO_SHAPES[shape]) face(f.pts, f.out, 0, f.slope ? PART.FACET : PART.PLAIN);
  } else if (MICRO_ARCS[shape]) {
    const A = MICRO_ARCS[shape];
    const R = Math.max(A.a * half[0], A.b * half[1]);                       // larger semi-axis, micros
    const seg = Math.max(2, Math.round((half[0] > 0 ? microRoundSegments(R) : MICRO_ROUND_SEGMENTS) * A.frac));
    const pt = (t, z) => [A.c[0] + A.a * Math.cos(t), A.c[1] + A.b * Math.sin(t), z];
    // smooth normal of the ellipse in REAL units: (cos t / (a*hx), sin t / (b*hy))
    const nrm = t => gl(dirWorld(norm([Math.cos(t) / (A.a * L[0]), Math.sin(t) / (A.b * L[1]), 0])));
    const ts = [];
    for (let i = 0; i <= seg; i++) ts.push(A.t0 + (A.t1 - A.t0) * i / seg);
    for (let i = 0; i < seg; i++) {
      const p00 = gl(toWorld(pt(ts[i], -1))), p10 = gl(toWorld(pt(ts[i+1], -1)));
      const p01 = gl(toWorld(pt(ts[i], 1))), p11 = gl(toWorld(pt(ts[i+1], 1)));
      const n0 = nrm(ts[i]), n1 = nrm(ts[i+1]);
      B.tri(p00, p10, p11, [n0, n1, n1], 0, PART.ROUND_SIDE);
      B.tri(p00, p11, p01, [n0, n1, n0], 0, PART.ROUND_SIDE);
    }
    for (const z of [-1, 1]) {                                                // the flat caps (fan from the centre)
      const C = [A.c[0], A.c[1], z];
      for (let i = 0; i < seg; i++) face([C, pt(ts[i], z), pt(ts[i+1], z)], [0, 0, z], 0, PART.PLAIN);
    }
    if (A.frac < 1) {                                                         // flat sides back to the centre
      const e0 = pt(A.t0, 0), e1 = pt(A.t1, 0);
      if (shape === 'roundHalf') face([[e0[0], e0[1], -1], [e1[0], e1[1], -1], [e1[0], e1[1], 1], [e0[0], e0[1], 1]], [-1, 0, 0], 0, PART.PLAIN);
      else {
        face([[-1, -1, -1], [e0[0], e0[1], -1], [e0[0], e0[1], 1], [-1, -1, 1]], [0, -1, 0], 0, PART.PLAIN);
        face([[-1, -1, -1], [e1[0], e1[1], -1], [e1[0], e1[1], 1], [-1, -1, 1]], [-1, 0, 0], 0, PART.PLAIN);
      }
    }
  } else throw new Error('unknown micro shape ' + asset);
  const wh = [0, 1, 2].map(i => Math.abs(M[i][0])*half[0] + Math.abs(M[i][1])*half[1] + Math.abs(M[i][2])*half[2]);
  const size = wh.map(h => 2 * h * UNIT);
  return B.finish(size, { size, worldHalf: wh, shape });
}

// --- Stud-scale special shapes, ramps and crests in the brick's LOCAL frame ---
// Measured from the game's glTF export (EXPORT_ANALYSIS.md "Special shapes"); procedural, no game data.
// Every generator below writes polygons in LOCAL Brickadia units around the brick centre (local +Z =
// the stud side, local +X = the ramp lip side, as tools/orient.js), h = local half-extents [X, Y, Z].
// localMesh() then turns them by the orientation byte exactly like microMesh, so all 24 orientations
// work. Part codes say which export material the face had: STUDS (Stud), INLET (InletBorder/Center),
// SLOPE + flags 1 (Bumpy), FACET (Bevel), RECESS (InletCenter used as a dark pit), PLAIN_TOP (a flat
// top with the Bevel material, e.g. SideWedgeTile).
const RAMP_CREST = 10;              // flat studded crest of every ramp-family brick: 1 stud (10 units) deep
const RAMP_LIP = 2;                 // vertical lip at a slope's low edge: 2 units (1 micro), also on wedges and crests
const ARCH_LEG = 10;                // arch legs: 1 stud along Y at each end
const ARCH_CROWN = 4;               // material above (Arch) / below (ArchInverted) the arc's apex: 1 plate
const archSegments = r => Math.round(14 + 0.4 * r);         // facets over the half circle: r 5/10/15/20 -> 16/18/20/22
const CAP_SEGMENTS = 10;            // RoundedCap: facets over its half-ellipse top
const CAP_ARC = 1.25;               // RoundedCap: vertical semi-axis = 1.25 x half height (straight walls below)
const PLATE_SEGMENTS = 20;          // BP_RoundPlate: facets around
// BP_RoundPlate profile [radius as a fraction of the half size, z in units at a 2-unit half height],
// counter-clockwise in (r, z): bottom centre -> rim -> recessed top centre
const ROUND_PLATE_PROFILE = [[0, -2], [0.5595, -2], [0.6, -1.6], [0.6, -1.25], [0.9607, -0.348], [1, 0.15], [1, 1.6], [0.9607, 1.902], [0.6, 1.0], [0, 1.0]];
// BP_SquarePlate rings [inset from the edge (units), corner chamfer (units), z (units)], same order
const SQUARE_PLATE_RINGS = [[4.4, 0, -2], [4, 0.452, -1.6], [4, 0.452, -1.25], [0.39, 0.4, -0.438], [0, 0.4, 0.05], [0, 0.4, 1.6], [0.388, 0.557, 1.903], [4, 0.557, 1.0]];
// BP_SpikePlate pit per stud cell: diamond rim tips, chamfer octagon (a, e), its drop, bottom square, depth below the top
const SPIKE_PIT = { rim: 4.172, a: 3.54, e: 0.158, drop: 0.094, bottom: 0.158, depth: 2.751 };
const LATTICE_HOLE = 3.276;         // BP_LatticeThin: diamond holes |x|+|y| < 3.276 around every stud-cell centre and corner
// PB_PicketFence (heights from the bottom, units): base, two rails, pickets with pointed tops
const FENCE = { base: 4, rails: [[8.236, 11.229], [16.236, 19.229]], railY: 1.17, picketHalf: 3.387, picketY: 1.674, shoulder: 20.617 };
// PB_Spike per stud cell: octagonal spire, levels [z, tip distance r, chamfer c]: the foot in units from the
// bottom, the spire as a fraction t of the height above the 2-unit foot
const SPIKE = { foot: [[0, 3.536, 0], [0.5, 3.889, 0.354], [2, 3.889, 0.354]], spire: [[0.008, 3.889, 0.354], [0.0903, 3.73, 0.361], [0.9975, 0.362, 0.362]] };
// PB_AerodynamicSurface(Vertical): slab 1.3 units thick tapering to an edge over the last 4 units of +X;
// the vertical one stands on a 4-unit base; a +X arrow (shaft and head, +-1 unit thick) in the middle
const AERO = { t: 0.65, taper: 4, base: 4, shaft: [-2.5, 0.5], shaftW: 0.45, head: [0.5, 2.5], headW: 1.5, at: 1 };
// PB_Baguette stand-in: a loaf, dips to BAGUETTE_DIP of the height at every interior stud line
const BAGUETTE_DIP = 0.76, BAGUETTE_SEG = 12;

function LocalBuilder() { this.f = []; }
// flat polygon (convex, or a fan valid from pts[0]); out = any vector on the outer side
// rect (optional): [lo, hi] local corners of the face's bevel rectangle when it isn't the face's own
// bounds (a face that continues another surface's UV strip, e.g. an arch's inner wall)
LocalBuilder.prototype.poly = function (pts, out, part, flag = 0, rect) { if (pts.length >= 3) this.f.push({ pts, out, part, flag, rect }); return this; };
// polygon with per-vertex normals (smooth surfaces), normals in local real units
LocalBuilder.prototype.smooth = function (pts, nrms, part, flag = 0) { this.f.push({ pts, nrms, part, flag }); return this; };
// axis-aligned box [lo, hi]; parts: top / bottom (local +Z / -Z) / side, or px nx py ny; skip = names to leave out
LocalBuilder.prototype.box = function (lo, hi, parts = {}, skip = '') {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi, side = parts.side ?? PART.FACET, sk = skip.split(' ');
  const F = {
    top: [[[x0,y0,z1], [x1,y0,z1], [x1,y1,z1], [x0,y1,z1]], [0,0,1], parts.top ?? PART.FACET],
    bottom: [[[x0,y0,z0], [x1,y0,z0], [x1,y1,z0], [x0,y1,z0]], [0,0,-1], parts.bottom ?? PART.FACET],
    px: [[[x1,y0,z0], [x1,y1,z0], [x1,y1,z1], [x1,y0,z1]], [1,0,0], parts.px ?? side],
    nx: [[[x0,y0,z0], [x0,y1,z0], [x0,y1,z1], [x0,y0,z1]], [-1,0,0], parts.nx ?? side],
    py: [[[x0,y1,z0], [x1,y1,z0], [x1,y1,z1], [x0,y1,z1]], [0,1,0], parts.py ?? side],
    ny: [[[x0,y0,z0], [x1,y0,z0], [x1,y0,z1], [x0,y0,z1]], [0,-1,0], parts.ny ?? side],
  };
  for (const k in F) if (!sk.includes(k)) this.poly(...F[k]);
  return this;
};
// Mirror in local Z (the *Inverted types), swapping the studded and underside faces.
LocalBuilder.prototype.invert = function () {
  for (const F of this.f) {
    F.pts = F.pts.map(p => [p[0], p[1], -p[2]]);
    if (F.out) F.out = [F.out[0], F.out[1], -F.out[2]];
    if (F.nrms) F.nrms = F.nrms.map(n => [n[0], n[1], -n[2]]);
    if (F.rect) F.rect = F.rect.map(p => [p[0], p[1], -p[2]]);
    if (F.part === PART.INLET) F.part = PART.STUDS; else if (F.part === PART.STUDS) F.part = PART.INLET;
  }
  return this;
};
// local polygons -> oriented mesh in the unit box of the WORLD bounds (same conventions as microMesh)
function localMesh(L, half, o, extra) {
  const M = brickOrient(o);
  const toW = p => [0, 1, 2].map(i => (M[i][0]*p[0] + M[i][1]*p[1] + M[i][2]*p[2]) * UNIT);
  const dW = d => [0, 1, 2].map(i => M[i][0]*d[0] + M[i][1]*d[1] + M[i][2]*d[2]);
  const gl = w => [w[0], w[2], w[1]];
  const B = new Builder(1);
  const wh = [0, 1, 2].map(i => Math.abs(M[i][0])*half[0] + Math.abs(M[i][1])*half[1] + Math.abs(M[i][2])*half[2]);
  const size = wh.map(v => 2 * v * UNIT), gs = gl(size);
  // a preset bevel rectangle in unit-box coords (u, v = the face's other GL axes in x, y, z order)
  const rectCap = (F, n) => {
    const a = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    const [u, v] = [[1, 2], [0, 2], [0, 1]][a], c = F.rect.map(p => gl(toW(p)).map((x, i) => x / gs[i]));
    return [Math.min(c[0][u], c[1][u]), Math.min(c[0][v], c[1][v]), Math.max(c[0][u], c[1][u]), Math.max(c[0][v], c[1][v])];
  };
  for (const F of L.f) {
    const w = F.pts.map(p => gl(toW(p)));
    if (F.nrms) {
      const ns = F.nrms.map(n => gl(norm(dW(n))));
      for (let i = 1; i + 1 < w.length; i++) B.tri(w[0], w[i], w[i+1], [ns[0], ns[i], ns[i+1]], F.flag, F.part);
      continue;
    }
    let n = [0, 0, 0];                                        // Newell normal
    for (let i = 0; i < w.length; i++) {
      const a = w[i], b = w[(i + 1) % w.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    if (Math.hypot(n[0], n[1], n[2]) < 1e-14) continue;
    n = norm(n);
    if (dot(n, gl(dW(F.out))) < 0) n = [-n[0], -n[1], -n[2]];
    const cap = F.rect ? rectCap(F, n) : undefined;
    for (let i = 1; i + 1 < w.length; i++) B.tri(w[0], w[i], w[i+1], n, F.flag, F.part, cap);
  }
  return B.finish(size, Object.assign({ size, worldHalf: wh }, extra || {}));
}
// a side profile (X-Z, counter-clockwise seen from +Y... any winding) extruded over Y: both end caps and
// one quad per profile edge; parts / flags per edge
function extrudeXZ(L, prof, y0, y1, parts, flags) {
  L.poly(prof.map(([x, z]) => [x, y0, z]), [0, -1, 0], PART.FACET);
  L.poly(prof.map(([x, z]) => [x, y1, z]), [0, 1, 0], PART.FACET);
  const c = prof.reduce((s, p) => [s[0] + p[0] / prof.length, s[1] + p[1] / prof.length], [0, 0]);
  for (let i = 0; i < prof.length; i++) {
    const a = prof[i], b = prof[(i + 1) % prof.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) continue;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    L.poly([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], [mid[0] - c[0], 0, mid[1] - c[1]], parts[i], flags ? flags[i] : 0);
  }
}
// a closed ring of rings (revolved / offset profile): rings[k] are equal-length point loops, outward hint per band
function bandStrip(L, rings, outOf, part) {
  for (let k = 0; k + 1 < rings.length; k++) {
    const A = rings[k], Bv = rings[k + 1], n = A.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      L.poly([A[i], A[j], Bv[j], Bv[i]], outOf(k, A[i], A[j], Bv[j], Bv[i]), part);
    }
  }
}

// PB_DefaultRamp / PB_DefaultWedge (no crest, plain slope) / PB_DefaultRampInverted (mirrored in Z).
// Profile over local X: studded crest RAMP_CREST deep at -X, slope down to a RAMP_LIP lip at +X.
function rampFaces(h, kind) {
  const [hx, hy, hz] = h, L = new LocalBuilder();
  const c = kind === 'wedge' ? 0 : Math.min(RAMP_CREST, 2 * hx), m = Math.min(RAMP_LIP, 2 * hz);
  const zl = -hz + m, xc = -hx + c, bump = kind !== 'wedge';
  const prof = [[-hx, -hz], [hx, -hz], [hx, zl], [xc, hz], [-hx, hz]];   // edges: bottom, lip, slope, crest top, back
  extrudeXZ(L, prof, -hy, hy, [PART.INLET, PART.FACET, bump ? PART.SLOPE : PART.FACET, PART.STUDS, PART.FACET], [0, 0, bump ? 1 : 0, 0, 0]);
  if (kind === 'inverted') L.invert();                        // full studded top; the crest is now the flat bottom
  return L;
}
// PB_DefaultRampCorner (outer corner) / ...Inverted: studded crest square at (-X,-Y), slopes down to
// lips on +X and +Y, meeting on the diagonal from the crest's inner corner to (+X,+Y).
function rampCornerFaces(h, inverted) {
  const [hx, hy, hz] = h, L = new LocalBuilder();
  const zl = -hz + Math.min(RAMP_LIP, 2 * hz);
  const xc = -hx + Math.min(RAMP_CREST, 2 * hx), yc = -hy + Math.min(RAMP_CREST, 2 * hy);
  L.poly([[-hx,-hy,-hz], [hx,-hy,-hz], [hx,hy,-hz], [-hx,hy,-hz]], [0,0,-1], PART.INLET);
  L.poly([[-hx,-hy,hz], [xc,-hy,hz], [xc,yc,hz], [-hx,yc,hz]], [0,0,1], PART.STUDS);
  L.poly([[xc,-hy,hz], [hx,-hy,zl], [hx,hy,zl], [xc,yc,hz]], [1,0,1], PART.SLOPE, 1);
  L.poly([[-hx,yc,hz], [xc,yc,hz], [hx,hy,zl], [-hx,hy,zl]], [0,1,1], PART.SLOPE, 1);
  L.poly([[-hx,-hy,-hz], [-hx,-hy,hz], [-hx,yc,hz], [-hx,hy,zl], [-hx,hy,-hz]], [-1,0,0], PART.FACET);
  L.poly([[-hx,-hy,-hz], [-hx,-hy,hz], [xc,-hy,hz], [hx,-hy,zl], [hx,-hy,-hz]], [0,-1,0], PART.FACET);
  L.poly([[hx,-hy,-hz], [hx,hy,-hz], [hx,hy,zl], [hx,-hy,zl]], [1,0,0], PART.FACET);
  L.poly([[-hx,hy,-hz], [hx,hy,-hz], [hx,hy,zl], [-hx,hy,zl]], [0,1,0], PART.FACET);
  return inverted ? L.invert() : L;
}
// PB_DefaultRampInnerCorner / ...Inverted: studded L-shaped top (all but the (+X,+Y) part beyond the crest
// lines), two slope triangles meeting in a valley that runs down to the lip corner at (+X,+Y).
function rampInnerCornerFaces(h, inverted) {
  const [hx, hy, hz] = h, L = new LocalBuilder();
  const zl = -hz + Math.min(RAMP_LIP, 2 * hz);
  const xc = -hx + Math.min(RAMP_CREST, 2 * hx), yc = -hy + Math.min(RAMP_CREST, 2 * hy);
  L.poly([[-hx,-hy,-hz], [hx,-hy,-hz], [hx,hy,-hz], [-hx,hy,-hz]], [0,0,-1], PART.INLET);
  L.poly([[-hx,-hy,hz], [hx,-hy,hz], [hx,yc,hz], [-hx,yc,hz]], [0,0,1], PART.STUDS);     // L top: the strip along -Y ...
  L.poly([[-hx,yc,hz], [xc,yc,hz], [xc,hy,hz], [-hx,hy,hz]], [0,0,1], PART.STUDS);       // ... and the one along -X
  L.poly([[xc,yc,hz], [hx,hy,zl], [xc,hy,hz]], [1,0,1], PART.SLOPE, 1);
  L.poly([[xc,yc,hz], [hx,yc,hz], [hx,hy,zl]], [0,1,1], PART.SLOPE, 1);
  L.poly([[-hx,-hy,-hz], [-hx,hy,-hz], [-hx,hy,hz], [-hx,-hy,hz]], [-1,0,0], PART.FACET);
  L.poly([[-hx,-hy,-hz], [hx,-hy,-hz], [hx,-hy,hz], [-hx,-hy,hz]], [0,-1,0], PART.FACET);
  L.poly([[hx,-hy,-hz], [hx,-hy,hz], [hx,yc,hz], [hx,hy,zl], [hx,hy,-hz]], [1,0,0], PART.FACET);
  L.poly([[-hx,hy,-hz], [-hx,hy,hz], [xc,hy,hz], [hx,hy,zl], [hx,hy,-hz]], [0,1,0], PART.FACET);
  return inverted ? L.invert() : L;
}
// PB_DefaultRampCrestCorner: an L-shaped ridge from the middle of the -Y edge to the centre, then to the
// middle of the +X edge; four bumpy slopes down to RAMP_LIP lips on all four sides (a valley toward
// (-X,+Y), a hip toward (+X,-Y)).
function crestCornerFaces(h) {
  const [hx, hy, hz] = h, L = new LocalBuilder();
  const zl = -hz + Math.min(RAMP_LIP, 2 * hz);
  L.poly([[-hx,-hy,-hz], [hx,-hy,-hz], [hx,hy,-hz], [-hx,hy,-hz]], [0,0,-1], PART.INLET);
  L.poly([[-hx,-hy,zl], [-hx,hy,zl], [0,0,hz], [0,-hy,hz]], [-1,0,1], PART.SLOPE, 1);
  L.poly([[0,-hy,hz], [0,0,hz], [hx,-hy,zl]], [1,0,1], PART.SLOPE, 1);
  L.poly([[-hx,hy,zl], [hx,hy,zl], [hx,0,hz], [0,0,hz]], [0,1,1], PART.SLOPE, 1);
  L.poly([[0,0,hz], [hx,0,hz], [hx,-hy,zl]], [0,-1,1], PART.SLOPE, 1);
  L.poly([[-hx,-hy,-hz], [-hx,hy,-hz], [-hx,hy,zl], [-hx,-hy,zl]], [-1,0,0], PART.FACET);
  L.poly([[-hx,hy,-hz], [hx,hy,-hz], [hx,hy,zl], [-hx,hy,zl]], [0,1,0], PART.FACET);
  L.poly([[hx,-hy,-hz], [hx,-hy,zl], [hx,0,hz], [hx,hy,zl], [hx,hy,-hz]], [1,0,0], PART.FACET);
  L.poly([[-hx,-hy,-hz], [-hx,-hy,zl], [0,-hy,hz], [hx,-hy,zl], [hx,-hy,-hz]], [0,-1,0], PART.FACET);
  return L;
}
// PB_DefaultRampCrest, local frame: run along local X, sharp ridge at x = 0, lips at both ends.
function crestFaces(h) {
  const [hx, hy, hz] = h, L = new LocalBuilder();
  const zl = -hz + Math.min(RAMP_LIP, 2 * hz);
  extrudeXZ(L, [[-hx, -hz], [hx, -hz], [hx, zl], [0, hz], [-hx, zl]], -hy, hy, [PART.INLET, PART.FACET, PART.SLOPE, PART.SLOPE, PART.FACET], [0, 0, 1, 1, 0]);
  return L;
}
// PB_DefaultRampCrestEnd, local frame: the crest closed at local -Y by a hip face (CREST_END_PITCH).
function crestEndFaces(h) {
  const [hx, hy, hz] = h, L = new LocalBuilder();
  const zl = -hz + Math.min(RAMP_LIP, 2 * hz), R = 2 * hx, W = 2 * hy;
  const ER = CREST_END_PITCH === 'width' ? W : Math.min(R / 2, W), ya = -hy + ER;
  L.poly([[-hx,-hy,-hz], [hx,-hy,-hz], [hx,hy,-hz], [-hx,hy,-hz]], [0,0,-1], PART.INLET);
  L.poly([[-hx,hy,-hz], [hx,hy,-hz], [hx,hy,zl], [0,hy,hz], [-hx,hy,zl]], [0,1,0], PART.FACET);   // open end
  L.poly([[-hx,-hy,-hz], [-hx,hy,-hz], [-hx,hy,zl], [-hx,-hy,zl]], [-1,0,0], PART.FACET);
  L.poly([[hx,-hy,-hz], [hx,hy,-hz], [hx,hy,zl], [hx,-hy,zl]], [1,0,0], PART.FACET);
  L.poly([[-hx,-hy,-hz], [hx,-hy,-hz], [hx,-hy,zl], [-hx,-hy,zl]], [0,-1,0], PART.FACET);
  L.poly([[-hx,-hy,zl], [-hx,hy,zl], [0,hy,hz], [0,ya,hz]], [-1,0,1], PART.SLOPE, 1);
  L.poly([[hx,-hy,zl], [hx,hy,zl], [0,hy,hz], [0,ya,hz]], [1,0,1], PART.SLOPE, 1);
  L.poly([[-hx,-hy,zl], [hx,-hy,zl], [0,ya,hz]], [0,-1,1], PART.SLOPE, 1);
  return L;
}
// PB_DefaultSideWedge(Tile): vertical prism on the footprint triangle (-X,-Y) (+X,-Y) (-X,+Y); studded top
// (the Tile variant: a plain Bevel top), underside below.
function sideWedgeFaces(h, tile) {
  const [hx, hy, hz] = h, L = new LocalBuilder();
  const tri = [[-hx, -hy], [hx, -hy], [-hx, hy]];
  L.poly(tri.map(([x, y]) => [x, y, -hz]), [0,0,-1], PART.INLET);
  L.poly(tri.map(([x, y]) => [x, y, hz]), [0,0,1], tile ? PART.PLAIN_TOP : PART.STUDS);
  L.poly([[-hx,-hy,-hz], [hx,-hy,-hz], [hx,-hy,hz], [-hx,-hy,hz]], [0,-1,0], PART.FACET);
  L.poly([[-hx,-hy,-hz], [-hx,hy,-hz], [-hx,hy,hz], [-hx,-hy,hz]], [-1,0,0], PART.FACET);
  L.poly([[hx,-hy,-hz], [-hx,hy,-hz], [-hx,hy,hz], [hx,-hy,hz]], [hy,hx,0], PART.FACET);
  return L;
}
// PB_DefaultArch / ArchInverted: spans local Y; legs ARCH_LEG long at both ends; a semicircular opening of
// radius r = hy - ARCH_LEG whose apex is ARCH_CROWN below the top, straight walls below the arc's centre.
// The inverted one is mirrored in Z (a U open at the top): studs on the leg tops, a full underside.
function archFaces(h, inverted) {
  const [hx, hy, hz] = h, L = new LocalBuilder();
  const r = Math.max(0, hy - ARCH_LEG), b = Math.max(0, Math.min(r, 2 * hz - ARCH_CROWN));   // b < r: squashed (X1)
  const zc = hz - ARCH_CROWN - b, n = archSegments(r);
  const arc = [];                                              // from (-r, zc) over the apex to (r, zc)
  for (let i = 0; i <= n; i++) { const t = Math.PI * (1 - i / n); arc.push([r * Math.cos(t), zc + b * Math.sin(t)]); }
  L.poly([[-hx,-hy,hz], [hx,-hy,hz], [hx,hy,hz], [-hx,hy,hz]], [0,0,1], PART.STUDS);
  for (const s of [-1, 1]) {
    const y0 = s * hy, y1 = s * r, ylo = Math.min(y0, y1), yhi = Math.max(y0, y1);
    L.poly([[-hx,ylo,-hz], [hx,ylo,-hz], [hx,yhi,-hz], [-hx,yhi,-hz]], [0,0,-1], PART.INLET);   // leg bottom
    L.poly([[-hx,y0,-hz], [hx,y0,-hz], [hx,y0,hz], [-hx,y0,hz]], [0,s,0], PART.FACET);           // end face
    // inner wall: the arc's strip continues down it, so its top edge (where the arc starts) has no bevel
    if (zc > -hz) L.poly([[-hx,y1,-hz], [hx,y1,-hz], [hx,y1,zc], [-hx,y1,zc]], [0,-s,0], PART.FACET, 0, [[-hx,y1,-hz], [hx,y1,zc + 4 * hz]]);
    for (const x of [-hx, hx]) L.poly([[x,ylo,-hz], [x,yhi,-hz], [x,yhi,hz], [x,ylo,hz]], [Math.sign(x),0,0], PART.FACET);   // leg sides
  }
  for (let i = 0; i < n; i++) {
    const [ya, za] = arc[i], [yb, zb] = arc[i + 1];
    const na = norm([0, -ya / ((r || 1) * (r || 1)), -(za - zc) / ((b || 1) * (b || 1))]), nb = norm([0, -yb / ((r || 1) * (r || 1)), -(zb - zc) / ((b || 1) * (b || 1))]);
    L.smooth([[-hx,ya,za], [hx,ya,za], [hx,yb,zb], [-hx,yb,zb]], [na, na, nb, nb], PART.FACET);   // the arc (smooth, facing its centre)
    for (const x of [-hx, hx]) L.poly([[x,ya,za], [x,yb,zb], [x,yb,hz], [x,ya,hz]], [Math.sign(x),0,0], PART.FACET);   // side above the arc
  }
  return inverted ? L.invert() : L;
}
// PB_DefaultStudded: a box with studs on the top and the four sides (10-unit pitch), the underside below.
function studdedFaces(h) {
  const [hx, hy, hz] = h;
  return new LocalBuilder().box([-hx, -hy, -hz], [hx, hy, hz], { top: PART.STUDS, bottom: PART.INLET, side: PART.STUDS });
}
// PB_RoundedCap: extruded along local X; straight walls up to zc, then a half-ellipse (a = hy,
// b = CAP_ARC * hz) to the top; underside below.
function roundedCapFaces(h) {
  const [hx, hy, hz] = h, L = new LocalBuilder();
  const b = Math.min(CAP_ARC * hz, 2 * hz), zc = hz - b;
  const prof = [[hy, -hz]];
  for (let i = 0; i <= CAP_SEGMENTS; i++) { const t = Math.PI * i / CAP_SEGMENTS; prof.push([hy * Math.cos(t), zc + b * Math.sin(t)]); }
  prof.push([-hy, -hz]);
  L.poly(prof.map(([y, z]) => [-hx, y, z]), [-1,0,0], PART.FACET);
  L.poly(prof.map(([y, z]) => [hx, y, z]), [1,0,0], PART.FACET);
  L.poly([[-hx,-hy,-hz], [hx,-hy,-hz], [hx,hy,-hz], [-hx,hy,-hz]], [0,0,-1], PART.INLET);
  for (const s of [-1, 1]) L.poly([[-hx,s*hy,-hz], [hx,s*hy,-hz], [hx,s*hy,zc], [-hx,s*hy,zc]], [0,s,0], PART.FACET);
  for (let i = 0; i < CAP_SEGMENTS; i++) {
    const ta = Math.PI * i / CAP_SEGMENTS, tb = Math.PI * (i + 1) / CAP_SEGMENTS;
    const na = norm([0, Math.cos(ta) / hy, Math.sin(ta) / b]), nb = norm([0, Math.cos(tb) / hy, Math.sin(tb) / b]);
    L.smooth([[-hx, hy*Math.cos(ta), zc + b*Math.sin(ta)], [hx, hy*Math.cos(ta), zc + b*Math.sin(ta)],
              [hx, hy*Math.cos(tb), zc + b*Math.sin(tb)], [-hx, hy*Math.cos(tb), zc + b*Math.sin(tb)]], [na, na, nb, nb], PART.FACET);
  }
  return L;
}
// BP_RoundPlate: ROUND_PLATE_PROFILE revolved (PLATE_SEGMENTS facets), radius scaled to the hx x hy
// ellipse. BP_SquarePlate: SQUARE_PLATE_RINGS as chamfered rectangles inset from the edge. No studs and
// no underside (the export gives every face the Bevel material).
function plateFaces(h, square) {
  const [hx, hy, hz] = h, L = new LocalBuilder(), zs = hz / 2;
  let rings, prof;
  if (!square) {
    prof = ROUND_PLATE_PROFILE;
    rings = prof.map(([r, z]) => {
      const pts = [];
      for (let i = 0; i < PLATE_SEGMENTS; i++) { const a = 2 * Math.PI * i / PLATE_SEGMENTS; pts.push([r * hx * Math.cos(a), r * hy * Math.sin(a), z * zs]); }
      return pts;
    });
  } else {
    const ring = ([d, k, z]) => {
      const x = hx - d, y = hy - d;
      return [[x, -y + k], [x, y - k], [x - k, y], [-x + k, y], [-x, y - k], [-x, -y + k], [-x + k, -y], [x - k, -y]].map(([a, b]) => [a, b, z * zs]);
    };
    const R = SQUARE_PLATE_RINGS;
    rings = [ring([0, 0, R[0][2]]).map(p => [0, 0, p[2]]), ...R.map(ring), ring([0, 0, R[R.length - 1][2]]).map(p => [0, 0, p[2]])];
    prof = [[0, R[0][2]], ...R.map(([d, , z]) => [1 - d / 10, z]), [0, R[R.length - 1][2]]];   // (r, z) for the outward hints
  }
  // outward hint from the profile's direction (counter-clockwise in (r, z)): edge (dr, dz) -> (dz, -dr)
  bandStrip(L, rings, (k, a, b) => {
    const dr = prof[k + 1][0] - prof[k][0], dz = prof[k + 1][1] - prof[k][1];
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], l = Math.hypot(m[0], m[1]) || 1;
    return [dz * m[0] / l, dz * m[1] / l, -dr];
  }, PART.FACET);
  return L;
}
// BP_SpikePlate: a plate with one funnel pit per stud cell (diamond rim, a small octagon chamfer, a tiny
// square bottom). The pits are RECESS (the export's InletCenter material); underside below.
function spikePlateFaces(h) {
  const [hx, hy, hz] = h, L = new LocalBuilder(), P = SPIKE_PIT;
  L.box([-hx, -hy, -hz], [hx, hy, hz], { bottom: PART.INLET }, 'top');
  const zr = hz, zo = hz - P.drop, zb = hz - P.depth;
  for (let cx = -hx + 5; cx < hx - 1e-9; cx += 10) for (let cy = -hy + 5; cy < hy - 1e-9; cy += 10) {
    const c = (x, y, z) => [cx + x, cy + y, z];
    const tip = [c(P.rim, 0, zr), c(0, P.rim, zr), c(-P.rim, 0, zr), c(0, -P.rim, zr)];
    const cor = [c(5, 5, zr), c(-5, 5, zr), c(-5, -5, zr), c(5, -5, zr)];         // cor[i] lies between tip[i] and tip[i+1]
    for (let i = 0; i < 4; i++) {
      L.poly([tip[i], cor[i], tip[(i + 1) % 4]], [0,0,1], PART.FACET);
      L.poly([cor[(i + 3) % 4], cor[i], tip[i]], [0,0,1], PART.FACET);
    }
    const a = P.a, e = P.e, q = P.bottom;
    // octagon: two points next to each tip, in order around (+X tip first)
    const oct = [c(a,-e,zo), c(a,e,zo), c(e,a,zo), c(-e,a,zo), c(-a,e,zo), c(-a,-e,zo), c(-e,-a,zo), c(e,-a,zo)];
    const bot = [c(q,q,zb), c(-q,q,zb), c(-q,-q,zb), c(q,-q,zb)];                 // bot[i]: the quadrant after tip i
    for (let i = 0; i < 4; i++) {
      const t0 = tip[i], t1 = tip[(i + 1) % 4], o0 = oct[2*i], o1 = oct[2*i + 1], o2 = oct[(2*i + 2) % 8];
      const inward = [cx - t0[0], cy - t0[1], 0];
      L.poly([o0, t0, o1], [-inward[0], -inward[1], 1].map((v, k) => k < 2 ? -v : v), PART.FACET);   // chamfer at the tip
      L.poly([o1, t0, t1, o2], [cx - (t0[0] + t1[0]) / 2, cy - (t0[1] + t1[1]) / 2, 1], PART.FACET); // chamfer along the side
      L.poly([o0, o1, bot[i], bot[(i + 3) % 4]], [cx - t0[0], cy - t0[1], 1], PART.RECESS);          // funnel below the tip
      L.poly([o1, o2, bot[i]], [cx - (t0[0] + t1[0]) / 2, cy - (t0[1] + t1[1]) / 2, 1], PART.RECESS); // funnel below the side
    }
    L.poly(bot, [0,0,1], PART.RECESS);
  }
  return L;
}
// BP_LatticeThin: a slab with diamond holes |x|+|y| < LATTICE_HOLE around every stud-cell centre and
// every cell corner, leaving diagonal bars. Built per cell as an octagonal ring (cell square with the
// corners cut) around the centre diamond; outer walls only on the brick's boundary.
function latticeFaces(h) {
  const [hx, hy, hz] = h, L = new LocalBuilder(), d = LATTICE_HOLE, k = 5 - d;   // k: half of the solid edge middle
  for (let cx = -hx + 5; cx < hx - 1e-9; cx += 10) for (let cy = -hy + 5; cy < hy - 1e-9; cy += 10) {
    const c = (x, y, z) => [cx + x, cy + y, z];
    // outer octagon (corners cut by the corner holes) and inner diamond, counter-clockwise from +X
    const outer = [[5, -k], [5, k], [k, 5], [-k, 5], [-5, k], [-5, -k], [-k, -5], [k, -5]];
    const inner = [[d, 0], [d, 0], [0, d], [0, d], [-d, 0], [-d, 0], [0, -d], [0, -d]];
    for (const z of [-hz, hz]) for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      L.poly([c(...outer[i], z), c(...outer[j], z), c(...inner[j], z), c(...inner[i], z)], [0, 0, Math.sign(z)], PART.FACET);
    }
    for (let i = 0; i < 8; i += 2) {                         // hole walls (the diamond's four sides face the centre)
      const a = inner[i + 1], b = inner[(i + 2) % 8];
      L.poly([c(...a, -hz), c(...b, -hz), c(...b, hz), c(...a, hz)], [-(a[0] + b[0]), -(a[1] + b[1]), 0], PART.FACET);
    }
    for (let i = 1; i < 8; i += 2) {                         // corner-hole walls (the cut corners face outward)
      const a = outer[i], b = outer[(i + 1) % 8];
      L.poly([c(...a, -hz), c(...b, -hz), c(...b, hz), c(...a, hz)], [a[0] + b[0], a[1] + b[1], 0], PART.FACET);
    }
    for (let i = 0; i < 8; i += 2) {                         // cell-edge middles: walls only on the brick's boundary
      const A = outer[i], B = outer[i + 1];
      const ex = cx + (A[0] + B[0]) / 2, ey = cy + (A[1] + B[1]) / 2;
      if (Math.abs(Math.abs(ex) - hx) > 1e-6 && Math.abs(Math.abs(ey) - hy) > 1e-6) continue;
      L.poly([c(...A, -hz), c(...B, -hz), c(...B, hz), c(...A, hz)], [A[0] + B[0], A[1] + B[1], 0], PART.FACET);
    }
  }
  return L;
}
// PB_PicketFence (runs along local X): a full-footprint base FENCE.base tall (underside below), two
// rails, and one picket per stud with a pointed top reaching the full height.
function fenceFaces(h) {
  const [hx, hy, hz] = h, L = new LocalBuilder(), z0 = -hz, F = FENCE, zb = z0 + F.base;
  const w = F.picketHalf, t = F.picketY, zs = z0 + F.shoulder, zt = hz;
  const cs = []; for (let cx = -hx + 5; cx < hx - 1e-9; cx += 10) cs.push(cx);
  L.box([-hx, -hy, z0], [hx, hy, zb], { bottom: PART.INLET });
  // rails: segments between the pickets (the export leaves the parts inside the pickets out, but keeps
  // the base's top face under them)
  const gaps = [-hx, ...cs.flatMap(c => [c - w, c + w]), hx];
  for (const [ra, rb] of F.rails) for (let k = 0; k + 1 < gaps.length; k += 2) {
    const [a, b] = [gaps[k], gaps[k + 1]];
    if (b - a < 1e-9) continue;
    L.box([a, -F.railY, z0 + ra], [b, F.railY, z0 + rb], {}, (a > -hx + 1e-9 ? 'nx ' : '') + (b < hx - 1e-9 ? 'px' : ''));
  }
  // pickets: one per stud, pointed top reaching the full height
  for (const cx of cs) {
    L.box([cx - w, -t, zb], [cx + w, t, zs], {}, 'top bottom');
    for (const y of [-t, t]) L.poly([[cx - w, y, zs], [cx + w, y, zs], [cx, y, zt]], [0, y, 0], PART.FACET);
    for (const s of [-1, 1]) L.poly([[cx + s*w, -t, zs], [cx + s*w, t, zs], [cx, t, zt], [cx, -t, zt]], [s * (zt - zs), 0, w], PART.FACET);
  }
  return L;
}
// PB_Spike: one octagonal spire per stud cell (SPIKE levels), a plain bottom.
function spikeFaces(h) {
  const [hx, hy, hz] = h, L = new LocalBuilder(), z0 = -hz, H = 2 * hz;
  const levels = [...SPIKE.foot.map(([z, r, c]) => [z0 + z, r, c]), ...SPIKE.spire.map(([t, r, c]) => [z0 + 2 + t * (H - 2), r, c])];
  const oct = (r, c) => [[r, -c], [r, c], [c, r], [-c, r], [-r, c], [-r, -c], [-c, -r], [c, -r]];
  for (let cx = -hx + 5; cx < hx - 1e-9; cx += 10) for (let cy = -hy + 5; cy < hy - 1e-9; cy += 10) {
    const rings = levels.map(([z, r, c]) => oct(r, c).map(([x, y]) => [cx + x, cy + y, z]));
    L.poly(rings[0].slice().reverse(), [0, 0, -1], PART.FACET);
    bandStrip(L, rings, (k, a, b) => [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy, 0.1], PART.FACET);
    L.poly(rings[rings.length - 1], [0, 0, 1], PART.FACET);
  }
  return L;
}
// PB_Baguette stand-in (X2): a loaf along local X with rounded ends and a dip at every interior stud
// line; flat bottom. The export's loaf is an organic mesh; this stays within about 0.5 unit of it.
function baguetteFaces(h) {
  const [hx, hy, hz] = h, L = new LocalBuilder(), nx = Math.max(8, Math.round(hx * 1.6)), na = BAGUETTE_SEG;
  const xs = []; for (let i = 0; i <= nx; i++) xs.push(-hx + 2 * hx * i / nx);
  const endR = Math.min(hy, hx);
  const width = x => { const e = Math.abs(x) - (hx - endR); return e <= 0 ? hy : hy * Math.sqrt(Math.max(0, 1 - (e / endR) ** 2)); };
  const top = x => {                                          // dips at interior stud lines (x = multiples of 10 from the end)
    const u = ((x + hx) % 10 + 10) % 10, dip = Math.cos(Math.PI * Math.min(u, 10 - u) / 5);
    const interior = Math.abs(x) < hx - 5;
    return interior ? 1 - (1 - BAGUETTE_DIP) * Math.max(0, dip) ** 4 : 1;
  };
  const sect = x => {                                         // half-ellipse over a flat bottom, scaled by width / top
    const w = width(x), t = top(x) * (w / hy) ** 0.5, pts = [];
    for (let j = 0; j <= na; j++) { const a = Math.PI * j / na; pts.push([x, w * Math.cos(a), -hz + 2 * hz * t * Math.sin(a)]); }
    return pts;
  };
  const S = xs.map(sect);
  for (let i = 0; i < nx; i++) for (let j = 0; j < na; j++) {
    const q = [S[i][j], S[i + 1][j], S[i + 1][j + 1], S[i][j + 1]];
    const a = Math.PI * (j + 0.5) / na;
    L.poly(q, [0, Math.cos(a), Math.sin(a)], PART.FACET);
  }
  for (let i = 0; i < nx; i++) L.poly([S[i][0], S[i][na], S[i + 1][na], S[i + 1][0]], [0, 0, -1], PART.FACET);
  return L;
}
// PB_AerodynamicSurface: a 1.3-unit slab tapering to an edge at +X, with a +X arrow (RECESS) through it.
// PB_AerodynamicSurfaceVertical: the same fin standing in the X-Z plane on a 4-unit base.
function aeroFaces(h, vertical) {
  const [hx, hy, hz] = h, L = new LocalBuilder(), A = AERO, t = A.t, xt = hx - A.taper;
  // airfoil profile across the thickness axis: (x, s) with s the thickness coordinate
  const prof = [[-hx, -t], [xt, -t], [hx, 0], [xt, t], [-hx, t]];
  const arrowPts = [[A.shaft[0], -A.shaftW], [A.shaft[1], -A.shaftW], [A.head[0], -A.headW], [A.head[1], 0], [A.head[0], A.headW], [A.shaft[1], A.shaftW], [A.shaft[0], A.shaftW]];
  if (!vertical) {
    extrudeXZ(L, prof, -hy, hy, [PART.FACET, PART.FACET, PART.FACET, PART.FACET, PART.FACET]);
    arrowPrism(L, arrowPts.map(([x, y]) => [x, y]), -A.at, A.at, 'z');
  } else {
    const zb = -hz + A.base, zm = (zb + hz) / 2;
    L.box([-hx, -hy, -hz], [hx, hy, zb], { bottom: PART.INLET });
    // the fin: profile in X-Y (thickness along Y), extruded over Z from zb to hz
    const pXY = prof.map(([x, s]) => [x, s]);
    L.poly(pXY.map(([x, y]) => [x, y, hz]), [0, 0, 1], PART.FACET);
    for (let i = 0; i < pXY.length; i++) {
      const a = pXY[i], b = pXY[(i + 1) % pXY.length];
      // the profile runs counter-clockwise in X-Y, so (dy, -dx) points out of the fin
      L.poly([[a[0], a[1], zb], [b[0], b[1], zb], [b[0], b[1], hz], [a[0], a[1], hz]], [b[1] - a[1], a[0] - b[0], 0], PART.FACET);
    }
    arrowPrism(L, arrowPts.map(([x, s]) => [x, zm + s]), -A.at, A.at, 'y');
  }
  return L;
}
// a flat arrow outline (x, v) extruded through the slab: axis 'z' -> v = local Y, thickness along Z;
// axis 'y' -> v = local Z, thickness along Y. Split into the shaft quad and the head triangle.
function arrowPrism(L, pts, t0, t1, axis) {
  const P = (x, v, s) => axis === 'z' ? [x, v, s] : [x, s, v];
  const out = (x, v, s) => axis === 'z' ? [x, v, s] : [x, s, v];
  const shaft = [pts[0], pts[1], pts[5], pts[6]], head = [pts[2], pts[3], pts[4]];
  for (const poly of [shaft, head]) {
    L.poly(poly.map(([x, v]) => P(x, v, t1)), out(0, 0, 1), PART.RECESS);
    L.poly(poly.map(([x, v]) => P(x, v, t0)), out(0, 0, -1), PART.RECESS);
  }
  // side walls only where the arrow stands proud of the slab (|s| > AERO.t); inside the slab they'd be hidden
  const ring = pts, cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cv = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  for (const [s0, s1] of [[t0, -AERO.t], [AERO.t, t1]]) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const m = [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cv];
    L.poly([P(a[0], a[1], s0), P(b[0], b[1], s0), P(b[0], b[1], s1), P(a[0], a[1], s1)], out(m[0], m[1], 0), PART.RECESS);
  }
}

// asset -> local-frame generator
const SPECIAL_TYPES = {
  PB_DefaultRamp: h => rampFaces(h, 'ramp'),
  PB_DefaultRampInverted: h => rampFaces(h, 'inverted'),
  PB_DefaultWedge: h => rampFaces(h, 'wedge'),
  PB_DefaultRampCorner: h => rampCornerFaces(h, false),
  PB_DefaultRampCornerInverted: h => rampCornerFaces(h, true),
  PB_DefaultRampInnerCorner: h => rampInnerCornerFaces(h, false),
  PB_DefaultRampInnerCornerInverted: h => rampInnerCornerFaces(h, true),
  PB_DefaultRampCrestCorner: crestCornerFaces,
  PB_DefaultRampCrest: crestFaces,
  PB_DefaultRampCrestEnd: crestEndFaces,
  PB_DefaultSideWedge: h => sideWedgeFaces(h, false),
  PB_DefaultSideWedgeTile: h => sideWedgeFaces(h, true),
  PB_DefaultArch: h => archFaces(h, false),
  PB_DefaultArchInverted: h => archFaces(h, true),
  PB_DefaultStudded: studdedFaces,
  PB_RoundedCap: roundedCapFaces,
  BP_RoundPlate: h => plateFaces(h, false),
  BP_SquarePlate: h => plateFaces(h, true),
  BP_SpikePlate: spikePlateFaces,
  BP_LatticeThin: latticeFaces,
  PB_PicketFence: fenceFaces,
  PB_Spike: spikeFaces,
  PB_Baguette: baguetteFaces,
  PB_AerodynamicSurface: h => aeroFaces(h, false),
  PB_AerodynamicSurfaceVertical: h => aeroFaces(h, true),
};
function isSpecial(name) { return Object.prototype.hasOwnProperty.call(SPECIAL_TYPES, name); }
// asset: a SPECIAL_TYPES name; half: local half-extents [X, Y, Z] in Brickadia units; o: orientation byte.
// Returns the mesh in the unit box of its world bounds plus size (viewer units, for uScale) and worldHalf.
function specialMesh(asset, half, o = 16) {
  const gen = SPECIAL_TYPES[asset];
  if (!gen) throw new Error('unknown special shape ' + asset);
  return localMesh(gen(half.slice()), half, o, { asset });
}

// A plain unit box (36 vertices, PART.PLAIN), for side-by-side comparisons.
function boxMesh() {
  const B = new Builder(1), s = 0.5, c = [0, 0, 0];
  const v = (x, y, z) => [x * s, y * s, z * s];
  const faces = [
    [v(1,-1,-1), v(1,1,-1), v(1,1,1), v(1,-1,1)], [v(-1,-1,-1), v(-1,1,-1), v(-1,1,1), v(-1,-1,1)],
    [v(-1,1,-1), v(1,1,-1), v(1,1,1), v(-1,1,1)], [v(-1,-1,-1), v(1,-1,-1), v(1,-1,1), v(-1,-1,1)],
    [v(-1,-1,1), v(1,-1,1), v(1,1,1), v(-1,1,1)], [v(-1,-1,-1), v(1,-1,-1), v(1,1,-1), v(-1,1,-1)],
  ];
  for (const f of faces) B.poly(f, c, 0, PART.PLAIN);
  return B.finish([1, 1, 1]);
}

// --- Orientation helpers (upright / upside-down orientation bytes, dir << 2 | rot) ---
// Crest: symmetric along its run, so only the run axis matters. Local X is the run (sizes in the
// saves: half X 5 or 10 = 1 or 2 studs run, half Y = width).
function crestDir(o) { return { run: (o & 3) & 1 }; }
// Crest End: run axis as above, plus which way along the width the closed end is (A8).
function crestEndDir(o) {
  const rot = o & 3;
  return { run: rot & 1, closed: [-1, 1, 1, -1][rot] };
}
function isRound(name) { return Object.prototype.hasOwnProperty.call(ROUND_TYPES, name); }

// Pack a mesh into one Float32Array: stride 7 floats (28 bytes: pos3 nrm3 flag1, same as rampBuffer),
// or with extras = true stride 12 floats (48 bytes: pos3 nrm3 flag1 part1 cap4).
function interleave(mesh, extras = false) {
  const st = extras ? 12 : 7, out = new Float32Array(mesh.count * st);
  for (let i = 0; i < mesh.count; i++) {
    const o = i * st;
    out[o] = mesh.positions[3*i]; out[o+1] = mesh.positions[3*i+1]; out[o+2] = mesh.positions[3*i+2];
    out[o+3] = mesh.normals[3*i]; out[o+4] = mesh.normals[3*i+1]; out[o+5] = mesh.normals[3*i+2];
    out[o+6] = mesh.flags[i];
    if (extras) { out[o+7] = mesh.parts[i]; for (let k = 0; k < 4; k++) out[o+8+k] = mesh.caps[4*i+k]; }
  }
  return out;
}

const api = {
  STUD, UNIT, MICRO, PLATE, PART, ROUND_TYPES, OPEN_QUESTIONS,
  ROUND_SEGMENTS, ROUND_SEGMENTS_2X2, ROUND_SEGMENTS_4X4, ROUND_UNDER_RIM, ROUND_STUD_DIAMETER, ROUND_STUD_HEIGHT, CONE_TOP_STUD_SCALE,
  CREST_LIP, CREST_PEAK_FLAT, CREST_END_PITCH,
  MICRO_TYPES, MICRO_ROUND_SEGMENTS, MICRO_SLOPE_TEXTURE,
  roundMesh, crestMesh, crestEndMesh, boxMesh, crestDir, crestEndDir, isRound, interleave,
  microMesh, isMicro, brickOrient, microRoundSegments,
  SPECIAL_TYPES, RAMP_CREST, RAMP_LIP, ARCH_LEG, ARCH_CROWN, CAP_SEGMENTS, PLATE_SEGMENTS,
  specialMesh, isSpecial, localMesh, LocalBuilder,
};
return api;
})();
