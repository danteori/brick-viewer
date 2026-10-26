// Tool modes (E-02 / E-03): Resize, Move and Paint, switched by the Tool buttons in the left panel
// or the keys 1 / 2 / 3. Shift+click / Shift+drag select in every mode (editor/input.ts).
//
//   Resize  the legacy behaviour: drag resizes the focused brick, click focuses another.
//   Move    the Resize drag, but it moves: grab a face (or drag anywhere) and the focused brick,
//           or the whole selection, shifts along one axis in grid steps; axis lock, right-click
//           commit, edge auto-drag and release work as in Resize (editor/move.ts). M also picks it.
//   Paint   click paints the brick under the cursor with the current paint (colour, material,
//           intensity: the palette's PaintModel); dragging paints every brick the cursor passes
//           over, picking along the path between pointer events so fast strokes skip nothing.
//           One stroke = one undo step, each brick painted once. Alt+click = fill paint (the
//           connected bricks of the clicked brick's colour and material, editor/fill.ts), as the
//           game's painter; Ctrl+click = eyedropper.
// Neither Move nor Paint ever resizes.

import { S, type EditTx } from '../app/state.ts';
import { pickRay, viewRay } from '../scene/spatial.ts';
import { histEnd, txBegin, txEnd } from '../scene/history.ts';
import { packRecords, REC_BYTES } from '../scene/record.ts';
import { cursorRay, ed, itemName } from './ghost.ts';
import { clip, setPasteMode, startPaste } from './clipboard.ts';
import { groupItems } from './selectops.ts';
import { eyedropBrick, paintModel, refreshFocus, sceneTarget } from '../ui/panels/paint.ts';
import { hexOfRgb8, materialLabel } from './paint.ts';
import { initAudio, playClick, playSelect } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';
import { saveString, loadString } from '../app/settings.ts';
import { isTyping } from './input.ts';
import { fillPaint } from './fill.ts';

export type Tool = 'resize' | 'move' | 'paint';
/** middle-click vs middle-drag: at most this many px of movement and this many ms */
export const MID_PX = 5, MID_MS = 400;
export const TOOLS: Tool[] = ['resize', 'move', 'paint'];
const TOOL_KEY = 'brickViewer.tool';
const LABEL: Record<Tool, string> = { resize: 'Resize', move: 'Move', paint: 'Paint' };

let buttons: HTMLButtonElement[] = [];
let canvas: HTMLCanvasElement;

export function setTool(t: Tool, quiet = false): void {
  if (S.held || ed.ghost) return;
  S.tool = t;
  for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  document.body.dataset.tool = t;
  saveString(TOOL_KEY, t);
  if (!quiet) {
    setStatus(t === 'resize' ? 'Resize tool: drag to resize the focused brick, click another brick to focus it'
      : t === 'move' ? 'Move tool: drag like Resize, but the focused brick (or the selection) moves along the axis; right-click commits an axis, release puts it down'
        : 'Paint tool: click or drag over bricks to paint them with the current paint; Alt+click takes a brick\'s paint');
    initAudio(); playClick();
  }
}

/** The brick under a screen point (CSS px), with the world point hit, or null. */
function pickAt(x: number, y: number): { id: number; at: number[] } | null {
  const r = cursorRay(x, y);
  if (!r) return null;
  const hit = pickRay(r.vx, r.vy);
  if (!hit || !S.scene.alive(hit.k)) return null;
  const v = viewRay(r.vx, r.vy);
  return { id: hit.k, at: v.S.map((s, i) => s + v.D[i]! * hit.s) };
}

// --- Paint strokes ---------------------------------------------------------------------------------

let stroke: { tx: EditTx; done: Set<number>; last: [number, number] } | null = null;
/** each stroke brick's record from before its first paint */
const strokeBefore = new Map<number, Uint8Array>();

function paintId(id: number): void {
  if (!stroke || stroke.done.has(id) || !S.scene.alive(id)) return;
  stroke.done.add(id);
  strokeBefore.set(id, packRecords(S.scene, [id]));
  const ch = paintModel().applyPaint(sceneTarget, [id], {}, 'paint');
  if (!ch.ids.length) return;
  stroke.tx.ids.push(id);
  if (id === S.sel) refreshFocus();
}

/** Paints along the screen segment a -> b, one pick every few px (fast strokes skip nothing). */
function paintAlong(a: readonly number[], b: readonly number[]): void {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!) / 3));
  for (let k = 1; k <= n; k++) {
    const h = pickAt(a[0]! + (b[0]! - a[0]!) * k / n, a[1]! + (b[1]! - a[1]!) * k / n);
    if (h) paintId(h.id);
  }
}

