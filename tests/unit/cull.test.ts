// Hidden-face culling (src/scene/cull.ts): synthetic cases and property tests against a brute-force
// per-unit-cell reference on random scenes.
import { describe, expect, it } from 'vitest';
import {
  ALL_FACES, FACE_NX, FACE_NY, FACE_NZ, FACE_PX, FACE_PY, FACE_PZ, FULLY_HIDDEN,
  FaceCuller, cullBrickOf, isOccluder, type CullBrick,
} from '../../src/scene/cull.ts';
import { brickOrient, worldHalf } from '../../src/core/orient.ts';

type V3 = [number, number, number];
const box = (pos: V3, half: V3, extra: Partial<CullBrick> = {}): CullBrick => ({ pos, half, shape: 'box', fullBox: true, ...extra });
const masksOf = (bricks: CullBrick[]): number[] => Array.from(new FaceCuller(bricks).masks);

// --- brute-force reference: every unit cell of every face, against every other brick ---
function reference(bricks: CullBrick[]): number[] {
  const lo = bricks.map((b) => b.pos.map((p, a) => p - b.half[a]!));
  const hi = bricks.map((b) => b.pos.map((p, a) => p + b.half[a]!));
  const occ = bricks.map(isOccluder);
  return bricks.map((_, i) => {
    if (!occ[i]) return 0;
    let m = 0;
    for (let f = 0; f < 6; f++) {
      const a = f >> 1, u = (a + 1) % 3, v = (a + 2) % 3, plane = f & 1 ? lo[i]![a]! : hi[i]![a]!;
      const others = bricks.map((_, j) => j).filter((j) => j !== i && occ[j] && (bricks[j]!.grid ?? 1) === (bricks[i]!.grid ?? 1)
        && (f & 1 ? hi[j]![a] === plane : lo[j]![a] === plane));
      let all = true;
      for (let x = lo[i]![u]!; x < hi[i]![u]! && all; x++)
        for (let y = lo[i]![v]!; y < hi[i]![v]! && all; y++)
          if (!others.some((j) => lo[j]![u]! <= x && x < hi[j]![u]! && lo[j]![v]! <= y && y < hi[j]![v]!)) all = false;
      if (all) m |= 1 << f;
    }
    return m === ALL_FACES ? m | FULLY_HIDDEN : m;
  });
}

// small deterministic PRNG
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function randomScene(seed: number, n: number): CullBrick[] {
  const r = rng(seed), I = (k: number): number => Math.floor(r() * k);
  const out: CullBrick[] = [];
  for (let i = 0; i < n; i++) {
    // half sizes 1..3, centres on a small lattice so faces often meet; even/odd mixes alignment
    const half: V3 = [1 + I(3), 1 + I(3), 1 + I(3)];
    const pos: V3 = [I(12), I(12), I(12)];
    const x = r();
    const extra: Partial<CullBrick> = x < 0.06 ? { material: 'BMC_Glass' } : x < 0.1 ? { material: 'BMC_Glow' } : x < 0.14 ? { shape: 'PB_DefaultRamp', fullBox: false }
      : x < 0.18 ? { grid: 'car' } : {};
    out.push(box(pos, half, extra));
  }
  return out;
}

