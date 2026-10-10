// Special materials in the forward pipeline (backlog L-02; the maths is src/render/materials.ts):
//   - glow: opaque and unlit (emission only), drawn right after the opaque bodies;
//   - glass and translucent plastic: transparent, drawn after every opaque body, back to front
//     (farthest brick centre first), depth-tested without writing depth. Glass is two blended
//     passes per brick (multiply by its transmission, then add the Fresnel sky reflection);
//     translucent plastic is one alpha-blended pass.
// Those bricks sit in instance groups of their own (instances.ts), so a plastic-only scene draws
// exactly as before. The full build adds a bloom pass around glow bricks (render/bloom.ts).

import { S, hasFocus } from '../app/state.ts';
import type { Brick } from '../scene/brick.ts';
import { brickView } from '../scene/view.ts';
import { G, bodyShape, drawBody, type BodyShape } from './draw.ts';
import { inst } from './instances.ts';
import { MAT_GLASS, MAT_GLOW, MAT_TRANSLUCENT, matCode } from './matcode.ts';
import { boxIB } from './meshes/registry.ts';

/**
 * Up to this many glass / translucent / glow bricks are drawn one by one as before: glow, then the
 * transparent ones exactly back to front (brick centres). Above it (big builds: thousands of
 * one-brick draws cost hundreds of ms a frame) they come from the instance buffers instead: glow
 * instanced, glass order-independent (its multiply and add passes commute, as each brick's own
 * faces already did), translucent plastic sorted back to front per chunk, chunks back to front.
 */
export const EXACT_SPECIAL = 128;

type Item = { b: Brick; l: readonly number[]; h: readonly number[]; m: number; shape?: BodyShape; sel: boolean };

/** Brick views of the special rows, rebuilt when the instance data changes (exact path only). */
let cache: Item[] = [], cacheRev = -1, cacheScene: unknown = null;
function rows(): Item[] {
  if (cacheRev === inst.rev && cacheScene === S.scene) return cache;
  cacheRev = inst.rev; cacheScene = S.scene;
  const s = S.scene;
  cache = [];
  for (const id of inst.special) {
    if (!s.alive(id) || id === S.sel) continue;
    const b = brickView(s, id);
    cache.push({ b, l: b.lo, h: b.hi, m: matCode(b), shape: bodyShape(b, b.lo, b.hi, s.orient[id]), sel: S.selection.has(id) });
  }
  return cache;
}

/** The focused brick as an item when it has a special material and is shown. */
function focusItem(dlo: readonly number[], dhi: readonly number[]): Item | null {
  const f = S.focus;
  if (!hasFocus() || !f || S.hidden.has(S.sel)) return null;
  const m = matCode(f);
  return m ? { b: f, l: dlo, h: dhi, m, shape: bodyShape(f, dlo, dhi, S.scene.orient[S.sel]), sel: S.selection.has(S.sel) } : null;
}

const intensityOf = (b: Brick): number => b.intensity ?? 5;
const count = (m: number): number => inst.set?.matCount[m] ?? 0;
/** Few enough special bricks to draw them one by one (exactly as before instancing them). */
const exact = (): boolean => count(MAT_GLASS) + count(MAT_TRANSLUCENT) + count(MAT_GLOW) <= EXACT_SPECIAL;

/** True when this frame shows a glow brick (the bloom pass then runs): one in a chunk in view (inst.cull), or the focused one. */
export function hasGlow(): boolean {
  if (count(MAT_GLOW) && inst.set!.glowInView(inst.cull)) return true;
  return hasFocus() && !!S.focus && matCode(S.focus) === MAT_GLOW;
}

/** The focused brick is shown and glows. */
export const hasFocusGlow = (): boolean => hasFocus() && !!S.focus && !S.hidden.has(S.sel) && matCode(S.focus) === MAT_GLOW;

/** The focused brick is drawn here, not with the plain bodies, when it has a special material. */
export const focusIsSpecial = (): boolean => hasFocus() && !!S.focus && matCode(S.focus) > 0;

const draw = (it: Item): void => drawBody(it.b, it.l, it.h, it.sel ? 1 : 0, it.shape);

