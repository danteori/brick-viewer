// Read-only extra bricks drawn after the scene: a world's dynamic grids (vehicles, doors), placed at
// their entity transforms. They are SceneStores of their own drawn as render chunks (optionally
// offset; scene/worldgrids.ts placedGridStore fills one for all grids), so they can't be focused, picked,
// resized, painted or saved. They belong to the scene store they were loaded with and are hidden
// while another one is shown (the undo of the load). Nothing is drawn while the list is empty, so
// scenes without extras render exactly as before.

import { S } from '../app/state.ts';
import { G } from './draw.ts';
import { ChunkSet, type ViewCull } from './instances.ts';
import { boxIB } from './meshes/registry.ts';
import type { SceneStore } from '../scene/store.ts';

const extra = {
  sets: [] as ChunkSet[],
  /** the scene store these extras go with */
  owner: null as SceneStore | null,
  count: 0,
};

/** Replaces the extras: each grid's store with its origin (units). `owner`: the scene they go with. */
export function setExtraStores(grids: { store: SceneStore; origin: [number, number, number] }[], owner: SceneStore | null): void {
  for (const s of extra.sets) s.dispose();
  extra.sets = grids.map((g) => new ChunkSet(g.store, { scene: false, offset: g.origin }));
  extra.owner = owner;
  extra.count = grids.reduce((n, g) => n + g.store.count, 0);
}

export const extraCount = (): number => extra.count;

/** Draws the extras (call with the body uniforms set and the cube's element array bound). */
export function drawExtras(cull: ViewCull | null = null): void {
  if (!extra.sets.length || (extra.owner && extra.owner !== S.scene)) return;
  for (const s of extra.sets) { s.sync(); s.draw(cull); }
  G.gl.bindBuffer(G.gl.ELEMENT_ARRAY_BUFFER, boxIB);
}
