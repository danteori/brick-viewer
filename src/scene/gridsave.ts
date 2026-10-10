// Saving the dynamic grids (W-03 / W-04): after grid 1 is written (save.ts), each dynamic grid of
// the scene goes back into the file tree:
//
//   bricks     rows -> grid-local (dyngrids.ts toLocal), in load order then new ones (so the
//              indices its components and wires name stay put). A grid whose bricks are exactly
//              what was loaded keeps its chunk files byte for byte; any other is rebuilt (chunk
//              offset 1024, so its usual one chunk -1_-1_-1 is centred on the grid origin).
//   transform  a moved or turned grid gets its entity's new Locations / Rotations; a new grid gets
//              an entity row (entitywrite.ts); a grid left with no bricks is removed with its entity.

import type { FileMap } from '../format/brz.ts';
import { editEntities, type NewGridEntity } from '../format/entitywrite.ts';
import { extractBricks, rebuildFromLoaded, type PlainBrick } from '../format/world.ts';
import { srgbToLinearByte } from '../format/palette.ts';
import { linearToSrgbByte } from '../format/stale.ts';
import { gridSetOf, locationOf, rowsOfGrid, sameXf, toLocal } from './dyngrids.ts';
import { plainOf } from './view.ts';
import type { SeqBrick } from './load.ts';
import type { SceneStore } from './store.ts';
import type { Quat, Vec3 } from './grids.ts';

/** A brick's save fields, normalised for "is it what was loaded?" */
const key = (b: PlainBrick): string => JSON.stringify([b.asset, b.size, b.pos, b.orient, b.color, b.material, b.owner ?? 0, b.originalOwner ?? b.owner ?? 0,
  Object.entries(b.flags ?? {}).filter(([, v]) => !v).map(([k]) => k).sort()]);

const byLoadOrder = (bricks: readonly SeqBrick[]): SeqBrick[] =>
  [...bricks.filter((b) => b.seq !== undefined).sort((a, b) => a.seq! - b.seq!), ...bricks.filter((b) => b.seq === undefined)];
const strip = ({ seq: _s, ...pb }: SeqBrick): PlainBrick => pb;

/** Grid `grid`'s bricks as save bricks in grid-local units (rows and the ones the viewer can't draw), in write order. */
export function gridLocalBricks(s: SceneStore, grid: number, linear: boolean): SeqBrick[] {
  const set = gridSetOf(s), xf = set?.grids.get(grid);
  if (!set || !xf) return [];
  const rows = rowsOfGrid(s, grid).map((id) => {
    const { linear: lin, ...pb } = plainOf(s, id), l = toLocal(xf, pb.pos, pb.orient);
    pb.pos = l.pos; pb.orient = l.orient;
    if (lin !== linear) { const f = linear ? srgbToLinearByte : linearToSrgbByte; pb.color = [f(pb.color[0]), f(pb.color[1]), f(pb.color[2]), pb.color[3]]; }
    return pb;
  });
  return byLoadOrder(rows.concat(set.unsupported.get(grid) ?? []));
}

/**
 * The scene's dynamic grids written into `files` (a save with grid 1 already written), against
 * `template` (the save as opened). `linear`: how grid 1 stores colours (for new grids).
 */
export function writeDynamicGrids(template: FileMap, files: FileMap, s: SceneStore, linear: boolean): { files: FileMap; warnings: string[] } {
  const set = gridSetOf(s), warnings: string[] = [];
  if (!set) return { files, warnings };
  let out = files;
  const moved = new Map<number, { location: Vec3; rotation: Quat }>(), removed = new Set<number>(), added: NewGridEntity[] = [];
  const ids = [...new Set([...set.loaded.keys(), ...set.grids.keys()])].sort((a, b) => a - b);
  for (const g of ids) {
    const was = set.loaded.get(g), xf = set.grids.get(g), name = String(g);
    const lin = was?.linear ?? linear;
    const bricks = xf ? gridLocalBricks(s, g, lin) : [];
    if (!bricks.length) {
      if (!was) continue;                                    // a new grid emptied again: nothing to write
      out = rebuildFromLoaded(out, [], { grid: name }).files;  // its owners' brick counts go down
      for (const p of [...out.keys()]) if (p.startsWith(`World/0/Bricks/Grids/${name}/`)) out.delete(p);
      removed.add(g);
      if (was.components) warnings.push(`grid ${g} had components / wires: anything wired to it now points at nothing`);
      continue;
    }
    const before = was ? extractBricks(template, { grid: name }).bricks : [];
    const same = !!was && before.length === bricks.length && bricks.every((b, i) => b.seq === i && key(b) === key(before[i]!));
    if (!same) {
      const r = rebuildFromLoaded(out, bricks.map(strip), { grid: name, linear: lin });
      out = r.files;
      for (const w of r.warnings) if (!/components \/ wires: they index bricks/.test(w)) warnings.push(`grid ${g}: ${w}`);
      if (was?.components && bricks.some((b, i) => b.seq !== undefined && b.seq !== i)) warnings.push(`grid ${g}: bricks were removed; its components / wires may now name other bricks`);
    }
    if (!xf) continue;
    if (!was) {
      const first = rowsOfGrid(s, g)[0];
      added.push({ persistentIndex: g, location: locationOf(xf), rotation: [...xf.quat] as Quat, owner: first !== undefined ? s.owner[first]! : 0 });
    } else if (!sameXf(xf, was.xf)) moved.set(g, { location: locationOf(xf), rotation: [...xf.quat] as Quat });
  }
  const e = editEntities(out, { moved, removed, added });
  return { files: e.files, warnings: warnings.concat(e.warnings) };
}
