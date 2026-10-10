// The Move tool (E-02): the Resize drag, moving instead of resizing. The drag code is resize.ts's
// own (axis pick, step snapping, pendAxis / lockAxis / bannedAxis, right-click commit, edge
// auto-drag, release commits); while S.move is set, a step shifts the whole focused brick, or the
// whole selection, along the axis by the focused brick's grid step (studs, plates or micros)
// instead of moving one face.
//
// Collision: a step that would put any moved brick into another brick of its grid stops the move
// at the last free offset; the moved bricks never block themselves. A brick that carries
// components or wires may not leave its 2048-unit save chunk (scene/remap.ts), which stops the move
// the same way. The whole drag, right-click commits included, is one undo step.

import { S, type EditTx } from '../app/state.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { boxesOverlap } from '../scene/collision.ts';
import { pickReady } from '../scene/spatial.ts';
import { histEnd, txBegin, txEnd } from '../scene/history.ts';
import { brickView } from '../scene/view.ts';
import { saveChunkOf } from '../scene/remap.ts';
import { componentBricks } from './selectops.ts';

export interface MoveState {
  ids: number[];
  set: Set<number>;
  tx: EditTx;
  /** bricks with components / wires among ids (they may not leave their save chunk) */
  comps: number[];
  /** the moved bricks' world box (absolute viewer units) before the drag */
  lo: number[]; hi: number[];
  /** the last refusal: 'collision' or 'components' */
  blocked: string;
}

/** The bricks a Move drag takes: the selection when there is one, else the focused brick. */
export function moveIds(): number[] {
  if (S.selection.size) return S.scene.ordered().filter((id) => S.selection.has(id));
  return S.scene.alive(S.sel) ? [S.sel] : [];
}

/** Starts a Move drag (its undo step opens here). */
export function beginMove(): MoveState | null {
  const ids = moveIds();
  if (!ids.length) return null;
  histEnd();
  const s = S.scene, b = new Array<number>(6), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const id of ids) { s.box(id, b); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, b[i]! * BRZ_UNIT); hi[i] = Math.max(hi[i]!, b[i + 3]! * BRZ_UNIT); } }
  S.move = { ids, set: new Set(ids), tx: txBegin(ids.length === 1 ? 'move brick' : 'move bricks', ids, { selBefore: [...S.selection] }), comps: componentBricks(ids), lo, hi, blocked: '' };
  return S.move;
}

/** Units one step along axis i is (the focused brick's grid). */
export const stepUnits = (i: number): number => Math.round(S.STEPS[i]! / BRZ_UNIT);

/** Would the moved bricks, shifted `n` steps along axis i, collide (or take a component brick out of its chunk)? */
function blockedAt(m: MoveState, i: number, n: number): string {
  if (!n) return '';
  const s = S.scene, du = n * stepUnits(i), ob = new Array<number>(6), b = new Array<number>(6), q = new Array<number>(6), G = pickReady(), U = 1 / BRZ_UNIT;
  for (const id of m.comps) {
    const p = [s.px[id]!, s.py[id]!, s.pz[id]!], np = p.slice();
    np[i] = np[i]! + du;
    if (saveChunkOf(p) !== saveChunkOf(np)) return 'components';
  }
  for (const id of m.ids) {
    s.box(id, ob); for (let j = 0; j < 6; j++) b[j] = ob[j]!;
    b[i] = b[i]! + du; b[i + 3] = b[i + 3]! + du;
    const grid = s.grid[id];
    const cell = (u: number, k: number): number => Math.max(0, Math.min(G.dim[k]! - 1, Math.floor((u * BRZ_UNIT - G.org[k]!) / G.cs)));
    const c0 = [cell(b[0]!, 0), cell(b[1]!, 1), cell(b[2]!, 2)], c1 = [cell(b[3]!, 0), cell(b[4]!, 1), cell(b[5]!, 2)];
    const stamp = ++G.q;
    for (let z = c0[2]!; z <= c1[2]!; z++) for (let y = c0[1]!; y <= c1[1]!; y++) for (let x = c0[0]!; x <= c1[0]!; x++) {
      const ks = G.cells[(z * G.dim[1]! + y) * G.dim[0]! + x];
      if (!ks) continue;
      for (const k of ks) {
        if (G.stamp[k] === stamp) continue;
        G.stamp[k] = stamp;
        if (m.set.has(k) || !s.alive(k) || s.grid[k] !== grid) continue;
        for (let j = 0; j < 6; j++) q[j] = Math.round(G.box[k * 6 + j]! * U);
        // only new overlaps count: a pair that already overlapped where it was never locks the move
        if (boxesOverlap(b, q) && !boxesOverlap(ob, q)) return 'collision';
      }
    }
  }
  return '';
}

/**
 * The largest pending offset (steps) from `from` toward `want` along axis i that is free; notes why
 * it stopped. Every step in between is checked, so a move can't jump through a brick.
 */
export function moveFree(i: number, from: number, want: number): number {
  const m = S.move!;
  m.blocked = '';
  const dir = Math.sign(want - from);
  let ok = from;
  for (let n = from + dir; dir && (dir > 0 ? n <= want : n >= want); n += dir) {
    const why = blockedAt(m, i, n);
    if (why) { m.blocked = why; break; }
    ok = n;
  }
  return ok;
}

/** Shifts the moved bricks `n` steps along axis i (a commit of the pending step). */
export function applyMove(i: number, n: number): void {
  const m = S.move, s = S.scene;
  if (!m || !n) return;
  const du = n * stepUnits(i);
  for (const id of m.ids) {
    if (i === 0) s.px[id] = s.px[id]! + du; else if (i === 1) s.py[id] = s.py[id]! + du; else s.pz[id] = s.pz[id]! + du;
    s.touch(id);
  }
  for (const a of [m.lo, m.hi]) a[i] = +(a[i]! + du * BRZ_UNIT).toFixed(3);
  if (m.set.has(S.sel)) {                                  // the focused brick: its record and faces follow
    const b = brickView(s, S.sel);
    S.focus = Object.assign(S.focus!, b, { lo: S.lo, hi: S.hi });
    S.lo.splice(0, 3, ...b.lo); S.hi.splice(0, 3, ...b.hi);
  }
}

/** Ends the drag: its undo step (nothing recorded when nothing moved). */
export function endMove(): void {
  const m = S.move;
  if (!m) return;
  S.move = null;
  txEnd(m.tx, { selAfter: [...S.selection] });
}

/** [lo, hi] of what moves (the selection's box), shifted by the pending step: for the ghost. */
export function movedBox(): [number[], number[]] | null {
  const m = S.move;
  if (!m) return null;
  const lo = m.lo.slice(), hi = m.hi.slice();
  if (S.pendAxis >= 0) { const d = S.pendUnits * S.STEPS[S.pendAxis]!; lo[S.pendAxis] = +(lo[S.pendAxis]! + d).toFixed(3); hi[S.pendAxis] = +(hi[S.pendAxis]! + d).toFixed(3); }
  return [lo, hi];
}
