// The sky and water passes (L-03), fullscreen triangles with their own programs:
//   - sky (before everything): the sky dome through the virtual perspective ray (render/fx/glsl.ts),
//     or, where the view looks down onto water, the deep-water colour (an endless body of water
//     seen through its own fog). Replaces the flat background colour.
//   - water surface (after the opaque bodies): each pixel's orthographic ray meets the water plane;
//     that point's depth goes to gl_FragDepth so bricks above the water hide it and bricks below
//     are covered. Procedural waves (a few scrolling wave trains along the wind plus cross ripples,
//     faded out where they would be smaller than a few pixels) bend the normal; the colour is the
//     Fresnel-weighted sky reflection (plus the sun's glint), blended over what is under the water
//     (the brick shader already tinted that by depth). No game assets.

import { TONEMAP_GLSL } from '../shaders/tonemap.ts';
import { FULL_VS, RAY_GLSL, SKY_GLSL } from './glsl.ts';

const SKY_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform float uExposure;
uniform vec4 uDeep;   // rgb deep-water radiance, a = 1 where the view looks down onto water
${TONEMAP_GLSL}
${RAY_GLSL}
${SKY_GLSL}
void main(){
  vec3 c = uDeep.a > 0.5 ? uDeep.rgb : skyRadiance(viewRay(vUv*2.0 - 1.0));
  o = vec4(ueFilmic(uExposure * c), 1.0);
}`;

const WATER_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform mat4 uInv, uMVP;
uniform float uExposure, uH, uTime, uPx, uWaves;
uniform vec3 uOrigin;    // render origin, GL axes (so the waves stay put when it moves)
uniform vec3 uWind;      // xy = direction (world GL x/z), z = strength 0..1
${TONEMAP_GLSL}
${RAY_GLSL}
${SKY_GLSL}
// one wave train: direction d, wavelength l (viewer units), steepness k, speed s; returns d(height)/d(xz)
vec2 wave(vec2 p, vec2 d, float l, float k, float s){
  float w = 6.2831853 / l, ph = dot(p, d) * w - uTime * s * w;
  float fade = smoothstep(2.0, 6.0, l / uPx);        // no aliasing when zoomed far out
  return d * (k * cos(ph) * fade);
}
// value-noise slope (breaks up the regular wave trains)
float wh(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x*p.y); }
float wn(vec2 p){ vec2 i = floor(p), f = fract(p), u = f*f*(3.0 - 2.0*f);
  return mix(mix(wh(i), wh(i + vec2(1.0, 0.0)), u.x), mix(wh(i + vec2(0.0, 1.0)), wh(i + vec2(1.0, 1.0)), u.x), u.y); }
vec2 noiseSlope(vec2 p, float l, float k){
  float e = 0.15, fade = smoothstep(2.0, 6.0, l / uPx);
  vec2 q = p / l;
  return vec2(wn(q + vec2(e, 0.0)) - wn(q - vec2(e, 0.0)), wn(q + vec2(0.0, e)) - wn(q - vec2(0.0, e))) / (2.0*e) * k * fade;
}
void main(){
  vec2 ndc = vUv*2.0 - 1.0;
  vec4 a = uInv * vec4(ndc, -1.0, 1.0), b = uInv * vec4(ndc, 1.0, 1.0);
  vec3 ro = a.xyz / a.w, rd = b.xyz / b.w - ro;
  if (abs(rd.y) < 1e-7) discard;
  float t = (uH - ro.y) / rd.y;
  vec3 P = ro + rd * t;
  vec4 cp = uMVP * vec4(P, 1.0);
  gl_FragDepth = clamp(cp.z / cp.w * 0.5 + 0.5, 0.0, 1.0);
  vec2 q = P.xz + uOrigin.xz;
  vec2 g = vec2(0.0);
  if (uWaves > 0.5) {
    vec2 d = uWind.xy, e = vec2(-d.y, d.x);
    float k = 0.02 + 0.07 * uWind.z, sp = 0.4 + 1.6 * uWind.z;
    g += wave(q, d, 14.0, k, sp);
    g += wave(q, normalize(d + 0.6*e), 6.3, k*0.8, sp*0.8);
    if (uWaves > 1.5) { g += wave(q, normalize(d - 0.7*e), 3.1, k*0.6, sp*0.7); g += wave(q, normalize(e + 0.3*d), 1.7, k*0.45, sp*0.5); }
    vec2 drift = uWind.xy * uTime * sp * 0.3;
    g += noiseSlope(q - drift, 5.0, k * 0.9);
    if (uWaves > 1.5) g += noiseSlope(q * 1.3 + drift, 1.9, k * 0.6);
    if (uWaves > 2.5) { g += wave(q, normalize(d + 1.8*e), 0.83, k*0.35, sp*0.45); g += wave(q, normalize(-d + 0.9*e), 0.47, k*0.3, sp*0.4); }
  }
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 V = -viewRay(ndc);
  float c = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - c, 5.0);
  vec3 R = reflect(-V, N); R.y = abs(R.y);
  vec3 refl = skyRadiance(R) + uSunDisc * 0.02 * pow(max(dot(R, uSunDir), 0.0), 600.0);
  o = vec4(ueFilmic(uExposure * refl), F);
}`;

