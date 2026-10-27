// Special materials in the forward pipeline (backlog L-02 / U-15; the maths is src/render/materials.ts):
//   - glow: opaque and unlit (emission only), drawn right after the opaque bodies;
//   - metallic: opaque, drawn right after the glow bricks (in the bloom pass's depth, never in its
//     emission buffer);
//   - hologram: transparent and one-sided, sorted with glass / translucent, one premultiplied pass
//     (background x (1 - opacity) + the animated stripe glow; uTime is set per frame by the pipeline);
//   - glass and translucent plastic: transparent, drawn after every opaque body, back to front
//     (farthest brick centre first), depth-tested without writing depth. Glass is two blended
//     passes per brick (multiply by its transmission, then add the Fresnel sky reflection);
//     translucent plastic is one alpha-blended pass.
// Those bricks sit in instance groups of their own (instances.ts), so a plastic-only scene draws
// exactly as before. Hidden (Visible off) bricks are drawn last, only while they show
// (app/hidden.ts), as see-through ghosts with scrolling stripes (drawHidden). The full build adds a bloom pass around glow bricks (render/bloom.ts).

import { S, hasFocus } from '../app/state.ts';
import { hiddenShown } from '../app/hidden.ts';
import { hiddenBit, isHiddenRow } from '../scene/hidden.ts';
import type { Brick } from '../scene/brick.ts';
import { brickView } from '../scene/view.ts';
import { G, bodyShape, drawBody, type BodyShape } from './draw.ts';
import { inst } from './instances.ts';
import { MAT_GLASS, MAT_GLOW, MAT_HIDDEN, MAT_HOLOGRAM, MAT_METALLIC, MAT_TRANSLUCENT, matCode } from './matcode.ts';
import { boxIB } from './meshes/registry.ts';

/**
 * Up to this many special-material bricks are drawn one by one as before: glow, metallic, then the
 * transparent ones exactly back to front (brick centres). Above it (big builds: thousands of
 * one-brick draws cost hundreds of ms a frame) they come from the instance buffers instead: glow
 * and metallic instanced, glass order-independent (its multiply and add passes commute, as each
 * brick's own faces already did), translucent plastic, then hologram, each sorted back to front
 * per chunk, chunks back to front (the two aren't interleaved with each other there).
 */
export const EXACT_SPECIAL = 128;

type Item = { b: Brick; l: readonly number[]; h: readonly number[]; m: number; shape?: BodyShape; sel: boolean };

/** Brick views of the special rows, rebuilt when the instance data changes (exact path only). */
let cache: Item[] = [], cacheRev = -1, cacheScene: unknown = null;
function rows(): Item[] {
  if (cacheRev === inst.rev && cacheScene === S.scene) return cache;
  cacheRev = inst.rev; cacheScene = S.scene;
  const s = S.scene, bit = hiddenBit(s);
  cache = [];
  for (const id of inst.special) {
    if (!s.alive(id) || id === S.sel) continue;
    const b = brickView(s, id);
    cache.push({ b, l: b.lo, h: b.hi, m: isHiddenRow(s, id, bit) ? MAT_HIDDEN : matCode(b), shape: bodyShape(b, b.lo, b.hi, s.orient[id]), sel: S.selection.has(id) });
  }
  return cache;
}

/** The focused brick's code: MAT_HIDDEN when it is hidden, else its material's (0 plastic, or no focus). */
function focusMat(): number {
  if (!hasFocus() || !S.focus) return 0;
  return isHiddenRow(S.scene, S.sel) ? MAT_HIDDEN : matCode(S.focus);
}

/** The focused brick as an item when it has a special material (or is hidden) and is shown. */
function focusItem(dlo: readonly number[], dhi: readonly number[]): Item | null {
  const f = S.focus;
  if (!hasFocus() || !f || S.hidden.has(S.sel)) return null;
  const m = focusMat();
  return m ? { b: f, l: dlo, h: dhi, m, shape: bodyShape(f, dlo, dhi, S.scene.orient[S.sel]), sel: S.selection.has(S.sel) } : null;
}

const intensityOf = (b: Brick): number => b.intensity ?? 5;
const count = (m: number): number => inst.set?.matCount[m] ?? 0;
/** Few enough special bricks to draw them one by one (exactly as before instancing them). */
const exact = (): boolean => count(MAT_GLASS) + count(MAT_TRANSLUCENT) + count(MAT_GLOW) + count(MAT_METALLIC) + count(MAT_HOLOGRAM) <= EXACT_SPECIAL;

/** True when this frame shows a glow brick (the bloom pass then runs): one in a chunk in view (inst.cull), or the focused one. */
export function hasGlow(): boolean {
  if (count(MAT_GLOW) && inst.set!.glowInView(inst.cull)) return true;
  return focusMat() === MAT_GLOW;
}

/** The focused brick is shown and glows. */
export const hasFocusGlow = (): boolean => !S.hidden.has(S.sel) && focusMat() === MAT_GLOW;

/** The focused brick is drawn here, not with the plain bodies, when it has a special material or is hidden. */
export const focusIsSpecial = (): boolean => focusMat() > 0;

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

