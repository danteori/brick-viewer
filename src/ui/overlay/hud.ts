import { ELEV, S, hasFocus } from '../../app/state.ts';
import { isoSettling, snapYaw } from '../../render/camera.ts';
import { BLOCK_SHOW_MS, proposedBox, resizeBlock } from '../../editor/resize.ts';
import { fmtUnits } from '../names.ts';
import { HINT, isClassic } from '../../app/mode.ts';

let hud: HTMLElement, shown = '';
export function initHud(el: HTMLElement): void { hud = el; }

const deg = (r: number): number => r * 180 / Math.PI;

function viewLine(): string {
  const { orbit } = S;
  const iso = !(isoSettling() || Math.abs(Math.abs(orbit.pitch) - ELEV) > 1e-4 || Math.abs(snapYaw(orbit.yaw) - orbit.yaw) > 1e-4);
  const isoNote = iso ? (orbit.pitch < 0 ? ' (isometric, from below)' : ' (isometric)') : '';
  return `view <b>${((deg(orbit.yaw) % 360 + 360) % 360).toFixed(0)}°</b> yaw · <b>${deg(orbit.pitch).toFixed(1)}°</b> elevation${isoNote}`;
}

function sizeLine(): string {
  const [pl, ph] = proposedBox();
  const pu = (i: number): number => Math.round((ph[i] - pl[i]) / S.STEPS[i]);
  const blocked = performance.now() - resizeBlock.t < BLOCK_SHOW_MS ? ` <b style="color:#ff7a66">(blocked: ${resizeBlock.reason})</b>` : '';
  const centre = isClassic() ? ` · auto-center <b>${S.autoCenter ? 'on' : 'off'}</b> (C)` : '';
  return `size <b>${pu(0)} × ${pu(1)} × ${fmtUnits(2, pu(2))}</b> ${S.micro ? '(micros)' : '(studs × studs × height, f = plates)'}${blocked}${centre}`;
}

export function drawHud(): void {
  const lines = [viewLine()];
  if (hasFocus()) lines.push(sizeLine());
  lines.push(...S.hooks.hud.map((f) => f()).filter(Boolean), HINT);
  const html = lines.join('<br>');
  if (html !== shown) hud.innerHTML = shown = html;
}
