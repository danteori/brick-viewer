// The mirror tool (backlog U-18 / E-14): Alt+X / Alt+Y (or the Selection panel's Mirror X / Mirror Y)
// mirror the placement ghost when one is out, else the selection (or the focused brick) in place,
// across world X or Y about the middle of its box. Each brick swaps to its mirror twin where one
// exists, else takes the orientation that mirrors it exactly, else the closest one
// (scene/mirror.ts); the status line names any asset that couldn't be mirrored exactly.
//
// In place, the mirrored bricks must not newly collide with other bricks of their grid
// (collision.ts rules, the bricks being mirrored don't block themselves), and a brick carrying
// components or wires may not leave its save chunk. The whole mirror is one undo step.

import { S } from '../app/state.ts';
import { r3 } from '../core/units.ts';
import type { V3 } from '../scene/brick.ts';
import { itemHits } from '../scene/collision.ts';
import { histEnd, txBegin, txEnd } from '../scene/history.ts';
import { mirrorGroup, type MirrorAxis } from '../scene/mirror.ts';
import { saveChunkOf } from '../scene/remap.ts';
import { writeBrick } from '../scene/view.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { ed, ghostItemsChanged, ghostName, gsize, itemName } from './ghost.ts';
import { effectiveIds, selectionBox } from './select.ts';
import { componentBricks, groupItems } from './selectops.ts';
import { focusKeepZoom } from './ops.ts';
import { isTyping } from './input.ts';
import { initAudio, playClick, playError } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';

const NAME = ['X', 'Y', 'Z'];

function inexactNote(set: Set<string>): string {
  if (!set.size) return '';
  const list = [...set].map((a) => a.replace(/^PB_Default|^PB_|^BP_|^B_/, ''));
  console.info('[mirror] no exact mirror image (closest orientation used):', [...set].join(', '));
  return ` · closest orientation for ${list.join(', ')} (no exact mirror image)`;
}

function refuse(msg: string): false { setStatus(msg); initAudio(); playError(); return false; }

/** Mirrors the ghost, else the selection / focused brick, across world `axis`. Returns whether anything was mirrored. */
export function mirror(axis: MirrorAxis): boolean {
  if (S.held || S.move) return false;
  const inexact = new Set<string>(), G = ed.ghost;
  if (G) {
    const w = gsize(G.items)[axis];
    G.items = mirrorGroup(G.items, axis, inexact).bricks;
    if (G.anchor) G.anchor[axis] = r3(w - G.anchor[axis]!);
    ghostItemsChanged();
    initAudio(); playClick();
    setStatus(`Mirrored ${ghostName(G.items)} across ${NAME[axis]}` + inexactNote(inexact));
    return true;
  }
  const ids = effectiveIds();
  if (!ids.length) { setStatus('Nothing to mirror: focus or select a brick, or hold one to place'); return false; }
  const box = selectionBox(ids)!, corner = box.lo;
  const items = groupItems(ids, true), { bricks, orients } = mirrorGroup(items, axis, inexact);
  const abs = bricks.map((t) => {
    const b = { ...t, lo: t.lo.map((v, i) => r3(v + corner[i]!)) as V3, hi: t.hi.map((v, i) => r3(v + corner[i]!)) as V3 };
    return b;
  });
  // components: their bricks must stay in their save chunk
  const comps = new Set(componentBricks(ids)), s = S.scene;
  for (let j = 0; j < ids.length; j++) {
    const id = ids[j]!;
    if (!comps.has(id)) continue;
    const c = [0, 1, 2].map((i) => Math.round((abs[j]!.lo[i]! + abs[j]!.hi[i]!) / 2 / BRZ_UNIT));
    if (saveChunkOf(c) !== saveChunkOf([s.px[id]!, s.py[id]!, s.pz[id]!])) return refuse(`Can't mirror: a brick with components or wires would leave its save chunk`);
  }
  const ignore = new Set(ids), zero = [0, 0, 0];
  const hit = abs.findIndex((b) => itemHits(zero, b, ignore));
  if (hit >= 0) return refuse(`Can't mirror ${ids.length === 1 ? itemName(abs[0]!) : `${ids.length} bricks`} across ${NAME[axis]}: ${ids.length === 1 ? 'it' : 'they'} would overlap a brick`);
  histEnd();
  const keep = S.cam.half, sel = [...S.selection];
  const t = txBegin(ids.length === 1 ? 'mirror brick' : 'mirror bricks', ids, { selBefore: sel });
  ids.forEach((id, j) => writeBrick(s, id, abs[j]!, true, orients[j]!));
  if (ids.includes(S.sel)) focusKeepZoom(S.sel, keep);
  const changed = txEnd(t, { selAfter: sel });
  initAudio(); playClick();
  setStatus((changed ? `Mirrored ${ids.length === 1 ? itemName(abs[0]!) : `${ids.length} bricks`} across ${NAME[axis]}` : `Mirrored across ${NAME[axis]}: it looks the same`) + inexactNote(inexact));
  return true;
}

export function initMirror(): void {
  addEventListener('keydown', (e) => {
    if (isTyping(e.target) || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
    const axis = e.code === 'KeyX' ? 0 : e.code === 'KeyY' ? 1 : -1;
    if (axis < 0) return;
    e.preventDefault();
    mirror(axis as MirrorAxis);
  });
}
