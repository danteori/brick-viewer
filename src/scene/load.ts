// Loading a .brz into the scene (ported from the legacy viewer's loadSave). The format layer reads
// the container and the grid's chunks (src/format); every brick the viewer can draw becomes a row of
// a new SceneStore (no per-brick objects), and the new store is swapped in as one undoable step.
// viewerBrick (a save brick -> an editor Brick) is the one conversion store rows are read with too
// (scene/view.ts brickView).

import { S } from '../app/state.ts';
import { BrickShapes } from '../render/meshes/shapes.js';
import { readBrz, type FileMap } from '../format/brz.ts';
import { extractBricks, type PlainBrick } from '../format/world.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { linearByteToSrgb } from '../core/colour.ts';
import { rampDir, sideCode, type Brick, type SaveExtras, type V3 } from './brick.ts';
import { roundHalf } from '../render/meshes/registry.ts';
import { histEnd, histPush, sceneSnap } from './history.ts';
import { selectBrick } from '../editor/resize.ts';
import { FLAG_NAMES, SceneStore } from './store.ts';
import { fixedHalfOf, isFixedAsset, isStretchedAsset, putPlain, supportedAsset } from './view.ts';
import { fastStore } from './fastload.ts';
import { fitHalf, ZOOM_MAX } from '../render/camera.ts';
import { setProgress, setStatus } from '../ui/status.ts';
import { attachComponents, loadOrderOf, type LoadOrder } from './compmodel.ts';
import type { Parsed, Progress } from './parsecore.ts';
import { loadDynamicGrids, type DynLoad } from './dyngrids.ts';

/** The status line's note on a save's other grids. */
function gridLine(extra: number, d: DynLoad): string {
  const shown = d.grids ? `${d.grids} moving grid${d.grids === 1 ? '' : 's'} (click one to select it)` : '';
  const rest = [d.snapped && `${d.snapped} turned to the nearest quarter turn`, d.skipped && `${d.skipped} of their bricks unsupported`,
    d.failed && `${d.failed} unreadable`, d.others && `${d.others} other grid${d.others === 1 ? '' : 's'} (microchips...) not shown`].filter(Boolean);
  return [shown || (!d.others && !d.failed ? `${extra} grid(s) not shown` : ''), ...rest].filter(Boolean).join(', ');
}

export interface LoadReport { name: string; drawn: number; skipped: number; skippedTypes: Record<string, number>; sideways: number; extraGrids: number }

/** A save brick with its index in load order (SaveExtras.seq), for bricks the viewer doesn't show. */
export type SeqBrick = PlainBrick & { seq?: number };

/** Why a save brick has no viewer brick: its asset isn't a supported type. */
export interface Skip { skip: string }

/**
 * One save brick -> a viewer brick (world box in absolute viewer units), or the asset
 * name when the type isn't supported. `linear`: the chunk stores linear colour bytes.
 */
