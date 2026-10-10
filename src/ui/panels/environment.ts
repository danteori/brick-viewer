// Environment settings panel: every setting of an environment preset, laid out like the game's
// Environment menu (backlog U-17): the sections Sky, Sky - Night, Weather, Fog, Ground, Water and
// Ambience in that order (Universe for Space worlds, and an Advanced fold for the one setting the
// game's menu has no control for), the game's Title Case labels, value-in-bar sliders with the
// game's units (%, x, hr, min, °), square I / O switches, full-width colour swatches, R / G / B
// number boxes, a reset arrow on every changed row, a PRESETS menu (.bp load / save, reset) and
// close / DONE buttons. Live preview through onChange. Colours and fonts stay the app's own.
//
//   const panel = createEnvironmentPanel({ kind: 'Plate', onChange: (env) => renderer.setEnvironment(env) });
//   document.body.append(panel.el);
//   panel.set(worldEnv, 'Plate');            // e.g. after loading a world
//   panel.setDefault(loadedDefault);         // what "Reset to default" goes back to
//
// Self-contained: plain DOM, its own scoped styles (injected once), and only the format module. It
// uses the app's CSS variables (--bg, --fg, --muted, --accent, --line) with fallbacks.

import {
  completeEnvironment, defaultEnvironment, environmentForKind, EnvironmentError, GROUP_DEFAULTS, hexToLinear, KNOWN_STRINGS,
  linearToHex, parseEnvironment, RANGES, serialiseEnvironment, setEnvValue, kindOf,
  type Environment, type EnvGroups, type GroupName, type LinearColor, type Range, type Rotator, type Vec3,
} from '../../format/environment.ts';

export type PanelWorldKind = 'Plate' | 'Space';

export interface EnvironmentPanelOptions {
  /** Starting environment (default: the game's default for `kind`). */
  env?: Environment;
  kind?: PanelWorldKind;
  /** What "Reset to default" restores, per kind (default: the game's built-in default). */
  defaults?: Partial<Record<PanelWorldKind, Environment>>;
  /** Called (at most once per animation frame) with a fresh copy after every edit, load or reset. */
  onChange?: (env: Environment) => void;
  /** Called when the panel loads a .bp, with its kind as detected from its groups. */
  onLoad?: (env: Environment, kind: PanelWorldKind, fileName: string) => void;
  /** The close (✕) / DONE buttons; they are left out when not given. */
  onClose?: () => void;
  /** Sections open at start (by id); default none, as in the game. */
  open?: string[];
}

export interface EnvironmentPanel {
  readonly el: HTMLElement;
  /** The current environment (a copy). */
  get(): Environment;
  /** Replaces the environment; groups the kind needs but `env` lacks are filled with defaults. */
  set(env: Environment, kind?: PanelWorldKind): void;
  setKind(kind: PanelWorldKind): void;
  readonly kind: PanelWorldKind;
  setDefault(env: Environment, kind?: PanelWorldKind): void;
  /** Loads .bp text (as from a file); throws EnvironmentError on bad input. */
  loadText(text: string, fileName?: string): void;
  /** The current environment as .bp text. */
  toText(): string;
  destroy(): void;
}

// ---------------------------------------------------------------------------------- layout
/** How a number shows: pct = x100 with %, x / hr / min / deg = suffixes, u / studs = our unit notes. */
export type Unit = 'pct' | 'x' | 'hr' | 'min' | 'deg' | 'u' | 'studs';
interface Row { g: GroupName; key: string; label: string; unit?: Unit; hint?: string; range?: Range }
interface Section { id: string; title: string; kinds: PanelWorldKind[]; rows: Row[]; note?: string }

const r = (g: GroupName, key: string, label: string, unit?: Unit, more: Partial<Row> = {}): Row => ({ g, key, label, unit, ...more });
/** The slider ends of the game's menu, where they differ from the format's RANGES (typed values may go past them). */
const rg = (min: number, max: number, step = 0.01): Range => ({ min, max, step });

