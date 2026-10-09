// Undo / redo (Ctrl+Z; Ctrl+Y or Ctrl+Shift+Z). One transaction per edit: a whole resize drag, a
// typed size, a type switch, one colour drag / pick, a placement, a delete or a scene load.
// Brick edits keep before/after copies of just the changed bricks (by index), with lo/hi stored
// frame-independently (local + histOrigin); scene loads keep the old and new brick lists by
// reference plus their origin, focus and zoom. Lighting is view state and isn't recorded.

import { S, type BrickTx, type SceneSnap, type Tx } from '../app/state.ts';
import { cloneBrick, type Brick, type V3 } from './brick.ts';
import { instAll, markBrick } from '../render/instances.ts';
import { selectBrick } from '../editor/resize.ts';
import { setStatus } from '../ui/status.ts';
import { initAudio, playClick } from '../ui/audio.ts';
import { loadNumber, saveString, UNDO_KEY } from '../app/settings.ts';

export const hist = { undo: [] as Tx[], redo: [] as Tx[], open: null as BrickTx | null, limit: 30 };
{
  const n = loadNumber(UNDO_KEY);
  if (n > 0) hist.limit = Math.min(500, n);
}

/** Frame-independent copy of brick k. */
export function snapBrick(k: number): Brick {
  const b = S.bricks[k], o = cloneBrick(b);
  o.lo = b.lo.map((v, i) => +(v + S.histOrigin[i]).toFixed(3)) as V3; o.hi = b.hi.map((v, i) => +(v + S.histOrigin[i]).toFixed(3)) as V3;
  return o;
}

/** in place: scene lists hold these objects by reference */
function putBrick(k: number, snap: Brick): void {
  const b = S.bricks[k] as unknown as Record<string, unknown>, o = cloneBrick(snap);
  for (const key of Object.keys(b)) delete b[key];
  Object.assign(b, o);
  const nb = b as unknown as Brick;
  nb.lo = snap.lo.map((v, i) => +(v - S.histOrigin[i]).toFixed(3)) as V3; nb.hi = snap.hi.map((v, i) => +(v - S.histOrigin[i]).toFixed(3)) as V3;
  markBrick(k);
}

export function histPush(t: Tx): void {
  hist.undo.push(t); hist.redo.length = 0;
  while (hist.undo.length > hist.limit) hist.undo.shift();
}

/** open a brick transaction on the focused brick; histEnd() closes it (and drops it if nothing changed) */
export function histBegin(label: string): void {
  histEnd();
  if (!S.bricks[S.sel]) return;
  hist.open = { kind: 'brick', label, sel: S.sel, idx: [S.sel], before: [snapBrick(S.sel)] };
}

export function histEnd(): void {
  const t = hist.open;
  if (!t) return;
  hist.open = null;
  if (!t.idx.every((k) => k < S.bricks.length)) return;
  t.after = t.idx.map(snapBrick);
  if (JSON.stringify(t.after) !== JSON.stringify(t.before)) histPush(t);
}

export const sceneSnap = (): SceneSnap => ({ list: S.bricks.slice(), origin: S.histOrigin.slice() as V3, sel: S.sel, zoom: S.zoomMul });

/** side: 'before' (undo) or 'after' (redo) */
function histApply(t: Tx, side: 'before' | 'after'): void {
  if (t.kind === 'scene') {
    t[side === 'before' ? 'after' : 'before'] = sceneSnap();   // the side being left, as it is now
    const s = t[side];
    S.bricks.length = 0; for (const b of s.list) S.bricks.push(b);
    S.histOrigin = s.origin.slice() as V3; S.zoomMul = s.zoom;
    instAll();
    selectBrick(s.sel);
  } else if (t.kind === 'list') {
    S.hooks.applyList(t, side);
  } else {
    t.idx.forEach((k, j) => putBrick(k, (side === 'before' ? t.before : t.after!)[j]));
    selectBrick(t.sel);
  }
}

export function histStep(redo: boolean): void {
  if (S.held) return;                        // mid-drag: finish the drag first
  histEnd();
  const from = redo ? hist.redo : hist.undo, to = redo ? hist.undo : hist.redo;
  const t = from.pop();
  if (!t) { setStatus(redo ? 'Nothing to redo' : 'Nothing to undo'); return; }
  histApply(t, redo ? 'after' : 'before');
  to.push(t);
  setStatus(`${redo ? 'Redo' : 'Undo'}: ${t.label}`);
  initAudio(); playClick();
}

export function setUndoLimit(n: number): void {
  if (n > 0) {
    hist.limit = Math.min(500, n);
    while (hist.undo.length > hist.limit) hist.undo.shift();
    while (hist.redo.length > hist.limit) hist.redo.shift();
    saveString(UNDO_KEY, String(hist.limit));
  }
}
