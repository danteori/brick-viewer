// The Bricks catalogue window (B): drag an entry into the scene (or click it, then click to place).

import { S, hasFocus } from '../../app/state.ts';
import { DEFAULT_COLOR, r3 } from '../../core/units.ts';
import { cloneBrick, type Brick, type V3 } from '../../scene/brick.ts';
import { CATALOGUE, iconSvg, type CatalogueEntry } from '../../editor/catalogue.ts';
import { ed, startPlacing } from '../../editor/ghost.ts';
import { $ } from '../dom.ts';
import { isTyping } from '../../editor/input.ts';
import { closeWindow, toggleWindow } from '../windows.ts';

const entryItems = (e: CatalogueEntry): Brick[] => [{
  micro: false, top: 'studs', tile: false, up: 1, ...cloneBrick(e.brick),
  color: (hasFocus() && S.focus ? S.focus.color : DEFAULT_COLOR).slice(), lo: [0, 0, 0], hi: e.size.map(r3) as V3,
}];

const LEAVE_PX = 8;

/** Hides the window once a drag from an entry starts moving, or once a press turns into click-to-place. */
function closeWhenPlacing(x0: number, y0: number): void {
  const stop = (): void => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  const move = (ev: PointerEvent): void => {
    if (!ed.ghost) { stop(); return; }
    if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > LEAVE_PX) { closeWindow('catwin'); stop(); }
  };
  const up = (): void => { if (ed.ghost?.mode === 'click') closeWindow('catwin'); stop(); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

export function initCataloguePanel(): void {
  const grid = $('bgrid');
  addEventListener('keydown', (e) => {
    if ((e.key !== 'b' && e.key !== 'B') || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    e.preventDefault();
    toggleWindow('catwin');
  });
  let group = '';
  for (const e of CATALOGUE) {
    if (e.group !== group) { group = e.group; const h = document.createElement('div'); h.className = 'bgroup'; h.textContent = group; grid.append(h); }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'bitem';
    b.innerHTML = iconSvg(e.icon) + `<span>${e.label}</span>`;
    b.title = `${e.label}: drag into the scene, or click it and then click to place`;
    b.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();                       // no focus / text selection: keys keep going to the scene
      startPlacing(entryItems(e), `place ${e.label.toLowerCase()}`, 'drag', b);
      closeWhenPlacing(ev.clientX, ev.clientY);
    });
    b.addEventListener('click', (ev) => {
      if (ev.detail !== 0) return;
      startPlacing(entryItems(e), `place ${e.label.toLowerCase()}`, 'click', b);
      closeWindow('catwin');
    });
    grid.append(b);
  }
}
