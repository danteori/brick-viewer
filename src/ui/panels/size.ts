// Typed sizes: the dimension labels (real text inputs parked on the dimension lines) and the
// top-left size menu, plus the Brick / Tile / Smooth Tile / Microbrick type buttons. Enter / click
// away applies, Esc cancels, Up / Down step one stud or plate. Like dragging, typing only moves the
// near face.

import { S } from '../../app/state.ts';
import { BRZ_UNIT } from '../../core/units.ts';
import { brickType, lockedType, type Brick } from '../../scene/brick.ts';
import { isFixedAxis, maxUnits, minUnits, setMode, setSize, units } from '../../editor/resize.ts';
import { fmtUnits, parseUnits, stepKind } from '../names.ts';
import { initAudio } from '../audio.ts';
import { $ } from '../dom.ts';

export interface DimBox { box: HTMLLabelElement; inp: HTMLInputElement; fitWidth: () => void }
export let dimBox: DimBox[] = [];
export let menuInp: HTMLInputElement[] = [];
let modeBtns: HTMLButtonElement[] = [];

function wireSizeInput(inp: HTMLInputElement, i: number, holder: HTMLElement, fitWidth: () => void = () => {}): void {
  inp.inputMode = i < 2 ? 'numeric' : 'text'; inp.autocomplete = 'off'; inp.spellcheck = false;
  inp.setAttribute('aria-label', i < 2 ? `${'XY'[i]} size in studs` : 'height in bricks + plates, e.g. 1+2f');
  const apply = (): void => setSize(i, parseUnits(i, inp.value));
  holder.addEventListener('pointerdown', (e) => e.stopPropagation());   // clicking it isn't a drag
  holder.addEventListener('dblclick', (e) => e.stopPropagation());
  inp.addEventListener('focus', () => { initAudio(); inp.select(); });
  inp.addEventListener('input', () => {
    inp.value = stepKind(i) === 'plate' ? inp.value.replace(/[^0-9+f]/gi, '').slice(0, 6)   // bricks + plates
      : inp.value.replace(/\D/g, '').slice(0, 3);                                    // studs / micros: plain numbers
    fitWidth();
  });
  inp.addEventListener('blur', apply);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') inp.blur();
    else if (e.key === 'Escape') { inp.value = ''; inp.blur(); }    // empty = no change
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const n = (parseUnits(i, inp.value) || units(i)) + (e.key === 'ArrowUp' ? 1 : -1);
      inp.value = fmtUnits(i, Math.max(minUnits(i), Math.min(maxUnits(i), n))); fitWidth(); apply(); inp.select();
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
    wireSizeInput(inp, i, row);
    return inp;
  });
  updateMenuUnits();
  modeBtns = [...document.querySelectorAll<HTMLButtonElement>('#mode button')];
  modeBtns.forEach((b) => {
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('dblclick', (e) => e.stopPropagation());
    b.addEventListener('click', () => setMode(b.dataset.mode!));
  });
}

export function updateMenuUnits(): void {
  document.querySelectorAll('#menu .munit').forEach((el, i) => {
    const k = stepKind(i), u = +(S.STEPS[i] / BRZ_UNIT).toFixed(2);
    el.textContent = ({ plate: 'height', stud: 'studs', micro: 'micros' } as Record<string, string>)[k] || `× ${u} units`;
    if (isFixedAxis(i)) el.textContent += ' (fixed)';
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
