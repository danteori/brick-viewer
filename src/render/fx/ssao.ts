// SSAO (L-03): soft contact darkening, at half resolution.
//   1. depth prepass: the opaque bodies in depth only, at half size, into a depth texture;
//   2. AO: per texel, a spiral of samples within a radius (view units, kept between 3 and 24
//      texels on screen); each sample's occlusion is how far it rises above the surface's tangent
//      plane (the cosine to the normal, reconstructed from the depth), fading out with distance;
//   3. a depth-aware blur (separable, 9 taps) that removes the sample noise without bleeding over
//      edges;
// The brick shader reads the result (gl_FragCoord) and darkens only the ambient terms (sky light
// and floor), as UE's SSAO does with Lumen off: direct sun is handled by the shadows.
// The camera is orthographic, so a texel's view position is linear in its uv and depth.

import { AO_UNIT } from '../gl.ts';
import { FULL_VS } from './glsl.ts';

const AO_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform highp sampler2D uDepth;
uniform vec2 uExt;       // half the view rectangle (view units)
uniform float uZr;       // depth half-range
uniform float uRadius;   // sample radius, view units
uniform float uRadPx;    // the same in AO texels
uniform int uN;
uniform float uStrength;
vec3 posAt(vec2 uv){ float d = texture(uDepth, uv).r; return vec3((uv*2.0 - 1.0)*uExt, -(d*2.0 - 1.0)*uZr); }
void main(){
  vec2 ts = 1.0 / vec2(textureSize(uDepth, 0));
  float d0 = texture(uDepth, vUv).r;
  if (d0 >= 1.0) { o = vec4(1.0); return; }
  vec3 P = posAt(vUv);
  vec3 px = posAt(vUv + vec2(ts.x, 0.0)), nx = posAt(vUv - vec2(ts.x, 0.0));
  vec3 py = posAt(vUv + vec2(0.0, ts.y)), ny = posAt(vUv - vec2(0.0, ts.y));
  vec3 dx = abs(px.z - P.z) < abs(P.z - nx.z) ? px - P : P - nx;
  vec3 dy = abs(py.z - P.z) < abs(P.z - ny.z) ? py - P : P - ny;
  vec3 N = normalize(cross(dx, dy));
  if (N.z < 0.0) N = -N;
  // interleaved 4x4 rotation (the blur takes the pattern out)
  ivec2 ip = ivec2(gl_FragCoord.xy) & 3;
  float rot = float(ip.x * 4 + ip.y) * 0.3926991 + float((ip.x + ip.y) & 1) * 0.19635;
  float sum = 0.0, R2 = uRadius * uRadius;
  for (int i = 0; i < 16; i++) {
    if (i >= uN) break;
    float t = (float(i) + 0.5) / float(uN);
    float a = rot + float(i) * 2.3999632;
    vec2 off = vec2(cos(a), sin(a)) * (t * uRadPx) * ts;
    vec3 v = posAt(vUv + off) - P;
    float vv = dot(v, v);
    if (vv < 1e-10) continue;
    float c = dot(v, N) * inversesqrt(vv);
    sum += max(0.0, c - 0.12) * max(0.0, 1.0 - vv / R2);
  }
  o = vec4(vec3(clamp(1.0 - uStrength * sum / float(uN) * 2.2, 0.0, 1.0)), 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uAoIn; uniform highp sampler2D uDepth; uniform vec2 uDir; uniform float uZk;
void main(){
  vec2 ts = uDir / vec2(textureSize(uAoIn, 0));
  float z0 = texture(uDepth, vUv).r, s = 0.0, ws = 0.0;
  for (int i = -4; i <= 4; i++) {
    vec2 uv = vUv + ts * float(i);
    float w = exp(-float(i*i) / 8.0) * exp(-abs(texture(uDepth, uv).r - z0) * uZk);
    s += texture(uAoIn, uv).r * w; ws += w;
  }
  o = vec4(vec3(s / ws), 1.0);
}`;

interface Res { w: number; h: number; dfb: WebGLFramebuffer; depth: WebGLTexture; a: { fb: WebGLFramebuffer; tex: WebGLTexture }; b: { fb: WebGLFramebuffer; tex: WebGLTexture } }
let res: Res | null = null;
let aoP: WebGLProgram | null = null, blurP: WebGLProgram | null = null, failed = false;

function program(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [t, src] of [[gl.VERTEX_SHADER, FULL_VS], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(t)!; gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'ssao shader');
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'ssao program');
  return p;
}

function colour(gl: WebGL2RenderingContext, w: number, h: number): { fb: WebGLFramebuffer; tex: WebGLTexture } {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fb, tex };
}

function setup(gl: WebGL2RenderingContext, W: number, H: number): Res | null {
  if (failed) return null;
  if (!aoP) { try { aoP = program(gl, AO_FS); blurP = program(gl, BLUR_FS); } catch (e) { console.warn('SSAO off', e); failed = true; return null; } }
  const w = Math.max(1, W >> 1), h = Math.max(1, H >> 1);
  if (res && res.w === w && res.h === h) return res;
  if (res) { for (const t of [res.a, res.b]) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); } gl.deleteFramebuffer(res.dfb); gl.deleteTexture(res.depth); res = null; }
  gl.activeTexture(gl.TEXTURE0);
  const depth = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, depth);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, w, h);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const dfb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, dfb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  const a = colour(gl, w, h), b = colour(gl, w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  if (!ok) { failed = true; console.warn('SSAO off: depth target incomplete'); return null; }
  return (res = { w, h, dfb, depth, a, b });
}

export interface AoView { extX: number; extY: number; zr: number; samples: number }

/** world radius of the AO (viewer units). ASSUMED: about 3 studs, tuned by eye. */
export const AO_RADIUS = 0.6;

/**
 * Renders the AO texture for a W x H frame: drawDepth draws the opaque bodies (depth only, the
 * brick program with the frame's uMVP). Returns the strength to apply (0 = none drawn).
 */
export function renderAO(gl: WebGL2RenderingContext, W: number, H: number, v: AoView, drawDepth: () => void): number {
  const r = setup(gl, W, H);
  if (!r || !aoP || !blurP) return 0;
  // 1. depth prepass
  gl.bindFramebuffer(gl.FRAMEBUFFER, r.dfb);
  gl.viewport(0, 0, r.w, r.h);
  gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.colorMask(false, false, false, false);
  drawDepth();
  gl.colorMask(true, true, true, true);
  // 2. AO: radius in texels from the world radius, kept on screen between 3 and 24 texels; below
  // 3 the strength fades (far zoom), above 24 the world radius shrinks (close-ups)
  const pxPerUnit = r.h / (2 * v.extY), want = AO_RADIUS * pxPerUnit;
  const radPx = Math.max(3, Math.min(24, want)), radius = radPx / pxPerUnit;
  const strength = want < 3 ? Math.max(0.35, want / 3) : 1;
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, r.depth);
  gl.useProgram(aoP);
  const U = (p: WebGLProgram, n: string): WebGLUniformLocation | null => gl.getUniformLocation(p, n);
  gl.uniform1i(U(aoP, 'uDepth'), 0);
  gl.uniform2f(U(aoP, 'uExt'), v.extX, v.extY);
  gl.uniform1f(U(aoP, 'uZr'), v.zr);
  gl.uniform1f(U(aoP, 'uRadius'), radius);
  gl.uniform1f(U(aoP, 'uRadPx'), radPx);
  gl.uniform1i(U(aoP, 'uN'), v.samples);
  gl.uniform1f(U(aoP, 'uStrength'), 1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, r.a.fb);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // 3. blur, x then y (depth units: a jump of ~2 % of the AO radius stops it)
  gl.useProgram(blurP);
  gl.uniform1i(U(blurP, 'uAoIn'), 1); gl.uniform1i(U(blurP, 'uDepth'), 0);
  gl.uniform1f(U(blurP, 'uZk'), (2 * v.zr) / Math.max(1e-6, radius * 0.5));
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, r.a.tex); gl.bindFramebuffer(gl.FRAMEBUFFER, r.b.fb); gl.uniform2f(U(blurP, 'uDir'), 1, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindTexture(gl.TEXTURE_2D, r.b.tex); gl.bindFramebuffer(gl.FRAMEBUFFER, r.a.fb); gl.uniform2f(U(blurP, 'uDir'), 0, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.enable(gl.DEPTH_TEST);
  return strength;
}

/** Binds the AO result for the main pass. */
export function bindAO(gl: WebGL2RenderingContext): void {
  if (!res) return;
  gl.activeTexture(gl.TEXTURE0 + AO_UNIT); gl.bindTexture(gl.TEXTURE_2D, res.a.tex); gl.activeTexture(gl.TEXTURE0);
}
