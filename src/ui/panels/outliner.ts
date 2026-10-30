// The outliner (W-10): a window that lists the main grid, the moving grids, the microchip grids, the
// other entities and the joints of the open save or world, with brick counts and frozen / asleep
// badges. A click on a row selects the grid and frames it. A moving grid's frozen flag and
// BrickGridDynamicActor settings are edited below the list. All words wait for the owner.

import { S } from '../../app/state.ts';
import { debugFlag, onDebugFlagChange } from '../../app/debugflags.ts';
import { rowOfChipGrid } from '../../app/chips.ts';
import { GRIDS } from '../../scene/store.ts';
import { gridSetOf, propsOf, rowsOfGrid, type GridProps, type GridSettings } from '../../scene/dyngrids.ts';
import { componentsOf } from '../../scene/compmodel.ts';
import { outlineRows, type OutlineKind, type OutlineRow } from '../../scene/outline.ts';
import { selectedGrid, selectGrid, setGridProps } from '../../editor/grids.ts';
import { clearSelection } from '../../editor/select.ts';
import { frameRows } from '../../editor/frame.ts';
import { initAudio, playSelect } from '../audio.ts';
import { setStatus } from '../status.ts';
import { $ } from '../dom.ts';
import { placeholder } from '../placeholder.ts';
import { initWindow, closeWindow, toggleWindow } from '../windows.ts';
import '../outliner.css';

const WIN = 'outlinewin';
const applyButton = debugFlag('outliner-apply-button', 'Outliner settings: edit the fields, then one Apply button writes them all as one undo step (default: each change applies at once)');

const KIND_TEXT: Record<OutlineKind, string> = {
  main: placeholder('[TEXT: main grid]'),
  dynamic: placeholder('[TEXT: moving grid]'),
  microchip: placeholder('[TEXT: microchip]'),
  orphan: placeholder('[TEXT: unused grid]'),
  entity: placeholder('[TEXT: entity]'),
  joint: placeholder('[TEXT: joint]'),
};
const T = {
  title: placeholder('[TEXT: Outliner]'),
  bricks: placeholder('[TEXT: bricks]'),
  frozen: placeholder('[TEXT: frozen]'),
  asleep: placeholder('[TEXT: asleep]'),
  mass: placeholder('[TEXT: Mass scale]'),
  buoyancy: placeholder('[TEXT: Buoyancy scale]'),
  gravity: placeholder('[TEXT: Gravity]'),
  collision: placeholder('[TEXT: Collision detail]'),
  coarse: placeholder('[TEXT: Coarse]'),
  fine: placeholder('[TEXT: Fine]'),
  freeze: placeholder('[TEXT: Frozen]'),
  apply: placeholder('[TEXT: Apply]'),
  noSettings: placeholder('[TEXT: This save stores no settings for this grid.]'),
  notInScene: placeholder('[TEXT: Not shown in the scene.]'),
  framed: placeholder('[TEXT: Framed]'),
  empty: placeholder('[TEXT: Nothing to show for this grid.]'),
  settingsEdit: placeholder('[TEXT: Grid settings changed]'),
};

let list: HTMLElement, edit: HTMLElement, note: HTMLElement, applyBtn: HTMLButtonElement;
let fMass: HTMLInputElement, fBuoy: HTMLInputElement, fGravity: HTMLInputElement, fQuality: HTMLSelectElement, fFrozen: HTMLInputElement;
let rows: OutlineRow[] = [], chosen = '', lastSelected = 0, shownRows = '', shownEdit = '';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
};

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const l = h('label');
  l.append(h('span', {}, text), control);
  return l;
}

