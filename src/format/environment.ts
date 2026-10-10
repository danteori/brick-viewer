// Environment presets (.bp, `type: "Environment"`) and a world's `World/0/Environment.bp`, which
// use the same JSON: {formatVersion, presetVersion, type, data: {groups: {...}}}.
//
//   const env = parseEnvironment(text);          // any generation -> the modern shape
//   const text2 = serialiseEnvironment(env);     // the game's own layout (tabs, CRLF, %.17g)
//
// Normalising:
// - Group names match case-insensitively (older files use `Sky`, `GroundPlate`, ...); the result
//   always uses the modern lower-camel names.
// - Every known group that is present is filled out with defaults for keys it lacks, and the keys
//   that were filled are remembered (`absent`), so a modern file round-trips byte for byte.
// - Older keys are mapped onto their modern equivalents (LEGACY_SKY below). The raw old values are
//   kept in `legacy` and are not written back.
// - Keys and groups this module doesn't know are kept in `extras` and written back after the
//   known keys, so nothing a newer game version adds is lost.
// - Groups that are missing stay missing; `completeEnvironment` adds them for a world kind.
//
// Colours are UE FLinearColor (linear floats). DOM-free.

import type { FileMap } from './brz.ts';

export interface LinearColor { r: number; g: number; b: number; a: number }
export interface Vec3 { x: number; y: number; z: number }
export interface Rotator { pitch: number; yaw: number; roll: number }
export type EnvValue = number | boolean | string | LinearColor | Vec3 | Rotator;

export interface SkyGroup {
  timeOfDay: number;
  animateTimeOfDay: boolean;
  dayLength: number;
  nightLength: number;
  sunAngle: number;
  sunScale: number;
  sunHorizonScaleMultiplier: number;
  sunlightColor: LinearColor;
  skyIntensity: number;
  skyColor: LinearColor;
  moonPhase: number;
  moonScale: number;
  moonlightIntensity: number;
  moonlightColor: LinearColor;
  starsIntensity: number;
  starsColor: LinearColor;
  auroraIntensity: number;
  cloudCoverage: number;
  rain: number;
  snow: number;
  dust: number;
  thunder: number;
  wind: number;
  windDirection: number;
  cloudSpeedMultiplier: number;
  bCloseLightning: boolean;
  rainVolume: number;
  closeThunderVolume: number;
  distantThunderVolume: number;
  windVolume: number;
  clearFogDensity: number;
  cloudyFogDensity: number;
  clearFogHeightFalloff: number;
  cloudyFogHeightFalloff: number;
  fogColor: LinearColor;
}

export interface GroundPlateGroup {
  variance: number;
  varianceBrickSize: number;
  groundColor: LinearColor;
  groundAccentColor: LinearColor;
  isVisible: boolean;
  bUseStudTexture: boolean;
}

export interface WaterGroup {
  waterHeight: number;
  waterAbsorption: Vec3;
  waterScattering: Vec3;
  waterFogIntensity: number;
  waterFogAmbientColor: LinearColor;
  waterFogAmbientScale: number;
  waterFogScatteringColor: LinearColor;
  waterFogScatteringScale: number;
}

export interface AmbienceGroup {
  selectedAmbienceType: string;
  ambienceVolume: number;
  reverbEffect: string;
}

export interface UniverseGroup {
  universeRotation: Rotator;
  universeLightColor: LinearColor;
  universeLightIntensity: number;
  universeAmbientColor: LinearColor;
  universeAmbientIntensity: number;
  universeGravityScale: number;
  bUniverseFloorEnabled: boolean;
  nebulaTexture: string;
  nebulaColor: LinearColor;
  nebulaRedBlueSwap: number;
  nebulaSaturation: number;
  nebulaPower: number;
  nebulaBrightness: number;
  nearStarsTexture: string;
  nearStarsPower: number;
  nearStarsBrightness: number;
  farStarsTexture: string;
  farStarsPower: number;
  farStarsBrightness: number;
}

export interface EnvGroups {
  sky: SkyGroup;
  groundPlate: GroundPlateGroup;
  water: WaterGroup;
  ambience: AmbienceGroup;
  universe: UniverseGroup;
}
export type GroupName = keyof EnvGroups;
/** The order groups are written in: Plate worlds use the first four, Space worlds universe + ambience. */
export const GROUP_ORDER: readonly GroupName[] = ['sky', 'groundPlate', 'water', 'universe', 'ambience'];

