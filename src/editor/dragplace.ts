import { MAX, r3 } from '../core/units.ts';
import { cloneBrick, fixedSize, sizeRule, type Brick, type V3 } from '../scene/brick.ts';
import { itemHits } from '../scene/collision.ts';
import { cursorRay, ed, ghostItemsVersion, groundZ, gsize, itemName, poseGhost, type Ghost, type GhostView } from './ghost.ts';
import { canStretch, planeAxes, repeatCorners, repeatSpan, resizeBox, type DragMode } from './dragmath.ts';
import { addBricks } from './ops.ts';
import { setSelection } from './select.ts';
import { noteBlock } from './resize.ts';
import { initAudio, playClick, playError, playPaste } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';
import { placeholder } from '../ui/placeholder.ts';

/** The drag mode J toggles while a ghost is out; kept for the session. */
export const dragPlace = { mode: 'resize' as DragMode };

/** Most bricks one drag repeat places. */
export const REPEAT_MAX_BRICKS = 4096;

export const MODE_TEXT: Record<DragMode, string> = { resize: placeholder('Drag: resize'), repeat: placeholder('Drag: repeat') };
const FALLBACK_TEXT = placeholder("can't stretch: repeats");
const LIMIT_TEXT = placeholder('limit reached');
const PLACED_TEXT = placeholder('Placed {n} bricks');
const LEFT_OUT_TEXT = placeholder('{k} left out: overlapping');
const NONE_FIT_TEXT = placeholder("Can't place here: every brick overlaps");

interface Drag {
  ghost: Ghost;
  start: V3;
  plane: { axis: number; at: number };
  /** follow the cursor on the drag plane every frame (mouse mode) */
  followMouse: boolean;
  key: string;
  view: GhostView | null;
  /** the drag covers more than the start ghost */
  grown: boolean;
  stretch: boolean;
  capped: boolean;
  bricks: number;
  left: number;
}
let drag: Drag | null = null;

export function toggleDragMode(): DragMode {
  dragPlace.mode = dragPlace.mode === 'resize' ? 'repeat' : 'resize';
  if (drag) { drag.key = ''; drag.view = null; }
  setStatus(MODE_TEXT[dragPlace.mode]);
  initAudio(); playClick();
  return dragPlace.mode;
}

/** Can this ghost be drag-placed? A move or an import goes down as one piece. */
export const canDrag = (G: Ghost): boolean => !G.onPlace && !G.noHits;

/** A drag placement of the current ghost is under way. */
export const dragging = (): boolean => !!drag && drag.ghost === ed.ghost;

/** Starts a drag from the ghost's current pose; false when it has no pose. */
export function beginDrag(G: Ghost, followMouse = true): boolean {
  poseGhost();
  if (!G.pose || !G.face) return false;
  drag = { ghost: G, start: G.pose.slice() as V3, plane: { ...G.face }, followMouse, key: '', view: null, grown: false, stretch: false, capped: false, bricks: 0, left: 0 };
  ed.preview = preview;
  return true;
}

export function cancelDrag(): void {
  drag = null;
  ed.preview = null;
}

/** Where the cursor's ray meets the drag plane; null when the ray runs along it. */
export function planePoint(mouse: [number, number]): V3 | null {
  if (!drag) return null;
  const r = cursorRay(mouse[0], mouse[1]), a = drag.plane.axis;
  if (!r || Math.abs(r.D[a]!) < 1e-9) return null;
  const t = (drag.plane.at - r.S[a]!) / r.D[a]!;
  return r.S.map((v, i) => v + r.D[i]! * t) as V3;
}

function preview(): GhostView | null {
  const d = drag;
  if (!d || d.ghost !== ed.ghost) { cancelDrag(); return null; }
  if (d.followMouse && d.ghost.mouse) { const p = planePoint(d.ghost.mouse); if (p) dragTo(p); }
  if (!d.view) dragTo(d.start);
  return d.view;
}

const shifted = (t: Brick, by: readonly number[]): Brick => {
  const b = cloneBrick(t);
  b.lo = t.lo.map((v, i) => r3(v + by[i]!)) as V3; b.hi = t.hi.map((v, i) => r3(v + by[i]!)) as V3;
  return b;
};

/** Moves the drag's far end to `point` (absolute viewer units). Precision mode passes its own point. */
export function dragTo(point: readonly number[]): void {
  const d = drag;
  if (!d) return;
  const G = d.ghost, axes = planeAxes(d.plane.axis), one = G.items.length === 1 ? G.items[0]! : null;
  const rule = one ? sizeRule(one) : null;
  d.stretch = dragPlace.mode === 'resize' && !!rule && canStretch(G.items.length, fixedSize(one), rule.fix, axes);
  if (d.stretch) stretchTo(d, point, axes, one!, rule!);
  else repeatTo(d, point, axes);
  G.pose = d.view ? d.view.pose : d.start;
  G.valid = !!d.view?.valid; G.reason = G.valid ? '' : 'overlaps a brick';
}