function build(): HTMLElement {
  const win = h('section', { id: WIN, class: 'win', role: 'dialog', 'aria-labelledby': 'outlinetitle', hidden: '' });
  const head = h('div', { class: 'winhead' });
  head.append(h('h2', { class: 'wintitle', id: 'outlinetitle' }, T.title), h('button', { type: 'button', class: 'winclose', 'aria-label': 'Close' }, '×'));
  const body = h('div', { class: 'winbody' });
  list = h('ul', { id: 'outlinelist' });
  edit = h('div', { id: 'outlineedit', hidden: '' });
  fMass = h('input', { type: 'number', min: '0', step: '0.1', 'data-set': 'MassScale' });
  fBuoy = h('input', { type: 'number', min: '0', step: '0.1', 'data-set': 'BouyancyScale' });
  fGravity = h('input', { type: 'checkbox', 'data-set': 'bEnableGravity' });
  fQuality = h('select', { 'data-set': 'CollisionQuality' });
  fQuality.append(new Option(T.coarse, '0'), new Option(T.fine, '1'));
  fFrozen = h('input', { type: 'checkbox', 'data-set': 'locked' });
  applyBtn = h('button', { type: 'button', id: 'outlineapply' }, T.apply);
  note = h('div', { id: 'outlinenote' });
  edit.append(labelled(T.freeze, fFrozen), labelled(T.mass, fMass), labelled(T.buoyancy, fBuoy), labelled(T.gravity, fGravity), labelled(T.collision, fQuality), applyBtn, note);
  body.append(list, edit);
  win.append(head, body);
  return win;
}

function rowsToFrame(r: OutlineRow): number[] {
  const s = S.scene;
  if (r.kind === 'main') { const g = GRIDS.id('1'); return [...s.ids()].filter((id) => s.grid[id] === g); }
  if (r.kind === 'dynamic') return rowsOfGrid(s, r.id);
  if (r.kind === 'microchip') { const row = rowOfChipGrid(r.id); return row >= 0 ? [row] : []; }
  if (r.kind === 'joint') {
    if (r.id === 1 && r.chunk) { const row = componentsOf(s)?.rowOfRef({ grid: 1, chunk: r.chunk, brick: r.brick }) ?? -1; return row >= 0 ? [row] : []; }
    return rowsOfGrid(s, r.id);
  }
  return [];
}

function choose(r: OutlineRow): void {
  chosen = r.key;
  initAudio();
  const target = rowsToFrame(r);
  shownRows = '';
  if (!target.length) { setStatus(r.kind === 'dynamic' ? T.empty : T.notInScene); return; }
  if (r.kind === 'dynamic') { selectGrid(r.id); lastSelected = r.id; } else clearSelection();
  frameRows(target);
  playSelect();
  setStatus(`${T.framed}: ${KIND_TEXT[r.kind]} ${r.id}`);
}

function rowButton(r: OutlineRow, on: boolean): HTMLLIElement {
  const li = h('li');
  const b = h('button', { type: 'button', class: `orow${on ? ' on' : ''}`, 'data-key': r.key, 'aria-pressed': String(on) });
  const name = r.kind === 'joint' ? `${r.id} / ${r.target}` : String(r.id);
  b.append(h('span', { class: 'okind' }, `${KIND_TEXT[r.kind]} ${name}`));
  b.append(h('span', { class: 'ocount' }, r.bricks === null ? '' : `${r.bricks} ${T.bricks}`));
  if (r.type) b.append(h('span', { class: 'otype' }, r.type));
  const badges = h('span', { class: 'obadges' });
  if (r.frozen) badges.append(h('span', { class: 'obadge frozen', 'data-badge': 'frozen' }, T.frozen));
  if (r.sleeping) badges.append(h('span', { class: 'obadge', 'data-badge': 'asleep' }, T.asleep));
  b.append(badges);
  li.append(b);
  return li;
}

function chosenGrid(): OutlineRow | null {
  const r = rows.find((x) => x.key === chosen);
  return r && r.kind === 'dynamic' ? r : null;
}

