// Explore mode input (U-24). In Explore the mouse never touches bricks: left-drag orbits freely,
// right-drag pans, scroll zooms toward the cursor, WASD pans (Shift is faster), a double-click on a
// brick enters Edit with that brick focused. These capture-phase listeners are registered before
// the editor's, and swallow the canvas input the editor would otherwise act on. The mode switch
// (indicator buttons, panels) is wired here too.

import { S } from './state.ts';
import { enterEdit, enterExplore, exploreDrag, isEdit, isExplore, onModeChange, type Mode } from './mode.ts';
import { frameFocus } from '../render/camera.ts';
import { centrePoint, orbitAbout, panBy, panView, rebaseOrigin, zoomAt } from '../render/freecam.ts';
import { cursorRay } from '../editor/ghost.ts';
import { pickRay } from '../scene/spatial.ts';
import { keepZoom, selectBrick } from '../editor/resize.ts';
import { gridClick } from '../editor/grids.ts';
import { isTyping } from '../editor/input.ts';
import { initAudio, playSelect } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';
import type { V3 } from '../scene/brick.ts';

/** panel parts that only make sense in Edit: using one of them enters Edit */
const EDIT_PARTS = '#tool, #menu, #mode, #pastemode, #bricks, #selbody, #gridbody, #paintbody, #appbody, #compbody';
const WASD = new Set(['w', 'a', 's', 'd']);
/** WASD pan speed: view heights per second, x3 with Shift */
const PAN_SPEED = 0.9, FAST = 3;

const keys = new Set<string>();
let shift = false;
let drag: { kind: 'orbit' | 'pan'; x: number; y: number; id: number; pivot: V3 } | null = null;
let lastT = 0;


/** Is a brick under this screen point? Returns its id or -1. */
function brickAt(x: number, y: number): number {
  const r = cursorRay(x, y);
  if (!r) return -1;
  const hit = pickRay(r.vx, r.vy);
  return hit && S.scene.alive(hit.k) ? hit.k : -1;
}

/** Double-click in Explore: Edit with that brick focused; the zoom stays, the camera glides onto the brick as Edit does. */
export function editBrick(id: number): void {
  const keep = S.cam.half, prev = S.sel;
  enterEdit();
  initAudio(); selectBrick(id); playSelect();
  gridClick(prev);
  keepZoom(keep);
  setStatus('Edit mode: Esc clears the selection, then returns to Explore');
}

export function initExplore(canvas: HTMLCanvasElement): void {
  const btns = [...document.querySelectorAll<HTMLButtonElement>('#viewmode button[data-vm]')];
  const sync = (m: Mode): void => {
    document.body.dataset.mode = m;
    for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.vm === m));
    if (m === 'edit') { drag = null; exploreDrag.kind = null; keys.clear(); } else { S.hoverAxis = -1; S.hoverBrick = -1; S.hoverFace = -1; S.pickKey = ''; }
  };
  onModeChange(sync);
  S.hooks.loaded.push(() => { if (isExplore()) frameFocus(); });   // a new save: frame it as Edit's glide would
  if (isExplore()) frameFocus();
  sync(isExplore() ? 'explore' : 'edit');
  for (const b of btns) {
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('dblclick', (e) => e.stopPropagation());
    b.addEventListener('click', () => {
      if (b.dataset.vm === 'edit') enterEdit(); else enterExplore();
      initAudio();
      setStatus(isEdit() ? 'Edit mode: Esc clears the selection, then returns to Explore' : 'Explore mode: drag to orbit, right-drag or WASD to pan, scroll to zoom, double-click a brick to edit it');
    });
  }

  // using an editing panel enters Edit (before the panel's own handler runs)
  addEventListener('pointerdown', (e) => {
    if (isExplore() && e.target instanceof Element && e.target.closest(EDIT_PARTS)) enterEdit();
  }, true);

  addEventListener('pointerdown', (e) => {
    if (!isExplore() || e.target !== canvas || (e.button !== 0 && e.button !== 1 && e.button !== 2)) return;
    if (e.button !== 1) { e.stopImmediatePropagation(); e.preventDefault(); }   // middle: the editor's click-to-copy still sees it
    drag = { kind: e.button === 2 ? 'pan' : 'orbit', x: e.clientX, y: e.clientY, id: e.pointerId, pivot: centrePoint() };
    S.orbit.yawT = S.orbit.yaw; S.orbit.pitchT = S.orbit.pitch;      // a settling snap stops where it is
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    exploreDrag.kind = drag.kind;
  }, true);
  addEventListener('pointermove', (e) => {
    if (!drag || !isExplore()) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.kind === 'orbit') orbitAbout(drag.pivot, dx, dy);
    else panBy(dx, dy, canvas.clientWidth, canvas.clientHeight);
  }, true);
  const end = (e: PointerEvent): void => { if (drag && e.pointerId === drag.id) { drag = null; exploreDrag.kind = null; } };
  addEventListener('pointerup', end, true);
  addEventListener('pointercancel', end, true);
  addEventListener('blur', () => { drag = null; exploreDrag.kind = null; keys.clear(); });

  addEventListener('wheel', (e) => {
    if (!isExplore() || e.target !== canvas) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    zoomAt(Math.exp(px * 0.0015), e.clientX, e.clientY, canvas.clientWidth, canvas.clientHeight);
  }, { capture: true, passive: false });

  addEventListener('dblclick', (e) => {
    if (!isExplore() || e.target !== canvas) return;
    const id = brickAt(e.clientX, e.clientY);
    if (id < 0) return;
    e.stopImmediatePropagation();
    editBrick(id);
  }, true);

  addEventListener('keydown', (e) => {
    shift = e.shiftKey;
    if (!isExplore() || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    if (!WASD.has(k)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    keys.add(k);
  }, true);
  addEventListener('keyup', (e) => { shift = e.shiftKey; keys.delete(e.key.toLowerCase()); }, true);
}

/** One frame of WASD panning (dt from the frame clock) and keeping float32 positions exact far from the origin. */
export function exploreTick(t: number): void {
  const dt = Math.min(0.1, Math.max(0, (t - lastT) / 1000));
  lastT = t;
  if (!isExplore()) return;
  if (keys.size) {
    const dx = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0), dy = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
    const n = Math.hypot(dx, dy);
    if (n) { const v = PAN_SPEED * (shift ? FAST : 1) * dt / n; panView(dx * v, dy * v); }
  }
  if (!drag || drag.kind !== 'orbit') rebaseOrigin();
}

