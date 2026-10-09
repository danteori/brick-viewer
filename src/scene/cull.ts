// Hidden-face and hidden-brick culling (S-02). Pure data: no rendering,
// no scene state, so it can run in a worker.
//
// Rule (conservative, exact on integer Brickadia units):
//   - Only OCCLUDERS take part: opaque full boxes (plain stud bricks, tiles, smooth tiles,
//     microbricks) on integer coordinates. Glass, translucent, glow, hologram and every non-box
//     shape (ramps, rounds, wedges, the micro family, PB_DefaultStudded with its side studs...)
//     never cover anything, and their own faces are never culled.
//   - An occluder's face is hidden when the union of the opposing, exactly coplanar faces of other
//     occluders in the SAME grid covers it completely. Partial cover never hides a face.
//   - A brick with all six faces hidden is fully hidden (not drawn at all).
// Coverage is tested exactly: the neighbours' rectangles are clipped to the face and the union's
// area (a sweep over the clipped rectangles with a segment tree) must equal the face's area.
//
// Output: masks[i] holds bit f set when face f of brick i is hidden, faces in the order
// +X, -X, +Y, -Y, +Z, -Z (bit 0..5), plus FULLY_HIDDEN (bit 6) when all six are.
//
// Spatial lookup: every occluder face goes into a hash of 2D cells keyed by (face direction, grid,
// plane, cell u, cell v). A face query looks up the opposite direction in the same plane, so only
// exactly coplanar opposing faces are ever visited. Cells come in levels 4x apart (32, 128, 512...
// units): a face goes to the finest level where it spans at most 4 cells per axis, so baseplates
// cost about as much as 1x1 bricks to store. A query looks in every level in use.

import { worldHalf } from '../core/orient.ts';

export const FACE_PX = 1, FACE_NX = 2, FACE_PY = 4, FACE_NY = 8, FACE_PZ = 16, FACE_NZ = 32;
export const ALL_FACES = 63;
export const FULLY_HIDDEN = 64;

/** One brick as the culler sees it, in integer Brickadia units (grid-local). */
export interface CullBrick {
  /** centre */
  pos: readonly [number, number, number];
  /** world half-extents, from worldHalf(orient, size) */
  half: readonly [number, number, number];
  /** 'box' for a plain box; anything else never covers and is never culled */
  shape: string;
  /** BMC_* material name (unset = plastic) */
  material?: string;
  /** grid id: only bricks in the same grid cover each other (unset = the main grid) */
  grid?: string | number;
  /** the brick fills its whole box with flat faces */
  fullBox: boolean;
}

/** Materials whose faces are opaque. Anything else (glass, translucent, glow, hologram, unknown) never covers. */
export const OPAQUE_MATERIALS: ReadonlySet<string> = new Set(['BMC_Plastic', 'BMC_Metallic']);

/**
 * Procedural assets that are plain full boxes with flat faces (studs, bevels and the underside are
 * normal maps in the game, not geometry). PB_DefaultStudded is left out on purpose: its side studs
 * count as not coverable, so it takes no part.
 */
export const FULL_BOX_ASSETS: ReadonlySet<string> = new Set(['PB_DefaultBrick', 'PB_DefaultTile', 'PB_DefaultSmoothTile', 'PB_DefaultMicroBrick']);

/** A save brick (PlainBrick-like: asset, local size or null, centre, orientation byte, material) -> CullBrick. */
export function cullBrickOf(b: { asset: string; size: readonly [number, number, number] | null; pos: readonly [number, number, number]; orient: number; material?: string }, grid?: string | number): CullBrick {
  const box = b.size !== null && FULL_BOX_ASSETS.has(b.asset);
  return { pos: b.pos, half: b.size ? worldHalf(b.orient, b.size) : [0, 0, 0], shape: box ? 'box' : b.asset, material: b.material, grid, fullBox: box };
}

const LIM = 1 << 29;
const okInt = (v: number): boolean => Number.isInteger(v) && v > -LIM && v < LIM;