function stretchTo(d: Drag, point: readonly number[], axes: number[], t: Brick, rule: ReturnType<typeof sizeRule>): void {
  const sz = gsize([t]), hi0 = d.start.map((v, i) => r3(v + sz[i]!));
  const box = resizeBox(d.start, hi0, point, axes, { steps: rule.steps, fix: rule.fix, max: MAX });
  const key = `s${ghostItemsVersion()}|${box.lo}|${box.hi}`;
  if (key === d.key) return;
  d.key = key;
  const b = cloneBrick(t);
  b.lo = [0, 0, 0]; b.hi = box.hi.map((v, i) => r3(v - box.lo[i]!)) as V3;
  const blocked = box.lo[2] < groundZ() - 1e-4 || itemHits(box.lo, b, d.ghost.ignore);
  const grown = box.lo.some((v, i) => v !== d.start[i]) || box.hi.some((v, i) => v !== hi0[i]);
  if (blocked && d.view?.valid) { noteBlock('overlaps a brick'); return; }
  d.view = { items: [b], pose: box.lo, skip: [false], valid: !blocked };
  d.grown = grown; d.capped = false; d.bricks = 1; d.left = blocked ? 1 : 0;
}

function repeatTo(d: Drag, point: readonly number[], axes: number[]): void {
  const G = d.ghost, cell = gsize(G.items), cap = Math.max(1, Math.floor(REPEAT_MAX_BRICKS / G.items.length));
  const span = repeatSpan(d.start, cell, point, axes, cap), free = repeatSpan(d.start, cell, point, axes);
  const key = `r${ghostItemsVersion()}|${cell}|${span.lo}|${span.n}`;
  if (key === d.key) return;
  d.key = key;
  const gz = groundZ(), items: Brick[] = [], skip: boolean[] = [];
  for (const c of repeatCorners(span, cell)) {
    const hit = G.items.map((t) => c[2] + t.lo[2] < gz - 1e-4 || itemHits(c, t, G.ignore));
    const copyOut = !G.drop && hit.some(Boolean);
    G.items.forEach((t, j) => { items.push(shifted(t, c.map((v, i) => r3(v - span.lo[i]!)))); skip.push(copyOut || hit[j]!); });
  }
  d.view = { items, pose: span.lo, skip, valid: skip.some((s) => !s) };
  d.grown = span.n.some((n) => n > 1); d.capped = free.n.some((n, i) => n !== span.n[i]);
  d.bricks = items.length; d.left = skip.filter(Boolean).length;
}

/** The HUD part for the ghost: the drag mode, and while dragging what the drag will place. */
export function dragHud(): string {
  const d = dragging() ? drag! : null, mode = `<b>${MODE_TEXT[dragPlace.mode]}</b> (J)`;
  if (!d) return mode;
  const notes = [dragPlace.mode === 'resize' && !d.stretch ? FALLBACK_TEXT : '', d.capped ? LIMIT_TEXT : '',
    d.left ? LEFT_OUT_TEXT.replace('{k}', String(d.left)) : ''].filter(Boolean);
  return `${mode} · ${d.stretch && d.view ? itemName(d.view.items[0]!) : PLACED_TEXT.replace('{n}', String(d.bricks - d.left))}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

/**
 * Ends the drag. 'single': it never grew past the start ghost, so the caller places the ghost as a
 * plain click does; 'placed': the bricks went down as one undo step; 'refused': nothing fits.
 */
export function endDrag(): 'single' | 'placed' | 'refused' | 'none' {
  const d = drag;
  cancelDrag();
  if (!d || d.ghost !== ed.ghost) return 'none';
  const G = d.ghost, v = d.view;
  if (!v || !d.grown) return 'single';
  const bricks = v.items.filter((_, j) => !v.skip[j]).map((t) => shifted(t, v.pose));
  if (!bricks.length) { setStatus(NONE_FIT_TEXT); initAudio(); playError(); return 'refused'; }
  const ids = addBricks(bricks, G.label);
  if (G.drop && ids.length > 1) setSelection(ids);
  ed.lastPlaceT = performance.now();
  initAudio(); if (G.drop) playPaste(); else playClick();
  const left = v.items.length - bricks.length;
  setStatus(d.stretch ? `Placed ${itemName(v.items[0]!)}`
    : PLACED_TEXT.replace('{n}', String(bricks.length)) + (left ? ` (${LEFT_OUT_TEXT.replace('{k}', String(left))})` : ''));
  return 'placed';
}
