// The atmosphere of a frame, on the CPU (pure functions, unit tested): the world-fixed sun or moon
// direction, the sky dome colours, the height fog and the water constants, from the lighting
// preset in use and the applied environment (if any). All radiance is scene-linear, in the same
// scale as the calibrated lighting (src/env/lighting.ts), so it goes through the same exposure and
// UE filmic tone map. Visual guesses are marked ASSUMED and logged in docs/UX_ASSUMPTIONS.md.
//
// Units: the .bp values are in game units (uu, 10 per stud); the renderer works in viewer units
// (1 = 50 uu). Directions are GL axes (x = world X, y = world Z up, z = world Y).

import type { Environment, SkyGroup, WaterGroup } from '../../format/environment.ts';
import { DEFAULT_SKY } from '../../format/environment.ts';
import { FIT, sunElevationFactor } from '../../env/lighting.ts';

export type V3 = [number, number, number];
export interface LightIn { sun: readonly number[]; sky: readonly number[]; floor: readonly number[]; exposure: number }

const UU_PER_VIEW = 50;
const lum = (c: readonly number[]): number => 0.2722287 * c[0]! + 0.6740818 * c[1]! + 0.0536895 * c[2]!;
const rgb = (c: { r: number; g: number; b: number }): V3 => [c.r, c.g, c.b];
const scale = (c: readonly number[], k: number): V3 => [c[0]! * k, c[1]! * k, c[2]! * k];
const mix3 = (a: readonly number[], b: readonly number[], t: number): V3 => [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const D2R = Math.PI / 180;

/** The default environment's top-face light luminance: the reference "daylight" level. */
const K_REF = 3.64;

/**
 * Where the sun is, as a unit vector toward it (GL axes), from the time of day and Sun Angle.
 * ASSUMED: the sun climbs a vertical arc through the zenith: on the horizon at 6h and 18h, overhead
 * at noon, rising on the side the angle points away from (the angle as the yaw a directional light
 * shines along: the sun sits at sunAngle + 180 degrees, measured from world +X toward +Y).
 * Below the horizon (night) the moon stands at 45 degrees elevation on the opposite side, as in the
 * lighting model.
 */
export function sunDirection(timeOfDay: number, sunAngle: number): { dir: V3; night: boolean; elevation: number } {
  const th = Math.PI * (timeOfDay - 6) / 12, az = (sunAngle + 180) * D2R;
  if (sunElevationFactor(timeOfDay) > 0) {
    const h = Math.cos(th), up = Math.sin(th);
    return { dir: [h * Math.cos(az), up, h * Math.sin(az)], night: false, elevation: Math.asin(up) / D2R };
  }
  const e = 45 * D2R, a = az + Math.PI;
  return { dir: [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)], night: true, elevation: 45 };
}

/** A light direction from azimuth / elevation in degrees (Space worlds' universe rotation). */
export function dirFromAngles(azimuthDeg: number, elevationDeg: number): V3 {
  const a = azimuthDeg * D2R, e = elevationDeg * D2R;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
}

/** The preset sun positions (no environment applied). ASSUMED: afternoon mirrors the default's 9.6h to 14.4h. */
const PRESET_TIME: Record<string, number> = { afternoon: 14.4, night: 0 };

export interface Atmos {
  /** toward the sun (or moon), GL axes */
  sunDir: V3;
  /**
   * The sun colour for N.L lighting with this world-fixed direction: the calibrated top-face light
   * is kept (sun x 0.81 there, at any elevation), so the sun is rescaled by 0.81 / sin(elevation).
   */
  sun: V3;
  night: boolean;
  space: boolean;
  /** sky dome at the zenith; horizon / fog inscatter colour */
  zenith: V3;
  fogColor: V3;
  /** sun disc radiance and angular radius (radians); a soft halo around it */
  sunDisc: V3;
  sunRadius: number;
  stars: V3;
  /** height fog: density (per uu) at height 0, falloff (per uu); fog height world Z 0 (ASSUMED) */
  fogDensity: number;
  fogFalloff: number;
  water: WaterLook | null;
}

export interface WaterLook {
  /** surface height, world units (uu) */
  height: number;
  /** extinction (absorption + scattering) per uu */
  extinction: V3;
  /** what in-scattering adds where the extinction removes light */
  inscatter: V3;
  /** the water fog: per uu, and its colour (deep water looks like this) */
  fogDensity: number;
  fogColor: V3;
  /** wave strength 0..1 and direction (radians, world XY) */
  wind: number;
  windDir: number;
}

/**
 * The atmosphere for lighting `L` (the preset in use, key `presetKey`) and environment `env`
 * (null: none applied; the sky then comes from the default environment, tinted by the preset).
 */
