// The applied environment (both builds): an environment preset lights the scene through the
// calibrated model (src/env/lighting.ts) as the "Environment" lighting preset, and its ground plate
// is drawn (src/render/ground.ts). Sources: a world's own Environment.bp when it loads, and the
// environment panel (full build). Until one is applied the viewer keeps its presets and no plate,
// exactly as before. In ?test mode a world's environment isn't applied on load, so goldens and the
// parity scripts see the legacy look.

import { S } from './state.ts';
import { environmentFromWorld, type Environment, type WorldKind } from '../format/environment.ts';
import { environmentToLighting } from '../env/lighting.ts';
import { baseMapGround } from '../env/basemap.ts';
import { environmentGroundPlate } from '../env/ground-plate.ts';
import { loadedFiles } from '../scene/load.ts';
import type { FileMap } from '../format/brz.ts';
import type { GroundPlateLook } from '../env/ground-plate.ts';
import { setPreset, useLighting } from '../ui/panels/file.ts';
import { fx } from '../render/fx/state.ts';

export const ENV_PRESET = 'env';

export type EnvSource = 'world' | 'user';
type Listener = (env: Environment, kind: WorldKind | null, source: EnvSource) => void;

const env = { current: null as Environment | null, source: null as EnvSource | null, before: 'default', listeners: [] as Listener[], plateOnly: false };

/** Lights the scene with `e` and shows its ground plate. */
export function applyEnvironment(e: Environment, source: EnvSource, label = source === 'world' ? 'World environment' : 'Environment'): void {
  if (S.lighting !== ENV_PRESET) env.before = S.lighting;
  const l = environmentToLighting(e);
  useLighting(ENV_PRESET, { name: label, sun: l.sun, sky: l.sky, floor: l.floor, exposure: l.exposure });
  S.ground = environmentGroundPlate(e);
  env.current = e; env.source = source;
  fx.env = e;                                // the graphics effects' sun, sky, fog and water (render/fx)
}

/** Back to the preset in use before an environment was applied, and no ground plate. */
export function clearEnvironment(): void {
  if (S.lighting === ENV_PRESET) setPreset(env.before);
  S.ground = null; env.current = null; env.source = null; env.plateOnly = false; fx.env = null;
}

/** Called when a world's environment is applied (the panel follows it). */
export function onWorldEnvironment(f: Listener): void { env.listeners.push(f); }

export const currentEnvironment = (): Environment | null => env.current;

/** After every load: apply the save's own environment, or drop the previous world's. */
export function initWorldEnvironment(): void {
  // picking another lighting preset stops applying the environment (plate off); picking it again restores it
  const sel = document.getElementById('light') as HTMLSelectElement | null;
  sel?.addEventListener('change', () => {
    S.ground = sel.value === ENV_PRESET && env.current ? environmentGroundPlate(env.current) : null;
    fx.env = sel.value === ENV_PRESET ? env.current : null;
  });
  S.hooks.loaded.push(() => {
    if (S.testMode || !loadedFiles) return;
    applyWorldBaseMap(loadedFiles);
  });
}

/**
 * Applies a world's environment and its base map's ground plate (W-12), or drops the previous
 * world's. Returns the ground plate shown, or null.
 */
export function applyWorldBaseMap(files: FileMap): GroundPlateLook | null {
  let found: { kind: WorldKind | null; env: Environment | null };
  try { found = environmentFromWorld(files); } catch (err) { console.warn('world environment unreadable', err); return null; }
  if (found.env) {
    applyEnvironment(found.env, 'world');
    S.ground = baseMapGround(found.kind, found.env);
    for (const f of env.listeners) f(found.env, found.kind, 'world');
    return S.ground;
  }
  if (env.source === 'world') clearEnvironment();
  else if (env.plateOnly) { S.ground = null; env.plateOnly = false; }
  const ground = found.kind ? baseMapGround(found.kind, null) : null;
  if (ground && !env.current) { S.ground = ground; env.plateOnly = true; }
  return S.ground;
}
