import { beforeEach, describe, expect, it } from 'vitest';
import { enterEdit, enterExplore, escapeAction, getMode, hold, isEdit, isExplore, onModeChange, resetMode, setMode } from '../../src/app/mode.ts';

describe('Explore / Edit modes', () => {
  beforeEach(() => resetMode('explore'));

  it('starts in Explore', () => {
    expect(getMode()).toBe('explore');
    expect(isExplore()).toBe(true);
    expect(isEdit()).toBe(false);
  });

  it('switches, reports a change once and tells the listeners', () => {
    const seen: string[] = [];
    onModeChange((m, p) => seen.push(`${p}>${m}`));
    expect(enterEdit()).toBe(true);
    expect(enterEdit()).toBe(false);
    expect(isEdit()).toBe(true);
    expect(enterExplore()).toBe(true);
    expect(setMode('explore')).toBe(false);
    expect(seen).toEqual(['explore>edit', 'edit>explore']);
  });

  it('holds the camera only on entering Edit', () => {
    enterEdit();
    expect(hold.cam).toBe(true);
    enterExplore();
    expect(hold.cam).toBe(false);
  });

  it('Esc clears first, then leaves Edit', () => {
    expect(escapeAction(true)).toBe('clear');
    expect(escapeAction(false)).toBe('exit');
  });
});
