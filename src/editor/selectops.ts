// Operations on the selection (backlog E-02); with nothing selected they act on the focused brick.
//
//   Move (M)        the ghost carries the bricks: R turns the group (about world Z; one brick turns
//                   about its own axes), PgUp / PgDn nudge a plate, collision as for placing. The
//                   originals are hidden from the scene and from collision while they move; a click
//                   puts them down (one undo step, same ids), Esc or right-click puts them back.
//   Copy (Ctrl+C)   the bricks go on the clipboard, relative to their low corner
//   Cut (Ctrl+X)    copy, then delete: one undo step
//   Paste (Ctrl+V)  clipboard.ts; the pasted bricks become the selection
//   Delete          every selected brick: one undo step
//   Paint           ui/panels/paint.ts paintSelection
//
// Components and wires (C-02 / C-03) name bricks by their index in a 2048-unit save chunk; saving
// re-indexes them (scene/remap.ts) as long as each such brick is still in its chunk. So a brick
// that carries components may be moved inside its chunk, but deleting it, cutting it or moving it
// into another chunk is refused with a message. Copies never take components along.

import { S } from '../app/state.ts';
import { BRZ_UNIT, r3 } from '../core/units.ts';
import { cloneBrick, type Brick, type V3 } from '../scene/brick.ts';
import { histEnd, txBegin, txEnd } from '../scene/history.ts';
import { brickView, centreOf, writeBrick } from '../scene/view.ts';
import { filesOf } from '../scene/load.ts';
import { componentSeqs, saveChunkOf } from '../scene/remap.ts';
import type { FileMap } from '../format/brz.ts';
import { markBrick } from '../render/instances.ts';
import { clearSelection, effectiveIds, setSelection } from './select.ts';
import { focusKeepZoom, listTx, nearestBrick } from './ops.ts';
import { ed, endPlacing, ghostName, itemName, startPlacing, type Ghost } from './ghost.ts';
import { clip } from './clipboard.ts';
import { keepZoom, selectBrick } from './resize.ts';
import { initAudio, playClick, playDelete, playError } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';

const plural = (n: number, w = 'brick'): string => `${n} ${w}${n === 1 ? '' : 's'}`;

function refuse(msg: string): void { setStatus(msg); initAudio(); playError(); }

// --- components ------------------------------------------------------------------------------------

let compCache: { files: FileMap; seqs: Set<number> } | null = null;
/** Ids among `ids` whose bricks carry components or wires in the save they were loaded from. */
export function componentBricks(ids: readonly number[]): number[] {
  const files = filesOf(S.scene);
  if (!files) return [];
  if (!compCache || compCache.files !== files) compCache = { files, seqs: componentSeqs(files) };
  const seqs = compCache.seqs, s = S.scene;
  if (!seqs.size) return [];
  return ids.filter((id) => s.srcOrder[id]! >= 0 && seqs.has(s.srcOrder[id]!));
}

// --- copy / cut / delete ---------------------------------------------------------------------------

/** Brick records of `ids` relative to their group's low corner, without load data (a paste makes new bricks). */
export function groupItems(ids: readonly number[], keepSave = false): Brick[] {
  const items = ids.map((id) => brickView(S.scene, id));
  const o = [0, 1, 2].map((i) => { let v = Infinity; for (const b of items) v = Math.min(v, b.lo[i]!); return v; });
  for (const b of items) {
    b.lo = b.lo.map((v, i) => r3(v - o[i]!)) as V3; b.hi = b.hi.map((v, i) => r3(v - o[i]!)) as V3;
    if (!keepSave && b.save) { delete b.save.seq; if (!Object.keys(b.save).length) delete b.save; }
  }
  return items;
}

/** Ctrl+C: the selection (or the focused brick) onto the clipboard. */
export function copySelection(): boolean {
  const ids = effectiveIds();
  if (!ids.length) { setStatus('Nothing to copy'); return false; }
  clip.items = groupItems(ids);
  const comps = componentBricks(ids).length;
  setStatus(`Copied ${ids.length === 1 ? itemName(clip.items[0]!) : plural(ids.length)}` + (comps ? ' (bricks only: components and wires are not copied)' : '') +
    (clip.mode === 'brick' ? ' · Ctrl+V to paste' : ' · Ctrl+V uploads: switch it to Paste brick under Open save'));
  return true;
}

/** Removes `ids` as one undo step; the brick nearest to them takes the focus if it was among them. */
function removeIds(ids: readonly number[], label: string): void {
  histEnd();
  const s = S.scene, keep = S.cam.half, gone = new Set(ids);
  const c = [0, 0, 0];
  for (const id of ids) { const m = centreOf(s, id); for (let i = 0; i < 3; i++) c[i]! += m[i]! / ids.length; }
  const focus = gone.has(S.sel) ? nearestBrick(gone.size === 1 ? centreOf(s, S.sel) : c, gone) : S.sel;
  const t = txBegin(label, ids, { selBefore: [...S.selection] });
  for (const id of ids) s.remove(id);
  clearSelection();
  focusKeepZoom(focus, keep);
  listTx.add(t); txEnd(t, { selAfter: [] });
}

