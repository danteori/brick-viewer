// Map tile worker (S-14). Holds the save's compressed bytes, answers with the S-09 overview, then
// decodes requested chunks one at a time, rasterises each into a top-down tile and drops the
// decoded chunk straight away. Tiles go back as ImageBitmaps (transferred) when the worker can
// make them, else as raw RGBA. Dynamic grids are placed by their entity; unplaced ones are skipped.
//
// Protocol (all messages are plain objects):
//   in  {type:'open', buffer}                         -> out {type:'overview', overview}
//   in  {type:'tiles', gen, ids, options}             -> out {type:'tile', gen, tile, bitmap?|rgba?} ... {type:'done', gen, ms}
//   in  {type:'cancel', gen}                          (drops queued work of older generations)
//   any failure                                       -> out {type:'error', gen?, message}
// A tile id is "<grid>:<X_Y_Z>".

import { openBrzLazy, type LazyBrz } from '../format/brzlazy.ts';
import { readOverview, type ChunkInfo, type GridInfo, type SaveOverview } from '../format/overview.ts';
import { parseSchema } from '../format/schema.ts';
import { rasteriseChunk, type ChunkContext, type MapTile, type TileOptions } from '../render/tileraster.ts';

export type TileMeta = Omit<MapTile, 'rgba' | 'top'> & { id: string };

export type ToWorker =
  | { type: 'open'; buffer: ArrayBuffer }
  | { type: 'tiles'; gen: number; ids: string[]; options?: TileOptions }
  | { type: 'cancel'; gen: number };

export type FromWorker =
  | { type: 'overview'; overview: SaveOverview }
  | { type: 'tile'; gen: number; tile: TileMeta; bitmap?: ImageBitmap; rgba?: Uint8ClampedArray<ArrayBuffer> }
  | { type: 'done'; gen: number; ms: number; count: number }
  | { type: 'error'; gen?: number; message: string };

interface WorkerScope {
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let save: LazyBrz | null = null;
let overview: SaveOverview | null = null;
let ctx: ChunkContext | null = null;
let byId = new Map<string, ChunkInfo>();
let grids = new Map<string, GridInfo>();
let current = 0;

const post = (msg: FromWorker, transfer: Transferable[] = []): void => scope.postMessage(msg, transfer);
// Let cancel / new requests in between tiles without setTimeout's 4 ms clamp: a MessageChannel
// round trip, at most every 8 ms.
const tick = new MessageChannel();
let lastYield = 0;
const yieldToMessages = (): Promise<void> => {
  if (performance.now() - lastYield < 8) return Promise.resolve();
  return new Promise((r) => { tick.port1.onmessage = () => { lastYield = performance.now(); r(); }; tick.port2.postMessage(0); });
};

function open(buffer: ArrayBuffer): void {
  save = openBrzLazy(buffer);
  overview = readOverview(save);
  const cs = save.get('World/0/Bricks/ChunksShared.schema');
  ctx = cs
    ? { schema: parseSchema(cs), basicNames: overview.names.basicBricks, proceduralNames: overview.names.proceduralBricks, materialNames: overview.names.materials }
    : null;
  byId = new Map(overview.chunks.map((c) => [`${c.grid}:${c.key}`, c]));
  grids = new Map(overview.grids.map((g) => [g.id, g]));
  post({ type: 'overview', overview });
}

async function tiles(gen: number, ids: string[], options: TileOptions = {}): Promise<void> {
  current = Math.max(current, gen);
  const t0 = performance.now();
  let count = 0;
  for (const id of ids) {
    if (gen < current) return;   // superseded
    const c = byId.get(id);
    if (!save || !ctx || !c || !c.present) continue;
    const grid = grids.get(c.grid);
    if (grid?.dynamic && !grid.location) continue;   // unplaced dynamic grid: nowhere to draw it
    try {
      let bytes = save.get(c.path);
      if (!bytes) continue;
      const transform = grid?.dynamic ? { loc: grid.location!, rot: grid.rotation } : null;
      const tile = rasteriseChunk(bytes, ctx, { ...c, transform }, options);
      bytes = undefined;   // the decoded chunk is gone once rasteriseChunk returns
      const { rgba, top: _top, ...meta } = tile;
      const msg: TileMeta = { ...meta, id };
      if (tile.w && tile.h && typeof createImageBitmap === 'function' && typeof ImageData === 'function') {
        const bitmap = await createImageBitmap(new ImageData(rgba, tile.w, tile.h));
        post({ type: 'tile', gen, tile: msg, bitmap }, [bitmap]);
      } else {
        post({ type: 'tile', gen, tile: msg, rgba }, [rgba.buffer]);
      }
      count++;
    } catch (e) {
      post({ type: 'error', gen, message: `${id}: ${(e as Error).message}` });
    }
    await yieldToMessages();
  }
  if (gen >= current) post({ type: 'done', gen, ms: performance.now() - t0, count });
}

scope.onmessage = (e: MessageEvent<ToWorker>): void => {
  const m = e.data;
  try {
    if (m.type === 'open') open(m.buffer);
    else if (m.type === 'cancel') current = Math.max(current, m.gen);
    else if (m.type === 'tiles') void tiles(m.gen, m.ids, m.options);
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
