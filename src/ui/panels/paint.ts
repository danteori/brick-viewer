// The Paint section of Brick Properties: the palette panel (src/ui/panels/palette.ts) docked under
// the brick's properties, collapsed by default. "Paint selection" paints the focused brick (the
// selection is the focused brick until multi-select, backlog E-01) as one undo step; the eyedropper
// takes the paint of the next brick clicked. Colour, material and intensity are set together
// (src/editor/paint.ts); intensity is the save's A byte.

import { S } from '../../app/state.ts';
import { histBegin, histEnd } from '../../scene/history.ts';
import { markBrick } from '../../render/instances.ts';
import { hexOfRgb8, materialLabel, PaintModel, srgbFloatTarget, type PaintFields } from '../../editor/paint.ts';
import { mountPalettePanel, type PalettePanel } from './palette.ts';
import { initAudio, playClick } from '../audio.ts';
import { setStatus } from '../status.ts';
import { $ } from '../dom.ts';

let model: PaintModel | null = null;
let panel: PalettePanel | null = null;
const target = srgbFloatTarget(S.bricks, markBrick);

/** Paints the focused brick with the current paint (one undo step; nothing recorded if it already matches). */
export function paintFocused(paint?: PaintFields): boolean {
  const b = S.bricks[S.sel];
  if (!b || !model) return false;
  if (paint) model.set(paint);
  histBegin('paint');
  const ch = model.applyPaint(target, [S.sel], {}, 'paint');
  histEnd();
  const p = model.paint;
  setStatus(ch.ids.length ? `Painted ${hexOfRgb8(p.colour)} · ${materialLabel(p.material)} · intensity ${p.intensity * 10} %` : 'Already that paint');
  if (ch.ids.length) { initAudio(); playClick(); }
  return ch.ids.length > 0;
}

function mount(body: HTMLElement): void {
  model = new PaintModel();
  panel = mountPalettePanel(body, {
    model,
    paintLabel: 'Paint focused brick',
    onPaint: () => { paintFocused(); },
    onEyedropper: (on) => { $('c').style.cursor = on ? 'crosshair' : ''; if (on) setStatus('Eyedropper: click a brick to take its paint'); },
  });
}

export function initPaintPanel(): void {
  const toggle = $<HTMLButtonElement>('painttoggle'), body = $('paintbody');
  toggle.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open && !panel) mount(body);
  });
  // eyedropper: the next click on a brick (focused or not) takes its paint instead of focusing it
  const canvas = $<HTMLCanvasElement>('c');
  canvas.addEventListener('pointerdown', (e) => {
    if (!panel?.eyedropper || e.button !== 0) return;
    const k = S.hoverBrick >= 0 ? S.hoverBrick : S.hoverAxis >= 0 ? S.sel : -1;
    if (k < 0) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const p = panel.eyedrop(target.get(k)!);
    $('c').style.cursor = '';
    setStatus(`Took ${hexOfRgb8(p.colour)} · ${materialLabel(p.material)} · intensity ${p.intensity * 10} %`);
  }, { capture: true });
}
