import { S, hasFocus } from '../../app/state.ts';
import { DEFAULT_COLOR, r3 } from '../../core/units.ts';
import { cloneBrick, type Brick, type V3 } from '../../scene/brick.ts';
import { CATALOGUE, iconSvg, type CatalogueEntry } from '../../editor/catalogue.ts';
import { clip, setPasteMode } from '../../editor/clipboard.ts';
import { startPlacing } from '../../editor/ghost.ts';
import { $ } from '../dom.ts';
import { isTyping } from '../../editor/input.ts';
import { closeWindow, toggleWindow } from '../windows.ts';

const entryItems = (e: CatalogueEntry): Brick[] => [{
  micro: false, top: 'studs', tile: false, up: 1, ...cloneBrick(e.brick),
  color: (hasFocus() && S.focus ? S.focus.color : DEFAULT_COLOR).slice(), lo: [0, 0, 0], hi: e.size.map(r3) as V3,
}];

/** Takes the entry as the ghost brick, as a middle-click on a brick does: click to place, Ctrl+V for another. */
function pickEntry(e: CatalogueEntry, from: HTMLElement): void {
  clip.items = entryItems(e); clip.origin = null;
  setPasteMode('brick');
  startPlacing(clip.items, `place ${e.label.toLowerCase()}`, 'click', from, { drop: true });
  closeWindow('catwin');
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
    b.title = `${e.label}: click it, then click to place`;
    b.addEventListener('pointerdown', (ev) => { if (ev.button === 0) ev.preventDefault(); });
    b.addEventListener('click', () => pickEntry(e, b));
    grid.append(b);
  }
}
