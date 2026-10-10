// Multi-select (backlog E-01). The selection is a set of brick ids (S.selection), separate from the
// focus: the focused brick is still the one that resizes. Operations act on the selection when it
// has bricks, else on the focused brick alone (effectiveIds).
//
//   Shift+click           add / remove a brick (the first one also adds the focused brick)
//   Shift+drag            box (marquee) select: adds every brick whose centre is inside the box
//   Ctrl+Shift+drag       the same box removes them
//   Ctrl+A                select every brick;  Esc clears the selection
//   Same colour / Connected (Selection panel): by the focused brick's colour, or every brick
//   touching the selection face to face, repeated until nothing new joins
//
// Selected bricks are tinted (the brick shader's SEL_TINT) and the HUD counts them.

import { S, hasFocus } from '../app/state.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { boxQuery, pickRay } from '../scene/spatial.ts';
import { touching } from '../scene/collision.ts';
import { syncScene } from '../scene/sync.ts';
import { markBrick } from '../render/instances.ts';
import { toView } from '../render/camera.ts';

/** Ids an operation acts on: the selection, or the focused brick alone. */
export function effectiveIds(): number[] {
  const s = S.scene;
  if (S.selection.size) return s.ordered().filter((id) => S.selection.has(id));
  return hasFocus() ? [S.sel] : [];
}

/** Whether the selection (not just the focus) holds bricks. */
export const hasSelection = (): boolean => S.selection.size > 0;

/** Replaces the selection (ids that aren't live are left out). */
/**
 * The Selector setting (U-21): what Shift+click does. 'brick' adds (or removes) that one brick;
 * 'box' grows a box from the first brick (the focused one) to contain every brick Shift+clicked
 * since, and selects every brick of that brick's grid FULLY inside it (integer units). The box
 * stays while that selection does; anything else that sets the selection ends it.
 */
export const selector = { mode: 'brick' as 'brick' | 'box', box: null as { b: number[]; grid: number } | null };

export function setSelection(ids: Iterable<number>, keepBox = false): void {
  if (!keepBox) selector.box = null;
  const next = new Set<number>();
  for (const id of ids) if (S.scene.alive(id)) next.add(id);
  for (const id of S.selection) if (!next.has(id)) markBrick(id);
  for (const id of next) if (!S.selection.has(id)) markBrick(id);
  S.selection = next;
}

export function clearSelection(): void { setSelection([]); }

export function addToSelection(ids: Iterable<number>): void { setSelection([...S.selection, ...ids]); }

export function removeFromSelection(ids: Iterable<number>): void {
  const out = new Set(S.selection);
  for (const id of ids) out.delete(id);
  setSelection(out);
}

/** Shift+click on brick id: toggles it (an empty selection first takes the focused brick). */
/**
 * Shift+click on brick id, by the Selector setting. The focused brick always stays in: in Brick mode
 * the clicked brick is added (a second Shift+click on it removes it, except the focused one); in
 * Box mode the box grows to take it in.
 */
export function toggleSelect(id: number): void {
  if (!S.scene.alive(id)) return;
  if (selector.mode === 'box') { growBox(id); return; }
  const next = new Set(S.selection);
  if (hasFocus()) next.add(S.sel);
  if (next.has(id) && id !== S.sel) next.delete(id); else next.add(id);
  setSelection(next);
}

/** Box mode: grow the box to contain brick id (starting from the focused brick) and reselect. */
export function growBox(id: number): void {
  const s = S.scene, b = new Array<number>(6);
  let box = selector.box;
  if (!box) {
    const anchor = hasFocus() ? S.sel : id;
    s.box(anchor, b);
    box = { b: b.slice(), grid: s.grid[anchor]! };
  }
  s.box(id, b);
  for (let i = 0; i < 3; i++) { box.b[i] = Math.min(box.b[i]!, b[i]!); box.b[i + 3] = Math.max(box.b[i + 3]!, b[i + 3]!); }
  const lo = box.b.slice(0, 3).map((v) => v * BRZ_UNIT), hi = box.b.slice(3).map((v) => v * BRZ_UNIT), out: number[] = [];
  for (const k of boxQuery(lo, hi, 0)) {
    if (!s.alive(k) || s.grid[k] !== box.grid) continue;
    s.box(k, b);
    if (b[0]! >= box.b[0]! && b[1]! >= box.b[1]! && b[2]! >= box.b[2]! && b[3]! <= box.b[3]! && b[4]! <= box.b[4]! && b[5]! <= box.b[5]!) out.push(k);
  }
  setSelection(out, true);
  selector.box = box;
}

/** Drops ids that are gone (after an undo or a load). */
export function pruneSelection(): void {
  if ([...S.selection].some((id) => !S.scene.alive(id))) setSelection(S.selection);
}

/** Every brick of the scene. */
export function selectAll(): number {
  setSelection(S.scene.ids());
  return S.selection.size;
}

