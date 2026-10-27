import { describe, expect, it } from 'vitest';
import { DEFAULT_LABEL, interactableOf, interactKindOf, promptLabel } from '../../src/logic/interact.ts';
import type { MpsObject } from '../../src/format/schema.ts';

const data = (o: Record<string, unknown>): MpsObject => o as unknown as MpsObject;

describe('interact prompt', () => {
  it('uses the custom label when it is not empty, else the default', () => {
    expect(promptLabel(data({ PromptCustomLabel: 'Open door' }))).toBe('Open door');
    expect(promptLabel(data({ PromptCustomLabel: '' }))).toBe(DEFAULT_LABEL);
    expect(promptLabel(data({ PromptCustomLabel: '   ' }))).toBe(DEFAULT_LABEL);
    expect(promptLabel(data({}))).toBe(DEFAULT_LABEL);
    expect(promptLabel(null)).toBe('Interact');
  });

  it('knows the interactable component types and not seats', () => {
    for (const t of ['Component_Button', 'Component_Switch', 'Component_Internal_AnimatedButton', 'Component_Internal_AnimatedSwitch', 'Component_Interact', 'BrickComponentType_WireGraph_Exec_WholeGridInteracted']) {
      expect(interactKindOf(t), t).not.toBeNull();
    }
    expect(interactKindOf('Component_Internal_Seat')).toBeNull();
    expect(interactKindOf('Component_PointLight')).toBeNull();
  });

  it('hides the prompt for a hidden interaction and a disabled component', () => {
    const b = (d: Record<string, unknown>) => interactableOf([{ type: 'Component_Button', data: data(d) }])!;
    expect(b({}).prompt).toBe(true);
    expect(b({ bHiddenInteraction: true })).toMatchObject({ prompt: false, enabled: true });
    expect(b({ bEnabled: false })).toMatchObject({ prompt: false, enabled: false });
  });

  it('keeps the prompt on a switch that is off', () => {
    expect(interactableOf([{ type: 'Component_Switch', data: data({ bEnabled: false }) }])).toMatchObject({ kind: 'switch', prompt: true, enabled: true });
  });

  it('takes the first interactable of a brick', () => {
    const r = interactableOf([{ type: 'Component_PointLight', data: null }, { type: 'Component_Button', data: data({ PromptCustomLabel: 'Go' }) }]);
    expect(r?.label).toBe('Go');
    expect(interactableOf([{ type: 'Component_PointLight', data: null }])).toBeNull();
  });
});
