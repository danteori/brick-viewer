// The ?test hook: window.__brickTest, used by the golden capture (scripts/golden-capture.mjs) and
// the e2e parity scripts. The same API is built for the legacy viewer from its globals, so both are
// driven identically.

import { ELEV, S, YAW0 } from './state.ts';
import { viewOf } from '../core/math.ts';
import { camSignature, isoSettling, toView, updateCamera, updateDirs } from '../render/camera.ts';
import { loadSave } from '../scene/load.ts';
import { brickView } from '../scene/view.ts';
import { setPreset } from '../ui/panels/file.ts';
import { statusText } from '../ui/status.ts';
import { clip, startPaste } from '../editor/clipboard.ts';
import type { Brick } from '../scene/brick.ts';
import { ed } from '../editor/ghost.ts';
import { selectBrick } from '../editor/resize.ts';
import { setSelection } from '../editor/select.ts';
import { inst, stats } from '../render/instances.ts';
import { resizeBlock } from '../editor/resize.ts';

export interface BrickTest {
  ready: true;
  renderer(): string;
  hideUi(): void;
  loadSave(b64: string, name: string): { status: string; bricks: number; zoom: number };
  setView(a: { k: number; pitchDeg?: number; zoom?: number; baseZoom: number }): void;
  setPreset(p: string): void;
  settle(): Promise<number>;
  snapshot(): unknown;
  /** world point (absolute viewer units) -> CSS px */
  project(x: number, y: number, z: number): [number, number];
  /** the focused brick's faces */
  focusBox(): { lo: number[]; hi: number[] };
  /** faces of brick k (k-th in list order) */
  brickBox(k: number): { lo: number[]; hi: number[] };
  /** scene ids in list order (the order snapshot() lists bricks in) */
  ids(): number[];
  /** the selection as list indices (as snapshot() numbers bricks) */
  selection(): number[];
  /** replaces the selection with these scene ids */
  select(ids: number[]): void;
  /** every live brick by id: [id, lo, hi, colour] (ids are stable, unlike list indices) */
  byId(): [number, number[], number[], number[]][];
  /** last frame's render counters: chunks and draws drawn, instances, render chunks in all */
  renderStats(): { chunks: number; draws: number; instances: number; total: number };
  /** refused edits so far and the last reason (the HUD shows it only briefly, so tests read it here) */
  blocks(): { n: number; reason: string; age: number };
  /** put bricks on the clipboard (lo / hi relative to the group's low corner) and start pasting them */
  paste(items: Brick[]): void;
  /** give brick k (k-th in list order) the focus (camera glides to it), keeping the zoom factor */
  focus(k: number): void;
}

/**
 * A brick record without the fields the legacy viewer doesn't have (intensity, pass-through save
 * data), so the parity scripts compare like with like.
 */
function paritySnap(id: number): unknown {
  const { intensity: _i, save: _s, ...rest } = brickView(S.scene, id);
  return rest;
}

export function installTestHook(canvas: HTMLCanvasElement): void {
  const raf = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
  const api: BrickTest = {
    ready: true,
    renderer() {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return 'no WebGL2';
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    },
    hideUi() {
      const st = document.createElement('style');
      st.textContent = 'body > :not(canvas) { visibility: hidden !important; } body.drop::after { display: none !important; }';
      document.head.append(st);
      S.noOverlay = true; S.mouse = null;
    },
    loadSave(b64, name) {
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      loadSave(u.buffer, name);
      return { status: statusText(), bricks: S.scene.count, zoom: S.zoomMul };
    },
    setView({ k, pitchDeg, zoom, baseZoom }) {
      S.orbit.yaw = S.orbit.yawT = YAW0 + k * Math.PI / 2;
      S.orbit.pitch = S.orbit.pitchT = pitchDeg === undefined ? ELEV : pitchDeg * Math.PI / 180;
      S.viewT = viewOf(S.orbit.yawT, S.orbit.pitchT);
      updateDirs();
      S.zoomMul = baseZoom * (zoom ?? 1);
    },
    setPreset,
    /**
     * Runs the camera glide without drawing until it has stopped: unchanged (to 1e-12) for 6 steps,
     * a repeat of either of the last two states counting (the glide can end in a 1-ulp two-step
     * cycle). The same maths and criterion as the legacy capture's frame loop, without the frames.
     * Then renders a few real frames. Returns steps taken (-1 = timed out).
     */
    async settle() {
      const dpr = devicePixelRatio || 1, w = canvas.clientWidth * dpr | 0, h = canvas.clientHeight * dpr | 0;
      let prev = '', prev2 = '', same = 0, frames = -1;
      for (let i = 0; i < 4000; i++) {
        updateCamera(w, h);
        const s = camSignature();
        if (!isoSettling() && (s === prev || s === prev2)) { if (++same >= 6) { frames = i; break; } } else same = 0;
        prev2 = prev;
        prev = s;
      }
      for (let i = 0; i < 3; i++) await raf();
      return frames;
    },
    project(x, y, z) {
      const cw = canvas.clientWidth, ch = canvas.clientHeight, cam = S.cam;
      const fx = Math.max(cw / ch, 1), fy = Math.max(ch / cw, 1), sx = 1 / (cam.half * fx), sy = 1 / (cam.half * fy);
      const v = toView(x, y, z);
      return [((v[0] - cam.x) * sx + 1) * cw / 2, (1 - (v[1] - cam.y) * sy) * ch / 2];
    },
    focusBox: () => ({ lo: S.lo.slice(), hi: S.hi.slice() }),
    brickBox: (k) => { const b = brickView(S.scene, S.scene.ordered()[k]!); return { lo: b.lo, hi: b.hi }; },
    ids: () => S.scene.ordered(),
    renderStats: () => ({ ...stats, total: inst.set?.chunks.size ?? 0 }),
    blocks: () => ({ n: resizeBlock.n, reason: resizeBlock.reason, age: performance.now() - resizeBlock.t }),
    selection: () => { const ids = S.scene.ordered(); return [...S.selection].map((id) => ids.indexOf(id)).sort((a, b) => a - b); },
    paste(items) { clip.items = items; startPaste(); },
    focus(k) { const z = S.zoomMul; selectBrick(S.scene.ordered()[k]!); S.zoomMul = z; },
    select: (ids) => setSelection(ids),
    byId: () => S.scene.ordered().map((id) => { const b = brickView(S.scene, id); return [id, b.lo, b.hi, b.color]; }),
    /** the scene as brick records (absolute) in list order, plus the focus and the editor state */
    snapshot() {
      const ids = S.scene.ordered();
      return {
        bricks: ids.map(paritySnap), sel: Math.max(0, ids.indexOf(S.sel)),
        clip: clip.items, pasteMode: clip.mode, ghost: !!ed.ghost, status: statusText(), held: S.held, zoom: +S.zoomMul.toPrecision(10), active: document.activeElement?.id || document.activeElement?.tagName,
      };
    },
  };
  (window as unknown as { __brickTest: BrickTest }).__brickTest = api;
}