/** `Meta/World.json` `environment`: the base map. Plate and Space carry an Environment.bp. */
export type WorldKind = 'Plate' | 'Space' | 'Studio' | (string & {});
export const KIND_GROUPS: Readonly<Record<'Plate' | 'Space', readonly GroupName[]>> = {
  Plate: ['sky', 'groundPlate', 'water', 'ambience'],
  Space: ['universe', 'ambience'],
};

export interface Environment {
  formatVersion: string;
  presetVersion: string;
  type: string;
  groups: Partial<EnvGroups>;
  /** Keys that were missing from the source and filled with defaults, per group. */
  absent: Partial<Record<GroupName, string[]>>;
  /** Unknown keys of known groups. Written back after the known keys. */
  extras: Partial<Record<GroupName, Record<string, unknown>>>;
  /** Unknown (or duplicate) groups, by their source name, verbatim. Written back after the known groups. */
  extraGroups: Record<string, unknown>;
  /** Line ending of the source text (preset files use CRLF; some world files use LF). */
  newline?: '\r\n' | '\n';
  /** Raw values of older keys that were mapped onto modern keys. Not written back. */
  legacy: Partial<Record<GroupName, Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------------- defaults
// The game's built-in default environment (Plate worlds), as it writes it: float32 values, hence
// f(). cloudSpeedMultiplier isn't in the game's default file; 1 is assumed. The Space (universe)
// defaults are this viewer's own neutral values (no stock universe preset is known). Key order is
// the order the game writes.
const f = Math.fround;
const col = (r: number, g: number, b: number, a = 1): LinearColor => ({ r: f(r), g: f(g), b: f(b), a: f(a) });

export const DEFAULT_SKY: Readonly<SkyGroup> = {
  timeOfDay: f(9.6),
  animateTimeOfDay: false,
  dayLength: 30,
  nightLength: 15,
  sunAngle: 300,
  sunScale: f(0.85),
  sunHorizonScaleMultiplier: 1,
  sunlightColor: col(1, 0.806952, 0.768151),
  skyIntensity: 1,
  skyColor: col(0, 0.171441, 1),
  moonPhase: f(0.4),
  moonScale: f(0.7),
  moonlightIntensity: f(0.4),
  moonlightColor: col(0.517647, 0.6, 0.866667),
  starsIntensity: 10,
  starsColor: col(0.74902, 0.85098, 1),
  auroraIntensity: 0,
  cloudCoverage: 0.25,
  rain: 0,
  snow: 0,
  dust: 0,
  thunder: 0,
  wind: f(0.2),
  windDirection: 1,
  cloudSpeedMultiplier: 1,
  bCloseLightning: true,
  rainVolume: f(0.65),
  closeThunderVolume: 1,
  distantThunderVolume: f(0.4),
  windVolume: f(0.65),
  clearFogDensity: f(0.01),
  cloudyFogDensity: 0.25,
  clearFogHeightFalloff: f(0.09),
  cloudyFogHeightFalloff: f(0.04),
  fogColor: col(0.502887, 0.679543, 1),
};

export const DEFAULT_GROUND_PLATE: Readonly<GroundPlateGroup> = {
  variance: 0,
  varianceBrickSize: 1,
  groundColor: col(0.042311, 0.212231, 0.042311),
  groundAccentColor: col(0, 0, 0),
  isVisible: true,
  bUseStudTexture: true,
};

export const DEFAULT_WATER: Readonly<WaterGroup> = {
  waterHeight: 0,
  waterAbsorption: { x: f(0.0065), y: f(0.000708), z: f(0.000196) },
  waterScattering: { x: f(7e-6), y: f(1.8e-5), z: f(3.1e-5) },
  waterFogIntensity: f(0.0002),
  waterFogAmbientColor: col(0.1, 0.409524, 0.75),
  waterFogAmbientScale: 0.25,
  waterFogScatteringColor: col(0.5, 1, 0.75),
  waterFogScatteringScale: 3,
};

export const DEFAULT_AMBIENCE: Readonly<AmbienceGroup> = {
  selectedAmbienceType: 'None',
  ambienceVolume: 1,
  reverbEffect: 'Default',
};

export const DEFAULT_UNIVERSE: Readonly<UniverseGroup> = {
  universeRotation: { pitch: 0, yaw: 0, roll: 0 },
  universeLightColor: col(1, 1, 1),
  universeLightIntensity: 1,
  universeAmbientColor: col(1, 1, 1),
  universeAmbientIntensity: 1,
  universeGravityScale: 1,
  bUniverseFloorEnabled: true,
  nebulaTexture: 'None',
  nebulaColor: col(1, 1, 1),
  nebulaRedBlueSwap: 0,
  nebulaSaturation: 1,
  nebulaPower: 1,
  nebulaBrightness: 1,
  nearStarsTexture: 'None',
  nearStarsPower: 1,
  nearStarsBrightness: 1,
  farStarsTexture: 'None',
  farStarsPower: 1,
  farStarsBrightness: 1,
};

export const GROUP_DEFAULTS: { readonly [G in GroupName]: Readonly<EnvGroups[G]> } = {
  sky: DEFAULT_SKY,
  groundPlate: DEFAULT_GROUND_PLATE,
  water: DEFAULT_WATER,
  ambience: DEFAULT_AMBIENCE,
  universe: DEFAULT_UNIVERSE,
};

/** Value ranges seen in real files (or the obvious physical range). Editors may go beyond them. */
export interface Range { min: number; max: number; step?: number; log?: boolean }
export const RANGES: Readonly<Record<string, Range>> = {
  'sky.timeOfDay': { min: 0, max: 24, step: 0.01 },
  'sky.dayLength': { min: 1, max: 60, step: 0.5 },
  'sky.nightLength': { min: 0.5, max: 60, step: 0.5 },
  'sky.sunAngle': { min: 0, max: 360, step: 1 },
  'sky.sunScale': { min: 0, max: 5, step: 0.01 },
  'sky.sunHorizonScaleMultiplier': { min: 0, max: 15, step: 0.01 },
  'sky.skyIntensity': { min: 0, max: 10, step: 0.01 },
  'sky.moonPhase': { min: 0, max: 29.53, step: 0.01 },
  'sky.moonScale': { min: 0, max: 5, step: 0.01 },
  'sky.moonlightIntensity': { min: 0, max: 2, step: 0.01 },
  'sky.starsIntensity': { min: 0, max: 15, step: 0.1 },
  'sky.auroraIntensity': { min: 0, max: 1, step: 0.01 },
  'sky.cloudCoverage': { min: 0, max: 1, step: 0.01 },
  'sky.rain': { min: 0, max: 1, step: 0.01 },
  'sky.snow': { min: 0, max: 1, step: 0.01 },
  'sky.dust': { min: 0, max: 1, step: 0.01 },
  'sky.thunder': { min: 0, max: 1, step: 0.01 },
  'sky.wind': { min: 0, max: 1, step: 0.01 },
  'sky.windDirection': { min: 0, max: 360, step: 1 },
  'sky.cloudSpeedMultiplier': { min: 0, max: 15, step: 0.1 },
  'sky.rainVolume': { min: 0, max: 1, step: 0.01 },
  'sky.closeThunderVolume': { min: 0, max: 1, step: 0.01 },
  'sky.distantThunderVolume': { min: 0, max: 1, step: 0.01 },
  'sky.windVolume': { min: 0, max: 1, step: 0.01 },
  'sky.clearFogDensity': { min: 0.001, max: 6, log: true },
  'sky.cloudyFogDensity': { min: 0.001, max: 6, log: true },
  'sky.clearFogHeightFalloff': { min: 0.001, max: 5, log: true },
  'sky.cloudyFogHeightFalloff': { min: 0.001, max: 5, log: true },
  'groundPlate.variance': { min: 0, max: 1, step: 0.01 },
  'groundPlate.varianceBrickSize': { min: 0, max: 64, step: 1 },
  'water.waterHeight': { min: 0, max: 20000, step: 10 },
  'water.waterAbsorption': { min: 0, max: 0.25, log: true },
  'water.waterScattering': { min: 0, max: 0.25, log: true },
  'water.waterFogIntensity': { min: 0.000001, max: 0.01, log: true },
  'water.waterFogAmbientScale': { min: 0, max: 2, step: 0.01 },
  'water.waterFogScatteringScale': { min: 0, max: 5, step: 0.01 },
  'ambience.ambienceVolume': { min: 0, max: 1, step: 0.01 },
  'universe.universeLightIntensity': { min: 0, max: 5, step: 0.01 },
  'universe.universeAmbientIntensity': { min: 0, max: 5, step: 0.01 },
  'universe.universeGravityScale': { min: 0, max: 2, step: 0.01 },
  'universe.nebulaRedBlueSwap': { min: 0, max: 1, step: 0.01 },
  'universe.nebulaSaturation': { min: 0, max: 1, step: 0.01 },
  'universe.nebulaPower': { min: 0, max: 2, step: 0.01 },
  'universe.nebulaBrightness': { min: 0, max: 2, step: 0.01 },
  'universe.nearStarsPower': { min: 0, max: 3, step: 0.01 },
  'universe.nearStarsBrightness': { min: 0, max: 5, step: 0.01 },
  'universe.farStarsPower': { min: 0, max: 3, step: 0.01 },
  'universe.farStarsBrightness': { min: 0, max: 5, step: 0.01 },
};

/** Asset names seen in files, for pickers. Any other string is kept as-is. */
export const KNOWN_STRINGS: Readonly<Record<string, readonly string[]>> = {
  'ambience.selectedAmbienceType': [
    'None', 'BP_AmbienceType_Exterior_City', 'BP_AmbienceType_Exterior_NightCrickets',
    'BP_AmbienceType_Exterior_WindyForest', 'BP_AmbienceType_Exterior_GentleForest',
    'BP_AmbienceType_Interior_Aircraft_Cabin_Intense',
  ],
  'ambience.reverbEffect': ['Default', 'ExteriorEcho', 'LongHallway'],
  'universe.nebulaTexture': ['None', 'DA_SpaceNebula_001', 'DA_SpaceNebula_004', 'DA_SpaceNebula_006', 'DA_SpaceNebula_009', 'DA_SpaceNebula_010'],
  'universe.nearStarsTexture': ['None', 'DA_SpaceNearStars_001', 'DA_SpaceNearStars_005'],
  'universe.farStarsTexture': ['None', 'DA_SpaceFarStars_001'],
};

// ---------------------------------------------------------------------------------- helpers
export type ValueKind = 'number' | 'bool' | 'string' | 'color' | 'vector' | 'rotator';

export function kindOf(v: unknown): ValueKind | null {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'string';
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('r' in v && 'g' in v && 'b' in v) return 'color';
    if ('x' in v && 'y' in v && 'z' in v) return 'vector';
    if ('pitch' in v && 'yaw' in v && 'roll' in v) return 'rotator';
  }
  return null;
}