let skyP: WebGLProgram | null = null, waterP: WebGLProgram | null = null, failed = false;
const locs = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
const loc = (gl: WebGL2RenderingContext, p: WebGLProgram, n: string): WebGLUniformLocation | null => {
  let m = locs.get(p);
  if (!m) locs.set(p, (m = new Map()));
  if (!m.has(n)) m.set(n, gl.getUniformLocation(p, n));
  return m.get(n)!;
};

function program(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [t, src] of [[gl.VERTEX_SHADER, FULL_VS], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(t)!; gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'sky shader');
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'sky program');
  return p;
}
function ready(gl: WebGL2RenderingContext): boolean {
  if (failed) return false;
  if (!skyP) { try { skyP = program(gl, SKY_FS); waterP = program(gl, WATER_FS); } catch (e) { console.warn('sky / water off', e); failed = true; return false; } }
  return true;
}

/** The sky uniforms both programs share (see SKY_GLSL / RAY_GLSL). */
export interface SkyUniforms {
  exposure: number;
  camF: number[]; camR: number[]; camU: number[]; tan: [number, number];
  zenith: number[]; fog: number[]; sunDir: number[]; sunDisc: number[]; stars: number[];
  /** x fog optical depth straight up, y cos(disc radius), w = 1 Space */
  skyP: [number, number, number, number];
}

function setSky(gl: WebGL2RenderingContext, p: WebGLProgram, s: SkyUniforms): void {
  gl.uniform1f(loc(gl, p, 'uExposure'), s.exposure);
  gl.uniform3fv(loc(gl, p, 'uCamF'), s.camF); gl.uniform3fv(loc(gl, p, 'uCamR'), s.camR); gl.uniform3fv(loc(gl, p, 'uCamU'), s.camU);
  gl.uniform2fv(loc(gl, p, 'uTan'), s.tan);
  gl.uniform3fv(loc(gl, p, 'uSkyZenith'), s.zenith); gl.uniform3fv(loc(gl, p, 'uSkyFog'), s.fog);
  gl.uniform3fv(loc(gl, p, 'uSunDir'), s.sunDir); gl.uniform3fv(loc(gl, p, 'uSunDisc'), s.sunDisc); gl.uniform3fv(loc(gl, p, 'uStars'), s.stars);
  gl.uniform4fv(loc(gl, p, 'uSkyP'), s.skyP);
}

/** The background: sky, or deep water (deep = radiance, or null). Depth untouched. */
export function drawSky(gl: WebGL2RenderingContext, s: SkyUniforms, deep: number[] | null): boolean {
  if (!ready(gl) || !skyP) return false;
  gl.useProgram(skyP);
  setSky(gl, skyP, s);
  gl.uniform4f(loc(gl, skyP, 'uDeep'), deep?.[0] ?? 0, deep?.[1] ?? 0, deep?.[2] ?? 0, deep ? 1 : 0);
  gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  return true;
}

export interface WaterUniforms {
  inv: Float32Array; mvp: Float32Array; height: number; time: number;
  /** viewer units per pixel (wave anti-aliasing) */
  px: number; origin: number[]; wind: [number, number, number]; waves: number;
}

/** The water surface over the opaque scene (depth-tested against it, not written). */
export function drawWater(gl: WebGL2RenderingContext, s: SkyUniforms, w: WaterUniforms): void {
  if (!ready(gl) || !waterP) return;
  const p = waterP;
  gl.useProgram(p);
  setSky(gl, p, s);
  gl.uniformMatrix4fv(loc(gl, p, 'uInv'), false, w.inv); gl.uniformMatrix4fv(loc(gl, p, 'uMVP'), false, w.mvp);
  gl.uniform1f(loc(gl, p, 'uH'), w.height); gl.uniform1f(loc(gl, p, 'uTime'), w.time); gl.uniform1f(loc(gl, p, 'uPx'), w.px);
  gl.uniform1f(loc(gl, p, 'uWaves'), w.waves);
  gl.uniform3fv(loc(gl, p, 'uOrigin'), w.origin); gl.uniform3fv(loc(gl, p, 'uWind'), w.wind);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.BLEND); gl.depthMask(true); gl.depthFunc(gl.LESS);
}