export function viewerBrick(pb: PlainBrick, linear: boolean): Brick | Skip {
  const asset = pb.asset, procedural = pb.size !== null;
  const isMicro = procedural && /MicroBrick$/i.test(asset), isBrick = procedural && /DefaultBrick$/.test(asset);
  const isTile = procedural && /DefaultSmoothTile$/.test(asset);   // a stud brick with a smooth top
  const isPlain = procedural && /DefaultTile$/.test(asset);         // a stud brick with a plain, bevelled top
  const isRamp = procedural && /DefaultRamp$/.test(asset);          // (RampInverted is a special shape)
  const isCrest = procedural && /DefaultRampCrest$/.test(asset), isCrestEnd = procedural && /DefaultRampCrestEnd$/.test(asset);
  // fixed-asset (B_*) rounds / cones: no size in the save, the generator gives their half-extents
  const basic = procedural ? null : asset;
  const isRound = !!basic && BrickShapes.isRound(basic);
  const isMicroShape = procedural && !isMicro && BrickShapes.isMicro(asset);
  // fixed-mesh B_* bricks (their box from the generator) and the stretched designs (PB_Frog, ...) draw as local shapes
  const isFixed = !!basic && isFixedAsset(basic);
  const isSpecial = (procedural && (BrickShapes.isSpecial(asset) || isStretchedAsset(asset))) || isFixed;
  if (!isRound && !isFixed && (!procedural || !(isMicro || isBrick || isTile || isPlain || isMicroShape || isSpecial))) return { skip: asset || 'unknown' };
  // World box from the verified orientation rule: h[i] = sum_j |M[i][j]| s[j].
  const o = pb.orient, M = BrickShapes.brickOrient(o), dir = (o >> 2) % 6;
  const s = isRound ? roundHalf(basic!) : isFixed ? fixedHalfOf(basic!) : pb.size!;
  const half = [0, 1, 2].map((r) => Math.abs(M[r][0]) * s[0] + Math.abs(M[r][1]) * s[1] + Math.abs(M[r][2]) * s[2]);
  const up = dir === 4 ? 1 : dir === 5 ? -1 : 0;
  // Ramps / crests upright or upside down keep their world-frame meshes; sideways they're special shapes.
  const shape: Partial<Brick> = isRamp && up ? { shape: 'ramp', ...rampDir(o) }
    : isCrest && up ? { shape: 'crest', ...BrickShapes.crestDir(o) }
      : isCrestEnd && up ? { shape: 'crestEnd', ...BrickShapes.crestEndDir(o) }
        : isRound ? { shape: 'round', round: basic!, ...(up ? {} : { o }) }
          : isMicroShape ? { shape: 'micro', asset, o }
            : isSpecial ? { shape: 'special', asset, o } : {};
  if (!up) shape.side = sideCode(o);
  const pos = pb.pos, col = pb.color;
  // The stored bytes are sRGB-encoded (bColorsAreLinear = false); bricks keep display (sRGB)
  // colours and the shader decodes them. Saves from before CL14860 store LINEAR bytes, so those
  // get the sRGB OETF applied first. The A byte is not colour: it's the material intensity (0-10).
  const toS = linear ? linearByteToSrgb : (v: number): number => v / 255;
  const b: Brick = {
    lo: pos.map((v, a) => +((v - half[a]) * BRZ_UNIT).toFixed(3)) as V3,
    hi: pos.map((v, a) => +((v + half[a]) * BRZ_UNIT).toFixed(3)) as V3,
    micro: !!(isMicro || isMicroShape), tile: !!isTile, top: isTile ? 'smooth' : isPlain ? 'plain' : 'studs', color: [toS(col[0]), toS(col[1]), toS(col[2])], up,
    material: pb.material,
    ...shape,
  };
  if (col[3] !== undefined) b.intensity = col[3];
  const keep: SaveExtras = {};
  if (pb.owner) keep.owner = pb.owner;
  if (pb.originalOwner !== undefined && pb.originalOwner !== (pb.owner ?? 0)) keep.originalOwner = pb.originalOwner;
  if (pb.flags) keep.flags = pb.flags;
  if (Object.keys(keep).length) b.save = keep;
  return b;
}

