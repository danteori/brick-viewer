// The placement ghost: a group of brick templates (items), each with lo / hi relative to the group's
// low corner. Every frame the ghost is posed under the cursor (pose = the group's low corner,
// absolute viewer units), checked against the scene and drawn translucent, tinted red when the spot
// is taken. Ported from the legacy viewer's editor script. A big group (a pasted or moved
// selection) is drawn instanced: its items become a store of their own, drawn as render chunks
// offset by the pose.

import { S, hasFocus } from '../app/state.ts';
import { BRZ_UNIT, MICRO, PLATE, STEP, r3 } from '../core/units.ts';
import { cloneBrick, sizeRule, turnOrient, type Brick, type V3 } from '../scene/brick.ts';
import { pickRay, viewRay } from '../scene/spatial.ts';
import { itemHits } from '../scene/collision.ts';
import { SceneStore } from '../scene/store.ts';
import { addBrick } from '../scene/view.ts';
import { farOf } from '../render/camera.ts';
import { ChunkSet, inst } from '../render/instances.ts';
import { G as Gfx, drawBody, setBox } from '../render/draw.ts';
import { BOX_EDGE_COUNT, boxEB, boxIB } from '../render/meshes/registry.ts';
import { displayName } from '../ui/names.ts';
import { initAudio, playClick } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';

export interface Ghost {
  items: Brick[];
  label: string;
  mode: 'drag' | 'click';
  from: HTMLElement | null;
  dz: number;
  pose: V3 | null;
  valid: boolean;
  reason: string;
  mouse: [number, number] | null;
  over: boolean;
  visited: boolean;
  /**
   * Paste: items that would overlap a brick of their grid are dropped (skip[j]) and the rest placed;
   * the pose is refused only when none fits. Otherwise any overlap refuses the whole ghost.
   */
  drop: boolean;
  skip: boolean[];
  /** scene rows that don't block this ghost (a move: the bricks being moved) */
  ignore?: ReadonlySet<number>;
  /** placing it does this instead of adding the items (a move); returns whether it was placed */
  onPlace?: (g: Ghost) => boolean;
  /** called when the ghost goes away without being placed (a move puts the originals back) */
  onCancel?: () => void;
}

export const ed = {
  ghost: null as Ghost | null,
  lastMouse: null as [number, number] | null,
  lastOver: false,
  lastPlaceT: -1e9,
  /** the scene's ground, remembered for an empty scene (absolute) */
  groundAbs: 0,
};

/** Items above this count are drawn instanced (a store of their own) and outlined as one box. */
const BATCH_AT = 64;
let batch: { items: Brick[]; rev: number; set: ChunkSet } | null = null;
/** bumped whenever the ghost's items change in place (a turn) */
let itemsRev = 0;
function ghostBatch(items: Brick[]): ChunkSet {
  if (batch && batch.items === items && batch.rev === itemsRev) return batch.set;
  batch?.set.dispose();
  const s = new SceneStore(items.length);
  for (const t of items) addBrick(s, t);
  s.drain();
  batch = { items, rev: itemsRev, set: new ChunkSet(s, { scene: false, offset: [0, 0, 0] }) };
  return batch.set;
}

let canvas: HTMLCanvasElement;
export function initGhost(c: HTMLCanvasElement): void {
  canvas = c;
  S.hooks.placing = () => !!ed.ghost;
  S.hooks.draw.push(drawGhost);
  S.hooks.beforeLoad.push(() => endPlacing());
}

export const gsize = (items: readonly Brick[]): V3 => {
  const m: V3 = [-Infinity, -Infinity, -Infinity];
  for (const t of items) for (let i = 0; i < 3; i++) m[i] = Math.max(m[i], t.hi[i]);
  return m;
};
export const gsteps = (items: readonly Brick[]): V3 => (items.some((t) => t.micro) ? [MICRO, MICRO, MICRO] : [STEP, STEP, PLATE]);

