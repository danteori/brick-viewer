// Brick Properties (top right): name, type, size, orientation, material and the colour editor (a
// hue / saturation wheel, a brightness slider and a hex box). It reads the scene once a frame and
// only touches the DOM when a shown string changes. Colours are display sRGB 0..1.

import { S, hasFocus } from '../../app/state.ts';
import { hexOf, hsv2rgb, parseHex, rgb2hsv, type HSV, type RGB } from '../../core/colour.ts';
import { brickType, fixedSize } from '../../scene/brick.ts';
import { hist, histBegin, histEnd } from '../../scene/history.ts';
import { proposedBox, pushFocus } from '../../editor/resize.ts';
import { displayName, fmtUnits, shapeLabel, stepKind } from '../names.ts';
import { initAudio } from '../audio.ts';
import { $ } from '../dom.ts';

let props: HTMLElement, pbody: HTMLElement, ced: HTMLElement, wheel: HTMLCanvasElement, mark: HTMLElement;
let valEl: HTMLInputElement, hexEl: HTMLInputElement, swatch: HTMLElement, hexOut: HTMLElement;
let out: Record<'name' | 'type' | 'size' | 'orient' | 'mat', HTMLElement>;

// HSV is the editor's own state; syncSel / syncHex say which brick colour it was last matched to,
// so an outside change (focus move, a loaded save) re-reads it but our own writes don't.
let hsv: HSV = { h: 0, s: 0, v: 1 }, syncSel = -1, syncHex = '';
let drawnV = -1, drawnW = 0, shownSwatch = '';

export function initProps(): void {
  props = $('props'); pbody = $('pbody'); ced = $('ced');
  const ptoggle = $('ptoggle'), cbtn = $('pcolor');
  wheel = $<HTMLCanvasElement>('cwheel'); mark = $('cmark'); valEl = $<HTMLInputElement>('cval'); hexEl = $<HTMLInputElement>('chex');
  swatch = $('cswatch'); hexOut = $('chexout');
  out = { name: $('pname'), type: $('ptype'), size: $('psize'), orient: $('porient'), mat: $('pmat') };
  // clicks here aren't a canvas drag, and the wheel scrolls the panel, not the zoom
  for (const t of ['pointerdown', 'dblclick', 'wheel']) props.addEventListener(t, (e) => e.stopPropagation());
  ptoggle.addEventListener('click', () => {
    const open = pbody.hidden;
    pbody.hidden = !open; props.classList.toggle('collapsed', !open);
    ptoggle.setAttribute('aria-expanded', String(open));
  });
  cbtn.addEventListener('click', () => {
    const open = ced.hidden;
    ced.hidden = !open; cbtn.setAttribute('aria-expanded', String(open));
    if (open) { showEditor(); drawWheel(); }
  });
  wheel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();                        // no text selection / touch scrolling while dragging
    try { wheel.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    wheel.focus({ preventScroll: true }); initAudio(); pick(e);
  });
  wheel.addEventListener('pointermove', (e) => { if (wheel.hasPointerCapture?.(e.pointerId)) pick(e); });
  for (const t of ['pointerup', 'lostpointercapture', 'keyup', 'blur']) wheel.addEventListener(t, () => histEnd());   // a drag / held key = one undo step
  wheel.addEventListener('keydown', (e) => {      // Left/Right hue, Up/Down saturation (Shift: bigger steps)
    const k = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') hsv.h = (hsv.h + (e.key === 'ArrowRight' ? k : -k) + 360) % 360;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') hsv.s = Math.max(0, Math.min(1, hsv.s + (e.key === 'ArrowUp' ? k : -k) / 100));
    else return;
    e.preventDefault(); applyHsv();
  });
  valEl.addEventListener('input', () => { hsv.v = +valEl.value / 1000; applyHsv(); });
  for (const t of ['change', 'pointerup', 'keyup', 'blur']) valEl.addEventListener(t, () => histEnd());
  valEl.addEventListener('pointerdown', () => initAudio());
  // hex box: Enter / blur applies, Esc reverts; a bad value is flagged and reverted on blur
  hexEl.addEventListener('focus', () => hexEl.select());
  hexEl.addEventListener('input', () => hexEl.setAttribute('aria-invalid', String(!parseHex(hexEl.value))));
  hexEl.addEventListener('blur', commitHex);
  hexEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commitHex(); hexEl.select(); }
    else if (e.key === 'Escape') { hexEl.value = syncHex; hexEl.removeAttribute('aria-invalid'); hexEl.blur(); }
  });
}

/** recolour the focused brick (one undo step per drag / pick) */
export function setColor(c: RGB): void {
  const b = S.focus;
  if (!hasFocus() || !b) return;   // empty scene
  if (!(hist.open && hist.open.label === 'colour' && hist.open.sel === S.sel)) histBegin('colour');
  b.color = c;                     // a fresh array; the focused brick draws live
  pushFocus();
  syncSel = S.sel; syncHex = hexOf(c);
  showEditor();
}
const applyHsv = (): void => setColor(hsv2rgb(hsv.h, hsv.s, hsv.v));

