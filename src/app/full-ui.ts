// Full-build UI, loaded lazily through features.ts (the lite build never imports it):
//   - the Environment panel (src/ui/panels/environment.ts), floating next to the left column;
//   - the Map: a toggleable top-down overview of the opened save with click-to-focus.

import { S } from './state.ts';
import { applyEnvironment, currentEnvironment, onWorldEnvironment } from './environment.ts';
import { createEnvironmentPanel, type EnvironmentPanel, type PanelWorldKind } from '../ui/panels/environment.ts';
import { loadedBrz } from '../scene/load.ts';
import { histEnd } from '../scene/history.ts';
import { MapTiler, drawMap, fitView, screenToWorld, worldToScreen, type MapView } from '../render/maptiles.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { keepZoom, selectBrick } from '../editor/resize.ts';
import { initAudio, playSelect } from '../ui/audio.ts';
import { $ } from '../ui/dom.ts';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
};
const stopDrag = (e: HTMLElement): void => { for (const t of ['pointerdown', 'dblclick', 'wheel']) e.addEventListener(t, (ev) => ev.stopPropagation()); };

export function mountFullUi(): void {
  initEnvironmentUi();
  initMap();
}

// ------------------------------------------------------------------------------- environment
function initEnvironmentUi(): void {
  const btn = h('button', { type: 'button', id: 'envbtn', 'aria-expanded': 'false', 'aria-controls': 'envpanel', title: 'Sky, sun, clouds, fog, water and ground plate settings (.bp)' }, 'Environment');
  $('lightbox').after(btn);
  const box = h('div', { id: 'envpanel', hidden: '' });
  document.body.append(box);
  stopDrag(btn); stopDrag(box);
  let panel: EnvironmentPanel | null = null, fromWorld = false;
  const kindOf = (k: string | null): PanelWorldKind => (k === 'Space' ? 'Space' : 'Plate');
  const place = (): void => {
    const r = $('side').getBoundingClientRect();
    box.style.left = `${Math.round(r.right + 12)}px`;
  };
  btn.addEventListener('click', () => {
    const open = box.hidden;
    box.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open && !panel) {
      const cur = currentEnvironment();
      panel = createEnvironmentPanel({
        ...(cur && { env: cur }),
        onChange: (e) => { applyEnvironment(e, fromWorld ? 'world' : 'user'); fromWorld = false; },
      });
      box.append(panel.el);
    }
    if (open) place();
  });
  addEventListener('resize', () => { if (!box.hidden) place(); });
  onWorldEnvironment((e, kind) => { if (panel) { fromWorld = true; panel.set(e, kindOf(kind)); } });
}

