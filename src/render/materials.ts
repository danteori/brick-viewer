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
//
// Metallic (opaque, fitted to daylight top-down captures):
//   scene = albedo * (METAL_SKY * env(r) + metalRough(i) * K)
//   env(r) = the preset sky light for reflections pointing up, METAL_GROUND x it pointing down (r = the
//   reflected view vector, smooth blend around the horizon); K = the usual lit-plastic light (sky + sun N.L).
//   Intensity 0 is a dark, sky-tinted mirror; higher intensities pick up more of the scene light (a rough,
//   sun-lit look): metalRough = METAL_ROUGH_MAX * (i / 10)^METAL_ROUGH_EXP.
//
// Hologram (transparent, glowing, animated):
//   scene = background * (1 - opacity(i)) + albedo * GLOW_BASE * holoLevel(i) * holoPattern(z, t)
//   holoPattern = 1 + s1 + s2: two layers of irregular horizontal stripes (0 or 1 each) in WORLD height z
//   (Brickadia units), scrolling in opposite directions (layer 1 up, layer 2 down). Where both overlap the
//   brick is three times as bright as where neither does. Opacity and brightness both rise with intensity.

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

/** Metallic: sky reflection strength (x the preset sky light) at every intensity. */
export const METAL_SKY = 2.35;
/** Metallic: the reflection pointing below the horizon is this fraction of the sky one. */
export const METAL_GROUND = 0.35;
/** Metallic: lit-plastic fraction at intensity 10 and its growth exponent (0 / 0.07 / 0.44 at 0 / 5 / 10). */
export const METAL_ROUGH_MAX = 0.44;
export const METAL_ROUGH_EXP = 2.6;
/** Hologram opacity at intensity 0 / 5 / 10. */
export const HOLO_OPACITY: readonly number[] = [0.15, 0.36, 0.48];
/** Hologram emission (x GLOW_BASE, i.e. x a daylight top face's light) of the dark level, at 0 / 5 / 10. */
export const HOLO_LEVEL: readonly number[] = [0.066, 0.361, 0.611];
/**
 * The two stripe layers. Each `cell` units of height holds one stripe whose width is a random fraction
 * (between `duty[0]` and `duty[1]`) of the cell at a random offset; `speed` in units per second, + = up.
 */
export const HOLO_LAYERS: readonly { cell: number; duty: readonly [number, number]; speed: number; seed: number }[] = [
  { cell: 11, duty: [0.13, 0.53], speed: 4.5, seed: 0 },
  { cell: 7, duty: [0.1, 0.44], speed: -9.3, seed: 57.31 },
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

/** Metallic lit-plastic fraction. */
export function metalRough(i: number): number { return METAL_ROUGH_MAX * (clampI(i) / 10) ** METAL_ROUGH_EXP; }

/** Smooth 0..1 weight of the sky in a reflection whose vertical component is rz (save Z up / GL y up). */
export function metalSkyWeight(rz: number): number {
  const t = Math.min(1, Math.max(0, (rz + 0.2) / 0.4));
  return t * t * (3 - 2 * t);
}

/** Metallic: scene-linear colour. rz = up component of the reflected view vector; K = lit-plastic light. */
export function metalColor(albedo: Rgb, i: number, rz: number, sky: Rgb, K: Rgb): Rgb {
  const w = METAL_GROUND + (1 - METAL_GROUND) * metalSkyWeight(rz), g = metalRough(i);
  return [0, 1, 2].map((k) => albedo[k]! * (METAL_SKY * w * sky[k]! + g * K[k]!)) as Rgb;
}

export function holoOpacity(i: number): number { return lerp3(HOLO_OPACITY, i); }
export function holoLevel(i: number): number { return lerp3(HOLO_LEVEL, i); }

/** A repeatable 0..1 hash of a number (the same formula as the GLSL one). */
export function hash1(x: number): number { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); }

/** One stripe layer at height u (units, already scrolled): 1 inside the cell's stripe, else 0. */
export function holoStripe(u: number, cell: number, duty: readonly [number, number], seed: number): number {
  const c = Math.floor(u / cell), f = u / cell - c;
  const w = duty[0] + (duty[1] - duty[0]) * hash1(c + seed), o = hash1(c + seed + 17.3) * (1 - w);
  return f >= o && f < o + w ? 1 : 0;
}

/** The hologram's brightness pattern at world height z (units) and time t (seconds): 1, 2 or 3. */
export function holoPattern(z: number, t: number): number {
  let p = 1;
  for (const L of HOLO_LAYERS) p += holoStripe(z - L.speed * t, L.cell, L.duty, L.seed);
  return p;
}

/** The pattern's mean over height (1 + the two layers' mean duty), for a static (time-free) look. */
export const HOLO_PATTERN_MEAN = 1 + HOLO_LAYERS.reduce((s, L) => s + (L.duty[0] + L.duty[1]) / 2, 0);

/** Hologram: scene-linear colour over a background. */
export function holoColor(albedo: Rgb, i: number, z: number, t: number, background: Rgb): Rgb {
  const a = holoOpacity(i), e = GLOW_BASE * holoLevel(i) * holoPattern(z, t);
  return [0, 1, 2].map((k) => background[k]! * (1 - a) + albedo[k]! * e) as Rgb;
}

const f = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));
type HoloLayer = (typeof HOLO_LAYERS)[number];
const [H1, H2] = HOLO_LAYERS as readonly [HoloLayer, HoloLayer];

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
const float METAL_SKY = ${f(METAL_SKY)}, METAL_GROUND = ${f(METAL_GROUND)};
const float METAL_ROUGH_MAX = ${f(METAL_ROUGH_MAX)}, METAL_ROUGH_EXP = ${f(METAL_ROUGH_EXP)};
float metalRough(float i){ return METAL_ROUGH_MAX*pow(clamp(i, 0.0, 10.0)/10.0, METAL_ROUGH_EXP); }
// rz: up component of the reflected view vector; K: the lit-plastic light (sky + sun N.L)
vec3 metalColor(vec3 albedo, float i, float rz, vec3 sky, vec3 K){
  float w = METAL_GROUND + (1.0 - METAL_GROUND)*smoothstep(-0.2, 0.2, rz);
  return albedo*(METAL_SKY*w*sky + metalRough(i)*K);
}
const vec3 HOLO_OPACITY = vec3(${HOLO_OPACITY.map(f).join(', ')});
const vec3 HOLO_LEVEL = vec3(${HOLO_LEVEL.map(f).join(', ')});
float holoOpacity(float i){ return matLerp3(HOLO_OPACITY, i); }
float matHash(float x){ return fract(sin(x*12.9898)*43758.5453); }
float holoStripe(float u, float cell, vec2 duty, float seed){
  float c = floor(u/cell), fr = u/cell - c;
  float w = mix(duty.x, duty.y, matHash(c + seed)), o = matHash(c + seed + 17.3)*(1.0 - w);
  return step(o, fr)*(1.0 - step(o + w, fr));
}
// z: world height in Brickadia units; t: seconds
float holoPattern(float z, float t){
  return 1.0 + holoStripe(z - (${f(H1.speed)})*t, ${f(H1.cell)}, vec2(${H1.duty.map(f).join(', ')}), ${f(H1.seed)})
             + holoStripe(z - (${f(H2.speed)})*t, ${f(H2.cell)}, vec2(${H2.duty.map(f).join(', ')}), ${f(H2.seed)});
}
vec3 holoEmission(vec3 albedo, float i, float z, float t){ return albedo*GLOW_BASE*matLerp3(HOLO_LEVEL, i)*holoPattern(z, t); }
`;