describe('cull: synthetic cases', () => {
  it('two bricks side by side hide the touching faces only', () => {
    const m = masksOf([box([0, 0, 0], [5, 5, 6]), box([10, 0, 0], [5, 5, 6])]);
    expect(m).toEqual([FACE_PX, FACE_NX]);
  });

  it('a solid cube keeps only its outer faces', () => {
    const n = 5, bricks: CullBrick[] = [];
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) bricks.push(box([x * 10, y * 10, z * 12], [5, 5, 6]));
    const c = new FaceCuller(bricks), s = c.stats();
    expect(s.faces - s.hiddenFaces).toBe(6 * n * n);
    expect(s.hiddenBricks).toBe((n - 2) ** 3);
    bricks.forEach((b, i) => {
      const inner = b.pos.every((p, a) => p > 0 && p < (n - 1) * (a === 2 ? 12 : 10));
      expect(!!(c.masks[i]! & FULLY_HIDDEN)).toBe(inner);
    });
    expect(c.masks).toEqual(new Uint8Array(reference(bricks)));
  });

  it('partial cover never hides: a 2x2 top needs all four 1x1s', () => {
    const base = box([0, 0, 0], [10, 10, 6]);
    const ones = [[-5, -5], [5, -5], [-5, 5], [5, 5]].map(([x, y]) => box([x!, y!, 12], [5, 5, 6]));
    expect(masksOf([base, ...ones.slice(0, 3)])[0]).toBe(0);
    const all = masksOf([base, ...ones]);
    expect(all[0]).toBe(FACE_PZ);
    expect(all.slice(1).every((m) => m & FACE_NZ)).toBe(true);
    // a 1x1 on a 2x2: the 1x1's bottom is hidden, the 2x2's top isn't
    expect(masksOf([base, ones[0]!])).toEqual([0, FACE_NZ]);
    // offset by one unit past the edge: the overhang leaves the bottom visible
    expect(masksOf([base, box([6, 0, 12], [5, 5, 6])])).toEqual([0, 0]);
  });

  it('overlapping neighbours count by their union, not their sum', () => {
    // two rectangles overlapping on the face, with a gap elsewhere: area sum >= face, union < face
    const face = box([0, 0, 0], [4, 4, 1]);
    const a = box([-2, 0, 2], [2, 4, 1]), b = box([0, -2, 2], [4, 2, 1]);   // left half + bottom half
    expect(masksOf([face, a, b, box([0, -2, 2], [4, 2, 1])])[0]).toBe(0);
    const c = box([2, 2, 2], [2, 2, 1]);                                     // the missing quarter
    expect(masksOf([face, a, b, c])[0]).toBe(FACE_PZ);
  });

  it('only the same grid covers', () => {
    expect(masksOf([box([0, 0, 0], [5, 5, 6], { grid: '1' }), box([10, 0, 0], [5, 5, 6], { grid: 'door' })])).toEqual([0, 0]);
    expect(masksOf([box([0, 0, 0], [5, 5, 6], { grid: 'door' }), box([10, 0, 0], [5, 5, 6], { grid: 'door' })])).toEqual([FACE_PX, FACE_NX]);
    expect(masksOf([box([0, 0, 0], [5, 5, 6]), box([10, 0, 0], [5, 5, 6], { grid: 1 })])).toEqual([FACE_PX, FACE_NX]);  // unset = main grid
  });

  it('glass, translucent, glow and hologram never cover and are never culled', () => {
    for (const material of ['BMC_Glass', 'BMC_TranslucentPlastic', 'BMC_Glow', 'BMC_Hologram', 'BMC_SomethingNew'])
      expect(masksOf([box([0, 0, 0], [5, 5, 6]), box([10, 0, 0], [5, 5, 6], { material })]), material).toEqual([0, 0]);
    expect(masksOf([box([0, 0, 0], [5, 5, 6]), box([10, 0, 0], [5, 5, 6], { material: 'BMC_Metallic' })])).toEqual([FACE_PX, FACE_NX]);
  });

  it('non-box shapes and PB_DefaultStudded never cover', () => {
    const studded = cullBrickOf({ asset: 'PB_DefaultStudded', size: [5, 5, 6], pos: [10, 0, 0], orient: 16 });
    expect(studded.fullBox).toBe(false);
    expect(masksOf([box([0, 0, 0], [5, 5, 6]), studded])).toEqual([0, 0]);
    const ramp = cullBrickOf({ asset: 'PB_DefaultRamp', size: [5, 5, 6], pos: [10, 0, 0], orient: 16 });
    expect(masksOf([box([0, 0, 0], [5, 5, 6]), ramp])).toEqual([0, 0]);
    const round = cullBrickOf({ asset: 'B_1x1_Round', size: null, pos: [10, 0, 0], orient: 16 });
    expect(masksOf([box([0, 0, 0], [5, 5, 6]), round])).toEqual([0, 0]);
    for (const asset of ['PB_DefaultBrick', 'PB_DefaultTile', 'PB_DefaultSmoothTile', 'PB_DefaultMicroBrick'])
      expect(masksOf([box([0, 0, 0], [5, 5, 6]), cullBrickOf({ asset, size: [5, 5, 6], pos: [10, 0, 0], orient: 16 })]), asset).toEqual([FACE_PX, FACE_NX]);
  });

  it('micro-grid alignment: a stud face tiled by microbricks is hidden, one micro off is not', () => {
    // 1x1 brick (10x10x12) face +X at x = 5, tiled by 5x6 microbricks (2 units) on the other side
    const brick = box([0, 0, 0], [5, 5, 6]), micros: CullBrick[] = [];
    for (let y = -4; y <= 4; y += 2) for (let z = -5; z <= 5; z += 2) micros.push(box([6, y, z], [1, 1, 1]));
    expect(masksOf([brick, ...micros])[0]).toBe(FACE_PX);
    // drop one micro: a 2x2 hole
    expect(masksOf([brick, ...micros.slice(1)])[0]).toBe(0);
    // shift the whole micro layer by one unit in Y: the bottom row of the face is uncovered
    expect(masksOf([brick, ...micros.map((m) => box([m.pos[0], m.pos[1] + 1, m.pos[2]], [1, 1, 1]))])[0]).toBe(0);
    // shift it by one unit in X: not coplanar any more
    expect(masksOf([brick, ...micros.map((m) => box([m.pos[0] + 1, m.pos[1], m.pos[2]], [1, 1, 1]))])[0]).toBe(0);
    // odd micro centres (bricks on the 1-unit grid): exact union, 1-unit strips
    const strips = [-4.5, -3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5, 4.5].map((y) => box([6, y, 0], [1, 0.5, 6]));
    expect(masksOf([brick, ...strips])[0]).toBe(FACE_PX);
  });

  it('non-integer boxes take no part', () => {
    expect(masksOf([box([0, 0, 0], [5, 5, 6]), box([10, 0.5, 0.5], [5, 6, 7])])).toEqual([0, 0]);
  });

  it('all 24 orientations: the box and each face bit follow worldHalf', () => {
    const size: V3 = [10, 5, 3];                      // asymmetric, so every orientation differs
    for (let o = 0; o < 24; o++) {
      const centre = cullBrickOf({ asset: 'PB_DefaultBrick', size, pos: [0, 0, 0], orient: o });
      const h = worldHalf(o, size);
      expect(centre.half).toEqual(h);
      // a same-oriented neighbour on each world side, one side at a time
      const bits = [FACE_PX, FACE_NX, FACE_PY, FACE_NY, FACE_PZ, FACE_NZ];
      for (let f = 0; f < 6; f++) {
        const a = f >> 1, s = f & 1 ? -1 : 1, pos: V3 = [0, 0, 0];
        pos[a] = s * 2 * h[a]!;
        const nb = cullBrickOf({ asset: 'PB_DefaultBrick', size, pos, orient: o });
        expect(masksOf([centre, nb]), `o=${o} f=${f}`).toEqual([bits[f], bits[f ^ 1]]);
      }
      // the local +Z (stud) face: a plate on top in local space hides exactly that world face
      const M = brickOrient(o), z = [M[0][2], M[1][2], M[2][2]], a = z.findIndex((c) => c), f = a * 2 + (z[a]! > 0 ? 0 : 1);
      const pos: V3 = [0, 0, 0];
      pos[a] = z[a]! * (size[2] + 1);
      const plate = cullBrickOf({ asset: 'PB_DefaultBrick', size: [size[0], size[1], 1], pos, orient: o });
      expect(masksOf([centre, plate])[0], `o=${o} stud face`).toBe(bits[f]);
    }
  });
});

