// Bloom around glow bricks (full build only; backlog L-02). The fitted kernel (materials.ts
// GLOW_BLOOM) is a sum of three normalised Gaussians of the linear emission, sigma a fraction of
// the viewport width:
//   1. the emission buffer: a half-resolution RGBA16F target with its own depth. The opaque bodies
//      go in depth only, then the glow bricks write their linear emission (so hidden glow doesn't
//      bloom); then a mip chain;
//   2. per Gaussian: a separable blur (horizontal, then vertical) at the mip level where sigma is a
//      few texels;
//   3. composite: the weighted sum, tone-mapped, screen-blended onto the frame (the forward pipeline
//      has no linear buffer to add it to before the tone map, so this is the display-space stand-in).
// Needs EXT_color_buffer_float; without it there is no bloom.

import { G } from './draw.ts';
import { perfMark } from './perf.ts';
import { GLOW_BLOOM } from './materials.ts';
import { TONEMAP_GLSL } from './shaders/tonemap.ts';

const VS = `#version 300 es
out vec2 vUv;
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p*2.0 - 1.0, 0.0, 1.0); }`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform float uLod; uniform vec2 uDir; uniform float uSigma;
void main(){
  vec2 px = uDir / vec2(textureSize(uTex, int(uLod)));
  int r = int(ceil(3.0*uSigma));
  vec3 s = vec3(0.0); float wsum = 0.0;
  for (int i = -48; i <= 48; i++) {
    if (i < -r || i > r) continue;
    float w = exp(-0.5*float(i*i)/(uSigma*uSigma));
    s += w * textureLod(uTex, vUv + px*float(i), uLod).rgb; wsum += w;
  }
  o = vec4(s / wsum, 1.0);
}`;

const COMP_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uB0, uB1, uB2; uniform vec3 uW;
${TONEMAP_GLSL}
void main(){
  vec3 b = uW.x*texture(uB0, vUv).rgb + uW.y*texture(uB1, vUv).rgb + uW.z*texture(uB2, vUv).rgb;
  o = vec4(max(ueFilmic(b) - ueFilmic(vec3(0.0)), 0.0), 1.0);   // no haze where there is no bloom
}`;

interface Target { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }

let ok: boolean | null = null;
let blurP: WebGLProgram, compP: WebGLProgram;
let emit: (Target & { depth: WebGLRenderbuffer }) | null = null;
let tmp: Target[] = [], out: Target[] = [];
let size = '';

function program(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [t, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(t)!; gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'bloom shader');
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'bloom program');
  return p;
}

function texture(gl: WebGL2RenderingContext, w: number, h: number, mips: boolean): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function target(gl: WebGL2RenderingContext, w: number, h: number, mips = false): Target {
  const tex = texture(gl, w, h, mips), fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fb, tex, w, h };
}

function free(gl: WebGL2RenderingContext): void {
  for (const t of [...tmp, ...out, ...(emit ? [emit] : [])]) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
  if (emit) gl.deleteRenderbuffer(emit.depth);
  emit = null; tmp = []; out = [];
}

/** mip level for a Gaussian of sigma px (at the emission buffer's size): sigma at that level ~4 texels */
const levelFor = (sigma: number): number => Math.max(0, Math.min(6, Math.round(Math.log2(Math.max(1, sigma / 4)))));

function setup(gl: WebGL2RenderingContext, w: number, h: number): boolean {
  if (ok === null) {
    ok = !!gl.getExtension('EXT_color_buffer_float');
    if (ok) { try { blurP = program(gl, BLUR_FS); compP = program(gl, COMP_FS); } catch (e) { console.warn('bloom off', e); ok = false; } }
  }
  if (!ok) return false;
  const ew = Math.max(1, w >> 1), eh = Math.max(1, h >> 1), key = `${ew}x${eh}`;
  if (key === size && emit) return true;
  free(gl);
  const t = target(gl, ew, eh, true), depth = gl.createRenderbuffer()!;
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, ew, eh);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  emit = { ...t, depth };
  for (const k of GLOW_BLOOM) {
    const L = levelFor(k.sigma * ew), lw = Math.max(1, ew >> L), lh = Math.max(1, eh >> L);
    tmp.push(target(gl, lw, lh)); out.push(target(gl, lw, lh));
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  size = key;
  return true;
}

function fullscreen(gl: WebGL2RenderingContext): void { gl.drawArrays(gl.TRIANGLES, 0, 3); }

/**
 * The bloom pass (pipeline.ts). drawDepth draws the opaque bodies, drawEmission the glow bricks
 * with linear emission; both with the brick program and its uniforms as the frame left them.
 */
export function bloom(w: number, h: number, drawDepth: () => void, drawEmission: () => void): void {
  const { gl } = G;
  if (!setup(gl, w, h) || !emit) return;
  // 1. emission buffer
  gl.bindFramebuffer(gl.FRAMEBUFFER, emit.fb);
  gl.viewport(0, 0, emit.w, emit.h);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND);
  gl.colorMask(false, false, false, false); drawDepth();
  perfMark('bloomEmit');
  gl.colorMask(true, true, true, true); drawEmission();
  perfMark('bloomBlur');
  gl.disable(gl.POLYGON_OFFSET_FILL); gl.disable(gl.DEPTH_TEST);
  gl.bindTexture(gl.TEXTURE_2D, emit.tex); gl.generateMipmap(gl.TEXTURE_2D);
  // 2. blur each Gaussian at its level
  gl.useProgram(blurP);
  gl.activeTexture(gl.TEXTURE0);
  const uTex = gl.getUniformLocation(blurP, 'uTex'), uLod = gl.getUniformLocation(blurP, 'uLod');
  const uDir = gl.getUniformLocation(blurP, 'uDir'), uSigma = gl.getUniformLocation(blurP, 'uSigma');
  gl.uniform1i(uTex, 0);
  GLOW_BLOOM.forEach((k, i) => {
    const L = levelFor(k.sigma * emit!.w), sig = Math.min(16, (k.sigma * emit!.w) / 2 ** L), a = tmp[i]!, b = out[i]!;
    gl.uniform1f(uSigma, sig);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb); gl.viewport(0, 0, a.w, a.h);
    gl.bindTexture(gl.TEXTURE_2D, emit!.tex); gl.uniform1f(uLod, L); gl.uniform2f(uDir, 1, 0); fullscreen(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
    gl.bindTexture(gl.TEXTURE_2D, a.tex); gl.uniform1f(uLod, 0); gl.uniform2f(uDir, 0, 1); fullscreen(gl);
  });
  // 3. composite onto the frame
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
  gl.useProgram(compP);
  out.forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.uniform1i(gl.getUniformLocation(compP, `uB${i}`), i); });
  gl.uniform3f(gl.getUniformLocation(compP, 'uW'), GLOW_BLOOM[0]!.weight, GLOW_BLOOM[1]!.weight, GLOW_BLOOM[2]!.weight);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); gl.depthMask(false);
  fullscreen(gl);
  // back to the frame's state
  for (let i = 2; i >= 0; i--) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, null); }
  gl.disable(gl.BLEND); gl.depthMask(true);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.clearColor(0.169, 0.173, 0.188, 1);
  gl.useProgram(G.prog);
}
