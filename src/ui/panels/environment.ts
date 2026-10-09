// Environment settings panel: every setting of an environment preset, grouped like the game's
// menu (Sky, Sun & Moon, Clouds & Weather, Fog, Water, Ground Plate, Ambience; Universe for Space
// worlds), with live preview through onChange, .bp load / save and reset to default.
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
  /** Starting environment (default: the placeholder default for `kind`). */
  env?: Environment;
  kind?: PanelWorldKind;
  /** What "Reset to default" restores, per kind (default: the built-in placeholder). */
  defaults?: Partial<Record<PanelWorldKind, Environment>>;
  /** Called (at most once per animation frame) with a fresh copy after every edit, load or reset. */
  onChange?: (env: Environment) => void;
  /** Called when the panel loads a .bp, with its kind as detected from its groups. */
  onLoad?: (env: Environment, kind: PanelWorldKind, fileName: string) => void;
  /** Sections open at start (by id); default just the first one. */
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
interface Row { g: GroupName; key: string; label: string; unit?: string; hint?: string }
interface Section { id: string; title: string; kinds: PanelWorldKind[]; rows: Row[]; note?: string }

const r = (g: GroupName, key: string, label: string, unit?: string, hint?: string): Row => ({ g, key, label, unit, hint });

export const SECTIONS: readonly Section[] = [
  { id: 'sky', title: 'Sky', kinds: ['Plate'], rows: [
    r('sky', 'timeOfDay', 'Time of day', 'h'),
    r('sky', 'animateTimeOfDay', 'Animate time of day'),
    r('sky', 'dayLength', 'Day length', 'min'),
    r('sky', 'nightLength', 'Night length', 'min'),
    r('sky', 'skyIntensity', 'Sky intensity'),
    r('sky', 'skyColor', 'Sky colour'),
    r('sky', 'starsIntensity', 'Stars intensity'),
    r('sky', 'starsColor', 'Stars colour'),
    r('sky', 'auroraIntensity', 'Aurora intensity'),
  ] },
  { id: 'sun', title: 'Sun & Moon', kinds: ['Plate'], rows: [
    r('sky', 'sunAngle', 'Sun angle', '°'),
    r('sky', 'sunScale', 'Sun scale'),
    r('sky', 'sunHorizonScaleMultiplier', 'Sun horizon scale'),
    r('sky', 'sunlightColor', 'Sunlight colour'),
    r('sky', 'moonPhase', 'Moon phase', 'd', 'Days into the lunar cycle (0 to 29.5)'),
    r('sky', 'moonScale', 'Moon scale'),
    r('sky', 'moonlightIntensity', 'Moonlight intensity'),
    r('sky', 'moonlightColor', 'Moonlight colour'),
  ] },
  { id: 'weather', title: 'Clouds & Weather', kinds: ['Plate'], rows: [
    r('sky', 'cloudCoverage', 'Cloud coverage'),
    r('sky', 'cloudSpeedMultiplier', 'Cloud speed'),
    r('sky', 'rain', 'Rain'),
    r('sky', 'snow', 'Snow'),
    r('sky', 'dust', 'Dust'),
    r('sky', 'thunder', 'Thunder'),
    r('sky', 'bCloseLightning', 'Close lightning'),
    r('sky', 'wind', 'Wind'),
    r('sky', 'windDirection', 'Wind direction', '°'),
  ] },
  { id: 'fog', title: 'Fog', kinds: ['Plate'], rows: [
    r('sky', 'clearFogDensity', 'Clear fog density'),
    r('sky', 'cloudyFogDensity', 'Cloudy fog density'),
    r('sky', 'clearFogHeightFalloff', 'Clear fog falloff'),
    r('sky', 'cloudyFogHeightFalloff', 'Cloudy fog falloff'),
    r('sky', 'fogColor', 'Fog colour'),
  ] },
  { id: 'water', title: 'Water', kinds: ['Plate'], rows: [
    r('water', 'waterHeight', 'Water height', 'u', 'World units (10 per stud). 0 = no water'),
    r('water', 'waterAbsorption', 'Absorption'),
    r('water', 'waterScattering', 'Scattering'),
    r('water', 'waterFogIntensity', 'Fog intensity'),
    r('water', 'waterFogAmbientColor', 'Fog ambient colour'),
    r('water', 'waterFogAmbientScale', 'Fog ambient scale'),
    r('water', 'waterFogScatteringColor', 'Fog scattering colour'),
    r('water', 'waterFogScatteringScale', 'Fog scattering scale'),
  ] },
  { id: 'ground', title: 'Ground Plate', kinds: ['Plate'], rows: [
    r('groundPlate', 'isVisible', 'Visible'),
    r('groundPlate', 'groundColor', 'Colour'),
    r('groundPlate', 'groundAccentColor', 'Accent colour'),
    r('groundPlate', 'variance', 'Variance'),
    r('groundPlate', 'varianceBrickSize', 'Variance size', 'studs'),
    r('groundPlate', 'bUseStudTexture', 'Stud texture'),
  ] },
  { id: 'universe', title: 'Universe', kinds: ['Space'], rows: [
    r('universe', 'universeRotation', 'Rotation', '°'),
    r('universe', 'universeLightColor', 'Light colour'),
    r('universe', 'universeLightIntensity', 'Light intensity'),
    r('universe', 'universeAmbientColor', 'Ambient colour'),
    r('universe', 'universeAmbientIntensity', 'Ambient intensity'),
    r('universe', 'universeGravityScale', 'Gravity scale'),
    r('universe', 'bUniverseFloorEnabled', 'Floor'),
    r('universe', 'nebulaTexture', 'Nebula'),
    r('universe', 'nebulaColor', 'Nebula colour'),
    r('universe', 'nebulaRedBlueSwap', 'Nebula red/blue swap'),
    r('universe', 'nebulaSaturation', 'Nebula saturation'),
    r('universe', 'nebulaPower', 'Nebula power'),
    r('universe', 'nebulaBrightness', 'Nebula brightness'),
    r('universe', 'nearStarsTexture', 'Near stars'),
    r('universe', 'nearStarsPower', 'Near stars power'),
    r('universe', 'nearStarsBrightness', 'Near stars brightness'),
    r('universe', 'farStarsTexture', 'Far stars'),
    r('universe', 'farStarsPower', 'Far stars power'),
    r('universe', 'farStarsBrightness', 'Far stars brightness'),
  ] },
  { id: 'ambience', title: 'Ambience', kinds: ['Plate', 'Space'], rows: [
    r('ambience', 'selectedAmbienceType', 'Ambience'),
    r('ambience', 'ambienceVolume', 'Ambience volume'),
    r('ambience', 'reverbEffect', 'Reverb'),
    r('sky', 'rainVolume', 'Rain volume'),
    r('sky', 'closeThunderVolume', 'Close thunder volume'),
    r('sky', 'distantThunderVolume', 'Distant thunder volume'),
    r('sky', 'windVolume', 'Wind volume'),
  ] },
];

