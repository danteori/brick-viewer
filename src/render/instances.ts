// Chunked instanced bodies (ARCHITECTURE.md 3.1 / 4). The scene is cut into render chunks of
// CHUNK units (independent of the save's 2048-unit chunks); each chunk keeps, per mesh, one vertex
// array object over its own instance buffer of 24-byte records (layout in shaders/brick.ts):
//
//   0  iPos   int16 x3 + spare   centre relative to the chunk's centre, units
//   8  iHalf  uint16 x3 + word   local half-extents, units; word = orientation, top, micro, linear
//  16  iColor uint8 x4           R, G, B as stored, intensity
//  20  iMisc  uint8 x4           face mask, material, variant, flags (bit 0 selected)
//
// A draw gets uChunkOffset = chunk centre - render origin, computed in doubles, so positions stay
// exact far from the origin. An edit re-packs only the chunks it touched (scene/sync.ts hands the
// changed rows on); chunks outside the view are skipped.
//
// Left out of the buffers: the focused brick (drawn live from constants, first, as the legacy
// viewer drew brick 0 first) and hidden rows (a selection being moved: the ghost shows them).
// Glass / translucent / glow bricks go in groups of their own per (material, mesh), which
// render/matpass.ts draws with drawSpecial (translucent ones sorted back to front per chunk).
// iMisc.x is the hidden-face mask (render/facecull.ts) for cube meshes; fully hidden rows are left out.

import { S } from '../app/state.ts';
import { LOC } from './gl.ts';
import { G, bindMesh } from './draw.ts';
import { BOX_MESH, boxIB, meshOf, type Mesh } from './meshes/registry.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { viewDir } from './camera.ts';
import { addMirror } from '../scene/sync.ts';
import { ASSETS, F_LINEAR, MATERIALS, worldHalfOf, type SceneStore } from '../scene/store.ts';
import { topOf } from '../scene/view.ts';
import { MAT_GLOW, MAT_TRANSLUCENT, matCode } from './matcode.ts';
import { FULLY_HIDDEN } from '../scene/cull.ts';

/** Render chunk size, units (about 50 studs). */
export const CHUNK = 1024;
export const REC = 24;

interface Group { mesh: Mesh; vao: WebGLVertexArrayObject; buf: WebGLBuffer; n: number; cap: number }
/** material code (matcode.ts) -> mesh -> group */
type SpecialGroups = Map<number, Map<Mesh, Group>>;
interface RChunk {
  /** chunk centre, units */
  c: [number, number, number];
  ids: Set<number>;
  groups: Map<Mesh, Group>;
  dirty: boolean;
  /** world box of what it holds, units (for culling) */
  box: [number, number, number, number, number, number];
  /** lowest brick bottom in it (units), Infinity when empty */
  minZ: number;
  /** glass / translucent / glow rows (drawn by matpass) */
  special: number[];
  /** the special rows' instance groups */
  sgroups: SpecialGroups;
  /** translucent rows per mesh, and the view direction they were last sorted for */
  trans: Map<Mesh, number[]>;
  sortEye: [number, number, number];
}

/** The word bits of an asset (top style, micro), cached by asset table index. */
const assetWord: number[] = [];
const wordOf = (a: number): number => {
  let w = assetWord[a];
  if (w === undefined) { const t = topOf(ASSETS.name(a)); w = assetWord[a] = (t.top << 5) | (t.micro ? 128 : 0); }
  return w;
};
const matOf: number[] = [];
const materialCode = (m: number): number => (matOf[m] ??= matCode({ material: MATERIALS.name(m) }));

/**
 * The render chunks of one store. `opts.offset` (units, doubles) shifts the whole set (a dynamic
 * grid's origin); `opts.scene` = it mirrors the scene (focus, hidden rows and selection apply).
 */
export class ChunkSet {
  chunks = new Map<string, RChunk>();
  private rowChunk: (RChunk | undefined)[] = [];
  /** bumped whenever instance data changed */
  rev = 0;
  special: number[] = [];
  /** special rows per material code (index = MAT_*) */
  matCount = [0, 0, 0, 0];
  private specialDirty = true;
  /** lowest brick bottom except the focused one (units), Infinity when none */
  minZ = Infinity;
  /** box around every chunk (units, without the offset); lo > hi when empty */
  bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  private focus = -1;

  constructor(public store: SceneStore, readonly opts: { scene: boolean; offset?: [number, number, number] } = { scene: true }) {
    this.reset(store);
  }

