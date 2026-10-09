// Resizing the focused brick: relative, stepped control on the near faces only. Ported from the
// legacy viewer.
//
// A step only ever moves the face on its axis that faces the camera. Resize steps are pending (the
// ghost) until committed by release or right-click. The drag is locked to the pending axis while it
// has a change; returning to the committed size unlocks it. Grabbing a face starts locked to its axis.

import { S, type AxisDir } from '../app/state.ts';
import { MAX, MICROB, BRICK, THRESH, TOL } from '../core/units.ts';
import { brickType, cloneBrick, fixedSize, lockedType, sizeRule, type V3 } from '../scene/brick.ts';
import { focusChangeHits, freeGrowth } from '../scene/collision.ts';
import { setStatus } from '../ui/status.ts';
import { farOf, fitHalf, PITCH_MAX, PITCH_MIN, snapToIso, studPx, toView, updateDirs, ZOOM_MAX, ZOOM_MIN } from '../render/camera.ts';
import { viewOf } from '../core/math.ts';
import { histBegin, histEnd } from '../scene/history.ts';
import { initAudio, playClick, playResize } from '../ui/audio.ts';
import { drawGuide, clearGuide } from '../ui/overlay/dims.ts';
import { syncSizeUi, updateMenuUnits, setModeButtons } from '../ui/panels/size.ts';

/** grid steps along axis i (studs, plates or micros) */
export const units = (i: number): number => Math.round((S.hi[i] - S.lo[i]) / S.STEPS[i]);
export const isFixedAxis = (i: number): boolean => !!S.RULE.fix[i];
export const maxUnits = (i: number): number => (isFixedAxis(i) ? units(i) : Math.round(MAX / S.STEPS[i]));
export const minUnits = (i: number): number => (isFixedAxis(i) ? units(i) : S.RULE.min[i]);

/** dragging toward the near face's outside pushes it out */
export const grows = (q: { i: number; d: number }): boolean => q.d * S.ns[q.i] > 0;

/** [lo, hi] with the pending step applied */
export function proposedBox(): [V3, V3] {
  const l = S.lo.slice() as V3, h = S.hi.slice() as V3;
  if (S.pendAxis >= 0) {
    const i = S.pendAxis, dv = S.pendUnits * S.STEPS[i];
    if (S.ns[i] > 0) h[i] = +(S.hi[i] + dv).toFixed(3); else l[i] = +(S.lo[i] - dv).toFixed(3);
  }
  return [l, h];
}

/** The last refused resize (collision): the HUD shows it in red for a moment. */
export const resizeBlock = { t: -1e9, reason: '' };
export const BLOCK_SHOW_MS = 1500;
function refuse(reason: string, partly = false): void {
  resizeBlock.t = performance.now(); resizeBlock.reason = reason;
  setStatus(partly ? `Resize stopped: ${reason}` : `Can't resize: ${reason}`);
}

/**
 * The largest pending growth on axis i in (from .. want] that doesn't run into another brick of the
 * same grid; flags the refusal when it stops short.
 */
function growFree(i: number, from: number, want: number): number {
  if (want <= Math.max(0, from)) return want;              // shrinking never collides
  const ok = freeGrowth(S.lo, S.hi, i, S.ns[i], S.STEPS[i], Math.max(0, from), want);
  if (ok < want) refuse('overlaps a brick', ok > Math.max(0, from));
  return Math.max(from, ok);
}

export function step(q: { i: number; d: number }): void {
  const i = q.i;
  if (S.pendAxis !== i) { S.pendAxis = i; S.pendUnits = 0; }
  const was = S.pendUnits;
  // keep the proposed size within 1 unit .. MAX, and stop at the last size that doesn't overlap a brick
  S.pendUnits = growFree(i, was, Math.max(minUnits(i) - units(i), Math.min(maxUnits(i) - units(i), S.pendUnits + q.d * S.ns[i])));
  if (S.pendUnits !== was) { S.grab[i] = 1; S.lastAxis = i; playResize(units(i) + S.pendUnits); }   // no tick when clamped; pitch = new size
  S.lockAxis = S.pendUnits ? i : -1;            // back at the default: unlocked again
  if (!S.pendUnits) S.pendAxis = -1;
}

/** the ghost becomes part of the solid brick; returns the committed axis or -1 */
export function commit(): number {
  if (S.pendAxis < 0) return -1;
  const i = S.pendAxis, [l, h] = proposedBox();
  S.lo[i] = l[i]; S.hi[i] = h[i];
  S.pendAxis = -1; S.pendUnits = 0; S.lockAxis = -1;
  return i;
}

