// .brdb worlds in the open-file flow (both builds when FEATURES.brdbRead): open (button, drop,
// paste), the live revision or any earlier one, and dynamic grids drawn read-only at their
// transforms.
//
// Worlds are read lazily (backlog S-08, src/format/brdblazy.ts): the file is never read whole. At
// open only the SQLite header, the revisions / folders / files tables and the blob index are read
// (File.slice); the world model (grids, entities) reads only the chunk indexes and entity chunks;
// then the scene loads what it shows: every file except the brick grids it doesn't draw
// (microchip, other entity and orphan grids). "Save .brz" / "Save as new world" need the whole tree
// as a template, so they load the rest first (ensureLoadedFiles).
//
// "Save as new world (.brdb)" writes a fresh world with the pure-TS SQLite writer (sqlitewrite.ts,
// raw blobs, which the game loads), so both builds can save worlds. The full build keeps sql.js
// (lazy wasm) only as a fallback reader for a world the lazy reader refuses. Lite has no sql.js.

import { S } from './state.ts';
import { loadBrdbBackend } from './features.ts';
import { LazyBrdbWorld, runLoaded, type LazyBrdbTree } from '../format/brdblazy.ts';
import { blobSource } from '../format/sqlitelazy.ts';
import { BrdbWorld, writeNewWorldFile, type BrdbRevision } from '../format/brdb.ts';
import { flattenTree } from '../format/stale.ts';
import { fileMapView, type SaveView } from '../format/saveview.ts';
import { writeBrz, type FileMap } from '../format/brz.ts';
import { buildWorldModel, buildWorldModelLazy, type WorldModel } from '../scene/grids.ts';
import { placedGridStore } from '../scene/worldgrids.ts';
import { ensureLoadedFiles, loadedName, loadFilesAsync } from '../scene/load.ts';
import { download, savedName, sceneFiles } from '../scene/save.ts';
import { setExtraStores } from '../render/extras.ts';
import { openers } from '../ui/panels/file.ts';
import { initAudio, playClick } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';
import { $ } from '../ui/dom.ts';
import { SceneStore } from '../scene/store.ts';

/** One state of a world, ready for the scene. */
interface WorldState {
  /** the files the scene needs (re-encoded to the live schemas where a revision is stale) */
  files: FileMap;
  model: WorldModel;
  /** every file of that state, for a save template; null when `files` already is all of it */
  complete: (() => Promise<FileMap>) | null;
  /** files left out of `files` because they can't be converted to the live schemas (flattenTree skipStale) */
  skipped: number;
}

/** An opened world, whichever reader opened it. */
interface OpenWorld {
  revisions: readonly BrdbRevision[];
  state(revisionId: number | null): Promise<WorldState>;
  close(): void;
  /** 'lazy' (File.slice pages) or 'sql.js' (whole file in wasm) */
  reader: string;
}

const GRID_DIR = /^World\/0\/Bricks\/Grids\/([^/]+)\//;

/** A SaveView of only some paths of a tree. */
const subView = (tree: SaveView, paths: readonly string[]): SaveView => {
  const keep = new Set(paths);
  return { paths: () => paths.slice(), has: (p) => keep.has(p), get: (p) => (keep.has(p) ? tree.get(p) : undefined), asWrittenWith: (p, m) => tree.asWrittenWith(p, m) };
};

async function openLazy(f: File): Promise<OpenWorld> {
  const w = await LazyBrdbWorld.open(blobSource(f));
  const flat = async (tree: LazyBrdbTree, view: SaveView, skipStale = false): Promise<{ files: FileMap; skipped: string[] }> => await runLoaded(tree, () => flattenTree(view, { skipStale }));
  return {
    reader: 'lazy',
    revisions: w.revisions,
    async state(revisionId) {
      const tree = w.tree(revisionId ?? undefined);
      const model = await buildWorldModelLazy(tree);
      const hidden = new Set(model.grids.filter((g) => g.id !== 1 && g.kind !== 'dynamic').map((g) => String(g.id)));
      const want = tree.paths().filter((p) => { const m = p.match(GRID_DIR); return !m || !hidden.has(m[1]!); });
      await tree.loadWritten(want.filter((p) => p.endsWith('.mps')));
      await tree.load(want);
      const { files, skipped } = await flat(tree, subView(tree, want), true);
      w.unloadBlobs();                        // the scene's file map holds what it needs
      const all = want.length === tree.paths().length && !skipped.length;
      return {
        files, model, skipped: skipped.length,
        // a save template must hold every file: flattened strictly (a file that can't be converted fails the save)
        complete: all ? null : async () => {
          const t = w.tree(revisionId ?? undefined);
          await t.load(t.paths());
          const full = (await flat(t, t)).files;
          w.unloadBlobs();
          return full;
        },
      };
    },
    close: () => w.clearCache(),
  };
}

async function openSqlJs(f: File): Promise<OpenWorld> {
  const backend = await loadBrdbBackend!();
  const w = BrdbWorld.open(backend, new Uint8Array(await f.arrayBuffer()));
  return {
    reader: 'sql.js',
    revisions: w.revisions,
    async state(revisionId) {
      const { files, skipped } = flattenTree(w.tree(revisionId ?? undefined), { skipStale: true });
      const complete = skipped.length ? async (): Promise<FileMap> => flattenTree(w.tree(revisionId ?? undefined)).files : null;
      return { files, model: buildWorldModel(fileMapView(files)), complete, skipped: skipped.length };
    },
    close: () => w.close(),
  };
}

