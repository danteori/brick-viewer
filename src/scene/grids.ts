// Brick grids as data: the static global grid (Grids/1) and the dynamic grids, each placed in
// the world by its entity (FORMAT.md 1.4, 1.5). No rendering here.
//
//   grid N's entity   the entity with PersistentIndex N (grid 1 has none: identity transform)
//   chunk centre      idx * ChunkSize + ChunkSize / 2 + ChunkOffset, in grid-local units.
//                     Dynamic grids use offset (1024, 1024, 1024), so their usual single chunk
//                     (-1,-1,-1) is centred on the grid origin. Older saves have no
//                     ChunkOffsets / ChunkSizes: 2048 and the same offsets are assumed (inferred).
//   brick, world      entity.location + rotate(entity.rotation, centre + RelativePosition)
//
// Seen in real worlds: grids whose ChunkIndex.mps is still live but whose chunk files and entity
// were deleted (kind 'orphan', chunks marked missing; skip them), and dynamic grids with more
// than one chunk.

import { overviewPaths, runLoaded, type LazyBrdbTree } from '../format/brdblazy.ts';
import { readEntities, type EntityRecord, type EntityTable, type Quat, type Vec3 } from '../format/entities.ts';
import { decodeWritten, writtenGlobalData, type SaveView } from '../format/saveview.ts';
import { decodeBrickChunk, type BrickChunk, type GlobalData, type PlainBrick } from '../format/world.ts';

export type { Quat, Vec3 } from '../format/entities.ts';

export interface GridTransform {
  /** Grid origin in world units. */
  pos: Vec3;
  /** Unit quaternion (x, y, z, w). */
  quat: Quat;
}

export const IDENTITY: Readonly<GridTransform> = Object.freeze({ pos: [0, 0, 0] as Vec3, quat: [0, 0, 0, 1] as Quat });

export interface GridChunk {
  /** Chunk 3D index. */
  index: Vec3;
  offset: Vec3;
  size: number;
  /** Centre in grid-local units. */
  centre: Vec3;
  numBricks: number;
  numComponents: number;
  numWires: number;
  /** Paths of the chunk's files, or null when absent. */
  bricks: string | null;
  components: string | null;
  wires: string | null;
}

/** global = Grids/1; dynamic / microchip = a grid entity; entity = another entity type; orphan = no entity. */
export type GridKind = 'global' | 'dynamic' | 'microchip' | 'entity' | 'orphan';

export interface Grid {
  id: number;
  kind: GridKind;
  entity: EntityRecord | null;
  transform: GridTransform;
  chunks: GridChunk[];
  /** Chunks the ChunkIndex lists whose brick file is missing. */
  missingChunks: number;
}

export interface WorldModel {
  grids: Grid[];
  entities: EntityTable;
  warnings: string[];
}

const GRID = /^World\/0\/Bricks\/Grids\/([^/]+)\//;
interface XYZ { X: number; Y: number; Z: number }

function kindOf(id: number, e: EntityRecord | undefined): GridKind {
  if (id === 1) return 'global';
  if (!e) return 'orphan';
  if (e.type === 'Entity_DynamicBrickGrid') return 'dynamic';
  if (e.type === 'Entity_MicrochipDynamicBrickGrid') return 'microchip';
  return 'entity';
}