/** resize axis i to n units by moving its near face (typed sizes, mode switches) */
export function setNear(i: number, n: number): void {
  if (S.ns[i] > 0) S.hi[i] = +(S.lo[i] + n * S.STEPS[i]).toFixed(3); else S.lo[i] = +(S.hi[i] - n * S.STEPS[i]).toFixed(3);
}

/** a world point this drag never moves, in view-plane coords */
export function pinned(): [number, number] {
  const p = [0, 1, 2].map((i) => (S.grab[i] ? farOf(i) : (S.lo[i] + S.hi[i]) / 2));
  return toView(p[0], p[1], p[2]);
}

/** Typed sizes, shared by the dimension labels and the top-left menu. Like dragging, typing only moves the near face. */
export function setSize(i: number, n: number): void {
  const b = S.bricks[S.sel];
  if (!(n > 0) || !b || fixedSize(b) || isFixedAxis(i)) return;   // empty scene, a fixed-size round or a fixed axis
  const was = units(i), want = Math.max(minUnits(i), Math.min(maxUnits(i), n));
  const to = was + growFree(i, 0, want - was);           // a typed size stops at the last one that fits
  if (to === was && want > was) return;
  histBegin('size');
  setNear(i, to); S.lastAxis = i; recenter();
  histEnd();
  if (units(i) !== was) playResize(units(i));
}

/**
 * Re-base the scene so the focused box sits on the origin and shift the camera with it (no visible
 * jump); the frame loop then glides the camera back to centre.
 */
export function recenter(): void {
  const { lo, hi } = S;
  const c = [0, 1, 2].map((i) => +((lo[i] + hi[i]) / 2).toFixed(3));
  for (const b of S.bricks) for (let i = 0; i < 3; i++) {
    b.lo[i] = +(b.lo[i] - c[i]).toFixed(3); b.hi[i] = +(b.hi[i] - c[i]).toFixed(3);
  }
  for (let i = 0; i < 3; i++) { S.dlo[i] -= c[i]; S.dhi[i] -= c[i]; S.histOrigin[i] = +(S.histOrigin[i] + c[i]).toFixed(3); }
  const v = toView(c[0], c[1], c[2]); S.cam.x -= v[0]; S.cam.y -= v[1];
}

/**
 * Give brick i the focus: the size menu, dimensions, name label and resizing all follow it, and the
 * camera glides over to centre on it (recenter shifts the world under the camera).
 */
export function selectBrick(i: number): void {
  S.sel = i; const b = S.bricks[i];
  S.lo = b.lo; S.hi = b.hi; S.micro = !!b.micro;
  const M = S.micro ? MICROB : BRICK;
  S.RULE = sizeRule(b);                                  // this type's grid, minimums and fixed axes
  S.STEPS = S.RULE.steps.slice() as V3; S.START = M.start.slice() as V3;
  for (let k = 0; k < 3; k++) { S.dlo[k] = S.lo[k]; S.dhi[k] = S.hi[k]; }
  S.pendAxis = -1; S.pendUnits = 0; S.lockAxis = -1; S.lastAxis = -1; S.dragDir = null;
  syncSizeUi(b);
  updateMenuUnits();
  recenter();
}

/**
 * Brick / Tile / Smooth Tile / Microbrick switch. Switching keeps the brick's size: brick -> micro
 * is exact, micro -> brick rounds to the nearest stud / plate, never below 1.
 */