describe('cull: property tests against the brute-force reference', () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`random scene ${seed}`, () => {
      const bricks = randomScene(seed, 40 + seed * 4);
      expect(masksOf(bricks)).toEqual(reference(bricks));
    });
  }

  it('small cell size and huge faces in the big table agree too', () => {
    const r = rng(99), bricks = randomScene(7, 150);
    bricks.push(box([6, 6, -40], [200, 200, 20]));        // a baseplate under everything
    bricks.push(box([6, 6, 60], [300, 2, 2]));             // a long beam
    for (let i = 0; i < 40; i++) bricks.push(box([Math.floor(r() * 400 - 200), Math.floor(r() * 400 - 200), -19], [1 + Math.floor(r() * 3), 1 + Math.floor(r() * 3), 1]));
    const ref = reference(bricks);
    for (const cellShift of [0, 2, 4, 6]) expect(Array.from(new FaceCuller(bricks, { cellShift }).masks), `shift ${cellShift}`).toEqual(ref);
  });
});

describe('cull: huge faces', () => {
  it('stacked baseplates hide each other even with small bricks around', () => {
    const lower = box([0, 0, 0], [5000, 5000, 2]), upper = box([0, 0, 4], [5000, 5000, 2]);
    const small = [box([0, 0, 12], [5, 5, 6]), box([20, 0, 12], [5, 5, 6])];
    const m = masksOf([lower, upper, ...small]);
    expect(m[0]).toBe(FACE_PZ);
    expect(m[1]).toBe(FACE_NZ);                 // its top is far too big for 1x1s to cover: visible
    expect(m[2]! & FACE_NZ).toBeTruthy();       // the 1x1s still sit on it
  });
});