/**
 * Metallic bricks only (opaque: depth written, no blending). Also drawn into the bloom pass's
 * depth, so a metallic brick hides the glow behind it as a plastic one does.
 */
export function drawMetallic(dlo: readonly number[], dhi: readonly number[]): void {
  if (!count(MAT_METALLIC) && focusMat() !== MAT_METALLIC) return;
  const { gl, u } = G;
  gl.uniform1f(u.uMat, MAT_METALLIC); gl.uniform1f(u.uMatPass, 0);
  const f = focusItem(dlo, dhi);
  if (exact()) {
    for (const it of f ? [...rows(), f] : rows()) if (it.m === MAT_METALLIC) { gl.uniform1f(u.uIntensity, intensityOf(it.b)); draw(it); }
  } else {
    drawSet(MAT_METALLIC);
    if (f && f.m === MAT_METALLIC) { gl.uniform1f(u.uIntensity, intensityOf(f.b)); draw(f); }
  }
  gl.uniform1f(u.uMat, 0); gl.uniform1f(u.uMatPass, 0);
}

/** An item's centre along the view direction (smaller = farther: drawn first). */
function depthOf(it: Item): number {
  const v = S.view;
  return ((it.l[0]! + it.h[0]!) * v[2]! + (it.l[2]! + it.h[2]!) * v[6]! + (it.l[1]! + it.h[1]!) * v[10]!) / 2;
}

/** One transparent item: glass as its two passes, hologram premultiplied, translucent plastic alpha-blended. */
function drawClear(it: Item): void {
  const { gl, u } = G;
  gl.uniform1f(u.uMat, it.m); gl.uniform1f(u.uIntensity, intensityOf(it.b));
  if (it.m === MAT_GLASS) {
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR); gl.uniform1f(u.uMatPass, 0); draw(it);
    gl.blendFunc(gl.ONE, gl.ONE); gl.uniform1f(u.uMatPass, 1); draw(it);
  } else if (it.m === MAT_HOLOGRAM) {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(u.uMatPass, 0); draw(it);
  } else {
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(u.uMatPass, 0); draw(it);
  }
}

/**
 * Draws glow and metallic, then the transparent bricks back to front (call after the opaque bodies, with the
 * body uniforms set and the cube's element array bound). Leaves uMat at 0 and blending off.
 */
export function drawMaterials(dlo: readonly number[], dhi: readonly number[]): void {
  if (!inst.specialCount && !focusIsSpecial()) return;
  const { gl, u } = G;
  drawGlow(dlo, dhi);
  drawMetallic(dlo, dhi);
  const f = focusItem(dlo, dhi), focusClear = f && f.m !== MAT_GLOW && f.m !== MAT_METALLIC && f.m !== MAT_HIDDEN ? f : null;
  const n = count(MAT_GLASS) + count(MAT_TRANSLUCENT) + count(MAT_HOLOGRAM);
  if (!n && !focusClear) return;
  if (exact()) {
    const list = focusClear ? [...rows(), focusClear] : rows();
    const clear = list.filter((it) => it.m !== MAT_GLOW && it.m !== MAT_METALLIC && it.m !== MAT_HIDDEN).map((it) => ({ it, d: depthOf(it) })).sort((a, b) => a.d - b.d);
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
    gl.uniform1f(u.uMat, MAT_HOLOGRAM);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(u.uMatPass, 0); drawSet(MAT_HOLOGRAM, true);
    if (focusClear) drawClear(focusClear);
  }
  gl.uniform1f(u.uMat, 0); gl.uniform1f(u.uMatPass, 0);
  gl.depthMask(true); gl.disable(gl.BLEND);
}

/**
 * Draws the hidden (Visible off) bricks as see-through ghosts, back to front, when they show
 * (app/hidden.ts); call after drawMaterials. Leaves uMat at 0 and blending off.
 */
export function drawHidden(dlo: readonly number[], dhi: readonly number[]): void {
  const f = focusItem(dlo, dhi), focusHidden = f && f.m === MAT_HIDDEN ? f : null, n = count(MAT_HIDDEN);
  if ((!n && !focusHidden) || !hiddenShown()) return;
  const { gl, u } = G;
  gl.enable(gl.BLEND); gl.depthMask(false);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform1f(u.uMat, MAT_HIDDEN); gl.uniform1f(u.uMatPass, 0);
  if (n <= EXACT_SPECIAL) {
    const list = rows().filter((it) => it.m === MAT_HIDDEN);
    if (focusHidden) list.push(focusHidden);
    for (const it of list.map((it) => ({ it, d: depthOf(it) })).sort((a, b) => a.d - b.d)) draw(it.it);
  } else {
    drawSet(MAT_HIDDEN, true);
    if (focusHidden) draw(focusHidden);
  }
  gl.uniform1f(u.uMat, 0);
  gl.depthMask(true); gl.disable(gl.BLEND);
}

/** The full build's bloom pass (render/bloom.ts), or null (lite, or not loaded yet). */
export let bloomPass: ((w: number, h: number, drawDepth: () => void, drawEmission: () => void) => void) | null = null;
export function setBloomPass(f: typeof bloomPass): void { bloomPass = f; }
