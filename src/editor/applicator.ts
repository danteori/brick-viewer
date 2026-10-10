// The applicator (backlog E-06): change the brick type (asset) or the material of the selection (or
// the focused brick), like the game's applicator. One undo step each; saving writes the new assets.
//
// Type changes follow scene/convert.ts (sizes kept between resizable types; fixed types take their
// own size). A brick is left as it is, and counted in the status line, when its size isn't on the
// target type's grid, when it carries components or wires (they belong to its type), or when its
// new shape would newly overlap a brick of its grid (collision.ts rules; overlaps it already had
// don't count, and the bricks being changed are tested against each other's new shapes).

import { S } from '../app/state.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { orientedBox, rowSolid, sceneHit, shapesOverlap, type IBox } from '../scene/collision.ts';
import { convertPlain, halfOf } from '../scene/convert.ts';
import { histEnd, txBegin, txEnd } from '../scene/history.ts';
import { isShaped, type Solid } from '../scene/hulls.ts';
import { GRIDS } from '../scene/store.ts';
import { plainOf, putPlain } from '../scene/view.ts';
import { effectiveIds } from './select.ts';
import { componentBricks } from './selectops.ts';
import { focusKeepZoom } from './ops.ts';
import { materialLabel, normalisePaint } from './paint.ts';
import { sceneTarget } from '../ui/panels/paint.ts';
import { shapeLabel } from '../ui/names.ts';
import { initAudio, playClick, playError } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';

export interface ApplyResult { changed: number; same: number; size: number; blocked: number; components: number }

const plural = (n: number, w: string): string => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

/** Changes the selection (or the focused brick) to brick type `asset`. */
export function applyType(asset: string): ApplyResult {
  const r: ApplyResult = { changed: 0, same: 0, size: 0, blocked: 0, components: 0 };
  const ids = effectiveIds();
  if (!ids.length || S.held) { setStatus('Nothing to change: focus or select a brick'); return r; }
  const s = S.scene, comps = new Set(componentBricks(ids));
  const done = new Set<number>(), placed: { box: IBox; solid: Solid | null; oldBox: IBox; oldSolid: Solid | null; grid: number }[] = [];
  const plan: { id: number; pb: ReturnType<typeof plainOf>; grid: string }[] = [];
  for (const id of ids) {
    const pb = plainOf(s, id), out = convertPlain(pb, asset);
    if ('skip' in out) { if (out.skip === 'same') r.same++; else r.size++; continue; }
    if (comps.has(id)) { r.components++; continue; }
    const nb = out.brick, box = orientedBox(nb.pos, halfOf(nb), nb.orient), solid: Solid | null = isShaped(asset) ? { asset, o: nb.orient, half: halfOf(nb), pos: nb.pos.slice() } : null;
    const oldBox = orientedBox(pb.pos, halfOf(pb), pb.orient), oldSolid = rowSolid(s, id), grid = s.grid[id]!, gname = GRIDS.name(grid);
    // the rest of the scene (rows already changed in this run are tested below, by their new shapes)
    const isNew = (k: number, b: readonly number[]): boolean => !shapesOverlap(oldBox, oldSolid, b, rowSolid(s, k));
    const lo = [box[0] * BRZ_UNIT, box[1] * BRZ_UNIT, box[2] * BRZ_UNIT], hi = [box[3] * BRZ_UNIT, box[4] * BRZ_UNIT, box[5] * BRZ_UNIT];
    let hit = sceneHit(lo, hi, { grid: gname, ignore: new Set([...done, id]), solid, test: isNew }) >= 0;
    if (!hit) hit = placed.some((p) => p.grid === grid && shapesOverlap(box, solid, p.box, p.solid) && !shapesOverlap(oldBox, oldSolid, p.oldBox, p.oldSolid));
    if (hit) { r.blocked++; continue; }
    done.add(id); placed.push({ box, solid, oldBox, oldSolid, grid });
    plan.push({ id, pb: { ...nb, linear: pb.linear, seq: pb.seq }, grid: gname });
  }
  if (plan.length) {
    histEnd();
    const keep = S.cam.half, sel = [...S.selection];
    const t = txBegin(plan.length === 1 ? 'change type' : 'change types', plan.map((p) => p.id), { selBefore: sel });
    for (const p of plan) putPlain(s, p.id, p.pb, p.pb.linear, p.grid);
    if (plan.some((p) => p.id === S.sel)) focusKeepZoom(S.sel, keep);
    txEnd(t, { selAfter: sel });
    r.changed = plan.length;
  }
  const left = [r.size && `${r.size} not on its size grid`, r.blocked && `${r.blocked} would overlap a brick`,
    r.components && `${r.components} with components or wires`, r.same && `${r.same} already that type`].filter(Boolean).join(', ');
  initAudio();
  if (r.changed) { playClick(); setStatus(`Changed ${plural(r.changed, 'brick')} to ${shapeLabel(asset)}${left ? ` · left as they are: ${left}` : ''}`); }
  else { if (!r.same || r.size || r.blocked || r.components) playError(); setStatus(`No brick changed to ${shapeLabel(asset)}${left ? `: ${left}` : ''}`); }
  return r;
}

/** Sets the material of the selection (or the focused brick), keeping colour and intensity. */
export function applyMaterial(material: string): number {
  const ids = effectiveIds();
  if (!ids.length || S.held) { setStatus('Nothing to change: focus or select a brick'); return 0; }
  histEnd();
  const t = txBegin('change material', ids);
  let n = 0;
  for (const id of ids) {
    const f = sceneTarget.get(id);
    if (!f || f.material === material) continue;
    sceneTarget.set(id, normalisePaint({ ...f, material }));
    n++;
  }
  if (ids.includes(S.sel)) focusKeepZoom(S.sel, S.cam.half);
  txEnd(t);
  initAudio();
  if (n) playClick();
  setStatus(n ? `Changed ${plural(n, 'brick')} to ${materialLabel(material)}` : `Already ${materialLabel(material)}`);
  return n;
}