export const SECTIONS: readonly Section[] = [
  { id: 'sky', title: 'Sky', kinds: ['Plate'], rows: [
    r('sky', 'timeOfDay', 'Time of Day', 'hr'),
    r('sky', 'animateTimeOfDay', 'Animate Time of Day'),
    r('sky', 'dayLength', 'Day Length', 'min', { range: rg(0, 30, 0.5) }),
    r('sky', 'nightLength', 'Night Length', 'min', { range: rg(0, 30, 0.5) }),
    r('sky', 'sunAngle', 'Sun Angle', 'deg'),
    r('sky', 'sunScale', 'Sun Scale', 'pct'),
    r('sky', 'sunHorizonScaleMultiplier', 'Sun Horizon Scale', 'x'),
    r('sky', 'sunlightColor', 'Sunlight Color'),
    r('sky', 'skyIntensity', 'Sky Intensity', 'pct', { range: rg(0, 2) }),
    r('sky', 'skyColor', 'Sky Color'),
  ] },
  { id: 'night', title: 'Sky - Night', kinds: ['Plate'], rows: [
    r('sky', 'moonPhase', 'Moon Phase', 'x', { hint: 'Days into the lunar cycle (0 to 29.5)' }),
    r('sky', 'moonScale', 'Moon Scale', 'pct'),
    r('sky', 'moonlightIntensity', 'Moonlight Intensity', 'pct', { range: rg(0, 2) }),
    r('sky', 'moonlightColor', 'Moonlight Color'),
    r('sky', 'starsIntensity', 'Stars Intensity', 'x'),
    r('sky', 'starsColor', 'Stars Color'),
    r('sky', 'auroraIntensity', 'Aurora Intensity'),
  ] },
  { id: 'weather', title: 'Weather', kinds: ['Plate'], rows: [
    r('sky', 'cloudCoverage', 'Cloud Coverage', 'pct'),
    r('sky', 'rain', 'Rain'),
    r('sky', 'snow', 'Snow'),
    r('sky', 'dust', 'Dust'),
    r('sky', 'thunder', 'Thunder'),
    r('sky', 'wind', 'Wind', 'pct'),
    r('sky', 'windDirection', 'Wind Angle', 'deg'),
    r('sky', 'bCloseLightning', 'Close Lightning'),
    r('sky', 'rainVolume', 'Rain Volume', 'pct'),
    r('sky', 'closeThunderVolume', 'Close Thunder Volume', 'pct'),
    r('sky', 'distantThunderVolume', 'Distant Thunder Volume', 'pct'),
    r('sky', 'windVolume', 'Wind Volume', 'pct'),
  ] },
  { id: 'fog', title: 'Fog', kinds: ['Plate'], rows: [
    r('sky', 'clearFogDensity', 'Clear Fog Density'),
    r('sky', 'cloudyFogDensity', 'Cloudy Fog Density'),
    r('sky', 'clearFogHeightFalloff', 'Clear Fog Height Falloff'),
    r('sky', 'cloudyFogHeightFalloff', 'Cloudy Fog Height Falloff'),
    r('sky', 'fogColor', 'Fog Color'),
  ] },
  { id: 'ground', title: 'Ground', kinds: ['Plate'], rows: [
    r('groundPlate', 'variance', 'Pattern Intensity'),
    r('groundPlate', 'varianceBrickSize', 'Pattern Size', 'studs'),
    r('groundPlate', 'groundColor', 'Ground Primary Color'),
    r('groundPlate', 'groundAccentColor', 'Ground Accent Color'),
    r('groundPlate', 'isVisible', 'Is Visible'),
    r('groundPlate', 'bUseStudTexture', 'Stud Texture'),
  ] },
  { id: 'water', title: 'Water', kinds: ['Plate'], rows: [
    r('water', 'waterHeight', 'Height', 'u', { hint: 'World units (10 per stud). 0 = no water' }),
    r('water', 'waterAbsorption', 'Color Absorption'),
    r('water', 'waterScattering', 'Scattering'),
    r('water', 'waterFogIntensity', 'Fog Intensity'),
    r('water', 'waterFogAmbientColor', 'Fog Ambient Color'),
    r('water', 'waterFogAmbientScale', 'Fog Ambient Strength', 'pct'),
    r('water', 'waterFogScatteringColor', 'Fog Scattering Color'),
    r('water', 'waterFogScatteringScale', 'Fog Scattering Strength', 'pct', { range: rg(0, 4) }),
  ] },
  { id: 'universe', title: 'Universe', kinds: ['Space'], rows: [
    r('universe', 'universeRotation', 'Rotation', 'deg'),
    r('universe', 'universeLightColor', 'Light Color'),
    r('universe', 'universeLightIntensity', 'Light Intensity'),
    r('universe', 'universeAmbientColor', 'Ambient Color'),
    r('universe', 'universeAmbientIntensity', 'Ambient Intensity'),
    r('universe', 'universeGravityScale', 'Gravity Scale'),
    r('universe', 'bUniverseFloorEnabled', 'Floor'),
    r('universe', 'nebulaTexture', 'Nebula'),
    r('universe', 'nebulaColor', 'Nebula Color'),
    r('universe', 'nebulaRedBlueSwap', 'Nebula Red/Blue Swap'),
    r('universe', 'nebulaSaturation', 'Nebula Saturation'),
    r('universe', 'nebulaPower', 'Nebula Power'),
    r('universe', 'nebulaBrightness', 'Nebula Brightness'),
    r('universe', 'nearStarsTexture', 'Near Stars'),
    r('universe', 'nearStarsPower', 'Near Stars Power'),
    r('universe', 'nearStarsBrightness', 'Near Stars Brightness'),
    r('universe', 'farStarsTexture', 'Far Stars'),
    r('universe', 'farStarsPower', 'Far Stars Power'),
    r('universe', 'farStarsBrightness', 'Far Stars Brightness'),
  ] },
  { id: 'ambience', title: 'Ambience', kinds: ['Plate', 'Space'], rows: [
    r('ambience', 'selectedAmbienceType', 'Ambience'),
    r('ambience', 'ambienceVolume', 'Ambience Volume', 'pct'),
    r('ambience', 'reverbEffect', 'Reverb Effect'),
  ] },
  { id: 'advanced', title: 'Advanced', kinds: ['Plate'], note: 'Saved in presets, but the game\'s menu has no control for it.', rows: [
    r('sky', 'cloudSpeedMultiplier', 'Cloud Speed', 'x'),
  ] },
];