/** Delete: the selection (or the focused brick). */
export function deleteSelection(): void {
  if (S.held) return;
  const ids = effectiveIds();
  if (!ids.length) return;
  const comps = componentBricks(ids);
  if (comps.length) { refuse(`Can't delete: ${comps.length === 1 ? itemName(brickView(S.scene, comps[0]!)) + ' carries' : plural(comps.length) + ' carry'} components or wires (deleting those isn't supported yet)`); return; }
  const name = ids.length === 1 ? itemName(brickView(S.scene, ids[0]!)) : plural(ids.length);
  removeIds(ids, ids.length === 1 ? 'delete brick' : 'delete bricks');
  initAudio(); playDelete();
  setStatus(S.scene.count ? `Deleted ${name}` : `Deleted ${name}: the scene is empty, drag a brick in from Bricks`);
}

/** Ctrl+X: copy, then delete (one undo step). */
export function cutSelection(): void {
  if (S.held) return;
  const ids = effectiveIds();
  if (!ids.length) { setStatus('Nothing to cut'); return; }
  const comps = componentBricks(ids);
  if (comps.length) { refuse(`Can't cut: ${plural(comps.length)} ${comps.length === 1 ? 'carries' : 'carry'} components or wires (deleting those isn't supported yet); Ctrl+C copies`); return; }
  clip.items = groupItems(ids);
  removeIds(ids, 'cut');
  initAudio(); playDelete();
  setStatus(`Cut ${ids.length === 1 ? itemName(clip.items[0]!) : plural(ids.length)}` + (clip.mode === 'brick' ? ' · Ctrl+V to paste' : ' · Ctrl+V uploads: switch it to Paste brick under Open save'));
}

// --- move ------------------------------------------------------------------------------------------

/**
 * Picks the selection (or the focused brick) up into the ghost. M: it follows the cursor until a
 * click puts it down. The Move tool (editor/tools.ts): `drag`, held by the point `grab` (absolute
 * viewer units) under the cursor, put down on release.
 */
export function startMove(opts: { drag?: boolean; grab?: number[] } = {}): void {
  if (S.held || ed.ghost) return;
  const ids = effectiveIds();
  if (!ids.length) { setStatus('Nothing to move: focus or select bricks first'); return; }
  let anchor: number[] | undefined;
  if (opts.grab) {
    const b = new Array<number>(6), lo = [Infinity, Infinity, Infinity];
    for (const id of ids) { S.scene.box(id, b); for (let i = 0; i < 3; i++) lo[i] = Math.min(lo[i]!, b[i]! * BRZ_UNIT); }
    anchor = opts.grab.map((v, i) => v - lo[i]!);
  }
  const items = groupItems(ids, true), hidden = new Set(ids);
  const hide = (on: boolean): void => {
    for (const id of ids) markBrick(id);
    S.hidden = on ? hidden : new Set();
  };
  hide(true);
  const onCancel = (): void => { hide(false); };
  const onPlace = (G: Ghost): boolean => placeMove(G, ids, () => hide(false));
  startPlacing(items, ids.length === 1 ? 'move brick' : 'move bricks', opts.drag ? 'drag' : 'click', null, { ignore: hidden, onPlace, onCancel, anchor });
  const it = ids.length === 1 ? 'it' : 'them';
  setStatus(`Moving ${ghostName(items)}: ${opts.drag ? 'release' : 'click'} to put ${it} down, R turns, PgUp / PgDn raise / lower, Esc puts ${it} back`);
}

/** Puts a moving group down at the ghost's pose: the same ids, one undo step. */
function placeMove(G: Ghost, ids: readonly number[], unhide: () => void): boolean {
  const p = G.pose!, s = S.scene;
  const moved = G.items.map((t) => {
    const b = cloneBrick(t);
    b.lo = t.lo.map((v, i) => r3(v + p[i]!)) as V3; b.hi = t.hi.map((v, i) => r3(v + p[i]!)) as V3;
    return b;
  });
  // a brick with components / wires may move within its 2048-unit save chunk only
  const comps = new Set(componentBricks(ids));
  for (let j = 0; j < ids.length; j++) {
    const id = ids[j]!;
    if (!comps.has(id)) continue;
    const b = moved[j]!, np = [0, 1, 2].map((i) => Math.round((b.lo[i]! + b.hi[i]!) / 2 / BRZ_UNIT));
    if (saveChunkOf(np) !== saveChunkOf([s.px[id]!, s.py[id]!, s.pz[id]!])) {
      refuse(`Can't move ${itemName(b)} there: it carries components or wires, which can't move into another chunk yet`);
      return false;
    }
  }
  histEnd();
  const keep = S.cam.half, t = txBegin(G.label, ids, { selBefore: [...S.selection] });
  ids.forEach((id, j) => writeBrick(s, id, moved[j]!, true));
  unhide();
  if (ids.length > 1 || S.selection.size) setSelection(ids);
  if (s.alive(S.sel)) { selectBrick(S.sel); keepZoom(keep); }
  listTx.add(t); txEnd(t, { selAfter: [...S.selection] });
  endPlacing(undefined, true);
  ed.lastPlaceT = performance.now();
  initAudio(); playClick();
  setStatus(`Moved ${ids.length === 1 ? itemName(moved[0]!) : plural(ids.length)}`);
  return true;
}

/** Is a move under way? */
export const moving = (): boolean => !!ed.ghost?.onPlace;
