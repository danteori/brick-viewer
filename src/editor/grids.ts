// Grid editing (W-03 / W-04): a moving (dynamic) grid as a unit, and bricks between grids.
//
//   click     a brick of a dynamic grid focuses it and selects its whole grid (the bricks are tinted);
//             clicks on other bricks of the same grid only move the focus, so after Esc (selection
//             cleared) single bricks of the grid can be edited like any others
//   Move      the Move tool drags the selection; when it holds a whole grid, the grid's transform
//             moves with it (editor/move.ts), so the save moves the entity, not its bricks
//   R         with a whole grid selected: a quarter turn about world Z through the grid's origin
//             (Shift+R the other way)
//   panel     Brick Properties > Grid (ui/panels/grid.ts): select the grid, make a new grid from the
//             selection, move the selection into another grid, type the grid's location and rotation
//
// Every change is one undo step: the rows' records plus the grids' transforms (history.ts).
// Collision (collision.ts): bricks of different grids never block each other, so moving or turning
// a whole grid is never refused; bricks moved INTO a grid must not overlap that grid's bricks.

import { S, hasFocus } from '../app/state.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { histEnd, txBegin, txEnd } from '../scene/history.ts';
import { GRIDS } from '../scene/store.ts';
import { rowSolid, sceneHit } from '../scene/collision.ts';
import {
  eulerOfQuat, exactTurn, gridCounts, gridOfRow, gridSetOf, IDENT, isDynamicRow, placeGrid, quatOfEuler, rowsOfGrid, sameXf, shiftedXf, turnedXf, xfOf,
  type GridXf,
} from '../scene/dyngrids.ts';
import type { Vec3 } from '../scene/grids.ts';
import { effectiveIds, setSelection } from './select.ts';
import { componentBricks } from './selectops.ts';
import { keepZoom, selectBrick } from './resize.ts';
import { initAudio, playClick, playError, playSelect } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';

const plural = (n: number, w = 'brick'): string => `${n} ${w}${n === 1 ? '' : 's'}`;
function refuse(msg: string): false { setStatus(msg); initAudio(); playError(); return false; }

/** The grid of the focused brick (1 = the main grid), or 0 with no focus. */
export const focusedGrid = (): number => (hasFocus() ? gridOfRow(S.scene, S.sel) : 0);

/** The dynamic grid the selection is exactly (every brick of it and nothing else), or 0. Cached per scene revision and selection (the HUD asks every frame). */
let memo: { scene: unknown; rev: number; sel: unknown; n: number; g: number } | null = null;
export function selectedGrid(): number {
  const s = S.scene, n = S.selection.size;
  if (memo && memo.scene === s && memo.rev === s.rev && memo.sel === S.selection && memo.n === n) return memo.g;
  const g = findSelectedGrid();
  memo = { scene: s, rev: s.rev, sel: S.selection, n, g };
  return g;
}
function findSelectedGrid(): number {
  const s = S.scene, n = S.selection.size;
  if (!n || !gridSetOf(s)) return 0;
  const first = S.selection.values().next().value!;
  if (!isDynamicRow(s, first)) return 0;
  const g = gridOfRow(s, first), gi = s.grid[first]!;
  let count = 0;
  for (const id of S.selection) if (s.grid[id] !== gi) return 0;
  for (const id of s.ids()) if (s.grid[id] === gi) count++;
  return count === n ? g : 0;
}

/** Selects every brick of grid g; returns how many. */
export function selectGrid(g: number): number {
  const rows = rowsOfGrid(S.scene, g);
  setSelection(rows);
  return rows.length;
}

/** After a click moved the focus from `prev`: a brick of a dynamic grid reached from outside it selects its whole grid. */
export function gridClick(prev: number): void {
  const s = S.scene, id = S.sel;
  if (!isDynamicRow(s, id)) return;
  const g = gridOfRow(s, id);
  if (s.alive(prev) && gridOfRow(s, prev) === g) return;      // within the grid: the selection stays as it is
  const n = selectGrid(g);
  setStatus(`Grid ${g} selected (${plural(n)}): the Move tool (2) drags it, R turns it a quarter turn; Esc, then click, edits single bricks`);
}