  reset(s: SceneStore): void {
    for (const ch of this.chunks.values()) this.drop(ch);
    this.chunks.clear(); this.rowChunk = []; this.store = s;
    for (const id of s.ids()) this.place(id);
    this.specialDirty = true; this.rev++;
  }

  private keyOf(id: number): [string, [number, number, number]] {
    const s = this.store, k = [Math.floor(s.px[id]! / CHUNK), Math.floor(s.py[id]! / CHUNK), Math.floor(s.pz[id]! / CHUNK)];
    return [k.join('_'), [k[0]! * CHUNK + CHUNK / 2, k[1]! * CHUNK + CHUNK / 2, k[2]! * CHUNK + CHUNK / 2]];
  }

  /** puts live row id into its chunk (marking old and new dirty) */
  private place(id: number): void {
    const old = this.rowChunk[id];
    if (!this.store.alive(id)) {
      if (old) { old.ids.delete(id); old.dirty = true; this.rowChunk[id] = undefined; }
      return;
    }
    const [key, c] = this.keyOf(id);
    let ch = this.chunks.get(key);
    if (!ch) { ch = { c, ids: new Set(), groups: new Map(), dirty: true, box: [0, 0, 0, 0, 0, 0], minZ: Infinity, special: [], sgroups: new Map(), trans: new Map(), sortEye: [0, 0, 0] }; this.chunks.set(key, ch); }
    if (old && old !== ch) { old.ids.delete(id); old.dirty = true; }
    ch.ids.add(id); ch.dirty = true;
    this.rowChunk[id] = ch;
  }

  changed(ids: ReadonlySet<number>): void { for (const id of ids) this.place(id); }

  /** marks row id's chunk dirty (focus / selection / hidden changes) */
  touch(id: number): void { const ch = this.rowChunk[id]; if (ch) ch.dirty = true; }

  /** re-packs dirty chunks (once a frame, before drawing) */
  sync(): void {
    if (this.opts.scene && this.focus !== S.sel) { this.touch(this.focus); this.touch(S.sel); this.focus = S.sel; }
    let any = false;
    for (const [key, ch] of this.chunks) {
      if (!ch.dirty) continue;
      any = true;
      if (!ch.ids.size) { this.drop(ch); this.chunks.delete(key); continue; }
      this.pack(ch);
    }
    if (any) {
      this.rev++; this.specialDirty = true;
      let m = Infinity;
      const B = this.bounds;
      B[0] = B[1] = B[2] = Infinity; B[3] = B[4] = B[5] = -Infinity;
      for (const ch of this.chunks.values()) {
        m = Math.min(m, ch.minZ);
        for (let i = 0; i < 3; i++) { B[i] = Math.min(B[i]!, ch.box[i]!); B[i + 3] = Math.max(B[i + 3]!, ch.box[i + 3]!); }
      }
      this.minZ = m;
    }
    if (this.specialDirty) {
      this.special = [];
      const mc = this.matCount, s = this.store;
      mc.fill(0);
      for (const ch of this.chunks.values()) for (const id of ch.special) { this.special.push(id); mc[materialCode(s.material[id]!)]!++; }
      this.specialDirty = false;
    }
  }

  private drop(ch: RChunk): void {
    const gl = G.gl;
    for (const g of ch.groups.values()) { gl.deleteBuffer(g.buf); gl.deleteVertexArray(g.vao); }
    for (const m of ch.sgroups.values()) for (const g of m.values()) { gl.deleteBuffer(g.buf); gl.deleteVertexArray(g.vao); }
    ch.groups.clear(); ch.sgroups.clear(); ch.trans.clear();
  }

