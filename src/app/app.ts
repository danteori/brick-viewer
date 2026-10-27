// createApp: builds the page, the renderer and the editor, wires the input in the legacy viewer's
// listener order (it decides which handler sees an event first), and runs the frame loop.

import { S } from './state.ts';
import { loadFaceCull, loadFullUi, type FeatureFlags } from './features.ts';
import { initWorlds } from './worlds.ts';
import { initImporter } from './importer.ts';
import { initWorldEnvironment } from './environment.ts';
import { initPaintPanel } from '../ui/panels/paint.ts';
import { initApplicatorPanel, tickApplicator } from '../ui/panels/applicator.ts';
import { initSoundPanel } from '../ui/panels/sound.ts';
import { initViewPanel, tickXray } from '../ui/panels/view.ts';
import { installTestHook } from './test-hook.ts';
import { createGfx } from '../render/gl.ts';
import { initDraw } from '../render/draw.ts';
import { initMeshes } from '../render/meshes/registry.ts';
import { initInstances } from '../render/instances.ts';
import { initGrid } from '../render/grid.ts';
import { initCamera, updateCamera } from '../render/camera.ts';
import { renderFrame } from '../render/pipeline.ts';
import { edgeTick, onDown, onMove, onRightDown, onUp, onWheel, orbitMove, startOrbit } from '../editor/resize.ts';
import { initExplore, exploreTick } from './explore.ts';
import { isClassic, setCameraStyle } from './mode.ts';
import { initWindow } from '../ui/windows.ts';
import { histStep } from '../scene/history.ts';
import { initGhost } from '../editor/ghost.ts';
import { initOps } from '../editor/ops.ts';
import { initSpatial } from '../scene/spatial.ts';
import { selectBrick } from '../editor/resize.ts';
import { initClipboard } from '../editor/clipboard.ts';
import { initEditorInput } from '../editor/input.ts';
import { initTools } from '../editor/tools.ts';
import { initMirror } from '../editor/mirrortool.ts';
import { $, mountDom } from '../ui/dom.ts';
import { initNotice } from '../ui/notice.ts';
import { initStatus } from '../ui/status.ts';
import { initSizePanel } from '../ui/panels/size.ts';
import { initFilePanel, waitForOpeners } from '../ui/panels/file.ts';
import { initSaveGame } from '../ui/panels/savegame.ts';
import { initProps, tickProps } from '../ui/panels/props.ts';
import { initSelectionPanel, tickSelection } from '../ui/panels/selection.ts';
import { initGridPanel, tickGrid } from '../ui/panels/grid.ts';
import { tickChips } from './chips.ts';
import { initComponentsPanel, tickComponents } from '../ui/panels/components.ts';
import { initContextPanel, tickContextPanel } from '../ui/panels/context.ts';
import { drawWires, initWires } from '../ui/overlay/wires.ts';
import { initLogicPanel, tickLogic } from '../ui/panels/logic.ts';
import { initCataloguePanel } from '../ui/panels/catalogue.ts';
import { drawDims, initDims } from '../ui/overlay/dims.ts';
import { drawHud, initHud } from '../ui/overlay/hud.ts';
import { initGraphics } from './graphics.ts';
import { adaptTick, fx } from '../render/fx/state.ts';

export interface AppOptions {
  features: Readonly<FeatureFlags>;
  /** where the legacy (WebGL1) viewer lives, for browsers without WebGL2 */
  legacyHref: string;
}