/** Ends the stroke: one undo step over the bricks it painted (their records from before their first paint). */
function endStroke(): void {
  const s = stroke;
  if (!s) return;
  stroke = null;
  const t = s.tx, ids = t.ids;
  if (!ids.length) { strokeBefore.clear(); return; }
  const before = new Uint8Array(ids.length * REC_BYTES);
  ids.forEach((id, j) => before.set(strokeBefore.get(id)!, j * REC_BYTES));
  t.ids = ids; t.before = before; t.beforeHas = new Uint8Array(ids.length).fill(1);
  strokeBefore.clear();
  txEnd(t);
  const p = paintModel().paint;
  setStatus(`Painted ${ids.length} brick${ids.length === 1 ? '' : 's'} ${hexOfRgb8(p.colour)} · ${materialLabel(p.material)} · intensity ${p.intensity * 10} %`);
}


export function initTools(c: HTMLCanvasElement): void {
  canvas = c;
  buttons = [...document.querySelectorAll<HTMLButtonElement>('#tool button[data-tool]')];
  for (const b of buttons) {
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', () => setTool(b.dataset.tool as Tool));
  }
  const saved = loadString(TOOL_KEY);
  setTool(TOOLS.includes(saved as Tool) && !S.testMode ? (saved as Tool) : 'resize', true);

  addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const i = ['1', '2', '3'].indexOf(e.key);
    if (i >= 0 && !ed.ghost && !S.held) { e.preventDefault(); setTool(TOOLS[i]!); }
    else if ((e.key === 'm' || e.key === 'M') && !e.shiftKey && !ed.ghost && !S.held) { e.preventDefault(); setTool('move'); }
  });

  // Paint: a left press on the canvas is its own (not a resize). Shift (select) and a ghost that is
  // out are handled by editor/input.ts before this. Move goes through the resize drag (move.ts).
  addEventListener('pointerdown', (e) => {
    if (S.tool !== 'paint' || e.button !== 0 || e.target !== canvas || e.shiftKey || ed.ghost || S.held || S.orbit.dragging) return;
    e.stopImmediatePropagation(); e.preventDefault();
    initAudio();
    const h = pickAt(e.clientX, e.clientY);
    if (e.altKey) { if (h) void fillPaint(h.id); return; }
    if (e.ctrlKey || e.metaKey) { if (h) { eyedropBrick(h.id); playSelect(); } return; }
    histEnd();
    stroke = { tx: txBegin('paint', []), done: new Set(), last: [e.clientX, e.clientY] };
    if (h) paintId(h.id);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  }, true);
  addEventListener('pointermove', (e) => {
    if (stroke) {
      if (!(e.buttons & 1)) { endStroke(); return; }
      const a = stroke.last, b: [number, number] = [e.clientX, e.clientY];
      stroke.last = b;
      paintAlong(a, b);
      return;
    }
  }, true);
  const up = (e: PointerEvent): void => {
    if (stroke) { e.stopImmediatePropagation(); endStroke(); return; }
  };
  addEventListener('pointerup', up, true);
  addEventListener('pointercancel', up, true);
  addEventListener('blur', () => { if (stroke) endStroke(); });

  // Middle-click (no drag) on a brick: copy it and hold the copy in a place ghost, as Ctrl+C then
  // Ctrl+V (U-23). A middle drag still orbits: it's a click while it moves under MID_PX and lets go
  // within MID_MS.
  let mid: { x: number; y: number; t: number; id: number } | null = null;
  addEventListener('pointerdown', (e) => {
    if (e.button !== 1 || e.target !== canvas) { mid = null; return; }
    const h = ed.ghost || S.held ? null : pickAt(e.clientX, e.clientY);
    mid = h ? { x: e.clientX, y: e.clientY, t: performance.now(), id: h.id } : null;
  }, true);
  addEventListener('pointerup', (e) => {
    const m = mid;
    mid = null;
    if (!m || e.button !== 1 || ed.ghost || S.held) return;
    if (Math.hypot(e.clientX - m.x, e.clientY - m.y) > MID_PX || performance.now() - m.t > MID_MS || !S.scene.alive(m.id)) return;
    S.orbit.dragging = false;
    clip.items = groupItems([m.id]);
    setPasteMode('brick');
    startPaste();
    setStatus(`Copied ${itemName(clip.items[0]!)}: click to place it (R turns, PgUp / PgDn raise / lower, Esc cancels); Ctrl+V places another`);
    initAudio(); playClick();
  }, true);

  S.hooks.hud.push(() => `tool <b>${LABEL[S.tool]}</b> (1 Resize · 2 Move · 3 Paint) · middle-click a brick to place a copy`);
}