/** Deep copy of plain JSON-like data. */
export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || a === b;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => valuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Coerces a source value to the kind of the default. Returns undefined when it can't (the default
 * is then kept). Struct values missing a field take it from the default; extra fields are dropped.
 */
function coerce(v: unknown, def: EnvValue): EnvValue | undefined {
  const k = kindOf(def);
  if (k === 'number') return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? Number(v) : undefined;
  if (k === 'bool') return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : undefined;
  if (k === 'string') return typeof v === 'string' ? v : undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [f, d] of Object.entries(def as unknown as Record<string, number>)) {
    const x = (v as Record<string, unknown>)[f];
    out[f] = typeof x === 'number' && Number.isFinite(x) ? x : d;
  }
  return out as unknown as EnvValue;
}

const GROUP_ALIASES: Readonly<Record<string, GroupName>> = {
  sky: 'sky', groundplate: 'groundPlate', water: 'water', ambience: 'ambience', universe: 'universe',
};

// ---------------------------------------------------------------------------------- legacy keys
// Older sky keys (2021-2024 presets). Simple renames first; the combined ones are handled in
// applyLegacy. All of these are assumptions about what the game does when it loads an old preset
//; nothing here has been checked against the game yet.
const LEGACY_RENAMES: Readonly<Partial<Record<GroupName, Readonly<Record<string, string>>>>> = {
  sky: {
    sunAzimuth: 'sunAngle',
    skyLightIntensity: 'skyIntensity',
    moonLightIntensity: 'moonlightIntensity',
    fogDensity: 'clearFogDensity',
    fogHeightFalloff: 'clearFogHeightFalloff',
  },
};
/** Old keys consumed by applyLegacy (kept in `legacy`, not written). */
const LEGACY_COMBINED: Readonly<Partial<Record<GroupName, readonly string[]>>> = {
  sky: ['weatherIntensity', 'rainSnow', 'timeChangeSpeed'],
  ambience: ['selectedAmbienceTypeInt'],
};