export function atmosphere(L: LightIn, presetKey: string, env: Environment | null): Atmos {
  const universe = env?.groups.universe && !env.groups.sky ? env.groups.universe : null;
  const skyG: SkyGroup = env?.groups.sky ?? DEFAULT_SKY;
  const fromEnv = !!env && !universe;
  // sun position
  let sd: { dir: V3; night: boolean; elevation: number };
  if (universe) {
    const el = Math.max(5, Math.min(90, 90 - Math.abs(universe.universeRotation.pitch)));
    sd = { dir: dirFromAngles(universe.universeRotation.yaw, el), night: false, elevation: el };
  } else if (fromEnv) sd = sunDirection(skyG.timeOfDay, skyG.sunAngle);
  else sd = sunDirection(PRESET_TIME[presetKey] ?? DEFAULT_SKY.timeOfDay, DEFAULT_SKY.sunAngle);
  const sinE = Math.max(0.05, Math.sin(sd.elevation * D2R));
  const sun = scale(L.sun, FIT.topNdotL / sinE);
  const Ktop = add(scale(L.sun, FIT.topNdotL), L.sky);
  const day = lum(Ktop) / K_REF;               // 1 for the default daylight

  if (universe) {
    return {
      sunDir: sd.dir, sun, night: false, space: true,
      zenith: [0, 0, 0], fogColor: [0, 0, 0], sunDisc: scale(L.sun, 25), sunRadius: 0.012, stars: [0.6, 0.65, 0.8],
      fogDensity: 0, fogFalloff: 0, water: null,
    };
  }
  // ASSUMED sky dome: the zenith leans toward the Sky Color (scaled by Sky Intensity), mixed with
  // the ambient sky light that the lighting model computes; without an environment, the ambient
  // light alone. The horizon is the Fog Color at the scene's daylight level.
  const skyCol = scale(rgb(skyG.skyColor), skyG.skyIntensity * 1.1 * Math.min(1, day));
  const zenith = fromEnv ? mix3(skyCol, scale(L.sky, 0.85), 0.35) : presetKey === 'default' ? mix3(skyCol, scale(L.sky, 0.85), 0.35) : scale(L.sky, 0.85);
  let fogColor: V3;
  if (fromEnv || presetKey === 'default') fogColor = scale(rgb(skyG.fogColor), Math.max(0.02, day));
  else {
    const l = Math.max(1e-4, lum(L.sky)), hue = scale(L.sky, 1 / l);
    fogColor = scale(mix3([1, 1, 1], hue, 0.3), 0.66 * Math.max(0.02, day));
  }
  const cc = skyG.cloudCoverage;
  // ASSUMED: the fog turns from Clear to Cloudy over the same cloud window that blocks the sun
  // (lighting model: 0.20 to 0.55), not linearly from 0
  const ct = Math.min(1, Math.max(0, (cc - FIT.cloudLo) / (FIT.cloudHi - FIT.cloudLo))), cw = ct * ct * (3 - 2 * ct);
  const nightK = sd.night ? 1 : 1 - Math.min(1, Math.max(0, (sd.elevation - 0) / 12));
  return {
    sunDir: sd.dir, sun, night: sd.night, space: false, zenith, fogColor,
    // ASSUMED disc: about 0.55 degrees at Sun Scale 1, Sun Horizon Scale applying near the horizon
    sunDisc: sd.night ? scale(rgb(skyG.moonlightColor), 3 * skyG.moonlightIntensity) : scale(L.sun, 40),
    sunRadius: (sd.night ? 0.008 * skyG.moonScale : 0.0096 * skyG.sunScale) *
      (1 + (skyG.sunHorizonScaleMultiplier - 1) * Math.max(0, 1 - sd.elevation / 15)),
    stars: scale(rgb(skyG.starsColor), skyG.starsIntensity * 0.02 * nightK),
    // UE height fog: the slider values are per 1000 uu (FogDensity / 1000, HeightFalloff / 1000);
    fogDensity: (skyG.clearFogDensity + (skyG.cloudyFogDensity - skyG.clearFogDensity) * cw) / 1000,
    fogFalloff: (skyG.clearFogHeightFalloff + (skyG.cloudyFogHeightFalloff - skyG.clearFogHeightFalloff) * cw) / 1000,
    water: fromEnv && env!.groups.water ? waterLook(env!.groups.water, L, skyG) : null,
  };
}

/**
 * Water: Beer-Lambert extinction (Color Absorption + Scattering, per uu), single in-scattering of the
 * ambient and sun light, then the water fog (Fog Intensity per uu) toward its colour, which is the
 * Fog Ambient Color x Strength lit by the sky plus the Fog Scattering Color x Strength lit by the sun.
 * ASSUMED: the weights of the two fog colours (0.1 on the sun term) and that 0 or less means no water.
 */
export function waterLook(w: WaterGroup, L: LightIn, sky: SkyGroup): WaterLook | null {
  if (!(w.waterHeight > 0)) return null;
  const a = [w.waterAbsorption.x, w.waterAbsorption.y, w.waterAbsorption.z], s = [w.waterScattering.x, w.waterScattering.y, w.waterScattering.z];
  const ext = a.map((v, i) => Math.max(1e-7, v + s[i]!)) as V3;
  const light = lum(L.sky) + 0.5 * lum(scale(L.sun, FIT.topNdotL));
  const inscatter = ext.map((e, i) => (s[i]! / e) * light) as V3;
  const fogColor = add(scale(rgb(w.waterFogAmbientColor), w.waterFogAmbientScale * lum(L.sky)),
    scale(rgb(w.waterFogScatteringColor), w.waterFogScatteringScale * 0.1 * lum(scale(L.sun, FIT.topNdotL))));
  return {
    height: w.waterHeight, extinction: ext, inscatter, fogDensity: Math.max(0, w.waterFogIntensity), fogColor,
    wind: Math.max(0, Math.min(1, sky.wind)), windDir: sky.windDirection * D2R,
  };
}

/**
 * The height-fog optical depth from a point at height zEye (uu) to infinity along a ray of
 * elevation sine dy > 0, the integral of density * exp(-falloff * z). For the sky dome.
 */
export function skyFogDepth(a: Atmos, zEye: number, dy: number): number {
  if (a.fogDensity <= 0) return 0;
  const d0 = a.fogDensity * Math.exp(-a.fogFalloff * zEye);
  return a.fogFalloff > 1e-9 ? d0 / (a.fogFalloff * Math.max(dy, 1e-3)) : Infinity;
}

export const VIEW_TO_UU = UU_PER_VIEW;
