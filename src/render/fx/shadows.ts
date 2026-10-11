// Sun shadows (L-03): one depth map from the world-fixed sun, fitted to what the view can show.
//
// Fitting (fitShadow, pure): the camera's view box (its rectangle x the depth range) is cut down to
// the scene's box (stretched down to the ground and out by the shadow's reach, so shadows on the
// ground count), and that region's corners are projected into light space. The light box's side is
// rounded up to a power of sqrt 2 and its centre snapped to whole texels, so while the camera orbits
// or pans the map's texels stay put in the world (no shimmering) and only change on a size step.
// The depth range covers the whole scene, so casters outside the view still cast into it.
//
// The map is redrawn only when its key changes (light box, scene revision, focus, LOD level): a
// still sun over a still scene costs nothing per frame. PCF: 4 / 8 / 12 hardware-compared taps.

import type { ViewCull } from '../instances.ts';
import { SHADOW_UNIT } from '../gl.ts';
import type { V3 } from './atmos.ts';

export interface ShadowFit {
  /** light view (rows: right, up, toward the sun; GL axes), column-major like S.view */
  view: Float32Array;
  /** light projection x view */
  vp: Float32Array;
  /** vp mapped to [0, 1] texture space (the shader's uShadowMat) */
  tex: Float32Array;
  /** the culling rectangle in light-view coordinates */
  cull: ViewCull;
  /** world size of one texel (viewer units) */
  texel: number;
  key: string;
}

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** The light's view basis for direction L (toward the light): right, up, back (= L). */
export function lightBasis(L: V3): [V3, V3, V3] {
  const z = norm(L), ref: V3 = Math.abs(z[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const x = norm(cross(ref, z)), y = cross(z, x);
  return [x, y, z];
}

/**
 * Fits the shadow map. view: the camera view (column-major, GL axes); rect: the camera's view-plane
 * rectangle and depth half-range (render origin frame); scene: the box of everything that casts
 * (GL axes, render origin frame: [x0, y0, z0, x1, y1, z1]); groundY: the ground's GL y (receivers
 * there too); size: map texels.
 */
export function fitShadow(L: V3, view: ArrayLike<number>, rect: { x0: number; x1: number; y0: number; y1: number; depth: number },
  scene: readonly number[], groundY: number, size: number): ShadowFit | null {
  if (!(scene[0]! <= scene[3]!)) return null;
  const [lx, ly, lz] = lightBasis(L);
  // receivers: the scene box, down to the ground, widened by how far its top can throw a shadow
  const top = scene[4]!, low = Math.min(scene[1]!, groundY);
  const reach = Math.min((top - low) * Math.sqrt(Math.max(0, 1 - L[1] * L[1])) / Math.max(L[1], 0.2), 4 * Math.max(scene[3]! - scene[0]!, scene[5]! - scene[2]!, top - low, 1));
  const rb = [scene[0]! - reach, low, scene[2]! - reach, scene[3]! + reach, top, scene[5]! + reach];
  // the camera's view box as a world box (its 8 corners), cut down to the receivers
  const R = [view[0]!, view[4]!, view[8]!], U = [view[1]!, view[5]!, view[9]!], B = [view[2]!, view[6]!, view[10]!];
  const vb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const a = c & 1 ? rect.x1 : rect.x0, b = c & 2 ? rect.y1 : rect.y0, d = c & 4 ? rect.depth : -rect.depth;
    for (let i = 0; i < 3; i++) { const v = a * R[i]! + b * U[i]! + d * B[i]!; vb[i] = Math.min(vb[i]!, v); vb[i + 3] = Math.max(vb[i + 3]!, v); }
  }
  const box = [0, 1, 2].flatMap((i) => [Math.max(vb[i]!, rb[i]!), Math.min(vb[i + 3]!, rb[i + 3]!)]);
  if (box[0]! > box[1]! || box[2]! > box[3]! || box[4]! > box[5]!) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let c = 0; c < 8; c++) {
    const p = [box[c & 1 ? 1 : 0]!, box[c & 2 ? 3 : 2]!, box[c & 4 ? 5 : 4]!];
    const u = dot(p, lx), v = dot(p, ly);
    x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
  }
  // casters: the whole scene box along the light
  let z0 = Infinity, z1 = -Infinity;
  for (let c = 0; c < 8; c++) {
    const p = [c & 1 ? scene[3]! : scene[0]!, c & 2 ? scene[4]! : Math.min(scene[1]!, groundY), c & 4 ? scene[5]! : scene[2]!];
    const w = dot(p, lz); z0 = Math.min(z0, w); z1 = Math.max(z1, w);
  }
  z0 -= 1; z1 += 1;
  // stable texels: side rounded up to a power of sqrt 2, centre snapped to the texel grid
  const side = Math.pow(Math.SQRT2, Math.ceil(Math.log(Math.max(x1 - x0, y1 - y0, 0.5) * 1.02) / Math.log(Math.SQRT2)));
  const texel = side / size;
  const cx = Math.round((x0 + x1) / 2 / texel) * texel, cy = Math.round((y0 + y1) / 2 / texel) * texel;
  const h = side / 2;
  const view4 = new Float32Array([lx[0], ly[0], lz[0], 0, lx[1], ly[1], lz[1], 0, lx[2], ly[2], lz[2], 0, 0, 0, 0, 1]);
  // ortho: x, y to [-1, 1] around (cx, cy); depth 0 at z1 (nearest the light) to 1 at z0
  const sx = 1 / h, sz = -2 / (z1 - z0);
  const proj = [sx, 0, 0, 0, 0, sx, 0, 0, 0, 0, sz, 0, -cx * sx, -cy * sx, (z1 + z0) / (z1 - z0), 1];
  const vp = mul4(proj, view4);
  const bias = [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0.5, 0.5, 0.5, 1];
  const zr = Math.max(Math.abs(z0), Math.abs(z1));
  return {
    view: view4, vp, tex: mul4(bias, vp), texel,
    cull: { x0: cx - h, x1: cx + h, y0: cy - h, y1: cy + h, depth: zr },
    key: `${lx.join()}|${ly.join()}|${cx},${cy},${side},${z0.toFixed(3)},${z1.toFixed(3)}`,
  };
}

