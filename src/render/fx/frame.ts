// The graphics effects in a frame (L-03), called from render/pipeline.ts at three points:
//   fxLight     after the light uniforms: the world-fixed sun replaces the camera-relative light;
//   fxPrepass   after the scene sync and LOD pick: the shadow map and SSAO passes (offscreen), the
//               brick program's FX uniforms, then the sky (the background);
//   fxWater     after the opaque bodies and the ground: the water surface.
// With the effects off none of these run and the brick program is the plain one, so the frame is
// exactly the pipeline's original one.

import { S } from '../../app/state.ts';
import { BRZ_UNIT } from '../../core/units.ts';
import { G } from '../draw.ts';
import { useBrickVariant } from '../gl.ts';
import { inst, lodStats, type ViewCull } from '../instances.ts';
import { boxIB } from '../meshes/registry.ts';
import { atmosphere, skyFogDepth, type Atmos, type LightIn, type V3, VIEW_TO_UU } from './atmos.ts';
import type { ShadowFit } from './shadows.ts';
import type * as Shadows from './shadows.ts';
import type * as Ssao from './ssao.ts';
import { drawSky, drawWater, type SkyUniforms } from './skypass.ts';
import { fx, fxEffective, type FxEff } from './state.ts';
import { SHADOW_UNIT } from '../gl.ts';
import { perfMark } from '../perf.ts';

/** What the pipeline knows about the frame. */
export interface FxCtx {
  w: number; h: number;
  /** ortho projection (with the frame's depth range) and the camera view; their product */
  ortho: Float32Array; view: Float32Array; mvp: Float32Array;
  half: number; fx: number; fy: number; zr: number;
  cull: ViewCull;
  lodLevel: number; cutOn: boolean;
  light: LightIn; presetKey: string;
  /** draws the opaque bodies (depth-only passes) culled by the given rectangle; ground: include the near ground plate */
  drawOpaque: (cull: ViewCull, ground: boolean) => void;
}

/**
 * The heavy passes, installed by the full build only (main.full.ts), so the lite build carries the
 * sky, fog, water and world-fixed sun but not the shadow map or SSAO code.
 */
let heavy: { shadows: typeof Shadows; ssao: typeof Ssao } | null = null;
export function installFxPasses(shadows: typeof Shadows, ssao: typeof Ssao): void { heavy = { shadows, ssao }; fx.supported = true; }

let eff: FxEff = { on: false, shadows: 0, ssao: 0, waves: 0 };
let atm: Atmos | null = null;
let sky: SkyUniforms | null = null;
let waterOn = false;

/** Is the FX path on this frame (decided once, at the top of the frame)? */
export function fxFrameOn(): boolean {
  eff = fxEffective();
  return eff.on;
}

const v3 = (a: ArrayLike<number>, i: number, j: number, k: number): V3 => [a[i]!, a[j]!, a[k]!];

/** The world-fixed sun: the light direction and colour uniforms. */
export function fxLight(light: LightIn, presetKey: string): void {
  atm = atmosphere(light, presetKey, fx.env);
  const { gl, u } = G;
  gl.uniform3f(u.uLight, atm.sunDir[0], atm.sunDir[1], atm.sunDir[2]);
  gl.uniform3fv(u.uSun, atm.sun);
}

/** The scene's casting box (GL axes, render-origin frame): every chunk plus the focused brick. */
function sceneBox(): number[] {
  const b = inst.set!.bounds, off = inst.set!.opts.offset, o = S.origin;
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const grow = (X: number, Y: number, Z: number): void => {
    const g = [X - o[0], Z - o[2], Y - o[1]];
    for (let i = 0; i < 3; i++) { box[i] = Math.min(box[i]!, g[i]!); box[i + 3] = Math.max(box[i + 3]!, g[i]!); }
  };
  if (b[0]! <= b[3]!) for (const c of [0, 7]) grow(((c & 1 ? b[3]! : b[0]!) + (off?.[0] ?? 0)) * BRZ_UNIT, ((c & 2 ? b[4]! : b[1]!) + (off?.[1] ?? 0)) * BRZ_UNIT, ((c & 4 ? b[5]! : b[2]!) + (off?.[2] ?? 0)) * BRZ_UNIT);
  if (S.focus) { grow(S.dlo[0]!, S.dlo[1]!, S.dlo[2]!); grow(S.dhi[0]!, S.dhi[1]!, S.dhi[2]!); }
  return box;
}

