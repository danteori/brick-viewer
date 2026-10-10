// Revision diff highlight (backlog W-05): box outlines over the bricks a world revision added
// (green), changed (amber) and removed (red, where they used to be), drawn on top of everything
// like the Box selector's outline. Only for the scene the diff was made for, at most MAX_DRAWN
// boxes a frame. Off unless the Revision row's Highlight box is ticked.

import { S } from '../../app/state.ts';
import { BRZ_UNIT } from '../../core/units.ts';
import { G as Gfx, setBox } from '../../render/draw.ts';
import { BOX_EDGE_COUNT, boxEB, boxIB } from '../../render/meshes/registry.ts';
import { worldHalfOf, type SceneStore } from '../../scene/store.ts';
import { fixedHalfOf, isFixedAsset, roundHalfOf } from '../../scene/view.ts';
import { BrickShapes } from '../../render/meshes/shapes.js';
import type { PlainBrick } from '../../format/world.ts';

/** Boxes drawn per frame at most (each is one draw call). */
export const MAX_DRAWN = 4000;

export type MarkKind = 'added' | 'changed' | 'removed';
const COLOUR: Record<MarkKind, [number, number, number]> = { added: [0.35, 0.95, 0.45], changed: [1, 0.78, 0.2], removed: [1, 0.3, 0.25] };

const marks = { boxes: null as Record<MarkKind, Float64Array> | null, owner: null as SceneStore | null, on: false };

/** A save brick's box, [x0, y0, z0, x1, y1, z1] in save units. */
export function plainBox(b: PlainBrick): number[] {
  const h0 = b.size ?? (BrickShapes.isRound(b.asset) ? roundHalfOf(b.asset) : isFixedAsset(b.asset) ? fixedHalfOf(b.asset) : [0, 0, 0]);
  const h = worldHalfOf(b.orient, h0[0]!, h0[1]!, h0[2]!);
  return [b.pos[0] - h[0], b.pos[1] - h[1], b.pos[2] - h[2], b.pos[0] + h[0], b.pos[1] + h[1], b.pos[2] + h[2]];
}

/** Sets the bricks to outline (null clears) for scene `owner`. */
export function setRevisionMarks(m: Record<MarkKind, readonly PlainBrick[]> | null, owner: SceneStore | null): void {
  if (!m) { marks.boxes = null; marks.owner = null; return; }
  const pack = (l: readonly PlainBrick[]): Float64Array => {
    const out = new Float64Array(l.length * 6);
    l.forEach((b, i) => out.set(plainBox(b), i * 6));
    return out;
  };
  marks.boxes = { added: pack(m.added), changed: pack(m.changed), removed: pack(m.removed) };
  marks.owner = owner;
}

export function showRevisionMarks(on: boolean): void { marks.on = on; }
/** How many boxes would be outlined now (0 when off or for another scene). */
export function revisionMarkCount(): number {
  const b = marks.boxes;
  return marks.on && b && marks.owner === S.scene ? (b.added.length + b.changed.length + b.removed.length) / 6 : 0;
}

function draw(): void {
  const b = marks.boxes;
  if (!marks.on || !b || marks.owner !== S.scene) return;
  const { gl, u } = Gfx, U = BRZ_UNIT;
  gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform1f(u.uEdge, 1); gl.uniform1f(u.uFadeR, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxEB);
  let left = MAX_DRAWN;
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (const k of ['removed', 'changed', 'added'] as const) {
    const c = COLOUR[k], a = b[k];
    gl.uniform4f(u.uLine, c[0], c[1], c[2], 0.9);
    for (let o = 0; o < a.length && left > 0; o += 6, left--) {
      for (let i = 0; i < 3; i++) { lo[i] = a[o + i]! * U; hi[i] = a[o + 3 + i]! * U; }
      setBox(lo, hi);
      gl.drawElements(gl.LINES, BOX_EDGE_COUNT, gl.UNSIGNED_SHORT, 0);
    }
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  gl.uniform4f(u.uLine, 0.05, 0.05, 0.08, 1);
  setBox(S.dlo, S.dhi);
}

export function initRevisionMarks(): void { S.hooks.draw.push(draw); }
