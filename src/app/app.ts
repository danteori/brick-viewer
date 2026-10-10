// createApp: builds the page, the renderer and the editor, wires the input in the legacy viewer's
// listener order (it decides which handler sees an event first), and runs the frame loop.

import { S } from './state.ts';
import { loadFaceCull, loadFullUi, type FeatureFlags } from './features.ts';
import { initWorlds } from './worlds.ts';
import { initWorldEnvironment } from './environment.ts';
import { initPaintPanel } from '../ui/panels/paint.ts';
import { initSoundPanel } from '../ui/panels/sound.ts';
import { initViewPanel } from '../ui/panels/view.ts';
import { installTestHook } from './test-hook.ts';
import { createGfx } from '../render/gl.ts';
import { initDraw } from '../render/draw.ts';
import { initMeshes } from '../render/meshes/registry.ts';
import { initInstances } from '../render/instances.ts';
import { initGrid } from '../render/grid.ts';
import { initCamera, updateCamera } from '../render/camera.ts';
import { renderFrame } from '../render/pipeline.ts';
import { edgeTick, onDown, onMove, onRightDown, onUp, onWheel, orbitMove } from '../editor/resize.ts';
import { histStep } from '../scene/history.ts';
import { initGhost } from '../editor/ghost.ts';
import { initOps } from '../editor/ops.ts';
import { initSpatial } from '../scene/spatial.ts';
import { selectBrick } from '../editor/resize.ts';
import { initClipboard } from '../editor/clipboard.ts';
import { initEditorInput } from '../editor/input.ts';
import { initTools } from '../editor/tools.ts';
import { $, mountDom } from '../ui/dom.ts';
import { initStatus } from '../ui/status.ts';
import { initSizePanel } from '../ui/panels/size.ts';
import { initFilePanel, waitForOpeners } from '../ui/panels/file.ts';
import { initProps, tickProps } from '../ui/panels/props.ts';
import { initSelectionPanel, tickSelection } from '../ui/panels/selection.ts';
import { initCataloguePanel } from '../ui/panels/catalogue.ts';
import { drawDims, initDims } from '../ui/overlay/dims.ts';
import { drawHud, initHud } from '../ui/overlay/hud.ts';

export interface AppOptions {
  features: Readonly<FeatureFlags>;
  /** where the legacy (WebGL1) viewer lives, for browsers without WebGL2 */
  legacyHref: string;
}

export function createApp(root: HTMLElement | null, opts: AppOptions): void {
  mountDom(root);
  S.testMode = new URLSearchParams(location.search).has('test');
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
  initHud($('hud'));
  initCamera(canvas);
  initSizePanel();
  initDims(canvas);
  selectBrick(S.scene.first());               // the startup brick

  // --- input, in the legacy order
  addEventListener('keydown', (e) => {
    if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target instanceof HTMLInputElement)) S.autoCenter = !S.autoCenter;   // not Ctrl+C (copy)
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
  addEventListener('pointerup', (e) => { if (e.button === 1 && S.orbit.dragging) S.orbit.dragging = false; });
  addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });   // no browser auto-scroll
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
  initSoundPanel();
  initViewPanel();
  if (opts.features.brdbRead) initWorlds();
  initProps();
  initSelectionPanel();
  initGhost(canvas);
  initOps();
  initClipboard([...document.querySelectorAll<HTMLButtonElement>('#pastemode button')]);
  initCataloguePanel();
  initEditorInput(canvas);
  initTools(canvas);
  initWorldEnvironment();
  initPaintPanel();
  // full build: environment panel, .brdb worlds and the map (a separate chunk, never in lite)
  if (loadFullUi) waitForOpeners(loadFullUi().then((m) => m.mountFullUi()).catch((err) => console.error('full UI failed to load', err)));

  if (S.testMode) installTestHook(canvas);

  const frame = (t: number = performance.now()): void => {
    edgeTick(t);
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth * dpr | 0, h = canvas.clientHeight * dpr | 0;
    if (w && h) {
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      updateCamera(w, h);
      const { sx, sy } = renderFrame(w, h, canvas);
      drawHud();
      drawDims(sx, sy);
      tickProps();
      tickSelection();
    }
    requestAnimationFrame(frame);
  };
  frame();
}