function readFields(): GridProps | null {
  const set = gridSetOf(S.scene), g = chosenGrid();
  if (!set || !g) return null;
  const now = propsOf(set, g.id);
  const num = (el: HTMLInputElement, was: number): number => { const v = Number(el.value); return el.value.trim() !== '' && Number.isFinite(v) && v >= 0 ? v : was; };
  const settings: GridSettings | null = now.settings && {
    MassScale: num(fMass, now.settings.MassScale),
    BouyancyScale: num(fBuoy, now.settings.BouyancyScale),
    bEnableGravity: fGravity.checked,
    CollisionQuality: Number(fQuality.value),
  };
  return { locked: fFrozen.checked, settings };
}

function commit(): void {
  const g = chosenGrid(), next = readFields();
  if (!g || !next) return;
  initAudio();
  setGridProps(g.id, next, T.settingsEdit);
  shownEdit = '';
}

export function initOutliner(): void {
  const win = build();
  document.body.append(win);
  initWindow(WIN);
  const btn = h('button', { type: 'button', id: 'outlinebtn', 'aria-expanded': 'false', 'aria-controls': WIN }, T.title);
  $('mview').append(btn);
  for (const t of ['pointerdown', 'dblclick', 'wheel']) btn.addEventListener(t, (e) => e.stopPropagation());
  btn.addEventListener('click', () => { closeWindow('escmenu'); toggleWindow(WIN); btn.setAttribute('aria-expanded', String(!win.hidden)); });
  win.querySelector('.winclose')?.addEventListener('click', () => btn.setAttribute('aria-expanded', 'false'));
  list.addEventListener('click', (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('button[data-key]')?.dataset.key;
    const r = rows.find((x) => x.key === key);
    if (r) choose(r);
  });
  for (const el of [fMass, fBuoy, fGravity, fQuality, fFrozen]) {
    el.addEventListener('change', () => { if (!applyButton.on || el === fFrozen) commit(); });
    el.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); commit(); } });
  }
  applyBtn.addEventListener('click', commit);
  onDebugFlagChange(() => { shownEdit = ''; });
}

/** Per-frame refresh while the window is open (the DOM changes only when the data did). */
export function tickOutliner(): void {
  const win = document.getElementById(WIN);
  if (!win || win.hidden) return;
  const set = gridSetOf(S.scene), sel = selectedGrid();
  if (sel && sel !== lastSelected) chosen = `dynamic:${sel}:0:-1`;
  lastSelected = sel;
  const propsKey = set ? [...set.props].map(([g, p]) => `${g}${p.locked ? 'L' : ''}${p.settings ? Object.values(p.settings).join('/') : ''}`).join() : '';
  const key = `${S.scene.rev}|${S.scene.count}|${set?.grids.size ?? 0}|${propsKey}|${chosen}`;
  if (key !== shownRows) {
    shownRows = key;
    rows = outlineRows(S.scene);
    list.replaceChildren(...rows.map((r) => rowButton(r, r.key === chosen)));
  }
  const g = chosenGrid(), p = g && set ? propsOf(set, g.id) : null;
  const editKey = `${g?.id ?? 0}|${p ? `${p.locked}|${p.settings ? Object.values(p.settings).join('/') : '-'}` : ''}|${applyButton.on}`;
  if (editKey === shownEdit) return;
  shownEdit = editKey;
  edit.hidden = !p;
  if (!p) return;
  const typing = edit.contains(document.activeElement) && document.activeElement !== applyBtn;
  fFrozen.checked = p.locked;
  const off = !p.settings;
  for (const el of [fMass, fBuoy, fGravity, fQuality]) el.disabled = off;
  if (!typing && p.settings) {
    fMass.value = String(p.settings.MassScale); fBuoy.value = String(p.settings.BouyancyScale);
    fGravity.checked = p.settings.bEnableGravity; fQuality.value = String(p.settings.CollisionQuality);
  }
  if (off) { fMass.value = ''; fBuoy.value = ''; fGravity.checked = false; }
  applyBtn.hidden = !applyButton.on || off;
  note.textContent = off ? T.noSettings : '';
}
