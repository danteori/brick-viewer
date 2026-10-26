import { S, type AxisDir } from '../app/state.ts';
import { MAX, r3 } from '../core/units.ts';
import { cloneBrick, fixedSize, sizeRule, type Brick, type V3 } from '../scene/brick.ts';
import { itemHits } from '../scene/collision.ts';
import { studPx } from '../render/camera.ts';
import { ed, ghostItemsVersion, groundZ, gsize, itemName, poseGhost, type Ghost, type GhostView } from './ghost.ts';
import { canStretch, copyCount, dragCounts, repeatCorners, repeatSpan, stretchBox, type DragMode } from './dragmath.ts';
import { axisDragFinish, axisDragMove, newAxisDrag, type AxisDrag } from './axisdrag.ts';
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
const AXIS_HINT = placeholder('right-click finishes an axis');

interface Drag {
  ghost: Ghost;
  start: V3;
  /** the stepped axis drag, as the Resize tool runs it */
  axes: AxisDrag;
  /** steps on the axes a right-click finished */
  done: V3;
  /** the axis in progress (-1: none) and its steps */
  axis: number;
  pending: number;
  /** follow the cursor every frame (mouse mode) */
  followMouse: boolean;
  lastMouse: [number, number] | null;
  version: number;
  mode: DragMode;
  view: GhostView;
  stretch: boolean;
  capped: boolean;
  left: number;
}
let drag: Drag | null = null;

export function toggleDragMode(): DragMode {
  dragPlace.mode = dragPlace.mode === 'resize' ? 'repeat' : 'resize';
  setStatus(MODE_TEXT[dragPlace.mode]);
  initAudio(); playClick();
  return dragPlace.mode;
}

/** Can this ghost be drag-placed? A move or an import goes down as one piece. */
export const canDrag = (G: Ghost): boolean => !G.onPlace && !G.noHits;

/** A drag placement of the current ghost is under way. */
export const dragging = (): boolean => !!drag && drag.ghost === ed.ghost;

/** Starts a drag from the ghost's current pose at screen point `at`; false when it has no pose. */
export function beginDrag(G: Ghost, at: [number, number], followMouse = true): boolean {
  poseGhost();
  if (!G.pose) return false;
  const start = G.pose.slice() as V3;
  drag = {
    ghost: G, start, axes: newAxisDrag(at.slice() as [number, number]), done: [0, 0, 0], axis: -1, pending: 0,
    followMouse, lastMouse: at, version: -1, mode: dragPlace.mode,
    view: { items: G.items, pose: start, skip: G.skip, valid: G.valid }, stretch: false, capped: false, left: 0,
  };
  rebuild(drag);
  ed.preview = preview;
  return true;
}

export function cancelDrag(): void {
  drag = null;
  ed.preview = null;
}

const counts = (d: Drag): V3 => dragCounts(d.done, d.axis, d.pending);

/** The ghost's items changed or J switched the mode: rebuild the view; start over when it no longer fits. */
function rebuild(d: Drag): void {
  const G = d.ghost, one = G.items.length === 1 ? G.items[0]! : null;
  d.version = ghostItemsVersion(); d.mode = dragPlace.mode;
  d.stretch = d.mode === 'resize' && !!one && canStretch(1, fixedSize(one), sizeRule(one).fix);
  const v = viewFor(d, counts(d), false);
  if (v) { d.view = v; return; }
  d.done = [0, 0, 0]; d.axis = -1; d.pending = 0; d.axes.lockAxis = -1; d.axes.bannedAxis = -1;
  d.view = viewFor(d, [0, 0, 0], false) ?? d.view;
}

function preview(): GhostView | null {
  const d = drag;
  if (!d || d.ghost !== ed.ghost) { cancelDrag(); return null; }
  if (d.version !== ghostItemsVersion() || d.mode !== dragPlace.mode) rebuild(d);
  const m = d.ghost.mouse;
  if (d.followMouse && m && (!d.lastMouse || m[0] !== d.lastMouse[0] || m[1] !== d.lastMouse[1])) {
    d.lastMouse = m;
    axisDragMove(d.axes, m, S.dirs, (i) => studPx(i) / S.STEPS[i]! * unitOf(d, i), (q) => dragStep(q));
  }
  d.ghost.pose = d.view.pose; d.ghost.valid = d.view.valid; d.ghost.reason = d.view.valid ? '' : 'overlaps a brick';
  return d.view;
}

/** One drag step along an axis, in viewer units. */
const unitOf = (d: Drag, i: number): number => (d.stretch ? sizeRule(d.ghost.items[0]!).steps[i]! : gsize(d.ghost.items)[i]!);

/**
 * One step of the drag toward `q` (the cursor crossed a grid line, or precision mode stepped). A
 * step that doesn't fit is refused and noted, as the Resize tool does.
 */
export function dragStep(q: AxisDir): void {
  const d = drag;
  if (!d) return;
  if (d.axis !== q.i) { d.axis = q.i; d.pending = 0; }
  const next = d.pending + q.d, v = viewFor(d, dragCounts(d.done, d.axis, next), true);
  if (v) { d.view = v; d.pending = next; }
  d.axes.lockAxis = d.pending ? d.axis : -1;
}

