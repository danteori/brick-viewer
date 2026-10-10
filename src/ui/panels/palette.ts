// Colour palette panel (backlog E-04) for the paint tool (E-03). Vanilla DOM, self-contained: it
// injects its own stylesheet (scoped under .bv-palette, using the app's CSS variables with
// fallbacks) and talks to the host only through the options below.
//
//   const panel = mountPalettePanel(container, {
//     model,                          // PaintModel: the current paint (remembered in localStorage)
//     onPick: (paint) => ...,         // the user changed the current paint here (swatch, material, ...)
//     onPaint: (paint) => ...,        // "Paint selection": the host paints its selection (applyPaint)
//     onEyedropper: (on) => ...,      // the eyedropper toggle changed (host: crosshair cursor, etc.)
//   });
//   // host, on a brick click while panel.eyedropper is on:  panel.eyedrop(fieldsOfThatBrick)
//
// Palettes: the panel starts with the remembered uploaded palette, else the default one
// (loadDefaultPalette: the game's 2021 default palette).
// Layout as the game's colour panel (backlog U-17): title "Color", a "<group> - <index>" subtitle
// for the current swatch, and the swatch grid with ONE COLUMN PER PALETTE GROUP read top to bottom
// (the game's current palette is 14 x 12; the 2021 default has 8 groups of 12), square swatches with
// a ring on the current one. Key-hint chips for the paint tool at the bottom.
// "Upload palette (.bp)" reads a ColorPalette preset; "Reset to default" forgets the upload.

import {
  paletteColourToSrgb, PaletteError, parsePalette, defaultPalette, serialisePalette, type Palette,
} from '../../format/palette.ts';
import {
  hexOfRgb8, materialLabel, MATERIALS, MAX_INTENSITY, type PaintFields, type PaintModel, type Rgb8,
} from '../../editor/paint.ts';

export const PALETTE_KEY = 'brickViewer.palette';
/** The palette "Reset to default" goes back to. */
export async function loadDefaultPalette(): Promise<Palette> {
  return defaultPalette();
}

