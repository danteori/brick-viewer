// Operations on the selection (backlog E-02); with nothing selected they act on the focused brick.
//
//   Move            the Move tool (editor/move.ts): the Resize drag, shifting the bricks
//   Copy (Ctrl+C)   the bricks go on the clipboard, relative to their low corner
//   Cut (Ctrl+X)    copy, then delete: one undo step
//   Paste (Ctrl+V)  clipboard.ts; the pasted bricks become the selection
//   Delete          every selected brick: one undo step
//   Paint           ui/panels/paint.ts paintSelection
//
// Components and wires (C-02 / C-03) name bricks by their index in a 2048-unit save chunk; saving
// re-indexes them (scene/remap.ts) as long as each such brick is still in its chunk. So a brick
// that carries components may be moved inside its chunk, but deleting it, cutting it or moving it
// into another chunk is refused with a message. Copies take each brick's components along (C-04:
// the data, not the wires); the paste gives the new bricks a place in the save for them.

import { S } from '../app/state.ts';
import { r3 } from '../core/units.ts';
import type { Brick, V3 } from '../scene/brick.ts';
import { histEnd, txBegin, txEnd } from '../scene/history.ts';
import { brickView, centreOf } from '../scene/view.ts';
import { carryComponents, componentsOf } from '../scene/compmodel.ts';
import { clearSelection, effectiveIds } from './select.ts';
import { focusKeepZoom, listTx, nearestBrick } from './ops.ts';
import { itemName } from './ghost.ts';
import { clip, startPaste } from './clipboard.ts';
import { initAudio, playDelete, playError } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';

const plural = (n: number, w = 'brick'): string => `${n} ${w}${n === 1 ? '' : 's'}`;

function refuse(msg: string): void { setStatus(msg); initAudio(); playError(); }

// --- components ------------------------------------------------------------------------------------

/** Ids among `ids` whose bricks carry components or wires (as they stand now: the live model of the save). */
export function componentBricks(ids: readonly number[]): number[] {
  const m = componentsOf(S.scene);
  if (!m) return [];
  const seqs = m.componentSeqs(), s = S.scene;
  if (!seqs.size) return [];
  return ids.filter((id) => s.srcOrder[id]! >= 0 && seqs.has(s.srcOrder[id]!));
}

// --- copy / cut / delete ---------------------------------------------------------------------------

/**
 * Brick records of `ids` relative to their group's low corner, without load data (a paste makes
 * new bricks) but with their components (a handle in `comps`, C-04). `keepSave`: the same bricks
 * (mirror in place): load data kept, no components carried.
 */
export function groupItems(ids: readonly number[], keepSave = false): Brick[] {
  const items = ids.map((id) => brickView(S.scene, id)), m = keepSave ? null : componentsOf(S.scene);
  const o = [0, 1, 2].map((i) => { let v = Infinity; for (const b of items) v = Math.min(v, b.lo[i]!); return v; });
  items.forEach((b, j) => {
    b.lo = b.lo.map((v, i) => r3(v - o[i]!)) as V3; b.hi = b.hi.map((v, i) => r3(v - o[i]!)) as V3;
    if (!keepSave && b.save) { delete b.save.seq; if (!Object.keys(b.save).length) delete b.save; }
    const carried = m?.carriedOf(ids[j]!) ?? [];
    if (carried.length) b.comps = carryComponents(carried);
  });
  return items;
}

/** Ctrl+C: the selection (or the focused brick) onto the clipboard. */
export function copySelection(): boolean {
  const ids = effectiveIds();
  if (!ids.length) { setStatus('Nothing to copy'); return false; }
  clip.items = groupItems(ids);
  const comps = clip.items.filter((b) => b.comps !== undefined).length;
  setStatus(`Copied ${ids.length === 1 ? itemName(clip.items[0]!) : plural(ids.length)}` + (comps ? ` (with the components of ${plural(comps)}; wires are not copied)` : '') +
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
  // the cut bricks are in hand at once, as a paste: click to put them down, Esc keeps them on the clipboard
  startPaste();
  setStatus(`Cut ${ids.length === 1 ? itemName(clip.items[0]!) : plural(ids.length)}: click to put ${ids.length === 1 ? 'it' : 'them'} down, Esc keeps ${ids.length === 1 ? 'it' : 'them'} on the clipboard (Ctrl+V)`);
}
