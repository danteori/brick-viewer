// The Bricks catalogue panel: drag an entry into the scene (or click it, then click to place).

import { S, hasFocus } from '../../app/state.ts';
import { DEFAULT_COLOR, r3 } from '../../core/units.ts';
import { cloneBrick, type Brick, type V3 } from '../../scene/brick.ts';
import { CATALOGUE, iconSvg, type CatalogueEntry } from '../../editor/catalogue.ts';
import { startPlacing } from '../../editor/ghost.ts';
import { $ } from '../dom.ts';

const entryItems = (e: CatalogueEntry): Brick[] => [{
  micro: false, top: 'studs', tile: false, up: 1, ...cloneBrick(e.brick),
  color: (hasFocus() && S.focus ? S.focus.color : DEFAULT_COLOR).slice(), lo: [0, 0, 0], hi: e.size.map(r3) as V3,
}];

export function initCataloguePanel(): void {
  const grid = $('bgrid'), btoggle = $('btoggle');
  for (const t of ['pointerdown', 'dblclick', 'wheel']) for (const id of ['bricks', 'pastemode']) $(id).addEventListener(t, (e) => e.stopPropagation());
  btoggle.addEventListener('click', () => {
    const open = grid.hidden;
    grid.hidden = !open; btoggle.setAttribute('aria-expanded', String(open));
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
    });
    b.addEventListener('click', (ev) => { if (ev.detail === 0) startPlacing(entryItems(e), `place ${e.label.toLowerCase()}`, 'click', b); });   // keyboard
    grid.append(b);
  }
}