function applyLegacy(g: GroupName, out: Record<string, EnvValue>, old: Record<string, unknown>, present: Set<string>): void {
  const num = (k: string): number | undefined => (typeof old[k] === 'number' ? (old[k] as number) : undefined);
  if (g === 'sky') {
    // weatherIntensity (0..1) with rainSnow (0 = rain, 1 = snow) -> rain / snow amounts.
    const wi = num('weatherIntensity'), rs = num('rainSnow') ?? 0;
    if (wi !== undefined) {
      if (!present.has('rain')) { out.rain = wi * (1 - rs); present.add('rain'); }
      if (!present.has('snow')) { out.snow = wi * rs; present.add('snow'); }
    }
    // timeChangeSpeed (0 = frozen) -> animateTimeOfDay.
    const tcs = num('timeChangeSpeed');
    if (tcs !== undefined && !present.has('animateTimeOfDay')) { out.animateTimeOfDay = tcs > 0; present.add('animateTimeOfDay'); }
  } else if (g === 'ambience') {
    // selectedAmbienceTypeInt: an index into the game's ambience list. Only 0 = None is known.
    const i = num('selectedAmbienceTypeInt');
    if (i === 0 && !present.has('selectedAmbienceType')) { out.selectedAmbienceType = 'None'; present.add('selectedAmbienceType'); }
  }
}

