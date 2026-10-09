// Special brick materials: Glass, Translucent Plastic and Glow, fitted to in-game captures through the
// same pipeline as the lighting presets (scene-linear light -> Unreal's stock filmic tonemapper).
// The material intensity is the colour's A byte (0-10). Values are measured at 0, 5 and 10; other
// intensities are interpolated (linear for the transparent materials, log-linear for glow).
// All colours here are scene-linear: albedo = sRGB-decoded save colour.
//
// Glass (thin translucent, no lighting of its own):
//   scene = background * (1 - F) * T + F * sky
//   T     = mix(1, albedo, tint(i)) ^ (1 / cos^GLASS_PATH_EXP)      (cos = view vector . surface normal)
//   F     = F0 + (1 - F0) * (1 - cos)^5,  F0 = 0.04                  (Schlick; sky = preset sky light)
//   Intensity is the tint strength: 0 is strongly coloured, 10 is nearly clear.
//
// Translucent plastic (alpha-blended lit plastic, no reflection term, no measurable angle dependence):
//   scene = mix(background, albedo * K + floor * TRANSLUCENT_FLOOR_SCALE, opacity(i))
//   with K / floor the usual top-face light of the preset. Intensity 0 is nearly opaque, 10 nearly clear.
//
// Glow (unlit: emission only, scene light is ignored):
//   scene = albedo * GLOW_BASE * glowLevel(i)
//   GLOW_BASE is about the light a daylight top face receives, so intensity 0 looks like lit plastic by
//   day and stays visible ("self-lit") at night. 5 and 10 clip most colours to white.
//   Bloom: add sum_k weight_k * gaussianBlur(emission, sigma_k * viewportWidth) before tonemapping.

export type Rgb = [number, number, number];

/** Glass tint strength t at intensity 0 / 5 / 10. */
export const GLASS_TINT: readonly number[] = [0.911, 0.557, 0.156];
/** Exponent on the 1/cos path-length term (1 would be Beer-Lambert through a slab). */
export const GLASS_PATH_EXP = 0.579;
/** Fresnel reflectance at normal incidence. */
export const GLASS_F0 = 0.04;
/** Translucent plastic opacity at intensity 0 / 5 / 10. */
export const TRANSLUCENT_OPACITY: readonly number[] = [0.897, 0.495, 0.096];
/** Scale on the preset's floor (ambient) term for the translucent surface. */
export const TRANSLUCENT_FLOOR_SCALE = 0.939;
/** Glow emission relative to intensity 0, at intensity 0 / 5 / 10. */
export const GLOW_LADDER: readonly number[] = [1, 13.77, 47.2];
/** Glow emission per unit albedo at intensity 0 (scene-linear, preset exposure scale). */
export const GLOW_BASE = 3.1;
/** Bloom kernel: normalised Gaussians, sigma as a fraction of the viewport width. */
export const GLOW_BLOOM: readonly { weight: number; sigma: number }[] = [
  { weight: 0.00638, sigma: 0.00751 },
  { weight: 0.00364, sigma: 0.0373 },
  { weight: 0.00481, sigma: 0.0952 },
];

function clampI(i: number): number { return Math.min(10, Math.max(0, i)); }

/** Piecewise-linear interpolation through values at intensity 0, 5 and 10. */
export function lerp3(v: readonly number[], i: number): number {
  const x = clampI(i);
  return x <= 5 ? v[0]! + (v[1]! - v[0]!) * (x / 5) : v[1]! + (v[2]! - v[1]!) * ((x - 5) / 5);
}

export function fresnel(cos: number, f0 = GLASS_F0): number {
  const c = Math.min(1, Math.max(0, cos));
  return f0 + (1 - f0) * (1 - c) ** 5;
}

export function glassTint(i: number): number { return lerp3(GLASS_TINT, i); }

/** Glass transmission per channel (excluding the Fresnel loss). */
export function glassTransmission(albedo: Rgb, i: number, cos: number): Rgb {
  const t = glassTint(i), e = 1 / Math.max(0.05, cos) ** GLASS_PATH_EXP;
  return albedo.map((a) => (1 - t + t * a) ** e) as Rgb;
}

