import { S, hasFocus } from './state.ts';
import { camDrag, isFree } from './mode.ts';
import { frameFocus, toView, viewDir } from '../render/camera.ts';
import { centrePoint, orbitAbout, panBy, panView, rebaseOrigin, zoomAt } from '../render/freecam.ts';
import { cursorRay, ed } from '../editor/ghost.ts';
import { pickRay } from '../scene/spatial.ts';
import { orbitDuringResize, selectBrick } from '../editor/resize.ts';
import { gridClick } from '../editor/grids.ts';
import { isTyping } from '../editor/input.ts';
import { initAudio, playSelect } from '../ui/audio.ts';
import type { V3 } from '../scene/brick.ts';

const MOVE_KEYS = new Set(['w', 'a', 's', 'd', ' ']);
/** Camera key speed: view heights per second. */
const PAN_SPEED = 0.9;
/** Space / Shift: the smallest on-screen share of a world-up step that still counts as full speed. */
const UP_MIN = 0.35;
/** Shift held alone this long (ms) moves the camera down; a click or a key in that time keeps it a modifier. */
export const SHIFT_DELAY = 250;
/** A left press that moves less than this (px) is a click: it selects. */
const CLICK_PX = 4;
const GLIDE = 0.2;

const keys = new Set<string>();
let shift: { t: number; alone: boolean } | null = null;
let press: { x: number; y: number; id: number } | null = null;
let drag: { kind: 'orbit' | 'pan'; x: number; y: number; id: number; pivot: V3 } | null = null;
let glide: V3 | null = null;
let lastT = 0, buttons = 0, pointerId = 1;

/** A brick, a selection or a ghost is being edited: the camera keys are off, so they don't clash with Shift+click. */
export const editing = (): boolean => hasFocus() || S.selection.size > 0 || !!ed.ghost;

/** The brick under this screen point, or -1. */
function brickAt(x: number, y: number): number {
  const r = cursorRay(x, y);
  if (!r) return -1;
  const hit = pickRay(r.vx, r.vy);
  return hit && S.scene.alive(hit.k) ? hit.k : -1;
}

/** A click on a brick: select it. The camera stays where it is. */
export function clickBrick(id: number): void {
  if (id < 0 || id === S.sel) return;
  const prev = S.sel;
  initAudio(); selectBrick(id); playSelect();
  gridClick(prev);
}

/** Double-click: select the brick and glide the camera onto its centre; the zoom stays. */
export function centreOn(id: number): void {
  clickBrick(id);
  glide = [0, 1, 2].map((i) => (S.lo[i] + S.hi[i]) / 2) as V3;
}

function startDrag(kind: 'orbit' | 'pan', x: number, y: number, id: number, canvas: HTMLCanvasElement): void {
  drag = { kind, x, y, id, pivot: centrePoint() };
  glide = null;
  S.orbit.yawT = S.orbit.yaw; S.orbit.pitchT = S.orbit.pitch;
  camDrag.kind = kind;
  capture(canvas, id);
}

function capture(el: Element, id: number): boolean {
  try { el.setPointerCapture(id); return true; } catch { return false; }
}

function stopAll(): void { drag = null; press = null; camDrag.kind = null; keys.clear(); shift = null; buttons = 0; }

