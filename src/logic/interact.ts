import type { MpsObject } from '../format/schema.ts';

export type InteractKind = 'switch' | 'button' | 'interact' | 'grid';

export const DEFAULT_LABEL = 'Interact';

const SWITCH = /Switch$/;
const BUTTON = /Button$/;
const PLAIN = /(?:^|_)Interact$/;
const GRID = /WholeGridInteracted$/;

/** What a component type does when the player interacts with its brick, or null if it is not interactable. */
export function interactKindOf(type: string): InteractKind | null {
  if (SWITCH.test(type)) return 'switch';
  if (BUTTON.test(type)) return 'button';
  if (PLAIN.test(type)) return 'interact';
  if (GRID.test(type)) return 'grid';
  return null;
}

export interface Interactable {
  type: string;
  kind: InteractKind;
  label: string;
  /** The prompt shows over the brick (the game hides it for a hidden interaction or a disabled component). */
  prompt: boolean;
  enabled: boolean;
}

const field = (data: MpsObject | null, name: string): unknown => (data as Record<string, unknown> | null)?.[name];

/** The prompt text: the component's custom label when it is not empty, else the default. */
export function promptLabel(data: MpsObject | null): string {
  const custom = field(data, 'PromptCustomLabel');
  return typeof custom === 'string' && custom.trim() ? custom : DEFAULT_LABEL;
}

/** A switch keeps its on/off state in bEnabled; on any other component bEnabled false turns the interaction off. */
export function isEnabled(kind: InteractKind, data: MpsObject | null): boolean {
  return kind === 'switch' || field(data, 'bEnabled') !== false;
}

/** The first interactable component of a brick, or null. */
export function interactableOf(components: readonly { type: string; data: MpsObject | null }[]): Interactable | null {
  for (const c of components) {
    const kind = interactKindOf(c.type);
    if (!kind) continue;
    const enabled = isEnabled(kind, c.data);
    return { type: c.type, kind, label: promptLabel(c.data), enabled, prompt: enabled && field(c.data, 'bHiddenInteraction') !== true };
  }
  return null;
}
