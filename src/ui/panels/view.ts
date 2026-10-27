// The View row in the left column: X-ray (X, U-05) toggles the cutaway cone, with its Hole (tube width)
// and Keep (dead zone) sliders shown underneath while it's on. A new focus fits X-ray to the bricks
// that cover it (U-33, render/xrayfit.ts).
// Figure (P, U-16) shows the player reference figure; its button sits in the Lighting row, so the
// View row never sets the left column's width (a wider column covers more of the scene).
// Hidden (E-21) cycles how hidden (Visible off) bricks show: auto (while a brick is selected), shown, off.

import { $ } from '../dom.ts';
import { S } from '../../app/state.ts';
import { cut } from '../../render/cutaway.ts';
import { XRAY_MODES, type XrayMode } from '../../render/xraymodes.ts';
import { KEEP_STEP, SIZE_MAX, fitXray, xrayOff, type XrayState } from '../../render/xrayfit.ts';
import { focusChanged, focusNeed, refreshRoom, xrayAuto } from '../../editor/autoxray.ts';
import { figure, initFigure } from '../../render/figure.ts';
import { isTyping } from '../../editor/input.ts';
import { initAudio, playClick } from '../audio.ts';
import { placeholder } from '../placeholder.ts';
import { hiddenView } from '../../app/hidden.ts';
import { nextHiddenMode, type HiddenMode } from '../../scene/hidden.ts';

/** Sets X-ray on or off with its Hole and Keep, and the button, panel and sliders to match. */
export function applyXray(x: XrayState): void {
  cut.on = x.on; cut.size = x.size; cut.keep = x.keep;
  $('xray').setAttribute('aria-pressed', String(x.on));
  $('xraybox').hidden = !x.on;
  $<HTMLInputElement>('xraysize').value = String(Math.round(cut.size / SIZE_MAX * 100));
  $<HTMLInputElement>('xraykeep').value = String(Math.round(cut.keep / KEEP_STEP));
}

const MODE_TEXT: Record<XrayMode, string> = {
  tube: placeholder('[TEXT: X-ray mode Tube]'), slice: placeholder('[TEXT: X-ray mode Height slice]'),
  room: placeholder('[TEXT: X-ray mode Room]'), ghost: placeholder('[TEXT: X-ray mode See-through]'),
};
const MODE_TITLE: Record<XrayMode, string> = {
  tube: placeholder('[TEXT: Tube: hide the bricks in a tube between the focus and the camera]'),
  slice: placeholder('[TEXT: Height slice: hide everything above a height]'),
  room: placeholder('[TEXT: Room: hide the roof and the near walls of the focus room]'),
  ghost: placeholder('[TEXT: See-through: draw the bricks in the tube as faint ghosts]'),
};
const HEIGHT_TEXT = placeholder('[TEXT: Height]');

/** Picks the X-ray mode, and shows only the sliders it uses. */
export function setXrayMode(mode: XrayMode): void {
  cut.mode = mode;
  if (mode !== 'room') cut.room = null;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#xraymodes button')) b.setAttribute('aria-pressed', String(b.dataset.xmode === mode));
  $('xraysizerow').hidden = mode === 'slice' || mode === 'room';
  $('xraykeeprow').hidden = mode === 'room';
  $('xraykeeplabel').textContent = mode === 'slice' ? HEIGHT_TEXT : 'Keep';
  refreshRoom(true);
}

function addModeButtons(): void {
  for (const m of XRAY_MODES) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.xmode = m; b.textContent = MODE_TEXT[m]; b.title = MODE_TITLE[m];
    b.addEventListener('click', () => { setXrayMode(m); initAudio(); playClick(); });
    $('xraymodes').append(b);
  }
  setXrayMode(cut.mode);
}

/** The X toggle: on fits the focus (the defaults when nothing covers it); off resets Hole and Keep. */
export function setXray(on: boolean): void {
  if (!on) { applyXray(xrayOff()); return; }
  const need = focusNeed();
  applyXray(need ? fitXray(xrayOff(), need) : { ...xrayOff(), on: true });
}

/** Call each frame before drawing: a new focus fits X-ray (on, off, Hole and Keep) to it. */
export function tickXray(): void {
  if (focusChanged() && xrayAuto.on) applyXray(fitXray({ ...cut }, focusNeed()));
  refreshRoom(false);
}

const HIDDEN_TEXT: Record<HiddenMode, string> = { auto: placeholder('Hidden: auto'), show: placeholder('Hidden: shown'), hide: placeholder('Hidden: off') };
const HIDDEN_TITLE = placeholder('Hidden bricks (Visible off): auto shows them while a brick is selected. Click to cycle auto, shown, off');
const HIDDEN_PRESSED: Record<HiddenMode, string> = { auto: 'mixed', show: 'true', hide: 'false' };

/** Sets how hidden (Visible off) bricks show, and the View row's Hidden button. */
export function setHiddenMode(mode: HiddenMode): void {
  hiddenView.mode = mode;
  const b = $('hiddenbtn');
  b.textContent = HIDDEN_TEXT[mode]; b.dataset.mode = mode; b.setAttribute('aria-pressed', HIDDEN_PRESSED[mode]);
}

function addHiddenButton(): void {
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'hiddenbtn'; b.title = HIDDEN_TITLE;
  $('viewbox').append(b);
  setHiddenMode(hiddenView.mode);
  b.addEventListener('click', () => { setHiddenMode(nextHiddenMode(hiddenView.mode)); initAudio(); playClick(); });
}

export function setFigure(on: boolean): void {
  figure.on = on;
  $('figure').setAttribute('aria-pressed', String(on));
}

export function initViewPanel(): void {
  initFigure();
  addHiddenButton();
  const fig = $<HTMLButtonElement>('figure');
  const toggleFigure = (): void => { setFigure(!figure.on); initAudio(); playClick(); };
  fig.addEventListener('click', toggleFigure);
  const xray = $<HTMLButtonElement>('xray');
  const size = $<HTMLInputElement>('xraysize'), keep = $<HTMLInputElement>('xraykeep');
  xrayAuto.on = !S.testMode;
  applyXray(xrayOff());
  addModeButtons();
  xray.addEventListener('click', () => { setXray(!cut.on); initAudio(); playClick(); });
  size.addEventListener('input', () => { cut.size = +size.value / 100 * SIZE_MAX; });
  keep.addEventListener('input', () => { cut.keep = +keep.value * KEEP_STEP; });
  for (const id of ['viewbox', 'xraybox']) for (const t of ['pointerdown', 'dblclick']) $(id).addEventListener(t, (e) => e.stopPropagation());
  addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.key === 'x' || e.key === 'X') { e.preventDefault(); setXray(!cut.on); initAudio(); playClick(); }
    else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); toggleFigure(); }
  });
  S.hooks.hud.push(() => `X toggles the X-ray hole${cut.on ? ' (<b>on</b>: clicks go through it)' : ''} · P shows a player figure for scale${figure.on ? ' (<b>on</b>)' : ''}`);
}
