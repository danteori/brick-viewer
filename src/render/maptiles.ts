// Top-down map tiles, main-thread side (S-14): runs the map worker, caches the tiles it sends as
// ImageBitmaps (with an LRU byte budget), and draws them on a 2D canvas. Dynamic grids are drawn
// where their entity sits. Seed of the minimap and
// the far LOD; DOM only, full build only (the lite build doesn't import it).
//
//   const tiler = new MapTiler();
//   const ov = await tiler.open(await file.arrayBuffer());     // the buffer is transferred to the worker
//   await tiler.request(tiler.idsAround([x, y, z]), () => redraw());
//   drawMap(ctx2d, tiler, view, { grid: true });
//
// Screen frame: the game's top view, world +X up and +Y right (see tileraster.ts).

import type { SaveOverview } from '../format/overview.ts';
import { suggestLoadOrder } from '../format/overview.ts';
import type { TileOptions } from './tileraster.ts';
import type { FromWorker, TileMeta, ToWorker } from '../workers/maptiles.worker.ts';

export interface CachedTile extends TileMeta {
  /** Null for a chunk with nothing to draw (kept so it isn't asked for again). */
  bitmap: ImageBitmap | null;
  bytes: number;
  lastUsed: number;
}

/** Map view: the world point at the canvas centre and the zoom in screen pixels per save unit. */
export interface MapView {
  x: number;
  y: number;
  pxPerUnit: number;
}

export interface MapTilerOptions {
  tile?: TileOptions;
  /** ImageBitmap cache budget in bytes (w*h*4 per tile; default 256 MB). */
  maxCacheBytes?: number;
  /** Use this worker instead of starting one (tests, shared pools). */
  worker?: Worker;
}

export const tileId = (grid: string, key: string): string => `${grid}:${key}`;

export class MapTiler {
  readonly tiles = new Map<string, CachedTile>();
  overview: SaveOverview | null = null;
  tileOptions: TileOptions;
  maxCacheBytes: number;
  cacheBytes = 0;
  /** Sum of decode / raster time over every tile received. */
  stats = { tiles: 0, decodeMs: 0, rasterMs: 0, evicted: 0 };
  private readonly worker: Worker;
  private gen = 0;
  private clock = 0;
  private pending = new Map<number, { onTile?: (t: CachedTile) => void; resolve: (r: { ms: number; count: number }) => void; reject: (e: Error) => void }>();
  private openWait: { resolve: (o: SaveOverview) => void; reject: (e: Error) => void } | null = null;
  /** Errors for single tiles (the rest of the request carries on). */
  readonly errors: string[] = [];

