// The outline of a save or world (W-10): the main grid, the moving grids, the microchip grids, the
// other entities and the joints, each with a brick count. The static part is read once per scene
// from the files the scene came from; the live part (brick counts of the main and moving grids,
// grids made or emptied since, frozen state) comes from the scene and its GridSet.

import type { FileMap } from '../format/brz.ts';
import { fileMapView } from '../format/saveview.ts';
import { buildWorldModel, type Grid } from './grids.ts';
import type { ChunkKey } from './components.ts';
import { gridCounts, gridSetOf, jointRefs, propsOf } from './dyngrids.ts';
import { filesOf } from './load.ts';
import type { SceneStore } from './store.ts';

export type OutlineKind = 'main' | 'dynamic' | 'microchip' | 'orphan' | 'entity' | 'joint';

export interface OutlineRow {
  key: string;
  kind: OutlineKind;
  /** grid folder number or entity persistent index; a joint's is the grid that holds it */
  id: number;
  /** a joint: the persistent index of the grid it joins to; else 0 */
  target: number;
  /** a joint: the index of its brick in the chunk; else -1 */
  brick: number;
  /** a joint: the chunk of its brick */
  chunk: ChunkKey | null;
  /** the entity type name from the save, or '' */
  type: string;
  /** bricks in the grid; null for an entity with no grid */
  bricks: number | null;
  frozen: boolean;
  sleeping: boolean;
}

interface Static {
  grids: Grid[];
  others: { id: number; type: string; locked: boolean; sleeping: boolean }[];
  joints: { grid: number; chunk: ChunkKey; target: number; brick: number }[];
}

const cache = new WeakMap<SceneStore, Static | null>();

function readStatic(s: SceneStore, files: FileMap | null): Static | null {
  if (cache.has(s)) return cache.get(s)!;
  let out: Static | null = null;
  if (files) {
    try {
      const model = buildWorldModel(fileMapView(files)), ofGrid = new Set(model.grids.map((g) => g.id));
      const joints: Static['joints'] = [];
      for (const j of jointRefs(files)) j.refs.forEach((target, k) => joints.push({ grid: j.grid, chunk: j.chunk, target, brick: j.bricks[k] ?? -1 }));
      out = {
        grids: model.grids.filter((g) => g.id !== 1),
        others: model.entities.entities.filter((e) => !ofGrid.has(e.persistentIndex)).map((e) => ({ id: e.persistentIndex, type: e.type, locked: e.physicsLocked, sleeping: e.physicsSleeping })),
        joints,
      };
    } catch (err) { console.warn('outline not read', err); }
  }
  cache.set(s, out);
  return out;
}

const staticBricks = (g: Grid): number => g.chunks.reduce((n, c) => n + c.numBricks, 0);

/** The outline rows of scene `s`, in display order: main grid, moving grids, microchips, others, joints. */
export function outlineRows(s: SceneStore, files: FileMap | null = filesOf(s)): OutlineRow[] {
  const set = gridSetOf(s), st = readStatic(s, files), counts = gridCounts(s);
  let moving = 0;
  for (const n of counts.values()) moving += n;
  const row = (r: Partial<OutlineRow> & Pick<OutlineRow, 'kind' | 'id'>): OutlineRow =>
    ({ key: `${r.kind}:${r.id}:${r.target ?? 0}:${r.brick ?? -1}`, target: 0, brick: -1, chunk: null, type: '', bricks: null, frozen: false, sleeping: false, ...r });
  const rows: OutlineRow[] = [row({ kind: 'main', id: 1, bricks: s.count - moving })];
  const dynamic = new Set<number>([...(set?.grids.keys() ?? [])]);
  for (const g of [...dynamic].sort((a, b) => a - b)) {
    const p = set ? propsOf(set, g) : null;
    rows.push(row({ kind: 'dynamic', id: g, type: st?.grids.find((x) => x.id === g)?.entity?.type ?? '', bricks: counts.get(g) ?? 0, frozen: !!p?.locked, sleeping: set?.loaded.get(g)?.sleeping ?? false }));
  }
  for (const g of st?.grids ?? []) {
    if (g.kind === 'dynamic' || dynamic.has(g.id)) continue;
    const kind: OutlineKind = g.kind === 'microchip' ? 'microchip' : g.kind === 'orphan' ? 'orphan' : 'entity';
    rows.push(row({ kind, id: g.id, type: g.entity?.type ?? '', bricks: staticBricks(g), frozen: !!g.entity?.physicsLocked, sleeping: !!g.entity?.physicsSleeping }));
  }
  for (const e of st?.others ?? []) rows.push(row({ kind: 'entity', id: e.id, type: e.type, frozen: e.locked, sleeping: e.sleeping }));
  for (const j of st?.joints ?? []) rows.push(row({ kind: 'joint', id: j.grid, target: j.target, brick: j.brick, chunk: j.chunk }));
  return rows;
}
