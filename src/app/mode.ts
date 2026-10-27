export type CameraStyle = 'free' | 'classic';

let style: CameraStyle = 'free';

/** A free-camera drag in progress (the hover and the cursor read it). */
export const camDrag = { kind: null as null | 'orbit' | 'pan' };

/** The HUD hint line. */
export const HINT = 'drag to orbit · right-drag orbits · middle-drag pans · WASD moves, Space up, Shift down · scroll zooms toward the cursor · click a brick to select it, double-click to centre on it · B bricks · Esc menu';

export const cameraStyle = (): CameraStyle => style;
export const isFree = (): boolean => style === 'free';
export const isClassic = (): boolean => style === 'classic';

/** Sets the camera style at startup (the ?test hook uses the classic one). */
export function setCameraStyle(s: CameraStyle): void { style = s; camDrag.kind = null; }

export type EscStep = 'window' | 'drop' | 'deselect' | 'menu';

/**
 * What Esc does, in order: close the top window, then drop the brick in hand (or cancel the tool
 * drag), then deselect, then open the Menu.
 */
export function escapeStep(s: { window: boolean; inHand: boolean; selected: boolean }): EscStep {
  return s.window ? 'window' : s.inHand ? 'drop' : s.selected ? 'deselect' : 'menu';
}
