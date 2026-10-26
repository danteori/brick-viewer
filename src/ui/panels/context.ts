import { S, hasFocus } from '../../app/state.ts';
import { isFree } from '../../app/mode.ts';
import { ed } from '../../editor/ghost.ts';
import { effectiveIds } from '../../editor/select.ts';
import { FLAG_PROPS, flagMask, flagState, writeFlags } from '../../scene/brickflags.ts';
import { histEnd, txBegin, txEnd } from '../../scene/history.ts';
import type { SceneStore } from '../../scene/store.ts';
import { focusRect } from '../overlay/dims.ts';
import { initAudio, playClick } from '../audio.ts';
import { $ } from '../dom.ts';
import { placeholder } from '../placeholder.ts';
import { refreshFocus } from './paint.ts';

const GAP = 56, MARGIN = 12;

const LABELS: Record<string, string> = {
  visible: placeholder('Visible'), collision: placeholder('Collision'),
  player1: placeholder('Player Collision 1'), player2: placeholder('Player Collision 2'),
  player3: placeholder('Player Collision 3'), player4: placeholder('Player Collision 4'),
};

let props: HTMLElement, flagBody: HTMLElement, done: HTMLButtonElement;
let switches: { key: string; fields: readonly string[]; el: HTMLButtonElement }[] = [];
let dismissed = false, openKey = '', shownFlags = '';
let lastScene: SceneStore | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string>, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function buildFlags(): void {
  const toggle = el('button', { type: 'button', id: 'flagtoggle', 'aria-controls': 'flagbody' }, placeholder('Properties'));
  const chev = $('ptoggle').querySelector('.chev');
  if (chev) toggle.append(chev.cloneNode(true));
  flagBody = el('div', { id: 'flagbody' });
  switches = FLAG_PROPS.map(({ key, fields }) => {
    const row = el('div', { class: 'flagrow' });
    const sw = el('button', { type: 'button', role: 'checkbox', class: 'flagsw', 'data-flag': key, 'aria-checked': 'true', 'aria-label': LABELS[key]! });
    sw.append(el('span', { class: 'knob' }));
    row.append(el('span', {}, LABELS[key]), sw);
    sw.addEventListener('click', () => {
      if (S.held || ed.ghost) return;
      applyFlags(fields, flagState(S.scene, effectiveIds(), flagMask(S.scene, fields)) !== 'on');
    });
    flagBody.append(row);
    return { key, fields, el: sw };
  });
  const open = isFree();
  flagBody.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.addEventListener('click', () => {
    const show = flagBody.hidden;
    flagBody.hidden = !show; toggle.setAttribute('aria-expanded', String(show));
    shownFlags = '';
  });
  $('comptoggle').before(toggle, flagBody);
}

/** Turns the save fields `fields` on or off for the selection (or the focused brick), as one undo step. */
export function applyFlags(fields: readonly string[], on: boolean): number {
  const s = S.scene, ids = effectiveIds(), mask = flagMask(s, fields);
  if (!ids.length || !mask) return 0;
  histEnd();
  const sel = [...S.selection];
  const t = txBegin(on ? 'turn property on' : 'turn property off', ids, { selBefore: sel });
  const changed = writeFlags(s, ids, mask, on);
  if (changed.includes(S.sel)) refreshFocus();
  txEnd(t, { selAfter: sel });
  if (changed.length) { initAudio(); playClick(); }
  shownFlags = '';
  return changed.length;
}

function showFlags(): void {
  if (flagBody.hidden) return;
  const ids = effectiveIds(), key = `${S.scene.rev}|${S.sel}|${ids.length}|${ids[0]}|${S.selection.size}`;
  if (key === shownFlags) return;
  shownFlags = key;
  for (const sw of switches) {
    const state = flagState(S.scene, ids, flagMask(S.scene, sw.fields));
    sw.el.disabled = state === 'none';
    sw.el.setAttribute('aria-checked', state === 'mixed' ? 'mixed' : String(state !== 'off'));
  }
}

const frozen = (): boolean => S.held || props.matches(':hover') || props.contains(document.activeElement);

function place(docked: boolean): void {
  if (frozen()) return;
  const w = props.offsetWidth, h = props.offsetHeight, vw = innerWidth, vh = innerHeight, r = docked ? null : focusRect;
  let x = vw - w - MARGIN, y = MARGIN;
  if (r) {
    const right = r[2] + GAP, left = r[0] - GAP - w;
    x = right + w <= vw - MARGIN ? right : left >= MARGIN ? left : vw - r[2] >= r[0] ? right : left;
    y = (r[1] + r[3]) / 2 - h / 2;
  }
  x = Math.round(Math.max(MARGIN, Math.min(x, vw - w - MARGIN)));
  y = Math.round(Math.max(MARGIN, Math.min(y, vh - h - MARGIN)));
  if (props.style.left !== `${x}px`) props.style.left = `${x}px`;
  if (props.style.top !== `${y}px`) props.style.top = `${y}px`;
}

export function initContextPanel(): void {
  props = $('props');
  buildFlags();
  if (!isFree()) return;
  props.classList.add('ctx');
  props.prepend($('tool'), $('menu'), $('mode'));
  done = el('button', { type: 'button', id: 'ctxdone' }, placeholder('DONE'));
  done.addEventListener('click', () => { dismissed = true; props.hidden = true; done.blur(); });
  props.append(done);
  for (const [id, open] of [['seltoggle', false], ['comptoggle', true]] as const) {
    const t = $<HTMLButtonElement>(id);
    if ((t.getAttribute('aria-expanded') === 'true') !== open) t.click();
  }
  props.hidden = true;
}

/** Per frame, after the overlays: the flag switches, and in the free camera the panel's visibility and place. */
export function tickContextPanel(): void {
  if (!isFree()) { showFlags(); return; }
  const key = `${S.sel}|${S.selection.size}`;
  if (key !== openKey || S.scene !== lastScene) { openKey = key; lastScene = S.scene; dismissed = false; }
  const placing = !!ed.ghost, show = placing || ((hasFocus() || S.selection.size > 0) && !dismissed);
  if (props.hidden === show) props.hidden = !show;
  props.classList.toggle('placing', placing);
  if (!show) return;
  if (!placing) showFlags();
  place(placing);
}