/** Rows shown disabled (greyed, hatched), as the game does: Ambience Volume while Ambience is None. */
const DISABLED: Record<string, (get: (g: GroupName, key: string) => unknown) => boolean> = {
  'ambience.ambienceVolume': (get) => get('ambience', 'selectedAmbienceType') === 'None',
};

// ---------------------------------------------------------------------------------- styles
const STYLE_ID = 'envp-style';
const CSS = `
.envp { --envp-bg: var(--panel-bg, rgba(29,30,33,.94)); --envp-fg: var(--fg, #eee); --envp-muted: var(--muted, #9a9ca3);
  --envp-accent: var(--accent, #e8590c); --envp-line: var(--line, rgba(255,255,255,.14)); --envp-field: var(--bg, #2b2c30);
  --envp-on: #3fae5a; --envp-off: #d9493c;
  box-sizing: border-box; display: flex; flex-direction: column; width: 100%; max-width: 380px; max-height: 100%; border-radius: 10px;
  background: var(--envp-bg); color: var(--envp-fg); border: 1px solid var(--envp-line); box-shadow: 0 6px 24px rgba(0,0,0,.35);
  font: 12px/1.35 system-ui, sans-serif; }
.envp *, .envp *::before, .envp *::after { box-sizing: border-box; }
.envp-head { display: flex; align-items: center; gap: 6px; padding: 10px 10px 6px; position: relative; }
.envp-head h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 800; letter-spacing: .06em; }
.envp-kind { font-size: 11px; color: var(--envp-muted); }
.envp button { padding: 5px 9px; border: 1px solid var(--envp-line); border-radius: 7px; background: var(--envp-field); color: var(--envp-fg);
  font: 600 12px/1.2 system-ui, sans-serif; cursor: pointer; }
.envp button:hover { border-color: var(--envp-accent); }
.envp button:focus-visible, .envp input:focus-visible, .envp select:focus-visible, .envp summary:focus-visible, .envp-sl:focus-visible { outline: 2px solid var(--envp-accent); outline-offset: 1px; }
.envp .envp-close { padding: 3px 7px; background: var(--envp-off); border-color: var(--envp-off); color: #fff; }
.envp-menu { position: absolute; right: 10px; top: 100%; z-index: 2; display: grid; min-width: 11em; padding: 4px; border-radius: 8px;
  background: var(--envp-bg); border: 1px solid var(--envp-line); box-shadow: 0 6px 18px rgba(0,0,0,.4); }
.envp-menu[hidden] { display: none; }
.envp .envp-menu button { border: 0; background: none; text-align: left; font-weight: 500; }
.envp .envp-menu button:hover { background: var(--envp-field); }
.envp-menu hr { width: 100%; margin: 3px 0; border: 0; border-top: 1px solid var(--envp-line); }
.envp-status { min-height: 1.35em; margin: 0; padding: 0 10px 4px; color: var(--envp-muted); font-size: 11px; }
.envp-status.err { color: #ff8a65; }
.envp-body { flex: 1; min-height: 0; overflow: auto; padding: 0 10px; scrollbar-width: thin; }
.envp details { border-top: 1px solid var(--envp-line); }
.envp summary { display: flex; align-items: center; gap: 6px; padding: 7px 2px; font-weight: 700; cursor: pointer; user-select: none; list-style: none; }
.envp summary::-webkit-details-marker { display: none; }
.envp summary::before { content: '>'; display: inline-block; width: 1em; color: var(--envp-muted); font-weight: 800; transition: transform .1s; }
.envp details[open] > summary::before { transform: rotate(90deg); }
.envp-row { display: grid; grid-template-columns: minmax(0, 40%) 1.3em minmax(0, 1fr); align-items: center; gap: 4px; padding: 3px 2px; }
.envp-row > label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--envp-muted); cursor: default; }
.envp-row > label:hover { color: var(--envp-fg); }
.envp .envp-reset { width: 1.3em; height: 1.3em; padding: 0; border: 0; background: none; color: var(--envp-muted); font-size: 14px; line-height: 1; }
.envp .envp-reset:hover { color: var(--envp-fg); }
.envp-reset[hidden] { display: block !important; visibility: hidden; }
.envp-ctl { display: flex; align-items: center; gap: 4px; min-width: 0; position: relative; }
.envp-sl { position: relative; flex: 1; min-width: 0; height: 22px; border-radius: 5px; background: var(--envp-field); border: 1px solid var(--envp-line);
  overflow: hidden; cursor: ew-resize; touch-action: none; user-select: none; }
.envp-fill { position: absolute; inset: 0 auto 0 0; background: rgba(255,255,255,.14); pointer-events: none; }
.envp-val { position: absolute; left: 6px; top: 50%; transform: translateY(-50%); font-variant-numeric: tabular-nums; pointer-events: none; white-space: nowrap; }
.envp-grip { position: absolute; right: 5px; top: 50%; transform: translateY(-50%); color: var(--envp-muted); font-size: 10px; pointer-events: none; }
.envp-edit { position: absolute; inset: 0; width: 100%; padding: 2px 6px; border: 1px solid var(--envp-accent); border-radius: 5px;
  background: var(--envp-field); color: var(--envp-fg); font: 12px/1.2 system-ui, sans-serif; font-variant-numeric: tabular-nums; }
.envp-edit[hidden] { display: none; }
.envp .envp-sw { width: 22px; height: 22px; padding: 0; border-radius: 4px; color: #fff; font: 800 12px/1 system-ui, sans-serif; }
.envp .envp-sw[aria-checked=true] { background: var(--envp-on); border-color: var(--envp-on); }
.envp .envp-sw[aria-checked=false] { background: var(--envp-off); border-color: var(--envp-off); }
.envp-row input[type=color] { flex: 1; min-width: 0; height: 22px; padding: 0; border: 1px solid var(--envp-line); border-radius: 5px; background: none; cursor: pointer; }
.envp-row input[type=color]::-webkit-color-swatch-wrapper { padding: 0; }
.envp-row input[type=color]::-webkit-color-swatch { border: 0; border-radius: 4px; }
.envp-row select, .envp-vec input { min-width: 0; padding: 3px 5px; border: 1px solid var(--envp-line); border-radius: 5px;
  background: var(--envp-field); color: var(--envp-fg); font: 12px/1.2 system-ui, sans-serif; }
.envp-row select { flex: 1; }
.envp-vec input { flex: 1; width: 0; font-variant-numeric: tabular-nums; border-left-width: 3px; }
.envp-vec input.c0 { border-left-color: #e5534b; } .envp-vec input.c1 { border-left-color: #57ab5a; } .envp-vec input.c2 { border-left-color: #539bf5; }
.envp-row.envp-dis > label { opacity: .5; }
.envp-row.envp-dis .envp-ctl { opacity: .55; pointer-events: none;
  background: repeating-linear-gradient(135deg, transparent 0 5px, rgba(255,255,255,.08) 5px 7px); border-radius: 5px; }
.envp-sub { padding: 0 2px 6px; color: var(--envp-muted); font-size: 11px; }
.envp-foot { display: flex; justify-content: flex-end; padding: 8px 10px 10px; border-top: 1px solid var(--envp-line); }
.envp .envp-done { background: var(--envp-on); border-color: var(--envp-on); color: #fff; letter-spacing: .04em; }
.envp.drop { border-color: var(--envp-accent); }
`;
function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.append(s);
}

