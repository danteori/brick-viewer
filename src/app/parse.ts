// The full build's off-main-thread loading and face culling (S-01): a parse worker
// (src/workers/parse.worker.ts) per job. installParse() hands scene/load.ts the parser (big saves
// load in the worker while the UI keeps running, with a progress bar) and render/facecull.ts the
// mask computer (scenes too big to cull on the main thread get their masks from a worker).

import type { ToParseWorker } from '../workers/parse.worker.ts';
import { adoptParsed, cullColumnsOf, type Parsed, type ParsedMsg, type Progress } from '../scene/parsecore.ts';
import type { FileMap } from '../format/brz.ts';
import { ASSETS, MATERIALS, type SceneStore } from '../scene/store.ts';
import { setParser } from '../scene/load.ts';
import { setAsyncCull } from '../render/facecull.ts';

type FromWorker = ParsedMsg | { type: 'progress'; phase: Parameters<Progress>[0]; done: number; total: number } | { type: 'masks'; masks: Uint8Array } | { type: 'error'; message: string };

const spawn = (): Worker => new Worker(new URL('../workers/parse.worker.ts', import.meta.url), { type: 'module' });

/** Masks computed (or being computed) for a store, and the store revision they are for. */
const masksOf = new WeakMap<SceneStore, { rev: number; masks: Promise<Uint8Array | null> }>();

/**
 * Reads a save in a worker: `bytes` (a .brz; transferred, so pass a copy you don't need) or its
 * `files`. With `cull`, the worker goes on to compute the store's face masks (cullInWorker picks
 * them up).
 */
export function parseInWorker(input: { bytes?: Uint8Array; files?: FileMap }, progress: Progress, cull: boolean): Promise<Parsed> {
  return new Promise((resolve, reject) => {
    const w = spawn();
    let done = false, gotMasks: (m: Uint8Array | null) => void = () => undefined;
    const masks = new Promise<Uint8Array | null>((r) => { gotMasks = r; });
    const fail = (message: string): void => { w.terminate(); gotMasks(null); if (!done) { done = true; reject(new Error(message)); } };
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const d = e.data;
      if (d.type === 'progress') { if (!done) progress(d.phase, d.done, d.total); }
      else if (d.type === 'store') {
        const p = adoptParsed(d, d.files ? new Map(d.files) : input.files!);
        done = true;
        if (cull) {
          masksOf.set(p.store, { rev: p.store.rev, masks });
          void masks.then((m) => { if (!m && masksOf.get(p.store)?.masks === masks) masksOf.delete(p.store); });
        } else w.terminate();
        resolve(p);
      } else if (d.type === 'masks') { gotMasks(d.masks); w.terminate(); }
      else fail(d.message);
    };
    w.onerror = (e) => { e.preventDefault(); fail(e.message || 'the parse worker failed'); };
    const msg: ToParseWorker = input.bytes ? { type: 'parse', bytes: input.bytes, cull } : { type: 'parse', files: [...input.files!], cull };
    w.postMessage(msg, input.bytes ? [input.bytes.buffer as ArrayBuffer] : []);
  });
}

let job: { w: Worker; cancel: () => void } | null = null;

/** The face masks of store s with rows `skip` left out, from a worker (null: failed or superseded by a newer request). */
export function cullInWorker(s: SceneStore, skip: ReadonlySet<number>): Promise<Uint8Array | null> {
  const c = masksOf.get(s);
  if (c && c.rev === s.rev && !skip.size) return c.masks;
  job?.cancel();
  const w = spawn(), cols = cullColumnsOf(s);
  const p = new Promise<Uint8Array | null>((resolve) => {
    const end = (m: Uint8Array | null): void => { w.terminate(); if (job?.w === w) job = null; resolve(m); };
    job = { w, cancel: () => end(null) };
    w.onmessage = (e: MessageEvent<FromWorker>) => { const d = e.data; if (d.type === 'masks') end(d.masks); else if (d.type === 'error') end(null); };
    w.onerror = (e) => { e.preventDefault(); end(null); };
  });
  const msg: ToParseWorker = { type: 'cull', cols, assets: ASSETS.list.slice(), materials: MATERIALS.list.slice(), skip: [...skip] };
  w.postMessage(msg, Object.values(cols).filter((v): v is Uint8Array => ArrayBuffer.isView(v)).map((v) => v.buffer as ArrayBuffer));
  if (!skip.size) {
    masksOf.set(s, { rev: s.rev, masks: p });
    void p.then((m) => { if (!m && masksOf.get(s)?.masks === p) masksOf.delete(s); });
  }
  return p;
}

/** Hands the loader and the face culler their workers (the full build, when Worker exists). */
export function installParse(): void {
  if (typeof Worker === 'undefined') return;
  setParser(parseInWorker);
  setAsyncCull(cullInWorker);
}