/** Dynamic grids of which every brick is in `ids` (they move as a whole: their transforms follow). */
export function wholeGrids(ids: readonly number[]): number[] {
  const s = S.scene, set = gridSetOf(s);
  if (!set || !set.grids.size) return [];
  const tally = new Map<number, number>();
  for (const id of ids) if (isDynamicRow(s, id)) { const g = gridOfRow(s, id); tally.set(g, (tally.get(g) ?? 0) + 1); }
  if (!tally.size) return [];
  const counts = gridCounts(s);
  return [...tally].filter(([g, n]) => counts.get(g) === n).map(([g]) => g);
}

/** The Move drag shifted the moved bricks du units along axis i: whole grids' transforms follow. */
export function shiftGrids(grids: readonly number[], i: number, du: number): void {
  const set = gridSetOf(S.scene);
  if (!set) return;
  for (const g of grids) { const x = set.grids.get(g); if (x) set.grids.set(g, shiftedXf(x, i, du)); }
}

/** Refreshes the focused brick's record after its row changed under it (keeping the zoom). */
function refocus(): void {
  if (!hasFocus()) return;
  const keep = S.cam.half;
  selectBrick(S.sel);
  keepZoom(keep);
}

/** Runs `edit` on rows `ids` as one undo step (records and grid transforms), keeping the selection. */
function gridEdit(label: string, ids: readonly number[], edit: () => void, selAfter?: number[]): void {
  histEnd();
  const t = txBegin(label, ids, { selBefore: [...S.selection] });
  edit();
  if (selAfter) setSelection(selAfter);
  refocus();
  txEnd(t, { selAfter: [...S.selection] });
}

/** R with a whole dynamic grid selected: a quarter turn of the grid (dir 1 = R, -1 = Shift+R). False when no grid is selected. */
export function rotateSelectedGrid(dir: 1 | -1): boolean {
  const g = selectedGrid(), s = S.scene, set = gridSetOf(s);
  if (!g || !set) return false;
  const x = set.grids.get(g)!, rows = rowsOfGrid(s, g);
  gridEdit('turn grid', rows, () => placeGrid(s, g, x, turnedXf(x, dir), rows));
  initAudio(); playClick();
  setStatus(`Turned grid ${g} a quarter turn ${dir > 0 ? 'anticlockwise' : 'clockwise'} (seen from above)`);
  return true;
}

/** Rows among ids whose bricks may not leave their grid: components / wires name them by index. */
function pinned(ids: readonly number[]): number[] {
  const s = S.scene, set = gridSetOf(s), out = componentBricks(ids);
  if (set) for (const id of ids) if (isDynamicRow(s, id) && set.loaded.get(gridOfRow(s, id))?.components) out.push(id);
  return out;
}

/** "New grid": the selection (or the focused brick) becomes a new dynamic grid, where it is. */
export function newGridFromSelection(): boolean {
  const s = S.scene, set = gridSetOf(s);
  if (!set) return refuse('New grid: open a save or world first (the grid is written into it)');
  if (set.createProblem) return refuse(`Can't make a grid: ${set.createProblem}`);
  const ids = effectiveIds();
  if (!ids.length) return refuse('New grid: select the bricks first');
  const from = new Set(ids.map((id) => gridOfRow(s, id)));
  if (from.size > 1) return refuse('New grid: take the bricks from one grid at a time');
  if (pinned(ids).length) return refuse("New grid: some of these bricks carry components or wires (or their grid does), which can't change grid yet");
  const src = [...from][0]!, b = new Array<number>(6), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const id of ids) { s.box(id, b); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, b[i]!); hi[i] = Math.max(hi[i]!, b[i + 3]!); } }
  const origin = lo.map((v, i) => Math.round((v + hi[i]!) / 2)) as Vec3;
  // bricks from a turned grid keep its rotation (their local frame); from the main grid: none
  const was = set.grids.get(src);
  const xf: GridXf = { origin, frac: [0, 0, 0], quat: was ? [...was.quat] : [0, 0, 0, 1], R: was ? was.R : IDENT };
  const g = set.next++, gi = GRIDS.id(String(g));
  gridEdit('new grid', ids, () => {
    set.grids.set(g, xf);
    for (const id of ids) { s.grid[id] = gi; s.srcOrder[id] = -1; s.touch(id); }
  }, ids.slice());
  initAudio(); playSelect();
  setStatus(`New grid ${g} from ${plural(ids.length)} (frozen in place in the game); it's selected: the Move tool drags it, R turns it`);
  return true;
}