/** What the depth passes depend on besides the camera / light. */
const sceneKey = (c: FxCtx): string => `${inst.rev}|${S.sel}|${S.dlo.join()}|${S.dhi.join()}|${c.lodLevel}|${c.cutOn ? 1 : 0}|${lodStats.built}|${S.hidden.size}|${S.ground?.visible ? 1 : 0}`;

let aoKey = '', aoStrength = 0;
let lastFit: ShadowFit | null = null;

export function fxPrepass(c: FxCtx): void {
  if (!atm) return;
  const { gl, u } = G;
  const view = c.view, B = v3(view, 2, 6, 10), R = v3(view, 0, 4, 8), U = v3(view, 1, 5, 9);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.uniform1f(u.uEdge, 1);                 // depth-only draws take the shader's early exit
  // ---- sun shadows
  let shadowOn = false, fit: ShadowFit | null = null;
  const sunUp = atm.sunDir[1] > 0.02 && (atm.sun[0] + atm.sun[1] + atm.sun[2]) > 1e-3;
  if (heavy && eff.shadows > 0 && sunUp) {
    const { fitShadow, renderShadow, shadowSize } = heavy.shadows;
    perfMark('fxShadow');
    const size = shadowSize(gl, eff.shadows);
    fit = fitShadow(atm.sunDir, view, { x0: c.cull.x0, x1: c.cull.x1, y0: c.cull.y0, y1: c.cull.y1, depth: c.zr }, sceneBox(), -S.origin[2], size);
    if (fit) {
      gl.activeTexture(gl.TEXTURE0 + SHADOW_UNIT); gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);   // no feedback loop
      const keep = S.view;
      shadowOn = renderShadow(gl, size, `${fit.key}|${size}|${sceneKey(c)}`, () => {
        gl.uniformMatrix4fv(u.uMVP, false, fit!.vp);
        S.view = fit!.view as typeof S.view;
        try { c.drawOpaque(fit!.cull, false); } finally { S.view = keep; }
      });
      gl.uniformMatrix4fv(u.uMVP, false, c.mvp);
    }
  }
  lastFit = fit;
  // ---- SSAO
  aoStrength = 0;
  if (heavy && eff.ssao > 0) {
    const { renderAO } = heavy.ssao;
    perfMark('fxAO');
    const key = `${Array.from(c.mvp).map((x) => x.toFixed(6)).join()}|${c.w}x${c.h}|${eff.ssao}|${sceneKey(c)}`;
    if (key !== aoKey) {
      aoStrength = renderAO(gl, c.w, c.h, { extX: c.half * c.fx, extY: c.half * c.fy, zr: c.zr, samples: [0, 6, 10, 14][eff.ssao]! }, () => c.drawOpaque(c.cull, true));
      aoKey = aoStrength > 0 ? key : '';
      lastAo = aoStrength;
      gl.useProgram(G.prog);
    } else aoStrength = lastAo;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, c.w, c.h);
  gl.uniform1f(u.uEdge, 0);
  perfMark('fxSky');
  // ---- the brick program's FX uniforms
  if (heavy && shadowOn && fit) {
    const { bindShadow, shadowSize, shadowTaps } = heavy.shadows;
    bindShadow(gl);
    const size = shadowSize(gl, eff.shadows);
    gl.uniformMatrix4fv(u.uShadowMat, false, fit.tex);
    gl.uniform4f(u.uShadowP, 1, 1 / size, fit.texel * 1.5, shadowTaps(eff.shadows));
    gl.uniform3fv(u.uShadowL, atm.sunDir);
  } else gl.uniform4f(u.uShadowP, 0, 0, 0, 0);
  if (heavy && aoStrength > 0) { heavy.ssao.bindAO(gl); gl.uniform4f(u.uAOP, 1, 1 / c.w, 1 / c.h, aoStrength); } else gl.uniform4f(u.uAOP, 0, 0, 0, 0);
  // virtual perspective camera: looks along -B through the view centre at the focused brick's depth,
  // from the distance where its field of view frames the view's height
  const tanX = Math.tan((fx.want.fov * Math.PI) / 360), asp = c.w / c.h, tanY = tanX / Math.max(asp, 1e-3);
  const fc = [(S.dlo[0]! + S.dhi[0]!) / 2 - S.origin[0], (S.dlo[2]! + S.dhi[2]!) / 2 - S.origin[2], (S.dlo[1]! + S.dhi[1]!) / 2 - S.origin[1]];
  // ASSUMED: the eye stays within FOG_EYE_MAX of the focus however far the view zooms out (a
  // player's camera is near what they look at), so a zoomed-out map isn't drowned in fog
  const depth = fc[0]! * B[0] + fc[1]! * B[1] + fc[2]! * B[2], D = Math.min(FOG_EYE_MAX, (c.half * c.fy) / tanY);
  const eye = [0, 1, 2].map((i) => R[i]! * S.cam.x + U[i]! * S.cam.y + B[i]! * (depth + D)) as V3;
  const eyeZuu = (eye[1] + S.origin[2]) * VIEW_TO_UU;
  const fogOn = atm.fogDensity > 0;
  const d0 = atm.fogDensity * Math.exp(-atm.fogFalloff * eyeZuu) * VIEW_TO_UU;
  gl.uniform3fv(u.uFogEye, eye);
  gl.uniform4f(u.uFogP, d0, atm.fogFalloff * VIEW_TO_UU, fogOn ? 1 : 0, 0);
  gl.uniform3fv(u.uFogColor, atm.fogColor);
  gl.uniform3f(u.uViewDir, -B[0], -B[1], -B[2]);
  const W = atm.water;
  const hGl = W ? W.height / VIEW_TO_UU - S.origin[2] : 0;
  waterOn = !!W;
  if (W) {
    gl.uniform4f(u.uWaterP, hGl, 1, W.fogDensity * VIEW_TO_UU, 0);
    gl.uniform3fv(u.uWaterExt, W.extinction.map((e) => e * VIEW_TO_UU));
    gl.uniform3fv(u.uWaterIn, W.inscatter);
    gl.uniform3fv(u.uWaterFogColor, W.fogColor);
  } else gl.uniform4f(u.uWaterP, 0, 0, 0, 0);
  // ---- the sky (background)
  const F: V3 = [-B[0], -B[1], -B[2]];
  sky = {
    exposure: c.light.exposure, camF: F, camR: R, camU: U, tan: [tanX, tanY],
    zenith: atm.zenith, fog: atm.fogColor, sunDir: atm.sunDir, sunDisc: atm.sunDisc, stars: atm.stars,
    skyP: [Math.min(50, skyFogDepth(atm, eyeZuu, 1)), Math.cos(atm.sunRadius), 0, atm.space ? 1 : 0],
  };
  const lookDown = B[1] > 0;
  drawSky(gl, sky, W && lookDown ? W.fogColor : null);
  gl.useProgram(G.prog);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
}

