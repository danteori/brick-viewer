import { afterEach, describe, expect, it } from 'vitest';
import { camDrag, cameraStyle, escapeStep, isClassic, isFree, setCameraStyle } from '../../src/app/mode.ts';

describe('camera style', () => {
  afterEach(() => setCameraStyle('free'));

  it('starts with the free camera', () => {
    expect(cameraStyle()).toBe('free');
    expect(isFree()).toBe(true);
    expect(isClassic()).toBe(false);
  });

  it('switches to the classic camera and clears a camera drag', () => {
    camDrag.kind = 'orbit';
    setCameraStyle('classic');
    expect(isClassic()).toBe(true);
    expect(camDrag.kind).toBe(null);
  });
});

describe('Esc order', () => {
  const none = { window: false, inHand: false, selected: false };

  it('closes a window first', () => {
    expect(escapeStep({ window: true, inHand: true, selected: true })).toBe('window');
  });

  it('then drops the brick in hand', () => {
    expect(escapeStep({ ...none, inHand: true, selected: true })).toBe('drop');
  });

  it('then deselects', () => {
    expect(escapeStep({ ...none, selected: true })).toBe('deselect');
  });

  it('then opens the Menu', () => {
    expect(escapeStep(none)).toBe('menu');
  });
});