export function createApp(root: HTMLElement | null, opts: AppOptions): void {
  mountDom(root);
  const q = new URLSearchParams(location.search);
  S.testMode = q.has('test');
  setCameraStyle(S.testMode && q.get('mode') !== 'one' ? 'classic' : 'free');
  initWindow('escmenu');
  initWindow('catwin');
  initGraphics();                             // graphics settings (stored; ?test: effects off)
  const canvas = $<HTMLCanvasElement>('c');
  const gfx = createGfx(canvas);
  if (!gfx) {
    document.body.innerHTML = `<p class="nogl">This viewer needs WebGL2. Try the <a href="${opts.legacyHref}">WebGL1 viewer</a>.</p>`;
    return;
  }
  const gl = gfx.gl;
  initDraw(gfx);
  initMeshes(gl);
  initInstances();
  if (loadFaceCull) void loadFaceCull().then((m) => m.initFaceCull());   // full build only
  initSpatial();
  initGrid();
  gl.enable(gl.DEPTH_TEST);
  initStatus($('status'));
  initNotice();
  initHud($('hud'));
  initCamera(canvas);
  initSizePanel();
  initDims(canvas);
  initWires(canvas);
  selectBrick(S.scene.first());               // the startup brick

  initExplore(canvas);
  addEventListener('keydown', (e) => {
    if (isClassic() && (e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target instanceof HTMLInputElement)) S.autoCenter = !S.autoCenter;
  });
  addEventListener('pointermove', (e) => { S.mouse = [e.clientX, e.clientY]; S.mouseOnCanvas = e.target === canvas; });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) S.mouse = null; });   // left the window
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    const a = e.target as HTMLElement | null;                      // typing in a field: leave the browser's own text undo alone
    if (a && (a.tagName === 'TEXTAREA' || a.isContentEditable ||
        (a.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|color|file)$/i.test((a as HTMLInputElement).type)))) return;
    e.preventDefault();
    histStep(k === 'y' || e.shiftKey);
  });
  addEventListener('pointermove', orbitMove);
  addEventListener('pointerup', (e) => { if ((e.button === 1 || e.button === 2) && S.orbit.dragging) S.orbit.dragging = false; });
  addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });   // no browser auto-scroll
  addEventListener('mousedown', (e) => { if (e.button === 1 && S.held) startOrbit(e, canvas); });
  addEventListener('mouseup', (e) => { if (e.button === 1 || e.button === 2) S.orbit.dragging = false; });
  addEventListener('pointerdown', (e) => onDown(e, canvas));
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', (e) => onUp(e));
  addEventListener('pointercancel', (e) => onUp(e));
  addEventListener('blur', (e) => onUp(e));
  addEventListener('wheel', (e) => onWheel(e, canvas), { passive: false });
  addEventListener('contextmenu', (e) => e.preventDefault());
  // right-click while dragging (a second button on a pressed pointer fires no pointerdown)
  addEventListener('mousedown', (e) => { if (e.button === 2) onRightDown(); });

  initFilePanel();
  initSaveGame();
  initSoundPanel();
  initViewPanel();
  initLogicPanel();
  if (opts.features.brdbRead) initWorlds();
  initImporter();
  initProps();
  initComponentsPanel();
  initSelectionPanel();
  initGridPanel();
  initGhost(canvas);
  initOps();
  initClipboard([...document.querySelectorAll<HTMLButtonElement>('#pastemode button')]);
  initCataloguePanel();
  initEditorInput(canvas);
  initTools(canvas);
  initMirror();
  initWorldEnvironment();
  initPaintPanel();
  initApplicatorPanel();
  initContextPanel();
  // full build: environment panel, .brdb worlds and the map (a separate chunk, never in lite)
  if (loadFullUi) waitForOpeners(loadFullUi().then((m) => m.mountFullUi()).catch((err) => console.error('full UI failed to load', err)));

  if (S.testMode) installTestHook(canvas);

  let lastDraw = 0;
  const frame = (t: number = performance.now()): void => {
    edgeTick(t);
    // the graphics settings' frame-rate cap (L-06; FrameRateLimit, FrameRateLimitUnfocused) and render scale
    const lim = document.hasFocus() ? fx.want.fpsLimit : fx.want.fpsLimitUnfocused || fx.want.fpsLimit;
    if (lim > 0 && !S.testMode && t - lastDraw < 1000 / lim - 2) { requestAnimationFrame(frame); return; }
    lastDraw = t;
    adaptTick(t, S.testMode, lim > 0 ? 1000 / lim : 0);
    exploreTick(t);
    const scale = S.testMode ? 1 : fx.want.renderScale;
    const dpr = (devicePixelRatio || 1) * scale, w = canvas.clientWidth * dpr | 0, h = canvas.clientHeight * dpr | 0;
    if (w && h) {
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      updateCamera(w, h);
      tickChips();
      tickXray();
      const { sx, sy } = renderFrame(w, h, canvas);
      drawHud();
      drawDims(sx, sy);
      drawWires(sx, sy);
      tickLogic(t, sx, sy);
      tickProps();
      tickComponents();
      tickSelection();
      tickGrid();
      tickApplicator();
      tickContextPanel();
    }
    requestAnimationFrame(frame);
  };
  frame();
}
