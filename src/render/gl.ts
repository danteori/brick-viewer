// WebGL2 context, the brick program and its fixed attribute slots.

import { BRICK_FS, BRICK_VS } from './shaders/brick.ts';

/**
 * Fixed attribute slots. Attribute 0 stays an enabled, non-instanced array. The i* slots are the
 * 24-byte instance record (render/instances.ts): iPos int16 x4, iHalf uint16 x4, iColor unorm8 x4,
 * iMisc uint8 x4.
 */
/** Texture unit the shape-template table (render/meshes/registry.ts) stays bound to. */
export const PULL_UNIT = 7;
/** Texture units of the graphics effects' shadow map and AO texture (render/fx), bound while drawing. */
export const SHADOW_UNIT = 5, AO_UNIT = 6;

export const LOC = { aPos: 0, aNrm: 1, aSlope: 2, iPos: 3, iHalf: 4, iColor: 5, iMisc: 6, aPart: 7, aCap: 8 } as const;

const UNIFORMS = ['uMVP', 'uChunkOffset', 'uBox', 'uUnitDiv', 'uEdge', 'uLine', 'uFadeC', 'uFadeR', 'uStudFade', 'uBevelMax', 'uBevelFit',
  'uEye', 'uLight', 'uSun', 'uSky', 'uFloor', 'uExposure', 'uBump', 'uMat', 'uIntensity', 'uMatPass',
  'uTime', 'uSpecAA', 'uCutA', 'uCutK', 'uCutLo', 'uCutHi', 'uCutOff', 'uCutEdge', 'uCutInv', 'uRoomLo', 'uRoomHi', 'uRoomT', 'uShowHidden', 'uPull',
  // graphics effects (FX variant only; render/fx/glsl.ts)
  'uShadowMat', 'uShadowP', 'uShadowL', 'uAOP', 'uFogEye', 'uFogP', 'uFogColor', 'uWaterP', 'uWaterExt', 'uWaterIn', 'uWaterFogColor', 'uViewDir'] as const;
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

function link(gl: WebGL2RenderingContext, fs: string, vs = BRICK_VS): { prog: WebGLProgram; u: Uniforms } {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  for (const [name, loc] of Object.entries(LOC)) gl.bindAttribLocation(prog, loc, name);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'program link failed');
  const u = {} as Uniforms;
  for (const n of UNIFORMS) u[n] = gl.getUniformLocation(prog, n);
  // the template table's sampler (render/meshes/registry.ts) reads its own unit, set once here
  const cur = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  gl.useProgram(prog); gl.uniform1i(gl.getUniformLocation(prog, 'uVtx'), PULL_UNIT);
  gl.uniform1i(gl.getUniformLocation(prog, 'uShadowMap'), SHADOW_UNIT); gl.uniform1i(gl.getUniformLocation(prog, 'uAO'), AO_UNIT);
  gl.useProgram(cur);
  return { prog, u };
}

/** null when WebGL2 isn't available (the page then points at the legacy viewer). */
export function createGfx(canvas: HTMLCanvasElement): Gfx | null {
  const gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) return null;
  const { prog, u } = link(gl, BRICK_FS);
  gl.useProgram(prog);
  gl.uniform1f(u.uUnitDiv, 50);                  // units per viewer unit (1 / BRZ_UNIT)
  variants.set('', { prog, u: { ...u } });
  return { gl, prog, u };
}

// The brick program's variants: plain, CUT (the X-ray cutaway's per-brick hiding, render/cutaway.ts)
// and FX (the graphics effects, render/fx), alone or together. Each is linked the first time it's
// asked for.
const variants = new Map<string, { prog: WebGLProgram; u: Uniforms }>();

/**
 * Makes the plain, CUT and / or FX brick program current (G.prog / G.u follow it). On a switch every
 * uniform value is copied across, so state set once (or set earlier this frame) carries over.
 */
export function useBrickVariant(G: Gfx, cut: boolean, fx = false): void {
  const { gl } = G;
  const key = (cut ? 'C' : '') + (fx ? 'F' : '');
  let v = variants.get(key);
  if (!v) {
    const defs = (cut ? '#define CUT 1\n' : '') + (fx ? '#define FX 1\n' : '');
    const def = (src: string): string => src.replace('#version 300 es\n', '#version 300 es\n' + defs);
    v = link(gl, def(BRICK_FS), def(BRICK_VS)); variants.set(key, v);
  }
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
