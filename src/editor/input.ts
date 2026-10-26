// Editor input. Capture-phase listeners on window, so a ghost gets the canvas clicks / wheel before
// the resize / focus / zoom handlers, and Shift+click / Shift+drag select (E-01) instead of
// focusing or resizing.

import { S, hasFocus } from '../app/state.ts';
import { ed, endPlacing, ghostName, nudgeGhost, gsteps } from './ghost.ts';
import { beginReorient, endReorient, reorienting, reorientMove, rotateTap } from './rotate.ts';
import { placeGhost } from './ops.ts';
import { clip, startPaste } from './clipboard.ts';
import { clearSelection, marqueeSelect, selectAll, selector, toggleSelect } from './select.ts';
import { G as Gfx, setBox } from '../render/draw.ts';
import { BOX_EDGE_COUNT, boxEB, boxIB } from '../render/meshes/registry.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { copySelection, cutSelection, deleteSelection } from './selectops.ts';
import { MICRO } from '../core/units.ts';
import { setStatus } from '../ui/status.ts';
import { initAudio, playClick, playSelect } from '../ui/audio.ts';
import { escapeStep, isFree } from '../app/mode.ts';
import { anyOpen, closeTop, openWindow } from '../ui/windows.ts';
import { onUp, selectBrick } from './resize.ts';
import { beginDrag, cancelDrag, canDrag, dragHud, dragging, endDrag, finishDragAxis, toggleDragMode } from './dragplace.ts';

export const isTyping = (a: EventTarget | null): boolean => {
  const e = a as HTMLElement | null;
  return !!e && (e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable ||
    (e.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|color|file)$/i.test((e as HTMLInputElement).type)));
};

let rShift = false;

/** Where a drag placement was pressed (screen px): a release within DRAG_DEAD px is a plain click. */
let press: [number, number] | null = null;
/** Where the right button went down with a ghost out: a release within DRAG_DEAD px puts the ghost away. */
let rightPress: [number, number] | null = null;
const DRAG_DEAD = 4;
const near = (a: [number, number], e: MouseEvent): boolean => Math.hypot(e.clientX - a[0], e.clientY - a[1]) <= DRAG_DEAD;

/** Places the ghost where the cursor is; a brick stays in hand, a move or an import goes away. */
function placeHere(): void {
  const G = ed.ghost;
  if (!G) return;
  const stays = canDrag(G);
  if (placeGhost() && !stays) endPlacing();
  if (stays) G.mode = 'click';
}

/** A Shift+drag box select in progress (screen px), and its rectangle on the page. */
let box: { x0: number; y0: number; x1: number; y1: number; remove: boolean; dragging: boolean; id: number } | null = null;
let boxEl: HTMLElement | null = null;
const BOX_DEAD = 5;
function showBox(): void {
  if (!box || !box.dragging) { if (boxEl) boxEl.hidden = true; return; }
  if (!boxEl) { boxEl = document.createElement('div'); boxEl.id = 'marquee'; document.body.append(boxEl); }
  const x = Math.min(box.x0, box.x1), y = Math.min(box.y0, box.y1);
  Object.assign(boxEl.style, { left: x + 'px', top: y + 'px', width: Math.abs(box.x1 - box.x0) + 'px', height: Math.abs(box.y1 - box.y0) + 'px' });
  boxEl.classList.toggle('remove', box.remove);
  boxEl.hidden = false;
}

/** The selection's HUD line. */
export function selectionHud(): string {
  const n = S.selection.size;
  return n
    ? `<b>${n} brick${n === 1 ? '' : 's'} selected</b> · the Move tool (2 or M) drags them along an axis · Ctrl+C / Ctrl+X copy / cut · Alt+X / Alt+Y mirror · Delete removes · Shift+click adds or removes one · Shift+drag adds a box, Ctrl+Shift+drag removes · Esc clears`
    : 'Shift+click a brick to select it · Shift+drag box-selects (Ctrl+Shift+drag removes) · Ctrl+A selects all · the Move tool (2 or M) moves the focused brick';
}
/** Esc: close the top window, else drop the brick in hand (or cancel the tool drag), else deselect, else open the Menu. The classic test camera keeps its focus and opens no Menu while it has one. */
/** Esc: close the top window, else drop the brick in hand (or cancel the tool drag), else deselect, else open the Menu. */
export function escape(): void {
  const step = escapeStep({ window: anyOpen(), inHand: !!ed.ghost || S.held, selected: S.selection.size > 0 || (isFree() && hasFocus()) });
  if (step === 'window') closeTop();
  else if (step === 'drop') {
    if (ed.ghost) endPlacing(ed.ghost.cancelText ?? (ed.ghost.onPlace ? 'Move cancelled: the bricks are back' : 'Placement cancelled'));
    else onUp({ type: 'pointercancel' });
  } else if (step === 'deselect') { clearSelection(); if (isFree()) selectBrick(-1); setStatus('Selection cleared'); }
  else if (isFree() || !hasFocus()) openWindow('escmenu');
}