function showEditor(): void {
  const hx = syncHex, a = hsv.h * Math.PI / 180;      // the brick's own hex (HSV round-trips can be off by one)
  mark.style.left = `${50 + Math.cos(a) * hsv.s * 50}%`; mark.style.top = `${50 - Math.sin(a) * hsv.s * 50}%`;
  mark.style.background = hx;
  valEl.value = String(Math.round(hsv.v * 1000));
  valEl.style.setProperty('--track', `linear-gradient(to right, #000, ${hexOf(hsv2rgb(hsv.h, hsv.s, 1))})`);
  valEl.setAttribute('aria-valuetext', `${Math.round(hsv.v * 100)}%`);
  wheel.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
  wheel.setAttribute('aria-valuetext', `hue ${Math.round(hsv.h)}°, saturation ${Math.round(hsv.s * 100)}%`);
  if (document.activeElement !== hexEl) { hexEl.value = hx; hexEl.removeAttribute('aria-invalid'); }
}

/** hue around the angle (red at 3 o'clock, counter-clockwise), saturation by radius, at the current value */
function drawWheel(): void {
  const W = Math.round(wheel.clientWidth * (devicePixelRatio || 1));
  if (!W) return;
  if (wheel.width !== W) { wheel.width = W; wheel.height = W; }
  const ctx = wheel.getContext('2d')!, img = ctx.createImageData(W, W), d = img.data, R = W / 2;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - R, dy = y + 0.5 - R, r = Math.hypot(dx, dy), a = Math.min(1, R - r);   // 1px soft rim
    if (a <= 0) continue;
    const c = hsv2rgb((Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360, Math.min(1, r / R), hsv.v), o = (y * W + x) * 4;
    d[o] = c[0] * 255; d[o + 1] = c[1] * 255; d[o + 2] = c[2] * 255; d[o + 3] = a * 255;
  }
  ctx.putImageData(img, 0, 0);
  drawnV = hsv.v; drawnW = W;
}

function pick(e: PointerEvent): void {
  const b = wheel.getBoundingClientRect(), R = b.width / 2;
  const dx = e.clientX - b.left - R, dy = e.clientY - b.top - R, r = Math.hypot(dx, dy);
  if (r > 0.5) hsv.h = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360;   // dead centre: keep the hue
  hsv.s = Math.min(1, r / R);
  applyHsv();
}

function commitHex(): void {
  const c = parseHex(hexEl.value);
  if (c && hexOf(c) !== syncHex) { hsv = rgb2hsv(c, hsv); setColor(c); histEnd(); }   // same colour: skip re-rounding it
  hexEl.value = syncHex; hexEl.removeAttribute('aria-invalid');
}

const ORIENT: Record<string, string> = { 1: 'Upright', '-1': 'Upside down', 0: 'Sideways' };
const matName = (m: string | undefined): string => (m ? String(m).replace(/^BMC_/, '').replace(/([a-z])([A-Z])/g, '$1 $2') : 'Plastic');
const put = (el: HTMLElement, s: string): void => { if (el.textContent !== s) el.textContent = s; };
const TYPE_NAMES: Record<string, string> = { brick: 'Brick', plain: 'Tile', tile: 'Smooth Tile', micro: 'Microbrick', ramp: 'Ramp', crest: 'Ramp Crest', crestEnd: 'Ramp Crest End' };

/** per-frame read-out */
export function tickProps(): void {
  const b = S.focus;
  if (!hasFocus() || !b || pbody.hidden) return;
  const [l, u] = proposedBox(), n = (i: number): number => Math.round((u[i] - l[i]) / S.STEPS[i]);   // size incl. the ghost
  put(out.name, displayName(b, n(0), n(1), n(2)));
  put(out.type, b.shape === 'special' || b.shape === 'micro' ? shapeLabel(b.asset)
    : b.shape === 'round' ? (/Cone$/.test(b.round || '') ? 'Cone' : 'Round') : TYPE_NAMES[brickType(b)]);
  put(out.size, [0, 1, 2].map((i) => fmtUnits(i, n(i)) + (stepKind(i) === 'micro' && !S.micro ? 'm' : '')).join(' × ') +
    (S.micro ? ' micros' : '') + (fixedSize(b) ? ' (fixed)' : S.RULE.fix.some(Boolean) ? ` (${'XYZ'.split('').filter((_, i) => S.RULE.fix[i]).join('')} fixed)` : ''));
  put(out.orient, (ORIENT[b.up ?? 1] || 'Upright') +
    (!b.up && b.side ? `, studs face ${b.side > 0 ? '+' : '−'}${Math.abs(b.side) === 2 ? 'X' : 'Y'}` : '') +
    (b.o != null ? ` (orientation ${b.o}: dir ${(b.o >> 2) % 6}, rot ${b.o & 3})` : '') +
    (b.shape === 'ramp' ? `, slopes down to ${b.lip! > 0 ? '+' : '−'}${'XY'[b.run!]}` : '') +
    (b.shape === 'crest' || b.shape === 'crestEnd' ? `, ridge along ${'YX'[b.run!]}` : '') +
    (b.shape === 'crestEnd' ? `, closed end at ${b.closed! > 0 ? '+' : '−'}${'YX'[b.run!]}` : ''));
  put(out.mat, matName(b.material));
  const hx = hexOf(b.color);
  put(hexOut, hx);
  if (shownSwatch !== hx) { swatch.style.background = shownSwatch = hx; }
  if (S.sel !== syncSel || hx !== syncHex) { hsv = rgb2hsv(b.color, hsv); syncSel = S.sel; syncHex = hx; showEditor(); }
  if (!ced.hidden && (drawnV !== hsv.v || drawnW !== Math.round(wheel.clientWidth * (devicePixelRatio || 1)))) drawWheel();
}
