// The View row in the left column: Underside (U, backlog U-03) flips the camera to the iso corner
// below the brick or back above; X-ray (X, U-05) toggles the cutaway cone, with its Hole and Spread
// sliders shown underneath while it's on.

import { $ } from '../dom.ts';
import { S } from '../../app/state.ts';
import { flipUnderside } from '../../render/camera.ts';
import { cut } from '../../render/cutaway.ts';
import { isTyping } from '../../editor/input.ts';
import { initAudio, playClick } from '../audio.ts';

/** Hole slider 0..100 -> cut.size (fraction of the view's half-height). */
const SIZE_MAX = 0.8;

export function setXray(on: boolean): void {
  cut.on = on;
  const b = $('xray');
  b.setAttribute('aria-pressed', String(on));
  $('xraybox').hidden = !on;
}

export function initViewPanel(): void {
  const under = $<HTMLButtonElement>('underside'), xray = $<HTMLButtonElement>('xray');
  const size = $<HTMLInputElement>('xraysize'), spread = $<HTMLInputElement>('xrayspread');
  size.value = String(Math.round(cut.size / SIZE_MAX * 100)); spread.value = String(cut.spread);
  const flip = (): void => { flipUnderside(); initAudio(); playClick(); };
  under.addEventListener('click', flip);
  xray.addEventListener('click', () => { setXray(!cut.on); initAudio(); playClick(); });
  size.addEventListener('input', () => { cut.size = +size.value / 100 * SIZE_MAX; });
  spread.addEventListener('input', () => { cut.spread = +spread.value; });
  for (const id of ['viewbox', 'xraybox']) for (const t of ['pointerdown', 'dblclick']) $(id).addEventListener(t, (e) => e.stopPropagation());
  addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.key === 'u' || e.key === 'U') { e.preventDefault(); flip(); }
    else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); setXray(!cut.on); initAudio(); playClick(); }
  });
  // the underside button shows which side the view is on
  S.hooks.hud.push(() => {
    under.setAttribute('aria-pressed', String(S.orbit.pitchT < 0));
    return `U flips the view below / above the brick · X toggles the X-ray hole${cut.on ? ' (<b>on</b>: clicks go through it)' : ''}`;
  });
}
