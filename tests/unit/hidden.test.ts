// Hidden bricks (E-21, scene/hidden.ts): which rows are Visible off, when they show, when they can
// be picked, and that they never cover their neighbours' faces. The ghost's stripe pattern
// (render/hiddenlook.ts) runs at the measured period and moves down-left.
import { describe, expect, it } from 'vitest';
import { readBrz } from '../../src/format/brz.ts';
import { storeFromFiles } from '../../src/scene/load.ts';
import { cullColumnsOf, regionMasks } from '../../src/scene/parsecore.ts';
import { flagMask, writeFlags } from '../../src/scene/brickflags.ts';
import { hiddenBit, isHiddenRow, nextHiddenMode, pickableRow, showsHidden } from '../../src/scene/hidden.ts';
import { ASSETS, FLAG_NAMES, MATERIALS, SceneStore } from '../../src/scene/store.ts';
import { HIDDEN_LOOK, hiddenPhase, hiddenStripe } from '../../src/render/hiddenlook.ts';
import { synthSave, type SynthBrick } from './synthsave.ts';

const cube = (x: number, hidden = false): SynthBrick => ({ asset: 'PB_DefaultBrick', size: [10, 10, 10], pos: [x, 0, 10], color: [22, 195, 134], hidden });
const load = (bricks: SynthBrick[]): SceneStore => storeFromFiles(readBrz(synthSave(bricks))).store;

describe('hidden rows', () => {
  it('reads Visible off from the save', () => {
    const s = load([cube(0), cube(20, true)]), bit = hiddenBit(s);
    expect(bit).toBe(1 << FLAG_NAMES.id('VisibilityFlags'));
    expect(isHiddenRow(s, 0, bit)).toBe(false);
    expect(isHiddenRow(s, 1, bit)).toBe(true);
  });

  it('follows the Visible switch', () => {
    const s = load([cube(0)]), bit = hiddenBit(s);
    writeFlags(s, [0], flagMask(s, ['VisibilityFlags']), false);
    expect(isHiddenRow(s, 0, bit)).toBe(true);
    writeFlags(s, [0], flagMask(s, ['VisibilityFlags']), true);
    expect(isHiddenRow(s, 0, bit)).toBe(false);
  });

  it('has none without a VisibilityFlags field', () => {
    const s = new SceneStore();
    s.alloc(); s.collision[0] = 0xffff;
    expect(hiddenBit(s)).toBe(0);
    expect(isHiddenRow(s, 0)).toBe(false);
  });
});

describe('show and pick rule', () => {
  it('auto shows hidden bricks only while a brick is selected', () => {
    expect(showsHidden('auto', true)).toBe(true);
    expect(showsHidden('auto', false)).toBe(false);
    expect(showsHidden('show', false)).toBe(true);
    expect(showsHidden('hide', true)).toBe(false);
  });

  it('picks hidden bricks only while they show; visible ones always', () => {
    const s = load([cube(0), cube(20, true)]);
    expect(pickableRow(s, 0, false)).toBe(true);
    expect(pickableRow(s, 0, true)).toBe(true);
    expect(pickableRow(s, 1, false)).toBe(false);
    expect(pickableRow(s, 1, true)).toBe(true);
  });

  it('cycles auto, shown, off', () => {
    expect(nextHiddenMode('auto')).toBe('show');
    expect(nextHiddenMode('show')).toBe('hide');
    expect(nextHiddenMode('hide')).toBe('auto');
  });
});

describe('face culling', () => {
  const masks = (s: SceneStore): number[] => Array.from(regionMasks(cullColumnsOf(s), ASSETS.list, MATERIALS.list));
  it('a hidden brick covers no face of its neighbour', () => {
    expect(masks(load([cube(0), cube(20)]))[0]).not.toBe(0);
    expect(masks(load([cube(0), cube(20, true)]))).toEqual([0, 0]);
  });
});

describe('ghost stripes', () => {
  it('repeats every period along each face axis, half light', () => {
    const P = HIDDEN_LOOK.period;
    expect(hiddenPhase(P, 0, 0) - hiddenPhase(0, 0, 0)).toBeCloseTo(1);
    expect(hiddenPhase(0, P, 0) - hiddenPhase(0, 0, 0)).toBeCloseTo(1);
    let light = 0;
    for (let i = 0; i < 1000; i++) light += hiddenStripe(i * P / 1000, 0, 0);
    expect(light / 1000).toBeCloseTo(0.5, 1);
  });

  it('runs from upper left to lower right and moves down-left', () => {
    expect(hiddenPhase(5, -5, 0)).toBeCloseTo(hiddenPhase(0, 0, 0));
    // after 0.1 s the phase seen at (0, 0) is the one that was 0.05 periods up-right of it
    const d = HIDDEN_LOOK.speed * 0.1 * HIDDEN_LOOK.period / 2;
    expect(hiddenPhase(0, 0, 0.1)).toBeCloseTo(hiddenPhase(d, d, 0));
  });
});
