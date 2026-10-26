// Graphics settings panel (backlog L-06), full build: the game's own Options/Graphics settings,
// grouped like a game menu, with the game's quality levels (Low / Medium / High / Epic) as presets.
// Loads and saves the game's preset files (.bp, format/graphics.ts) with every key kept. Settings
// the viewer has no equivalent for are still read, edited and saved, and say "Not Implemented".
// What each implemented one does here is in its tooltip and in docs/UX_ASSUMPTIONS.md (the mapping
// is close, not 1:1). Same look as the Environment panel (its styles).

import { injectStyle } from './environment.ts';
import {
  defaultGraphicsPreset, getGfx, GraphicsPresetError, parseGraphicsPreset, qualityLevelOf, QUALITY_NAMES, serialiseGraphicsPreset, setGfx, withQualityLevel,
  type GfxValue, type GraphicsPreset,
} from '../../format/graphics.ts';
import { graphicsFileName, graphicsPreset, onGraphicsChange, setGraphicsPreset, setViewerGraphics, viewerGraphics } from '../../app/graphics.ts';
import { fx } from '../../render/fx/state.ts';

type Kind = 'level' | 'level4' | 'bool' | 'num' | 'enum';
interface Row { key: string; label: string; kind: Kind; does?: string; opts?: string[]; min?: number; max?: number; step?: number }
interface Section { title: string; rows: Row[] }

