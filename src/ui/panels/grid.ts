// The Grid section of Brick Properties (W-03 / W-04): which grid the focused brick is in, Select
// grid, New grid (from the selection), Move to grid (a list of the scene's grids), and the focused
// dynamic grid's location (units) and yaw / pitch / roll (degrees) to type. Shown only for a save
// that has moving grids or can take new ones (a world, or a recent save with the entity layout).

import { S, hasFocus } from '../../app/state.ts';
import { gridCounts, gridSetOf } from '../../scene/dyngrids.ts';
import { focusedGrid, gridFields, gridHud, moveToGrid, newGridFromSelection, selectGrid, selectedGrid, setGridTransform } from '../../editor/grids.ts';
import { ed } from '../../editor/ghost.ts';
import { initAudio, playSelect } from '../audio.ts';
import { setStatus } from '../status.ts';
import { $ } from '../dom.ts';

let toggle: HTMLButtonElement, body: HTMLElement, nameEl: HTMLElement, noteEl: HTMLElement, to: HTMLSelectElement;
let buttons: HTMLButtonElement[] = [], fields: HTMLInputElement[] = [];
let shown = '', listed = '';

function apply(): void {
  const g = focusedGrid();
  if (g <= 1) return;
  const v = fields.map((f) => Number(f.value));
  setGridTransform(g, [v[0]!, v[1]!, v[2]!], [v[3]!, v[4]!, v[5]!]);
  shown = '';
}

const ACTIONS: Record<string, () => void> = {
  select: () => {
    const g = focusedGrid();
    if (!g) { setStatus('Focus a brick first: its grid is the one selected'); return; }
    const n = selectGrid(g); playSelect();
    setStatus(`Selected ${g === 1 ? 'the main grid' : 'grid ' + g}: ${n} brick${n === 1 ? '' : 's'}`);
  },
  new: () => { newGridFromSelection(); },
  to: () => { if (to.value) moveToGrid(Number(to.value)); },
  apply,
};

export function initGridPanel(): void {
  toggle = $<HTMLButtonElement>('gridtoggle'); body = $('gridbody'); nameEl = $('gridname'); noteEl = $('gridnote'); to = $<HTMLSelectElement>('gridto');
  toggle.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });
  for (const t of ['pointerdown', 'dblclick', 'wheel']) body.addEventListener(t, (e) => e.stopPropagation());
  buttons = [...body.querySelectorAll<HTMLButtonElement>('button[data-grid]')];
  fields = [...body.querySelectorAll<HTMLInputElement>('input[data-xf]')];
  for (const b of buttons) b.addEventListener('click', () => { if (S.held || ed.ghost) return; initAudio(); ACTIONS[b.dataset.grid!]?.(); });
  for (const f of fields) f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); initAudio(); apply(); } });
  S.hooks.hud.push(gridHud);
}

/** Per-frame read-out (only touches the DOM when something changed). */
export function tickGrid(): void {
  const set = gridSetOf(S.scene), visible = !!set && (set.grids.size > 0 || !set.createProblem);
  if (toggle.hidden === visible) toggle.hidden = !visible;
  if (!visible) { if (!body.hidden) { body.hidden = true; toggle.setAttribute('aria-expanded', 'false'); } return; }
  const g = focusedGrid(), whole = selectedGrid(), xf = g > 1 ? set!.grids.get(g) : undefined, busy = S.held || !!ed.ghost;
  const key = `${g}|${whole}|${S.selection.size}|${busy}|${hasFocus()}|${set!.grids.size}|${S.scene.count}|${xf ? xf.origin.join() + xf.quat.join() : ''}`;
  if (key === shown) return;
  shown = key;
  nameEl.textContent = !g ? '' : g === 1 ? 'main grid' : `grid ${g}${whole ? ' (selected)' : ''}`;
  nameEl.classList.toggle('on', whole > 0);
  for (const b of buttons) {
    const a = b.dataset.grid!;
    b.disabled = busy || !hasFocus() || (a === 'new' && !!set!.createProblem) || (a === 'apply' && !xf);
    if (a === 'new') b.title = set!.createProblem ? `Can't make grids in this save: ${set!.createProblem}` : 'Make the selection (or the focused brick) a new moving grid, where it is';
  }
  // the grid list: the main grid and every moving grid, with brick counts
  const counts = gridCounts(S.scene), list = [...set!.grids.keys()].sort((a, b) => a - b);
  const lk = list.map((k) => `${k}:${counts.get(k) ?? 0}`).join();
  if (lk !== listed) {
    listed = lk;
    const keep = to.value;
    to.replaceChildren(new Option('Main grid', '1'), ...list.map((k) => new Option(`Grid ${k} (${counts.get(k) ?? 0} bricks)`, String(k))));
    if ([...to.options].some((o) => o.value === keep)) to.value = keep;
  }
  to.disabled = busy || !hasFocus();
  const f = xf ? gridFields(g) : null;
  const typing = fields.includes(document.activeElement as HTMLInputElement);
  fields.forEach((el, i) => {
    el.disabled = busy || !f;
    if (!typing) el.value = f ? String(i < 3 ? f.location[i] : f.euler[i - 3]) : '';
  });
  noteEl.textContent = !f ? (g === 1 ? 'The main grid stays put; focus a moving grid to place it.' : '') : f.exact ? '' : 'Turned by an angle that is not a quarter turn: drawn at the nearest one.';
}
