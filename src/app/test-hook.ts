// The ?test hook: window.__brickTest, used by the golden capture (scripts/golden-capture.mjs) and
// the e2e parity scripts. The same API is built for the legacy viewer from its globals, so both are
// driven identically.

import { cameraStyle } from './mode.ts';
import { persp } from '../render/persp.ts';
import { gliding } from './explore.ts';
import { closeWindow, openWindow, openWindows } from '../ui/windows.ts';
import { ELEV, S, YAW0 } from './state.ts';
import { viewOf } from '../core/math.ts';
import { camSignature, isoSettling, toView, updateCamera, updateDirs } from '../render/camera.ts';
import { hasParser, loadSave, loadSaveAsync, loadSettings } from '../scene/load.ts';
import { brickView } from '../scene/view.ts';
import { setPreset } from '../ui/panels/file.ts';
import { downloadTap } from '../scene/save.ts';
import { statusText } from '../ui/status.ts';
import { clip, startPaste } from '../editor/clipboard.ts';
import type { Brick } from '../scene/brick.ts';
import { ed } from '../editor/ghost.ts';
import { selectBrick } from '../editor/resize.ts';
import { xrayAuto } from '../editor/autoxray.ts';
import { cut } from '../render/cutaway.ts';
import type { XrayMode } from '../render/xraymodes.ts';
import { setXrayMode } from '../ui/panels/view.ts';
import { setSelection } from '../editor/select.ts';
import { inst, stats } from '../render/instances.ts';
import { MAT_HIDDEN } from '../render/matcode.ts';
import { hiddenShown, hiddenView } from './hidden.ts';
import { resizeBlock } from '../editor/resize.ts';
import { componentsOf } from '../scene/compmodel.ts';
import { brickKey } from '../scene/components.ts';
import type { WireEnd } from '../scene/wires.ts';
import { wireView } from '../ui/overlay/wires.ts';
import { setLightView, setZoneView, volumeView } from '../ui/overlay/volumes.ts';
import { live, shownPrompt } from '../ui/panels/logic.ts';
import { figureBoxes } from '../render/figure.ts';
import { gridSetOf, rowsOfGrid } from '../scene/dyngrids.ts';
import { setGraphicsPreset, setViewerGraphics } from './graphics.ts';
import { applyEnvironment, applyWorldBaseMap, clearEnvironment } from './environment.ts';
import { loadedFiles } from '../scene/load.ts';
import { shownProxies } from '../render/proxies.ts';
import { defaultEnvironment, setEnvValue } from '../format/environment.ts';
import { defaultGraphicsPreset, withQualityLevel } from '../format/graphics.ts';
import { fxDebug } from '../render/fx/frame.ts';

