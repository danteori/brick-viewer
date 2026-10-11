// Graphics options presets (.bp, type "Options/Graphics"): the game's own format for its
// graphics settings, read and written as is. DOM-free.
//
//   { "formatVersion": "1", "presetVersion": "1", "type": "Options/Graphics",
//     "data": { "ShadowQuality": 3, "FieldOfView": 65, ... } }
//
// The game has written the keys in two spellings over time: lowerCamel ("shadowQuality") in older
// files and PascalCase ("ShadowQuality") in newer ones. Lookups ignore the case of the first
// letter; a written file keeps every key in its original spelling and order, unknown keys
// included, so an unedited file round-trips byte for byte. Same text layout as the environment
// presets (tab indent, CRLF, %.17g numbers: format/environment.ts).

import { writeUeObject } from './environment.ts';

export type GfxValue = number | boolean | string;

export interface GraphicsPreset {
  formatVersion: string;
  presetVersion: string;
  /** every key of data, in file order, with its own spelling */
  entries: [string, unknown][];
  newline?: '\r\n' | '\n';
}

export class GraphicsPresetError extends Error {}

export const GRAPHICS_TYPE = 'Options/Graphics';

/** "shadowQuality" and "ShadowQuality" are the same key. */
const norm = (k: string): string => k.toLowerCase();

/** Parses a graphics preset (text, bytes or parsed JSON). */
export function parseGraphicsPreset(input: string | Uint8Array | unknown): GraphicsPreset {
  let json: unknown = input, newline: '\r\n' | '\n' | undefined;
  if (input instanceof Uint8Array) json = new TextDecoder().decode(input);
  if (typeof json === 'string') {
    if (json.includes('\n')) newline = json.includes('\r\n') ? '\r\n' : '\n';
    try { json = JSON.parse((json.charCodeAt(0) === 0xfeff ? json.slice(1) : json)); } catch (e) { throw new GraphicsPresetError(`not JSON: ${(e as Error).message}`); }
  }
  if (!json || typeof json !== 'object') throw new GraphicsPresetError('not a graphics preset');
  const root = json as Record<string, unknown>;
  if (root.type !== undefined && root.type !== GRAPHICS_TYPE) throw new GraphicsPresetError(`not a graphics preset (type "${String(root.type)}")`);
  const data = root.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GraphicsPresetError('not a graphics preset (no data)');
  const p: GraphicsPreset = {
    formatVersion: typeof root.formatVersion === 'string' ? root.formatVersion : '1',
    presetVersion: typeof root.presetVersion === 'string' ? root.presetVersion : '1',
    entries: Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, structuredClone(v)]),
  };
  if (newline) p.newline = newline;
  return p;
}

/** The preset as .bp text in the game's layout. */
export function serialiseGraphicsPreset(p: GraphicsPreset): string {
  const text = writeUeObject([
    ['formatVersion', p.formatVersion],
    ['presetVersion', p.presetVersion],
    ['type', GRAPHICS_TYPE],
    ['data', Object.fromEntries(p.entries)],
  ]);
  return (p.newline ?? '\r\n') === '\r\n' ? text : text.replace(/\r\n/g, '\n');
}

/** The value of key (either spelling), or undefined. */
export function getGfx(p: GraphicsPreset, key: string): unknown {
  const n = norm(key);
  return p.entries.find(([k]) => norm(k) === n)?.[1];
}

/** A copy with key set: in place under the file's spelling, or appended (spelled as given). */
export function setGfx(p: GraphicsPreset, key: string, value: GfxValue): GraphicsPreset {
  const n = norm(key), entries = p.entries.map(([k, v]) => [k, v] as [string, unknown]);
  const i = entries.findIndex(([k]) => norm(k) === n);
  if (i >= 0) entries[i] = [entries[i]![0], value]; else entries.push([key, value]);
  return { ...p, entries };
}

export const cloneGraphicsPreset = (p: GraphicsPreset): GraphicsPreset => ({ ...p, entries: p.entries.map(([k, v]) => [k, structuredClone(v)]) });

/**
 * Our default preset when none is loaded: the keys of the current game build in its spelling, at
 * values that look good in the viewer (scalability High for shadows, Epic for the rest).
 * Assumed values, not read from the game.
 */
export function defaultGraphicsPreset(): GraphicsPreset {
  return {
    formatVersion: '1', presetVersion: '1', entries: [
      ['FullscreenMode', 'Windowed'],
      ['ScreenResolutionById', 0],
      ['FrameRateLimit', 0],
      ['FrameRateLimitUnfocused', 0],
      ['VSyncEnabled', true],
      ['FPSCounterMode', 'Disabled'],
      ['RenderingMode', 'DirectX12'],
      ['bSimpleShadingSupportLocalLights', false],
      ['bBR_HDREnabled', false],
      ['BR_HDRNits', 1000],
      ['BR_HDR_UI_Nits', 300],
      ['HDRPaperWhite', 203],
      ['AntiAliasingMode', 'TSR'],
      ['ResolutionScalePreset', 'Native'],
      ['ResolutionScaleValueEx', 100],
      ['AntiAliasingQuality', 3],
      ['ReflexMode', 'Disabled'],
      ['bTransformerEnabled', false],
      ['FrameGenerationMethod', 'None'],
      ['FrameGenerationMode', 'Disabled'],
      ['ViewDistanceQuality', 3],
      ['ShadowQuality', 2],
      ['TextureQuality', 3],
      ['VisualEffectQuality', 3],
      ['PostProcessingQuality', 3],
      ['FoliageQuality', 3],
      ['bSupportRayTracing', false],
      ['GlobalIlluminationMode', 'None'],
      ['GlobalIlluminationQuality', 3],
      ['ReflectionMode', 'None'],
      ['ReflectionQuality', 3],
      ['bExtremeReflections', false],
      ['bUseVirtualShadowMaps', true],
      ['bEnableOIT', true],
      ['bEnableGizmoPass', true],
      ['bEnableGizmoMSAA', true],
      ['CustomInterfaceScale', 1],
      ['bUseCustomInterfaceScale', false],
      ['FieldOfView', 65],
      ['ThirdPersonShoulderFieldOfView', 65],
      ['bUseThirdPersonShoulderFieldOfView', false],
      ['ThirdPersonOrbitFieldOfView', 65],
      ['bUseThirdPersonOrbitFieldOfView', false],
      ['bEnableCameraTransitions', true],
      ['CameraShakeScale', 1],
      ['MotionBlurMode', 'Disabled'],
    ],
  };
}

/** The scalability keys an overall quality level sets (0 Low, 1 Medium, 2 High, 3 Epic). */
export const QUALITY_KEYS = ['ViewDistanceQuality', 'ShadowQuality', 'TextureQuality', 'VisualEffectQuality', 'PostProcessingQuality', 'FoliageQuality', 'AntiAliasingQuality', 'GlobalIlluminationQuality', 'ReflectionQuality'] as const;
export const QUALITY_NAMES = ['Low', 'Medium', 'High', 'Epic', 'Cinematic'] as const;

/** A copy with every scalability key at `level` (the game's per-group levels). */
export function withQualityLevel(p: GraphicsPreset, level: number): GraphicsPreset {
  let out = p;
  for (const k of QUALITY_KEYS) out = setGfx(out, k, level);
  return out;
}

/** The overall level when every scalability key agrees, else null (Custom). */
export function qualityLevelOf(p: GraphicsPreset): number | null {
  const v = QUALITY_KEYS.map((k) => getGfx(p, k)).filter((x) => typeof x === 'number') as number[];
  return v.length && v.every((x) => x === v[0]) ? v[0]! : null;
}
