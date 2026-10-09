// Scene edits: place the ghost, delete the focused brick, and their undo / redo. One 'list'
// transaction each: { kind:'list', label, adds:[[index, snap]], removes:[[index, snap]], selBefore,
// selAfter } with frame-independent snapshots (snapBrick: local + histOrigin).

import { S, type ListTx } from '../app/state.ts';
import { r3 } from '../core/units.ts';
import { cloneBrick, type Brick, type V3 } from '../scene/brick.ts';
import { histEnd, histPush, snapBrick } from '../scene/history.ts';
import { instAll } from '../render/instances.ts';
import { keepZoom, selectBrick } from './resize.ts';
import { ed, endPlacing, ghostName, itemName, poseGhost } from './ghost.ts';
import { initAudio, playClick, playDelete, playError, playPaste } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';

function fromSnap(s: Brick): Brick {
  const b = cloneBrick(s);
  b.lo = s.lo.map((v, i) => r3(v - S.histOrigin[i])) as V3; b.hi = s.hi.map((v, i) => r3(v - S.histOrigin[i])) as V3;
  return b;
}

/** focus brick k (clamped), keeping the on-screen zoom; an empty scene keeps a detached box */
function focusKeepZoom(k: number, keep = S.cam.half): void {
  if (!S.bricks.length) {
    S.sel = 0; S.lo = S.lo.slice() as V3; S.hi = S.hi.slice() as V3;
    S.pendAxis = -1; S.pendUnits = 0; S.lockAxis = -1; S.lastAxis = -1;
    return;
  }
  selectBrick(Math.max(0, Math.min(S.bricks.length - 1, k)));
  keepZoom(keep);
}

export function applyList(t: ListTx, side: 'before' | 'after'): void {
  endPlacing();
  const ins = side === 'after' ? t.adds : t.removes, del = side === 'after' ? t.removes : t.adds;
  for (const [k] of [...del].sort((a, b) => b[0] - a[0])) S.bricks.splice(k, 1);
  for (const [k, s] of [...ins].sort((a, b) => a[0] - b[0])) S.bricks.splice(k, 0, fromSnap(s));
  instAll();                                // indices moved: re-upload the instance buffers (and the pick grid)
  focusKeepZoom(side === 'after' ? t.selAfter : t.selBefore);
}

export function placeGhost(): boolean {
  const G = ed.ghost;
  if (!G) return false;
  poseGhost();
  if (!G.pose) return false;
  if (!G.valid) { setStatus(`Can't place ${ghostName(G.items)} here: ${G.reason}`); initAudio(); playError(); return false; }
  histEnd();
  const p = G.pose, selBefore = S.sel, base = S.bricks.length, keep = S.cam.half;
  const placed = G.items.filter((_, j) => !G.skip[j]), skipped = G.items.length - placed.length;   // a paste drops overlapping bricks
  for (const t of placed) {
    const b = cloneBrick(t);
    b.lo = t.lo.map((v, i) => r3(v + p[i])) as V3; b.hi = t.hi.map((v, i) => r3(v + p[i])) as V3;
    S.bricks.push(b);
  }
  const adds = placed.map((_, j): [number, Brick] => [base + j, snapBrick(base + j)]);
  histPush({ kind: 'list', label: G.label, adds, removes: [], selBefore, selAfter: base });   // one undo step
  instAll();
  focusKeepZoom(base, keep);
  ed.lastPlaceT = performance.now();
  initAudio(); if (G.drop) playPaste(); else playClick();
  setStatus(G.drop
    ? `Pasted ${G.items.length === 1 ? ghostName(placed) : `${placed.length} brick${placed.length === 1 ? '' : 's'}`}${skipped ? ` (${skipped} skipped: overlapping)` : ''}`
    : `Placed ${ghostName(G.items)}`);
  return true;
}

export function deleteFocused(): void {
  if (S.held || !S.bricks[S.sel]) return;
  histEnd();
  const k = S.sel, snap = snapBrick(k), name = itemName(S.bricks[k]);
  const mid = (b: Brick): number[] => [0, 1, 2].map((i) => (b.lo[i] + b.hi[i]) / 2), c = mid(S.bricks[k]);
  let best = -1, bd = Infinity;                  // the nearest brick (by centre) takes the focus
  for (let j = 0; j < S.bricks.length; j++) {
    if (j === k) continue;
    const m = mid(S.bricks[j]), d = (m[0] - c[0]) ** 2 + (m[1] - c[1]) ** 2 + (m[2] - c[2]) ** 2;
    if (d < bd) { bd = d; best = j; }
  }
  const nb = best < 0 ? 0 : best > k ? best - 1 : best, keep = S.cam.half;
  S.bricks.splice(k, 1);
  histPush({ kind: 'list', label: 'delete brick', adds: [], removes: [[k, snap]], selBefore: k, selAfter: nb });
  instAll();
  focusKeepZoom(nb, keep);
  initAudio(); playDelete();
  setStatus(S.bricks.length ? `Deleted ${name}` : `Deleted ${name}: the scene is empty, drag a brick in from Bricks`);
}