  constructor(opts: MapTilerOptions = {}) {
    this.tileOptions = { unitsPerPx: 10, hillshade: 0.6, ...opts.tile };
    this.maxCacheBytes = opts.maxCacheBytes ?? 256 * 1024 * 1024;
    this.worker = opts.worker ?? new Worker(new URL('../workers/maptiles.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
    this.worker.onerror = (e) => this.fail(new Error(e.message || 'map worker failed'));
  }

  private send(m: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }

  private fail(err: Error): void {
    this.openWait?.reject(err);
    this.openWait = null;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private receive(m: FromWorker): void {
    if (m.type === 'overview') {
      this.overview = m.overview;
      this.openWait?.resolve(m.overview);
      this.openWait = null;
    } else if (m.type === 'tile') {
      this.stats.tiles++; this.stats.decodeMs += m.tile.decodeMs; this.stats.rasterMs += m.tile.rasterMs;
      // empty chunks come without pixels; raw RGBA only comes where there's no ImageBitmap (not a page)
      const bitmap = m.bitmap ?? null;
      const old = this.tiles.get(m.tile.id);
      if (old) { old.bitmap?.close(); this.cacheBytes -= old.bytes; }
      const t: CachedTile = { ...m.tile, bitmap, bytes: bitmap ? m.tile.w * m.tile.h * 4 : 0, lastUsed: ++this.clock };
      this.tiles.set(t.id, t);
      this.cacheBytes += t.bytes;
      this.evict();
      this.pending.get(m.gen)?.onTile?.(t);
    } else if (m.type === 'done') {
      this.pending.get(m.gen)?.resolve({ ms: m.ms, count: m.count });
      this.pending.delete(m.gen);
    } else if (m.type === 'error') {
      if (m.gen === undefined) this.fail(new Error(m.message));
      else this.errors.push(m.message);
    }
  }

  /** Least recently drawn first, until the cache fits its budget. */
  private evict(): void {
    if (this.cacheBytes <= this.maxCacheBytes) return;
    const byAge = [...this.tiles.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of byAge) {
      if (this.cacheBytes <= this.maxCacheBytes) break;
      t.bitmap?.close();
      this.tiles.delete(t.id);
      this.cacheBytes -= t.bytes;
      this.stats.evicted++;
    }
  }

  /** Hands the save to the worker (the buffer is transferred, so it's unusable here afterwards). */
  open(buffer: ArrayBuffer): Promise<SaveOverview> {
    this.clear();
    return new Promise((resolve, reject) => {
      this.openWait = { resolve, reject };
      this.send({ type: 'open', buffer }, [buffer]);
    });
  }

  /**
   * Tile ids in load order around a camera point (S-09 suggestLoadOrder): every grid by default,
   * without the dynamic grids that have no location.
   */
  idsAround(camera: readonly number[], grids?: string[]): string[] {
    if (!this.overview) return [];
    const lo = suggestLoadOrder(this.overview, camera, grids ? { grids } : {});
    return lo.order.filter((_, i) => Number.isFinite(lo.distance[i])).map((c) => tileId(c.grid, c.key));
  }

  /** Asks for tiles not in the cache yet; cancels any earlier request. Resolves when the worker is done. */
  request(ids: string[], onTile?: (t: CachedTile) => void): Promise<{ ms: number; count: number }> {
    this.cancel();
    const gen = ++this.gen, missing = ids.filter((id) => !this.tiles.has(id));
    return new Promise((resolve, reject) => {
      this.pending.set(gen, { ...(onTile && { onTile }), resolve, reject });
      this.send({ type: 'tiles', gen, ids: missing, options: this.tileOptions });
    });
  }

  /** Stops the current request; its promise resolves with what arrived so far. */
  cancel(): void {
    if (!this.pending.size) return;
    const gen = ++this.gen;
    this.send({ type: 'cancel', gen });
    for (const p of this.pending.values()) p.resolve({ ms: 0, count: -1 });
    this.pending.clear();
  }

  /** New tile options drop the cache (tiles are rebuilt on the next request). */
  setTileOptions(opts: TileOptions): void {
    this.tileOptions = { ...this.tileOptions, ...opts };
    this.clear();
  }

  clear(): void {
    this.cancel();
    for (const t of this.tiles.values()) t.bitmap?.close();
    this.tiles.clear();
    this.cacheBytes = 0;
  }

  /** Marks a tile as used (drawMap does this) so the LRU keeps it. */
  touch(t: CachedTile): void {
    t.lastUsed = ++this.clock;
  }

  dispose(): void {
    this.clear();
    this.worker.terminate();
  }
}

/** World (X, Y) -> canvas pixel. */
export function worldToScreen(view: MapView, w: number, h: number, x: number, y: number): [number, number] {
  return [(y - view.y) * view.pxPerUnit + w / 2, (view.x - x) * view.pxPerUnit + h / 2];
}

/** Canvas pixel -> world (X, Y). */
export function screenToWorld(view: MapView, w: number, h: number, sx: number, sy: number): [number, number] {
  return [view.x - (sy - h / 2) / view.pxPerUnit, view.y + (sx - w / 2) / view.pxPerUnit];
}

/** The world rectangle a view shows: [xMin, xMax, yMin, yMax]. */
export function viewRect(view: MapView, w: number, h: number): [number, number, number, number] {
  const hx = h / 2 / view.pxPerUnit, hy = w / 2 / view.pxPerUnit;
  return [view.x - hx, view.x + hx, view.y - hy, view.y + hy];
}

/** A view that fits a box (world X/Y), with a margin. */
export function fitView(box: { min: readonly number[]; max: readonly number[] }, w: number, h: number, margin = 0.05): MapView {
  const ex = Math.max(1, box.max[0]! - box.min[0]!), ey = Math.max(1, box.max[1]! - box.min[1]!);
  const pxPerUnit = Math.min(h / ex, w / ey) * (1 - 2 * margin);
  return { x: (box.min[0]! + box.max[0]!) / 2, y: (box.min[1]! + box.max[1]!) / 2, pxPerUnit };
}

export interface DrawOptions {
  /** Chunk cell outlines (static grid). */
  grid?: boolean;
  /** Fill chunks that have no tile yet with a density shade from the overview. */
  placeholders?: boolean;
  /** Draw dynamic grids' tiles (default true). */
  dynamic?: boolean;
  /** Chunk key to outline in the highlight colour. */
  highlight?: string | null;
  colors?: { grid?: string; highlight?: string; placeholder?: string };
}

/** Draws the cached tiles (lower layers first) plus static-grid overlays. */
export function drawMap(g: CanvasRenderingContext2D, tiler: MapTiler, view: MapView, opts: DrawOptions = {}): void {
  const { width: w, height: h } = g.canvas;
  const [x0, x1, y0, y1] = viewRect(view, w, h);
  const ov = tiler.overview;
  const colors = { grid: 'rgba(127,127,127,0.5)', highlight: '#f5a623', placeholder: 'rgba(127,127,127,', ...opts.colors };
  g.imageSmoothingEnabled = view.pxPerUnit * (tiler.tileOptions.unitsPerPx ?? 10) < 1;
  const chunks = ov?.chunks.filter((c) => c.grid === '1') ?? [];
  const visible = chunks.filter((c) => c.cell.max[0] >= x0 && c.cell.min[0] <= x1 && c.cell.max[1] >= y0 && c.cell.min[1] <= y1);
  if (opts.placeholders && ov) {
    const most = Math.max(1, ...visible.map((c) => c.bricks));
    for (const c of visible) {
      if (tiler.tiles.has(tileId(c.grid, c.key)) || !c.bricks) continue;
      const [sx, sy] = worldToScreen(view, w, h, c.cell.max[0], c.cell.min[1]);
      g.fillStyle = colors.placeholder + (0.08 + 0.3 * Math.sqrt(c.bricks / most)).toFixed(3) + ')';
      g.fillRect(sx, sy, c.size * view.pxPerUnit, c.size * view.pxPerUnit);
    }
  }
  // lower first: static chunks by their Z layer, then anything (dynamic grids too) by its top
  const layer = (t: CachedTile): number => (t.grid === '1' ? Number(t.key.split('_')[2]) : Math.floor(t.maxZ / 2048));
  const tiles = [...tiler.tiles.values()].filter((t) => t.bitmap && (opts.dynamic !== false || t.grid === '1'));
  tiles.sort((a, b) => layer(a) - layer(b) || a.maxZ - b.maxZ);
  for (const t of tiles) {
    const u = t.unitsPerPx, tx0 = t.ix0 * u, tx1 = (t.ix0 + t.nx) * u, ty0 = t.iy0 * u, ty1 = (t.iy0 + t.ny) * u;
    if (tx1 < x0 || tx0 > x1 || ty1 < y0 || ty0 > y1) continue;
    const [sx, sy] = worldToScreen(view, w, h, tx1, ty0);
    g.drawImage(t.bitmap!, sx, sy, t.ny * u * view.pxPerUnit, t.nx * u * view.pxPerUnit);
    tiler.touch(t);
  }
  if (opts.grid || opts.highlight) {
    g.lineWidth = 1;
    for (const c of visible) {
      const hl = c.key === opts.highlight;
      if (!opts.grid && !hl) continue;
      const [sx, sy] = worldToScreen(view, w, h, c.cell.max[0], c.cell.min[1]);
      g.strokeStyle = hl ? colors.highlight : colors.grid;
      g.lineWidth = hl ? 2 : 1;
      g.strokeRect(Math.round(sx) + 0.5, Math.round(sy) + 0.5, Math.round(c.size * view.pxPerUnit), Math.round(c.size * view.pxPerUnit));
    }
  }
}
