// Fill paint (backlog U-18 / E-13): Alt+click in the Paint tool paints the clicked brick and every
// brick connected to it by touching faces (the Selection panel's "Connected" rule, same grid) that
// has the SAME colour and material as the clicked brick (intensity may differ), with the current
// paint. The flood goes through the pick grid (spatial index); the whole fill is one undo step.
// A fill of more than FILL_CAP bricks asks first, in the page.

import { S } from '../app/state.ts';
import { histEnd, txBegin, txEnd } from '../scene/history.ts';
import { connectedFrom } from './select.ts';
import { paintModel, refreshFocus, sceneTarget } from '../ui/panels/paint.ts';
import { hexOfRgb8, materialLabel } from './paint.ts';
import { askInPage } from '../ui/ask.ts';
import { initAudio, playClick } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';

/** Fills above this many bricks ask for a confirmation first. */
export const FILL_CAP = 5000;

/** The bricks a fill from `id` reaches: connected by faces, same colour bytes (sRGB) and material. At most `limit`. */
export function fillRegion(id: number, limit = Infinity): number[] {
  const f = sceneTarget.get(id);
  if (!f) return [];
  const [r, g, b] = f.colour, m = f.material;
  return connectedFrom([id], limit, (k) => {
    const o = sceneTarget.get(k);
    return !!o && o.colour[0] === r && o.colour[1] === g && o.colour[2] === b && o.material === m;
  });
}

/** Paints `ids` with the current paint as one undo step; returns how many changed. */
function paintIds(ids: number[]): number {
  histEnd();
  const t = txBegin('fill paint', ids);
  const ch = paintModel().applyPaint(sceneTarget, ids, {}, 'fill paint');
  if (ch.ids.includes(S.sel)) refreshFocus();
  txEnd(t);
  return ch.ids.length;
}

let busy = false;

/** Alt+click on brick id in the Paint tool. Resolves to the number of bricks painted. */
export async function fillPaint(id: number): Promise<number> {
  if (busy || !S.scene.alive(id)) return 0;
  let ids = fillRegion(id, FILL_CAP + 1);
  if (ids.length > FILL_CAP) {
    busy = true;
    try {
      const ok = await askInPage(`Fill paint more than ${FILL_CAP.toLocaleString('en')} connected bricks of that colour? It may take a moment.`, 'Fill all', 'Cancel');
      if (!ok || !S.scene.alive(id)) { setStatus('Fill paint cancelled'); return 0; }
      ids = fillRegion(id);
    } finally { busy = false; }
  }
  const n = paintIds(ids), p = paintModel().paint;
  initAudio();
  if (n) playClick();
  setStatus(n
    ? `Fill painted ${n} brick${n === 1 ? '' : 's'} ${hexOfRgb8(p.colour)} · ${materialLabel(p.material)} · intensity ${p.intensity * 10} %`
    : `Fill: ${ids.length} connected brick${ids.length === 1 ? '' : 's'} already that paint`);
  return n;
}