// `does` set = implemented (what it changes in the viewer); unset = Not Implemented
const SECTIONS: Section[] = [
  { title: 'Quality', rows: [
    { key: 'ShadowQuality', label: 'Shadows', kind: 'level', does: 'Sun shadows: Low = off, Medium = 1024 map / 4 taps, High = 2048 / 8 taps, Epic = 4096 / 12 taps' },
    { key: 'PostProcessingQuality', label: 'Post Processing', kind: 'level', does: 'SSAO (Low = off, then 6 / 10 / 14 samples) and the glow bloom (off at Low)' },
    { key: 'VisualEffectQuality', label: 'Visual Effects', kind: 'level', does: 'Water waves: Low = flat, then 1 / 2 / 3 wave octaves' },
    { key: 'ViewDistanceQuality', label: 'View Distance', kind: 'level4' },
    { key: 'TextureQuality', label: 'Textures', kind: 'level' },
    { key: 'FoliageQuality', label: 'Foliage', kind: 'level' },
    { key: 'AntiAliasingQuality', label: 'Anti-Aliasing Quality', kind: 'level' },
    { key: 'GlobalIlluminationMode', label: 'Global Illumination', kind: 'enum', opts: ['None', 'ProtoLumen', 'SWLumen', 'HWRTLumen'] },
    { key: 'GlobalIlluminationQuality', label: 'GI Quality', kind: 'level' },
    { key: 'ReflectionMode', label: 'Reflections', kind: 'enum', opts: ['None', 'SSR', 'SWLumen', 'HWRTLumen'] },
    { key: 'ReflectionQuality', label: 'Reflection Quality', kind: 'level' },
    { key: 'bExtremeReflections', label: 'Extreme Reflections', kind: 'bool' },
    { key: 'bUseVirtualShadowMaps', label: 'Virtual Shadow Maps', kind: 'bool' },
    { key: 'bSupportRayTracing', label: 'Ray Tracing Support', kind: 'bool' },
    { key: 'bEnableOIT', label: 'Order-Independent Transparency', kind: 'bool' },
    { key: 'bSimpleShadingSupportLocalLights', label: 'Simple Shading Local Lights', kind: 'bool' },
    { key: 'bEnableGizmoPass', label: 'Gizmo Pass', kind: 'bool' },
    { key: 'bEnableGizmoMSAA', label: 'Gizmo MSAA', kind: 'bool' },
  ] },
  { title: 'Display', rows: [
    { key: 'FrameRateLimit', label: 'Frame Rate Limit', kind: 'num', min: 0, max: 500, step: 1, does: 'Caps the viewer\'s frame rate (0 = no cap)' },
    { key: 'FrameRateLimitUnfocused', label: 'Background Frame Rate Limit', kind: 'num', min: 0, max: 500, step: 1, does: 'The cap while the window is in the background (0 = the normal cap)' },
    { key: 'ResolutionScaleValueEx', label: 'Resolution Scale', kind: 'num', min: 25, max: 100, step: 1, does: 'Render resolution (%). With an upscaler (DLSS, FSR, XeSS, TSR) the viewer renders at 100 %, since it has no upscaler' },
    { key: 'ResolutionScalePreset', label: 'Resolution Scale Preset', kind: 'enum', opts: ['Native', 'Quality', 'Balanced', 'Performance', 'Performance2', 'UltraPerformance', 'Custom'] },
    { key: 'AntiAliasingMode', label: 'Anti-Aliasing', kind: 'enum', opts: ['None', 'FXAA', 'TAA', 'TSR', 'DLSS', 'FSR', 'XeSS'] },
    { key: 'FullscreenMode', label: 'Window Mode', kind: 'enum', opts: ['Windowed', 'WindowedFullscreen', 'Fullscreen', 'Exclusive'] },
    { key: 'ScreenResolutionById', label: 'Resolution', kind: 'num', min: 0, max: 99, step: 1 },
    { key: 'VSyncEnabled', label: 'VSync', kind: 'bool' },
    { key: 'FPSCounterMode', label: 'FPS Counter', kind: 'enum', opts: ['Disabled', 'Enabled', 'Detailed'] },
    { key: 'RenderingMode', label: 'Rendering Mode', kind: 'enum', opts: ['DirectX11', 'DirectX12', 'Vulkan'] },
    { key: 'ReflexMode', label: 'Reflex', kind: 'enum', opts: ['Disabled', 'Enabled', 'Boost'] },
    { key: 'FrameGenerationMethod', label: 'Frame Generation Method', kind: 'enum', opts: ['None', 'DLSS', 'FSR'] },
    { key: 'FrameGenerationMode', label: 'Frame Generation', kind: 'enum', opts: ['Disabled', 'Enabled'] },
    { key: 'bTransformerEnabled', label: 'DLSS Transformer Model', kind: 'bool' },
    { key: 'bBR_HDREnabled', label: 'HDR', kind: 'bool' },
    { key: 'BR_HDRNits', label: 'HDR Peak Nits', kind: 'num', min: 100, max: 10000, step: 10 },
    { key: 'BR_HDR_UI_Nits', label: 'HDR Interface Nits', kind: 'num', min: 50, max: 1000, step: 1 },
    { key: 'HDRPaperWhite', label: 'HDR Paper White', kind: 'num', min: 50, max: 1000, step: 1 },
    { key: 'bUseCustomInterfaceScale', label: 'Custom Interface Scale', kind: 'bool' },
    { key: 'CustomInterfaceScale', label: 'Interface Scale', kind: 'num', min: 0.25, max: 3, step: 0.05 },
  ] },
  { title: 'Camera', rows: [
    { key: 'FieldOfView', label: 'Field of View', kind: 'num', min: 20, max: 130, step: 1, does: 'The view stays orthographic; the sky, the fog distance and the water reflections use a virtual camera with this horizontal field of view' },
    { key: 'ThirdPersonShoulderFieldOfView', label: 'Shoulder Camera FOV', kind: 'num', min: 20, max: 130, step: 1 },
    { key: 'bUseThirdPersonShoulderFieldOfView', label: 'Use Shoulder Camera FOV', kind: 'bool' },
    { key: 'ThirdPersonOrbitFieldOfView', label: 'Orbit Camera FOV', kind: 'num', min: 20, max: 130, step: 1 },
    { key: 'bUseThirdPersonOrbitFieldOfView', label: 'Use Orbit Camera FOV', kind: 'bool' },
    { key: 'bEnableCameraTransitions', label: 'Camera Transitions', kind: 'bool' },
    { key: 'CameraShakeScale', label: 'Camera Shake', kind: 'num', min: 0, max: 2, step: 0.05 },
    { key: 'MotionBlurMode', label: 'Motion Blur', kind: 'enum', opts: ['Disabled', 'Enabled'] },
  ] },
];
const KNOWN = new Set(SECTIONS.flatMap((s) => s.rows.map((r) => r.key.toLowerCase())));
const LEVELS = ['Low', 'Medium', 'High', 'Epic'];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = String(v);
    else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role' || k === 'for') e.setAttribute(k, String(v));
    else (e as unknown as Record<string, unknown>)[k] = v;
  }
  e.append(...kids);
  return e;
};