/** column-major 4x4 a * b */
export function mul4(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
    o[c * 4 + r] = s;
  }
  return o;
}

// ----------------------------------------------------------------------------------- GPU side
let map: { fb: WebGLFramebuffer; tex: WebGLTexture; size: number } | null = null;
let drawnKey = '';

/** The depth map of `size` texels (re-created on a size change); null when it can't be made. */
function target(gl: WebGL2RenderingContext, size: number): typeof map {
  if (map && map.size === size) return map;
  if (map) { gl.deleteFramebuffer(map.fb); gl.deleteTexture(map.tex); map = null; }
  const tex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);      // never bound while it is being drawn into
  if (!ok) { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); return null; }
  drawnKey = '';
  return (map = { fb, tex, size });
}

/** map size for a quality level 1..3, capped by the GPU */
export const shadowSize = (gl: WebGL2RenderingContext, q: number): number =>
  Math.min(q >= 3 ? 4096 : q >= 2 ? 2048 : 1024, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
export const shadowTaps = (q: number): number => (q >= 3 ? 12 : q >= 2 ? 8 : 4);

/**
 * Draws the shadow map if `key` (the fit's key plus the scene's state) changed. drawCasters draws
 * the opaque bodies with the brick program in depth-only mode, culled by the rectangle it's given;
 * the caller has set uMVP. Returns false when there is no map.
 */
export function renderShadow(gl: WebGL2RenderingContext, size: number, key: string, drawCasters: () => void): boolean {
  const t = target(gl, size);
  if (!t) return false;
  if (key === drawnKey) return true;
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
  gl.viewport(0, 0, t.size, t.size);
  gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.colorMask(false, false, false, false);
  gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2, 4);
  drawCasters();
  gl.colorMask(true, true, true, true);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  drawnKey = key;
  return true;
}

/** Binds the map for the main pass. */
export function bindShadow(gl: WebGL2RenderingContext): void {
  if (!map) return;
  gl.activeTexture(gl.TEXTURE0 + SHADOW_UNIT); gl.bindTexture(gl.TEXTURE_2D, map.tex); gl.activeTexture(gl.TEXTURE0);
}

/** Forget the drawn map (context changes, tests). */
export const invalidateShadow = (): void => { drawnKey = ''; };
