// Hidden-face culling wired into the renderer (S-02 / U-02). A scene mirror keeps a FaceCuller
// (scene/cull.ts) over the scene store's rows: ids are store row ids, dead and hidden rows are
// empty slots. The masks go into the store's faceMask column, which the instance records carry
// (iMisc.x). At the far LOD levels (render/lod.ts hidesCovered) the vertex shader collapses the
// hidden faces of box meshes and the coarse sets leave fully hidden bricks out. Not at full
// detail: a hidden face is exactly covered by opaque coplanar neighbours, but where bricks of
// different sizes meet, their outer faces leave sub-pixel slivers (T-junctions) that the covered
// faces behind fill, so culling there would let the background sparkle through the seams.
//
// Rows hidden while a selection is being moved (S.hidden) don't cover anything, so their
// neighbours' faces come back while the ghost is out.

import { S } from '../app/state.ts';
import { addMirror } from '../scene/sync.ts';
import { FaceCuller, FULL_BOX_ASSETS, FULLY_HIDDEN, type CullBrick } from '../scene/cull.ts';
import { ASSETS, Kind, MATERIALS, worldHalfOf, type SceneStore } from '../scene/store.ts';
import { beforeSync, markBrick, masksChanged } from './instances.ts';

const NONE: CullBrick = { pos: [0, 0, 0], half: [0, 0, 0], shape: 'none', fullBox: false };

/**
 * Settings and counters (test hook / bench). `maxBricks`: bigger scenes aren't culled on the main
 * thread (~3-8 us a brick in the browser plus ~150 bytes a brick of tables: a multi-million brick
 * prefab would stall for many seconds). Up to `asyncMaxBricks`, the full build gets their masks
 * from a worker instead (S-01, setAsyncCull): `async` is that mode, `pending` while masks are on
 * their way. Until they arrive, and after every edit until they are recomputed (EDIT_SETTLE_MS
 * after the last one), the masks are all zero: every face drawn, never a hole.
 */
export const faceCull = { on: true, maxBricks: 300_000, asyncMaxBricks: 16_000_000, active: false, async: false, pending: false, buildMs: 0, hiddenFaces: 0, hiddenBricks: 0 };

/** A worker computing a store's masks with some rows left out (app/parse.ts), or null (lite). */
type AsyncCull = (s: SceneStore, skip: ReadonlySet<number>) => Promise<Uint8Array | null>;
let asyncCull: AsyncCull | null = null;
export function setAsyncCull(f: AsyncCull | null): void { asyncCull = f; }
/** ms after the last edit before an async-culled scene's masks are recomputed */
const EDIT_SETTLE_MS = 2000;
/** bumped to drop async results that are out of date (a newer request, an edit, another scene) */
let asyncGen = 0, settleTimer: ReturnType<typeof setTimeout> | undefined;
/** do the store's masks hold worker results (as opposed to all zeros)? */
let asyncApplied = false;

/** Asks the worker for store s's masks (rows hidden right now left out) and applies them if nothing changed meanwhile. */
function requestMasks(s: SceneStore): void {
  const gen = ++asyncGen, rev = s.rev, hid = hidden, t = performance.now();
  faceCull.pending = true;
  void asyncCull!(s, hid).then((m) => {
    if (gen !== asyncGen || store !== s || s.rev !== rev || hidden !== hid) return;
    faceCull.pending = false;
    if (!m) return;
    s.faceMask.set(m.subarray(0, s.n));
    asyncApplied = true;
    faceCull.buildMs = performance.now() - t;
    let faces = 0, bricks = 0;
    for (let id = 0; id < s.n; id++) { const v = m[id]!; if (!v) continue; if (v & FULLY_HIDDEN) bricks++; for (let f = 0; f < 6; f++) if (v & (1 << f)) faces++; }
    faceCull.hiddenFaces = faces; faceCull.hiddenBricks = bricks;
    masksChanged();
  });
}

/** An async-culled scene changed (an edit, or the moving selection): masks to zero now, recomputed once edits settle. */
function asyncEdit(s: SceneStore): void {
  asyncGen++;
  faceCull.pending = false;
  if (asyncApplied) { s.faceMask.fill(0); asyncApplied = false; faceCull.hiddenFaces = faceCull.hiddenBricks = 0; masksChanged(); }
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { if (store === s && faceCull.async) requestMasks(s); }, EDIT_SETTLE_MS);
}

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
  (globalThis as { __faceCull?: typeof faceCull }).__faceCull = faceCull;   // the test hook reads it (lite has no face culling)
  beforeSync.push(syncFaceCull);
  addMirror({
    reset: (s) => {
      culler = null; store = s; hidden = S.hidden;
      asyncGen++; clearTimeout(settleTimer); asyncApplied = false;
      faceCull.active = faceCull.on && s.count <= faceCull.maxBricks;
      faceCull.async = !faceCull.active && faceCull.on && !!asyncCull && s.count <= faceCull.asyncMaxBricks;
      faceCull.pending = false;
      faceCull.buildMs = faceCull.hiddenFaces = faceCull.hiddenBricks = 0;
      if (faceCull.active) build(s);
      else { s.faceMask.fill(0); if (faceCull.async) requestMasks(s); }
    },
    changed: (s, ids) => { if (culler && store === s) update(s, ids); else if (faceCull.async && store === s) asyncEdit(s); },
  });
}

/** Once a frame, after syncScene: follows the moving-selection hidden set. */
export function syncFaceCull(): void {
  if (faceCull.async && store === S.scene && S.hidden !== hidden) { hidden = S.hidden; asyncEdit(store); return; }
  if (!culler || store !== S.scene || S.hidden === hidden) return;
  const was = hidden;
  hidden = S.hidden;
  const ids = new Set<number>();
  for (const id of was) ids.add(id);
  for (const id of hidden) ids.add(id);
  if (ids.size) update(store, ids);
}