let world: OpenWorld | null = null;
let worldName = '';
let loading = false;

export function initWorlds(): void {
  $('open').textContent = 'Open save (.brz / .brdb)';
  $<HTMLInputElement>('pick').accept = '.brz,.brdb,.bp';
  const revBox = document.createElement('label');
  revBox.id = 'revbox'; revBox.hidden = true; revBox.title = 'Show the world as it was saved at an earlier revision';
  revBox.textContent = 'Revision ';
  const rev = document.createElement('select');
  rev.id = 'rev'; rev.setAttribute('aria-label', 'World revision');
  revBox.append(rev);
  $('saverow').after(revBox);
  const saveWorld = document.createElement('button');
  saveWorld.type = 'button'; saveWorld.id = 'savebrdb';
  saveWorld.title = 'Download the scene as a new world (.brdb, uncompressed), written from the save or world you opened';
  saveWorld.textContent = 'Save as new world (.brdb)';
  $('saverow').append(saveWorld);
  saveWorld.addEventListener('click', () => { void saveAsWorld(); });
  for (const t of ['pointerdown', 'dblclick', 'wheel']) revBox.addEventListener(t, (ev) => ev.stopPropagation());

  openers.push(async (f) => {
    if (!/\.brdb$/i.test(f.name)) return false;
    let w: OpenWorld | null = null;
    try {
      setStatus(`Opening ${f.name}…`);
      try { w = await openLazy(f); await loadRevision(w, null, f.name); }
      catch (err) {
        w?.close(); w = null;
        if (!loadBrdbBackend) throw err;
        console.warn('lazy .brdb reader failed, falling back to sql.js', err);
        w = await openSqlJs(f); await loadRevision(w, null, f.name);
      }
      world?.close(); world = w; worldName = f.name;
      rev.replaceChildren(new Option(`Live (${w.revisions.length} revision${w.revisions.length === 1 ? '' : 's'})`, ''));
      for (const r of [...w.revisions].reverse()) {
        const when = new Date(r.createdAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
        rev.add(new Option(`#${r.id} · ${when}${r.description ? ' · ' + r.description : ''}`, String(r.id)));
      }
      revBox.hidden = false;
      initAudio(); playClick();
    } catch (err) { w?.close(); setStatus(`Couldn't open ${f.name}: ${(err as Error).message}`); console.error(err); }
    return true;
  });
  rev.addEventListener('change', () => {
    if (!world) return;
    const w = world;
    rev.disabled = true;
    setStatus(`Loading ${worldName}${rev.value ? ` @ revision ${rev.value}` : ''}…`);
    loadRevision(w, rev.value ? Number(rev.value) : null, worldName)
      .catch((err) => { setStatus(`Couldn't load that revision: ${(err as Error).message}`); console.error(err); })
      .finally(() => { rev.disabled = false; });
  });
  // any other save replaces the world: hide its revision list and dynamic grids
  S.hooks.beforeLoad.push(() => { setExtraStores([], null); });
  S.hooks.loaded.push(() => { if (!loading) { revBox.hidden = true; world?.close(); world = null; } });
}

/** Loads a world as of a revision (null = live): grid 1 as the scene, dynamic grids read-only. */
async function loadRevision(w: OpenWorld, revisionId: number | null, name: string): Promise<void> {
  const { files, model, complete, skipped: staleFiles } = await w.state(revisionId);
  const extras = new SceneStore();
  let placed = 0, snapped = 0, skipped = 0, failed = 0;
  for (const g of model.grids) {
    if (g.kind !== 'dynamic') continue;
    let p: ReturnType<typeof placedGridStore>;
    try { p = placedGridStore(fileMapView(files), g, extras); }
    catch (err) { failed++; console.warn(`grid ${g.id} not shown`, err); continue; }
    if (p.placed) placed++;
    if (p.snapped) snapped++;
    skipped += p.skipped;

  }
  const others = model.grids.filter((g) => g.id !== 1).length;
  const note = [`${placed} of ${others} moving grid(s) shown (read-only)`, snapped && `${snapped} turned to the nearest quarter turn`, skipped && `${skipped} of their bricks unsupported`,
    failed && `${failed} unreadable`, staleFiles && `${staleFiles} file(s) in a newer layout left out (saving this world will fail)`].filter(Boolean).join(', ');
  const label = revisionId === null ? name : `${name} @ revision ${revisionId}`;
  loading = true;
  try { if (!(await loadFilesAsync(files, label, writeBrz(files), note, complete))) return; } finally { loading = false; }
  extras.drain();
  setExtraStores(extras.count ? [{ store: extras, origin: [0, 0, 0] }] : [], S.scene);
}

/** "Save as new world": the scene as a fresh .brdb (two revisions, raw blobs). */
async function saveAsWorld(): Promise<void> {
  try {
    await ensureLoadedFiles();
    const s = sceneFiles();
    if (!s) { setStatus('Open a save or world first: the new world is written from the save you opened'); return; }
    const name = savedName(loadedName.replace(/ @ revision \d+$/, ''), '.brdb');
    download(writeNewWorldFile(s.files), name);
    setStatus(`Saved ${name}` + (s.warnings.length ? ' · ' + s.warnings.join(' · ') : ''));
  } catch (err) { setStatus(`Couldn't save the world: ${(err as Error).message}`); console.error(err); }
}

/** Which reader opened the current world (tests and the status line). */
export const worldReader = (): string | null => world?.reader ?? null;
