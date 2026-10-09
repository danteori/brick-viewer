// The SceneStore (ARCHITECTURE.md section 4): every brick of the scene as SoA typed arrays, in
// integer Brickadia units (stud 10, plate 4, micro 2), with stable ids and a free list.
//
// A brick's id is its row. Deleting frees the row (pushed on the free list); placing takes the most
// recently freed row first, else a new one. Undo and redo put a brick back under the SAME id: the
// history is linear, so by the time a delete is undone every later edit (which might have reused
// the row) has been undone too.
//
// Rows hold what a save holds: centre, local half-extents, orientation byte, asset, colour bytes as
// stored (COLOR_LINEAR marks the linear bytes of saves from before CL14860, so re-saving is exact),
// material, owners and brick flags. Everything the viewer derives (box faces, shape kind, top style,
// ramp direction...) comes from functions (src/scene/brick.ts brickView). String columns (asset,
// material, flag field and grid names) are indices into tables shared by every store, so a
// BrickRecord (src/scene/record.ts) means the same in any store: the clipboard and the undo history
// rely on that.
//
// Changes are collected in `changed` (ids) until a consumer drains them (scene/sync.ts: the render
// chunks and the pick grid), so a store never knows about the renderer.

/** Shape kinds (the `shape` column). Box = every plain cuboid: bricks, plates, tiles, microbricks. */
export const enum Kind { Box = 0, Ramp = 1, Crest = 2, CrestEnd = 3, Round = 4, Special = 5, Micro = 6 }

/** Bits of the `flags` column. */
export const F_ALIVE = 1, F_LINEAR = 2, F_HAS_FLAGS = 4;
/** `origOwner` value meaning "the same as owner". */
export const SAME_OWNER = 0xffff;

/** A string table shared by every store (asset, material, flag field and grid names). */
export class Names {
  readonly list: string[] = [];
  private readonly map = new Map<string, number>();
  constructor(first: string[] = []) { for (const s of first) this.id(s); }
  id(s: string): number {
    let i = this.map.get(s);
    if (i === undefined) { i = this.list.length; this.list.push(s); this.map.set(s, i); }
    return i;
  }
  name(i: number): string { return this.list[i] ?? ''; }
}

export const ASSETS = new Names(['PB_DefaultBrick']);
export const MATERIALS = new Names(['BMC_Plastic']);
/** Brick flag fields (BRSavedBitFlags in the chunk schema, e.g. collision flags), at most 16. */
export const FLAG_NAMES = new Names();
export const GRIDS = new Names(['1']);

const grow = <T extends Int32Array | Uint16Array | Uint8Array | Uint32Array | Float64Array>(a: T, n: number): T => {
  const b = new (a.constructor as new (n: number) => T)(n);
  b.set(a);
  return b;
};

export class SceneStore {
  /** rows allocated so far (the high-water mark); ids are 0 .. n-1 */
  n = 0;
  /** live bricks */
  count = 0;
  private cap: number;
  px: Int32Array; py: Int32Array; pz: Int32Array;
  hx: Uint16Array; hy: Uint16Array; hz: Uint16Array;
  orient: Uint8Array;
  asset: Uint16Array;
  shape: Uint8Array;
  /** R | G << 8 | B << 16 | A << 24, as stored (A = material intensity 0-10) */
  color: Uint32Array;
  material: Uint8Array;
  owner: Uint16Array;
  origOwner: Uint16Array;
  /** brick flag fields that are 0 (bit i = FLAG_NAMES i); only meaningful with F_HAS_FLAGS */
  collision: Uint16Array;
  flags: Uint8Array;
  /** hidden faces (Phase 3; 0 = all drawn) */
  faceMask: Uint8Array;
  grid: Uint16Array;
  /** index in the save as loaded (load order), -1 for a brick placed in the viewer */
  srcOrder: Int32Array;
  /** list order: bricks sort by it (load order, then placement order); undo restores it */
  order: Float64Array;
  nextOrder = 0;
  /** the brick flag fields (FLAG_NAMES ids) of the save this store was loaded from */
  flagFields: number[] = [];
  private free: number[] = [];
  /** ids changed since the last drain (added, removed or edited) */
  changed = new Set<number>();
  /** bumped on every change */
  rev = 0;

  constructor(cap = 64) {
    this.cap = Math.max(1, cap);
    const c = this.cap;
    this.px = new Int32Array(c); this.py = new Int32Array(c); this.pz = new Int32Array(c);
    this.hx = new Uint16Array(c); this.hy = new Uint16Array(c); this.hz = new Uint16Array(c);
    this.orient = new Uint8Array(c); this.asset = new Uint16Array(c); this.shape = new Uint8Array(c);
    this.color = new Uint32Array(c); this.material = new Uint8Array(c);
    this.owner = new Uint16Array(c); this.origOwner = new Uint16Array(c); this.collision = new Uint16Array(c);
    this.flags = new Uint8Array(c); this.faceMask = new Uint8Array(c); this.grid = new Uint16Array(c);
    this.srcOrder = new Int32Array(c); this.order = new Float64Array(c);
  }

