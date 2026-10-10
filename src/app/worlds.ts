// .brdb worlds in the open-file flow (both builds when FEATURES.brdbRead): open (button, drop,
// paste), the live revision or any earlier one. Its dynamic grids load into the scene with grid 1
// (scene/dyngrids.ts), as for any save.
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
import { ensureLoadedFiles, loadedName, loadFilesAsync } from '../scene/load.ts';
import { download, savedName, sceneFiles } from '../scene/save.ts';
import { openers } from '../ui/panels/file.ts';
import { initAudio, playClick } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';
import { $ } from '../ui/dom.ts';
import { bytesEqual } from '../format/brz.ts';
import type { BrdbFileTable, BrdbTree } from '../format/brdb.ts';
import { diffSummary, revisionDiff, type RevisionDiff, type RevisionDiffOptions } from '../format/revdiff.ts';
import { initRevisionMarks, MAX_DRAWN, revisionMarkCount, setRevisionMarks, showRevisionMarks } from '../ui/overlay/revmarks.ts';

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
  /** What changed from `from` (null = the live tree, 'empty' = nothing) to `to` (W-05). */
  diff(from: number | null | 'empty', to: number | null, opts?: RevisionDiffOptions): Promise<RevisionDiff>;
  /** Do the live tree and the head revision hold the same files? */
  liveIsHead(): boolean;
  close(): void;
  /** 'lazy' (File.slice pages) or 'sql.js' (whole file in wasm) */
  reader: string;
}

/** OpenWorld.diff / liveIsHead on either reader's world. */
function diffOps(w: BrdbFileTable & { tree(id?: number): BrdbTree }, opts0: RevisionDiffOptions, after: () => void): Pick<OpenWorld, 'diff' | 'liveIsHead'> {
  const treeOf = (id: number | null): BrdbTree => w.tree(id ?? undefined);
  return {
    async diff(from, to, opts = {}) {
      try { return await revisionDiff(w, from === 'empty' ? null : treeOf(from), treeOf(to), { ...opts0, ...opts }); }
      finally { after(); }
    },
    liveIsHead() {
      const head = w.head;
      if (!head) return true;
      const d = w.diffTrees(w.tree(head.id), w.tree());
      return !d.added.length && !d.removed.length && !d.changed.length;
    },
  };
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
    ...diffOps(w, {}, () => w.unloadBlobs()),
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
    ...diffOps(w, { undecided: (x, y) => bytesEqual(w.blob(x.contentId), w.blob(y.contentId)) }, () => w.clearCache()),
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
  const diffUi = initDiffUi(revBox);

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
      shownRev = null;
      diffUi.reset(w);
      initAudio(); playClick();
    } catch (err) { w?.close(); setStatus(`Couldn't open ${f.name}: ${(err as Error).message}`); console.error(err); }
    return true;
  });
  rev.addEventListener('change', () => {
    if (!world) return;
    const w = world;
    rev.disabled = true;
    setStatus(`Loading ${worldName}${rev.value ? ` @ revision ${rev.value}` : ''}…`);
    const id = rev.value ? Number(rev.value) : null;
    loadRevision(w, id, worldName)
      .then((ok) => { if (ok && world === w) { shownRev = id; diffUi.refresh(); } })
      .catch((err) => { setStatus(`Couldn't load that revision: ${(err as Error).message}`); console.error(err); })
      .finally(() => { rev.disabled = false; });
  });
  // any other save replaces the world: hide its revision list
  S.hooks.loaded.push(() => { if (!loading) { revBox.hidden = true; diffUi.hide(); world?.close(); world = null; } });
}

/** The revision shown now (null = live). */
let shownRev: number | null = null;

/**
 * W-05: the revision diff row under the Revision dropdown. "Changes vs" previous (default), any
 * revision, or off; the counts for the shown revision against it; Highlight outlines the main
 * grid's added / changed / removed bricks. Computed after each revision load, in the background.
 */