let lastAo = 0;
/** the virtual eye's farthest distance from the focus (viewer units; 100 = 50 m) */
const FOG_EYE_MAX = 100;

/** Settings changed: redraw the shadow map and the AO next frame. */
export function invalidateFx(): void { aoKey = ''; heavy?.shadows.invalidateShadow(); }

/** The water surface (after the opaque bodies and the ground plate). */
export function fxWater(c: FxCtx): void {
  if (!atm?.water || !waterOn || !sky) return;
  const B = v3(c.view, 2, 6, 10);
  if (B[1] <= 0) return;                    // looking up from below: no surface drawn (no underwater view)
  const { gl } = G, W = atm.water;
  const inv = invert4(c.mvp);
  if (!inv) return;
  const wd = W.windDir;
  drawWater(gl, sky, {
    inv, mvp: c.mvp, height: W.height / VIEW_TO_UU - S.origin[2], time: S.testMode ? 0 : (performance.now() / 1000) % 3600,
    // a pixel's footprint on the water: stretched along the view by 1 / sin(pitch)
    px: (2 * c.half * c.fy) / c.h / Math.max(B[1], 0.03), origin: [S.origin[0], S.origin[2], S.origin[1]],
    wind: [Math.cos(wd), Math.sin(wd), W.wind], waves: eff.waves,
  });
  gl.useProgram(G.prog);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
}

/** Makes the FX (or plain) brick program current; the pipeline calls it once at the top of the frame. */
export function fxProgram(cutOn: boolean, on: boolean): void { useBrickVariant(G, cutOn, on); }

/** The last frame's shadow fit (test hook / debugging). */
export const fxDebug = (): { shadow: ShadowFit | null; ao: number; water: boolean; eff: FxEff } => ({ shadow: lastFit, ao: aoStrength, water: waterOn, eff });

