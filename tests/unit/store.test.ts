// Phase 2 data model (ARCHITECTURE.md section 4) and orientation in the shader (3.1):
//  - the SceneStore's ids, free list and records;
//  - rows <-> editor bricks agree with the loader's own conversion;
//  - a local mesh turned by the shader's orientation matrix is the very mesh the Phase 1 renderer
//    built per orientation (same triangles), for every shape family and orientation it drew.
import { describe, expect, it } from 'vitest';
import { worldHalf, brickOrient } from '../../src/core/orient.ts';
import { AXIS, F_LINEAR, SceneStore, worldHalfOf } from '../../src/scene/store.ts';
import { packRecords, readRecord, REC_BYTES, writeRecord } from '../../src/scene/record.ts';
import { addBrick, brickView, kindOf, plainOf, putPlain, writeBrick } from '../../src/scene/view.ts';
import { viewerBrick } from '../../src/scene/load.ts';
import { rampDir } from '../../src/scene/brick.ts';
import { rampMesh } from '../../src/render/meshes/ramp.ts';
import { BrickShapes, type ShapeMesh } from '../../src/render/meshes/shapes.js';
import type { PlainBrick } from '../../src/format/world.ts';

describe('SceneStore', () => {
  it('maps orientation bytes to world half-extents like core/orient.ts', () => {
    expect(AXIS.length).toBe(72);
    for (let o = 0; o < 24; o++) {
      const h: [number, number, number] = [3, 7, 11];
      expect([...worldHalfOf(o, 3, 7, 11)]).toEqual(worldHalf(o, h));
    }
  });

  it('keeps ids stable: a deleted row is reused last-in first-out, and an undo can revive it', () => {
    const s = new SceneStore(2);
    const a = s.alloc(), b = s.alloc(), c = s.alloc();
    expect([a, b, c]).toEqual([0, 1, 2]);
    s.remove(b);
    expect(s.alive(b)).toBe(false);
    expect(s.count).toBe(2);
    s.revive(b);                                   // an undo puts it back under the same id
    expect(s.alive(b)).toBe(true);
    const d = s.alloc();                           // the free list's stale entry is skipped
    expect(d).toBe(3);
    s.remove(a); s.remove(c);
    expect(s.alloc()).toBe(c);
    expect(s.alloc()).toBe(a);
    expect(s.ordered()).toEqual([b, d, c, a].sort((x, y) => s.order[x]! - s.order[y]!));
  });

  it('round-trips a row through a 48-byte record', () => {
    const s = new SceneStore();
    const id = s.alloc();
    putPlain(s, id, { asset: 'PB_DefaultRamp', size: [20, 10, 6], pos: [-4000, 70000, 12], orient: 21, color: [9, 99, 199, 7], material: 'BMC_Glow', owner: 3, originalOwner: 4, flags: { CollisionFlags_Player: 0, bVisibility: 1 }, seq: 12 }, true);
    const rec = packRecords(s, [id]);
    expect(rec.length).toBe(REC_BYTES);
    const t = new SceneStore();
    t.flagFields = s.flagFields;
    readRecord(t, 5, new DataView(rec.buffer), 0, kindOf);
    expect(t.alive(5)).toBe(true);
    const back = new Uint8Array(REC_BYTES);
    writeRecord(t, 5, new DataView(back.buffer));
    expect([...back]).toEqual([...rec]);
    const { linear: _l, ...pb } = plainOf(t, 5);
    expect(pb).toMatchObject({ asset: 'PB_DefaultRamp', size: [20, 10, 6], pos: [-4000, 70000, 12], orient: 21, color: [9, 99, 199, 7], material: 'BMC_Glow', owner: 3, originalOwner: 4, seq: 12 });
    expect(pb.flags?.CollisionFlags_Player).toBe(0);
  });
});

const SYNTH: PlainBrick[] = [
  { asset: 'PB_DefaultBrick', size: [10, 20, 6], pos: [5, 10, 6], orient: 17, color: [250, 64, 64, 5], material: 'BMC_Plastic' },
  { asset: 'PB_DefaultMicroBrick', size: [1, 1, 1], pos: [101, 101, 1], orient: 20, color: [1, 2, 3, 5], material: 'BMC_Plastic' },
  { asset: 'PB_DefaultRamp', size: [20, 10, 6], pos: [200, 0, 6], orient: 18, color: [9, 99, 199, 9], material: 'BMC_Plastic' },
  { asset: 'PB_DefaultRamp', size: [20, 10, 6], pos: [200, 300, 6], orient: 9, color: [9, 99, 199, 5], material: 'BMC_Plastic' },
  { asset: 'PB_DefaultSmoothTile', size: [5, 5, 2], pos: [5, 205, 2], orient: 2, color: [77, 77, 77, 5], material: 'BMC_Glass' },
  { asset: 'PB_DefaultTile', size: [5, 5, 2], pos: [5, 405, 2], orient: 9, color: [77, 7, 77, 5], material: 'BMC_Plastic' },
  { asset: 'B_1x1_Round', size: null, pos: [3005, 5, 6], orient: 13, color: [0, 255, 0, 5], material: 'BMC_Plastic' },
  { asset: 'PB_DefaultMicroWedge', size: [5, 3, 2], pos: [55, 5, 6], orient: 6, color: [0, 25, 0, 5], material: 'BMC_Plastic' },
  { asset: 'PB_DefaultRampCrestEnd', size: [10, 5, 6], pos: [655, 5, 6], orient: 23, color: [0, 25, 70, 5], material: 'BMC_Plastic' },
];