export function setMode(mode: string): void {
  const b = S.bricks[S.sel], m = mode === 'micro';
  if (!b || mode === brickType(b) || lockedType(b)) return;
  const prev = cloneBrick(b), prevLo = S.lo.slice(), prevHi = S.hi.slice();
  histBegin('type');
  if (b.shape === 'ramp') { delete b.shape; delete b.run; delete b.lip; }
  if (b.shape === 'crest' || b.shape === 'crestEnd') { delete b.shape; delete b.run; delete b.closed; }
  b.top = mode === 'tile' ? 'smooth' : mode === 'plain' ? 'plain' : 'studs'; b.tile = b.top === 'smooth';
  setModeButtons(mode);
  S.RULE = sizeRule(b);                         // a ramp's 2-stud run minimum goes with its shape
  if (m === S.micro) { histEnd(); initAudio(); playClick(); return; }   // brick <-> tiles: same sizes, just the top changes
  S.micro = m; b.micro = m;
  const M = S.micro ? MICROB : BRICK;
  S.RULE = sizeRule(b);
  S.STEPS = S.RULE.steps.slice() as V3; S.START = M.start.slice() as V3;
  for (let i = 0; i < 3; i++) {
    const n = Math.max(1, Math.min(maxUnits(i), Math.round((S.hi[i] - S.lo[i]) / S.STEPS[i] + 1e-9)));   // halves round up
    setNear(i, n);
  }
  if (focusChangeHits(prevLo, prevHi, S.lo, S.hi)) {      // micro -> brick rounding grew into a brick: refuse
    const lo = b.lo, hi = b.hi;                           // S.lo / S.hi are these arrays: keep them
    Object.assign(b, prev); b.lo = lo; b.hi = hi; lo.splice(0, 3, ...prevLo); hi.splice(0, 3, ...prevHi);
    for (const k of Object.keys(b) as (keyof typeof b)[]) if (!(k in prev)) delete b[k];
    S.micro = !!b.micro; S.RULE = sizeRule(b); S.STEPS = S.RULE.steps.slice() as V3;
    S.START = (S.micro ? MICROB : BRICK).start.slice() as V3;
    setModeButtons(brickType(b));
    histEnd(); updateMenuUnits();
    refuse('overlaps a brick');
    return;
  }
  recenter();
  S.pendAxis = -1; S.pendUnits = 0; S.lockAxis = -1; S.lastAxis = -1; S.dragDir = null;
  histEnd();
  updateMenuUnits(); initAudio(); playClick();
}

/** keep the zoom on screen while the focus moves */
export function keepZoom(keep: number): void {
  S.zoomMul = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, keep / fitHalf(S.lo, S.hi)));
}

// --- Pointer input. A step fires once the cursor is SNAP of the way to the next grid line.
export const SNAP = 0.6;

export function onDown(e: PointerEvent, canvas: HTMLCanvasElement): void {
  if (e.button === 1) { startOrbit(e, canvas); return; }
  if (e.button !== 0 || S.orbit.dragging || !S.bricks[S.sel]) return;
  if (S.hoverBrick >= 0 && S.hoverBrick !== S.sel) {            // clicked another brick: just move the focus
    const keep = S.cam.half;
    histEnd(); initAudio(); selectBrick(S.hoverBrick); playClick();
    keepZoom(keep);
    return;
  }
  if (fixedSize(S.bricks[S.sel])) return;                     // rounds / cones can't be resized
  snapToIso();                                           // resize from a balanced iso corner
  histBegin('resize');                                    // the whole drag is one undo step
  S.held = true; S.grab = [0, 0, 0]; S.steppedThisDrag = false; S.userZoomed = false;
  S.lockAxis = -1; S.bannedAxis = -1; S.lastAxis = -1;
  S.pendAxis = -1; S.pendUnits = 0;
  S.cursor = S.anchor = [e.clientX, e.clientY]; S.active = null;
  if (S.hoverAxis >= 0) S.lockAxis = S.hoverAxis;               // pressed on a face: start locked to its axis
  initAudio();
  try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  drawGuide();
}

export function onUp(e?: { type: string }): void {
  clearGuide();
  if (!S.held) return;
  if (e && e.type === 'pointerup') { commit(); playClick(); }   // release commits + clicks
  else { S.pendAxis = -1; S.pendUnits = 0; S.lockAxis = -1; }         // window blur / cancel: discard the step
  S.held = false; S.anchor = S.cursor = S.active = null; S.grab = [0, 0, 0];
  recenter();
  histEnd();
}

