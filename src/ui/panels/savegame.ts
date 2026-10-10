// Saving into the game's prefab folder (backlog U-22), and saving just the selection.
//
//   Save selection   downloads the selection (or the focused brick) as a .brz of its own
//   Save to game     writes the selection, or the whole build when nothing is selected, as a .brz
//                    with a timestamped name straight into a folder the user picked once: the
//                    game's Saved\Prefabs or a folder in it, so it shows in the in-game prefab menu.
//                    "Folder" picks another one.
//
// Save to game uses the File System Access API (showDirectoryPicker: Chrome and Edge); where it's
// missing the two buttons aren't added. The picked folder's handle is remembered in IndexedDB (the
// browser keeps it per site); any failure there just means picking again. Nothing is uploaded.

import { S } from '../../app/state.ts';
import { ensureLoadedFiles, loadedName } from '../../scene/load.ts';
import { download, partFiles, sceneBrz } from '../../scene/save.ts';
import { writeBrz } from '../../format/brz.ts';
import { effectiveIds } from '../../editor/select.ts';
import { initAudio, playClick } from '../audio.ts';
import { setStatus } from '../status.ts';
import { $ } from '../dom.ts';

// --- the File System Access bits this module uses (not in every TS DOM lib) ---------------------------
interface Writable { write(data: Uint8Array): Promise<void>; close(): Promise<void> }
interface FileHandle { createWritable(): Promise<Writable> }
interface DirHandle {
  name: string;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandle>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
}
type Picker = (o?: { id?: string; mode?: 'readwrite'; startIn?: string }) => Promise<DirHandle>;
const picker = (): Picker | undefined => (globalThis as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;

/** Can this browser write into a picked folder? */
export const canSaveToGame = (): boolean => typeof picker() === 'function' && typeof indexedDB !== 'undefined';

// --- the remembered folder (IndexedDB; every failure means "not remembered") --------------------------
const DB = 'brickViewer', STORE = 'handles', KEY = 'gamePrefabs';

function db(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}
async function loadDir(): Promise<DirHandle | null> {
  try {
    const d = await db();
    if (!d) return null;
    return await new Promise((res) => {
      const q = d.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      q.onsuccess = () => res((q.result as DirHandle | undefined) ?? null);
      q.onerror = () => res(null);
    });
  } catch { return null; }
}
async function storeDir(h: DirHandle): Promise<void> {
  try {
    const d = await db();
    if (!d) return;
    await new Promise<void>((res) => {
      const t = d.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(h, KEY);
      t.oncomplete = t.onerror = t.onabort = () => res();
    });
  } catch { /* not remembered: the next save asks again */ }
}

async function writable(h: DirHandle): Promise<boolean> {
  try {
    if (!h.queryPermission) return true;
    if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch { return false; }
}

// --- names and bytes --------------------------------------------------------------------------------
const pad = (n: number): string => String(n).padStart(2, '0');
/** "castle 2026-10-10 04-31-07.brz" (no colons: Windows file names). */
export function stampedName(base: string, d = new Date()): string {
  const b = (base.replace(/\.(brz|brdb)$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'build');
  return `${b} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.brz`;
}

const plural = (n: number): string => `${n} brick${n === 1 ? '' : 's'}`;

/** The selection's .brz (null: nothing to save / no save opened; the status says why). */
async function selectionBytes(ids: readonly number[]): Promise<{ bytes: Uint8Array; warnings: string[] } | null> {
  if (!ids.length) { setStatus('Nothing selected: select bricks (or focus one) to save them'); return null; }
  await ensureLoadedFiles();
  const r = partFiles(ids);
  if (!r) { setStatus('Open a save first: the selection is written into the save you opened'); return null; }
  return { bytes: writeBrz(r.files), warnings: r.warnings };
}

async function saveSelectionClick(): Promise<void> {
  try {
    const ids = effectiveIds(), r = await selectionBytes(ids);
    if (!r) return;
    const name = (loadedName.replace(/\.(brz|brdb)$/i, '') || 'save') + ' (selection).brz';
    download(r.bytes, name);
    setStatus(`Saved ${name} (${plural(ids.length)})` + (r.warnings.length ? ' · ' + r.warnings.join(' · ') : ''));
  } catch (err) { setStatus(`Couldn't save: ${(err as Error).message}`); console.error(err); }
}

const HINT = 'Pick the game\'s prefab folder once: %LOCALAPPDATA%\\Brickadia\\Saved\\Prefabs, or a folder in it such as PROJECT WORK';

async function saveToGameClick(repick: boolean): Promise<void> {
  const pick = picker();
  if (!pick) return;
  try {
    // the folder first: the picker and the permission prompt need the click's user activation
    let dir = repick ? null : await loadDir();
    if (dir && !(await writable(dir))) dir = null;
    if (!dir) {
      setStatus(HINT);
      dir = await pick({ id: 'brickadia-prefabs', mode: 'readwrite', startIn: 'documents' });
      await storeDir(dir);
    }
    if (repick) { setStatus(`Save to game writes into "${dir.name}" from now on`); initAudio(); playClick(); return; }
    const sel = S.selection.size > 0, ids = effectiveIds();
    let r: { bytes: Uint8Array; warnings: string[] } | null;
    if (sel) r = await selectionBytes(ids);
    else {
      await ensureLoadedFiles();
      r = sceneBrz();
      if (!r) { setStatus('Open a save first: Save to game writes your build into the save you opened'); return; }
    }
    if (!r) return;
    const name = stampedName(loadedName.replace(/\.(brz|brdb)$/i, '') + (sel ? ' selection' : ''));
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(r.bytes);
    await w.close();
    initAudio(); playClick();
    setStatus(`Saved ${name} (${plural(sel ? ids.length : S.scene.count)}) into "${dir.name}": load it from the game's prefab menu` + (r.warnings.length ? ' · ' + r.warnings.join(' · ') : ''));
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') { setStatus('Save to game cancelled'); return; }
    setStatus(`Couldn't save to the game folder: ${e.message}`); console.error(err);
  }
}

export function initSaveGame(): void {
  const row = $('saverow');
  const add = (id: string, text: string, title: string, f: () => void): void => {
    const b = document.createElement('button');
    b.type = 'button'; b.id = id; b.textContent = text; b.title = title;
    b.addEventListener('click', f);
    row.append(b);
  };
  add('savesel', 'Save selection', 'Download the selection (or the focused brick) as a .brz of its own', () => { void saveSelectionClick(); });
  if (!canSaveToGame()) return;
  add('savegame', 'Save to game', 'Write the selection, or the whole build, as a .brz into the game\'s prefab folder (picked once) so it shows in the in-game prefab menu', () => { void saveToGameClick(false); });
  add('gamefolder', 'Folder…', 'Pick the folder Save to game writes into (the game\'s Saved\\Prefabs, or a folder in it)', () => { void saveToGameClick(true); });
}