// ---------------------------------------------------------------------------------- helpers
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = String(v);
    else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role' || k === 'for' || k === 'list') e.setAttribute(k, String(v));
    else (e as unknown as Record<string, unknown>)[k] = v;
  }
  e.append(...kids);
  return e;
};

/** Short display form of a number (the input keeps the exact value until edited). */
export function fmt(n: number): string {
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 1000) return String(Math.round(n * 10) / 10);
  if (a < 0.001) return n.toExponential(2);
  return String(Number(n.toPrecision(4)));
}

/** Stored value -> the number the user sees and types (x100 for %). */
export const toShown = (v: number, unit?: Unit): number => (unit === 'pct' ? Number((v * 100).toPrecision(6)) : v);
export const fromShown = (v: number, unit?: Unit): number => (unit === 'pct' ? v / 100 : v);
const SUFFIX: Record<Unit, string> = { pct: '%', x: 'x', hr: 'hr', min: 'min', deg: '°', u: ' u', studs: ' st' };
/** The value text in a slider bar, as the game writes it: 30%, 1x, 9.6hr, 30min, 300°. */
export function shownText(v: number, unit?: Unit): string {
  const n = toShown(v, unit);
  const s = unit === 'pct' || unit === 'deg' ? String(Math.round(n * 10) / 10) : fmt(n);
  return unit ? s + SUFFIX[unit] : s;
}

