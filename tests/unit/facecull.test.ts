// Hidden-face culling wired to the scene (render/facecull.ts): the store's faceMask column follows
// loads, edits, removals and the moving-selection hidden set.
import { describe, expect, it } from 'vitest';
import { S } from '../../src/app/state.ts';
import { SceneStore } from '../../src/scene/store.ts';
import { putPlain } from '../../src/scene/view.ts';
import { syncScene } from '../../src/scene/sync.ts';
import { faceCull, initFaceCull, syncFaceCull } from '../../src/render/facecull.ts';
import { FACE_NX, FACE_PX, FULLY_HIDDEN } from '../../src/scene/cull.ts';

const brick = (s: SceneStore, x: number, y = 0, z = 6, material?: string): number => {
  const id = s.alloc();
  putPlain(s, id, { asset: 'PB_DefaultBrick', size: [5, 5, 6], pos: [x, y, z], orient: 16, color: [200, 200, 200, 5], material: material ?? 'BMC_Plastic' }, false);
  return id;
};

describe('face culling mirror', () => {
  initFaceCull();

  it('hides the shared faces of a row of bricks and follows edits', () => {
    const s = new SceneStore();
    const a = brick(s, 0), b = brick(s, 10), c = brick(s, 20);
    S.scene = s; S.hidden = new Set();
    syncScene();
    expect(s.faceMask[a]! & (FACE_PX | FACE_NX)).toBe(FACE_PX);
    expect(s.faceMask[b]! & (FACE_PX | FACE_NX)).toBe(FACE_PX | FACE_NX);
    expect(s.faceMask[c]! & (FACE_PX | FACE_NX)).toBe(FACE_NX);
    expect(faceCull.hiddenFaces).toBe(4);

    s.remove(b);
    syncScene();
    expect(s.faceMask[a]! & FACE_PX).toBe(0);
    expect(s.faceMask[c]! & FACE_NX).toBe(0);

    const d = brick(s, 10);                        // put one back (re-uses the row)
    syncScene();
    expect(s.faceMask[d]! & (FACE_PX | FACE_NX)).toBe(FACE_PX | FACE_NX);
    expect(s.faceMask[a]! & FACE_PX).toBe(FACE_PX);
  });

  it('glass covers nothing, and a hidden (moving) brick uncovers its neighbours', () => {
    const s = new SceneStore();
    const a = brick(s, 0), g = brick(s, 10, 0, 6, 'BMC_Glass'), b = brick(s, 0, 10);
    S.scene = s; S.hidden = new Set();
    syncScene();
    expect(s.faceMask[a]! & FACE_PX).toBe(0);
    expect(s.faceMask[g]).toBe(0);
    expect(s.faceMask[a]).not.toBe(0);             // b covers a's +Y face
    S.hidden = new Set([b]);
    syncFaceCull();
    expect(s.faceMask[a]).toBe(0);
    S.hidden = new Set();
    syncFaceCull();
    expect(s.faceMask[a]).not.toBe(0);
  });

  it('marks a brick enclosed on all six sides fully hidden', () => {
    const s = new SceneStore();
    const mid = brick(s, 0, 0, 18);
    for (const [x, y, z] of [[10, 0, 18], [-10, 0, 18], [0, 10, 18], [0, -10, 18], [0, 0, 30], [0, 0, 6]]) brick(s, x!, y!, z!);
    S.scene = s; S.hidden = new Set();
    syncScene();
    expect(s.faceMask[mid]! & FULLY_HIDDEN).toBe(FULLY_HIDDEN);
  });

  it('uses every brick\'s own size (a small brick against a big one covers only part of its face)', () => {
    const s = new SceneStore();
    const big = s.alloc();
    putPlain(s, big, { asset: 'PB_DefaultBrick', size: [20, 20, 6], pos: [0, 0, 6], orient: 16, color: [200, 200, 200, 5], material: 'BMC_Plastic' }, false);
    const small = brick(s, 25, 0, 6);              // 1x1 against the big brick's +X face (2 studs wide)
    S.scene = s; S.hidden = new Set();
    syncScene();
    expect(s.faceMask[big]! & FACE_PX).toBe(0);     // only partly covered
    expect(s.faceMask[small]! & FACE_NX).toBe(FACE_NX);
  });
});