/** "Move to grid": the selection (or the focused brick) joins grid `target` (1 = the main grid), where it is. */
export function moveToGrid(target: number): boolean {
  const s = S.scene, set = gridSetOf(s);
  if (!set) return refuse('Open a save or world first');
  if (target !== 1 && !set.grids.has(target)) return refuse(`There is no grid ${target}`);
  const ids = effectiveIds().filter((id) => gridOfRow(s, id) !== target);
  if (!ids.length) return refuse(`Already in ${target === 1 ? 'the main grid' : 'grid ' + target}`);
  if (pinned(ids).length) return refuse("Move to grid: some of these bricks carry components or wires (or their grid does), which can't change grid yet");
  const name = String(target), skip = new Set(ids), b = new Array<number>(6);
  for (const id of ids) {
    s.box(id, b);
    const lo = [b[0]! * BRZ_UNIT, b[1]! * BRZ_UNIT, b[2]! * BRZ_UNIT], hi = [b[3]! * BRZ_UNIT, b[4]! * BRZ_UNIT, b[5]! * BRZ_UNIT];
    if (sceneHit(lo, hi, { grid: name, ignore: skip, solid: rowSolid(s, id) }) >= 0) {
      return refuse(`Move to grid: ${ids.length === 1 ? 'the brick' : 'a brick'} would overlap a brick of ${target === 1 ? 'the main grid' : 'grid ' + target}`);
    }
  }
  const gi = GRIDS.id(name);
  gridEdit('move to grid', ids, () => { for (const id of ids) { s.grid[id] = gi; s.srcOrder[id] = -1; s.touch(id); } });
  initAudio(); playClick();
  setStatus(`Moved ${plural(ids.length)} into ${target === 1 ? 'the main grid' : 'grid ' + target}`);
  return true;
}

/** The location (units) and yaw / pitch / roll (degrees) the Grid panel shows for grid g. */
export function gridFields(g: number): { location: Vec3; euler: [number, number, number]; exact: boolean } | null {
  const x = gridSetOf(S.scene)?.grids.get(g);
  if (!x) return null;
  const location = x.origin.map((v, i) => +(v + x.frac[i]!).toFixed(4)) as Vec3;
  return { location, euler: eulerOfQuat(x.quat), exact: exactTurn(x) };
}

/** The Grid panel's Apply: grid g placed at `location` (units) turned by yaw / pitch / roll (degrees). */
export function setGridTransform(g: number, location: Vec3, euler: [number, number, number]): boolean {
  const s = S.scene, set = gridSetOf(s), x = set?.grids.get(g);
  if (!set || !x) return refuse(`There is no grid ${g}`);
  if (![...location, ...euler].every(Number.isFinite)) return refuse('Grid: type numbers');
  const shown = eulerOfQuat(x.quat), sameTurn = euler.every((v, i) => Math.abs(v - shown[i]!) < 1e-4);
  const to = sameTurn ? { ...xfOf(location, x.quat, x.R), quat: x.quat } : xfOf(location, quatOfEuler(euler[0], euler[1], euler[2]));
  if (sameXf(to, x)) { setStatus(`Grid ${g}: nothing changed`); return true; }
  const rows = rowsOfGrid(s, g);
  gridEdit('grid transform', rows, () => placeGrid(s, g, x, to, rows));
  initAudio(); playClick();
  setStatus(`Grid ${g} placed at ${location.join(', ')}` + (exactTurn(to) ? '' : ' (drawn at the nearest quarter turn)'));
  return true;
}

/** HUD line while a whole grid is selected. */
export function gridHud(): string {
  const g = selectedGrid();
  return g ? `<b>grid ${g} selected</b> · the Move tool (2) drags it along an axis · R / Shift+R turn it a quarter turn · Brick Properties > Grid types its place · Esc, then click, edits single bricks` : '';
}