  private pack(ch: RChunk): void {
    const s = this.store, scene = this.opts.scene, sel = scene ? S.sel : -1;
    const hidden = scene ? S.hidden : null;
    const lists = new Map<Mesh, number[]>(), slists = new Map<number, Map<Mesh, number[]>>();
    const box = ch.box;
    box[0] = box[1] = box[2] = Infinity; box[3] = box[4] = box[5] = -Infinity;
    ch.minZ = Infinity; ch.special = [];
    for (const id of ch.ids) {
      const o = s.orient[id]!, h = worldHalfOf(o, s.hx[id]!, s.hy[id]!, s.hz[id]!);
      const x = s.px[id]!, y = s.py[id]!, z = s.pz[id]!;
      box[0] = Math.min(box[0], x - h[0]); box[1] = Math.min(box[1], y - h[1]); box[2] = Math.min(box[2], z - h[2]);
      box[3] = Math.max(box[3], x + h[0]); box[4] = Math.max(box[4], y + h[1]); box[5] = Math.max(box[5], z + h[2]);
      if (id === sel) continue;
      ch.minZ = Math.min(ch.minZ, z - h[2]);
      if (hidden && hidden.size && hidden.has(id)) continue;
      if (s.faceMask[id]! & FULLY_HIDDEN) continue;           // covered on all six sides (render/facecull.ts)
      const mesh = meshOf(s.shape[id]!, ASSETS.name(s.asset[id]!), s.hx[id]!, s.hy[id]!, s.hz[id]!);
      const m = scene ? materialCode(s.material[id]!) : 0;   // extras draw every brick as plastic, as before
      let into = lists;
      if (m > 0) {
        ch.special.push(id);
        let sl = slists.get(m);
        if (!sl) slists.set(m, (sl = new Map()));
        into = sl;
      }
      let l = into.get(mesh);
      if (!l) into.set(mesh, (l = []));
      l.push(id);
    }
    // groups: re-use a mesh's buffer and vertex array when it is still there
    this.fill(ch, ch.groups, lists);
    for (const [m, groups] of ch.sgroups) if (!slists.has(m)) { this.fill(ch, groups, new Map()); ch.sgroups.delete(m); }
    for (const [m, l] of slists) {
      let groups = ch.sgroups.get(m);
      if (!groups) ch.sgroups.set(m, (groups = new Map()));
      if (m === MAT_TRANSLUCENT) { for (const ids of l.values()) sortBackToFront(s, ids); ch.sortEye = eyeOf(); }
      this.fill(ch, groups, l);
    }
    ch.trans = slists.get(MAT_TRANSLUCENT) ?? new Map();
    ch.dirty = false;
  }

  /** Makes `groups` hold exactly `lists` (mesh -> rows, in draw order), re-using buffers. */
  private fill(ch: RChunk, groups: Map<Mesh, Group>, lists: Map<Mesh, number[]>): void {
    const gl = G.gl;
    for (const [mesh, g] of groups) if (!lists.has(mesh)) { gl.deleteBuffer(g.buf); gl.deleteVertexArray(g.vao); groups.delete(mesh); }
    for (const [mesh, ids] of lists) {
      let g = groups.get(mesh);
      if (!g) {
        g = { mesh, vao: gl.createVertexArray()!, buf: gl.createBuffer()!, n: 0, cap: 0 };
        groups.set(mesh, g);
        gl.bindVertexArray(g.vao);
        bindMesh(mesh);
        if (mesh === BOX_MESH) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
        instancePointers(gl);
        gl.bindVertexArray(null);
      }
      this.upload(ch, g, ids);
    }
  }

  /** Writes rows `ids` (all in chunk ch) into group g's buffer, in that order. */
  private upload(ch: RChunk, g: Group, ids: readonly number[]): void {
    const gl = G.gl, s = this.store, selection = this.opts.scene ? S.selection : null, box = g.mesh === BOX_MESH;
    const data = new ArrayBuffer(ids.length * REC), i16 = new Int16Array(data), u16 = new Uint16Array(data), u32 = new Uint32Array(data), u8 = new Uint8Array(data);
    for (let j = 0; j < ids.length; j++) {
      const id = ids[j]!, b = j * REC, w = j * 12;
      i16[w] = s.px[id]! - ch.c[0]; i16[w + 1] = s.py[id]! - ch.c[1]; i16[w + 2] = s.pz[id]! - ch.c[2]; i16[w + 3] = 0;
      u16[w + 4] = s.hx[id]!; u16[w + 5] = s.hy[id]!; u16[w + 6] = s.hz[id]!;
      u16[w + 7] = s.orient[id]! | wordOf(s.asset[id]!) | (s.flags[id]! & F_LINEAR ? 256 : 0);
      u32[(b + 16) >> 2] = s.color[id]!;
      u8[b + 20] = box ? s.faceMask[id]! & 63 : 0; u8[b + 21] = s.material[id]!; u8[b + 22] = 0; u8[b + 23] = selection && selection.has(id) ? 1 : 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
    if (ids.length > g.cap) { g.cap = Math.max(ids.length, g.cap * 2); gl.bufferData(gl.ARRAY_BUFFER, g.cap * REC, gl.DYNAMIC_DRAW); }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(data));
    g.n = ids.length;
  }

