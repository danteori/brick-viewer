// The live hidden-brick state (backlog E-21; rules in scene/hidden.ts). The renderer, picking and
// box select ask hiddenShown(); the wire overlay (C-14) uses the same rule for wires to hidden bricks.

import { S, hasFocus } from './state.ts';
import { hiddenBit, pickableRow, showsHidden, type HiddenMode } from '../scene/hidden.ts';

/** The Esc menu toggle's mode. */
export const hiddenView: { mode: HiddenMode } = { mode: 'auto' };

/** Hidden (Visible off) bricks show this frame: always, never, or while a brick is focused or selected. */
export const hiddenShown = (): boolean => showsHidden(hiddenView.mode, hasFocus() || S.selection.size > 0);

/** Row `id` of the scene can be picked now (`bit`: hiddenBit of the scene, when known). */
export const hiddenPickable = (id: number, bit = hiddenBit(S.scene)): boolean => pickableRow(S.scene, id, hiddenShown(), bit);