/** A right-click during the drag: the axis in progress is finished, and the drag can go another way. */
export function finishDragAxis(): void {
  const d = drag;
  if (!d) return;
  const axis = d.axis;
  if (axis >= 0) d.done[axis] += d.pending;
  d.axis = -1; d.pending = 0;
  axisDragFinish(d.axes, axis, d.ghost.mouse);
  initAudio(); playClick();
}

const shifted = (t: Brick, by: readonly number[]): Brick => {
  const b = cloneBrick(t);
  b.lo = t.lo.map((v, i) => r3(v + by[i]!)) as V3; b.hi = t.hi.map((v, i) => r3(v + by[i]!)) as V3;
  return b;
};

/** The view for `k` steps on each axis; null (with a note when `strict`) when it can't be placed. */
function viewFor(d: Drag, k: readonly number[], strict: boolean): GhostView | null {
  return d.stretch ? stretchView(d, k, strict) : repeatView(d, k, strict);
}

function stretchView(d: Drag, k: readonly number[], strict: boolean): GhostView | null {
  const t = d.ghost.items[0]!, rule = sizeRule(t), sz = gsize([t]), hi0 = d.start.map((v, i) => r3(v + sz[i]!));
  const box = stretchBox(d.start, hi0, k, { steps: rule.steps, fix: rule.fix, max: MAX });
  if (!box) { if (strict) noteBlock(LIMIT_TEXT); return null; }
  const b = cloneBrick(t);
  b.lo = [0, 0, 0]; b.hi = box.hi.map((v, i) => r3(v - box.lo[i]!)) as V3;
  const grown = k.some(Boolean);
  const blocked = box.lo[2] < groundZ() - 1e-4 || itemHits(box.lo, b);
  if (blocked && grown && strict) { noteBlock('overlaps a brick'); return null; }
  d.capped = false; d.left = blocked ? 1 : 0;
  return { items: [b], pose: box.lo, skip: [false], valid: !blocked };
}

function repeatView(d: Drag, k: readonly number[], strict: boolean): GhostView | null {
  const G = d.ghost, cell = gsize(G.items), cap = Math.max(1, Math.floor(REPEAT_MAX_BRICKS / G.items.length));
  const span = repeatSpan(d.start, cell, k);
  if (copyCount(span) > cap) { d.capped = true; if (strict) noteBlock(LIMIT_TEXT); return null; }
  const gz = groundZ(), items: Brick[] = [], skip: boolean[] = [];
  for (const c of repeatCorners(span, cell)) {
    const hit = G.items.map((t) => c[2] + t.lo[2] < gz - 1e-4 || itemHits(c, t));
    const copyOut = !G.drop && hit.some(Boolean);
    G.items.forEach((t, j) => { items.push(shifted(t, c.map((v, i) => r3(v - span.lo[i]!)))); skip.push(copyOut || hit[j]!); });
  }
  d.capped = false; d.left = skip.filter(Boolean).length;
  return { items, pose: span.lo, skip, valid: skip.some((s) => !s) };
}

/** The HUD part for the ghost: the drag mode, and while dragging what the drag will place. */
export function dragHud(): string {
  const d = dragging() ? drag! : null, mode = `<b>${MODE_TEXT[dragPlace.mode]}</b> (J)`;
  if (!d) return mode;
  const placed = d.view.items.length - d.left;
  const notes = [dragPlace.mode === 'resize' && !d.stretch ? FALLBACK_TEXT : '', d.capped ? LIMIT_TEXT : '',
    d.left ? LEFT_OUT_TEXT.replace('{k}', String(d.left)) : ''].filter(Boolean);
  return `${mode} · ${d.stretch ? itemName(d.view.items[0]!) : PLACED_TEXT.replace('{n}', String(placed))}${notes.length ? ` (${notes.join(', ')})` : ''} · ${AXIS_HINT}`;
}

/**
 * Ends the drag. 'single': it never stepped, so the caller places the ghost as a plain click does;
 * 'placed': the bricks went down as one undo step; 'refused': nothing fits. The ghost stays in hand.
 */
export function endDrag(): 'single' | 'placed' | 'refused' | 'none' {
  const d = drag;
  cancelDrag();
  if (!d || d.ghost !== ed.ghost) return 'none';
  const G = d.ghost, v = d.view;
  if (!counts(d).some(Boolean)) return 'single';
  const bricks = v.items.filter((_, j) => !v.skip[j]).map((t) => shifted(t, v.pose));
  if (!bricks.length || (d.stretch && !v.valid)) { setStatus(NONE_FIT_TEXT); initAudio(); playError(); return 'refused'; }
  const ids = addBricks(bricks, G.label);
  if (G.drop && ids.length > 1) setSelection(ids);
  ed.lastPlaceT = performance.now();
  initAudio(); if (G.drop) playPaste(); else playClick();
  const left = v.items.length - bricks.length;
  setStatus(d.stretch ? `Placed ${itemName(v.items[0]!)}`
    : PLACED_TEXT.replace('{n}', String(bricks.length)) + (left ? ` (${LEFT_OUT_TEXT.replace('{k}', String(left))})` : ''));
  return 'placed';
}
