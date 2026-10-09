// Dev-only map demo (S-09 + S-14): open a .brz, see the S-09 overview at once, then a pannable,
// zoomable top-down map that fills in tile by tile from the map worker, nearest the view first.
// Seed of the minimap and the far LOD. Not part of either build.
import '../ui/styles.css';
import { distSqToBox, suggestLoadMode, worldCell, type ChunkInfo, type SaveOverview } from '../format/overview.ts';
import { drawMap, fitView, MapTiler, screenToWorld, tileId, type MapView } from '../render/maptiles.ts';

const CSS = `
.md { display: grid; grid-template-columns: minmax(0, 1fr) 300px; height: 100vh; }
.md canvas { width: 100%; height: 100%; display: block; background: var(--map-bg); cursor: grab; touch-action: none; }
.md canvas.drag { cursor: grabbing; }
.md aside { border-left: 1px solid var(--line); padding: 12px 16px; overflow: auto; font-size: 13px; }
.md h1 { font-size: 15px; margin: 0 0 8px; }
.md h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 14px 0 4px; }
.md dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; }
.md dt { color: var(--muted); }
.md dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; }
.md label { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
.md select, .md input[type=range] { flex: 1; }
.md .drop { border: 2px dashed var(--line); border-radius: 6px; padding: 10px; text-align: center; color: var(--muted); }
.md .drop.over { border-color: var(--accent); color: var(--fg); }
.md .bar { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; margin-top: 6px; }
.md .bar i { display: block; height: 100%; background: var(--accent); width: 0; }
.md button { font: inherit; }
.md .err { color: #c92a2a; white-space: pre-wrap; }
:root { --map-bg: #e9e9e4; }
@media (prefers-color-scheme: dark) { :root { --map-bg: #121211; } }
@media (max-width: 700px) {
  .md { grid-template-columns: 1fr; grid-template-rows: 60vh auto; height: auto; }
  .md aside { border-left: 0; border-top: 1px solid var(--line); }
}`;

const fmt = (n: number): string => n.toLocaleString('en-US');
const mb = (b: number): string => `${(b / 1048576).toFixed(b < 1048576 * 10 ? 1 : 0)} MB`;

