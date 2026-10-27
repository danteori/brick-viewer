// Hidden bricks (backlog E-21): rows whose VisibilityFlags field is 0 (Visible off). The game never
// draws them; the viewer shows them as see-through ghosts while a brick is selected, or as the
// Esc menu's toggle says. These are the pure rules; app/hidden.ts applies them to the live state.

import { flagMask } from './brickflags.ts';
import { F_HAS_FLAGS, type SceneStore } from './store.ts';

/** How hidden bricks show: by the selection ('auto'), always ('show') or never ('hide'). */
export type HiddenMode = 'auto' | 'show' | 'hide';
export const HIDDEN_MODES: readonly HiddenMode[] = ['auto', 'show', 'hide'];

/** The collision bit that marks Visible off in store `s`, 0 when its save has no VisibilityFlags field. */
export const hiddenBit = (s: SceneStore): number => flagMask(s, ['VisibilityFlags']);

/** Row `id` has Visible off (`bit` from hiddenBit). */
export const isHiddenRow = (s: SceneStore, id: number, bit = hiddenBit(s)): boolean =>
  bit !== 0 && (s.flags[id]! & F_HAS_FLAGS) !== 0 && (s.collision[id]! & bit) !== 0;

/** Hidden bricks show in `mode` when `selected` says a brick is focused or selected. */
export const showsHidden = (mode: HiddenMode, selected: boolean): boolean => mode === 'show' || (mode === 'auto' && selected);

/** Row `id` can be picked: a visible row always, a hidden one only while hidden bricks show. */
export const pickableRow = (s: SceneStore, id: number, shown: boolean, bit = hiddenBit(s)): boolean => shown || !isHiddenRow(s, id, bit);

/** The mode after `m` in the toggle's cycle. */
export const nextHiddenMode = (m: HiddenMode): HiddenMode => HIDDEN_MODES[(HIDDEN_MODES.indexOf(m) + 1) % HIDDEN_MODES.length]!;