  private ensure(n: number): void {
    if (n <= this.cap) return;
    let c = this.cap;
    while (c < n) c *= 2;
    this.cap = c;
    this.px = grow(this.px, c); this.py = grow(this.py, c); this.pz = grow(this.pz, c);
    this.hx = grow(this.hx, c); this.hy = grow(this.hy, c); this.hz = grow(this.hz, c);
    this.orient = grow(this.orient, c); this.asset = grow(this.asset, c); this.shape = grow(this.shape, c);
    this.color = grow(this.color, c); this.material = grow(this.material, c);
    this.owner = grow(this.owner, c); this.origOwner = grow(this.origOwner, c); this.collision = grow(this.collision, c);
    this.flags = grow(this.flags, c); this.faceMask = grow(this.faceMask, c); this.grid = grow(this.grid, c);
    this.srcOrder = grow(this.srcOrder, c); this.order = grow(this.order, c);
  }

  /** Bytes held by the columns (for the undo history's byte cap). */
  get bytes(): number { return this.cap * 48; }

  alive(id: number): boolean { return id >= 0 && id < this.n && (this.flags[id]! & F_ALIVE) !== 0; }

  /** A fresh row (the most recently freed one first); the caller fills it, then calls touch. */
  alloc(): number {
    let id = -1;
    while (this.free.length) {
      const f = this.free.pop()!;
      if (!this.alive(f)) { id = f; break; }            // stale entry: that row was revived by an undo
    }
    if (id < 0) { this.ensure(this.n + 1); id = this.n++; }
    this.clearRow(id);
    this.flags[id] = F_ALIVE; this.count++;
    this.order[id] = this.nextOrder++;
    this.srcOrder[id] = -1;
    this.origOwner[id] = SAME_OWNER;
    return id;
  }

  /** Makes row `id` live again (an undo restoring a brick under its old id); the caller fills it. */
  revive(id: number): void {
    if (this.alive(id)) return;
    this.ensure(id + 1);
    while (this.n <= id) { this.flags[this.n] = 0; this.free.push(this.n); this.n++; }
    this.flags[id] = F_ALIVE; this.count++;
  }

  remove(id: number): void {
    if (!this.alive(id)) return;
    this.flags[id] = 0; this.count--;
    this.free.push(id);
    this.touch(id);
  }

  touch(id: number): void { this.changed.add(id); this.rev++; }

  private clearRow(id: number): void {
    this.px[id] = 0; this.py[id] = 0; this.pz[id] = 0; this.hx[id] = 0; this.hy[id] = 0; this.hz[id] = 0;
    this.orient[id] = 16; this.asset[id] = 0; this.shape[id] = 0; this.color[id] = 0; this.material[id] = 0;
    this.owner[id] = 0; this.origOwner[id] = SAME_OWNER; this.collision[id] = 0; this.flags[id] = 0;
    this.faceMask[id] = 0; this.grid[id] = 0; this.srcOrder[id] = -1; this.order[id] = 0;
  }

  /** Live ids in row order. */
  *ids(): IterableIterator<number> {
    for (let id = 0; id < this.n; id++) if (this.flags[id]! & F_ALIVE) yield id;
  }

  /** Live ids in list order (load order, then placement order). */
  ordered(): number[] {
    const out: number[] = [];
    for (let id = 0; id < this.n; id++) if (this.flags[id]! & F_ALIVE) out.push(id);
    const o = this.order;
    return out.sort((a, b) => o[a]! - o[b]!);
  }

  /** The first live id in list order, or -1. */
  first(): number {
    let best = -1;
    for (let id = 0; id < this.n; id++) if ((this.flags[id]! & F_ALIVE) && (best < 0 || this.order[id]! < this.order[best]!)) best = id;
    return best;
  }

  /** World box of brick id in units: [x0, y0, z0, x1, y1, z1] into out (the orientation applied). */
  box(id: number, out: number[] | Float64Array = new Array(6)): number[] | Float64Array {
    const h = worldHalfOf(this.orient[id]!, this.hx[id]!, this.hy[id]!, this.hz[id]!);
    out[0] = this.px[id]! - h[0]; out[1] = this.py[id]! - h[1]; out[2] = this.pz[id]! - h[2];
    out[3] = this.px[id]! + h[0]; out[4] = this.py[id]! + h[1]; out[5] = this.pz[id]! + h[2];
    return out;
  }

  /** Drains the change set. */
  drain(): Set<number> {
    const c = this.changed;
    this.changed = new Set();
    return c;
  }
}

// --- orientation: which world axis each local axis lies along (the |M| permutation of core/orient.ts)
// AXIS[o][i] = the local axis that world axis i comes from, so worldHalf[i] = half[AXIS[o][i]].
const D: [number, number, number][] = [[2, 1, 0], [2, 1, 0], [2, 0, 1], [2, 0, 1], [0, 1, 2], [0, 1, 2]];   // world axis of local X, Y, Z per dir
export const AXIS: Uint8Array = (() => {
  const out = new Uint8Array(24 * 3);
  for (let o = 0; o < 24; o++) {
    const d = D[(o >> 2) % 6]!, odd = o & 1;
    const wx = odd ? d[1] : d[0], wy = odd ? d[0] : d[1], wz = d[2];   // a quarter turn swaps local X and Y
    out[o * 3 + wx] = 0; out[o * 3 + wy] = 1; out[o * 3 + wz] = 2;
  }
  return out;
})();

const wh: [number, number, number] = [0, 0, 0];
/** World half-extents of local half-extents (hx, hy, hz) at orientation o (a shared scratch array). */
export function worldHalfOf(o: number, hx: number, hy: number, hz: number): [number, number, number] {
  const a = o * 3, h = [hx, hy, hz];
  wh[0] = h[AXIS[a]!]!; wh[1] = h[AXIS[a + 1]!]!; wh[2] = h[AXIS[a + 2]!]!;
  return wh;
}
