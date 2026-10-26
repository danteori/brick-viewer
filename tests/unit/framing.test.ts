import { describe, expect, it } from 'vitest';
import { SceneStore } from '../../src/scene/store.ts';
import { mainBuild } from '../../src/scene/framing.ts';

function store(centres: [number, number, number][]): SceneStore {
  const s = new SceneStore();
  for (const [x, y, z] of centres) {
    const id = s.alloc();
    s.px[id] = x; s.py[id] = y; s.pz[id] = z; s.hx[id] = 10; s.hy[id] = 10; s.hz[id] = 6;
  }
  return s;
}

describe('main build framing', () => {
  it('frames the biggest cluster and ignores distant bricks', () => {
    const near: [number, number, number][] = [];
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) near.push([x * 20, y * 20, 6]);
    const s = store([[500000, 500000, 6], ...near, [-300000, 0, 90000]]);
    const m = mainBuild(s)!;
    expect(m.hi[0]! - m.lo[0]!).toBeLessThan(400);
    expect(m.lo[0]).toBeGreaterThanOrEqual(-20);
    expect(s.px[m.focus]).toBeGreaterThan(40);
    expect(s.px[m.focus]).toBeLessThan(160);
  });
  it('keeps the first brick as the focus when it is in the main build', () => {
    const s = store([[0, 0, 6], [20, 0, 6], [40, 0, 6], [900000, 0, 6]]);
    expect(mainBuild(s)!.focus).toBe(0);
  });
  it('is null for an empty store', () => {
    expect(mainBuild(new SceneStore())).toBeNull();
  });
});
