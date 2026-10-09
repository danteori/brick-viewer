// Editor input. Capture-phase listeners on window, so a ghost gets the canvas clicks / wheel before
// the resize / focus / zoom handlers.

import { S } from '../app/state.ts';
import { ed, endPlacing, ghostName, nudgeGhost, gsteps } from './ghost.ts';
import { beginReorient, endReorient, reorienting, reorientMove, rotateTap } from './rotate.ts';
import { deleteFocused, placeGhost } from './ops.ts';
import { clip, copyFocused, startPaste } from './clipboard.ts';
import { MICRO } from '../core/units.ts';
import { setStatus } from '../ui/status.ts';

export const isTyping = (a: EventTarget | null): boolean => {
  const e = a as HTMLElement | null;
  return !!e && (e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable ||
    (e.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|color|file)$/i.test((e as HTMLInputElement).type)));
};

let rShift = false;

export function initEditorInput(canvas: HTMLCanvasElement): void {
  S.hooks.hud.push(() => {
    const G = ed.ghost;
    return G
      ? `<b>placing ${ghostName(G.items)}</b>${G.pose && !G.valid ? ` <b style="color:#ff7a66">(blocked: ${G.reason})</b>` : ''} · ` +
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
    if (e.button === 2) { endPlacing('Placement cancelled'); return; }
    if (e.button === 0 && G.mode === 'click' && placeGhost()) endPlacing();
  }, true);
  addEventListener('pointerup', (e) => {
    const G = ed.ghost;
    if (!G || G.mode !== 'drag' || e.button !== 0) return;
    G.mouse = [e.clientX, e.clientY]; G.over = e.target === canvas;
    if (G.over) { placeGhost(); endPlacing(); return; }           // refused: placeGhost said why
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
    if (isTyping(e.target)) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.altKey && !e.shiftKey && (k === 'c' || k === 'C')) { if (!S.held) copyFocused(); return; }
    if (ctrl && !e.altKey && !e.shiftKey && (k === 'v' || k === 'V')) { if (clip.mode === 'brick' && clip.items && !S.held) { e.preventDefault(); startPaste(); } return; }
    if (ctrl || e.altKey) return;
    if (k === 'r' || k === 'R') {
      if (ed.ghost || S.bricks[S.sel]) e.preventDefault();
      if (e.repeat || S.held || reorienting() || (!ed.ghost && !S.bricks[S.sel])) return;
      rShift = e.shiftKey; beginReorient(ed.lastMouse);       // a tap rotates on release; a drag reorients
      return;
    }
    if (ed.ghost) {
      if (k === 'Escape') { e.preventDefault(); endPlacing('Placement cancelled'); }
      else if (k === 'PageUp' || k === 'PageDown') { e.preventDefault(); nudgeGhost(k === 'PageUp' ? 1 : -1); }
      return;
    }
    if (k === 'Delete') { e.preventDefault(); deleteFocused(); }
  });
  addEventListener('keyup', (e) => {
    if ((e.key === 'r' || e.key === 'R') && reorienting() && endReorient()) rotateTap(rShift ? -1 : 1);
  });
  addEventListener('blur', () => { endReorient(); if (ed.ghost && ed.ghost.mode === 'drag') endPlacing(); });
}