export function initEditorInput(canvas: HTMLCanvasElement): void {
  S.hooks.hud.push(selectionHud);
  // the Box selector's box: an orange outline on top while it's active
  S.hooks.draw.push(() => {
    const bx = selector.box;
    if (!bx) return;
    const { gl, u } = Gfx, U = BRZ_UNIT;
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(u.uEdge, 1); gl.uniform1f(u.uFadeR, 0); gl.uniform4f(u.uLine, 1, 0.62, 0.28, 0.95);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxEB);
    setBox(bx.b.slice(0, 3).map((v) => v * U), bx.b.slice(3).map((v) => v * U));
    gl.drawElements(gl.LINES, BOX_EDGE_COUNT, gl.UNSIGNED_SHORT, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    setBox(S.dlo, S.dhi);
  });
  S.hooks.hud.push(() => {
    const G = ed.ghost;
    return G
      ? `<b>placing ${ghostName(G.items)}</b>${G.pose && !G.valid ? ` <b style="color:#ff7a66">(blocked: ${G.reason})</b>` : ''} · ${dragHud()} · ` +
        `${G.mode === 'drag' ? 'release' : 'click'} to place · R or Ctrl+scroll rotates (Shift+R back), hold R and drag toward an axis to point the top that way · ` +
        `PgUp / PgDn or Shift+scroll raise / lower one ${gsteps(G.items)[2] === MICRO ? 'micro' : 'plate'}${G.dz ? ` (<b>${G.dz > 0 ? '+' : ''}${G.dz}</b>)` : ''} · Esc or right-click cancels`
      : 'drag a brick from Bricks into the scene (or click it, then click to place) · Ctrl+C copies the focused brick · ' +
        `Ctrl+V ${clip.mode === 'brick' ? 'pastes it' : 'opens a copied .brz (switch under Open save)'} · Delete removes the focused brick · ` +
        'R rotates the focused brick (Shift+R back), hold R and drag toward an axis to point its top that way';
  });
  addEventListener('pointermove', (e) => {
    ed.lastMouse = [e.clientX, e.clientY]; ed.lastOver = e.target === canvas;
    if (reorienting()) { reorientMove(ed.lastMouse); return; }   // R held: the drag points the top; the ghost stays put
    const G = ed.ghost;
    if (!G) return;
    G.mouse = ed.lastMouse; G.over = ed.lastOver; if (ed.lastOver) G.visited = true;
    if (G.mode === 'drag' && !(e.buttons & 1)) endPlacing('Placement cancelled');   // released outside the window
  }, true);
  addEventListener('pointerdown', (e) => {
    const G = ed.ghost;
    if (!G || e.target !== canvas || e.button === 1) return;     // the middle button still orbits
    e.stopImmediatePropagation(); e.preventDefault();
    if (e.button === 2) { if (!dragging()) rightPress = [e.clientX, e.clientY]; return; }
    if (e.button !== 0 || G.mode !== 'click') return;
    if (canDrag(G) && beginDrag(G, [e.clientX, e.clientY])) {
      press = [e.clientX, e.clientY];
      try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      return;
    }
    placeHere();
  }, true);
  addEventListener('mousedown', (e) => {
    if (e.button !== 2 || !dragging()) return;
    e.stopImmediatePropagation(); e.preventDefault();
    finishDragAxis();
  }, true);
  addEventListener('pointerup', (e) => {
    const G = ed.ghost;
    if (e.button === 2 && rightPress) {
      const click = near(rightPress, e);
      rightPress = null;
      if (G && click && !dragging()) { e.stopImmediatePropagation(); endPlacing('Placement cancelled'); }
      return;
    }
    if (G && e.button === 0 && dragging()) {
      const p0 = press!, still = near(p0, e);
      press = null;
      if (still) cancelDrag();
      if ((still ? 'single' : endDrag()) === 'single') { G.mouse = p0; G.over = true; placeHere(); }
      return;
    }
    if (!G || G.mode !== 'drag' || e.button !== 0) return;
    G.mouse = [e.clientX, e.clientY]; G.over = e.target === canvas;
    if (G.over) { placeHere(); return; }           // refused: placeGhost said why
    const t = e.target as Element | null;
    const onItem = t?.closest && t.closest('.bitem') === G.from;
    if (!G.visited && onItem) { G.mode = 'click'; setStatus(`Placing ${ghostName(G.items)}: click in the scene to place, Esc cancels`); return; }
    endPlacing('Placement cancelled');
  }, true);
  addEventListener('dblclick', (e) => { if (ed.ghost || performance.now() - ed.lastPlaceT < 600) e.stopImmediatePropagation(); }, true);
  let wheelAcc = 0;
  addEventListener('wheel', (e) => {
    if (!ed.ghost || !(e.ctrlKey || e.shiftKey || e.metaKey)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const px = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? innerHeight : 1);   // Shift+wheel often arrives as deltaX
    let d = 0;
    if (Math.abs(px) >= 60) { wheelAcc = 0; d = Math.sign(px); }
    else { wheelAcc += px; if (Math.abs(wheelAcc) >= 60) { d = Math.sign(wheelAcc); wheelAcc = 0; } }
    if (!d) return;
    if (e.shiftKey) nudgeGhost(-d);               // wheel up = raise
    else rotateTap(d < 0 ? 1 : -1);
  }, { capture: true, passive: false });
  addEventListener('keydown', (e) => {
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (k === 'Escape' && !ctrl && !e.altKey && (!isTyping(e.target) || (e.target as HTMLElement).tagName === 'SELECT')) {
      e.preventDefault(); (e.target as HTMLElement).blur?.(); escape(); return;
    }
    if (isTyping(e.target)) return;
    if (ctrl && !e.altKey && !e.shiftKey && (k === 'c' || k === 'C')) { if (!S.held && !ed.ghost) copySelection(); return; }
    if (ctrl && !e.altKey && !e.shiftKey && (k === 'x' || k === 'X')) { if (!S.held && !ed.ghost) { e.preventDefault(); cutSelection(); } return; }
    if (ctrl && !e.altKey && !e.shiftKey && (k === 'v' || k === 'V')) { if (clip.mode === 'brick' && clip.items && !S.held) { e.preventDefault(); startPaste(); } return; }
    if (ctrl && !e.altKey && !e.shiftKey && (k === 'a' || k === 'A')) {
      e.preventDefault();
      if (!S.held && !ed.ghost) { const n = selectAll(); setStatus(`Selected all ${n} brick${n === 1 ? '' : 's'}`); initAudio(); playSelect(); }
      return;
    }
    if (ctrl || e.altKey) return;
    if (k === 'r' || k === 'R') {
      if (ed.ghost || hasFocus()) e.preventDefault();
      if (e.repeat || S.held || reorienting() || (!ed.ghost && !hasFocus())) return;
      rShift = e.shiftKey; beginReorient(ed.lastMouse);       // a tap rotates on release; a drag reorients
      return;
    }
    if (ed.ghost) {
      if (k === 'PageUp' || k === 'PageDown') { e.preventDefault(); nudgeGhost(k === 'PageUp' ? 1 : -1); }
      if ((k === 'j' || k === 'J') && !e.repeat) { e.preventDefault(); toggleDragMode(); }
      return;
    }
    if (k === 'Delete') { e.preventDefault(); deleteSelection(); }
  });
  // Shift+click toggles a brick in the selection; Shift+drag draws a box (Ctrl+Shift+drag removes)
  addEventListener('pointerdown', (e) => {
    if (!e.shiftKey || e.button !== 0 || e.target !== canvas || ed.ghost || S.held || S.orbit.dragging) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const id = S.hoverBrick >= 0 ? S.hoverBrick : S.hoverAxis >= 0 ? S.sel : -1;
    box = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, remove: e.ctrlKey || e.metaKey, dragging: false, id };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  }, true);
  addEventListener('pointermove', (e) => {
    if (!box) return;
    box.x1 = e.clientX; box.y1 = e.clientY;
    if (!box.dragging && Math.hypot(box.x1 - box.x0, box.y1 - box.y0) > BOX_DEAD) box.dragging = true;
    showBox();
  }, true);
  const endBox = (e: PointerEvent): void => {
    const b = box;
    if (!b) return;
    box = null; showBox();
    if (e.type !== 'pointerup') return;
    e.stopImmediatePropagation();
    initAudio();
    if (b.dragging) {
      const n = marqueeSelect(canvas, b.x0, b.y0, b.x1, b.y1, b.remove ? 'remove' : 'add');
      setStatus(`${b.remove ? 'Removed' : 'Added'} ${n} brick${n === 1 ? '' : 's'} · ${S.selection.size} selected`);
      playClick();
    } else if (b.id >= 0) {
      toggleSelect(b.id);
      setStatus(selector.mode === 'box' ? `Box: ${S.selection.size} brick${S.selection.size === 1 ? '' : 's'} fully inside` : `${S.selection.has(b.id) ? 'Selected' : 'Deselected'} a brick · ${S.selection.size} selected`);
      playSelect();
    }
  };
  addEventListener('pointerup', endBox, true);
  addEventListener('pointercancel', endBox, true);
  addEventListener('keyup', (e) => {
    if ((e.key === 'r' || e.key === 'R') && reorienting() && endReorient()) rotateTap(rShift ? -1 : 1);
  });
  addEventListener('pointercancel', () => { rightPress = null; if (dragging()) { cancelDrag(); press = null; } }, true);
  addEventListener('blur', () => { endReorient(); cancelDrag(); press = null; rightPress = null; if (ed.ghost && ed.ghost.mode === 'drag') endPlacing(); });
}
