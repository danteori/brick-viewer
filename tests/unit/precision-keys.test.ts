import { describe, expect, it } from 'vitest';
import { togglesPrecision } from '../../src/editor/precision.ts';

describe('togglesPrecision', () => {
  it('C toggles outside the classic camera', () => {
    expect(togglesPrecision('c', false)).toBe(true);
    expect(togglesPrecision('C', false)).toBe(true);
  });
  it('C is left to autoCenter in the classic camera', () => {
    expect(togglesPrecision('c', true)).toBe(false);
  });
  it('G stays as an alias in both cameras', () => {
    expect(togglesPrecision('g', true)).toBe(true);
    expect(togglesPrecision('G', false)).toBe(true);
  });
  it('other keys do nothing', () => {
    expect(togglesPrecision('x', false)).toBe(false);
  });
});