/** Instanced special rows of material m (uIntensity < 0: per-instance intensity), then the cube's elements re-bound. */
function drawSet(m: number, sorted = false): void {
  const { gl, u } = G;
  gl.uniform1f(u.uIntensity, -1);
  inst.set?.drawSpecial(m, inst.cull, sorted);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
}

/** Glow bricks only, with `pass` (0 display colour, 2 linear emission for the bloom buffer). */
export function drawGlow(dlo: readonly number[], dhi: readonly number[], pass = 0): void {
  const { gl, u } = G;
  gl.uniform1f(u.uMat, MAT_GLOW); gl.uniform1f(u.uMatPass, pass);
  const f = focusItem(dlo, dhi);
  if (exact()) {
    for (const it of f ? [...rows(), f] : rows()) if (it.m === MAT_GLOW) { gl.uniform1f(u.uIntensity, intensityOf(it.b)); draw(it); }
  } else {
    drawSet(MAT_GLOW);
    if (f && f.m === MAT_GLOW) { gl.uniform1f(u.uIntensity, intensityOf(f.b)); draw(f); }
  }
  gl.uniform1f(u.uMat, 0); gl.uniform1f(u.uMatPass, 0);
}

/** One transparent item: glass as its two passes, translucent plastic alpha-blended. */
function drawClear(it: Item): void {
  const { gl, u } = G;
  gl.uniform1f(u.uMat, it.m); gl.uniform1f(u.uIntensity, intensityOf(it.b));
  if (it.m === MAT_GLASS) {
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR); gl.uniform1f(u.uMatPass, 0); draw(it);
    gl.blendFunc(gl.ONE, gl.ONE); gl.uniform1f(u.uMatPass, 1); draw(it);
  } else {
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(u.uMatPass, 0); draw(it);
  }
}

/**
 * Draws glow, then the transparent bricks back to front (call after the opaque bodies, with the
 * body uniforms set and the cube's element array bound). Leaves uMat at 0 and blending off.
 */
export function drawMaterials(dlo: readonly number[], dhi: readonly number[]): void {
  if (!inst.special.length && !focusIsSpecial()) return;
  const { gl, u } = G;
  drawGlow(dlo, dhi);
  const f = focusItem(dlo, dhi), focusClear = f && f.m !== MAT_GLOW ? f : null;
  const n = count(MAT_GLASS) + count(MAT_TRANSLUCENT);
  if (!n && !focusClear) return;
  if (exact()) {
    const v = S.view, eye = [v[2], v[6], v[10]];
    const depth = (it: Item): number => ((it.l[0]! + it.h[0]!) * eye[0]! + (it.l[2]! + it.h[2]!) * eye[1]! + (it.l[1]! + it.h[1]!) * eye[2]!) / 2;
    const list = focusClear ? [...rows(), focusClear] : rows();
    const clear = list.filter((it) => it.m !== MAT_GLOW).map((it) => ({ it, d: depth(it) })).sort((a, b) => a.d - b.d);
    if (!clear.length) return;
    gl.enable(gl.BLEND); gl.depthMask(false);
    for (const { it } of clear) drawClear(it);
  } else {
    gl.enable(gl.BLEND); gl.depthMask(false);
    gl.uniform1f(u.uMat, MAT_GLASS);
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR); gl.uniform1f(u.uMatPass, 0); drawSet(MAT_GLASS);
    gl.blendFunc(gl.ONE, gl.ONE); gl.uniform1f(u.uMatPass, 1); drawSet(MAT_GLASS);
    gl.uniform1f(u.uMat, MAT_TRANSLUCENT);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(u.uMatPass, 0); drawSet(MAT_TRANSLUCENT, true);
    if (focusClear) drawClear(focusClear);
  }
  gl.uniform1f(u.uMat, 0); gl.uniform1f(u.uMatPass, 0);
  gl.depthMask(true); gl.disable(gl.BLEND);
}

/** The full build's bloom pass (render/bloom.ts), or null (lite, or not loaded yet). */
export let bloomPass: ((w: number, h: number, drawDepth: () => void, drawEmission: () => void) => void) | null = null;
export function setBloomPass(f: typeof bloomPass): void { bloomPass = f; }