describe('rows <-> editor bricks', () => {
  it('reads a row exactly as the loader reads the save brick', () => {
    for (const lin of [false, true]) {
      const s = new SceneStore();
      for (const pb of SYNTH) {
        const id = s.alloc();
        putPlain(s, id, pb, lin);
        const want = viewerBrick(pb, lin);
        expect(brickView(s, id)).toEqual(want);
      }
    }
  });

  it('writing an unchanged brick back leaves the row byte-identical (linear colours and turned boxes too)', () => {
    for (const lin of [false, true]) {
      const s = new SceneStore();
      for (const pb of SYNTH) {
        const id = s.alloc();
        putPlain(s, id, { ...pb, seq: 3 }, lin);
        const before = packRecords(s, [id]);
        writeBrick(s, id, brickView(s, id));
        expect([...packRecords(s, [id])]).toEqual([...before]);
      }
    }
  });

  it('a changed colour is stored as sRGB bytes; a moved brick keeps its other fields', () => {
    const s = new SceneStore(), id = s.alloc();
    putPlain(s, id, SYNTH[2]!, true);
    const b = brickView(s, id);
    b.color = [1, 0.5, 0];
    b.lo = b.lo.map((v, i) => (i === 0 ? +(v + 0.2).toFixed(3) : v)) as typeof b.lo; b.hi = b.hi.map((v, i) => (i === 0 ? +(v + 0.2).toFixed(3) : v)) as typeof b.hi;
    writeBrick(s, id, b);
    expect(s.flags[id]! & F_LINEAR).toBe(0);
    expect(s.color[id]! & 0xffffff).toBe(255 | (128 << 8));
    expect(s.color[id]! >>> 24).toBe(9);
    expect([s.px[id], s.py[id], s.pz[id]]).toEqual([210, 0, 6]);
    expect(s.orient[id]).toBe(18);
  });

  it('adds new bricks from editor records', () => {
    const s = new SceneStore();
    const id = addBrick(s, { lo: [0, 0, 0], hi: [0.4, 0.2, 0.24], micro: false, color: [1, 0, 0], up: 1 });
    expect([s.hx[id], s.hy[id], s.hz[id]]).toEqual([10, 5, 6]);
    expect([s.px[id], s.py[id], s.pz[id]]).toEqual([10, 5, 6]);
    expect(s.srcOrder[id]).toBe(-1);
    expect(brickView(s, id)).toMatchObject({ lo: [0, 0, 0], hi: [0.4, 0.2, 0.24], up: 1, top: 'studs', material: 'BMC_Plastic', intensity: 5 });
  });
});

// --- orientation in the shader: the turned local mesh == the Phase 1 per-orientation mesh -------
/** the shader's orientGL: GL-axis rotation of an orientation byte */
function orientGL(o: number): number[][] {
  const M = brickOrient(o), p = [0, 2, 1];
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => M[p[i]!]![p[j]!]!));
}
/**
 * The surface of a unit-box mesh scaled by GL size, optionally turned: per plane (normal and
 * offset) its corner points and its area. Turning a mesh can split a quad along the other diagonal,
 * which draws the same, so triangles themselves aren't compared.
 */
function triangles(pos: Float32Array, count: number, stride: number, size: number[], R?: number[][]): string[] {
  const r = (x: number): string => (Math.round(x * 1e4) / 1e4 + 0).toFixed(4);
  const planes = new Map<string, { pts: Set<string>; area: number }>();
  for (let t = 0; t < count / 3; t++) {
    const w: number[][] = [];
    for (let k = 0; k < 3; k++) {
      const o = (3 * t + k) * stride, v = [pos[o]! * size[0]!, pos[o + 1]! * size[1]!, pos[o + 2]! * size[2]!];
      w.push(R ? [0, 1, 2].map((i) => R[i]![0]! * v[0]! + R[i]![1]! * v[1]! + R[i]![2]! * v[2]!) : v);
    }
    const a = w[0]!, b = w[1]!, c = w[2]!, u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!], L = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (L < 1e-12) continue;
    const nn = n.map((x) => x / L), s = Math.sign(nn.find((x) => Math.abs(x) > 1e-6)!);   // unsigned normal: the winding may differ
    const key = nn.map((x) => r(x * s)).join(',') + '@' + r(s * (nn[0]! * a[0]! + nn[1]! * a[1]! + nn[2]! * a[2]!));
    const p = planes.get(key) ?? { pts: new Set<string>(), area: 0 };
    for (const q of w) p.pts.add(q.map(r).join(','));
    p.area += L / 2;
    planes.set(key, p);
  }
  return [...planes].map(([k, p]) => `${k} ${r(p.area)} ${[...p.pts].sort().join(' ')}`).sort();
}
const gl3 = (v: readonly number[]): number[] => [v[0]!, v[2]!, v[1]!];
const UNIT = 0.02;