function mount(root: HTMLElement): void {
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  root.innerHTML = `
  <div class="md">
    <canvas id="map" aria-label="Top-down map of the save"></canvas>
    <aside>
      <h1>Save map <small style="color:var(--muted);font-weight:400">dev demo</small></h1>
      <p class="drop" id="drop">Drop a <code>.brz</code> here or <input type="file" id="file" accept=".brz"></p>
      <h2>Map</h2>
      <label>Resolution <select id="res">
        <option value="20">0.5 px per stud</option><option value="10" selected>1 px per stud</option>
        <option value="5">2 px per stud</option><option value="2.5">4 px per stud</option></select></label>
      <label>Hillshade <input type="range" id="shade" min="0" max="1" step="0.1" value="0.6"></label>
      <label><input type="checkbox" id="grid" checked> Chunk grid</label>
      <label><input type="checkbox" id="dyn" checked> Dynamic grids</label>
      <label><input type="checkbox" id="ph" checked> Density placeholders</label>
      <button id="fit" type="button">Fit to save</button>
      <div class="bar"><i id="bar"></i></div>
      <dl id="progress"></dl>
      <h2>Overview (chunk index only)</h2>
      <dl id="stats"><dt>No save loaded</dt><dd></dd></dl>
      <h2>Under the cursor</h2>
      <dl id="hover"><dt>-</dt><dd></dd></dl>
      <p class="err" id="err"></p>
    </aside>
  </div>`;
  const $ = <T extends HTMLElement>(id: string): T => root.querySelector<T>('#' + id)!;
  const canvas = $<HTMLCanvasElement>('map'), g = canvas.getContext('2d')!;
  const res = $<HTMLSelectElement>('res'), shade = $<HTMLInputElement>('shade');
  const gridBox = $<HTMLInputElement>('grid'), dynBox = $<HTMLInputElement>('dyn'), phBox = $<HTMLInputElement>('ph');

  let tiler: MapTiler | null = null, ov: SaveOverview | null = null;
  let view: MapView = { x: 0, y: 0, pxPerUnit: 0.05 };
  let hoverKey: string | null = null, frame = 0, wanted = 0, got = 0, t0 = 0;

  const draw = (): void => {
    frame = 0;
    const dpr = devicePixelRatio || 1, w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.clearRect(0, 0, w, h);
    if (!tiler) return;
    drawMap(g, tiler, view, { grid: gridBox.checked, dynamic: dynBox.checked, placeholders: phBox.checked, highlight: hoverKey });
  };
  const redraw = (): void => { if (!frame) frame = requestAnimationFrame(draw); };
  addEventListener('resize', redraw);

  const progress = (): void => {
    $('bar').style.width = wanted ? `${(100 * got / wanted).toFixed(1)}%` : '0';
    const s = tiler?.stats;
    $('progress').innerHTML = tiler && s ? `
      <dt>Tiles</dt><dd>${fmt(got)} / ${fmt(wanted)}</dd>
      <dt>Elapsed</dt><dd>${((performance.now() - t0) / 1000).toFixed(2)} s</dd>
      <dt>Decode / raster</dt><dd>${(s.decodeMs / 1000).toFixed(2)} / ${(s.rasterMs / 1000).toFixed(2)} s</dd>
      <dt>Tile cache</dt><dd>${mb(tiler.cacheBytes)} (${fmt(tiler.tiles.size)})</dd>
      <dt>Evicted</dt><dd>${fmt(s.evicted)}</dd>` : '';
  };

  /** (Re)requests every placed chunk, nearest the view centre first. */
  const fill = (): void => {
    if (!tiler || !ov) return;
    const z = ov.bounds ? ov.bounds.max[2] : 0;
    const ids = tiler.idsAround([view.x, view.y, z]).filter((id) => dynBox.checked || id.startsWith('1:'));
    wanted = ids.length; got = ids.filter((id) => tiler!.tiles.has(id)).length; t0 = performance.now();
    progress();
    void tiler.request(ids, () => { got++; progress(); redraw(); }).then(() => progress());
  };

  const showStats = (): void => {
    if (!ov) return;
    const t = ov.totals, dyn = ov.grids.filter((x) => x.dynamic), placed = dyn.filter((x) => x.location).length;
    const b = ov.bounds, ext = b ? `${fmt(Math.round((b.max[0] - b.min[0]) / 10))} x ${fmt(Math.round((b.max[1] - b.min[1]) / 10))} studs` : '-';
    $('stats').innerHTML = `
      <dt>Read in</dt><dd>${ov.ms.toFixed(1)} ms</dd>
      <dt>Grids</dt><dd>${fmt(t.grids)} (${fmt(dyn.length)} dynamic, ${fmt(placed)} placed)</dd>
      <dt>Chunks</dt><dd>${fmt(t.chunks)}</dd>
      <dt>Bricks</dt><dd>${fmt(t.bricks)}</dd>
      <dt>Components</dt><dd>${fmt(t.components)}</dd>
      <dt>Wires</dt><dd>${fmt(t.wires)}</dd>
      <dt>Static extent</dt><dd>${ext}</dd>
      <dt>Chunk data</dt><dd>${mb(t.storedBytes)} stored, ${mb(t.rawBytes)} raw</dd>
      <dt>Est. memory</dt><dd>${mb(t.estBytes)}</dd>
      <dt>Suggested load</dt><dd>${suggestLoadMode(ov, { budgetBytes: 1 << 30 })}</dd>
      <dt>Brick assets</dt><dd>${fmt(ov.names.basicBricks.length + ov.names.proceduralBricks.length)}</dd>
      <dt>Materials</dt><dd>${fmt(ov.names.materials.length)}</dd>
      <dt>Component types</dt><dd>${fmt(ov.names.components.length)}</dd>`;
  };

  const open = async (f: File): Promise<void> => {
    $('err').textContent = '';
    tiler?.dispose();
    tiler = new MapTiler({ tile: { unitsPerPx: Number(res.value), hillshade: Number(shade.value) } });
    try {
      ov = await tiler.open(await f.arrayBuffer());
    } catch (e) {
      $('err').textContent = `${f.name}: ${(e as Error).message}`;
      return;
    }
    showStats();
    const box = ov.bounds ?? ov.boundsAll;
    if (box) view = fitView(box, canvas.width || canvas.clientWidth, canvas.height || canvas.clientHeight);
    redraw();
    fill();
  };

  $<HTMLInputElement>('file').addEventListener('change', (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void open(f); });
  const drop = $('drop');
  addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  addEventListener('dragleave', () => drop.classList.remove('over'));
  addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files[0]; if (f) void open(f); });

  const retile = (): void => { if (!tiler) return; tiler.setTileOptions({ unitsPerPx: Number(res.value), hillshade: Number(shade.value) }); redraw(); fill(); };
  res.addEventListener('change', retile);
  shade.addEventListener('change', retile);
  for (const b of [gridBox, phBox]) b.addEventListener('change', redraw);
  dynBox.addEventListener('change', () => { redraw(); fill(); });
  $('fit').addEventListener('click', () => {
    const box = ov?.bounds ?? ov?.boundsAll;
    if (box) { view = fitView(box, canvas.width, canvas.height); redraw(); }
  });

  // pan (drag) and zoom (wheel / pinch-less: wheel at the cursor)
  const dpr = (): number => devicePixelRatio || 1;
  let drag: { x: number; y: number; view: MapView } | null = null, refill = 0;
  const scheduleRefill = (): void => { clearTimeout(refill); refill = window.setTimeout(() => { if (tiler && tiler.cacheBytes >= tiler.maxCacheBytes * 0.9) fill(); }, 250); };
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, view: { ...view } }; canvas.setPointerCapture(e.pointerId); canvas.classList.add('drag'); });
  canvas.addEventListener('pointerup', () => { drag = null; canvas.classList.remove('drag'); scheduleRefill(); });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      const k = dpr() / view.pxPerUnit;
      view = { ...view, x: drag.view.x + (e.clientY - drag.y) * k, y: drag.view.y - (e.clientX - drag.x) * k };
      redraw();
    }
    hover(e);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect(), sx = (e.clientX - r.left) * dpr(), sy = (e.clientY - r.top) * dpr();
    const [wx, wy] = screenToWorld(view, canvas.width, canvas.height, sx, sy);
    const f = Math.exp(-e.deltaY * 0.0015), ppu = Math.min(8, Math.max(1e-4, view.pxPerUnit * f));
    // keep the world point under the cursor fixed
    view = { pxPerUnit: ppu, x: wx + (sy - canvas.height / 2) / ppu, y: wy - (sx - canvas.width / 2) / ppu };
    redraw();
    scheduleRefill();
  }, { passive: false });

  const hover = (e: PointerEvent): void => {
    if (!ov) return;
    const r = canvas.getBoundingClientRect();
    const [wx, wy] = screenToWorld(view, canvas.width, canvas.height, (e.clientX - r.left) * dpr(), (e.clientY - r.top) * dpr());
    const here = ov.chunks.filter((c) => c.grid === '1' && wx >= c.cell.min[0] && wx < c.cell.max[0] && wy >= c.cell.min[1] && wy < c.cell.max[1]);
    // dynamic grids whose turned cell covers the point
    const dyn = ov.chunks.filter((c) => c.grid !== '1' && c.bricks).filter((c) => { const b = worldCell(ov!, c); return b && distSqToBox([wx, wy, (b.min[2] + b.max[2]) / 2], b) === 0; });
    const key = here[0]?.key ?? null;
    if (key !== hoverKey) { hoverKey = key; redraw(); }
    const sum = (cs: ChunkInfo[], f: (c: ChunkInfo) => number): number => cs.reduce((s, c) => s + f(c), 0);
    const tile = key ? tiler?.tiles.get(tileId('1', key)) : undefined;
    $('hover').innerHTML = `
      <dt>World X, Y</dt><dd>${fmt(Math.round(wx))}, ${fmt(Math.round(wy))}</dd>
      <dt>Chunk column</dt><dd>${key ? key.replace(/_-?\d+$/, '_*') : '-'}</dd>
      <dt>Z layers</dt><dd>${here.length}</dd>
      <dt>Bricks</dt><dd>${fmt(sum(here, (c) => c.bricks))}</dd>
      <dt>Components / wires</dt><dd>${fmt(sum(here, (c) => c.components))} / ${fmt(sum(here, (c) => c.wires))}</dd>
      <dt>Est. memory</dt><dd>${mb(sum(here, (c) => c.estBytes))}</dd>
      <dt>Tile</dt><dd>${tile ? `${tile.w}x${tile.h}, ${(tile.decodeMs + tile.rasterMs).toFixed(1)} ms` : '-'}</dd>
      <dt>Dynamic chunks here</dt><dd>${fmt(dyn.length)}</dd>
      <dt>Zoom</dt><dd>${(view.pxPerUnit * 10 / dpr()).toFixed(3)} px/stud</dd>`;
  };
  redraw();
}

mount(document.getElementById('app')!);