export function itemName(t: Brick): string {
  const st = sizeRule(t).steps, n = (i: number): number => Math.round((t.hi[i] - t.lo[i]) / st[i]);
  try { return displayName(t, n(0), n(1), n(2)); } catch { return 'brick'; }
}
export const ghostName = (items: readonly Brick[]): string => (items.length === 1 ? itemName(items[0]) : `${items.length} bricks`);

export interface PlaceOpts { drop?: boolean; ignore?: ReadonlySet<number>; onPlace?: (g: Ghost) => boolean; onCancel?: () => void }

export function startPlacing(items: Brick[], label: string, mode: 'drag' | 'click', from: HTMLElement | null, opts: PlaceOpts = {}): void {
  if (S.held) return;
  endPlacing();
  ed.ghost = { items: cloneBrick(items), label, mode, from, dz: 0, pose: null, valid: false, reason: '', mouse: ed.lastMouse, over: ed.lastOver, visited: false, drop: !!opts.drop, skip: [],
    ignore: opts.ignore, onPlace: opts.onPlace, onCancel: opts.onCancel };
  document.body.classList.add('placing'); if (from) from.classList.add('on');
  initAudio();
  setStatus(`Placing ${ghostName(ed.ghost.items)}: ${mode === 'drag' ? 'release' : 'click'} in the scene to place, Esc cancels`);
}

/** Ends the ghost. `placed`: it was placed (otherwise a move puts its bricks back). */
export function endPlacing(msg?: string, placed = false): void {
  const g = ed.ghost;
  if (!g) return;
  if (g.from) g.from.classList.remove('on');
  ed.ghost = null;
  if (batch) { batch.set.dispose(); batch = null; }
  document.body.classList.remove('placing');
  if (!placed) g.onCancel?.();
  if (msg) setStatus(msg);
}

/** a quarter turn of each item's shape fields, +X toward +Y */
const ROTATE: Record<string, (t: Brick) => void> = {
  ramp: (t) => { const r = ((t.run! | 0) + (t.lip! < 0 ? 2 : 0) + 1) % 4; t.run = r & 1; t.lip = r < 2 ? 1 : -1; },
  crest: (t) => { t.run = 1 - (t.run! | 0); },
  crestEnd: (t) => {
    const C = [-1, 1, 1, -1];
    let r = [0, 1, 2, 3].find((q) => (q & 1) === (t.run! | 0) && C[q] === t.closed) ?? 0;
    r = (r + 1) % 4; t.run = r & 1; t.closed = C[r];
  },
  // the export-measured shapes and sideways rounds carry their orientation byte: turn it about world Z
  special: (t) => { t.o = turnOrient(t.o!); },
  micro: (t) => { t.o = turnOrient(t.o!); },
  round: (t) => { if (t.o != null) t.o = turnOrient(t.o); },
};
/** a sideways brick's stud side turns with it: +X -> +Y -> -X -> -Y */
const turnSide = (s: number): number => (({ 2: 3, 3: -2, [-2]: -3, [-3]: 2 } as Record<number, number>)[s] ?? s);

export function rotateItems(items: Brick[], turns: number): void {
  itemsRev++;
  for (let n = 0; n < ((turns % 4) + 4) % 4; n++) {
    for (const t of items) {
      const l = t.lo, h = t.hi;
      t.lo = [-h[1], l[0], l[2]]; t.hi = [-l[1], h[0], h[2]];       // (x, y) -> (-y, x) about the group corner
      if (t.shape && ROTATE[t.shape]) ROTATE[t.shape](t);
      if (!t.up && t.side) t.side = turnSide(t.side);
    }
    const m = [0, 1].map((i) => { let v = Infinity; for (const t of items) v = Math.min(v, t.lo[i]); return v; });   // back onto the group's low corner
    for (const t of items) for (const i of [0, 1]) { t.lo[i] = r3(t.lo[i] - m[i]); t.hi[i] = r3(t.hi[i] - m[i]); }
  }
}

export function nudgeGhost(d: number): void { if (!ed.ghost) return; ed.ghost.dz += d; playClick(); }