export interface BrickTest {
  ready: true;
  renderer(): string;
  hideUi(): void;
  /** from now on downloads are kept here, not given to the browser */
  captureDownloads(): void;
  /** the last captured download as base64, or null */
  lastDownload(): { name: string; b64: string } | null;
  loadSave(b64: string, name: string): { status: string; bricks: number; zoom: number };
  /** loads as opening a file does, through the parse worker when there is one (S-01; any size); cullMax = the main-thread face-culling cap meanwhile */
  loadSaveWorker(b64: string, name: string, cullMax?: number): Promise<{ status: string; bricks: number; zoom: number; viaWorker: boolean }>;
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
  /** auto X-ray on a new focus (U-33; off in ?test until this turns it on) */
  autoXray(on: boolean): void;
  /** the X-ray settings: on, Hole (cut.size) and Keep (cut.keep, viewer units) */
  xray(): { on: boolean; size: number; keep: number; mode: string; room: boolean };
  /** picks the X-ray mode (tube, slice, room, ghost) as its panel button does */
  xrayMode(mode: string): void;
  /** the scene's components and wires (C-02 / C-03): each instance as [brick key, type, data as JSON], each wire as "source -> target" */
    volumes(): { zones: boolean; lights: boolean; drawn: { zones: number; water: number; point: number; spot: number } };
    setVolumes(zones: boolean, lights: boolean): void;
  components(): { instances: [string, string, string][]; wires: string[]; dirty: boolean; refused: number; drawn: { wires: number; ports: number } } | null;
  /** the live logic (C-13): tick count, rate, pause, the texts shown and the switches' states */
  logic(): { ticks: number; tps: number; paused: boolean; prompt: string | null; texts: string[]; switches: boolean[] };
  /** list index of the scene row showing save brick `key` ("grid/x_y_z/index"), or -1 */
  rowOfBrick(key: string): number;
  /** the player reference figure's part boxes (absolute viewer units), empty while it's off */
  figureBoxes(): [number[], number[]][];
  /** the entity proxies shown (balls and wheels) */
  proxies(): { id: number; kind: string; centre: number[]; scale: number; colours: number[][] }[];
  /** applies the loaded world's base map (tests skip it on load) and returns the ground plate: null, or its colour and stud flag */
  baseMap(): { color: number[]; studs: boolean } | null;
  /** the scene's dynamic grids (W-03): persistent index, transform and their rows' ids; null without a GridSet */
  /** the camera style: 'free' (the one mode) or 'classic' (plain ?test) */
  mode(): string;
  /** whether a double-click glide is still moving the camera */
  gliding(): boolean;
  /** the focused brick's list index, or -1 with no focus */
  focused(): number;
  /** the open windows, oldest first, and opening or closing one by id */
  windows(): string[];
  openWindow(id: string): void;
  closeWindow(id: string): void;
  /** the camera: view-plane centre, half-height, yaw and pitch (radians) */
  camera(): { x: number; y: number; half: number; yaw: number; pitch: number };
  persp(): { on: boolean; fly: boolean; follow: boolean; eye: number[]; anchor: number[]; dist: number; effDist: number };
  grids(): { id: number; origin: number[]; frac: number[]; quat: number[]; ids: number[] }[] | null;
  /**
   * Graphics effects (L-03 / L-06; off in ?test until this is called): on / off, the game quality
   * level 0..3 for every group (default: our defaults), and an environment to apply ('none' keeps
   * the lighting preset; 'default' the game's default with its ground plate; 'water' that plus
   * water 40 units deep). Adaptive quality stays off so captures are deterministic.
   */
  setGraphics(a: { on: boolean; level?: number; env?: 'none' | 'default' | 'water' }): void;
  /** what the effects did last frame */
  graphicsState(): { shadow: boolean; shadowTexel: number; ao: number; water: boolean; on: boolean };
  /** hidden bricks (Visible off, E-21): the view mode, whether they show now, and the packed ghost rows */
  hidden(): { mode: string; shown: boolean; ghosts: number };
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
  let lastDownload: { name: string; b64: string } | null = null;
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
    captureDownloads() {
      downloadTap.take = (bytes, name) => {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        lastDownload = { name, b64: btoa(bin) };
        return true;
      };
    },
    lastDownload() { const d = lastDownload; lastDownload = null; return d; },
    loadSave(b64, name) {
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      loadSave(u.buffer, name);
      return { status: statusText(), bricks: S.scene.count, zoom: S.zoomMul };
    },
    async loadSaveWorker(b64, name, cullMax) {
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const fc = (globalThis as { __faceCull?: { maxBricks: number } }).__faceCull, was = loadSettings.workerMinBytes, cap = fc?.maxBricks;
      loadSettings.workerMinBytes = 0;
      if (fc && cullMax !== undefined) fc.maxBricks = cullMax;
      try { await loadSaveAsync(u, name); await raf(); } finally { loadSettings.workerMinBytes = was; if (fc && cap !== undefined) fc.maxBricks = cap; }
      return { status: statusText(), bricks: S.scene.count, zoom: S.zoomMul, viaWorker: hasParser() };
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
    mode: () => cameraStyle(),
    gliding: () => gliding(),
    focused: () => S.scene.ordered().indexOf(S.sel),
    windows: () => openWindows(),
    openWindow: (id) => { openWindow(id); },
    closeWindow: (id) => { closeWindow(id); },
    camera: () => ({ x: S.cam.x, y: S.cam.y, half: S.cam.half, yaw: S.orbit.yaw, pitch: S.orbit.pitch }),
    persp: () => ({ on: persp.on, fly: persp.fly, follow: persp.follow, eye: persp.eye.slice(), anchor: persp.anchor.slice(), dist: persp.dist, effDist: persp.effDist }),
    focusBox: () => ({ lo: S.lo.slice(), hi: S.hi.slice() }),
    brickBox: (k) => { const b = brickView(S.scene, S.scene.ordered()[k]!); return { lo: b.lo, hi: b.hi }; },
    ids: () => S.scene.ordered(),
    renderStats: () => ({ ...stats, total: inst.set?.chunks.size ?? 0 }),
    blocks: () => ({ n: resizeBlock.n, reason: resizeBlock.reason, age: performance.now() - resizeBlock.t }),
    selection: () => { const ids = S.scene.ordered(); return [...S.selection].map((id) => ids.indexOf(id)).sort((a, b) => a - b); },
    paste(items) { clip.items = items; clip.origin = null; startPaste(); },
    focus(k) { const z = S.zoomMul; selectBrick(S.scene.ordered()[k]!); S.zoomMul = z; },
    autoXray: (on) => { xrayAuto.on = on; },
    xray: () => ({ on: cut.on, size: cut.size, keep: cut.keep, mode: cut.mode, room: !!cut.room }),
    xrayMode: (mode) => setXrayMode(mode as XrayMode),
    select: (ids) => setSelection(ids),
    volumes: () => ({ zones: volumeView.zones, lights: volumeView.lights, drawn: { ...volumeView.drawn } }),
    setVolumes: (zones, lights) => { setZoneView(zones); setLightView(lights); },
    components() {
      const m = componentsOf(S.scene);
      if (!m) return null;
      const js = (x: unknown): string => JSON.stringify(x, (_k, v: unknown) => (v instanceof Map ? { $map: [...v] } : typeof v === 'bigint' ? `${v}n` : v)) ?? '';
      const end = (e: WireEnd): string => `${brickKey(e)}/${e.component}.${e.port}`;
      return {
        instances: m.store.instances.map((c) => [brickKey(c.brickRef), c.type, js(c.data)] as [string, string, string]).sort((a, b) => (a.join() < b.join() ? -1 : 1)),
        wires: m.wires.wires().map((w) => `${end(w.source)} -> ${end(w.target)}`).sort(),
        dirty: m.dirty, refused: wireView.refused.n, drawn: { ...wireView.drawn },
      };
    },
    logic: () => ({
      ticks: live.ev?.ticks ?? 0, tps: live.clock.tps, paused: live.clock.paused, prompt: shownPrompt(),
      texts: live.shownTexts().map((s) => s.text), switches: live.graph?.ofKind('switch').map((n) => live.ev!.switchOn(n)) ?? [],
    }),
    rowOfBrick(key) {
      const m = componentsOf(S.scene), [g, c, b] = key.split('/');
      if (!m) return -1;
      const [X, Y, Z] = c!.split('_').map(Number);
      const row = m.rowOfRef({ grid: +g!, chunk: { X: X!, Y: Y!, Z: Z! }, brick: +b! });
      return row < 0 ? -1 : S.scene.ordered().indexOf(row);
    },
    figureBoxes: () => figureBoxes().map(([l, h]) => [l.slice(), h.slice()]),
    proxies: () => shownProxies().map((p) => ({ id: p.id, kind: p.kind, centre: p.centre.slice(), scale: p.scale, colours: p.colours.map((c) => c.slice()) })),
    baseMap() {
      const g = loadedFiles ? applyWorldBaseMap(loadedFiles) : null;
      return g && { color: g.color.slice(), studs: g.studTexture };
    },
    grids() {
      const set = gridSetOf(S.scene);
      return set && [...set.grids].sort((a, b) => a[0] - b[0]).map(([id, x]) => ({ id, origin: x.origin.slice(), frac: x.frac.slice(), quat: x.quat.slice(), ids: rowsOfGrid(S.scene, id) }));
    },
    setGraphics({ on, level, env }) {
      setGraphicsPreset(level === undefined ? defaultGraphicsPreset() : withQualityLevel(defaultGraphicsPreset(), level));
      setViewerGraphics({ effects: on, adaptive: false });
      if (env === 'default' || env === 'water') {
        let e = defaultEnvironment('Plate');
        if (env === 'water') e = setEnvValue(e, 'water', 'waterHeight', 40);
        applyEnvironment(e, 'user');
      } else if (env === 'none') clearEnvironment();
    },
    graphicsState() {
      const d = fxDebug();
      return { shadow: !!d.shadow, shadowTexel: d.shadow?.texel ?? 0, ao: d.ao, water: d.water, on: d.eff.on };
    },
    hidden: () => ({ mode: hiddenView.mode, shown: hiddenShown(), ghosts: inst.set?.matCount[MAT_HIDDEN] ?? 0 }),
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
