// The ?test hook: window.__brickTest, used by the golden capture (scripts/golden-capture.mjs) and
// the e2e parity scripts. The same API is built for the legacy viewer from its globals, so both are
// driven identically.

import { ELEV, S, YAW0 } from './state.ts';
import { viewOf } from '../core/math.ts';
import { camSignature, isoSettling, toView, updateCamera, updateDirs } from '../render/camera.ts';
import { loadSave } from '../scene/load.ts';
import { snapBrick } from '../scene/history.ts';
import { setPreset } from '../ui/panels/file.ts';
import { statusText } from '../ui/status.ts';
import { clip } from '../editor/clipboard.ts';
import { ed } from '../editor/ghost.ts';

export interface BrickTest {
  ready: true;
  renderer(): string;
  hideUi(): void;
  loadSave(b64: string, name: string): { status: string; bricks: number; zoom: number };
  setView(a: { k: number; pitchDeg?: number; zoom?: number; baseZoom: number }): void;
  setPreset(p: string): void;
  settle(): Promise<number>;
  snapshot(): unknown;
  /** world point (current frame, viewer units) -> CSS px */
  project(x: number, y: number, z: number): [number, number];
  /** the focused brick's faces in the current frame */
  focusBox(): { lo: number[]; hi: number[] };
  /** brick k's faces in the current frame */
  brickBox(k: number): { lo: number[]; hi: number[] };
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
      return { status: statusText(), bricks: S.bricks.length, zoom: S.zoomMul };
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
    brickBox: (k) => ({ lo: S.bricks[k].lo.slice(), hi: S.bricks[k].hi.slice() }),
    /** the scene as frame-independent records, plus the focus and the editor state */
    snapshot() {
      return {
        bricks: S.bricks.map((_, k) => snapBrick(k)), sel: S.sel,
        clip: clip.items, pasteMode: clip.mode, ghost: !!ed.ghost, status: statusText(), held: S.held, zoom: +S.zoomMul.toPrecision(10), active: document.activeElement?.id || document.activeElement?.tagName,
      };
    },
  };
  (window as unknown as { __brickTest: BrickTest }).__brickTest = api;
}
