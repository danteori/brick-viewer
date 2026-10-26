import { BRZ_UNIT, r3 } from '../core/units.ts';
import { readBrz, type FileMap } from '../format/brz.ts';
import { extractBricks } from '../format/world.ts';
import type { Brick, V3 } from '../scene/brick.ts';
import { brickSolid, sceneHit } from '../scene/collision.ts';
import { importParts, mergeImport, placedBricks, prefabOffset, type ImportParts, type MergeChoice, type PartMode } from '../scene/importmerge.ts';
import { ensureLoadedFiles, loadedFiles, loadedName, loadFilesAsync, loadSaveAsync, storeFromFiles, viewerBrick } from '../scene/load.ts';
import { loadDynamicGrids } from '../scene/dyngrids.ts';
import { sceneFiles } from '../scene/save.ts';
import { GRIDS } from '../scene/store.ts';
import { brickView } from '../scene/view.ts';
import { ed, startPlacing, type Ghost } from '../editor/ghost.ts';
import { exclusive } from '../core/exclusive.ts';
import { placeholder } from '../ui/placeholder.ts';
import { openers } from '../ui/panels/file.ts';
import { initAudio, playClick, playError } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';
import { readWorldFile } from './worlds.ts';
import { FEATURES } from './features.ts';

/** Above this many bricks the prefab ghost shows a sample of them inside the import's outline. */
export const PREVIEW_MAX = 5000;
/** Up to this many bricks the prefab ghost shows in red the bricks that collide and will be left out. */
export const HITS_MAX = 1500;

export type Placement = 'saved' | 'prefab';

/** What the dialog chose. */
export interface ImportChoice { parts: MergeChoice; placement: Placement }

type Answer = { open: true } | { cancel: true } | ImportChoice;

const isSave = (f: File): boolean => /\.(brz|brdb)$/i.test(f.name);

async function readImport(f: File): Promise<FileMap> {
  if (/\.brdb$/i.test(f.name)) {
    if (!FEATURES.brdbRead) throw new Error('worlds cannot be read in this build');
    return await readWorldFile(f);
  }
  return readBrz(new Uint8Array(await f.arrayBuffer()));
}

export function initImporter(): void {
  openers.unshift(async (f) => {
    if (!loadedFiles || !isSave(f)) return false;
    let add: FileMap;
    try { setStatus(`Reading ${f.name}…`); add = await readImport(f); }
    catch (err) { setStatus(`Couldn't open ${f.name}: ${(err as Error).message}`); console.error(err); return true; }
    const parts = importParts(add);
    const answer = await askImport(f.name, parts);
    if ('open' in answer) return openAsNew(f);
    if ('cancel' in answer) { setStatus('Import cancelled'); return true; }
    try { await runImport(f.name, add, answer); }
    catch (err) { setStatus(`Couldn't import ${f.name}: ${(err as Error).message}`); console.error(err); }
    return true;
  });
}

async function openAsNew(f: File): Promise<boolean> {
  for (const o of openers.slice(1)) if (await o(f)) return true;
  try { if (await loadSaveAsync(await f.arrayBuffer(), f.name)) { initAudio(); playClick(); } }
  catch (err) { setStatus(`Couldn't open ${f.name}: ${(err as Error).message}`); console.error(err); }
  return true;
}

const hasChoice = (c: MergeChoice): boolean => !!(c.bricks || c.entities || c.environment || c.other);
const adds = (c: MergeChoice): boolean => c.bricks === 'add' || c.entities === 'add';

async function runImport(name: string, add: FileMap, choice: ImportChoice): Promise<void> {
  if (!hasChoice(choice.parts)) { setStatus('Nothing chosen to import'); return; }
  if (choice.placement === 'prefab' && adds(choice.parts)) { placeAsPrefab(name, add, choice.parts); return; }
  await mergeAt(name, add, choice.parts, 0, [0, 0, 0]);
}

async function mergeAt(name: string, add: FileMap, parts: MergeChoice, turns: number, offset: readonly number[]): Promise<void> {
  setStatus(`Importing ${name}…`);
  await ensureLoadedFiles();
  const drop = parts.bricks === 'add' ? overlapping(add, turns, offset) : new Set<number>();
  const base = sceneFiles();
  if (!base) throw new Error('open a save first');
  const r = mergeImport(base.files, add, parts, { turns, offset, drop });
  const notes = [r.dropped && `${r.dropped} overlapping brick${r.dropped === 1 ? '' : 's'} left out`, ...r.warnings].filter(Boolean).join(' · ');
  const report = await loadFilesAsync(r.files, loadedName, null, `imported ${name}${notes ? ' · ' + notes : ''}`, null, { label: 'import', keepView: true });
  if (report) { initAudio(); playClick(); }
}