  /** Is chunk ch (its box) in the view? */
  private visible(ch: RChunk, cull: ViewCull): boolean {
    const b = ch.box, off = this.opts.offset;
    const ox = off ? off[0] : 0, oy = off ? off[1] : 0, oz = off ? off[2] : 0;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let c = 0; c < 8; c++) {
      const X = ((c & 1 ? b[3] : b[0]) + ox) * BRZ_UNIT - S.origin[0], Y = ((c & 2 ? b[4] : b[1]) + oy) * BRZ_UNIT - S.origin[1], Z = ((c & 4 ? b[5] : b[2]) + oz) * BRZ_UNIT - S.origin[2];
      const v = viewDir(X, Y, Z), m = S.view, d = m[2]! * X + m[6]! * Z + m[10]! * Y;
      x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); z0 = Math.min(z0, d); z1 = Math.max(z1, d);
    }
    return x1 >= cull.x0 && x0 <= cull.x1 && y1 >= cull.y0 && y0 <= cull.y1 && z1 >= -cull.depth && z0 <= cull.depth;
  }

  /** Draws every visible chunk (the brick program's uniforms set; uBox off). */
  draw(cull: ViewCull | null): void {
    const gl = G.gl, u = G.u, o = S.origin, off = this.opts.offset;
    gl.uniform4f(u.uBox, 0, 0, 0, 0);
    for (const ch of this.chunks.values()) {
      if (!ch.groups.size || (cull && !this.visible(ch, cull))) continue;
      stats.chunks++;
      const cx = ch.c[0] + (off ? off[0] : 0), cy = ch.c[1] + (off ? off[1] : 0), cz = ch.c[2] + (off ? off[2] : 0);
      gl.uniform3f(u.uChunkOffset, cx * BRZ_UNIT - o[0], cz * BRZ_UNIT - o[2], cy * BRZ_UNIT - o[1]);
      for (const g of ch.groups.values()) {
        if (!g.n) continue;
        gl.bindVertexArray(g.vao);
        stats.draws++; stats.instances += g.n;
        if (g.mesh === BOX_MESH) gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, g.n);
        else gl.drawArraysInstanced(gl.TRIANGLES, 0, g.mesh.count, g.n);
      }
    }
    gl.bindVertexArray(null);
  }

  /**
   * Draws the special rows of material `m` in every visible chunk (the caller sets the material
   * uniforms, with uIntensity < 0 so each instance's own intensity is used). `sorted`: chunks back
   * to front, each chunk's rows re-sorted when the view has turned (translucent plastic).
   */
  drawSpecial(m: number, cull: ViewCull | null, sorted = false): void {
    if (!this.matCount[m]) return;
    const gl = G.gl, u = G.u, o = S.origin, off = this.opts.offset;
    const list: RChunk[] = [];
    for (const ch of this.chunks.values()) if (ch.sgroups.has(m) && (!cull || this.visible(ch, cull))) list.push(ch);
    if (!list.length) return;
    if (sorted) {
      const e = eyeOf();
      for (const ch of list) {
        if (ch.sortEye[0] === e[0] && ch.sortEye[1] === e[1] && ch.sortEye[2] === e[2]) continue;
        const groups = ch.sgroups.get(m)!;
        for (const [mesh, ids] of ch.trans) { sortBackToFront(this.store, ids); const g = groups.get(mesh); if (g) this.upload(ch, g, ids); }
        ch.sortEye = e;
      }
      const d = (ch: RChunk): number => ch.c[0] * e[0] + ch.c[2] * e[1] + ch.c[1] * e[2];
      list.sort((a, b) => d(a) - d(b));
    }
    gl.uniform4f(u.uBox, 0, 0, 0, 0);
    for (const ch of list) {
      const cx = ch.c[0] + (off ? off[0] : 0), cy = ch.c[1] + (off ? off[1] : 0), cz = ch.c[2] + (off ? off[2] : 0);
      gl.uniform3f(u.uChunkOffset, cx * BRZ_UNIT - o[0], cz * BRZ_UNIT - o[2], cy * BRZ_UNIT - o[1]);
      for (const g of ch.sgroups.get(m)!.values()) {
        if (!g.n) continue;
        gl.bindVertexArray(g.vao);
        stats.draws++; stats.instances += g.n;
        if (g.mesh === BOX_MESH) gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, g.n);
        else gl.drawArraysInstanced(gl.TRIANGLES, 0, g.mesh.count, g.n);
      }
    }
    gl.bindVertexArray(null);
  }

  /** The farthest any chunk reaches along the view axis from the render origin (viewer units), 0 when empty. */
  depthReach(): number {
    const b = this.bounds, off = this.opts.offset, m = S.view;
    if (!(b[0]! <= b[3]!)) return 0;
    let r = 0;
    for (let c = 0; c < 8; c++) {
      const X = ((c & 1 ? b[3]! : b[0]!) + (off ? off[0] : 0)) * BRZ_UNIT - S.origin[0], Y = ((c & 2 ? b[4]! : b[1]!) + (off ? off[1] : 0)) * BRZ_UNIT - S.origin[1];
      const Z = ((c & 4 ? b[5]! : b[2]!) + (off ? off[2] : 0)) * BRZ_UNIT - S.origin[2];
      r = Math.max(r, Math.abs(m[2]! * X + m[6]! * Z + m[10]! * Y));
    }
    return r;
  }

  /** Frees every buffer. */
  dispose(): void { for (const ch of this.chunks.values()) this.drop(ch); this.chunks.clear(); }
}

