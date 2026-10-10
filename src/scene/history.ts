// Undo / redo (Ctrl+Z; Ctrl+Y or Ctrl+Shift+Z). One transaction per edit: a whole resize drag, a
// typed size, a type switch, one colour drag / pick, a paint, a placement, a delete, a move, a
// scene load (ARCHITECTURE.md section 4).
//
// Edits keep BrickRecords (scene/record.ts) of just the rows they touch, before and after, by id:
// positions are absolute integers, so a record means the same however the camera moved since. A
// scene load keeps the old and new stores by reference. The stack is capped by steps (the "Undo
// steps" box) and by bytes (MAX_BYTES). Lighting is view state and isn't recorded.

import { hasFocus, S, type EditTx, type SceneSnap, type Tx } from '../app/state.ts';
import type { V3 } from './brick.ts';
import { packRecords, readRecord, REC_BYTES } from './record.ts';
import { kindOf } from './view.ts';
import { restoreGrids, sameGrids, snapGrids } from './dyngrids.ts';
import { selectBrick } from '../editor/resize.ts';
import { setStatus } from '../ui/status.ts';
import { initAudio, playClick } from '../ui/audio.ts';
import { loadNumber, saveString, UNDO_KEY } from '../app/settings.ts';

/** Byte cap of the whole undo + redo history (records and replaced scenes). */
export const MAX_BYTES = 64 << 20;

export const hist = { undo: [] as Tx[], redo: [] as Tx[], open: null as EditTx | null, limit: 30 };
{
  const n = loadNumber(UNDO_KEY);
  if (n > 0) hist.limit = Math.min(500, n);
}

const has = (ids: readonly number[]): Uint8Array => Uint8Array.from(ids, (id) => (S.scene.alive(id) ? 1 : 0));

/** Opens an edit of rows `ids` (records taken now); txEnd closes it. */
export function txBegin(label: string, ids: readonly number[], opts: { selBefore?: number[] } = {}): EditTx {
  const t: EditTx = { kind: 'edit', label, sel: S.sel, ids: ids.slice(), before: packRecords(S.scene, ids.filter((id) => S.scene.alive(id))), beforeHas: has(ids), focusBefore: S.sel, focusAfter: S.sel, selBefore: opts.selBefore };
  const g = snapGrids(S.scene);
  if (g) t.gridsBefore = g;
  return t;
}

/** Finishes an edit: takes the after records; pushes it unless nothing changed. Returns whether it was pushed. */
export function txEnd(t: EditTx, opts: { selAfter?: number[]; force?: boolean } = {}): boolean {
  t.afterHas = has(t.ids);
  t.after = packRecords(S.scene, t.ids.filter((id) => S.scene.alive(id)));
  t.focusAfter = S.sel;
  if (opts.selAfter) t.selAfter = opts.selAfter;
  if (t.gridsBefore) {
    const g = snapGrids(S.scene);
    if (sameGrids(t.gridsBefore, g)) delete t.gridsBefore;   // the grids didn't change: nothing to keep
    else t.gridsAfter = g;
  }
  const same = !t.gridsBefore && t.afterHas.every((v, j) => v === t.beforeHas[j]) && t.after.length === t.before.length && t.after.every((v, j) => v === t.before[j]);
  if (same && !opts.force) return false;
  histPush(t);
  return true;
}

const txBytes = (t: Tx): number => (t.kind === 'scene' ? t.before.scene.bytes + t.after.scene.bytes : t.kind === 'data' ? t.bytes : t.before.length + (t.after?.length ?? 0) + 2 * t.ids.length * 5);

function trim(): void {
  let bytes = 0;
  for (const t of hist.undo) bytes += txBytes(t);
  for (const t of hist.redo) bytes += txBytes(t);
  while (hist.undo.length > hist.limit || (bytes > MAX_BYTES && hist.undo.length > 1)) bytes -= txBytes(hist.undo.shift()!);
}

export function histPush(t: Tx): void {
  hist.undo.push(t); hist.redo.length = 0;
  trim();
}

/** open a transaction on the focused brick; histEnd() closes it (and drops it if nothing changed) */
export function histBegin(label: string): void {
  histEnd();
  if (!hasFocus()) return;
  hist.open = txBegin(label, [S.sel]);
}

export function histEnd(): void {
  const t = hist.open;
  if (!t) return;
  hist.open = null;
  txEnd(t);
}

export const sceneSnap = (): SceneSnap => ({ scene: S.scene, sel: S.sel, zoom: S.zoomMul, origin: S.origin.slice() as V3 });

/** Puts one side of an edit into the scene: rows with a record get it, the others are removed. */
function putSide(t: EditTx, side: 'before' | 'after'): void {
  const recs = side === 'before' ? t.before : t.after!, present = side === 'before' ? t.beforeHas : t.afterHas!;
  const dv = new DataView(recs.buffer, recs.byteOffset, recs.byteLength), s = S.scene;
  let j = 0;
  t.ids.forEach((id, i) => {
    if (present[i]) { readRecord(s, id, dv, j * REC_BYTES, kindOf); j++; }
    else s.remove(id);
  });
  if (t.gridsBefore) restoreGrids(s, side === 'before' ? t.gridsBefore : t.gridsAfter);
}

/** side: 'before' (undo) or 'after' (redo) */
function histApply(t: Tx, side: 'before' | 'after'): void {
  for (const f of S.hooks.beforeTx) f();
  if (t.kind === 'scene') {
    t[side === 'before' ? 'after' : 'before'] = sceneSnap();   // the side being left, as it is now
    const s = t[side];
    S.scene = s.scene; S.zoomMul = s.zoom; S.origin = s.origin.slice() as V3;
    selectBrick(s.sel);
  } else if (t.kind === 'data') {
    if (side === 'before') t.undo(); else t.redo();
    if (S.scene.alive(t.focus) && t.focus !== S.sel) selectBrick(t.focus);
  } else {
    putSide(t, side);
    const f = side === 'before' ? t.focusBefore : t.focusAfter;
    selectBrick(S.scene.alive(f) ? f : S.scene.alive(S.sel) ? S.sel : S.scene.first());
  }
  for (const f of S.hooks.afterTx) f(t, side);
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