// ---------------------------------------------------------------------------------- parse
export class EnvironmentError extends Error {}

/** Parses an environment preset (text, bytes or already-parsed JSON) into the modern shape. */
export function parseEnvironment(input: string | Uint8Array | unknown): Environment {
  let json: unknown = input;
  let newline: '\r\n' | '\n' | undefined;
  if (input instanceof Uint8Array) json = new TextDecoder().decode(input);
  if (typeof json === 'string') {
    if (json.includes('\n')) newline = json.includes('\r\n') ? '\r\n' : '\n';
    try { json = JSON.parse(json.replace(/^\uFEFF/, '')); } catch (e) { throw new EnvironmentError(`not JSON: ${(e as Error).message}`); }
  }
  if (!json || typeof json !== 'object') throw new EnvironmentError('not an environment preset');
  const root = json as Record<string, unknown>;
  if (root.type !== undefined && root.type !== 'Environment') throw new EnvironmentError(`not an environment preset (type "${String(root.type)}")`);
  const groupsIn = (root.data as Record<string, unknown> | undefined)?.groups;
  if (!groupsIn || typeof groupsIn !== 'object' || Array.isArray(groupsIn)) throw new EnvironmentError('not an environment preset (no data.groups)');

  const env: Environment = {
    formatVersion: typeof root.formatVersion === 'string' ? root.formatVersion : '1',
    presetVersion: typeof root.presetVersion === 'string' ? root.presetVersion : '1',
    type: 'Environment',
    groups: {}, absent: {}, extras: {}, extraGroups: {}, legacy: {},
  };
  if (newline) env.newline = newline;
  for (const [srcName, body] of Object.entries(groupsIn as Record<string, unknown>)) {
    const g = GROUP_ALIASES[srcName.toLowerCase()];
    if (!g || !body || typeof body !== 'object' || Array.isArray(body) || env.groups[g]) {
      env.extraGroups[srcName] = clone(body);
      continue;
    }
    const src = body as Record<string, unknown>;
    const def = GROUP_DEFAULTS[g] as unknown as Record<string, EnvValue>;
    const out = clone(def) as Record<string, EnvValue>;
    const present = new Set<string>();
    const renames = LEGACY_RENAMES[g] ?? {};
    const combined = LEGACY_COMBINED[g] ?? [];
    const old: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    // Modern keys first, so a modern key wins over an old alias of it.
    for (const [k, v] of Object.entries(src)) {
      if (!(k in def)) continue;
      const c = coerce(v, def[k]!);
      if (c === undefined) { extra[k] = clone(v); continue; }   // wrong type: keep it, use the default
      out[k] = c; present.add(k);
    }
    for (const [k, v] of Object.entries(src)) {
      if (k in def) continue;
      const to = renames[k];
      if (to && !present.has(to)) {
        const c = coerce(v, def[to]!);
        if (c !== undefined) { out[to] = c; present.add(to); old[k] = clone(v); continue; }
      }
      if (combined.includes(k)) { old[k] = clone(v); continue; }
      extra[k] = clone(v);
    }
    applyLegacy(g, out, old, present);
    (env.groups as Record<string, unknown>)[g] = out;
    const absent = Object.keys(def).filter((k) => !present.has(k));
    if (absent.length) env.absent[g] = absent;
    if (Object.keys(extra).length) env.extras[g] = extra;
    if (Object.keys(old).length) env.legacy[g] = old;
  }
  return env;
}

