// WebGL2 context, the brick program and its fixed attribute slots.

import { BRICK_FS, BRICK_VS } from './shaders/brick.ts';

/**
 * Fixed attribute slots. Attribute 0 stays an enabled, non-instanced array. The i* slots are the
 * 24-byte instance record (render/instances.ts): iPos int16 x4, iHalf uint16 x4, iColor unorm8 x4,
 * iMisc uint8 x4.
 */
export const LOC = { aPos: 0, aNrm: 1, aSlope: 2, iPos: 3, iHalf: 4, iColor: 5, iMisc: 6, aPart: 7, aCap: 8 } as const;

const UNIFORMS = ['uMVP', 'uChunkOffset', 'uBox', 'uUnitDiv', 'uEdge', 'uLine', 'uFadeC', 'uFadeR', 'uStudFade', 'uBevelMax', 'uBevelFit',
  'uEye', 'uLight', 'uSun', 'uSky', 'uFloor', 'uExposure', 'uBump', 'uMat', 'uIntensity', 'uMatPass',
  'uCutA', 'uCutK', 'uCutLo', 'uCutHi', 'uCutOff', 'uCutEdge'] as const;
export type UniformName = (typeof UNIFORMS)[number];
export type Uniforms = Record<UniformName, WebGLUniformLocation | null>;

export interface Gfx {
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  u: Uniforms;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const o = gl.createShader(type)!;
  gl.shaderSource(o, src); gl.compileShader(o);
  if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o) ?? 'shader compile failed');
  return o;
}

function link(gl: WebGL2RenderingContext, fs: string): { prog: WebGLProgram; u: Uniforms } {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, BRICK_VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  for (const [name, loc] of Object.entries(LOC)) gl.bindAttribLocation(prog, loc, name);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'program link failed');
  const u = {} as Uniforms;
  for (const n of UNIFORMS) u[n] = gl.getUniformLocation(prog, n);
  return { prog, u };
}

/** null when WebGL2 isn't available (the page then points at the legacy viewer). */
export function createGfx(canvas: HTMLCanvasElement): Gfx | null {
  const gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) return null;
  const { prog, u } = link(gl, BRICK_FS);
  gl.useProgram(prog);
  gl.uniform1f(u.uUnitDiv, 50);                  // units per viewer unit (1 / BRZ_UNIT)
  variants.set(false, { prog, u: { ...u } });
  return { gl, prog, u };
}

// The brick program's two variants: plain, and CUT (the X-ray cutaway's discard, render/cutaway.ts).
// The CUT one is linked the first time it's asked for.
const variants = new Map<boolean, { prog: WebGLProgram; u: Uniforms }>();

/**
 * Makes the plain or the CUT brick program current (G.prog / G.u follow it). On a switch every
 * uniform value is copied across, so state set once (or set earlier this frame) carries over.
 */
export function useBrickVariant(G: Gfx, cut: boolean): void {
  const { gl } = G;
  let v = variants.get(cut);
  if (!v) { v = link(gl, BRICK_FS.replace('#version 300 es\n', '#version 300 es\n#define CUT 1\n')); variants.set(cut, v); }
  if (v.prog === G.prog) return;
  const old = G.prog, oldU = { ...G.u };
  gl.useProgram(v.prog);
  for (const n of UNIFORMS) {
    const from = oldU[n], to = v.u[n];
    if (!from || !to) continue;
    const val: unknown = gl.getUniform(old, from);
    if (typeof val === 'number') gl.uniform1f(to, val);
    else if (val instanceof Float32Array) {
      if (val.length === 16) gl.uniformMatrix4fv(to, false, val);
      else if (val.length === 4) gl.uniform4fv(to, val);
      else if (val.length === 3) gl.uniform3fv(to, val);
      else if (val.length === 2) gl.uniform2fv(to, val);
    }
  }
  G.prog = v.prog; Object.assign(G.u, v.u);
}