/** column-major 4x4 inverse (null when singular) */
export function invert4(m: ArrayLike<number>): Float32Array | null {
  const a = Array.from(m), o = new Array<number>(16);
  o[0] = a[5]! * a[10]! * a[15]! - a[5]! * a[11]! * a[14]! - a[9]! * a[6]! * a[15]! + a[9]! * a[7]! * a[14]! + a[13]! * a[6]! * a[11]! - a[13]! * a[7]! * a[10]!;
  o[4] = -a[4]! * a[10]! * a[15]! + a[4]! * a[11]! * a[14]! + a[8]! * a[6]! * a[15]! - a[8]! * a[7]! * a[14]! - a[12]! * a[6]! * a[11]! + a[12]! * a[7]! * a[10]!;
  o[8] = a[4]! * a[9]! * a[15]! - a[4]! * a[11]! * a[13]! - a[8]! * a[5]! * a[15]! + a[8]! * a[7]! * a[13]! + a[12]! * a[5]! * a[11]! - a[12]! * a[7]! * a[9]!;
  o[12] = -a[4]! * a[9]! * a[14]! + a[4]! * a[10]! * a[13]! + a[8]! * a[5]! * a[14]! - a[8]! * a[6]! * a[13]! - a[12]! * a[5]! * a[10]! + a[12]! * a[6]! * a[9]!;
  o[1] = -a[1]! * a[10]! * a[15]! + a[1]! * a[11]! * a[14]! + a[9]! * a[2]! * a[15]! - a[9]! * a[3]! * a[14]! - a[13]! * a[2]! * a[11]! + a[13]! * a[3]! * a[10]!;
  o[5] = a[0]! * a[10]! * a[15]! - a[0]! * a[11]! * a[14]! - a[8]! * a[2]! * a[15]! + a[8]! * a[3]! * a[14]! + a[12]! * a[2]! * a[11]! - a[12]! * a[3]! * a[10]!;
  o[9] = -a[0]! * a[9]! * a[15]! + a[0]! * a[11]! * a[13]! + a[8]! * a[1]! * a[15]! - a[8]! * a[3]! * a[13]! - a[12]! * a[1]! * a[11]! + a[12]! * a[3]! * a[9]!;
  o[13] = a[0]! * a[9]! * a[14]! - a[0]! * a[10]! * a[13]! - a[8]! * a[1]! * a[14]! + a[8]! * a[2]! * a[13]! + a[12]! * a[1]! * a[10]! - a[12]! * a[2]! * a[9]!;
  o[2] = a[1]! * a[6]! * a[15]! - a[1]! * a[7]! * a[14]! - a[5]! * a[2]! * a[15]! + a[5]! * a[3]! * a[14]! + a[13]! * a[2]! * a[7]! - a[13]! * a[3]! * a[6]!;
  o[6] = -a[0]! * a[6]! * a[15]! + a[0]! * a[7]! * a[14]! + a[4]! * a[2]! * a[15]! - a[4]! * a[3]! * a[14]! - a[12]! * a[2]! * a[7]! + a[12]! * a[3]! * a[6]!;
  o[10] = a[0]! * a[5]! * a[15]! - a[0]! * a[7]! * a[13]! - a[4]! * a[1]! * a[15]! + a[4]! * a[3]! * a[13]! + a[12]! * a[1]! * a[7]! - a[12]! * a[3]! * a[5]!;
  o[14] = -a[0]! * a[5]! * a[14]! + a[0]! * a[6]! * a[13]! + a[4]! * a[1]! * a[14]! - a[4]! * a[2]! * a[13]! - a[12]! * a[1]! * a[6]! + a[12]! * a[2]! * a[5]!;
  o[3] = -a[1]! * a[6]! * a[11]! + a[1]! * a[7]! * a[10]! + a[5]! * a[2]! * a[11]! - a[5]! * a[3]! * a[10]! - a[9]! * a[2]! * a[7]! + a[9]! * a[3]! * a[6]!;
  o[7] = a[0]! * a[6]! * a[11]! - a[0]! * a[7]! * a[10]! - a[4]! * a[2]! * a[11]! + a[4]! * a[3]! * a[10]! + a[8]! * a[2]! * a[7]! - a[8]! * a[3]! * a[6]!;
  o[11] = -a[0]! * a[5]! * a[11]! + a[0]! * a[7]! * a[9]! + a[4]! * a[1]! * a[11]! - a[4]! * a[3]! * a[9]! - a[8]! * a[1]! * a[7]! + a[8]! * a[3]! * a[5]!;
  o[15] = a[0]! * a[5]! * a[10]! - a[0]! * a[6]! * a[9]! - a[4]! * a[1]! * a[10]! + a[4]! * a[2]! * a[9]! + a[8]! * a[1]! * a[6]! - a[8]! * a[2]! * a[5]!;
  const det = a[0]! * o[0]! + a[1]! * o[4]! + a[2]! * o[8]! + a[3]! * o[12]!;
  if (!det) return null;
  return new Float32Array(o.map((x) => x / det));
}
