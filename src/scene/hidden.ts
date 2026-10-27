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

/** A wire between rows `a` and `b` (-1: an end outside the scene) is drawn: it needs both ends visible, or hidden bricks showing. */
export const wireDrawn = (s: SceneStore, a: number, b: number, shown: boolean, bit = hiddenBit(s)): boolean =>
  shown || !((a >= 0 && isHiddenRow(s, a, bit)) || (b >= 0 && isHiddenRow(s, b, bit)));

/** Of port keys with one flag per wire that uses them (true: the wire is drawn), the keys that only hidden wires use. */
export function portsOfHiddenWires(uses: Iterable<readonly [string, boolean]>): Set<string> {
  const drawn = new Set<string>(), all = new Set<string>();
  for (const [key, on] of uses) { all.add(key); if (on) drawn.add(key); }
  for (const key of drawn) all.delete(key);
  return all;
}

/** The mode after `m` in the toggle's cycle. */
export const nextHiddenMode = (m: HiddenMode): HiddenMode => HIDDEN_MODES[(HIDDEN_MODES.indexOf(m) + 1) % HIDDEN_MODES.length]!;