/** Bricks whose colour bytes (and material) match brick id's (exact bytes, any intensity). */
export function selectSameColour(id: number): number {
  const s = S.scene;
  if (!s.alive(id)) return 0;
  const c = s.color[id]! & 0xffffff, lin = s.flags[id]! & 2, out: number[] = [];
  for (const k of s.ids()) if ((s.color[k]! & 0xffffff) === c && (s.flags[k]! & 2) === lin) out.push(k);
  setSelection(out);
  return out.length;
}

/** Bricks of brick id's type: the same save asset (any size, orientation or colour). */
export function selectSameType(id: number): number {
  const s = S.scene;
  if (!s.alive(id)) return 0;
  const a = s.asset[id]!, out: number[] = [];
  for (const k of s.ids()) if (s.asset[k] === a) out.push(k);
  setSelection(out);
  return out.length;
}

/**
 * Flood from `seed` over bricks touching face to face (or overlapping), within the same grid.
 * Returns the connected ids (seed included). `limit` caps the result.
 */
export function connectedFrom(seed: readonly number[], limit = Infinity): number[] {
  syncScene();
  const s = S.scene, seen = new Set<number>(), queue: number[] = [], a = new Array<number>(6), b = new Array<number>(6);
  for (const id of seed) if (s.alive(id) && !seen.has(id)) { seen.add(id); queue.push(id); }
  while (queue.length && seen.size < limit) {
    const id = queue.pop()!;
    s.box(id, a);
    const lo = [a[0]! * BRZ_UNIT, a[1]! * BRZ_UNIT, a[2]! * BRZ_UNIT], hi = [a[3]! * BRZ_UNIT, a[4]! * BRZ_UNIT, a[5]! * BRZ_UNIT];
    for (const k of boxQuery(lo, hi, 0)) {
      if (seen.has(k) || !s.alive(k) || s.grid[k] !== s.grid[id]) continue;
      s.box(k, b);
      if (!touching(a, b)) continue;
      seen.add(k); queue.push(k);
    }
  }
  return [...seen];
}

/** Selection panel "Connected": everything connected to the selection (or the focused brick). */
export function selectConnected(): number {
  const seed = effectiveIds();
  if (!seed.length) return 0;
  setSelection(connectedFrom(seed));
  return S.selection.size;
}

/**
 * Is brick id visible from the camera? Its centre or the centre of one of its camera-facing faces
 * is the first brick a view ray there meets.
 */
function seen(id: number, box: number[]): boolean {
  const lo = box.slice(0, 3).map((v) => v * BRZ_UNIT), hi = box.slice(3).map((v) => v * BRZ_UNIT);
  const c = [0, 1, 2].map((i) => (lo[i]! + hi[i]!) / 2), pts = [c];
  for (let i = 0; i < 3; i++) { const p = c.slice(); p[i] = S.ns[i]! > 0 ? hi[i]! : lo[i]!; pts.push(p); }
  for (const p of pts) {
    const v = toView(p[0]!, p[1]!, p[2]!), h = pickRay(v[0], v[1]);
    if (h && h.k === id) return true;
  }
  return false;
}

/**
 * Box select: the VISIBLE bricks whose centre projects inside the screen rectangle (CSS px) of
 * `canvas` (bricks hidden behind others aren't picked up). mode 'add' or 'remove'.
 */
export function marqueeSelect(canvas: HTMLCanvasElement, x0: number, y0: number, x1: number, y1: number, mode: 'add' | 'remove'): number {
  const r = canvas.getBoundingClientRect(), cw = canvas.clientWidth, ch = canvas.clientHeight, cam = S.cam;
  const fx = Math.max(cw / ch, 1), fy = Math.max(ch / cw, 1), sx = 1 / (cam.half * fx), sy = 1 / (cam.half * fy);
  const ax = Math.min(x0, x1) - r.left, bx = Math.max(x0, x1) - r.left, ay = Math.min(y0, y1) - r.top, by = Math.max(y0, y1) - r.top;
  const s = S.scene, hits: number[] = [];
  for (const id of s.ids()) {
    if (S.hidden.has(id)) continue;
    const v = toView(s.px[id]! * BRZ_UNIT, s.py[id]! * BRZ_UNIT, s.pz[id]! * BRZ_UNIT);
    const px = ((v[0] - cam.x) * sx + 1) * cw / 2, py = (1 - (v[1] - cam.y) * sy) * ch / 2;
    if (px >= ax && px <= bx && py >= ay && py <= by && seen(id, s.box(id, new Array<number>(6)) as number[])) hits.push(id);
  }
  if (mode === 'add') addToSelection(hits); else removeFromSelection(hits);
  return hits.length;
}

/** The selection's world box (absolute viewer units), or null. */
export function selectionBox(ids: readonly number[]): { lo: number[]; hi: number[] } | null {
  if (!ids.length) return null;
  const s = S.scene, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], b = new Array<number>(6);
  for (const id of ids) {
    s.box(id, b);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, b[i]! * BRZ_UNIT); hi[i] = Math.max(hi[i]!, b[i + 3]! * BRZ_UNIT); }
  }
  return { lo, hi };
}
