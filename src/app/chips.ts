import { S } from './state.ts';
import { setExtraStores } from '../render/extras.ts';
import { boardOf, chipBricks, CHIP_ASSET, defaultOpen, fillBoardStore, readChips, type Board, type Chip, type ChipBrick } from '../scene/chips.ts';
import { filesOf } from '../scene/load.ts';
import { ASSETS, SceneStore } from '../scene/store.ts';

const KEY = 'chips';

interface ChipState {
  chips: Chip[];
  chipOfRow: Map<number, Chip>;
  open: Set<number>;
  inner: Map<number, ChipBrick[]>;
  shown: string;
  boards: Board[];
  rowItems: Map<number, ChipBrick>;
  store: SceneStore | null;
  rev: number;
}

const states = new WeakMap<SceneStore, ChipState>();
let drawn: SceneStore | null = null;

function mapRows(scene: SceneStore, chips: readonly Chip[]): Map<number, Chip> {
  const out = new Map<number, Chip>(), asset = ASSETS.id(CHIP_ASSET);
  if (!chips.length) return out;
  const at = new Map(chips.filter((c) => c.parent === 1).map((c) => [c.pos.join(','), c]));
  for (let id = 0; id < scene.n; id++) {
    if (!scene.alive(id) || scene.asset[id] !== asset) continue;
    const c = at.get(`${scene.px[id]},${scene.py[id]},${scene.pz[id]}`);
    if (c) out.set(id, c);
  }
  return out;
}

function stateOf(scene: SceneStore): ChipState | null {
  let st = states.get(scene);
  if (st) return st;
  const files = filesOf(scene);
  if (!files) return null;
  let chips: Chip[] = [];
  try { chips = readChips(files); } catch (err) { console.warn('microchips not read', err); }
  st = { chips, chipOfRow: mapRows(scene, chips), open: new Set(defaultOpen(chips)), inner: new Map(), shown: '', boards: [], rowItems: new Map(), store: null, rev: 0 };
  states.set(scene, st);
  return st;
}

/** The microchip that outer-scene row `row` is, or null. */
export const chipForRow = (row: number): Chip | null => stateOf(S.scene)?.chipOfRow.get(row) ?? null;

export const isChipOpen = (chip: Chip): boolean => stateOf(S.scene)?.open.has(chip.grid) ?? false;

export function setChipOpen(chip: Chip, open: boolean): void {
  const st = stateOf(S.scene);
  if (!st) return;
  if (open) st.open.add(chip.grid); else st.open.delete(chip.grid);
}

/** The open boards of the current scene. */
export const openBoards = (): readonly Board[] => stateOf(S.scene)?.boards ?? [];

function innerOf(st: ChipState, scene: SceneStore, chip: Chip): ChipBrick[] {
  let list = st.inner.get(chip.grid);
  if (!list) {
    const files = filesOf(scene);
    try { list = files ? chipBricks(files, chip) : []; } catch (err) { console.warn(`chip ${chip.grid} not read`, err); list = []; }
    st.inner.set(chip.grid, list);
  }
  return list;
}

/** Builds the open boards when the open set (or the scene) changed. Call once a frame. */
export function tickChips(): void {
  const scene = S.scene, st = stateOf(scene);
  if (!st) { if (drawn) { setExtraStores([], null, KEY); drawn = null; } return; }
  const key = [...st.open].sort((a, b) => a - b).join(',');
  if (drawn === scene && key === st.shown) return;
  if (!st.chips.length && !drawn) { st.shown = key; return; }
  const store = new SceneStore();
  st.boards = []; st.rowItems = new Map();
  for (const chip of st.chips) {
    if (!st.open.has(chip.grid) || chip.parent !== 1) continue;
    const board = boardOf(chip, innerOf(st, scene, chip));
    st.boards.push(board);
    for (const [row, item] of fillBoardStore(store, board)) st.rowItems.set(row, item);
  }
  store.drain();
  st.store = store; st.rev++;
  setExtraStores(st.boards.length ? [{ store, origin: [0, 0, 0] }] : [], scene, KEY);
  st.shown = key; drawn = scene;
}

/** Changes when the shown boards change (overlays redraw on it). */
export const boardRev = (): number => states.get(S.scene)?.rev ?? 0;

/** An inner brick on an open board: its place in the chip's grid and its box in save units. */
export interface BoardPick {
  ref: ChipBrick['ref'];
  box: ArrayLike<number>;
}

/** The inner bricks on the open boards of the current scene. */
export function boardBricks(): BoardPick[] {
  const st = states.get(S.scene);
  if (!st?.store) return [];
  const out: BoardPick[] = [];
  for (const [row, item] of st.rowItems) out.push({ ref: item.ref, box: st.store.box(row, new Array<number>(6)) });
  return out;
}

/** The row of the chip brick that holds microchip grid `grid` in the main grid, or -1. */
export function rowOfChipGrid(grid: number): number {
  for (const [row, chip] of stateOf(S.scene)?.chipOfRow ?? []) if (chip.grid === grid && S.scene.alive(row)) return row;
  return -1;
}