describe('cull: incremental updates', () => {
  it('moving, removing and adding bricks matches a fresh build', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed * 31), bricks = randomScene(seed, 80), c = new FaceCuller(bricks), live = bricks.slice() as (CullBrick | null)[];
      for (let step = 0; step < 25; step++) {
        const ids: number[] = [];
        for (let e = 0, ne = 1 + Math.floor(r() * 3); e < ne; e++) {
          const x = r(), id = x < 0.15 ? live.length : Math.floor(r() * live.length);
          const nb = x < 0.25 && id < live.length ? null : randomScene(seed * 1000 + step * 10 + e, 1)[0]!;
          c.set(id, nb);
          if (id === live.length) live.push(nb); else live[id] = nb;
          ids.push(id);
        }
        c.updateAround(ids);
        // removed bricks are empty slots: compare with the reference on the live ones
        const present = live.map((b, i) => [b, i] as const).filter(([b]) => b) as [CullBrick, number][];
        const ref = reference(present.map(([b]) => b));
        expect(present.map(([, i]) => c.masks[i]), `seed ${seed} step ${step}`).toEqual(ref);
        for (let i = 0; i < live.length; i++) if (!live[i]) expect(c.masks[i]).toBe(0);
      }
    }
  });

  it('updateAround returns the bricks whose mask changed', () => {
    const c = new FaceCuller([box([0, 0, 0], [5, 5, 6]), box([10, 0, 0], [5, 5, 6])]);
    c.set(1, box([30, 0, 0], [5, 5, 6]));
    expect(c.updateAround([1]).sort()).toEqual([0, 1]);
    expect(Array.from(c.masks)).toEqual([0, 0]);
    c.set(1, box([0, 0, 12], [5, 5, 6]));
    expect(c.updateAround([1]).sort()).toEqual([0, 1]);
    expect(Array.from(c.masks)).toEqual([FACE_PZ, FACE_NZ]);
    c.set(1, { ...box([0, 0, 12], [5, 5, 6]), material: 'BMC_Glass' });
    expect(c.updateAround([1]).sort()).toEqual([0, 1]);
    expect(() => c.set(5, null)).toThrow(RangeError);
  });
});