/** a ray from the cursor (the same one pickRay casts) */
export function cursorRay(mx: number, my: number): { vx: number; vy: number; S: number[]; D: number[] } | null {
  const cw = canvas.clientWidth, ch = canvas.clientHeight, cam = S.cam;
  if (!cw || !ch) return null;
  const fx = Math.max(cw / ch, 1), fy = Math.max(ch / cw, 1);
  const vx = (2 * mx / cw - 1) * cam.half * fx + cam.x, vy = (1 - 2 * my / ch) * cam.half * fy + cam.y;
  return { vx, vy, ...viewRay(vx, vy) };
}

/** the scene's ground: the lowest brick bottom (as the ground grid uses), remembered for an empty scene */
function groundZ(): number {
  const z = Math.min(hasFocus() && !S.hidden.has(S.sel) ? S.dlo[2] : Infinity, inst.groundAbs);
  if (isFinite(z)) { ed.groundAbs = z; return z; }
  return ed.groundAbs;
}

/** pose the ghost onto the face under the cursor, else the ground */
export function poseGhost(): void {
  const G = ed.ghost!;
  G.pose = null; G.valid = false; G.reason = ''; G.skip = [];
  if (!G.mouse || !G.over) return;
  const r = cursorRay(G.mouse[0], G.mouse[1]);
  if (!r) return;
  const sz = gsize(G.items), st = gsteps(G.items), gz = groundZ();
  const snap = (v: number, ref: number, s: number): number => r3(ref + Math.round((v - ref) / s) * s);
  const hit = pickRay(r.vx, r.vy), p: V3 = [0, 0, 0];
  if (hit && hit.ax >= 0 && S.scene.alive(hit.k)) {
    // on a face: flush against it along its axis, centred on the cursor and snapped to that brick's grid
    const own = hit.k === S.sel, bx = own ? null : S.scene.box(hit.k);
    const bl = own ? S.dlo : [0, 1, 2].map((i) => r3(bx![i]! * BRZ_UNIT)), bh = own ? S.dhi : [0, 1, 2].map((i) => r3(bx![i + 3]! * BRZ_UNIT));
    const P = r.S.map((v, i) => v + r.D[i] * hit.s), a = hit.ax, outward = r.D[a] > 0 ? -1 : 1;
    for (let i = 0; i < 3; i++) p[i] = i === a ? (outward > 0 ? bh[i] : r3(bl[i] - sz[i])) : snap(P[i] - sz[i] / 2, bl[i], st[i]);
  } else {
    // the ground plane, snapped to the drawn ground grid (it lines up with the focused brick's far corner)
    if (Math.abs(r.D[2]) < 1e-9) return;
    const t = (gz - r.S[2]) / r.D[2];
    if (t < 0) return;
    const P = r.S.map((v, i) => v + r.D[i] * t);
    const ref = hasFocus() && !S.hidden.has(S.sel) ? [farOf(0, S.dlo, S.dhi), farOf(1, S.dlo, S.dhi)] : [0, 0];
    p[0] = snap(P[0] - sz[0] / 2, ref[0], st[0]); p[1] = snap(P[1] - sz[1] / 2, ref[1], st[1]); p[2] = r3(gz);
  }
  p[2] = r3(p[2] + G.dz * st[2]);
  G.pose = p;
  if (p[2] < gz - 1e-4) { G.reason = 'below the ground'; return; }
  // same-grid overlap: a paste drops the items that collide, any other placement is refused
  G.skip = G.items.map((t) => itemHits(p, t, G.ignore));
  if (G.drop ? G.skip.every(Boolean) : G.skip.some(Boolean)) { G.reason = 'overlaps a brick'; return; }
  G.valid = true;
}

/**
 * After the resize ghost: a depth-only pass, then the brick itself blended at a constant alpha, a red
 * wash when blocked, and the box outline on top of everything.
 */