/** Glass: scene-linear colour over a background, reflecting the sky light. */
export function glassColor(albedo: Rgb, i: number, cos: number, background: Rgb, sky: Rgb): Rgb {
  const F = fresnel(cos), T = glassTransmission(albedo, i, cos);
  return [0, 1, 2].map((k) => background[k]! * (1 - F) * T[k]! + F * sky[k]!) as Rgb;
}

export function translucentOpacity(i: number): number { return lerp3(TRANSLUCENT_OPACITY, i); }

/** Translucent plastic: scene-linear colour over a background; surface lit by top-face light K. */
export function translucentColor(albedo: Rgb, i: number, background: Rgb, K: Rgb, floor: Rgb): Rgb {
  const a = translucentOpacity(i);
  return [0, 1, 2].map((k) => background[k]! * (1 - a) + a * (albedo[k]! * K[k]! + floor[k]! * TRANSLUCENT_FLOOR_SCALE)) as Rgb;
}

/** Glow emission multiplier relative to intensity 0 (log-linear between the measured points). */
export function glowLevel(i: number): number {
  const x = clampI(i), L = GLOW_LADDER;
  return x <= 5 ? L[0]! * (L[1]! / L[0]!) ** (x / 5) : L[1]! * (L[2]! / L[1]!) ** ((x - 5) / 5);
}

/** Glow: scene-linear emission (no lighting). */
export function glowColor(albedo: Rgb, i: number): Rgb {
  const s = GLOW_BASE * glowLevel(i);
  return albedo.map((a) => a * s) as Rgb;
}

const f = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** GLSL versions of the functions above (no dependencies; pair with TONEMAP_GLSL for display). */
export const MATERIALS_GLSL = `
const vec3 GLASS_TINT = vec3(${GLASS_TINT.map(f).join(', ')});
const float GLASS_PATH_EXP = ${f(GLASS_PATH_EXP)};
const float GLASS_F0 = ${f(GLASS_F0)};
const vec3 TRANSLUCENT_OPACITY = vec3(${TRANSLUCENT_OPACITY.map(f).join(', ')});
const float TRANSLUCENT_FLOOR_SCALE = ${f(TRANSLUCENT_FLOOR_SCALE)};
const vec3 GLOW_LADDER = vec3(${GLOW_LADDER.map(f).join(', ')});
const float GLOW_BASE = ${f(GLOW_BASE)};
float matLerp3(vec3 v, float i){
  float x = clamp(i, 0.0, 10.0);
  return x <= 5.0 ? mix(v.x, v.y, x/5.0) : mix(v.y, v.z, (x - 5.0)/5.0);
}
float matFresnel(float c){ c = clamp(c, 0.0, 1.0); return GLASS_F0 + (1.0 - GLASS_F0)*pow(1.0 - c, 5.0); }
vec3 glassColor(vec3 albedo, float i, float c, vec3 background, vec3 sky){
  float t = matLerp3(GLASS_TINT, i);
  vec3 T = pow(1.0 - t + t*albedo, vec3(1.0/pow(max(c, 0.05), GLASS_PATH_EXP)));
  float F = matFresnel(c);
  return background*(1.0 - F)*T + F*sky;
}
float translucentOpacity(float i){ return matLerp3(TRANSLUCENT_OPACITY, i); }
vec3 translucentSurface(vec3 albedo, vec3 K, vec3 floorLight){ return albedo*K + floorLight*TRANSLUCENT_FLOOR_SCALE; }
float glowLevel(float i){
  float x = clamp(i, 0.0, 10.0);
  return x <= 5.0 ? GLOW_LADDER.x*pow(GLOW_LADDER.y/GLOW_LADDER.x, x/5.0) : GLOW_LADDER.y*pow(GLOW_LADDER.z/GLOW_LADDER.y, (x - 5.0)/5.0);
}
vec3 glowColor(vec3 albedo, float i){ return albedo*GLOW_BASE*glowLevel(i); }
`;