describe('orientation matrices reproduce the Phase 1 meshes', () => {
  const ups = [16, 17, 18, 19, 20, 21, 22, 23];

  it('ramps (every upright / upside-down orientation)', () => {
    const half: [number, number, number] = [20, 10, 6];
    for (const o of ups) {
      const wh = worldHalf(o, half), world = wh.map((h) => 2 * h * UNIT), local = half.map((h) => 2 * h * UNIT);
      const { run, lip } = rampDir(o), up = o >> 2 === 4 ? 1 : -1;
      const legacy = triangles(rampMesh(world, run, lip, up), 48, 7, gl3(world));
      const turned = triangles(rampMesh(local, 0, 1, 1), 48, 7, gl3(local), orientGL(o));
      expect(turned, `o ${o}`).toEqual(legacy);
    }
  });

  it('crests and crest ends (upside-down crest ends at odd rotations now turn instead of mirror)', () => {
    const half: [number, number, number] = [10, 5, 6], changed: number[] = [];
    for (const o of ups) {
      const wh = worldHalf(o, half), world = wh.map((h) => 2 * h * UNIT), local = half.map((h) => 2 * h * UNIT), up = o >> 2 === 4 ? 1 : -1;
      const c = BrickShapes.crestDir(o), e = BrickShapes.crestEndDir(o);
      const lc = BrickShapes.crestMesh(world as never, c.run, up), tc = BrickShapes.crestMesh(local as never, 0, 1);
      expect(triangles(tc.positions, tc.count, 3, gl3(local), orientGL(o)), `crest o ${o}`).toEqual(triangles(lc.positions, lc.count, 3, gl3(world)));
      const le = BrickShapes.crestEndMesh(world as never, e.run, e.closed, up), te = BrickShapes.crestEndMesh(local as never, 0, -1, 1);
      const turned = triangles(te.positions, te.count, 3, gl3(local), orientGL(o)), legacy = triangles(le.positions, le.count, 3, gl3(world));
      if (JSON.stringify(turned) !== JSON.stringify(legacy)) {
        changed.push(o);
        // the old mesh was the vertical mirror, which puts the closed end on the other side
        const mirror = BrickShapes.crestEndMesh(world as never, e.run, -e.closed, up);
        expect(turned, `crest end o ${o}`).toEqual(triangles(mirror.positions, mirror.count, 3, gl3(world)));
      }
    }
    expect(changed).toEqual([21, 23]);
  });

  it('special and micro shapes (all 24 orientations)', () => {
    const cases: [string, [number, number, number], (a: string, h: [number, number, number], o: number) => ShapeMesh][] = [
      ['PB_DefaultWedge', [10, 5, 6], (a, h, o) => BrickShapes.specialMesh(a, h, o)],
      ['PB_DefaultRampCorner', [10, 10, 6], (a, h, o) => BrickShapes.specialMesh(a, h, o)],
      ['PB_DefaultArch', [5, 20, 6], (a, h, o) => BrickShapes.specialMesh(a, h, o)],
      ['PB_DefaultMicroWedge', [5, 3, 2], (a, h, o) => BrickShapes.microMesh(a, h, o)],
      ['PB_DefaultMicroRoundCorner', [5, 4, 3], (a, h, o) => BrickShapes.microMesh(a, h, o)],
    ];
    for (const [asset, half, make] of cases) {
      const local = half.map((h) => 2 * h * UNIT), lm = make(asset, half, 16);
      for (let o = 0; o < 24; o++) {
        const world = worldHalf(o, half).map((h) => 2 * h * UNIT), wm = make(asset, half, o);
        expect(triangles(lm.positions, lm.count, 3, gl3(local), orientGL(o)), `${asset} o ${o}`).toEqual(triangles(wm.positions, wm.count, 3, gl3(world)));
      }
    }
  });

  it('rounds: upright rot 0 and upside down draw the same solid; sideways ones as orientMesh did', () => {
    for (const name of ['B_1x1_Round', 'B_2x2_Cone', 'B_4x4_Round']) {
      const m = BrickShapes.roundMesh(name, 1), size = m.size;
      const up = triangles(m.positions, m.count, 3, gl3(size));
      expect(triangles(m.positions, m.count, 3, gl3(size), orientGL(16))).toEqual(up);
      // the old renderer ignored an upright round's rotation; turning it now changes nothing (the facets repeat every quarter turn)
      for (const o of [17, 18, 19]) expect(triangles(m.positions, m.count, 3, gl3(size), orientGL(o)), `${name} o ${o}`).toEqual(up);
      // the old upside-down mesh was a vertical mirror; turning 180 degrees about Y gives the same solid
      const down = BrickShapes.roundMesh(name, -1);
      expect(triangles(m.positions, m.count, 3, gl3(size), orientGL(20))).toEqual(triangles(down.positions, down.count, 3, gl3(size)));
    }
  });
});
