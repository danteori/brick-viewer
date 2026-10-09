// Special materials in the forward pipeline (backlog L-02; the maths is src/render/materials.ts):
//   - glow: opaque and unlit (emission only), drawn right after the opaque bodies;
//   - glass and translucent plastic: transparent, drawn after every opaque body, back to front
//     (farthest brick centre first), depth-tested without writing depth. Glass is two blended
//     passes per brick (multiply by its transmission, then add the Fresnel sky reflection);
//     translucent plastic is one alpha-blended pass.
// Those bricks are left out of the instance buffers (instances.ts), so a plastic-only scene draws
// exactly as before. The full build adds a bloom pass around glow bricks (render/bloom.ts).

import { S, hasFocus } from '../app/state.ts';
import type { Brick } from '../scene/brick.ts';
import { brickView } from '../scene/view.ts';
import { G, bodyShape, drawBody, type BodyShape } from './draw.ts';
import { inst } from './instances.ts';
import { MAT_GLASS, MAT_GLOW, matCode } from './matcode.ts';

type Item = { b: Brick; l: readonly number[]; h: readonly number[]; m: number; shape?: BodyShape; sel: boolean };

/** Brick views of the special-material rows, rebuilt when the instance data changes. */
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

/** The special-material bricks to draw this frame (the focused one with its live box). */
function items(dlo: readonly number[], dhi: readonly number[]): Item[] {
  const out = rows().slice(), f = S.focus;
  if (hasFocus() && f && !S.hidden.has(S.sel)) { const m = matCode(f); if (m) out.push({ b: f, l: dlo, h: dhi, m, shape: bodyShape(f, dlo, dhi, S.scene.orient[S.sel]), sel: S.selection.has(S.sel) }); }
  return out;
}

const intensityOf = (b: Brick): number => b.intensity ?? 5;

/** True when this frame has a glow brick (the bloom pass then runs). */
export function hasGlow(): boolean {
  if (rows().some((it) => it.m === MAT_GLOW)) return true;
  return hasFocus() && !!S.focus && matCode(S.focus) === MAT_GLOW;
}

/** The focused brick is drawn here, not with the plain bodies, when it has a special material. */
export const focusIsSpecial = (): boolean => hasFocus() && !!S.focus && matCode(S.focus) > 0;

const draw = (it: Item): void => drawBody(it.b, it.l, it.h, it.sel ? 1 : 0, it.shape);

/** Glow bricks only, with `pass` (0 display colour, 2 linear emission for the bloom buffer). */
export function drawGlow(dlo: readonly number[], dhi: readonly number[], pass = 0): void {
  const { gl, u } = G;
  gl.uniform1f(u.uMat, MAT_GLOW); gl.uniform1f(u.uMatPass, pass);
  for (const it of items(dlo, dhi)) if (it.m === MAT_GLOW) { gl.uniform1f(u.uIntensity, intensityOf(it.b)); draw(it); }
  gl.uniform1f(u.uMat, 0); gl.uniform1f(u.uMatPass, 0);
}

/**
 * Draws glow, then the transparent bricks back to front (call after the opaque bodies, with the
 * body uniforms set and the cube's element array bound). Leaves uMat at 0 and blending off.
 */
export function drawMaterials(dlo: readonly number[], dhi: readonly number[]): void {
  if (!inst.special.length && !focusIsSpecial()) return;
  const { gl, u } = G, list = items(dlo, dhi);
  drawGlow(dlo, dhi);
  const v = S.view, eye = [v[2], v[6], v[10]];
  const depth = (it: Item): number => ((it.l[0]! + it.h[0]!) * eye[0]! + (it.l[2]! + it.h[2]!) * eye[1]! + (it.l[1]! + it.h[1]!) * eye[2]!) / 2;
  const clear = list.filter((it) => it.m !== MAT_GLOW).map((it) => ({ it, d: depth(it) })).sort((a, b) => a.d - b.d);
  if (!clear.length) return;
  gl.enable(gl.BLEND); gl.depthMask(false);
  for (const { it } of clear) {
    gl.uniform1f(u.uMat, it.m); gl.uniform1f(u.uIntensity, intensityOf(it.b));
    if (it.m === MAT_GLASS) {
      gl.blendFunc(gl.ZERO, gl.SRC_COLOR); gl.uniform1f(u.uMatPass, 0); draw(it);
      gl.blendFunc(gl.ONE, gl.ONE); gl.uniform1f(u.uMatPass, 1); draw(it);
    } else {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(u.uMatPass, 0); draw(it);
    }
  }
  gl.uniform1f(u.uMat, 0); gl.uniform1f(u.uMatPass, 0);
  gl.depthMask(true); gl.disable(gl.BLEND);
}

/** The full build's bloom pass (render/bloom.ts), or null (lite, or not loaded yet). */
export let bloomPass: ((w: number, h: number, drawDepth: () => void, drawEmission: () => void) => void) | null = null;
export function setBloomPass(f: typeof bloomPass): void { bloomPass = f; }
