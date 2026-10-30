// Debug toggles: a switch between two candidate behaviours while the user decides (Menu → Debug options).
// A flag is on when its box is ticked (saved in localStorage) or when the URL names it: ?debug=a,b.

import { loadString, saveString } from './settings.ts';

export interface DebugFlag { readonly id: string; readonly label: string; on: boolean }

const KEY_PREFIX = 'brickViewer.debug.';
const flags: DebugFlag[] = [];
const listeners: Array<() => void> = [];

function urlFlags(): Set<string> {
  try { return new Set((new URLSearchParams(location.search).get('debug') ?? '').split(',').filter(Boolean)); } catch { return new Set(); }
}

/** Registers a flag (call once at module load); `label` says what ticking it switches to. */
export function debugFlag(id: string, label: string): DebugFlag {
  const stored = loadString(KEY_PREFIX + id);
  const flag: DebugFlag = { id, label, on: urlFlags().has(id) || stored === '1' };
  flags.push(flag);
  return flag;
}

export const debugFlags = (): readonly DebugFlag[] => flags;

export function setDebugFlag(flag: DebugFlag, on: boolean): void {
  flag.on = on;
  saveString(KEY_PREFIX + flag.id, on ? '1' : '0');
  for (const f of listeners) f();
}

/** Calls `f` after any flag changes (redraw, rebuild a panel). */
export const onDebugFlagChange = (f: () => void): void => { listeners.push(f); };

/** Fills #debugbox with one checkbox per flag; the box stays hidden while there are none. */
export function renderDebugBox(): void {
  const box = document.getElementById('debugbox');
  if (!box) return;
  box.hidden = flags.length === 0;
  const list = box.querySelector('.debuglist') ?? box;
  list.replaceChildren(...flags.map((flag) => {
    const row = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = flag.on;
    input.dataset.debug = flag.id;
    input.addEventListener('change', () => setDebugFlag(flag, input.checked));
    row.append(input, ` ${flag.label}`);
    return row;
  }));
}