/** Indices of the import's grid-1 bricks that, placed, would overlap a grid-1 brick of the scene. */
export function overlapping(add: FileMap, turns: number, offset: readonly number[]): Set<number> {
  const imp = extractBricks(add), placed = placedBricks(imp.bricks, turns, offset), out = new Set<number>();
  placed.forEach((pb, i) => {
    const b = viewerBrick(pb, imp.linear[i] ?? false);
    if ('skip' in b) return;
    if (sceneHit(b.lo, b.hi, { grid: '1', solid: brickSolid(b, b.lo, b.hi) }) >= 0) out.add(i);
  });
  return out;
}

interface ImportGhost { items: Brick[]; low: V3; size: V3; total: number }

function importGhost(add: FileMap, parts: MergeChoice): ImportGhost {
  const s = storeFromFiles(add).store;
  if (parts.entities === 'add') loadDynamicGrids(s, add);
  s.drain();
  const main = GRIDS.id('1');
  const rows = [...s.ids()].filter((id) => (s.grid[id] === main ? parts.bricks === 'add' : parts.entities === 'add'));
  if (!rows.length) throw new Error('nothing to place');
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity], ext = new Array<number>(6).fill(rows[0]!), bx = new Array<number>(6);
  for (const id of rows) {
    s.box(id, bx);
    for (let i = 0; i < 3; i++) {
      if (bx[i]! < lo[i]) { lo[i] = bx[i]!; ext[i] = id; }
      if (bx[i + 3]! > hi[i]) { hi[i] = bx[i + 3]!; ext[i + 3] = id; }
    }
  }
  const low = lo.map(Math.round) as V3, size = hi.map((v, i) => Math.round(v) - low[i]!) as V3;
  const shown = sample(rows, ext);
  const items = shown.map((id) => relativeTo(brickView(s, id), low));
  return { items, low, size, total: rows.length };
}

function sample(rows: readonly number[], extremes: readonly number[]): number[] {
  if (rows.length <= PREVIEW_MAX) return rows.slice();
  const step = rows.length / PREVIEW_MAX, pick = new Set(extremes);
  for (let i = 0; i < rows.length && pick.size < PREVIEW_MAX; i += step) pick.add(rows[Math.floor(i)]!);
  return [...pick];
}

function relativeTo(b: Brick, low: V3): Brick {
  const o = low.map((v) => v * BRZ_UNIT);
  b.lo = b.lo.map((v, i) => r3(v - o[i]!)) as V3; b.hi = b.hi.map((v, i) => r3(v - o[i]!)) as V3;
  if (b.save) { delete b.save.seq; if (!Object.keys(b.save).length) delete b.save; }
  return b;
}

const BUSY_TEXT = placeholder('Wait: the last copy is still being imported');

/** Merges one copy of the import at a time; the ghost stays in hand through the merge's load. */
const mergeCopy = exclusive(async (name: string, add: FileMap, parts: MergeChoice, turns: number, offset: readonly number[]) => {
  ed.keepOnLoad = true;
  try { await mergeAt(name, add, parts, turns, offset); } catch (err) { setStatus(`Couldn't import ${name}: ${(err as Error).message}`); console.error(err); } finally { ed.keepOnLoad = false; }
});

function placeAsPrefab(name: string, add: FileMap, parts: MergeChoice): void {
  const g = importGhost(add, parts);
  const note = g.items.length < g.total ? ` (showing ${g.items.length} of ${g.total} bricks)` : '';
  startPlacing(g.items, `import ${name}`, 'click', null, {
    drop: true, noHits: g.items.length > HITS_MAX, whole: true, cancelText: 'Import cancelled',
    onPlace: (G: Ghost) => {
      const pose = G.pose!, turns = ((G.turns % 4) + 4) % 4, offset = prefabOffset(g.low, g.size, turns, pose, BRZ_UNIT);
      if (mergeCopy(name, add, parts, turns, offset)) return true;
      setStatus(BUSY_TEXT); initAudio(); playError();
      return false;
    },
  });
  setStatus(`Placing ${name}${note}: click in the scene to place, R turns it, PgUp / PgDn raise / lower, Esc cancels`);
}

