// Scene edits: place the ghost, delete the focused brick, and their undo / redo. Each is one edit
// transaction (scene/history.ts) over the rows it adds or removes; `list` marks the ones that add or
// remove bricks, whose undo keeps the on-screen zoom like the legacy viewer did.

import { S, hasFocus } from '../app/state.ts';
import { r3 } from '../core/units.ts';
import { cloneBrick, type Brick, type V3 } from '../scene/brick.ts';
import { histEnd, txBegin, txEnd } from '../scene/history.ts';
import { carriedComponents, componentsOf, shortType } from '../scene/compmodel.ts';
import { addBrick, brickView, centreOf } from '../scene/view.ts';
import { keepZoom, selectBrick } from './resize.ts';
import { pruneSelection, setSelection } from './select.ts';
import { ed, endPlacing, ghostName, itemName, poseGhost } from './ghost.ts';
import { initAudio, playClick, playDelete, playError, playPaste } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';

/** transactions that add or remove bricks: their undo / redo keeps the on-screen zoom */
export const listTx = new WeakSet<object>();

/** focus brick id (if it's live), keeping the on-screen zoom; an empty scene keeps a detached box */
export function focusKeepZoom(id: number, keep = S.cam.half): void {
  if (!S.scene.alive(id)) { selectBrick(-1); return; }
  selectBrick(id);
  keepZoom(keep);
}

export function initOps(): void {
  let keep = 0;
  S.hooks.beforeTx.push(() => { endPlacing(); keep = S.cam.half; });
  S.hooks.afterTx.push((t, side) => {
    if (listTx.has(t) && S.scene.alive(S.sel)) keepZoom(keep);
    if (t.kind === 'scene') setSelection([]);                              // another scene: its own ids
    else if (t.kind === 'data') { /* the selection stays */ }
    else if (t.selBefore || t.selAfter) setSelection((side === 'before' ? t.selBefore : t.selAfter) ?? []);
    else pruneSelection();
  });
  S.hooks.beforeLoad.push(() => { endPlacing(); setSelection([]); });
}

/** Component types a paste could not carry over (last addBricks; not types of this save, say). */
export let lastUncarried: string[] = [];

/**
 * Adds bricks (absolute faces) as one undo step; returns their ids. Bricks with carried components
 * (a paste, C-04) get them, and a place in the save, inside the same step (the records take the
 * place along; undoing the paste orphans the components, which saving then leaves out).
 */
export function addBricks(bricks: readonly Brick[], label: string, focus: 'first' | 'keep' = 'first'): number[] {
  histEnd();
  const keep = S.cam.half, ids: number[] = [];
  const t = txBegin(label, []);
  for (const b of bricks) ids.push(addBrick(S.scene, b));
  lastUncarried = [];
  const m = componentsOf(S.scene);
  bricks.forEach((b, j) => {
    if (b.comps === undefined) return;
    const list = carriedComponents(b.comps);
    lastUncarried.push(...(m ? m.attachCarried(ids[j]!, list) : list.map((c) => c.type)));
  });
  t.ids = ids; t.beforeHas = new Uint8Array(ids.length);
  if (focus === 'first' && ids.length) focusKeepZoom(ids[0]!, keep);
  listTx.add(t); txEnd(t);
  return ids;
}

export function placeGhost(): boolean {
  const G = ed.ghost;
  if (!G) return false;
  poseGhost();
  if (!G.pose) return false;
  if (!G.valid) { setStatus(`Can't place ${ghostName(G.items)} here: ${G.reason}`); initAudio(); playError(); return false; }
  if (G.onPlace) return G.onPlace(G);
  const p = G.pose;
  const placed = G.items.filter((_, j) => !G.skip[j]), skipped = G.items.length - placed.length;   // a paste drops overlapping bricks
  const bricks = placed.map((t) => {
    const b = cloneBrick(t);
    b.lo = t.lo.map((v, i) => r3(v + p[i]!)) as V3; b.hi = t.hi.map((v, i) => r3(v + p[i]!)) as V3;
    return b;
  });
  const ids = addBricks(bricks, G.label);
  if (G.drop && ids.length > 1) setSelection(ids);            // a pasted group stays selected
  ed.lastPlaceT = performance.now();
  initAudio(); if (G.drop) playPaste(); else playClick();
  setStatus(G.drop
    ? `Pasted ${G.items.length === 1 ? ghostName(placed) : `${placed.length} brick${placed.length === 1 ? '' : 's'}`}${skipped ? ` (${skipped} skipped: overlapping)` : ''}` +
      (lastUncarried.length ? ` · ${lastUncarried.length} component${lastUncarried.length === 1 ? '' : 's'} left behind (${[...new Set(lastUncarried)].map(shortType).join(', ')}: this save can't take them)` : '')
    : `Placed ${ghostName(G.items)}`);
  return true;
}

/** The live brick whose centre is nearest to `c` (viewer units), not in `except`; -1 when none. */
export function nearestBrick(c: readonly number[], except: ReadonlySet<number>): number {
  const s = S.scene;
  let best = -1, bd = Infinity;
  for (const id of s.ids()) {
    if (except.has(id)) continue;
    const m = centreOf(s, id), d = (m[0] - c[0]!) ** 2 + (m[1] - c[1]!) ** 2 + (m[2] - c[2]!) ** 2;
    if (d < bd || (d === bd && s.order[id]! < s.order[best]!)) { bd = d; best = id; }
  }
  return best;
}

export function deleteFocused(): void {
  if (S.held || !hasFocus()) return;
  histEnd();
  const k = S.sel, name = itemName(S.focus!), c = centreOf(S.scene, k);
  const nb = nearestBrick(c, new Set([k])), keep = S.cam.half;   // the nearest brick (by centre) takes the focus
  const t = txBegin('delete brick', [k]);
  S.scene.remove(k);
  focusKeepZoom(nb, keep);
  listTx.add(t); txEnd(t);
  initAudio(); playDelete();
  setStatus(S.scene.count ? `Deleted ${name}` : `Deleted ${name}: the scene is empty, drag a brick in from Bricks`);
}

/** A brick's record (absolute faces) by id. */
export const brickOf = (id: number): Brick => brickView(S.scene, id);