// ---------------------------------------------------------------------------------- styles
const STYLE_ID = 'envp-style';
const CSS = `
.envp { --envp-bg: var(--panel-bg, rgba(29,30,33,.94)); --envp-fg: var(--fg, #eee); --envp-muted: var(--muted, #9a9ca3);
  --envp-accent: var(--accent, #e8590c); --envp-line: var(--line, rgba(255,255,255,.14)); --envp-field: var(--bg, #2b2c30);
  box-sizing: border-box; width: 100%; max-width: 360px; max-height: 100%; overflow: auto; padding: 10px; border-radius: 10px;
  background: var(--envp-bg); color: var(--envp-fg); border: 1px solid var(--envp-line); box-shadow: 0 6px 24px rgba(0,0,0,.35);
  font: 12px/1.35 system-ui, sans-serif; }
.envp *, .envp *::before, .envp *::after { box-sizing: border-box; }
.envp-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.envp-head h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 700; }
.envp-kind { font-size: 11px; color: var(--envp-muted); }
.envp-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.envp button { padding: 5px 9px; border: 1px solid var(--envp-line); border-radius: 7px; background: var(--envp-field); color: var(--envp-fg);
  font: 600 12px/1.2 system-ui, sans-serif; cursor: pointer; }
.envp button:hover { border-color: var(--envp-accent); }
.envp button:focus-visible, .envp input:focus-visible, .envp summary:focus-visible { outline: 2px solid var(--envp-accent); outline-offset: 1px; }
.envp-status { min-height: 1.35em; margin: 0 0 6px; color: var(--envp-muted); font-size: 11px; }
.envp-status.err { color: #ff8a65; }
.envp details { border-top: 1px solid var(--envp-line); }
.envp summary { padding: 7px 2px; font-weight: 700; cursor: pointer; user-select: none; }
.envp-row { display: grid; grid-template-columns: minmax(0, 9.5em) minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 3px 2px; }
.envp-row > label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--envp-muted); cursor: default; }
.envp-row > label:hover { color: var(--envp-fg); }
.envp-row .envp-ctl { display: flex; align-items: center; gap: 6px; min-width: 0; }
.envp-row input[type=range] { flex: 1; min-width: 0; accent-color: var(--envp-accent); }
.envp-row input[type=number], .envp-row input[type=text] { width: 5.6em; min-width: 0; padding: 3px 5px; border: 1px solid var(--envp-line); border-radius: 6px;
  background: var(--envp-field); color: var(--envp-fg); font: 12px/1.2 system-ui, sans-serif; font-variant-numeric: tabular-nums; }
.envp-row input[type=text] { width: 100%; }
.envp-row .envp-vec input[type=number] { width: 0; flex: 1; }
.envp-row input[type=color] { width: 34px; height: 22px; padding: 0; border: 1px solid var(--envp-line); border-radius: 5px; background: none; cursor: pointer; }
.envp-row input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--envp-accent); }
.envp-hex { color: var(--envp-muted); font-variant-numeric: tabular-nums; }
.envp-unit { min-width: 2.2em; color: var(--envp-muted); font-size: 11px; }
.envp-sub { padding: 0 2px 6px; color: var(--envp-muted); font-size: 11px; }
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
    else if (k.startsWith('aria-') || k === 'role' || k === 'for' || k === 'list') e.setAttribute(k, String(v));
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
  const openSet = new Set(opts.open ?? [SECTIONS[0]!.id]);

  const root = el('section', { class: 'envp', 'aria-label': 'Environment settings' });
  const kindLabel = el('span', { class: 'envp-kind' });
  const pick = el('input', { type: 'file', accept: '.bp,application/json', hidden: true });
  const btnLoad = el('button', { type: 'button', title: 'Load an environment preset (.bp)' }, 'Load .bp');
  const btnSave = el('button', { type: 'button', title: 'Download these settings as a .bp preset' }, 'Save .bp');
  const btnReset = el('button', { type: 'button', title: 'Reset every setting to the default' }, 'Reset to default');
  const status = el('p', { class: 'envp-status', role: 'status', 'aria-live': 'polite' });
  const body = el('div');
  root.append(el('div', { class: 'envp-head' }, el('h2', {}, 'Environment'), kindLabel), el('div', { class: 'envp-bar' }, btnLoad, btnSave, btnReset), status, body, pick);

  const say = (msg: string, err = false): void => { status.textContent = msg; status.classList.toggle('err', err); };
  const emit = (): void => {
    if (!opts.onChange || pending) return;
    pending = requestAnimationFrame(() => { pending = 0; if (!destroyed) opts.onChange!(environmentForKind(env, kind)); });
  };
  const getValue = (g: GroupName, key: string): unknown => (env.groups[g] as unknown as Record<string, unknown> | undefined)?.[key]
    ?? (GROUP_DEFAULTS[g] as unknown as Record<string, unknown>)[key];
  const setValue = (g: GroupName, key: string, v: unknown): void => {
    env = setEnvValue(env, g, key as keyof EnvGroups[GroupName], v as never);
    emit();
  };

  // Each row: builds its control, returns a refresh() that shows the current value.
  let refreshers: (() => void)[] = [];
  let uid = 0;
  function buildRow(row: Row): HTMLElement {
    const id = `envp-${++uid}`;
    const path = `${row.g}.${row.key}`;
    const def = (GROUP_DEFAULTS[row.g] as unknown as Record<string, unknown>)[row.key];
    const rg = RANGES[path];
    const label = el('label', { for: id, title: `${row.hint ? row.hint + '. ' : ''}${row.key} (double-click to reset)` }, row.label);
    const ctl = el('div', { class: 'envp-ctl' });
    const unit = el('span', { class: 'envp-unit' }, row.unit ?? '');
    let refresh: () => void = () => {};
    switch (kindOf(def)) {
      case 'number': {
        const range = rg ?? { min: 0, max: Math.max(1, (def as number) * 2) };
        const slider = el('input', { type: 'range', min: '0', max: String(SLIDER_STEPS), step: '1', 'aria-label': row.label, tabIndex: -1 });
        const num = el('input', { type: 'number', id, step: 'any' });
        slider.addEventListener('input', () => {
          const v = fixStep(sliderToValue(Number(slider.value), range), range);
          num.value = fmt(v);
          setValue(row.g, row.key, v);
          if (row.key === 'timeOfDay') unit.textContent = clock(v);
        });
        num.addEventListener('change', () => {
          const v = Number(num.value);
          if (num.value.trim() === '' || !Number.isFinite(v)) { refresh(); return; }
          setValue(row.g, row.key, v);
          refresh();
        });
        ctl.append(slider, num);
        refresh = () => {
          const v = getValue(row.g, row.key) as number;
          slider.value = String(clampPos(valueToSlider(v, range)));
          if (document.activeElement !== num) num.value = fmt(v);
          num.title = String(v);
          if (row.key === 'timeOfDay') unit.textContent = clock(v);
        };
        break;
      }
      case 'bool': {
        const cb = el('input', { type: 'checkbox', id });
        cb.addEventListener('change', () => setValue(row.g, row.key, cb.checked));
        ctl.append(cb);
        refresh = () => { cb.checked = getValue(row.g, row.key) as boolean; };
        break;
      }
      case 'string': {
        const known = KNOWN_STRINGS[path] ?? [];
        const listId = `${id}-list`;
        const input = el('input', { type: 'text', id, list: listId, spellcheck: false, autocomplete: 'off' });
        const dl = el('datalist', { id: listId }, ...known.map((s) => el('option', { value: s })));
        input.addEventListener('change', () => setValue(row.g, row.key, input.value.trim() || String(def)));
        ctl.append(input, dl);
        refresh = () => { input.value = getValue(row.g, row.key) as string; };
        break;
      }
      case 'color': {
        const pickc = el('input', { type: 'color', id, 'aria-label': row.label });
        const hex = el('span', { class: 'envp-hex' });
        pickc.addEventListener('input', () => {
          const old = getValue(row.g, row.key) as LinearColor;
          setValue(row.g, row.key, hexToLinear(pickc.value, old.a));
          hex.textContent = pickc.value;
        });
        ctl.append(pickc, hex);
        refresh = () => {
          const c = getValue(row.g, row.key) as LinearColor;
          pickc.value = linearToHex(c);
          hex.textContent = pickc.value;
          pickc.title = `linear ${fmt(c.r)}, ${fmt(c.g)}, ${fmt(c.b)}`;
        };
        break;
      }
      case 'vector':
      case 'rotator': {
        const fields = kindOf(def) === 'vector' ? ['x', 'y', 'z'] : ['pitch', 'yaw', 'roll'];
        const wrap = el('div', { class: 'envp-ctl envp-vec' });
        const inputs = fields.map((f, i) => {
          const n = el('input', { type: 'number', step: 'any', 'aria-label': `${row.label} ${f}`, title: f, ...(i === 0 ? { id } : {}) });
          n.addEventListener('change', () => {
            const v = Number(n.value);
            if (n.value.trim() === '' || !Number.isFinite(v)) { refresh(); return; }
            const cur = { ...(getValue(row.g, row.key) as Vec3 | Rotator) } as Record<string, number>;
            cur[f] = v;
            setValue(row.g, row.key, cur);
            refresh();
          });
          return n;
        });
        wrap.append(...inputs);
        ctl.append(wrap);
        refresh = () => {
          const cur = getValue(row.g, row.key) as unknown as Record<string, number>;
          inputs.forEach((n, i) => { if (document.activeElement !== n) n.value = fmt(cur[fields[i]!]!); n.title = `${fields[i]}: ${cur[fields[i]!]}`; });
        };
        break;
      }
      default:
        ctl.append(String(def));
    }
    label.addEventListener('dblclick', () => { setValue(row.g, row.key, def); refresh(); say(`${row.label} reset`); });
    refreshers.push(refresh);
    return el('div', { class: 'envp-row' }, label, ctl, unit);
  }

  function build(): void {
    refreshers = [];
    body.replaceChildren();
    kindLabel.textContent = kind === 'Space' ? 'Space world' : 'Plate world';
    for (const s of SECTIONS) {
      if (!s.kinds.includes(kind)) continue;
      const rows = s.rows.filter((row) => kind === 'Plate' || row.g !== 'sky');
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

  btnLoad.addEventListener('click', () => pick.click());
  pick.addEventListener('change', () => { const f = pick.files?.[0]; if (f) void loadFile(f); pick.value = ''; });
  btnSave.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([toText()], { type: 'application/json' }));
    const a = el('a', { href: url, download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`Saved ${fileName}`);
  });
  btnReset.addEventListener('click', () => { set(defaults[kind]); say('Reset to default'); });
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
    setDefault: (d, k) => { defaults[k ?? detectKind(d) ?? kind] = d; },
    loadText,
    toText,
    destroy: () => { destroyed = true; if (pending) cancelAnimationFrame(pending); root.remove(); },
  };
}
