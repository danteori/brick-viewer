// Explore / Edit modes (U-24). Explore is the startup mode: the camera moves freely and mouse clicks
// never touch bricks. Edit is the editor. This module is DOM-free: the mode, its listeners and the
// Esc rule, so the state machine is unit-tested on its own. The wiring (input, indicator) is explore.ts.

export type Mode = 'explore' | 'edit';
export type EscAction = 'clear' | 'exit';

let mode: Mode = 'explore';
const listeners: ((m: Mode, prev: Mode) => void)[] = [];

/**
 * Edit was entered without choosing a brick (a panel, the toggle, a paste): the camera stays where
 * it is instead of gliding onto the focused brick. Cleared by anything that moves the focus or
 * starts a drag.
 */
export const exploreDrag = { kind: null as null | 'orbit' | 'pan' };

/** The HUD hint line of each mode. */
export const HINT: Record<Mode, string> = {
  explore: '<b>Explore</b> · drag to orbit · right-drag or WASD to pan (Shift = faster) · scroll zooms toward the cursor · double-click a brick to edit it · bricks are not touched in Explore',
  edit: '<b>Edit</b> · Esc clears the selection, then returns to Explore',
};

export const hold = { cam: false };

export const getMode = (): Mode => mode;
export const isExplore = (): boolean => mode === 'explore';
export const isEdit = (): boolean => mode === 'edit';
export function onModeChange(f: (m: Mode, prev: Mode) => void): void { listeners.push(f); }

/** Switches mode; false when it already was. */
export function setMode(m: Mode): boolean {
  if (m === mode) return false;
  const prev = mode;
  mode = m;
  hold.cam = m === 'edit';
  for (const f of listeners) f(m, prev);
  return true;
}
export const enterEdit = (): boolean => setMode('edit');
export const enterExplore = (): boolean => setMode('explore');

/**
 * What Esc does in Edit: clear the selection / the brick in hand while there is one, else leave for
 * Explore. In Explore Esc does nothing.
 */
export function escapeAction(clearable: boolean): EscAction { return clearable ? 'clear' : 'exit'; }

/** Sets the starting mode (the ?test hook starts in Edit): no listeners, no camera hold. */
export function resetMode(m: Mode = 'explore'): void { mode = m; hold.cam = false; }
