// The View row in the left column: Underside (U, backlog U-03) flips the camera to the iso corner
// below the brick or back above; X-ray (X, U-05) toggles the cutaway cone. Its Hole (tube width) and
// Keep (dead zone) sliders sit in a small side panel that shows only while it's on. A new focus
// fits X-ray to the bricks that cover it (U-33, render/xrayfit.ts).
// Figure (P, U-16) shows the player reference figure; its button sits in the Lighting row, so the
// View row never sets the left column's width (a wider column covers more of the scene).

import { $ } from '../dom.ts';
import { S } from '../../app/state.ts';
import { flipUnderside } from '../../render/camera.ts';
import { cut } from '../../render/cutaway.ts';
import { KEEP_STEP, SIZE_MAX, fitXray, xrayOff, type XrayState } from '../../render/xrayfit.ts';
import { focusChanged, focusNeed, xrayAuto } from '../../editor/autoxray.ts';
import { figure, initFigure } from '../../render/figure.ts';
import { isTyping } from '../../editor/input.ts';
import { initAudio, playClick } from '../audio.ts';

/** Sets X-ray on or off with its Hole and Keep, and the button, panel and sliders to match. */
export function applyXray(x: XrayState): void {
  cut.on = x.on; cut.size = x.size; cut.keep = x.keep;
  $('xray').setAttribute('aria-pressed', String(x.on));
  $('xraybox').hidden = !x.on;
  $<HTMLInputElement>('xraysize').value = String(Math.round(cut.size / SIZE_MAX * 100));
  $<HTMLInputElement>('xraykeep').value = String(Math.round(cut.keep / KEEP_STEP));
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
}

export function setFigure(on: boolean): void {
  figure.on = on;
  $('figure').setAttribute('aria-pressed', String(on));
}

export function initViewPanel(): void {
  initFigure();
  const fig = $<HTMLButtonElement>('figure');
  const toggleFigure = (): void => { setFigure(!figure.on); initAudio(); playClick(); };
  fig.addEventListener('click', toggleFigure);
  const under = $<HTMLButtonElement>('underside'), xray = $<HTMLButtonElement>('xray');
  const size = $<HTMLInputElement>('xraysize'), keep = $<HTMLInputElement>('xraykeep');
  xrayAuto.on = !S.testMode;
  applyXray(xrayOff());
  const flip = (): void => { flipUnderside(); initAudio(); playClick(); };
  under.addEventListener('click', flip);
  xray.addEventListener('click', () => { setXray(!cut.on); initAudio(); playClick(); });
  size.addEventListener('input', () => { cut.size = +size.value / 100 * SIZE_MAX; });
  keep.addEventListener('input', () => { cut.keep = +keep.value * KEEP_STEP; });
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
