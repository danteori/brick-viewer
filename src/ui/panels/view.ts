// The View row in the left column: Underside (U, backlog U-03) flips the camera to the iso corner
// below the brick or back above; X-ray (X, U-05) toggles the cutaway cone, with its Hole (tube width)
// and Keep (dead zone) sliders shown underneath while it's on.
// Figure (P, U-16) shows the player reference figure; its button sits in the Lighting row, so the
// View row never sets the left column's width (a wider column covers more of the scene).
// Hidden (E-21) cycles how hidden (Visible off) bricks show: auto (while a brick is selected), shown, off.

import { $ } from '../dom.ts';
import { S } from '../../app/state.ts';
import { flipUnderside } from '../../render/camera.ts';
import { cut } from '../../render/cutaway.ts';
import { PLATE } from '../../core/units.ts';
import { figure, initFigure } from '../../render/figure.ts';
import { isTyping } from '../../editor/input.ts';
import { initAudio, playClick } from '../audio.ts';
import { placeholder } from '../placeholder.ts';
import { hiddenView } from '../../app/hidden.ts';
import { nextHiddenMode, type HiddenMode } from '../../scene/hidden.ts';

/** Keep slider step: one brick (3 plates). */
const BRICK = 3 * PLATE;

/** Hole slider 0..100 -> cut.size (fraction of the view's half-height). */
const SIZE_MAX = 0.8;

export function setXray(on: boolean): void {
  cut.on = on;
  const b = $('xray');
  b.setAttribute('aria-pressed', String(on));
  $('xraybox').hidden = !on;
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
  const under = $<HTMLButtonElement>('underside'), xray = $<HTMLButtonElement>('xray');
  const size = $<HTMLInputElement>('xraysize'), keep = $<HTMLInputElement>('xraykeep');
  size.value = String(Math.round(cut.size / SIZE_MAX * 100)); keep.value = String(Math.round(cut.keep / BRICK));
  const flip = (): void => { flipUnderside(); initAudio(); playClick(); };
  under.addEventListener('click', flip);
  xray.addEventListener('click', () => { setXray(!cut.on); initAudio(); playClick(); });
  size.addEventListener('input', () => { cut.size = +size.value / 100 * SIZE_MAX; });
  keep.addEventListener('input', () => { cut.keep = +keep.value * BRICK; });
  for (const id of ['viewbox', 'xraybox']) for (const t of ['pointerdown', 'dblclick']) $(id).addEventListener(t, (e) => e.stopPropagation());
  addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.key === 'u' || e.key === 'U') { e.preventDefault(); flip(); }
    else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); setXray(!cut.on); initAudio(); playClick(); }
    else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); toggleFigure(); }
  });
  // the underside button shows which side the view is on
  S.hooks.hud.push(() => {
    under.setAttribute('aria-pressed', String(S.orbit.pitchT < 0));
    return `U flips the view below / above the brick · X toggles the X-ray hole${cut.on ? ' (<b>on</b>: clicks go through it)' : ''} · P shows a player figure for scale${figure.on ? ' (<b>on</b>)' : ''}`;
  });
}
