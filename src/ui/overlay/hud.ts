// The help / status HUD (bottom left). Only touches the DOM when the text changes.

import { ELEV, S } from '../../app/state.ts';
import { isoSettling, snapYaw } from '../../render/camera.ts';
import { BLOCK_SHOW_MS, proposedBox, resizeBlock } from '../../editor/resize.ts';
import { fmtUnits } from '../names.ts';

let hud: HTMLElement, shown = '';
export function initHud(el: HTMLElement): void { hud = el; }

export function drawHud(): void {
  const { orbit } = S, [pl, ph] = proposedBox();
  const pu = (i: number): number => Math.round((ph[i] - pl[i]) / S.STEPS[i]);   // size including the ghost
  const blocked = performance.now() - resizeBlock.t < BLOCK_SHOW_MS ? ` <b style="color:#ff7a66">(blocked: ${resizeBlock.reason})</b>` : '';
  const iso = !(isoSettling() || Math.abs(Math.abs(orbit.pitch) - ELEV) > 1e-4 || Math.abs(snapYaw(orbit.yaw) - orbit.yaw) > 1e-4);
  const html = `view <b>${(((orbit.yaw * 180 / Math.PI) % 360 + 360) % 360).toFixed(0)}°</b> yaw · <b>${(orbit.pitch * 180 / Math.PI).toFixed(1)}°</b> elevation${iso ? (orbit.pitch < 0 ? ' (isometric, from below)' : ' (isometric)') : ''}<br>` +
    `size <b>${pu(0)} × ${pu(1)} × ${fmtUnits(2, pu(2))}</b> ${S.micro ? '(micros)' : '(studs × studs × height, f = plates)'}${blocked} · auto-center <b>${S.autoCenter ? 'on' : 'off'}</b> (C)<br>` +
    'middle-drag to orbit (resizing snaps back to the nearest iso corner, below the brick when looking up from underneath; U flips above / below) · drag to resize one axis at a time (return to the solid brick to change axis; release or right-click commits) · scroll to zoom (zoom out for faster resizing) · hold at the window edge to keep going · click a size to type it · click Color in Brick Properties to recolour' +
    S.hooks.hud.map((f) => '<br>' + f()).join('');
  if (html !== shown) hud.innerHTML = shown = html;
}