export interface GraphicsPanel { readonly el: HTMLElement; refresh(): void; loadText(text: string, name?: string): void; toText(): string }

export function createGraphicsPanel(opts: { onClose?: () => void } = {}): GraphicsPanel {
  injectStyle(document);
  const root = el('section', { class: 'envp gfxp', 'aria-label': 'Graphics settings' });
  const pick = el('input', { type: 'file', accept: '.bp,application/json', hidden: true });
  const btnPresets = el('button', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Quality levels, and load / save the game\'s graphics preset (.bp)' }, 'PRESETS ▾');
  const lvlBtns = LEVELS.map((n, i) => {
    const b = el('button', { type: 'button', role: 'menuitem', title: `Every quality setting at ${n}` }, n);
    b.addEventListener('click', () => { showMenu(false); setGraphicsPreset(withQualityLevel(graphicsPreset(), i)); say(`Quality: ${n}`); });
    return b;
  });
  const btnLoad = el('button', { type: 'button', role: 'menuitem', title: 'Load a graphics preset (.bp) from the game\'s Presets\\Options\\Graphics folder' }, 'Load .bp…');
  const btnSave = el('button', { type: 'button', role: 'menuitem', title: 'Download these settings as a graphics preset (.bp) the game can load' }, 'Save .bp');
  const btnReset = el('button', { type: 'button', role: 'menuitem', title: 'Back to the viewer\'s defaults' }, 'Reset to default');
  const menu = el('div', { class: 'envp-menu', role: 'menu', hidden: true }, ...lvlBtns, el('hr'), btnLoad, btnSave, el('hr'), btnReset);
  const head = el('div', { class: 'envp-head' }, el('h2', {}, 'GRAPHICS'), btnPresets, menu);
  const status = el('p', { class: 'envp-status', role: 'status', 'aria-live': 'polite' });
  const body = el('div', { class: 'envp-body' });
  root.append(head, status, body, pick);
  if (opts.onClose) {
    const close = el('button', { type: 'button', class: 'envp-close', 'aria-label': 'Close', title: 'Close' }, '✕');
    const done = el('button', { type: 'button', class: 'envp-done' }, '→ DONE');
    close.addEventListener('click', () => opts.onClose!()); done.addEventListener('click', () => opts.onClose!());
    head.append(close); root.append(el('div', { class: 'envp-foot' }, done));
  }
  const say = (m: string, err = false): void => { status.textContent = m; status.classList.toggle('err', err); };
  const showMenu = (on: boolean): void => { menu.hidden = !on; btnPresets.setAttribute('aria-expanded', String(on)); };
  btnPresets.addEventListener('click', () => showMenu(menu.hidden !== false));
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !head.contains(e.target as Node)) showMenu(false); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); showMenu(false); btnPresets.focus(); } });

  let refreshers: (() => void)[] = [];
  let uid = 0;
  const set = (key: string, v: GfxValue): void => setGraphicsPreset(setGfx(graphicsPreset(), key, v));

  function line(labelText: string, title: string, ni: boolean, ctl: HTMLElement, id: string): HTMLElement {
    const label = el('label', { for: id, title: ni ? `${title}. Not Implemented: read and saved, not shown in the viewer` : title }, labelText);
    if (ni) label.append(el('span', { class: 'envp-ni' }, 'Not Implemented'));
    return el('div', { class: ni ? 'envp-row envp-nirow' : 'envp-row' }, label, el('span'), ctl);
  }
  function switchCtl(id: string, label: string, get: () => boolean, put: (v: boolean) => void): HTMLElement {
    const sw = el('button', { type: 'button', role: 'switch', class: 'envp-sw', id, 'aria-label': label });
    sw.addEventListener('click', () => put(!get()));
    refreshers.push(() => { const on = get(); sw.setAttribute('aria-checked', String(on)); sw.textContent = on ? 'I' : 'O'; });
    return el('div', { class: 'envp-ctl' }, sw);
  }
  function rowEl(r: Row): HTMLElement {
    const id = `gfxp-${++uid}`, ni = !r.does, title = `${r.key}${r.does ? ': ' + r.does : ''}`;
    const cur = (): unknown => getGfx(graphicsPreset(), r.key);
    let ctl: HTMLElement;
    if (r.kind === 'bool') ctl = switchCtl(id, r.label, () => cur() === true, (v) => set(r.key, v));
    else if (r.kind === 'level' || r.kind === 'level4' || r.kind === 'enum') {
      const sel = el('select', { id, 'aria-label': r.label });
      const names = r.kind === 'enum' ? r.opts! : QUALITY_NAMES.slice(0, r.kind === 'level4' ? 5 : 4);
      sel.addEventListener('change', () => set(r.key, r.kind === 'enum' ? sel.value : Number(sel.value)));
      refreshers.push(() => {
        const v = cur(), list: [string, string][] = names.map((n, i) => (r.kind === 'enum' ? [n, n] : [String(i), n]));
        if (v !== undefined && !list.some(([k]) => k === String(v))) list.push([String(v), String(v)]);
        if (v === undefined) list.unshift(['', '(not in file)']);
        sel.replaceChildren(...list.map(([k, n]) => el('option', { value: k }, n)));
        sel.value = v === undefined ? '' : String(v);
      });
      ctl = el('div', { class: 'envp-ctl' }, sel);
    } else {
      const inp = el('input', { type: 'number', id, step: String(r.step ?? 'any'), min: String(r.min ?? ''), max: String(r.max ?? ''), 'aria-label': r.label, class: 'gfxp-num' });
      inp.addEventListener('change', () => { const n = Number(inp.value); if (inp.value.trim() !== '' && Number.isFinite(n)) set(r.key, n); else refreshAll(); });
      refreshers.push(() => { const v = cur(); if (document.activeElement !== inp) inp.value = typeof v === 'number' ? String(Number(v.toPrecision(6))) : ''; });
      ctl = el('div', { class: 'envp-ctl' }, inp);
    }
    return line(r.label, title, ni, ctl, id);
  }
  function build(): void {
    refreshers = [];
    body.replaceChildren();
    // the viewer's own switches (not in the game's file)
    const viewer = el('details', { open: true }, el('summary', {}, 'Viewer'), el('div', { class: 'envp-sub' }, 'The viewer\'s own switches (kept by the browser, not in the game\'s file).'));
    viewer.append(line('Graphics Effects', 'Sun shadows, SSAO, sky, distance fog and water. Off = the plain calibrated look', false,
      switchCtl('gfxp-fx', 'Graphics Effects', () => viewerGraphics().effects, (v) => setViewerGraphics({ effects: v })), 'gfxp-fx'));
    viewer.append(line('Adaptive Quality', 'On big scenes, step SSAO and then shadows down while the frame rate is low', false,
      switchCtl('gfxp-ad', 'Adaptive Quality', () => viewerGraphics().adaptive, (v) => setViewerGraphics({ adaptive: v })), 'gfxp-ad'));
    const lvl = el('select', { id: 'gfxp-overall', 'aria-label': 'Overall quality' });
    lvl.addEventListener('change', () => { if (lvl.value !== '') setGraphicsPreset(withQualityLevel(graphicsPreset(), Number(lvl.value))); });
    refreshers.push(() => {
      const q = qualityLevelOf(graphicsPreset());
      lvl.replaceChildren(...(q === null ? [el('option', { value: '' }, 'Custom')] : []), ...LEVELS.map((n, i) => el('option', { value: String(i) }, n)));
      lvl.value = q === null ? '' : String(Math.min(3, q));
    });
    viewer.append(line('Overall Quality', 'Sets every quality setting to one level, like the game\'s presets', false, el('div', { class: 'envp-ctl' }, lvl), 'gfxp-overall'));
    const note = el('div', { class: 'envp-sub' });
    refreshers.push(() => { note.textContent = fx.want.on && fx.drop ? `Adaptive quality has stepped effects down (level ${fx.drop}) to keep the frame rate.` : ''; });
    viewer.append(note);
    body.append(viewer);
    for (const s of SECTIONS) {
      const det = el('details', { open: s.title === 'Quality' }, el('summary', {}, s.title));
      for (const r of s.rows) det.append(rowEl(r));
      body.append(det);
    }
    // keys this viewer doesn't know (older or newer game builds): shown, editable, saved
    const extra = graphicsPreset().entries.filter(([k, v]) => !KNOWN.has(k.toLowerCase()) && ['number', 'boolean', 'string'].includes(typeof v));
    if (extra.length) {
      const det = el('details', {}, el('summary', {}, 'Other (from the file)'));
      for (const [k, v] of extra) det.append(rowEl({ key: k, label: k, kind: typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'num' : 'enum', opts: typeof v === 'string' ? [v] : undefined }));
      body.append(det);
    }
    refreshAll();
  }
  const refreshAll = (): void => { for (const f of refreshers) f(); };
  let keys = '';
  onGraphicsChange(() => {
    const k = graphicsPreset().entries.map(([x]) => x).join();
    if (k !== keys) { keys = k; build(); } else refreshAll();
  });

  function loadText(text: string, name = 'graphics.bp'): void {
    const p: GraphicsPreset = parseGraphicsPreset(text);
    setGraphicsPreset(p, /\.bp$/i.test(name) ? name : `${name}.bp`);
    say(`Loaded ${name}`);
  }
  const toText = (): string => serialiseGraphicsPreset(graphicsPreset());
  btnLoad.addEventListener('click', () => { showMenu(false); pick.click(); });
  pick.addEventListener('change', () => {
    const f = pick.files?.[0];
    pick.value = '';
    if (!f) return;
    void f.text().then((t) => loadText(t, f.name)).catch((e: unknown) => say(`Couldn't read ${f.name}: ${e instanceof GraphicsPresetError ? e.message : String(e)}`, true));
  });
  btnSave.addEventListener('click', () => {
    showMenu(false);
    const url = URL.createObjectURL(new Blob([toText()], { type: 'application/json' })), name = graphicsFileName();
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`Saved ${name}`);
  });
  btnReset.addEventListener('click', () => { showMenu(false); setGraphicsPreset(defaultGraphicsPreset(), 'graphics.bp'); setViewerGraphics({ effects: true, adaptive: true }); say('Reset to default'); });
  root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); root.classList.add('drop'); } });
  root.addEventListener('dragleave', () => root.classList.remove('drop'));
  root.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => /\.(bp|json)$/i.test(x.name));
    root.classList.remove('drop');
    if (!f) return;
    e.preventDefault(); e.stopPropagation();
    void f.text().then((t) => loadText(t, f.name)).catch((err: unknown) => say(`Couldn't read ${f.name}: ${String(err)}`, true));
  });
  keys = graphicsPreset().entries.map(([x]) => x).join();
  build();
  return { el: root, refresh: refreshAll, loadText, toText };
}