/** Grids and entities of a save (a .brz via fileMapView, or a BrdbTree at any revision). */
export function buildWorldModel(view: SaveView): WorldModel {
  const entities = readEntities(view), warnings: string[] = [];
  const ids = new Set<string>();
  for (const p of view.paths()) {
    const m = GRID.exec(p);
    if (m) ids.add(m[1]!);
  }
  const grids: Grid[] = [];
  for (const name of [...ids].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))) {
    const id = Number(name), e = entities.byIndex.get(id), kind = kindOf(id, e);
    const base = `World/0/Bricks/Grids/${name}/`, at = (sub: string, k: XYZ): string | null => {
      const p = `${base}${sub}/${k.X}_${k.Y}_${k.Z}.mps`;
      return view.has(p) ? p : null;
    };
    const chunks: GridChunk[] = [];
    let missing = 0;
    if (view.has(base + 'ChunkIndex.mps')) {
      const ci = decodeWritten(view, base + 'ChunkIndex.mps').root as Record<string, unknown>;
      const idx = (ci.Chunk3DIndices as XYZ[] | undefined) ?? [];
      const offs = ci.ChunkOffsets as XYZ[] | undefined, sizes = ci.ChunkSizes as number[] | undefined;
      const nb = (ci.NumBricks as number[] | undefined) ?? [], nc = (ci.NumComponents as number[] | undefined) ?? [], nw = (ci.NumWires as number[] | undefined) ?? [];
      const dflt = id === 1 ? 0 : 1024;
      idx.forEach((k, j) => {
        const o = offs?.[j] ?? { X: dflt, Y: dflt, Z: dflt }, size = sizes?.[j] ?? 2048;
        const c: GridChunk = {
          index: [k.X, k.Y, k.Z],
          offset: [o.X, o.Y, o.Z],
          size,
          centre: [k.X * size + size / 2 + o.X, k.Y * size + size / 2 + o.Y, k.Z * size + size / 2 + o.Z],
          numBricks: nb[j] ?? 0,
          numComponents: nc[j] ?? 0,
          numWires: nw[j] ?? 0,
          bricks: at('Chunks', k),
          components: at('Components', k),
          wires: at('Wires', k),
        };
        if (!c.bricks) missing++;
        chunks.push(c);
      });
      const listed = new Set(chunks.map((c) => c.bricks));
      for (const p of view.paths()) {
        if (p.startsWith(base + 'Chunks/') && !listed.has(p)) warnings.push(`grid ${name}: ${p} is not in its ChunkIndex (ignored)`);
      }
    } else {
      warnings.push(`grid ${name} has no ChunkIndex.mps`);
    }
    if (kind === 'orphan') warnings.push(`grid ${name} has no entity${missing === chunks.length ? ' and no chunk files' : ''}`);
    else if (missing) warnings.push(`grid ${name}: ${missing} indexed chunk(s) have no brick file`);
    grids.push({
      id,
      kind,
      entity: e ?? null,
      transform: e && id !== 1 ? { pos: [...e.location], quat: [...e.rotation] } : { pos: [0, 0, 0], quat: [0, 0, 0, 1] },
      chunks,
      missingChunks: missing,
    });
  }
  return { grids, entities, warnings };
}

/** buildWorldModel on a lazily opened world (brdblazy.ts): loads only the chunk indexes and entity files, with their schemas. */
export async function buildWorldModelLazy(tree: LazyBrdbTree): Promise<WorldModel> {
  await tree.loadWritten(overviewPaths(tree));
  return runLoaded(tree, buildWorldModel);
}

/** A brick of a grid: grid-local position (`pos`) plus where it sits in the world. */
export interface GridBrick extends PlainBrick {
  grid: number;
  world: Vec3;
}

/** The bricks of one grid, each chunk decoded with the schema and GlobalData it was written with. */
export function gridBricks(view: SaveView, grid: Grid): GridBrick[] {
  const out: GridBrick[] = [];
  for (const c of grid.chunks) {
    if (!c.bricks) continue;
    const f = decodeWritten(view, c.bricks), g = writtenGlobalData<GlobalData>(view, c.bricks);
    if (!g) throw new Error('no GlobalData for ' + c.bricks);
    for (const b of decodeBrickChunk(f.root as BrickChunk, f.schema, g, c.centre)) {
      out.push({ ...b, grid: grid.id, world: localToWorld(grid.transform, b.pos) });
    }
  }
  return out;
}

/** Rotates v by unit quaternion q (v' = q v q*). */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  // t = 2 (q.xyz x v); v' = v + w t + q.xyz x t
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** Grid-local position -> world position. */
export function localToWorld(t: GridTransform, p: Vec3 | readonly number[]): Vec3 {
  const r = rotate(t.quat, [p[0]!, p[1]!, p[2]!]);
  return [r[0] + t.pos[0], r[1] + t.pos[1], r[2] + t.pos[2]];
}

/** The grid's local-to-world matrix, 4x4 column-major (WebGL order), in save units and axes. */
export function gridMatrix(t: GridTransform): Float64Array {
  const [x, y, z, w] = t.quat, m = new Float64Array(16);
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w);     m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w);     m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w);     m[9] = 2 * (y * z - x * w);     m[10] = 1 - 2 * (x * x + y * y);
  m[12] = t.pos[0]; m[13] = t.pos[1]; m[14] = t.pos[2]; m[15] = 1;
  return m;
}