function initDiffUi(revBox: HTMLElement): { reset(w: OpenWorld): void; refresh(): void; hide(): void } {
  const box = document.createElement('div');
  box.id = 'revdiffbox'; box.hidden = true;
  const cmpLabel = document.createElement('label');
  cmpLabel.textContent = 'Compare ';
  cmpLabel.title = 'Count what the shown revision changed since another one (the previous revision by default)';
  const cmp = document.createElement('select');
  cmp.id = 'revcmp'; cmp.setAttribute('aria-label', 'Compare the shown revision with');
  cmpLabel.append(cmp);
  const hlLabel = document.createElement('label');
  hlLabel.title = 'Outline the main grid\'s added (green), changed (amber) and removed (red) bricks';
  const hl = document.createElement('input');
  hl.type = 'checkbox'; hl.id = 'revhl';
  hlLabel.append(hl, ' Highlight');
  const out = document.createElement('div');
  out.id = 'revdiff'; out.setAttribute('aria-live', 'polite');
  const more = document.createElement('button');
  more.type = 'button'; more.id = 'revmatch'; more.hidden = true; more.textContent = 'Match bricks';
  box.append(cmpLabel, hlLabel, out, more);
  revBox.after(box);
  for (const t of ['pointerdown', 'dblclick', 'wheel']) box.addEventListener(t, (ev) => ev.stopPropagation());
  initRevisionMarks();

  let token = 0;
  /** The base for the shown revision: a revision id or 'empty' (before the first one). */
  const baseOf = (w: OpenWorld): number | 'empty' | null => {
    const revs = w.revisions;
    if (cmp.value === 'none') return null;
    if (cmp.value !== 'prev') return Number(cmp.value);
    if (shownRev === null) {
      const head = revs[revs.length - 1];
      if (!head) return 'empty';
      return w.liveIsHead() ? (revs[revs.length - 2]?.id ?? 'empty') : head.id;
    }
    const i = revs.findIndex((r) => r.id === shownRev);
    return i > 0 ? revs[i - 1]!.id : 'empty';
  };
  const run = async (force: boolean): Promise<void> => {
    const w = world, tok = ++token;
    more.hidden = true;
    setRevisionMarks(null, null);
    if (!w) return;
    const base = baseOf(w);
    if (base === null) { out.textContent = ''; return; }
    const what = `${shownRev === null ? 'Live' : '#' + shownRev} vs ${base === 'empty' ? 'nothing (first revision)' : '#' + base}`;
    if (base === shownRev) { out.textContent = `${what}: the same revision`; return; }
    out.textContent = `${what}: comparing…`;
    try {
      const d = await w.diff(base, shownRev, { force });
      if (tok !== token || world !== w) return;
      out.textContent = `${what}: ${diffSummary(d)}`;
      out.title = `Files: ${d.files.added.length} added, ${d.files.removed.length} removed, ${d.files.changed.length} changed · ` +
        `chunk files changed: ${d.chunks.bricks} brick, ${d.chunks.components} component, ${d.chunks.wires} wire` +
        (d.marks.truncated ? ' · the highlight shows only part of the change' : '');
      if (!d.bricks.counted) { more.hidden = false; more.textContent = `Match bricks (${Math.round(d.bricks.bytes / 1048576)} MB of chunks)`; }
      setRevisionMarks(d.marks, S.scene);
      showRevisionMarks(hl.checked);
    } catch (err) {
      if (tok !== token) return;
      out.textContent = `${what}: couldn't compare (${(err as Error).message})`;
      console.error(err);
    }
  };
  cmp.addEventListener('change', () => { void run(false); });
  more.addEventListener('click', () => { void run(true); });
  hl.addEventListener('change', () => {
    showRevisionMarks(hl.checked);
    const n = revisionMarkCount();
    if (hl.checked) setStatus(n ? `Highlighting ${n.toLocaleString('en-US')} changed brick${n === 1 ? '' : 's'}${n > MAX_DRAWN ? ` (the first ${MAX_DRAWN.toLocaleString('en-US')} drawn)` : ''}: green added, amber changed, red removed` : 'Nothing to highlight for this comparison');
  });
  return {
    reset(w) {
      cmp.replaceChildren(new Option('vs previous', 'prev'), new Option('off', 'none'));
      for (const r of [...w.revisions].reverse()) cmp.add(new Option(`vs #${r.id}`, String(r.id)));
      box.hidden = false;
      void run(false);
    },
    refresh() { void run(false); },
    hide() { token++; box.hidden = true; setRevisionMarks(null, null); },
  };
}

/** Loads a world as of a revision (null = live): grid 1 and the dynamic grids as the scene (scene/dyngrids.ts). */
async function loadRevision(w: OpenWorld, revisionId: number | null, name: string): Promise<boolean> {
  const { files, complete, skipped: staleFiles } = await w.state(revisionId);
  const note = staleFiles ? `${staleFiles} file(s) in a newer layout left out (saving this world will fail)` : null;
  const label = revisionId === null ? name : `${name} @ revision ${revisionId}`;
  loading = true;
  try { return !!(await loadFilesAsync(files, label, writeBrz(files), note, complete)); } finally { loading = false; }
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