const SLIDER_STEPS = 1000;
/** Slider position (0..SLIDER_STEPS) <-> value, linear or logarithmic. */
export function sliderToValue(pos: number, rg: Range): number {
  const t = pos / SLIDER_STEPS;
  if (rg.log) {
    const lo = Math.max(rg.min, 1e-6), v = lo * Math.pow(rg.max / lo, t);
    return t <= 0 && rg.min === 0 ? 0 : Number(v.toPrecision(3));
  }
  const v = rg.min + t * (rg.max - rg.min);
  return rg.step ? Math.round(v / rg.step) * rg.step : v;
}
export function valueToSlider(v: number, rg: Range): number {
  if (rg.log) {
    const lo = Math.max(rg.min, 1e-6);
    if (v <= lo) return 0;
    return Math.round((SLIDER_STEPS * Math.log(v / lo)) / Math.log(rg.max / lo));
  }
  return Math.round((SLIDER_STEPS * (v - rg.min)) / (rg.max - rg.min));
}
const clampPos = (p: number): number => Math.min(SLIDER_STEPS, Math.max(0, p));
const fixStep = (n: number, rg: Range | undefined): number => (rg?.step ? Number(n.toFixed(Math.max(0, -Math.floor(Math.log10(rg.step))))) : n);

/** "9.6" -> "09:36" */
const clock = (h: number): string => {
  const m = Math.round((((h % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Equal for the reset arrow: numbers within float32 noise, objects field by field. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    return ka.length === Object.keys(b as object).length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/** "BP_AmbienceType_Exterior_City" -> "Exterior City" (the option keeps the asset name). */
const prettyAsset = (s: string): string => s.replace(/^(BP_AmbienceType_|DA_)/, '').replace(/_/g, ' ');

function detectKind(env: Environment): PanelWorldKind | null {
  if (env.groups.universe && !env.groups.sky) return 'Space';
  if (env.groups.sky || env.groups.groundPlate || env.groups.water) return 'Plate';
  return null;
}

// ---------------------------------------------------------------------------------- panel
export function createEnvironmentPanel(opts: EnvironmentPanelOptions = {}): EnvironmentPanel {
  injectStyle(document);
  let kind: PanelWorldKind = opts.kind ?? (opts.env && detectKind(opts.env)) ?? 'Plate';
  const defaults: Record<PanelWorldKind, Environment> = {
    Plate: opts.defaults?.Plate ?? defaultEnvironment('Plate'),
    Space: opts.defaults?.Space ?? defaultEnvironment('Space'),
  };
  let env = completeEnvironment(opts.env ?? defaults[kind], kind);
  let fileName = 'environment.bp';
  let pending = 0;
  let destroyed = false;
  const openSet = new Set(opts.open ?? []);

  const root = el('section', { class: 'envp', 'aria-label': 'Environment settings' });
  const kindLabel = el('span', { class: 'envp-kind' });
  const pick = el('input', { type: 'file', accept: '.bp,application/json', hidden: true });
  const btnPresets = el('button', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Load, save or reset the environment preset' }, 'PRESETS ▾');
  const btnLoad = el('button', { type: 'button', role: 'menuitem', title: 'Load an environment preset (.bp)' }, 'Load .bp…');
  const btnSave = el('button', { type: 'button', role: 'menuitem', title: 'Download these settings as a .bp preset' }, 'Save .bp');
  const btnReset = el('button', { type: 'button', role: 'menuitem', title: 'Reset every setting to the default' }, 'Reset to default');
  const menu = el('div', { class: 'envp-menu', role: 'menu', hidden: true }, btnLoad, btnSave, el('hr'), btnReset);
  const status = el('p', { class: 'envp-status', role: 'status', 'aria-live': 'polite' });
  const body = el('div', { class: 'envp-body' });
  const head = el('div', { class: 'envp-head' }, el('h2', {}, 'ENVIRONMENT'), kindLabel, btnPresets, menu);
  root.append(head, status, body, pick);
  if (opts.onClose) {
    const close = el('button', { type: 'button', class: 'envp-close', 'aria-label': 'Close', title: 'Close' }, '✕');
    const done = el('button', { type: 'button', class: 'envp-done' }, '→ DONE');
    close.addEventListener('click', () => opts.onClose!());
    done.addEventListener('click', () => opts.onClose!());
    head.append(close);
    root.append(el('div', { class: 'envp-foot' }, done));
  }

  const say = (msg: string, err = false): void => { status.textContent = msg; status.classList.toggle('err', err); };
  const emit = (): void => {
    if (!opts.onChange || pending) return;
    pending = requestAnimationFrame(() => { pending = 0; if (!destroyed) opts.onChange!(environmentForKind(env, kind)); });
  };
  const getValue = (g: GroupName, key: string): unknown => (env.groups[g] as unknown as Record<string, unknown> | undefined)?.[key]
    ?? (GROUP_DEFAULTS[g] as unknown as Record<string, unknown>)[key];
  const defaultOf = (g: GroupName, key: string): unknown => {
    const d = (defaults[kind].groups[g] as unknown as Record<string, unknown> | undefined)?.[key];
    return d ?? (GROUP_DEFAULTS[g] as unknown as Record<string, unknown>)[key];
  };
  const setValue = (g: GroupName, key: string, v: unknown): void => {
    env = setEnvValue(env, g, key as keyof EnvGroups[GroupName], v as never);
    emit();
    refreshAll();
  };

  const showMenu = (on: boolean): void => { menu.hidden = !on; btnPresets.setAttribute('aria-expanded', String(on)); };
  btnPresets.addEventListener('click', () => showMenu(menu.hidden !== false));
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { showMenu(false); btnPresets.focus(); } });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !head.contains(e.target as Node)) showMenu(false); });

  // A value-in-bar slider: drag (or click) along the bar, arrow keys step, Enter / double-click / a
  // digit opens a number box for an exact value (any value: files may go past the slider's ends).
  function slider(row: Row, id: string, range: Range, onValue: (v: number) => void): { el: HTMLElement; show: (v: number) => void } {
    const bar = el('div', { class: 'envp-sl', role: 'slider', tabIndex: 0, id, 'aria-label': row.label,
      'aria-valuemin': String(toShown(range.min, row.unit)), 'aria-valuemax': String(toShown(range.max, row.unit)) });
    const fill = el('div', { class: 'envp-fill' }), val = el('span', { class: 'envp-val' }), grip = el('span', { class: 'envp-grip', 'aria-hidden': 'true' }, '↘');
    const edit = el('input', { type: 'number', class: 'envp-edit', step: 'any', hidden: true, 'aria-label': `${row.label} value` });
    bar.append(fill, val, grip);
    const wrap = el('div', { class: 'envp-ctl' }, bar, edit);
    let cur = 0;
    const show = (v: number): void => {
      cur = v;
      const t = clampPos(valueToSlider(v, range)) / SLIDER_STEPS;
      fill.style.width = `${(t * 100).toFixed(2)}%`;
      const text = shownText(v, row.unit) + (row.key === 'timeOfDay' ? `  (${clock(v)})` : '');
      val.textContent = text;
      bar.setAttribute('aria-valuenow', String(toShown(v, row.unit)));
      bar.setAttribute('aria-valuetext', text);
      bar.title = `${row.key} = ${v}`;
    };
    const atX = (x: number): number => {
      const b = bar.getBoundingClientRect(), t = Math.min(1, Math.max(0, (x - b.left) / Math.max(1, b.width)));
      return fixStep(sliderToValue(Math.round(t * SLIDER_STEPS), range), range);
    };
    let dragging = false;
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true; bar.setPointerCapture(e.pointerId); bar.focus();
      const v = atX(e.clientX); show(v); onValue(v);
    });
    bar.addEventListener('pointermove', (e) => { if (!dragging) return; const v = atX(e.clientX); if (v !== cur) { show(v); onValue(v); } });
    const stop = (): void => { dragging = false; };
    bar.addEventListener('pointerup', stop); bar.addEventListener('pointercancel', stop);
    const openEdit = (seed?: string): void => {
      edit.hidden = false;
      edit.value = seed ?? String(Number(toShown(cur, row.unit).toPrecision(6)));
      edit.focus();
      if (seed === undefined) edit.select();
    };
    const closeEdit = (commit: boolean): void => {
      if (edit.hidden) return;
      const n = Number(edit.value);
      edit.hidden = true;
      if (commit && edit.value.trim() !== '' && Number.isFinite(n)) { const v = fromShown(n, row.unit); show(v); onValue(v); }
      bar.focus();
    };
    bar.addEventListener('dblclick', () => openEdit());
    bar.addEventListener('keydown', (e) => {
      const span = range.max - range.min, step = range.log ? 0 : (range.step && range.step * 10 < span ? range.step : span / 100);
      const pos = valueToSlider(cur, range);
      let v: number | null = null;
      if (e.key === 'Enter') { e.preventDefault(); openEdit(); return; }
      if (/^[0-9.-]$/.test(e.key)) { e.preventDefault(); openEdit(e.key); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = step ? cur - step * (e.shiftKey ? 10 : 1) : sliderToValue(clampPos(pos - (e.shiftKey ? 100 : 10)), range);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = step ? cur + step * (e.shiftKey ? 10 : 1) : sliderToValue(clampPos(pos + (e.shiftKey ? 100 : 10)), range);
      else if (e.key === 'Home') v = range.min;
      else if (e.key === 'End') v = range.max;
      if (v === null) return;
      e.preventDefault();
      v = fixStep(Math.min(range.max, Math.max(range.min, v)), range);
      show(v); onValue(v);
    });
    edit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); closeEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEdit(false); }
    });
    edit.addEventListener('blur', () => closeEdit(true));
    return { el: wrap, show };
  }

  // Each row: builds its control, returns a refresh() that shows the current value.
  let refreshers: (() => void)[] = [];
  let uid = 0;
  function buildRow(row: Row): HTMLElement {
    const id = `envp-${++uid}`;
    const path = `${row.g}.${row.key}`;
    const def = (GROUP_DEFAULTS[row.g] as unknown as Record<string, unknown>)[row.key];
    const range = row.range ?? RANGES[path];
    const label = el('label', { for: id, title: `${row.hint ? row.hint + '. ' : ''}${row.key} (double-click to reset)` }, row.label);
    const reset = el('button', { type: 'button', class: 'envp-reset', title: 'Reset to default', 'aria-label': `Reset ${row.label}`, hidden: true }, '↶');
    let ctl: HTMLElement = el('div', { class: 'envp-ctl' });
    let show: () => void = () => {};
    switch (kindOf(def)) {
      case 'number': {
        const s = slider(row, id, range ?? { min: 0, max: Math.max(1, (def as number) * 2) }, (v) => setValue(row.g, row.key, v));
        ctl = s.el;
        show = () => s.show(getValue(row.g, row.key) as number);
        break;
      }
      case 'bool': {
        const sw = el('button', { type: 'button', role: 'switch', class: 'envp-sw', id, 'aria-checked': 'false', 'aria-label': row.label });
        sw.addEventListener('click', () => setValue(row.g, row.key, !(getValue(row.g, row.key) as boolean)));
        ctl.append(sw);
        show = () => { const on = getValue(row.g, row.key) as boolean; sw.setAttribute('aria-checked', String(on)); sw.textContent = on ? 'I' : 'O'; };
        break;
      }
      case 'string': {
        const known = KNOWN_STRINGS[path] ?? [];
        const sel = el('select', { id, 'aria-label': row.label });
        const fill = (cur: string): void => {
          const list = known.includes(cur) ? known : [...known, cur];
          sel.replaceChildren(...list.map((s) => el('option', { value: s, title: s }, prettyAsset(s))));
          sel.value = cur;
        };
        sel.addEventListener('change', () => setValue(row.g, row.key, sel.value || String(def)));
        ctl.append(sel);
        show = () => fill(getValue(row.g, row.key) as string);
        break;
      }
      case 'color': {
        const pickc = el('input', { type: 'color', id, 'aria-label': row.label });
        pickc.addEventListener('input', () => {
          const old = getValue(row.g, row.key) as LinearColor;
          setValue(row.g, row.key, hexToLinear(pickc.value, old.a));
        });
        ctl.append(pickc);
        show = () => {
          const c = getValue(row.g, row.key) as LinearColor;
          pickc.value = linearToHex(c);
          pickc.title = `${pickc.value} (linear ${fmt(c.r)}, ${fmt(c.g)}, ${fmt(c.b)})`;
        };
        break;
      }
      case 'vector':
      case 'rotator': {
        const vec = kindOf(def) === 'vector', fields = vec ? ['x', 'y', 'z'] : ['pitch', 'yaw', 'roll'];
        const names = vec && row.g === 'water' ? ['R', 'G', 'B'] : fields;
        ctl.classList.add('envp-vec');
        const inputs = fields.map((f, i) => {
          const n = el('input', { type: 'number', step: 'any', class: vec ? `c${i}` : '', 'aria-label': `${row.label} ${names[i]}`, title: names[i], ...(i === 0 ? { id } : {}) });
          n.addEventListener('change', () => {
            const v = Number(n.value);
            if (n.value.trim() === '' || !Number.isFinite(v)) { show(); return; }
            const cur = { ...(getValue(row.g, row.key) as Vec3 | Rotator) } as Record<string, number>;
            cur[f] = v;
            setValue(row.g, row.key, cur);
          });
          return n;
        });
        ctl.append(...inputs);
        show = () => {
          const cur = getValue(row.g, row.key) as unknown as Record<string, number>;
          inputs.forEach((n, i) => { if (document.activeElement !== n) n.value = fmt(cur[fields[i]!]!); n.title = `${names[i]}: ${cur[fields[i]!]}`; });
        };
        break;
      }
      default:
        ctl.append(String(def));
    }
    const line = el('div', { class: 'envp-row', 'data-key': row.key }, label, reset, ctl);
    const resetIt = (): void => { setValue(row.g, row.key, defaultOf(row.g, row.key)); say(`${row.label} reset`); };
    label.addEventListener('dblclick', resetIt);
    reset.addEventListener('click', resetIt);
    const off = DISABLED[path];
    refreshers.push(() => {
      show();
      reset.hidden = same(getValue(row.g, row.key), defaultOf(row.g, row.key));
      if (off) {
        const dis = off(getValue);
        line.classList.toggle('envp-dis', dis);
        for (const c of ctl.querySelectorAll<HTMLElement>('input, select, button, [role=slider]')) {
          if (c instanceof HTMLInputElement || c instanceof HTMLSelectElement || c instanceof HTMLButtonElement) c.disabled = dis;
          else { c.setAttribute('aria-disabled', String(dis)); c.tabIndex = dis ? -1 : 0; }
        }
      }
    });
    return line;
  }

  function build(): void {
    refreshers = [];
    body.replaceChildren();
    kindLabel.textContent = kind === 'Space' ? 'Space world' : 'Plate world';
    for (const s of SECTIONS) {
      if (!s.kinds.includes(kind)) continue;
      const rows = s.rows.filter((row) => kind === 'Plate' || row.g !== 'sky');
      if (!rows.length) continue;
      const det = el('details', { open: openSet.has(s.id) });
      det.dataset.section = s.id;
      det.addEventListener('toggle', () => { if (det.open) openSet.add(s.id); else openSet.delete(s.id); });
      det.append(el('summary', {}, s.title));
      if (s.note) det.append(el('div', { class: 'envp-sub' }, s.note));
      for (const row of rows) det.append(buildRow(row));
      body.append(det);
    }
    refreshAll();
  }
  const refreshAll = (): void => { for (const f of refreshers) f(); };

  function set(next: Environment, k?: PanelWorldKind): void {
    const nk = k ?? kind;
    env = completeEnvironment(next, nk);
    if (nk !== kind) { kind = nk; build(); } else refreshAll();
    emit();
  }
  function loadText(text: string, name = 'environment.bp'): void {
    const parsed = parseEnvironment(text);
    const k = detectKind(parsed);
    if (!k) throw new EnvironmentError('no environment groups in this file');
    fileName = /\.bp$/i.test(name) ? name : `${name}.bp`;
    set(parsed, k);
    const notes = [Object.keys(parsed.legacy).length && 'older preset, converted', Object.keys(parsed.extras).length && 'unknown settings kept'].filter(Boolean);
    say(`Loaded ${fileName}${notes.length ? ` (${notes.join(', ')})` : ''}`);
    opts.onLoad?.(environmentForKind(parsed, k), k, fileName);
  }
  async function loadFile(f: File): Promise<void> {
    try { loadText(await f.text(), f.name); } catch (e) { say(`Couldn't read ${f.name}: ${(e as Error).message}`, true); }
  }
  const toText = (): string => serialiseEnvironment(environmentForKind(env, kind));

  btnLoad.addEventListener('click', () => { showMenu(false); pick.click(); });
  pick.addEventListener('change', () => { const f = pick.files?.[0]; if (f) void loadFile(f); pick.value = ''; });
  btnSave.addEventListener('click', () => {
    showMenu(false);
    const url = URL.createObjectURL(new Blob([toText()], { type: 'application/json' }));
    const a = el('a', { href: url, download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`Saved ${fileName}`);
  });
  btnReset.addEventListener('click', () => { showMenu(false); set(defaults[kind]); say('Reset to default'); });
  // Drop a .bp onto the panel. Stops propagation so the app's own drop handler doesn't also get it.
  root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); root.classList.add('drop'); } });
  root.addEventListener('dragleave', () => root.classList.remove('drop'));
  root.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => /\.(bp|json)$/i.test(x.name));
    root.classList.remove('drop');
    if (!f) return;
    e.preventDefault(); e.stopPropagation();
    void loadFile(f);
  });

  build();

  return {
    el: root,
    get: () => environmentForKind(env, kind),
    set,
    setKind: (k) => { if (k !== kind) set(env, k); },
    get kind() { return kind; },
    setDefault: (d, k) => { defaults[k ?? detectKind(d) ?? kind] = d; refreshAll(); },
    loadText,
    toText,
    destroy: () => { destroyed = true; if (pending) cancelAnimationFrame(pending); root.remove(); },
  };
}
