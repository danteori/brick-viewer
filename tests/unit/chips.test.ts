import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBrz } from '../../src/format/brz.ts';
import { boardOf, BOARD_LIFT, chipBricks, defaultOpen, fillBoardStore, readChips, type Chip, type ChipBrick } from '../../src/scene/chips.ts';
import { SceneStore } from '../../src/scene/store.ts';
import { REFS } from './refs.ts';

const chip = (over: Partial<Chip> = {}): Chip => ({
  grid: 3, parent: 1, ref: { grid: 1, chunk: { X: 0, Y: 0, Z: 0 }, brick: 0 }, pos: [100, 200, 2], orient: 16, collapsed: false,
  planeCenter: [5, 5, 0], planeExtent: [30, 30, 0], ...over,
});
const inner = (pos: [number, number, number], asset = 'PB_DefaultBrick'): ChipBrick => ({
  ref: { grid: 3, chunk: { X: 0, Y: 0, Z: 0 }, brick: 0 }, linear: false,
  brick: { asset, size: asset.startsWith('PB_') ? [5, 5, 2] : null, pos, orient: 16, color: [255, 0, 0, 5], material: 'BMC_Plastic' },
});

describe('microchip board', () => {
  it('floats the board above the chip and keeps inner offsets from the plane centre', () => {
    const b = boardOf(chip(), [inner([5, 5, 1]), inner([-15, 25, 3])], 6);
    expect(b.origin).toEqual([100, 200, 2 + 6 + BOARD_LIFT]);
    expect(b.bricks.map((x) => x.pos)).toEqual([[100, 200, 69], [80, 220, 71]]);
  });

  it('sizes the surface from the plane extent and puts the beam on the chip', () => {
    const b = boardOf(chip({ planeExtent: [30, 20, 0] }), [], 6);
    expect(b.surface.size).toEqual([30, 20, 1]);
    expect(b.surface.pos).toEqual([100, 200, 2 + 6 + BOARD_LIFT - 1]);
    expect(b.beam.pos.slice(0, 2)).toEqual([100, 200]);
    const [, , hz] = b.beam.size!;
    expect(b.beam.pos[2]! - hz!).toBe(8);
    expect(b.beam.pos[2]! + hz!).toBeLessThanOrEqual(2 + 6 + BOARD_LIFT - 2);
    expect(b.surface.material).toBe('BMC_Hologram');
  });

  it('puts the surface, the beam and the supported bricks into a store', () => {
    const store = new SceneStore();
    const b = boardOf(chip(), [inner([5, 5, 1]), inner([0, 0, 0], 'B_Unknown_Thing')], 6);
    const rows = fillBoardStore(store, b);
    expect(store.count).toBe(3);
    expect([...rows.values()]).toEqual([b.bricks[0]!.item]);
    const row = [...rows.keys()][0]!;
    expect([store.px[row], store.py[row], store.pz[row]]).toEqual([100, 200, 69]);
  });

  it('opens the chips the save left open, unless there are too many', () => {
    expect(defaultOpen([chip({ grid: 3 }), chip({ grid: 4, collapsed: true })])).toEqual([3]);
    const many = Array.from({ length: 9 }, (_, i) => chip({ grid: i + 3 }));
    expect(defaultOpen(many)).toEqual([]);
  });
});

const CHIP_DIR = resolve(REFS, 'microchip');
const CHIP_SAVE = existsSync(CHIP_DIR) ? readdirSync(CHIP_DIR).filter((f) => f.endsWith('.brz')).sort()[0] : undefined;
const REFERENCE = CHIP_SAVE ? resolve(CHIP_DIR, CHIP_SAVE) : '';
describe.skipIf(!REFERENCE)('microchip reading (private reference save)', () => {
  const files = existsSync(REFERENCE) ? readBrz(new Uint8Array(readFileSync(REFERENCE))) : new Map();
  it('finds the chip, its grid and its board', () => {
    const chips = readChips(files);
    expect(chips.length).toBe(1);
    expect(chips[0]).toMatchObject({ grid: 3, parent: 1, collapsed: false, planeCenter: [5, 5, 0], planeExtent: [30, 30, 0] });
  });
  it('reads the bricks inside the chip', () => {
    const c = readChips(files)[0]!;
    expect(chipBricks(files, c).length).toBe(7);
  });
});