/** A fresh environment with the given groups at their defaults (Plate: sky, groundPlate, water, ambience). */
export function defaultEnvironment(kind: 'Plate' | 'Space' = 'Plate'): Environment {
  const env: Environment = { formatVersion: '1', presetVersion: '1', type: 'Environment', groups: {}, absent: {}, extras: {}, extraGroups: {}, legacy: {} };
  for (const g of KIND_GROUPS[kind]) (env.groups as Record<string, unknown>)[g] = clone(GROUP_DEFAULTS[g]);
  return env;
}

/** Adds the groups a world kind needs that `env` lacks (at defaults). Returns a new object. */
export function completeEnvironment(env: Environment, kind: 'Plate' | 'Space' = 'Plate'): Environment {
  const out = cloneEnvironment(env);
  for (const g of KIND_GROUPS[kind]) {
    if (!out.groups[g]) {
      (out.groups as Record<string, unknown>)[g] = clone(GROUP_DEFAULTS[g]);
      out.absent[g] = Object.keys(GROUP_DEFAULTS[g]);
    }
  }
  return out;
}

/**
 * The environment as a world of this kind stores it: completed, and without the known groups the
 * kind doesn't use (a Space world has no sky, ground plate or water). Unknown groups are kept.
 */
export function environmentForKind(env: Environment, kind: 'Plate' | 'Space'): Environment {
  const out = completeEnvironment(env, kind);
  for (const g of GROUP_ORDER) {
    if (KIND_GROUPS[kind].includes(g)) continue;
    delete out.groups[g]; delete out.absent[g]; delete out.extras[g]; delete out.legacy[g];
  }
  return out;
}

export function cloneEnvironment(env: Environment): Environment {
  return clone(env);
}

/** The base map from `Meta/World.json` ({"environment": "Plate"}), or null if unreadable. */
export function parseWorldKind(input: string | Uint8Array): WorldKind | null {
  try {
    const s = typeof input === 'string' ? input : new TextDecoder().decode(input);
    const k = (JSON.parse(s.replace(/^\uFEFF/, '')) as { environment?: unknown }).environment;
    return typeof k === 'string' ? k : null;
  } catch { return null; }
}

/**
 * A world's environment from its file tree (a world .brz or .brdb). Worlds converted from old saves
 * have no Environment.bp; then env is null and the game's built-in default applies.
 */
export function environmentFromWorld(files: FileMap): { kind: WorldKind | null; env: Environment | null } {
  const wj = files.get('Meta/World.json'), bp = files.get('World/0/Environment.bp');
  return { kind: wj ? parseWorldKind(wj) : null, env: bp ? parseEnvironment(bp) : null };
}

// ---------------------------------------------------------------------------------- serialise
/**
 * A number the way the game's JSON writer prints it: C's %.17g (shortest exact form for integers,
 * 17 significant digits otherwise, exponent below 1e-4 and from 1e17).
 */