// --------------------------------------------------------------------------------------- map
function initMap(): void {
  const btn = h('button', { type: 'button', id: 'mapbtn', 'aria-expanded': 'false', 'aria-controls': 'mappanel', title: 'Top-down map of the opened save; click it to focus the nearest brick' }, 'Map');
  const box = h('section', { id: 'mappanel', hidden: '', 'aria-label': 'Map' });
  const canvas = h('canvas', { id: 'mapcanvas', 'aria-label': 'Top-down map. Click to focus the nearest brick; drag to pan, wheel to zoom.' });
  const note = h('div', { class: 'mapnote' });
  const fit = h('button', { type: 'button', class: 'mapfit' }, 'Fit');
  const head = h('div', { class: 'maphead' });
  head.append(h('span', {}, 'Map'), fit);
  box.append(head, canvas, note);
  document.body.append(btn, box);
  stopDrag(btn); stopDrag(box);
  const g = canvas.getContext('2d')!;
  let tiler: MapTiler | null = null, source: Uint8Array | null = null, view: MapView | null = null, drawnKey = '';

  const dpr = (): number => devicePixelRatio || 1;
  const size = (): void => {
    const w = Math.round(canvas.clientWidth * dpr()), hh = Math.round(canvas.clientHeight * dpr());
    if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; drawnKey = ''; }
  };
  /** the focused brick's centre in save units */
  const focusXY = (): [number, number] | null => {
    return S.sel >= 0 && S.scene.alive(S.sel) ? [((S.lo[0] + S.hi[0]) / 2) / BRZ_UNIT, ((S.lo[1] + S.hi[1]) / 2) / BRZ_UNIT] : null;
  };
  const redraw = (): void => {
    drawnKey = '';
  };
  const paint = (): void => {
    if (box.hidden || !view) return;
    size();
    const f = focusXY(), key = [view.x, view.y, view.pxPerUnit, f?.join(), tiler?.tiles.size, canvas.width, canvas.height].join();
    if (key === drawnKey) return;
    drawnKey = key;
    g.fillStyle = '#1d1e21'; g.fillRect(0, 0, canvas.width, canvas.height);
    if (tiler) drawMap(g, tiler, view, { placeholders: true });
    if (f) {
      const [sx, sy] = worldToScreen(view, canvas.width, canvas.height, f[0], f[1]);
      g.strokeStyle = '#e8590c'; g.lineWidth = 2 * dpr();
      g.beginPath(); g.arc(sx, sy, 6 * dpr(), 0, Math.PI * 2); g.stroke();
    }
  };
  const tick = (): void => { paint(); if (!box.hidden) requestAnimationFrame(tick); };
  const fitAll = (): void => {
    const ov = tiler?.overview, b = ov?.bounds ?? ov?.boundsAll;
    size();
    if (b) view = fitView(b, canvas.width, canvas.height);
    redraw();
  };

  const build = async (): Promise<void> => {
    if (source === loadedBrz && tiler) return;
    tiler?.dispose(); tiler = null; view = null; source = loadedBrz;
    if (!source) { note.textContent = 'Open a save to see its map.'; g.clearRect(0, 0, canvas.width, canvas.height); return; }
    note.textContent = 'Reading the save…';
    const t = new MapTiler();
    tiler = t;
    try {
      const ov = await t.open(source.slice().buffer);
      if (tiler !== t) return;
      fitAll();
      const top = ov.bounds ?? ov.boundsAll;
      const c = top ? [(top.min[0] + top.max[0]) / 2, (top.min[1] + top.max[1]) / 2, top.max[2]] : [0, 0, 0];
      note.textContent = `${ov.totals.bricks.toLocaleString()} bricks in ${ov.totals.chunks} chunk(s). Click to focus the nearest brick.`;
      await t.request(t.idsAround(c), () => redraw());
    } catch (err) { if (tiler === t) note.textContent = `No map: ${(err as Error).message}`; }
  };

  btn.addEventListener('click', () => {
    const open = box.hidden;
    box.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { void build(); requestAnimationFrame(tick); }
  });
  fit.addEventListener('click', fitAll);
  S.hooks.loaded.push(() => { if (!box.hidden) void build(); });

  // drag = pan, a click without dragging = focus the nearest brick, wheel = zoom at the cursor
  let drag: { x: number; y: number; view: MapView; moved: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!view) return;
    drag = { x: e.clientX, y: e.clientY, view: { ...view }, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !view) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
    if (!drag.moved) return;
    const k = dpr() / view.pxPerUnit;
    view = { ...view, x: drag.view.x + (e.clientY - drag.y) * k, y: drag.view.y - (e.clientX - drag.x) * k };
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (!d || d.moved || !view) return;
    const r = canvas.getBoundingClientRect();
    const [wx, wy] = screenToWorld(view, canvas.width, canvas.height, (e.clientX - r.left) * dpr(), (e.clientY - r.top) * dpr());
    focusNearest(wx, wy);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!view) return;
    const r = canvas.getBoundingClientRect(), sx = (e.clientX - r.left) * dpr(), sy = (e.clientY - r.top) * dpr();
    const [wx, wy] = screenToWorld(view, canvas.width, canvas.height, sx, sy);
    const ppu = Math.min(8, Math.max(1e-4, view.pxPerUnit * Math.exp(-e.deltaY * 0.0015)));
    view = { pxPerUnit: ppu, x: wx + (sy - canvas.height / 2) / ppu, y: wy - (sx - canvas.width / 2) / ppu };
  }, { passive: false });
}

/** Focus the brick whose centre is nearest to world (x, y) in save units (map click). */
export function focusNearest(x: number, y: number): number {
  let best = -1, bd = Infinity;
  const s = S.scene;
  for (const k of s.ordered()) {
    const dx = s.px[k]! - x, dy = s.py[k]! - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = k; }
  }
  if (best < 0 || S.held) return -1;
  const keep = S.cam.half;
  histEnd(); initAudio(); selectBrick(best); playSelect();
  keepZoom(keep);
  return best;
}
