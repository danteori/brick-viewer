// Parse worker (S-01): reads a save into a store off the main thread, then (asked to) computes its
// hidden-face masks; or computes the masks of a store the main thread sends. One job per worker:
// the main thread (src/app/parse.ts) makes a worker per job and terminates it when done, which
// also frees the culling tables.
//
// Protocol:
//   in  {type:'parse', bytes? | files?, cull}   -> out progress..., {type:'store', ...ParsedMsg} (transferred),
//                                                  then with cull: progress..., {type:'masks', masks}
//   in  {type:'cull', cols, assets, materials, skip}  -> out progress..., {type:'masks', masks}
//   progress: {type:'progress', phase, done, total}; any failure: {type:'error', message}

import { cullColumnsOf, parseForPost, regionMasks, type CullColumns, type Progress } from '../scene/parsecore.ts';
import { ASSETS, MATERIALS } from '../scene/store.ts';

export type ToParseWorker =
  | { type: 'parse'; bytes?: Uint8Array; files?: [string, Uint8Array][]; cull: boolean }
  | { type: 'cull'; cols: CullColumns; assets: string[]; materials: string[]; skip: number[] };

const post = (m: unknown, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(m, transfer);

let last = 0;
const progress: Progress = (phase, done, total) => {
  const t = performance.now();
  if (t - last < 100 && done < total) return;
  last = t;
  post({ type: 'progress', phase, done, total });
};

self.onmessage = (e: MessageEvent<ToParseWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'parse') {
      const { msg, transfer, store } = parseForPost(m, progress);
      const cols = m.cull ? cullColumnsOf(store) : null;     // copies: the store's own columns go to the main thread
      post(msg, transfer);
      if (cols) { const masks = regionMasks(cols, ASSETS.list, MATERIALS.list, null, progress); post({ type: 'masks', masks }, [masks.buffer]); }
    } else {
      const masks = regionMasks(m.cols, m.assets, m.materials, new Set(m.skip), progress);
      post({ type: 'masks', masks }, [masks.buffer]);
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
