// The Selection section of Brick Properties (E-01 / E-02): the count, select all / by colour /
// connected / clear, and move / copy / cut / delete. With nothing selected the operations act on
// the focused brick, so they stay enabled while there is one.

import { S, hasFocus } from '../../app/state.ts';
import { clearSelection, selectAll, selectConnected, selectSameColour, selectSameType, selector } from '../../editor/select.ts';
import { loadString, saveString } from '../../app/settings.ts';
import { copySelection, cutSelection, deleteSelection } from '../../editor/selectops.ts';
import { setTool } from '../../editor/tools.ts';
import { ed } from '../../editor/ghost.ts';
import { initAudio, playClick, playSelect } from '../audio.ts';
import { setStatus } from '../status.ts';
import { $ } from '../dom.ts';

let countEl: HTMLElement, buttons: HTMLButtonElement[] = [], shown = '';

const ACTIONS: Record<string, () => void> = {
  all: () => { const n = selectAll(); setStatus(`Selected all ${n} brick${n === 1 ? '' : 's'}`); playSelect(); },
  colour: () => {
    if (!hasFocus()) { setStatus('Focus a brick first: its colour is the one selected'); return; }
    const n = selectSameColour(S.sel); setStatus(`Selected ${n} brick${n === 1 ? '' : 's'} of the focused brick's colour`); playSelect();
  },
  type: () => {
    if (!hasFocus()) { setStatus('Focus a brick first: its type is the one selected'); return; }
    const n = selectSameType(S.sel); setStatus(`Selected ${n} brick${n === 1 ? '' : 's'} of the focused brick's type`); playSelect();
  },
  connected: () => {
    const n = selectConnected();
    setStatus(n ? `Selected ${n} connected brick${n === 1 ? '' : 's'} (touching face to face)` : 'Nothing to start from: focus or select a brick'); playSelect();
  },
  clear: () => { clearSelection(); setStatus('Selection cleared'); playClick(); },
  move: () => setTool('move'),
  copy: () => { copySelection(); playClick(); },
  cut: () => cutSelection(),
  delete: () => deleteSelection(),
};

export function initSelectionPanel(): void {
  const toggle = $<HTMLButtonElement>('seltoggle'), body = $('selbody');
  countEl = $('selcount');
  toggle.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });
  buttons = [...body.querySelectorAll<HTMLButtonElement>('button[data-sel]')];
  // the Selector setting (Brick / Box), remembered
  const modeBtns = [...body.querySelectorAll<HTMLButtonElement>('button[data-selector]')];
  const setMode = (m: 'brick' | 'box'): void => {
    selector.mode = m; selector.box = null;
    for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.selector === m));
    saveString('brickViewer.selector', m);
  };
  const saved = loadString('brickViewer.selector');
  setMode(saved === 'box' && !S.testMode ? 'box' : 'brick');
  for (const b of modeBtns) b.addEventListener('click', () => {
    setMode(b.dataset.selector as 'brick' | 'box'); initAudio(); playClick();
    setStatus(b.dataset.selector === 'box' ? 'Selector: Box. Shift+click grows a box from the focused brick; every brick fully inside is selected' : 'Selector: Brick. Shift+click adds one brick at a time');
  });
  for (const b of buttons) {
    b.addEventListener('click', () => {
      if (S.held || ed.ghost) return;
      initAudio();
      ACTIONS[b.dataset.sel!]?.();
    });
  }
}

/** Per-frame read-out (only touches the DOM when something changed). */
export function tickSelection(): void {
  const n = S.selection.size, busy = !!ed.ghost || S.held, focus = hasFocus();
  const key = `${n}|${busy}|${focus}|${S.scene.count}`;
  if (key === shown) return;
  shown = key;
  countEl.textContent = n ? `${n} selected` : focus ? 'focused brick' : '';
  countEl.classList.toggle('on', n > 0);
  for (const b of buttons) {
    const a = b.dataset.sel!;
    b.disabled = busy || (a === 'clear' ? !n : a === 'all' ? !S.scene.count : a === 'colour' || a === 'type' ? !focus : !(n || focus));
  }
}