interface PartRow { key: keyof ImportParts; label: string; modes: boolean; count: (p: ImportParts) => string }
const ROWS: PartRow[] = [
  { key: 'bricks', label: 'Bricks', modes: true, count: (p) => `${p.bricks} brick${p.bricks === 1 ? '' : 's'}, with components and wires` },
  { key: 'entities', label: 'Entities', modes: true, count: (p) => `${p.entities} moving grid${p.entities === 1 ? '' : 's'}` },
  { key: 'environment', label: 'Environment', modes: false, count: () => 'replaces the current one' },
  { key: 'other', label: 'Other world data', modes: false, count: () => 'minigame, game mode, prefabs; replaces the current data' },
];

let openDialog: { el: HTMLElement; done: (a: Answer) => void } | null = null;

/** The import dialog for file `name` holding `parts`. */
export function askImport(name: string, parts: ImportParts): Promise<Answer> {
  openDialog?.done({ cancel: true });
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.id = 'importdlg'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'imp-title');
    const title = document.createElement('h2');
    title.id = 'imp-title'; title.textContent = `Import ${name} into the open save`;
    const list = document.createElement('div');
    list.className = 'imp-parts';
    const boxes = new Map<keyof ImportParts, HTMLInputElement>(), modes = new Map<keyof ImportParts, HTMLSelectElement>();
    for (const r of ROWS) {
      const has = typeof parts[r.key] === 'number' ? (parts[r.key] as number) > 0 : !!parts[r.key];
      const row = document.createElement('div');
      row.className = 'imp-row';
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = `imp-${r.key}`; cb.disabled = !has; cb.checked = has;
      const txt = document.createElement('span');
      txt.textContent = r.label;
      const sub = document.createElement('small');
      sub.textContent = has ? r.count(parts) : 'not in this file';
      lab.append(cb, txt, sub);
      row.append(lab);
      boxes.set(r.key, cb);
      if (r.modes) {
        const sel = document.createElement('select');
        sel.id = `imp-${r.key}-mode`; sel.setAttribute('aria-label', `${r.label}: replace or add`);
        sel.add(new Option('Add to current', 'add')); sel.add(new Option('Replace current', 'replace'));
        sel.disabled = !cb.checked;
        row.append(sel);
        modes.set(r.key, sel);
      }
      list.append(row);
    }
    const place = document.createElement('fieldset');
    place.className = 'imp-place';
    const legend = document.createElement('legend');
    legend.textContent = 'Place added bricks and entities';
    place.append(legend);
    const radios = (['saved', 'prefab'] as const).map((v) => {
      const lab = document.createElement('label'), r = document.createElement('input');
      r.type = 'radio'; r.name = 'imp-place'; r.value = v; r.id = `imp-place-${v}`; r.checked = v === 'saved';
      lab.append(r, v === 'saved' ? ' At saved position' : ' As a prefab (place it with the mouse)');
      place.append(lab);
      return r;
    });
    const btns = document.createElement('div');
    btns.className = 'imp-buttons';
    const mk = (id: string, text: string, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button'; b.id = id; b.textContent = text; if (cls) b.className = cls;
      return b;
    };
    const ok = mk('imp-ok', 'Import', 'ok'), asNew = mk('imp-new', 'Open as a new world instead'), cancel = mk('imp-cancel', 'Cancel');
    btns.append(ok, asNew, cancel);
    el.append(title, list, place, btns);

    const choice = (): MergeChoice => {
      const c: MergeChoice = {};
      for (const k of ['bricks', 'entities'] as const) if (boxes.get(k)!.checked) c[k] = modes.get(k)!.value as PartMode;
      if (boxes.get('environment')!.checked) c.environment = true;
      if (boxes.get('other')!.checked) c.other = true;
      return c;
    };
    const refresh = (): void => {
      for (const [k, sel] of modes) sel.disabled = !boxes.get(k)!.checked;
      const c = choice();
      place.disabled = !adds(c);
      ok.disabled = !hasChoice(c);
    };
    for (const cb of boxes.values()) cb.addEventListener('change', refresh);
    for (const sel of modes.values()) sel.addEventListener('change', refresh);
    refresh();

    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done({ cancel: true }); }
      else e.stopPropagation();
    };
    const done = (a: Answer): void => {
      if (openDialog?.el !== el) return;
      openDialog = null; el.remove(); removeEventListener('keydown', key, true);
      resolve(a);
    };
    ok.addEventListener('click', () => done({ parts: choice(), placement: radios[1]!.checked ? 'prefab' : 'saved' }));
    asNew.addEventListener('click', () => done({ open: true }));
    cancel.addEventListener('click', () => done({ cancel: true }));
    for (const t of ['pointerdown', 'dblclick', 'wheel']) el.addEventListener(t, (e) => e.stopPropagation());
    addEventListener('keydown', key, true);
    document.body.append(el);
    openDialog = { el, done };
    ok.focus();
  });
}
