import { afterEach, describe, expect, it } from 'vitest';
import { ed, type Ghost } from '../../src/editor/ghost.ts';
import { ghostBrick, ghostUnits, setGhostSize, setGhostType } from '../../src/editor/ghostsize.ts';
import { brickType, type Brick } from '../../src/scene/brick.ts';
import { MICRO, PLATE, STEP } from '../../src/core/units.ts';

function hold(items: Brick[], extra: Partial<Ghost> = {}): Brick {
  ed.ghost = { items, label: 'place', mode: 'click', from: null, dz: 0, pose: null, valid: false, reason: '', mouse: null, over: false,
    visited: false, drop: true, skip: [], turns: 0, ...extra };
  return items[0]!;
}
const brick = (x: number, y: number, plates: number): Brick => ({ lo: [0, 0, 0], hi: [x * STEP, y * STEP, plates * PLATE], up: 3 } as Brick);

afterEach(() => { ed.ghost = null; });

describe('ghost size and type', () => {
  it('acts only on a single held brick that is not an import', () => {
    expect(ghostBrick()).toBeNull();
    hold([brick(2, 2, 3), brick(1, 1, 3)]);
    expect(ghostBrick()).toBeNull();
    hold([brick(2, 2, 3)], { onPlace: () => true });
    expect(setGhostSize(0, 4)).toBe(false);
  });

  it('sets a size in grid steps and clamps it', () => {
    const t = hold([brick(2, 2, 3)]);
    expect(setGhostSize(0, 4)).toBe(true);
    expect(ghostUnits(t, 0)).toBe(4);
    expect(setGhostSize(0, 4)).toBe(false);
    expect(setGhostSize(2, 0)).toBe(false);
    expect(ghostUnits(t, 2)).toBe(3);
    setGhostSize(1, 1e6);
    expect(ghostUnits(t, 1)).toBeLessThan(1e6);
  });

  it('switches the type and keeps the size on the new grid', () => {
    const t = hold([brick(2, 4, 3)]);
    expect(setGhostType('tile')).toBe(true);
    expect(brickType(t)).toBe('tile');
    expect(ghostUnits(t, 1)).toBe(4);
    expect(setGhostType('micro')).toBe(true);
    expect(brickType(t)).toBe('micro');
    expect(t.hi[0]).toBeCloseTo(2 * STEP);
    expect(ghostUnits(t, 0)).toBe(Math.round((2 * STEP) / MICRO));
    expect(setGhostType('micro')).toBe(false);
  });
});