export function initExplore(canvas: HTMLCanvasElement): void {
  S.hooks.loaded.push(() => { if (isFree()) frameFocus(); });
  if (isFree()) frameFocus();

  addEventListener('pointerdown', (e) => {
    if (shift) shift.alone = false;
    buttons = e.buttons; pointerId = e.pointerId;
    if (!isFree() || e.target !== canvas || S.held) return;
    if (e.button === 1) { startDrag('orbit', e.clientX, e.clientY, e.pointerId, canvas); return; }
    if (ed.ghost) return;
    if (e.button === 2) { e.stopImmediatePropagation(); e.preventDefault(); startDrag('pan', e.clientX, e.clientY, e.pointerId, canvas); return; }
    if (e.button !== 0 || e.shiftKey || S.tool === 'paint' || S.hoverAxis >= 0) return;
    e.stopImmediatePropagation(); e.preventDefault();
    press = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }, true);
  addEventListener('pointermove', (e) => {
    if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_PX) {
      startDrag('orbit', press.x, press.y, press.id, canvas);
      press = null;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.kind === 'orbit') orbitAbout(drag.pivot, dx, dy);
    else panBy(dx, dy, canvas.clientWidth, canvas.clientHeight);
  }, true);
  addEventListener('pointerup', (e) => {
    buttons = e.buttons;
    if (press && e.pointerId === press.id) { press = null; e.stopImmediatePropagation(); clickBrick(brickAt(e.clientX, e.clientY)); }
    if (drag && e.pointerId === drag.id) { drag = null; camDrag.kind = null; }
  }, true);
  addEventListener('pointercancel', (e) => {
    buttons = e.buttons;
    if (press && e.pointerId === press.id) press = null;
    if (drag && e.pointerId === drag.id) { drag = null; camDrag.kind = null; }
  }, true);
  addEventListener('mousedown', (e) => {
    if (!isFree() || !S.held || e.button !== 1 || drag) return;
    e.preventDefault();
    orbitDuringResize();
    startDrag('orbit', e.clientX, e.clientY, pointerId, canvas);
  }, true);
  addEventListener('mouseup', (e) => {
    if (e.button === 1 && drag?.kind === 'orbit') { drag = null; camDrag.kind = null; }
  }, true);
  addEventListener('blur', stopAll);

  addEventListener('wheel', (e) => {
    if (shift) shift.alone = false;
    if (!isFree() || e.target !== canvas) return;
    if (ed.ghost && (e.ctrlKey || e.shiftKey || e.metaKey)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    zoomAt(Math.exp(px * 0.0015), e.clientX, e.clientY, canvas.clientWidth, canvas.clientHeight);
    if (S.held) S.userZoomed = true;
  }, { capture: true, passive: false });

  addEventListener('dblclick', (e) => {
    if (!isFree() || e.target !== canvas || ed.ghost || performance.now() - ed.lastPlaceT < 600) return;
    const id = brickAt(e.clientX, e.clientY);
    if (id < 0) return;
    e.stopImmediatePropagation();
    centreOn(id);
  }, true);

  addEventListener('keydown', (e) => {
    if (e.key === 'Shift') {
      if (!e.repeat) shift = isFree() && !editing() && !isTyping(e.target) ? { t: performance.now(), alone: true } : null;
      return;
    }
    if (shift) shift.alone = false;
    if (!isFree() || editing() || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    if (!MOVE_KEYS.has(k)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    keys.add(k);
  }, true);
  addEventListener('keyup', (e) => {
    if (e.key === 'Shift') shift = null;
    if (e.key === ' ' && !isTyping(e.target)) e.preventDefault();
    keys.delete(e.key.toLowerCase());
  }, true);
}

/** Shift is moving the camera down: held alone, with no mouse button down, past the delay. */
export const shiftDown = (t: number): boolean => !!shift && shift.alone && !buttons && t - shift.t >= SHIFT_DELAY;

/** One frame of the camera keys and the double-click glide (dt from the frame clock). */
export function exploreTick(t: number): void {
  const dt = Math.min(0.1, Math.max(0, (t - lastT) / 1000));
  lastT = t;
  if (!isFree()) return;
  if (editing()) { keys.clear(); shift = null; }
  const dx = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0), dy = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
  const dz = (keys.has(' ') ? 1 : 0) - (shiftDown(t) ? 1 : 0);
  const n = Math.hypot(dx, dy);
  if (n) { const v = PAN_SPEED * dt / n; panView(dx * v, dy * v); }
  if (dz) {
    const up = viewDir(0, 0, 1), len = Math.hypot(up[0], up[1]);
    const v = dz * PAN_SPEED * dt * S.cam.half / Math.max(len, UP_MIN);
    S.cam.x += up[0] * v; S.cam.y += up[1] * v;
  }
  if (n || dz) glide = null;
  if (glide) {
    const [gx, gy] = toView(glide[0], glide[1], glide[2]);
    S.cam.x += (gx - S.cam.x) * GLIDE; S.cam.y += (gy - S.cam.y) * GLIDE;
    if (Math.hypot(gx - S.cam.x, gy - S.cam.y) < S.cam.half * 1e-4) { S.cam.x = gx; S.cam.y = gy; glide = null; }
  }
  if (!drag || drag.kind !== 'orbit') rebaseOrigin();
}

/** The camera is gliding after a double-click (test hook). */
export const gliding = (): boolean => !!glide;