function drawGhost(): void {
  const G = ed.ghost;
  if (!G) return;
  poseGhost();
  if (!G.pose) return;
  const { gl, u } = Gfx, p = G.pose;
  if (G.items.length > BATCH_AT) { drawBigGhost(G); return; }
  const boxes = G.items.map((t) => [[0, 1, 2].map((i) => p[i] + t.lo[i]), [0, 1, 2].map((i) => p[i] + t.hi[i])]);
  const body = (t: Brick, [l, h]: number[][]): void => drawBody(t, l, h);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.uniform1f(u.uFadeR, 0); gl.uniform1f(u.uEdge, 0);
  gl.enable(gl.DEPTH_TEST);
  gl.colorMask(false, false, false, false); gl.depthMask(true); gl.depthFunc(gl.LESS);
  G.items.forEach((t, j) => body(t, boxes[j]));
  gl.colorMask(true, true, true, true); gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.BLEND);
  gl.blendColor(0, 0, 0, G.valid ? 0.6 : 0.35); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
  G.items.forEach((t, j) => body(t, boxes[j]));
  gl.uniform1f(u.uEdge, 1); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const red = (j: number): boolean => !G.valid || !!G.skip[j];     // blocked, or a pasted brick that will be dropped
  gl.uniform4f(u.uLine, 1, 0.12, 0.08, 0.5); G.items.forEach((t, j) => { if (red(j)) body(t, boxes[j]); });
  gl.disable(gl.DEPTH_TEST);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxEB);
  boxes.forEach(([l, h], j) => {
    if (red(j)) gl.uniform4f(u.uLine, 1, 0.3, 0.25, 0.95); else gl.uniform4f(u.uLine, 1, 1, 1, 0.85);
    setBox(l, h); gl.drawElements(gl.LINES, BOX_EDGE_COUNT, gl.UNSIGNED_SHORT, 0);
  });
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LESS); gl.disable(gl.BLEND);
  gl.uniform4f(u.uLine, 0.05, 0.05, 0.08, 1);
  setBox(S.dlo, S.dhi);
}

/** drawGhost for a big group: the same passes, instanced, with one outline round the whole group. */
function drawBigGhost(G: Ghost): void {
  const { gl, u } = Gfx, p = G.pose!, set = ghostBatch(G.items), off = set.opts.offset!;
  for (let i = 0; i < 3; i++) off[i] = p[i]! / BRZ_UNIT;
  set.sync();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.uniform1f(u.uFadeR, 0); gl.uniform1f(u.uEdge, 0);
  gl.enable(gl.DEPTH_TEST);
  gl.colorMask(false, false, false, false); gl.depthMask(true); gl.depthFunc(gl.LESS);
  set.draw(null);
  gl.colorMask(true, true, true, true); gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.BLEND);
  gl.blendColor(0, 0, 0, G.valid ? 0.6 : 0.35); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
  set.draw(null);
  gl.uniform1f(u.uEdge, 1); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform4f(u.uLine, 1, 0.12, 0.08, 0.5);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  if (!G.valid) set.draw(null);                                   // blocked: all of it red
  else G.items.forEach((t, j) => {                                 // a paste: the bricks that will be dropped
    if (G.skip[j]) drawBody(t, [0, 1, 2].map((i) => p[i]! + t.lo[i]!), [0, 1, 2].map((i) => p[i]! + t.hi[i]!));
  });
  gl.disable(gl.DEPTH_TEST);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxEB);
  const sz = gsize(G.items);
  if (!G.valid) gl.uniform4f(u.uLine, 1, 0.3, 0.25, 0.95); else gl.uniform4f(u.uLine, 1, 1, 1, 0.85);
  setBox(p, [0, 1, 2].map((i) => p[i]! + sz[i]!)); gl.drawElements(gl.LINES, BOX_EDGE_COUNT, gl.UNSIGNED_SHORT, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LESS); gl.disable(gl.BLEND);
  gl.uniform4f(u.uLine, 0.05, 0.05, 0.08, 1);
  setBox(S.dlo, S.dhi);
}
