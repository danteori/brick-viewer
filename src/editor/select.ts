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
import { boxQuery } from '../scene/spatial.ts';
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
export function setSelection(ids: Iterable<number>): void {
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
export function toggleSelect(id: number): void {
  if (!S.scene.alive(id)) return;
  const next = new Set(S.selection);
  if (!next.size && hasFocus() && id !== S.sel) next.add(S.sel);
  if (next.has(id)) next.delete(id); else next.add(id);
  setSelection(next);
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
 * Box select: bricks whose centre projects inside the screen rectangle (CSS px) of `canvas`. Every
 * depth counts, hidden bricks too. mode 'add' or 'remove'.
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
    if (px >= ax && px <= bx && py >= ay && py <= by) hits.push(id);
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