export interface PalettePanelOptions {
  model: PaintModel;
  /** Called after the user changes the current paint in the panel. */
  onPick?: (paint: PaintFields) => void;
  /** Label of the paint button (default "Paint selection"). */
  paintLabel?: string;
  /** "Paint selection" was pressed. The button is hidden when this is not given. */
  onPaint?: (paint: PaintFields) => void;
  /** The eyedropper toggle changed. */
  onEyedropper?: (on: boolean) => void;
  /** Override the default palette source (tests, other hosts). */
  defaultPalette?: () => Palette | Promise<Palette>;
  /** Where the uploaded palette is remembered (default localStorage; null = don't remember). */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

export interface PalettePanel {
  readonly el: HTMLElement;
  readonly palette: Palette;
  /** True while the eyedropper toggle is on. */
  readonly eyedropper: boolean;
  setEyedropper(on: boolean): void;
  /** The host's brick click in eyedropper mode: adopt the brick's paint and turn the toggle off. */
  eyedrop(brick: Partial<PaintFields>): PaintFields;
  /** Show a palette (does not remember it; uploads do). */
  setPalette(p: Palette): void;
  /** Upload a .bp file programmatically (same as the button). Rejects with PaletteError on bad files. */
  loadFile(file: Blob): Promise<Palette>;
  resetToDefault(): Promise<void>;
  destroy(): void;
}

const CSS = `
.bv-palette { display:grid; gap:8px; padding:8px 10px; border-radius:12px; box-sizing:border-box;
  background:rgba(29,30,33,.88); border:1px solid rgba(255,255,255,.12); box-shadow:0 6px 24px rgba(0,0,0,.35);
  color:var(--fg, #eee); font:13px/1.2 system-ui, sans-serif; min-width:0; }
.bv-palette [hidden] { display:none !important; }
.bv-palette .bvp-title { font-size:14px; font-weight:700; text-align:center; }
.bv-palette .bvp-where { font-size:11px; text-align:center; color:var(--muted, #9a9ca3); min-height:1.2em; margin-top:-6px; }
.bv-palette .bvp-cur { display:flex; align-items:center; gap:8px; min-width:0; }
.bv-palette .bvp-chip { width:28px; height:28px; flex:none; border-radius:7px; border:1px solid rgba(255,255,255,.35); }
.bv-palette .bvp-curtxt { display:grid; gap:2px; min-width:0; }
.bv-palette .bvp-hex { font-weight:600; font-variant-numeric:tabular-nums; }
.bv-palette .bvp-sub { font-size:11px; color:var(--muted, #9a9ca3); overflow-wrap:anywhere; }
.bv-palette .bvp-grid { display:grid; grid-auto-flow:column; grid-auto-columns:minmax(0, 28px); gap:3px; justify-content:center;
  max-height:min(46vh, 340px); overflow:hidden auto; overscroll-behavior:contain; scrollbar-width:thin; padding:3px; }
.bv-palette .bvp-sw { aspect-ratio:1; min-width:0; min-height:12px; padding:0; border-radius:3px; cursor:pointer;
  border:1px solid rgba(255,255,255,.18); }
.bv-palette .bvp-sw:hover { border-color:rgba(255,255,255,.7); }
.bv-palette .bvp-sw[aria-pressed="true"] { border-color:#fff; box-shadow:0 0 0 2px rgba(255,255,255,.85); transform:scale(1.12); position:relative; z-index:1; }
.bv-palette .bvp-keys { display:flex; flex-wrap:wrap; gap:4px; font-size:11px; color:var(--muted, #9a9ca3); }
.bv-palette .bvp-keys span { padding:2px 6px; border-radius:6px; background:rgba(0,0,0,.35); border:1px solid rgba(255,255,255,.1); white-space:nowrap; }
.bv-palette .bvp-keys kbd { font:600 10px/1 system-ui, sans-serif; color:var(--fg, #eee); margin-right:4px; }
.bv-palette .bvp-field { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted, #9a9ca3); min-width:0; }
.bv-palette .bvp-field > span:first-child { flex:none; width:5.2em; }
.bv-palette select, .bv-palette .bvp-btn { min-width:0; padding:5px 8px; border-radius:7px; border:1px solid rgba(255,255,255,.18);
  background:var(--bg, #2b2c30); color:var(--fg, #eee); font:600 12px/1.2 system-ui, sans-serif; }
.bv-palette select { flex:1; }
.bv-palette input[type=range] { flex:1; min-width:0; accent-color:var(--accent, #e8590c); }
.bv-palette .bvp-num { width:2.4em; text-align:right; color:var(--fg, #eee); font-weight:600; font-variant-numeric:tabular-nums; }
.bv-palette .bvp-btns { display:flex; flex-wrap:wrap; gap:4px; }
.bv-palette .bvp-btn { flex:1 1 auto; cursor:pointer; white-space:nowrap; }
.bv-palette .bvp-btn:hover { border-color:var(--accent, #e8590c); }
.bv-palette .bvp-btn[aria-pressed="true"], .bv-palette .bvp-btn.bvp-main { background:var(--accent, #e8590c); border-color:var(--accent, #e8590c); color:#fff; }
.bv-palette button:focus-visible, .bv-palette select:focus-visible, .bv-palette input:focus-visible { outline:2px solid #fff; outline-offset:1px; }
.bv-palette .bvp-status { font-size:11px; color:var(--muted, #9a9ca3); min-height:1.2em; overflow-wrap:anywhere; }
.bv-palette .bvp-status.err { color:#ff8a7a; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const st = document.createElement('style');
  st.dataset.bv = 'palette';
  st.textContent = CSS;
  document.head.append(st);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

const sameRgb = (a: readonly number[], b: readonly number[]): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

function defaultStorage(): PalettePanelOptions['storage'] {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function mountPalettePanel(root: HTMLElement, opts: PalettePanelOptions): PalettePanel {
  injectCss();
  const { model } = opts;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const getDefault = opts.defaultPalette ?? loadDefaultPalette;

  // --- markup
  const chip = el('span', { class: 'bvp-chip', 'aria-hidden': 'true' });
  const hex = el('span', { class: 'bvp-hex' });
  const sub = el('span', { class: 'bvp-sub' });
  const where = el('div', { class: 'bvp-where', 'aria-live': 'polite' });
  const grid = el('div', { class: 'bvp-grid', role: 'group', 'aria-label': 'Palette colours' });
  const mat = el('select', { 'aria-label': 'Material' });
  for (const m of MATERIALS) mat.append(el('option', { value: m, text: materialLabel(m) }));
  const inten = el('input', { type: 'range', min: '0', max: String(MAX_INTENSITY), step: '1', 'aria-label': 'Material intensity, 0 to 10' });
  const intenOut = el('output', { class: 'bvp-num' });
  const eyeBtn = el('button', { type: 'button', class: 'bvp-btn', 'aria-pressed': 'false', title: 'Eyedropper: click a brick to take its colour, material and intensity' }, 'Eyedropper');
  const paintBtn = el('button', { type: 'button', class: 'bvp-btn bvp-main', title: 'Paint the selected bricks with the current paint' }, opts.paintLabel ?? 'Paint selection');
  const upBtn = el('button', { type: 'button', class: 'bvp-btn' }, 'Upload palette (.bp)');
  const resetBtn = el('button', { type: 'button', class: 'bvp-btn', title: 'Forget the uploaded palette and show the default one' }, 'Reset to default');
  const file = el('input', { type: 'file', accept: '.bp,application/json', hidden: '' });
  const status = el('div', { class: 'bvp-status', role: 'status', 'aria-live': 'polite' });
  paintBtn.hidden = !opts.onPaint;

  const key = (k: string, what: string): HTMLElement => el('span', {}, el('kbd', { text: k }), what);
  const keys = el('div', { class: 'bvp-keys', 'aria-label': 'Paint tool keys' }, key('Click / drag', 'Paint'), key('Alt+click', 'Fill Paint'), key('Ctrl+click', 'Pick'));
  const panel = el('section', { class: 'bv-palette', 'aria-label': 'Paint' },
    el('div', { class: 'bvp-title', text: 'Color' }),
    where,
    grid,
    el('div', { class: 'bvp-cur' }, chip, el('span', { class: 'bvp-curtxt' }, hex, sub)),
    el('label', { class: 'bvp-field' }, el('span', { text: 'Material' }), mat),
    el('label', { class: 'bvp-field' }, el('span', { text: 'Intensity' }), inten, intenOut),
    el('div', { class: 'bvp-btns' }, eyeBtn, paintBtn),
    el('div', { class: 'bvp-btns' }, upBtn, resetBtn),
    keys, file, status,
  );
  // clicks and wheel here aren't canvas drags / zooms
  for (const t of ['pointerdown', 'dblclick', 'wheel']) panel.addEventListener(t, (e) => e.stopPropagation());
  root.append(panel);

  // --- state
  let palette: Palette = defaultPalette();
  let swatches: { btn: HTMLButtonElement; rgb: Rgb8; g: number; i: number }[] = [];
  let eye = false;

  const say = (msg: string, err = false): void => { status.textContent = msg; status.classList.toggle('err', err); };

  function renderGrid(): void {
    grid.replaceChildren();
    swatches = [];
    // one column per group, top to bottom (in DOM order too, so Tab walks a column at a time)
    const rows = Math.max(1, ...palette.groups.map((g) => g.colors.length));
    grid.style.gridTemplateRows = `repeat(${rows}, auto)`;
    palette.groups.forEach((g, gi) => {
      g.colors.forEach((c, ci) => {
        const rgb = paletteColourToSrgb(c), h = hexOfRgb8(rgb);
        const btn = el('button', { type: 'button', class: 'bvp-sw', title: `${g.name} - ${ci}: ${h}`, 'aria-label': `${g.name} - ${ci}, ${h}`, 'aria-pressed': 'false' });
        btn.style.background = h;
        btn.style.gridColumn = String(gi + 1); btn.style.gridRow = String(ci + 1);
        btn.dataset.g = String(gi); btn.dataset.i = String(ci);
        btn.addEventListener('click', () => { model.setColour(rgb); opts.onPick?.(model.paint); });
        btn.addEventListener('pointerenter', () => { where.textContent = `${g.name} - ${ci}`; });
        btn.addEventListener('pointerleave', () => syncCurrent());
        swatches.push({ btn, rgb, g: gi, i: ci });
        grid.append(btn);
      });
    });
    syncCurrent();
  }

  function syncCurrent(): void {
    const p = model.paint, h = hexOfRgb8(p.colour);
    chip.style.background = h;
    hex.textContent = h.toUpperCase();
    sub.textContent = `${materialLabel(p.material)} · ${p.intensity * 10}%`;
    if (![...mat.options].some((o) => o.value === p.material)) mat.append(el('option', { value: p.material, text: materialLabel(p.material) }));
    mat.value = p.material;
    inten.value = String(p.intensity);
    intenOut.textContent = String(p.intensity);
    let first = true, cur = '';
    for (const s of swatches) {
      const on = first && sameRgb(s.rgb, p.colour);
      if (on) { first = false; cur = `${palette.groups[s.g]!.name} - ${s.i}`; }   // duplicates in a palette: mark the first only
      s.btn.setAttribute('aria-pressed', String(on));
    }
    where.textContent = cur || 'Custom colour';
  }

  // arrow keys move between swatches: Up / Down within a group's column, Left / Right to the next group
  grid.addEventListener('keydown', (e) => {
    const s = swatches.find((w) => w.btn === document.activeElement);
    if (!s) return;
    const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (!d) return;
    e.preventDefault();
    const g = Math.max(0, Math.min(palette.groups.length - 1, s.g + d[0]));
    const i = Math.max(0, Math.min(palette.groups[g]!.colors.length - 1, s.i + d[1]));
    swatches.find((w) => w.g === g && w.i === i)?.btn.focus();
  });

  mat.addEventListener('change', () => { model.setMaterial(mat.value); opts.onPick?.(model.paint); });
  inten.addEventListener('input', () => { model.setIntensity(+inten.value); opts.onPick?.(model.paint); });
  eyeBtn.addEventListener('click', () => api.setEyedropper(!eye));
  paintBtn.addEventListener('click', () => opts.onPaint?.(model.paint));
  upBtn.addEventListener('click', () => file.click());
  resetBtn.addEventListener('click', () => { void api.resetToDefault(); });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (f) api.loadFile(f).catch(() => { /* reported in the status line */ });
  });
  const unsub = model.subscribe(syncCurrent);

  const remember = (p: Palette | null): void => {
    try { if (p) storage?.setItem(PALETTE_KEY, serialisePalette(p)); else storage?.removeItem(PALETTE_KEY); } catch { /* storage blocked */ }
  };

  const api: PalettePanel = {
    el: panel,
    get palette() { return palette; },
    get eyedropper() { return eye; },
    setEyedropper(on) {
      if (on === eye) return;
      eye = on;
      eyeBtn.setAttribute('aria-pressed', String(on));
      say(on ? 'Eyedropper: click a brick' : '');
      opts.onEyedropper?.(on);
    },
    eyedrop(brick) {
      const p = model.pickFrom(brick);
      api.setEyedropper(false);
      say(`Picked ${hexOfRgb8(p.colour).toUpperCase()}`);
      opts.onPick?.(p);
      return p;
    },
    setPalette(p) { palette = p; renderGrid(); },
    async loadFile(f) {
      try {
        const p = parsePalette(new Uint8Array(await f.arrayBuffer()));
        api.setPalette(p);
        remember(p);
        const n = p.groups.reduce((a, g) => a + g.colors.length, 0);
        say(`Loaded ${(f as File).name ?? 'palette'}: ${n} colours${p.description ? ` (${p.description.split(/\r?\n/)[0]})` : ''}`);
        return p;
      } catch (e) {
        say(e instanceof PaletteError ? `Not a colour palette: ${e.message}` : `Couldn't read the file: ${(e as Error).message}`, true);
        throw e;
      }
    },
    async resetToDefault() {
      remember(null);
      api.setPalette(await getDefault());
      say('Default palette');
    },
    destroy() { unsub(); panel.remove(); },
  };

  // start: the remembered upload, else the default
  renderGrid();
  let saved: Palette | null = null;
  try { const s = storage?.getItem(PALETTE_KEY); if (s) saved = parsePalette(s); } catch { saved = null; }
  if (saved) api.setPalette(saved);
  else void Promise.resolve(getDefault()).then((p) => { if (!saved) api.setPalette(p); }, () => { /* keep the built-in default */ });
  return api;
}