export function formatUeNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return Object.is(n, -0) ? '-0' : '0';
  const [m, e] = n.toExponential(16).split('e') as [string, string];
  const exp = Number(e);
  const strip = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exp < -4 || exp >= 17) return `${strip(m)}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  return strip(n.toFixed(Math.max(0, 16 - exp)));
}

const NL = '\r\n';
function writeValue(v: unknown, depth: number): string {
  const ind = '\t'.repeat(depth);
  if (typeof v === 'number') return formatUeNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[${NL}${v.map((x) => `${ind}\t${writeValue(x, depth + 1)}`).join(`,${NL}`)}${NL}${ind}]`;
  }
  return writeObject(Object.entries(v as Record<string, unknown>), depth);
}
function writeObject(entries: [string, unknown][], depth: number): string {
  const ind = '\t'.repeat(depth);
  if (!entries.length) return `{${NL}${ind}}`;
  const lines = entries.map(([k, v]) => {
    const isObj = v !== null && typeof v === 'object' && !Array.isArray(v);
    return isObj ? `${ind}\t${JSON.stringify(k)}:${NL}${ind}\t${writeValue(v, depth + 1)}` : `${ind}\t${JSON.stringify(k)}: ${writeValue(v, depth + 1)}`;
  });
  return `{${NL}${lines.join(`,${NL}`)}${NL}${ind}}`;
}

export interface SerialiseOptions {
  /**
   * Write every known key, including ones the source didn't have (default true). With false, a
   * key that was absent from the source and still equals its default is left out, so an unedited
   * file round-trips byte for byte.
   */
  complete?: boolean;
  /** Write unknown keys and groups back (default true). */
  extras?: boolean;
  /** Line ending (default: the source's, else CRLF as the game writes presets). */
  newline?: '\r\n' | '\n';
}

/** The environment as a .bp file's text, in the game's layout (tab indent, CRLF, no final newline). */
export function serialiseEnvironment(env: Environment, opts: SerialiseOptions = {}): string {
  const complete = opts.complete ?? true, withExtras = opts.extras ?? true;
  const groups: [string, unknown][] = [];
  for (const g of GROUP_ORDER) {
    const body = env.groups[g] as Record<string, unknown> | undefined;
    if (!body) continue;
    const def = GROUP_DEFAULTS[g] as unknown as Record<string, unknown>;
    const absent = new Set(env.absent[g] ?? []);
    const entries: [string, unknown][] = [];
    for (const k of Object.keys(def)) {
      const v = body[k] ?? def[k];
      if (!complete && absent.has(k) && valuesEqual(v, def[k])) continue;
      entries.push([k, v]);
    }
    if (withExtras) for (const [k, v] of Object.entries(env.extras[g] ?? {})) if (!(k in def)) entries.push([k, v]);
    groups.push([g, Object.fromEntries(entries)]);
  }
  if (withExtras) for (const [name, body] of Object.entries(env.extraGroups)) if (!groups.some(([n]) => n === name)) groups.push([name, body]);
  const text = writeObject([
    ['formatVersion', env.formatVersion],
    ['presetVersion', env.presetVersion],
    ['type', 'Environment'],
    ['data', { groups: Object.fromEntries(groups) }],
  ], 0);
  return (opts.newline ?? env.newline ?? NL) === NL ? text : text.replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------------- editing
/** Sets one value (returns a new environment). Marks the key as present so it is always written. */
export function setEnvValue<G extends GroupName, K extends keyof EnvGroups[G]>(env: Environment, group: G, key: K, value: EnvGroups[G][K]): Environment {
  const out = cloneEnvironment(env);
  const body = (out.groups[group] ?? clone(GROUP_DEFAULTS[group])) as EnvGroups[G];
  body[key] = clone(value);
  (out.groups as Record<string, unknown>)[group] = body;
  const a = out.absent[group]?.filter((k) => k !== key);
  if (a?.length) out.absent[group] = a; else delete out.absent[group];
  return out;
}

// ---------------------------------------------------------------------------------- colour
/** Linear -> sRGB-encoded (0..1), exact piecewise OETF. */
export function linearToSrgb(v: number): number {
  const x = Math.min(1, Math.max(0, v));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}
/** sRGB-encoded (0..1) -> linear, exact piecewise EOTF. */
export function srgbToLinear(v: number): number {
  const x = Math.min(1, Math.max(0, v));
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
/** A linear colour as #rrggbb (sRGB), the way the game converts linear colours for display. */
export function linearToHex(c: LinearColor): string {
  return '#' + [c.r, c.g, c.b].map((v) => Math.round(255 * linearToSrgb(v)).toString(16).padStart(2, '0')).join('');
}
export function hexToLinear(hex: string, a = 1): LinearColor {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new EnvironmentError(`bad colour ${hex}`);
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => srgbToLinear(parseInt(h, 16) / 255)) as [number, number, number];
  return { r, g, b, a };
}