/** Does this brick cover neighbours (and can its own faces be culled)? */
export function isOccluder(b: CullBrick): boolean {
  if (!b.fullBox || b.shape !== 'box' || !OPAQUE_MATERIALS.has(b.material ?? 'BMC_Plastic')) return false;
  for (let i = 0; i < 3; i++) {
    const h = b.half[i]!, p = b.pos[i]!;
    if (!(h > 0) || !okInt(p - h) || !okInt(p + h)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Growable typed arrays and hashing

type I32 = Int32Array<ArrayBuffer>;

function growI32(a: I32, n: number): I32 {
  if (n <= a.length) return a;
  const b = new Int32Array(Math.max(n, a.length * 2, 16));
  b.set(a);
  return b;
}

function mix(h: number, x: number): number {
  h = Math.imul(h ^ x, 0x9e3779b1);
  return h ^ (h >>> 15);
}

/** murmur3's finaliser: spreads every input bit over the low bits the table index uses. */
function fmix(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

// Slot layout (one cache line per probe): key = (direction | grid << 3, plane, cell u, cell v),
// then the slot's first entry. Entry layout: brick, its version when inserted, next entry.
const SLOT = 5, HEAD = 4, ENTRY = 3;

/** Open-addressing hash of 2D face cells -> linked lists of (brick, version) entries. */
class FaceTable {
  cap = 0;
  slots = new Int32Array(0);
  used = 0;
  ent: I32;
  eCount = 0;
  readonly shift: number;

  constructor(shift: number, expectKeys: number, expectEntries: number) {
    this.shift = shift;
    this.alloc(Math.max(16, expectKeys * 2));
    this.ent = new Int32Array(Math.max(16, expectEntries) * ENTRY);
  }

  private alloc(want: number): void {
    let cap = 16;
    while (cap < want) cap *= 2;
    this.cap = cap; this.used = 0;
    this.slots = new Int32Array(cap * SLOT);
    for (let s = HEAD; s < this.slots.length; s += SLOT) this.slots[s] = -1;
  }

  /** The slot offset of a key, or -1 (find) / a new slot (insert). */
  slot(dg: number, p: number, u: number, v: number, insert: boolean): number {
    const m = this.cap - 1, S = this.slots;
    let s = fmix(mix(mix(mix(mix(0x2545f491, dg), p), u), v)) & m;
    for (;;) {
      const o = s * SLOT;
      if (S[o + HEAD] === -1) {
        if (!insert) return -1;
        S[o] = dg; S[o + 1] = p; S[o + 2] = u; S[o + 3] = v;
        this.used++;
        return o;
      }
      if (S[o] === dg && S[o + 1] === p && S[o + 2] === u && S[o + 3] === v) return o;
      s = (s + 1) & m;
    }
  }

  private rehash(): void {
    const { cap, slots } = this;
    this.alloc(cap * 2);
    for (let o = 0; o < cap * SLOT; o += SLOT) {
      if (slots[o + HEAD] === -1) continue;
      this.slots[this.slot(slots[o]!, slots[o + 1]!, slots[o + 2]!, slots[o + 3]!, true) + HEAD] = slots[o + HEAD]!;
    }
  }

  add(dg: number, p: number, u: number, v: number, brick: number, ver: number): void {
    if ((this.used + 1) * 2 > this.cap) this.rehash();
    const o = this.slot(dg, p, u, v, true), e = this.eCount++;
    if ((e + 1) * ENTRY > this.ent.length) this.ent = growI32(this.ent, (e + 1) * ENTRY);
    const E = this.ent, w = e * ENTRY;
    E[w] = brick; E[w + 1] = ver; E[w + 2] = this.slots[o + HEAD]!; this.slots[o + HEAD] = e;
  }
}

/** Options: the finest cell size is 2^cellShift units (default 32). */
export interface CullOptions { cellShift?: number }

/** Face counts: faces of all bricks (6 each) and the hidden ones. */
export interface CullStats { bricks: number; occluders: number; faces: number; hiddenFaces: number; hiddenBricks: number }

// the two in-plane axes of each face axis
const UA = [1, 2, 0], VA = [2, 0, 1];
const MAX_LEVEL = 7;
/** Cells one face query may visit per level; past that the level is skipped (conservative). */
const QUERY_CELLS = 4096;

/**
 * Hidden-face masks for a set of bricks, kept up to date through set() + updateAround().
 * Brick ids are indexes into the array given to the constructor (set() with id === count appends).
 */
export class FaceCuller {
  /** per brick: hidden-face bits (FACE_*) | FULLY_HIDDEN */
  masks: Uint8Array;
  private n = 0;
  private box: I32;          // 6 per brick: lo x y z, hi x y z
  private gr: I32;           // grid index, -1 = removed
  private occ: Uint8Array;          // 1 = occluder
  private ver: I32;          // bumped on every set(); stale table entries carry an older one
  private stamp: I32;
  private q = 0;
  private gridIds = new Map<string | number, number>();
  private levels: FaceTable[] = [];
  private readonly shift: number;
  private readonly expect: number;
  private pending = new Set<number>();
  // scratch for coverage tests
  private rect = new Int32Array(64);
  private cand = new Int32Array(16);

  constructor(bricks: readonly CullBrick[], opts: CullOptions = {}) {
    const N = bricks.length, shift = opts.cellShift ?? 5;
    this.masks = new Uint8Array(N); this.box = new Int32Array(N * 6);
    this.gr = new Int32Array(N); this.occ = new Uint8Array(N); this.ver = new Int32Array(N); this.stamp = new Int32Array(N);
    this.shift = shift; this.expect = N;
    this.n = N;
    for (let i = 0; i < N; i++) { this.write(i, bricks[i]!); if (this.occ[i]) this.insert(i); }
    this.computeAll();
  }

  get count(): number { return this.n; }

  private gridIndex(g: string | number | undefined): number {
    const k = g ?? 1;
    let v = this.gridIds.get(k);
    if (v === undefined) { v = this.gridIds.size; this.gridIds.set(k, v); }
    return v;
  }

  private write(i: number, b: CullBrick | null): void {
    const o = i * 6;
    this.occ[i] = b && isOccluder(b) ? 1 : 0;
    for (let a = 0; a < 3; a++) {
      // non-occluders keep their (rounded) box only to find the neighbours of an edit
      this.box[o + a] = b ? Math.round(b.pos[a]! - b.half[a]!) : 0;
      this.box[o + 3 + a] = b ? Math.round(b.pos[a]! + b.half[a]!) : 0;
    }
    this.gr[i] = b ? this.gridIndex(b.grid) : -1;
  }

  /** The table for faces up to `extent` units across (created on first use). */
  private level(extent: number): FaceTable {
    let L = 0;
    while (L < MAX_LEVEL && extent > 4 << (this.shift + 2 * L)) L++;
    while (this.levels.length <= L) {
      const k = this.levels.length;
      this.levels.push(new FaceTable(this.shift + 2 * k, k ? 16 : this.expect * 2, k ? 16 : this.expect * 12));
    }
    return this.levels[L]!;
  }

  /** Puts brick i's six faces into the tables. */
  private insert(i: number): void {
    const B = this.box, o = i * 6, g = this.gr[i]! << 3, ver = this.ver[i]!;
    for (let f = 0; f < 6; f++) {
      const a = f >> 1, ua = UA[a]!, va = VA[a]!;
      const p = B[o + (f & 1 ? a : a + 3)]!;
      const u0 = B[o + ua]!, u1 = B[o + 3 + ua]!, v0 = B[o + va]!, v1 = B[o + 3 + va]!;
      const T = this.level(Math.max(u1 - u0, v1 - v0)), s = T.shift;
      for (let cu = u0 >> s, cu1 = (u1 - 1) >> s; cu <= cu1; cu++)
        for (let cv = v0 >> s, cv1 = (v1 - 1) >> s; cv <= cv1; cv++) T.add(f | g, p, cu, cv, i, ver);
    }
  }

  /**
   * Finds every occluder j != i in brick i's grid whose face opposite face f lies in the plane of
   * i's face f and overlaps it with positive area. Their ids go to cand[0..k) and their rectangles,
   * clipped to the face, to rect (u0, u1, v0, v1 each); returns k. With `early`, returns -1 as soon
   * as one of them covers the whole face.
   */
  private gather(i: number, f: number, early: boolean): number {
    const B = this.box, o = i * 6, a = f >> 1, ua = UA[a]!, va = VA[a]!, g = this.gr[i]!;
    if (g < 0) return 0;
    const p = B[o + (f & 1 ? a : a + 3)]!, dg = (f ^ 1) | g << 3;
    const u0 = B[o + ua]!, u1 = B[o + 3 + ua]!, v0 = B[o + va]!, v1 = B[o + 3 + va]!;
    if (u1 <= u0 || v1 <= v0) return 0;
    const q = ++this.q, st = this.stamp, ver = this.ver;
    let k = 0;
    for (let t = 0; t < this.levels.length; t++) {
      const T = this.levels[t]!, s = T.shift;
      if (!T.used) continue;
      // a huge face (a baseplate) over a fine level: rather than visit thousands of cells, skip the
      // level (fewer candidates can only hide less). Neighbour searches for edits look everywhere.
      if (early && (((u1 - 1) >> s) - (u0 >> s) + 1) * (((v1 - 1) >> s) - (v0 >> s) + 1) > QUERY_CELLS) continue;
      const S = T.slots, E = T.ent;
      for (let cu = u0 >> s, cu1 = (u1 - 1) >> s; cu <= cu1; cu++)
        for (let cv = v0 >> s, cv1 = (v1 - 1) >> s; cv <= cv1; cv++) {
          const sl = T.slot(dg, p, cu, cv, false);
          if (sl < 0) continue;
          for (let e = S[sl + HEAD]!; e >= 0; e = E[e * ENTRY + 2]!) {
            const j = E[e * ENTRY]!;
            if (j === i || st[j] === q || E[e * ENTRY + 1] !== ver[j]) continue;
            st[j] = q;
            const oj = j * 6;
            const a0 = Math.max(u0, B[oj + ua]!), a1 = Math.min(u1, B[oj + 3 + ua]!), b0 = Math.max(v0, B[oj + va]!), b1 = Math.min(v1, B[oj + 3 + va]!);
            if (a1 <= a0 || b1 <= b0) continue;
            if (early && a0 === u0 && a1 === u1 && b0 === v0 && b1 === v1) return -1;
            if (k >= this.cand.length) { this.cand = growI32(this.cand, k + 1); this.rect = growI32(this.rect, this.cand.length * 4); }
            const r = this.rect, w = k * 4;
            this.cand[k] = j; r[w] = a0; r[w + 1] = a1; r[w + 2] = b0; r[w + 3] = b1;
            k++;
          }
        }
    }
    return k;
  }

  /** Is face f of occluder i fully covered? */
  private faceHidden(i: number, f: number): boolean {
    const k = this.gather(i, f, true);
    if (k < 0) return true;
    if (k === 0) return false;
    const B = this.box, o = i * 6, a = f >> 1, ua = UA[a]!, va = VA[a]!;
    const v0 = B[o + va]!, v1 = B[o + 3 + va]!, r = this.rect, area = (B[o + 3 + ua]! - B[o + ua]!) * (v1 - v0);
    let sum = 0;
    for (let x = 0; x < k; x++) sum += (r[x * 4 + 1]! - r[x * 4]!) * (r[x * 4 + 3]! - r[x * 4 + 2]!);
    if (sum < area) return false;                   // can't cover even without overlaps
    return unionArea(r, k, v0, v1) === area;
  }

  private computeMask(i: number): void {
    if (!this.occ[i]) { this.masks[i] = 0; return; }
    let m = 0;
    for (let f = 0; f < 6; f++) if (this.faceHidden(i, f)) m |= 1 << f;
    this.masks[i] = m === ALL_FACES ? m | FULLY_HIDDEN : m;
  }

  /** Recomputes every mask. */
  computeAll(): void { for (let i = 0; i < this.n; i++) this.computeMask(i); }

  /** Every brick touching brick i's faces (coplanar, opposing, positive overlap) in its current place. */
  private neighbours(i: number, out: Set<number>): void {
    for (let f = 0; f < 6; f++) for (let x = 0, k = this.gather(i, f, false); x < k; x++) out.add(this.cand[x]!);
  }

  /**
   * Replaces brick id (id === count appends a new brick; null removes it, keeping its id as an
   * empty slot). Masks aren't recomputed until updateAround(): the bricks it used to touch are
   * remembered and recomputed then too.
   */
  set(id: number, b: CullBrick | null): void {
    if (id > this.n || id < 0) throw new RangeError(`brick id ${id} out of range`);
    if (id === this.n) this.grow(id + 1);
    else this.neighbours(id, this.pending);
    this.ver[id] = this.ver[id]! + 1;            // drops its old table entries
    this.write(id, b);
    if (this.occ[id]) this.insert(id);
    this.pending.add(id);
  }

  private grow(n: number): void {
    if (n > this.masks.length) {
      const c = Math.max(n, this.masks.length * 2, 16);
      const m = new Uint8Array(c); m.set(this.masks); this.masks = m;
      const oc = new Uint8Array(c); oc.set(this.occ); this.occ = oc;
      this.box = growI32(this.box, c * 6);
      this.gr = growI32(this.gr, c); this.ver = growI32(this.ver, c); this.stamp = growI32(this.stamp, c);
    }
    this.n = n;
  }

  /**
   * Recomputes the masks of the given (edited) bricks, the bricks they touch now, and the bricks
   * they touched before their last set(). Returns the ids whose mask changed.
   */
  updateAround(ids: Iterable<number>): number[] {
    const todo = this.pending;
    this.pending = new Set();
    for (const i of ids) if (i >= 0 && i < this.n) todo.add(i);
    const edited = Array.from(todo);
    for (let k = 0; k < edited.length; k++) this.neighbours(edited[k]!, todo);
    const changed: number[] = [];
    for (const i of todo) {
      const before = this.masks[i];
      this.computeMask(i);
      if (this.masks[i] !== before) changed.push(i);
    }
    return changed;
  }

  /** Totals over the current masks. */
  stats(): CullStats {
    let occluders = 0, hiddenFaces = 0, hiddenBricks = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.occ[i]) occluders++;
      const m = this.masks[i]!;
      if (m & FULLY_HIDDEN) hiddenBricks++;
      for (let f = 0; f < 6; f++) if (m & (1 << f)) hiddenFaces++;
    }
    return { bricks: this.n, occluders, faces: this.n * 6, hiddenFaces, hiddenBricks };
  }
}

// ---------------------------------------------------------------------------------------------
// Exact union area of k rectangles [u0,u1)x[v0,v1) (4 ints each in r) inside the v range [v0, v1):
// a sweep along u with a segment tree over the distinct v edges.

let evU = new Float64Array(0), evI = new Int32Array(0), vs = new Float64Array(0), cnt = new Int32Array(0), len = new Float64Array(0);

function unionArea(r: I32, k: number, v0: number, v1: number): number {
  if (evU.length < k * 2) { evU = new Float64Array(k * 4); evI = new Int32Array(k * 4); }
  if (vs.length < k * 2 + 2) vs = new Float64Array(k * 4 + 4);
  // distinct v coordinates
  let m = 0;
  vs[m++] = v0; vs[m++] = v1;
  for (let i = 0; i < k; i++) { vs[m++] = r[i * 4 + 2]!; vs[m++] = r[i * 4 + 3]!; }
  const V = vs.subarray(0, m).sort();
  let w = 0;
  for (let i = 0; i < m; i++) if (i === 0 || V[i] !== V[w - 1]) V[w++] = V[i]!;
  const nv = w;
  if (cnt.length < nv * 4) { cnt = new Int32Array(nv * 4); len = new Float64Array(nv * 4); }
  cnt.fill(0, 0, nv * 4); len.fill(0, 0, nv * 4);
  // events: start (+) and end (-) of each rectangle along u, sorted by u
  for (let i = 0; i < k; i++) { evU[i * 2] = r[i * 4]!; evI[i * 2] = i + 1; evU[i * 2 + 1] = r[i * 4 + 1]!; evI[i * 2 + 1] = -(i + 1); }
  const ne = k * 2, ord = new Array<number>(ne);
  for (let i = 0; i < ne; i++) ord[i] = i;
  ord.sort((x, y) => evU[x]! - evU[y]!);
  const vIndex = (v: number): number => {           // binary search in V[0..nv)
    let a = 0, b = nv - 1;
    while (a < b) { const c = (a + b) >> 1; if (V[c]! < v) a = c + 1; else b = c; }
    return a;
  };
  let area = 0, prevU = evU[ord[0]!]!;
  for (let e = 0; e < ne; e++) {
    const x = ord[e]!, u = evU[x]!, id = evI[x]!, ri = (Math.abs(id) - 1) * 4;
    area += len[1]! * (u - prevU);
    prevU = u;
    update(1, 0, nv - 1, vIndex(r[ri + 2]!), vIndex(r[ri + 3]!), id > 0 ? 1 : -1, V);
  }
  return area;
}

/** Segment tree over elementary v intervals [V[l], V[r]) for node (l, r); adds d on [a, b). */
function update(node: number, l: number, rr: number, a: number, b: number, d: number, V: Float64Array): void {
  if (b <= l || rr <= a || rr - l < 1) return;
  if (a <= l && rr <= b) cnt[node] = cnt[node]! + d;
  else {
    const mid = (l + rr) >> 1;
    if (rr - l > 1) { update(node * 2, l, mid, a, b, d, V); update(node * 2 + 1, mid, rr, a, b, d, V); }
  }
  if (cnt[node]! > 0) len[node] = V[rr]! - V[l]!;
  else len[node] = rr - l > 1 ? len[node * 2]! + len[node * 2 + 1]! : 0;
}