export function onMove(e: PointerEvent): void {
  if (!S.held || !S.anchor) return;
  if (!(e.buttons & 1)) { onUp({ type: 'pointerup' }); return; }   // left released while right still held
  const p: [number, number] = [e.clientX, e.clientY]; S.cursor = p;
  for (let guard = 0; guard < 200; guard++) {
    const anchor: [number, number] = S.anchor!;
    const dx = p[0] - anchor[0], dy = p[1] - anchor[1], d = Math.hypot(dx, dy);
    S.active = null;
    if (S.lockAxis >= 0) {
      const pos = S.dirs.find((q) => q.i === S.lockAxis && q.d > 0)!;
      S.active = dx * pos.v[0] + dy * pos.v[1] >= 0 ? pos : S.dirs.find((q) => q.i === S.lockAxis && q.d < 0)!;
    } else if (d > Math.min(6, SNAP * studPx(0))) {
      let best = S.dirs[0], bestAng = 1e9;
      for (const q of S.dirs) {
        const ang = Math.acos(Math.max(-1, Math.min(1, (dx * q.v[0] + dy * q.v[1]) / d)));
        if (ang < bestAng) { bestAng = ang; best = q; }
      }
      // motion toward the banned axis is thrown away so it can't skew the next pick
      if (best.i === S.bannedAxis) { S.anchor = p; break; }
      if (bestAng <= TOL) S.active = best;
    }
    const active: AxisDir | null = S.active;
    const sp = Math.max(4, studPx(active ? active.i : 0));
    if (active && dx * active.v[0] + dy * active.v[1] >= sp * SNAP) {
      step(active); S.dragDir = active; S.steppedThisDrag = true;   // step() sets/clears the lock
      const along = dx * active.v[0] + dy * active.v[1] - sp;       // cursor offset from the new grid line
      S.anchor = [p[0] - active.v[0] * along, p[1] - active.v[1] * along];
      continue;
    }
    if (S.lockAxis < 0 && !active && d >= Math.max(THRESH, sp) * 2.5) S.anchor = p;   // drifted: re-anchor
    break;
  }
  drawGuide();
}

/** Edge auto-drag: the cursor pinned against a window edge the drag points into keeps stepping. */
const EDGE = 16, EDGE_MS = 220;
export function edgeTick(t: number): void {
  const W = innerWidth, H = innerHeight, cursor = S.cursor;
  const nx = !cursor ? 0 : cursor[0] <= EDGE ? -1 : cursor[0] >= W - EDGE ? 1 : 0;
  const ny = !cursor ? 0 : cursor[1] <= EDGE ? -1 : cursor[1] >= H - EDGE ? 1 : 0;
  const dd = S.dragDir;
  const into = S.held && S.steppedThisDrag && dd && (nx || ny) && (dd.v[0] * nx + dd.v[1] * ny) / Math.hypot(nx, ny) > 0.25;
  if (!into) { S.edgeT = t; return; }
  if (t - S.edgeT >= EDGE_MS) { step(dd!); S.edgeT = t; S.anchor = cursor!.slice() as [number, number]; drawGuide(); }
}

/** Right-click while dragging: commit the ghost; that axis can't be picked next. */
export function onRightDown(): void {
  if (!S.held || S.pendAxis < 0) return;
  S.bannedAxis = commit(); S.active = null;
  if (S.cursor) S.anchor = S.cursor.slice() as [number, number];
  S.steppedThisDrag = false;
  playClick(); drawGuide();
}

// --- Middle-mouse orbit: horizontal drag spins about the vertical axis, vertical drag tilts.
export function startOrbit(e: PointerEvent, canvas: HTMLCanvasElement): void {
  if (S.held) return;
  e.preventDefault();
  S.orbit.dragging = true; S.orbit.last = [e.clientX, e.clientY];
  try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  canvas.style.cursor = 'move';
}
export function orbitMove(e: PointerEvent): void {
  const o = S.orbit;
  if (!o.dragging) return;
  const dx = e.clientX - o.last![0], dy = e.clientY - o.last![1]; o.last = [e.clientX, e.clientY];
  o.yawT += dx * 0.008;                                  // drag right = the scene turns right
  o.pitchT = Math.max(PITCH_MIN, Math.min(PITCH_MAX, o.pitchT + dy * 0.006));
  o.yaw = o.yawT; o.pitch = o.pitchT;
  S.viewT = viewOf(o.yawT, o.pitchT); updateDirs();
}

/**
 * Scroll zooms the view. zoomMul scales the auto-fit framing. Mid-drag with auto-center off it zooms
 * immediately about the pinned point without touching the drag state.
 */
export function onWheel(e: WheelEvent, canvas: HTMLCanvasElement): void {
  e.preventDefault();
  const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
  const m = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, S.zoomMul * Math.exp(px * 0.0015)));
  const g = m / S.zoomMul; S.zoomMul = m;
  if (S.held && !S.autoCenter) {
    const P = pinned(), cw = canvas.clientWidth, ch = canvas.clientHeight, cam = S.cam;
    const fx = Math.max(cw / ch, 1), fy = Math.max(ch / cw, 1);
    const ux = (P[0] - cam.x) / (cam.half * fx), uy = (P[1] - cam.y) / (cam.half * fy);
    cam.half *= g; cam.x = P[0] - ux * cam.half * fx; cam.y = P[1] - uy * cam.half * fy;
    S.userZoomed = true;
  }
}

