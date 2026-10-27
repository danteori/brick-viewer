// Typed sizes: the dimension labels (real text inputs parked on the dimension lines) and the
// top-left size menu, plus the Brick / Tile / Smooth Tile / Microbrick type buttons. Enter / click
// away applies, Esc cancels, Up / Down step one stud or plate. Like dragging, typing only moves the
// near face.

import { S, hasFocus } from '../../app/state.ts';
import { BRZ_UNIT } from '../../core/units.ts';
import { brickType, lockedType, sizeRule, type Brick } from '../../scene/brick.ts';
import { isFixedAxis, maxUnits, minUnits, setMode, setSize, units } from '../../editor/resize.ts';
import { ghostItemsVersion } from '../../editor/ghost.ts';
import { ghostBrick, ghostFixedAxis, ghostMaxUnits, ghostMinUnits, ghostUnits, setGhostSize, setGhostType } from '../../editor/ghostsize.ts';
import { fmtUnits, kindOf, parseUnits, stepKind } from '../names.ts';
import { initAudio } from '../audio.ts';
import { $ } from '../dom.ts';

export interface DimBox { box: HTMLLabelElement; inp: HTMLInputElement; fitWidth: () => void }
export let dimBox: DimBox[] = [];
export let menuInp: HTMLInputElement[] = [];
let modeBtns: HTMLButtonElement[] = [];

/** What a size field changes: the focused brick, or the ghost brick while one is in hand. */
interface SizeTarget {
  kind(i: number): string; units(i: number): number; min(i: number): number; max(i: number): number; set(i: number, n: number): void;
}
const focusTarget: SizeTarget = {
  kind: (i) => stepKind(i), units: (i) => units(i), min: (i) => minUnits(i), max: (i) => maxUnits(i), set: (i, n) => setSize(i, n),
};
function ghostTarget(t: Brick): SizeTarget {
  return {
    kind: (i) => kindOf(sizeRule(t).steps[i]!, !!t.micro), units: (i) => ghostUnits(t, i),
    min: (i) => ghostMinUnits(t, i), max: (i) => ghostMaxUnits(t, i), set: (i, n) => { setGhostSize(i, n); },
  };
}
/** The menu fields and type buttons act on the ghost brick while one is in hand, else on the focused brick. */
function panelTarget(): SizeTarget {
  const t = ghostBrick();
  return t ? ghostTarget(t) : focusTarget;
}

function wireSizeInput(inp: HTMLInputElement, i: number, holder: HTMLElement, fitWidth: () => void = () => {}, target = (): SizeTarget => focusTarget): void {
  inp.inputMode = i < 2 ? 'numeric' : 'text'; inp.autocomplete = 'off'; inp.spellcheck = false;
  inp.setAttribute('aria-label', i < 2 ? `${'XY'[i]} size in studs` : 'height in bricks + plates, e.g. 1+2f');
  const apply = (): void => { const t = target(); t.set(i, parseUnits(i, inp.value, t.kind(i))); };
  holder.addEventListener('pointerdown', (e) => e.stopPropagation());   // clicking it isn't a drag
  holder.addEventListener('dblclick', (e) => e.stopPropagation());
  inp.addEventListener('focus', () => { initAudio(); inp.select(); });
  inp.addEventListener('input', () => {
    inp.value = target().kind(i) === 'plate' ? inp.value.replace(/[^0-9+f]/gi, '').slice(0, 6)   // bricks + plates
      : inp.value.replace(/\D/g, '').slice(0, 3);                                    // studs / micros: plain numbers
    fitWidth();
  });
  inp.addEventListener('blur', apply);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') inp.blur();
    else if (e.key === 'Escape') { inp.value = ''; inp.blur(); }    // empty = no change
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const t = target(), k = t.kind(i), n = (parseUnits(i, inp.value, k) || t.units(i)) + (e.key === 'ArrowUp' ? 1 : -1);
      inp.value = fmtUnits(i, Math.max(t.min(i), Math.min(t.max(i), n)), k); fitWidth(); apply(); inp.select();
    }
  });
}

export function initSizePanel(): void {
  dimBox = [0, 1, 2].map((i) => {
    const box = document.createElement('label'); box.className = 'dim';
    const inp = document.createElement('input');
    box.append(inp); document.body.appendChild(box);
    const fitWidth = (): void => { inp.style.width = Math.max(1, inp.value.length) + 'ch'; };
    wireSizeInput(inp, i, box, fitWidth);
    return { box, inp, fitWidth };
  });
  menuInp = [0, 1, 2].map((i) => {
    const row = document.createElement('label'); row.className = 'mrow';
    const tag = document.createElement('span'); tag.textContent = 'XYZ'[i];
    const inp = document.createElement('input');
    const unit = document.createElement('small'); unit.className = 'munit';
    row.append(tag, inp, unit); $('menu').appendChild(row);
    wireSizeInput(inp, i, row, undefined, panelTarget);
    return inp;
  });
  updateMenuUnits();
  modeBtns = [...document.querySelectorAll<HTMLButtonElement>('#mode button')];
  modeBtns.forEach((b) => {
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('dblclick', (e) => e.stopPropagation());
    b.addEventListener('click', () => { if (ghostBrick()) setGhostType(b.dataset.mode!); else setMode(b.dataset.mode!); });
  });
}

export function updateMenuUnits(): void {
  const g = ghostBrick();
  document.querySelectorAll('#menu .munit').forEach((el, i) => {
    const step = g ? sizeRule(g).steps[i]! : S.STEPS[i]!, k = g ? kindOf(step, !!g.micro) : stepKind(i), u = +(step / BRZ_UNIT).toFixed(2);
    el.textContent = ({ plate: 'height', stud: 'studs', micro: 'micros' } as Record<string, string>)[k] || `× ${u} units`;
    if (g ? ghostFixedAxis(g, i) : isFixedAxis(i)) el.textContent += ' (fixed)';
  });
}

export function setModeButtons(mode: string): void {
  modeBtns.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode)));
}

/** the type buttons and the read-only state of fixed axes follow the focused brick */
export function syncSizeUi(b: Brick): void {
  setModeButtons(brickType(b));
  modeBtns.forEach((btn) => { btn.disabled = lockedType(b); });
  dimBox.forEach((d, i) => { const f = isFixedAxis(i); d.inp.readOnly = f; d.box.classList.toggle('ro', f); });
  menuInp.forEach((inp, i) => { const f = isFixedAxis(i); inp.readOnly = f; inp.closest('.mrow')!.classList.toggle('ro', f); });
}

let shownGhost = '';
/** Per frame: while a ghost brick is in hand, the menu fields and type buttons show it; after, the focused brick again. */
export function tickSizeUi(): void {
  const g = ghostBrick(), key = g ? `${ghostItemsVersion()}|${brickType(g)}|${g.hi.join()}` : '';
  if (key === shownGhost) return;
  const was = shownGhost;
  shownGhost = key;
  if (!g) { if (was && hasFocus()) syncSizeUi(S.focus!); updateMenuUnits(); return; }
  setModeButtons(brickType(g));
  modeBtns.forEach((btn) => { btn.disabled = lockedType(g); });
  menuInp.forEach((inp, i) => {
    const f = ghostFixedAxis(g, i);
    inp.readOnly = f; inp.closest('.mrow')!.classList.toggle('ro', f);
    if (document.activeElement !== inp) inp.value = fmtUnits(i, ghostUnits(g, i), kindOf(sizeRule(g).steps[i]!, !!g.micro));
  });
  updateMenuUnits();
}
