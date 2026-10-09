// The Paint section of Brick Properties: the palette panel (src/ui/panels/palette.ts) docked under
// the brick's properties, collapsed by default. "Paint selection" paints the selection (E-01; the
// focused brick when nothing is selected) as one undo step; the eyedropper takes the paint of the
// next brick clicked. Colour, material and intensity are set together (src/editor/paint.ts);
// intensity is the save's A byte.

import { S } from '../../app/state.ts';
import { txBegin, txEnd, histEnd } from '../../scene/history.ts';
import { F_LINEAR, MATERIALS } from '../../scene/store.ts';
import { linearToSrgbByte } from '../../format/stale.ts';
import { brickView } from '../../scene/view.ts';
import { selectBrick } from '../../editor/resize.ts';
import { effectiveIds } from '../../editor/select.ts';
import { hexOfRgb8, materialLabel, normalisePaint, PaintModel, type PaintFields, type PaintTarget } from '../../editor/paint.ts';
import { mountPalettePanel, type PalettePanel } from './palette.ts';
import { initAudio, playClick } from '../audio.ts';
import { setStatus } from '../status.ts';
import { $ } from '../dom.ts';

let model: PaintModel | null = null;
let panel: PalettePanel | null = null;

/** The paint fields of the scene's rows (sRGB bytes; a linear row reads as its sRGB bytes). */
export const sceneTarget: PaintTarget<number> = {
  get(id) {
    const s = S.scene;
    if (!s.alive(id)) return undefined;
    const c = s.color[id]!, lin = (s.flags[id]! & F_LINEAR) !== 0, ch = (i: number): number => { const v = (c >>> (8 * i)) & 255; return lin ? linearToSrgbByte(v) : v; };
    return normalisePaint({ colour: [ch(0), ch(1), ch(2)], material: MATERIALS.name(s.material[id]!), intensity: c >>> 24 });
  },
  set(id, f) {
    const s = S.scene;
    if (!s.alive(id)) return;
    s.color[id] = (f.colour[0] | (f.colour[1] << 8) | (f.colour[2] << 16) | (f.intensity << 24)) >>> 0;
    s.flags[id] = s.flags[id]! & ~F_LINEAR;
    s.material[id] = MATERIALS.id(f.material);
    s.touch(id);
  },
};

/** Paints the selection (or the focused brick) with the current paint: one undo step, nothing recorded if it already matches. */
export function paintSelection(paint?: PaintFields): boolean {
  const ids = effectiveIds();
  const model = paintModel();
  if (!ids.length) return false;
  if (paint) model.set(paint);
  histEnd();
  const t = txBegin('paint', ids);
  const ch = model.applyPaint(sceneTarget, ids, {}, 'paint');
  if (ch.ids.includes(S.sel)) S.focus = brickView(S.scene, S.sel);   // the focus draws live: re-read it
  txEnd(t);
  if (ch.ids.includes(S.sel)) selectBrickQuiet();
  const p = model.paint, n = ch.ids.length;
  setStatus(n ? `Painted ${ids.length > 1 ? `${n} brick${n === 1 ? '' : 's'} ` : ''}${hexOfRgb8(p.colour)} · ${materialLabel(p.material)} · intensity ${p.intensity * 10} %` : 'Already that paint');
  if (n) { initAudio(); playClick(); }
  return n > 0;
}
/** @deprecated the old name: paints the selection (the focused brick when nothing is selected) */
export const paintFocused = paintSelection;

/** Re-reads the focused brick from the scene without moving the camera. */
function selectBrickQuiet(): void {
  const keep = S.cam.half, z = S.zoomMul;
  selectBrick(S.sel);
  S.cam.half = keep; S.zoomMul = z;
}

/** The current paint (shared by the palette panel and the Paint tool). */
export function paintModel(): PaintModel { return (model ??= new PaintModel()); }

/** Eyedropper on brick id: the current paint becomes its paint (the panel follows if it's open). */
export function eyedropBrick(id: number): PaintFields | null {
  const f = sceneTarget.get(id);
  if (!f) return null;
  const p = panel ? panel.eyedrop(f) : paintModel().pickFrom(f);
  setStatus(`Took ${hexOfRgb8(p.colour)} · ${materialLabel(p.material)} · intensity ${p.intensity * 10} %`);
  return p;
}

/** Re-reads the focused brick after its row was painted (it draws live from its record). */
export function refreshFocus(): void { if (S.scene.alive(S.sel)) selectBrickQuiet(); }

function mount(body: HTMLElement): void {
  model = paintModel();
  panel = mountPalettePanel(body, {
    model,
    paintLabel: 'Paint selection',
    onPaint: () => { paintSelection(); },
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
    const p = panel.eyedrop(sceneTarget.get(k)!);
    $('c').style.cursor = '';
    setStatus(`Took ${hexOfRgb8(p.colour)} · ${materialLabel(p.material)} · intensity ${p.intensity * 10} %`);
  }, { capture: true });
}
