
import type { FileMap } from '../format/brz.ts';
import { decodeWritten, fileMapView, writtenGlobalData, type SaveView } from '../format/saveview.ts';
import { decodeBrickChunk, type BrickChunk, type GlobalData, type PlainBrick } from '../format/world.ts';
import type { BrickRef, ChunkKey } from './components.ts';
import type { SceneStore } from './store.ts';
import { fixedHalfOf, putPlain, supportedAsset } from './view.ts';
import { buildWorldModel, type Grid, type GridChunk, type Vec3 } from './grids.ts';

export const CHIP_ASSET = 'B_1x1_Microchip';

export interface Chip {
  /** the chip's inner grid (persistent index) */
  grid: number;
  /** the grid the chip brick sits on */
  parent: number;
  /** the chip brick's place in its outer grid */
  ref: BrickRef;
  /** the chip brick: grid-local centre and orientation byte */
  pos: Vec3;
  orient: number;
  collapsed: boolean;
  planeCenter: Vec3;
  planeExtent: Vec3;
}

export interface ChipBrick {
  ref: BrickRef;
  brick: PlainBrick;
  linear: boolean;
}

interface XYZ { X?: number; Y?: number; Z?: number }
const vec = (v: unknown, fallback: Vec3): Vec3 => {
  const o = v as XYZ | undefined;
  return o ? [o.X ?? 0, o.Y ?? 0, o.Z ?? 0] : fallback;
};

function decodeChunk(view: SaveView, chunk: GridChunk): { bricks: PlainBrick[]; linear: boolean } | null {
  if (!chunk.bricks) return null;
  const f = decodeWritten(view, chunk.bricks), g = writtenGlobalData<GlobalData>(view, chunk.bricks);
  if (!g) return null;
  const root = f.root as BrickChunk & { bColorsAreLinear?: boolean };
  return { bricks: decodeBrickChunk(root, f.schema, g, chunk.centre), linear: root.bColorsAreLinear !== false };
}

const chunkKey = (c: GridChunk): ChunkKey => ({ X: c.index[0], Y: c.index[1], Z: c.index[2] });

/** The microchips of a save, in the order their chip bricks are stored. */
export function readChips(files: FileMap): Chip[] {
  const view = fileMapView(files), model = buildWorldModel(view), byId = new Map<number, Grid>(model.grids.map((g) => [g.id, g]));
  const out: Chip[] = [];
  for (const g of model.grids) {
    for (const c of g.chunks) {
      if (!c.components || !c.numComponents) continue;
      const root = decodeWritten(view, c.components).root as Record<string, unknown>;
      const idx = root.MicrochipBrickIndices as number[] | undefined, refs = root.MicrochipBrickGridReferences as number[] | undefined;
      if (!idx?.length || !refs) continue;
      const decoded = decodeChunk(view, c);
      if (!decoded) continue;
      idx.forEach((bi, j) => {
        const inner = byId.get(refs[j]!), pb = decoded.bricks[bi];
        if (!inner || inner.kind !== 'microchip' || !pb) return;
        const d = (inner.entity?.data ?? {}) as Record<string, unknown>;
        out.push({
          grid: inner.id, parent: g.id, ref: { grid: g.id, chunk: chunkKey(c), brick: bi }, pos: [...pb.pos], orient: pb.orient,
          collapsed: d.bCollapsed === true, planeCenter: vec(d.PlaneCenter, [0, 0, 0]), planeExtent: vec(d.PlaneExtent, [0, 0, 0]),
        });
      });
    }
  }
  return out;
}

/** The bricks inside chip `chip`, each with its place in the inner grid, in grid-local units. */
export function chipBricks(files: FileMap, chip: Chip): ChipBrick[] {
  const view = fileMapView(files), grid = buildWorldModel(view).grids.find((g) => g.id === chip.grid);
  const out: ChipBrick[] = [];
  if (!grid) return out;
  for (const c of grid.chunks) {
    const d = decodeChunk(view, c);
    if (!d) continue;
    d.bricks.forEach((brick, n) => out.push({ ref: { grid: grid.id, chunk: chunkKey(c), brick: n }, brick, linear: d.linear }));
  }
  return out;
}

/** Chips that start open: those the save did not collapse, unless the save has too many to show at once. */
export const AUTO_OPEN_MAX = 8;
export function defaultOpen(chips: readonly Chip[]): number[] {
  return chips.length <= AUTO_OPEN_MAX ? chips.filter((c) => !c.collapsed).map((c) => c.grid) : [];
}

export const BOARD_LIFT = 60;
const SURFACE_HALF_Z = 1;
const BEAM_HALF_XY = 1;
const SURFACE_COLOUR: [number, number, number, number] = [30, 200, 255, 5];

export interface BoardBrick {
  item: ChipBrick;
  pos: Vec3;
}

export interface Board {
  chip: Chip;
  /** the board plane's centre in the chip's outer grid */
  origin: Vec3;
  bricks: BoardBrick[];
  surface: PlainBrick;
  beam: PlainBrick;
}

const holo = (pos: Vec3, size: Vec3): PlainBrick => ({
  asset: 'PB_DefaultBrick', size, pos, orient: 16, color: SURFACE_COLOUR, material: 'BMC_Hologram',
});

/** Where the open board of `chip` floats and where each inner brick sits on it (outer-grid units). */
export function boardOf(chip: Chip, inner: readonly ChipBrick[], chipHalfZ = fixedHalfOf(CHIP_ASSET)[2]): Board {
  const origin: Vec3 = [chip.pos[0], chip.pos[1], chip.pos[2] + chipHalfZ + BOARD_LIFT];
  const pc = chip.planeCenter;
  const bricks = inner.map((item) => ({
    item,
    pos: [0, 1, 2].map((i) => Math.round(origin[i]! + item.brick.pos[i]! - pc[i]!)) as Vec3,
  }));
  const ex = Math.max(1, Math.round(chip.planeExtent[0])), ey = Math.max(1, Math.round(chip.planeExtent[1]));
  const surfaceTop = origin[2];
  const surface = holo([origin[0], origin[1], surfaceTop - SURFACE_HALF_Z], [ex, ey, SURFACE_HALF_Z]);
  const beamBottom = chip.pos[2] + chipHalfZ, beamTop = surfaceTop - 2 * SURFACE_HALF_Z;
  const beamHalf = Math.max(1, Math.floor((beamTop - beamBottom) / 2));
  const beam = holo([chip.pos[0], chip.pos[1], beamBottom + beamHalf], [BEAM_HALF_XY, BEAM_HALF_XY, beamHalf]);
  return { chip, origin, bricks, surface, beam };
}

/** Puts the board's surface, beam and supported inner bricks into `store`; returns the row of each inner brick. */
export function fillBoardStore(store: SceneStore, board: Board): Map<number, ChipBrick> {
  const rows = new Map<number, ChipBrick>(), name = String(board.chip.grid);
  for (const pb of [board.surface, board.beam]) putPlain(store, store.alloc(), pb, false, name);
  for (const { item, pos } of board.bricks) {
    if (!supportedAsset(item.brick.asset, item.brick.size !== null)) continue;
    const id = store.alloc();
    putPlain(store, id, { ...item.brick, pos }, item.linear, name);
    rows.set(id, item);
  }
  return rows;
}