/** The view direction toward the camera (GL x, y, z = world X, Z, Y), as matpass sorts by. */
const eyeOf = (): [number, number, number] => [S.view[2]!, S.view[6]!, S.view[10]!];

/** Sorts rows farthest first along the view direction (centres). */
function sortBackToFront(s: SceneStore, ids: number[]): void {
  const e = eyeOf();
  const d = (id: number): number => s.px[id]! * e[0] + s.pz[id]! * e[1] + s.py[id]! * e[2];
  ids.sort((a, b) => d(a) - d(b));
}

/** The 24-byte record's attribute pointers on the bound buffer (instanced). */
function instancePointers(gl: WebGL2RenderingContext): void {
  gl.enableVertexAttribArray(LOC.iPos); gl.vertexAttribIPointer(LOC.iPos, 4, gl.SHORT, REC, 0); gl.vertexAttribDivisor(LOC.iPos, 1);
  gl.enableVertexAttribArray(LOC.iHalf); gl.vertexAttribIPointer(LOC.iHalf, 4, gl.UNSIGNED_SHORT, REC, 8); gl.vertexAttribDivisor(LOC.iHalf, 1);
  gl.enableVertexAttribArray(LOC.iColor); gl.vertexAttribPointer(LOC.iColor, 4, gl.UNSIGNED_BYTE, true, REC, 16); gl.vertexAttribDivisor(LOC.iColor, 1);
  gl.enableVertexAttribArray(LOC.iMisc); gl.vertexAttribIPointer(LOC.iMisc, 4, gl.UNSIGNED_BYTE, REC, 20); gl.vertexAttribDivisor(LOC.iMisc, 1);
}

/** The view rectangle (view-plane coords, relative to the render origin) and depth half-range. */
export interface ViewCull { x0: number; x1: number; y0: number; y1: number; depth: number }

/** Per-frame counters (test hook / benchmark): chunks and instanced draws drawn, instances in them. */
export const stats = { chunks: 0, draws: 0, instances: 0 };

/** The scene's chunks and what the rest of the renderer reads from them. */
export const inst = {
  set: null as ChunkSet | null,
  /** glass / translucent / glow bricks (not the focused one): drawn by matpass.ts */
  special: [] as number[],
  /** lowest brick bottom except the focused one (absolute viewer units), for the ground grid */
  groundAbs: Infinity,
  /** bumped whenever the instance data changed (hover re-pick key) */
  rev: 0,
  /** the view rectangle of the frame being drawn (set by drawInstances; matpass culls with it) */
  cull: null as ViewCull | null,
};

export function initInstances(): void {
  inst.set = new ChunkSet(S.scene);
  addMirror({
    reset: (s) => { inst.set!.reset(s); },
    changed: (_s, ids) => { inst.set!.changed(ids); },
  });
}

/** marks row id's chunk for re-packing (selection or hidden state changed) */
export const markBrick = (id: number): void => { inst.set?.touch(id); };

/** bring the buffers up to date with the scene (once a frame, before drawing) */
export function syncInstances(): void {
  const set = inst.set!;
  stats.chunks = stats.draws = stats.instances = 0;
  set.sync();
  inst.special = set.special;
  inst.groundAbs = set.minZ * BRZ_UNIT;
  inst.rev = set.rev;
}

/** Draw every brick: the focused one first (drawFocus, from constants), then the chunks. */
export function drawInstances(drawFocus: () => void, cull: ViewCull | null = null): void {
  const gl = G.gl;
  inst.cull = cull;
  drawFocus();
  inst.set!.draw(cull);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
}

export { MAT_GLOW };