/** Save files -> viewer bricks of grid 1 (other grids are physics entities, not shown yet). */
export function bricksFromFiles(files: FileMap): { bricks: Brick[]; report: Omit<LoadReport, 'name' | 'drawn'>; unsupported: SeqBrick[] } {
  const out: Brick[] = [], skippedTypes: Record<string, number> = {}, unsupported: SeqBrick[] = [];
  let skipped = 0, sideways = 0, extraGrids = 0;
  const grids = [...new Set([...files.keys()].map((k) => k.match(/^World\/0\/Bricks\/Grids\/([^/]+)\//)?.[1]).filter(Boolean))];
  for (const g of grids) if (g !== '1') extraGrids++;
  if (grids.includes('1')) {
    const { bricks, linear } = extractBricks(files);
    bricks.forEach((pb, i) => {
      const b = viewerBrick(pb, linear[i]!);
      if ('skip' in b) { skipped++; skippedTypes[b.skip] = (skippedTypes[b.skip] || 0) + 1; unsupported.push({ ...pb, seq: i }); return; }
      (b.save ??= {}).seq = i;                 // its place in the save (see SaveExtras.seq)
      if (!b.up) sideways++;
      out.push(b);
    });
  }
  return { bricks: out, report: { skipped, skippedTypes, sideways, extraGrids }, unsupported };
}

/** Save files -> a SceneStore of grid 1's drawable bricks, plus the bricks it can't draw (with their load order). */
export function storeFromFiles(files: FileMap, progress?: (done: number, total: number) => void): { store: SceneStore; report: Omit<LoadReport, 'name' | 'drawn'>; unsupported: SeqBrick[]; order: LoadOrder } {
  const grids = [...new Set([...files.keys()].map((k) => k.match(/^World\/0\/Bricks\/Grids\/([^/]+)\//)?.[1]).filter(Boolean))];
  let extraGrids = 0;
  for (const g of grids) if (g !== '1') extraGrids++;
  if (!grids.includes('1')) return { store: new SceneStore(), report: { skipped: 0, skippedTypes: {}, sideways: 0, extraGrids }, unsupported: [], order: loadOrderOf([]) };
  const f = fastStore(files, progress);
  return { store: f.store, report: { skipped: f.skipped, skippedTypes: f.skippedTypes, sideways: f.sideways, extraGrids }, unsupported: f.unsupported, order: f.order };
}

/** storeFromFiles by way of a PlainBrick per brick (the reference the fast path is tested against). */
export function storeFromFilesPlain(files: FileMap): { store: SceneStore; report: Omit<LoadReport, 'name' | 'drawn'>; unsupported: SeqBrick[]; order: LoadOrder } {
  const skippedTypes: Record<string, number> = {}, unsupported: SeqBrick[] = [];
  let skipped = 0, sideways = 0, extraGrids = 0;
  const grids = [...new Set([...files.keys()].map((k) => k.match(/^World\/0\/Bricks\/Grids\/([^/]+)\//)?.[1]).filter(Boolean))];
  for (const g of grids) if (g !== '1') extraGrids++;
  let store = new SceneStore(), order = loadOrderOf([]);
  if (grids.includes('1')) {
    const { bricks, linear, ctx } = extractBricks(files);
    order = loadOrderOf(bricks.map((b) => b.pos));
    store = new SceneStore(bricks.length);
    store.flagFields = ctx.flagFields.map((f) => FLAG_NAMES.id(f));
    bricks.forEach((pb, i) => {
      if (!supportedAsset(pb.asset, pb.size !== null)) {
        const k = pb.asset || 'unknown';
        skipped++; skippedTypes[k] = (skippedTypes[k] || 0) + 1; unsupported.push({ ...pb, seq: i });
        return;
      }
      const id = store.alloc();
      putPlain(store, id, { ...pb, seq: i }, linear[i]!);
      const dir = (pb.orient >> 2) % 6;
      if (dir < 4) sideways++;
    });
    store.drain();
  }
  return { store, report: { skipped, skippedTypes, sideways, extraGrids }, unsupported, order };
}

/**
 * The files of the save the scene came from: the template "Save .brz" rebuilds grid 1 into
 * (everything else is copied as is). Null until a save is opened.
 */
export let loadedFiles: FileMap | null = null;
export let loadedName = '';
/** The bytes as opened (a .brz, or a .brz made from a world), for the map. */
export let loadedBrz: Uint8Array | null = null;
/**
 * When loadedFiles is only part of the save (a lazily read world), loads the rest. Null when
 * loadedFiles is complete.
 */
let completeFiles: (() => Promise<FileMap>) | null = null;
/** Makes loadedFiles the whole save before it's used as a template (Save .brz, Save as new world). */
export async function ensureLoadedFiles(): Promise<void> {
  const f = completeFiles;
  if (!f) return;
  const all = await f();
  if (completeFiles === f) { loadedFiles = all; completeFiles = null; }   // unless another save opened meanwhile
}
/** Grid-1 bricks of that save the viewer can't show: "Save .brz" writes them back unchanged. */
export let loadedUnsupported: SeqBrick[] = [];

export let lastLoad: LoadReport | null = null;

/** The save files each scene store was loaded from (components / wires checks); none for the startup scene. */
const storeFiles = new WeakMap<SceneStore, FileMap>();
export const filesOf = (s: SceneStore): FileMap | null => storeFiles.get(s) ?? null;

/** Read a .brz and make it the scene, framed around its first brick. One undo step. */
export function loadSave(buf: ArrayBuffer | Uint8Array, name: string): LoadReport {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return loadFiles(readBrz(bytes), name, bytes);
}

/**
 * A save's file tree (a .brz, or a world at some revision) -> the scene. `brz`: the bytes of a
 * .brz holding the same tree, for the map. `gridNote`: one more note for the status line. `complete`: files is part of the save (it holds grid 1); this loads all of it.
 */
export function loadFiles(files: FileMap, name: string, brz: Uint8Array | null = null, gridNote: string | null = null, complete: (() => Promise<FileMap>) | null = null): LoadReport {
  for (const f of S.hooks.beforeLoad) f();
  return finishLoad({ files, ...storeFromFiles(files) }, name, brz, gridNote, complete);
}

/**
 * Off-main-thread parsing (S-01): the full build installs a worker (app/parse.ts); null in lite.
 * `cull`: also compute the store's face masks in the worker (render/facecull.ts picks them up).
 */
type Parser = (input: { bytes?: Uint8Array; files?: FileMap }, progress: Progress, cull: boolean) => Promise<Parsed>;
let parser: Parser | null = null;
export function setParser(p: Parser | null): void { parser = p; }
export const hasParser = (): boolean => parser !== null;
/** Saves at least workerMinBytes big (compressed .brz bytes, or file bytes for a world) load in the worker when there is one (test hook: lower it). */
export const loadSettings = { workerMinBytes: 2_000_000 };
/** Bumped by every async load: a parse that finishes after a newer load started is dropped. */
let loadGen = 0;

/** Parses in the worker with the status line's progress bar; null when a newer load started meanwhile. */
async function parseOff(input: { bytes?: Uint8Array; files?: FileMap }, name: string): Promise<Parsed | null> {
  const gen = ++loadGen, mb = (n: number): string => (n / 1e6).toFixed(1);
  setStatus(`Opening ${name}...`); setProgress(0);
  try {
    const p = await parser!(input, (phase, done, total) => {
      if (gen !== loadGen || phase === 'cull') return;
      if (phase === 'read') { setStatus(`Opening ${name}: reading...`); setProgress(0.03); return; }
      setStatus(`Opening ${name}: ${total ? `${mb(done)} of ${mb(total)}` : mb(done)} M bricks`);
      setProgress(total ? 0.05 + 0.9 * Math.min(1, done / total) : NaN);
    }, true);
    return gen === loadGen ? p : null;
  } finally { if (gen === loadGen) setProgress(null); }
}

/** loadSave, in the parse worker when there is one and the save is big (the UI keeps running meanwhile); null when superseded. */
export async function loadSaveAsync(buf: ArrayBuffer | Uint8Array, name: string): Promise<LoadReport | null> {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (!parser || bytes.length < loadSettings.workerMinBytes) { loadGen++; return loadSave(bytes, name); }
  const p = await parseOff({ bytes: bytes.slice() }, name);
  if (!p) return null;
  for (const f of S.hooks.beforeLoad) f();
  return finishLoad(p, name, bytes);
}

/** loadFiles, in the parse worker when there is one and the files are big; null when superseded. */
export async function loadFilesAsync(files: FileMap, name: string, brz: Uint8Array | null = null, gridNote: string | null = null, complete: (() => Promise<FileMap>) | null = null): Promise<LoadReport | null> {
  let size = 0;
  for (const v of files.values()) size += v.length;
  if (!parser || size < loadSettings.workerMinBytes) { loadGen++; return loadFiles(files, name, brz, gridNote, complete); }
  const p = await parseOff({ files }, name);
  if (!p) return null;
  for (const f of S.hooks.beforeLoad) f();
  return finishLoad({ ...p, files }, name, brz, gridNote, complete);
}

/** The rest of a load, after its store is built (loadFiles / the async loads): the store becomes the scene. */
function finishLoad(parsed: Parsed, name: string, brz: Uint8Array | null = null, gridNote: string | null = null, complete: (() => Promise<FileMap>) | null = null): LoadReport {
  const { files, store, report, unsupported, order } = parsed;
  const dyn = loadDynamicGrids(store, files);   // the moving grids, as rows of their own grids (W-03)
  store.drain();
  if (!store.count) throw new Error('no supported bricks in this save');
  histEnd();
  const prevScene = sceneSnap();
  S.scene = store;
  S.origin = [0, 0, 0];                        // a new scene: the camera's frame starts at the world origin
  selectBrick(store.first());
  // frame the whole save around the focused brick
  const { lo, hi } = S;
  const sl = [Infinity, Infinity, Infinity], sh = [-Infinity, -Infinity, -Infinity], bx = new Array<number>(6);
  for (const id of store.ids()) {
    store.box(id, bx);
    for (let i = 0; i < 3; i++) { sl[i] = Math.min(sl[i]!, bx[i]!); sh[i] = Math.max(sh[i]!, bx[i + 3]!); }
  }
  for (let i = 0; i < 3; i++) { sl[i] = +(sl[i]! * BRZ_UNIT).toFixed(3); sh[i] = +(sh[i]! * BRZ_UNIT).toFixed(3); }
  const c = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2), r = [0, 1, 2].map((i) => Math.max(c[i] - sl[i]!, sh[i]! - c[i]));
  S.zoomMul = Math.min(ZOOM_MAX, Math.max(1, fitHalf(c.map((v, i) => v - r[i]), c.map((v, i) => v + r[i])) / fitHalf(lo, hi)));
  histPush({ kind: 'scene', label: 'load save', before: prevScene, after: sceneSnap() });
  lastLoad = { name, drawn: store.count, ...report };
  loadedFiles = files; completeFiles = complete; loadedName = name; loadedBrz = brz; loadedUnsupported = unsupported;
  storeFiles.set(store, files);
  const compErr = attachComponents(store, files, order);
  const { skipped, skippedTypes, sideways, extraGrids } = report;
  const notes = [skipped && `${skipped} unsupported skipped (${Object.entries(skippedTypes).map(([k, n]) => `${k.replace(/^(PB|BP|B)_(Default)?/, '')} ${n}`).join(', ')})`,
    sideways && `${sideways} sideways`,
    extraGrids && gridLine(extraGrids, dyn),
    gridNote,
    compErr && `components / wires unreadable (${compErr})`].filter(Boolean);
  setStatus(`${name}: ${store.count} brick${store.count === 1 ? '' : 's'}${notes.length ? ' · ' + notes.join(' · ') : ''}`);
  for (const f of S.hooks.loaded) f();
  return lastLoad;
}
