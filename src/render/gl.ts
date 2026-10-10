// WebGL2 context, the brick program and its fixed attribute slots.

import { BRICK_FS, BRICK_VS } from './shaders/brick.ts';

/**
 * Fixed attribute slots. Attribute 0 stays an enabled, non-instanced array. The i* slots are the
 * 24-byte instance record (render/instances.ts): iPos int16 x4, iHalf uint16 x4, iColor unorm8 x4,
 * iMisc uint8 x4.
 */
export const LOC = { aPos: 0, aNrm: 1, aSlope: 2, iPos: 3, iHalf: 4, iColor: 5, iMisc: 6, aPart: 7, aCap: 8 } as const;

const UNIFORMS = ['uMVP', 'uChunkOffset', 'uBox', 'uUnitDiv', 'uEdge', 'uLine', 'uFadeC', 'uFadeR', 'uStudFade', 'uBevelMax', 'uBevelFit',
  'uEye', 'uLight', 'uSun', 'uSky', 'uFloor', 'uExposure', 'uBump', 'uMat', 'uIntensity', 'uMatPass', 'uTime'] as const;
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

/** null when WebGL2 isn't available (the page then points at the legacy viewer). */
export function createGfx(canvas: HTMLCanvasElement): Gfx | null {
  const gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, BRICK_VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, BRICK_FS));
  for (const [name, loc] of Object.entries(LOC)) gl.bindAttribLocation(prog, loc, name);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'program link failed');
  gl.useProgram(prog);
  const u = {} as Uniforms;
  for (const n of UNIFORMS) u[n] = gl.getUniformLocation(prog, n);
  gl.uniform1f(u.uUnitDiv, 50);                  // units per viewer unit (1 / BRZ_UNIT)
  return { gl, prog, u };
}
