// Environment -> viewer lighting {sun, sky, floor, exposure}, with the structured formula from the
// joint calibration fit (the light-from-.bp model). DOM-free and renderer-agnostic.
//
// Convention (the same as the viewer's lighting presets):
//   scene = exposure * (albedo * (sky + sun * N.L) + floor)   -> filmic tonemap
//   albedo = sRGB_EOTF(byte / 255); a top face (N.L = 0.81 in the fit) gets K = 0.81 * sun + sky.
// Colours from the .bp are taken as linear (UE FLinearColor).
//
// Plate worlds (sky group), day (fe > 0):
//   fe      = max(0, sin(pi * (timeOfDay - 6) / 12))           sunrise 6h, noon 12h (assumed)
//   Dcl     = 1 - smoothstep(0.20, 0.55, cloudCoverage)        clouds block the direct sun (assumed window)
//   direct  = s * sunScale * fe * sunlightColor * T * Dcl      T = (1, .701, .470) warm atmosphere tint
//   diffuse = q * s * sunScale * fe * cloudCoverage * sunlightColor + k * skyIntensity * skyColor
//   floor   = 0.0220 * direct + 0.0326 * diffuse
// Night (fe = 0):
//   direct = 0.1174 * moonlightIntensity * moonlightColor; diffuse = 0.0403 (neutral); floor = 0.0093 * (direct + diffuse)
// Then sun = direct / 0.81 and sky = diffuse. sunAngle (azimuth) doesn't change the amount of light.
//
// Not covered by the fit (marked `calibrated: false` in the result): Space worlds (universe group),
// whose light is modelled like an untinted noon sun; and sunScale / elevation, which no capture
// varied. The fit's stated errors, per environment: DEFAULT +5 %, AFTERNOON -4 %, OVERCAST <= 6 %,
// NIGHT 9.7 % rms (top-face K).

import type { Environment, LinearColor, SkyGroup, UniverseGroup } from '../format/environment.ts';
import { DEFAULT_SKY } from '../format/environment.ts';

export type Rgb = [number, number, number];

export interface Lighting {
  /** Directional light colour (scene-linear RGB); multiply by N.L. */
  sun: Rgb;
  /** Uniform ambient light. */
  sky: Rgb;
  /** Constant floor added after the albedo multiply (specular / GI stand-in). */
  floor: Rgb;
  /** Scene multiplier before the tonemapper. 0.93 without a vignette, 1 with one (see options). */
  exposure: number;
  /** True for night-time lighting (moon). */
  night: boolean;
  /** False where the model goes beyond what the calibration measured. */
  calibrated: boolean;
  /** Sun (or moon) azimuth in degrees, from sunAngle, and elevation in degrees, from timeOfDay. */
  azimuth: number;
  elevation: number;
}

export interface LightingOptions {
  /** The viewer applies the game's screen vignette itself (then exposure is 1). Default false. */
  vignette?: boolean;
}

/** The fitted constants (exported for tests and tuning). */
export const FIT = Object.freeze({
  s: 7.567, q: 0.324, k: 0.974,
  tint: [1, 0.701, 0.470] as Rgb,
  cloudLo: 0.20, cloudHi: 0.55,
  floorDirect: 0.0220, floorDiffuse: 0.0326,
  moon: 0.1174, nightAmbient: 0.0403, nightFloor: 0.0093,
  topNdotL: 0.81,
  exposureNoVignette: 0.93,
});

const rgb = (c: LinearColor | undefined): Rgb => [c?.r ?? 0, c?.g ?? 0, c?.b ?? 0];
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Sun elevation factor from the time of day (0 at night, 1 at noon). */
export function sunElevationFactor(timeOfDay: number): number {
  return Math.max(0, Math.sin(Math.PI * (timeOfDay - 6) / 12));
}

export function skyLighting(g: SkyGroup, opts: LightingOptions = {}): Lighting {
  const fe = sunElevationFactor(g.timeOfDay);
  const sunC = rgb(g.sunlightColor), skyC = rgb(g.skyColor), cc = g.cloudCoverage;
  const exposure = opts.vignette ? 1 : FIT.exposureNoVignette;
  const azimuth = g.sunAngle;
  if (fe > 0) {
    const Dcl = 1 - smoothstep(FIT.cloudLo, FIT.cloudHi, cc);
    const a = FIT.s * g.sunScale * fe;
    const direct = sunC.map((v, i) => a * v * FIT.tint[i]! * Dcl) as Rgb;
    const diffuse = sunC.map((v, i) => FIT.q * a * cc * v + FIT.k * g.skyIntensity * skyC[i]!) as Rgb;
    const floor = direct.map((v, i) => FIT.floorDirect * v + FIT.floorDiffuse * diffuse[i]!) as Rgb;
    return {
      sun: direct.map((v) => v / FIT.topNdotL) as Rgb, sky: diffuse, floor, exposure, night: false,
      calibrated: true, azimuth, elevation: (Math.asin(Math.min(1, fe)) * 180) / Math.PI,
    };
  }
  const direct = rgb(g.moonlightColor).map((v) => FIT.moon * g.moonlightIntensity * v) as Rgb;
  const diffuse: Rgb = [FIT.nightAmbient, FIT.nightAmbient, FIT.nightAmbient];
  const floor = direct.map((v, i) => FIT.nightFloor * (v + diffuse[i]!)) as Rgb;
  return {
    sun: direct.map((v) => v / FIT.topNdotL) as Rgb, sky: diffuse, floor, exposure, night: true,
    calibrated: true, azimuth: (azimuth + 180) % 360, elevation: 45,
  };
}

/**
 * Space worlds: an UNCALIBRATED guess. The universe light is treated like a noon sun with no
 * atmosphere tint or clouds, and the ambient like the sky term.
 */
export function universeLighting(u: UniverseGroup, opts: LightingOptions = {}): Lighting {
  const direct = rgb(u.universeLightColor).map((v) => FIT.s * u.universeLightIntensity * v) as Rgb;
  const diffuse = rgb(u.universeAmbientColor).map((v) => FIT.k * u.universeAmbientIntensity * v) as Rgb;
  const floor = direct.map((v, i) => FIT.floorDirect * v + FIT.floorDiffuse * diffuse[i]!) as Rgb;
  return {
    sun: direct.map((v) => v / FIT.topNdotL) as Rgb, sky: diffuse, floor,
    exposure: opts.vignette ? 1 : FIT.exposureNoVignette, night: false, calibrated: false,
    azimuth: u.universeRotation.yaw, elevation: Math.max(5, Math.min(90, 90 - Math.abs(u.universeRotation.pitch))),
  };
}

/**
 * The lighting for an environment. A Space world's environment (universe, no sky) uses the
 * universe light; anything else uses the sky group, falling back to defaults for a missing one.
 */
export function environmentToLighting(env: Environment, opts: LightingOptions = {}): Lighting {
  if (env.groups.universe && !env.groups.sky) return universeLighting(env.groups.universe, opts);
  return skyLighting(env.groups.sky ?? DEFAULT_SKY, opts);
}

/** The top-face light K = 0.81 * sun + sky, the quantity the calibration measured. */
export function topFaceK(l: Lighting): Rgb {
  return l.sun.map((v, i) => FIT.topNdotL * v + l.sky[i]!) as Rgb;
}
