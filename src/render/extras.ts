// Read-only extra bricks drawn after the scene: a world's dynamic grids (vehicles, doors), placed at
// their entity transforms. They are SceneStores of their own drawn as render chunks (optionally
// offset; scene/worldgrids.ts placedGridStore fills one for all grids), so they can't be focused, picked,
// resized, painted or saved. They belong to the scene store they were loaded with and are hidden
// while another one is shown (the undo of the load). Nothing is drawn while the list is empty, so
// scenes without extras render exactly as before.

import { S } from '../app/state.ts';
import { G } from './draw.ts';
import { ChunkSet, type ViewCull } from './instances.ts';
import { MAT_CIRCUIT, MAT_HOLOGRAM } from './matcode.ts';
import { boxIB } from './meshes/registry.ts';
import type { SceneStore } from '../scene/store.ts';

interface Source {
  sets: ChunkSet[];
  /** the scene store these extras go with */
  owner: SceneStore | null;
  count: number;
}

const sources = new Map<string, Source>();
const shown = (): ChunkSet[] => {
  const out: ChunkSet[] = [];
  for (const x of sources.values()) if (x.sets.length && (!x.owner || x.owner === S.scene)) out.push(...x.sets);
  return out;
};

/** Replaces the extras of source `key`: each grid's store with its origin (units). `owner`: the scene they go with. */
export function setExtraStores(grids: { store: SceneStore; origin: [number, number, number] }[], owner: SceneStore | null, key = 'grids'): void {
  for (const s of sources.get(key)?.sets ?? []) s.dispose();
  sources.set(key, { sets: grids.map((g) => new ChunkSet(g.store, { scene: false, offset: g.origin })), owner, count: grids.reduce((n, g) => n + g.store.count, 0) });
}

export const extraCount = (): number => sources.get('grids')?.count ?? 0;

/** How far the shown extras reach along the view axis (viewer units; see ChunkSet.depthReach). */
export function extrasDepth(): number {
  let r = 0;
  for (const s of shown()) { s.sync(); r = Math.max(r, s.depthReach()); }
  return r;
}

/** Draws the extras (call with the body uniforms set and the cube's element array bound). */
export function drawExtras(cull: ViewCull | null = null): void {
  const sets = shown();
  if (!sets.length) return;
  for (const s of sets) { s.sync(); s.draw(cull); }
  G.gl.bindBuffer(G.gl.ELEMENT_ARRAY_BUFFER, boxIB);
}

/** Draws the extras' hologram and circuit-board bricks (after the opaque pass, like matpass.ts does for the scene's own). */
export function drawExtraHolograms(cull: ViewCull | null = null): void {
  const sets = shown().filter((s) => s.matCount[MAT_HOLOGRAM] || s.matCount[MAT_CIRCUIT]);
  if (!sets.length) return;
  const { gl, u } = G;
  gl.enable(gl.BLEND); gl.depthMask(false);
  gl.uniform1f(u.uIntensity, -1); gl.uniform1f(u.uMatPass, 0);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  for (const m of [MAT_CIRCUIT, MAT_HOLOGRAM]) {
    gl.uniform1f(u.uMat, m);
    for (const s of sets) s.drawSpecial(m, cull, true);
  }
  gl.uniform1f(u.uMat, 0);
  gl.depthMask(true); gl.disable(gl.BLEND);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
}
