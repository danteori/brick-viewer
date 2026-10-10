// Hidden-face culling wired into the renderer (S-02 / U-02). A scene mirror keeps a FaceCuller
// (scene/cull.ts) over the scene store's rows: ids are store row ids, dead and hidden rows are
// empty slots. The masks go into the store's faceMask column, which the instance records carry
// (iMisc.x); the vertex shader collapses the hidden faces of box meshes and render chunks skip
// fully hidden bricks. A hidden face is exactly covered by opaque coplanar neighbours, so no pixel
// it could have drawn is visible: the image is unchanged, only the work goes.
//
// Rows hidden while a selection is being moved (S.hidden) don't cover anything, so their
// neighbours' faces come back while the ghost is out.

import { S } from '../app/state.ts';
import { addMirror } from '../scene/sync.ts';
import { FaceCuller, FULL_BOX_ASSETS, type CullBrick } from '../scene/cull.ts';
import { ASSETS, Kind, MATERIALS, worldHalfOf, type SceneStore } from '../scene/store.ts';
import { markBrick } from './instances.ts';

const NONE: CullBrick = { pos: [0, 0, 0], half: [0, 0, 0], shape: 'none', fullBox: false };

/**
 * Settings and counters (test hook / bench). `maxBricks`: bigger scenes skip culling (the build
 * runs on the main thread: ~3-8 us a brick in the browser plus ~150 bytes a brick of tables; a
 * multi-million brick prefab would stall the load for many seconds). Moving it to a worker lifts this (S-01).
 */
export const faceCull = { on: true, maxBricks: 300_000, active: false, buildMs: 0, hiddenFaces: 0, hiddenBricks: 0 };

let culler: FaceCuller | null = null;
let store: SceneStore | null = null;
let hidden: ReadonlySet<number> = new Set();

function cullOf(s: SceneStore, id: number): CullBrick {
  if (!s.alive(id) || hidden.has(id)) return NONE;
  const box = s.shape[id] === Kind.Box && FULL_BOX_ASSETS.has(ASSETS.name(s.asset[id]!));
  const h = worldHalfOf(s.orient[id]!, s.hx[id]!, s.hy[id]!, s.hz[id]!);   // a shared scratch array: copy it
  return {
    pos: [s.px[id]!, s.py[id]!, s.pz[id]!], half: [h[0], h[1], h[2]],
    shape: box ? 'box' : 'other', material: MATERIALS.name(s.material[id]!), grid: s.grid[id]!, fullBox: box,
  };
}

function build(s: SceneStore): void {
  const t = performance.now();
  store = s; hidden = S.hidden;
  const bricks: CullBrick[] = new Array<CullBrick>(s.n);
  for (let id = 0; id < s.n; id++) bricks[id] = cullOf(s, id);
  culler = new FaceCuller(bricks);
  const m = culler.masks;
  for (let id = 0; id < s.n; id++) s.faceMask[id] = m[id]!;
  faceCull.buildMs = performance.now() - t;
  const st = culler.stats();
  faceCull.hiddenFaces = st.hiddenFaces; faceCull.hiddenBricks = st.hiddenBricks;
}

/** Re-describes rows `ids` to the culler and writes back every mask that changed. */
function update(s: SceneStore, ids: Iterable<number>): void {
  const c = culler!;
  const list = [...ids].sort((a, b) => a - b);
  for (const id of list) {
    while (c.count < id) c.set(c.count, null);
    c.set(id, cullOf(s, id));
  }
  // the edited rows always (an undo may have restored an old mask with the row), then every
  // neighbour whose mask changed
  for (const id of [...list, ...c.updateAround(list)]) {
    if (id >= s.n) continue;
    const m = c.masks[id]!;
    if (s.faceMask[id] !== m) { s.faceMask[id] = m; markBrick(id); }
  }
}

export function initFaceCull(): void {
  addMirror({
    reset: (s) => {
      culler = null; store = s;
      faceCull.active = faceCull.on && s.count <= faceCull.maxBricks;
      faceCull.buildMs = faceCull.hiddenFaces = faceCull.hiddenBricks = 0;
      if (faceCull.active) build(s); else s.faceMask.fill(0);
    },
    changed: (s, ids) => { if (culler && store === s) update(s, ids); },
  });
}

/** Once a frame, after syncScene: follows the moving-selection hidden set. */
export function syncFaceCull(): void {
  if (!culler || store !== S.scene || S.hidden === hidden) return;
  const was = hidden;
  hidden = S.hidden;
  const ids = new Set<number>();
  for (const id of was) ids.add(id);
  for (const id of hidden) ids.add(id);
  if (ids.size) update(store, ids);
}
