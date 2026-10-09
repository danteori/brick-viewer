// Opening files (button, drag-and-drop, Ctrl+V), the lighting preset picker (with .bp environment
// presets added on the fly) and the "Undo steps" box. Saves are read locally; nothing is uploaded.

import { S } from '../../app/state.ts';
import { lightFromBp } from '../../format/bp.ts';
import { LIGHTING, type LightPreset } from '../../render/lighting.ts';
import { ensureLoadedFiles, loadedName, loadSave } from '../../scene/load.ts';
import { download, savedName, sceneBrz } from '../../scene/save.ts';
import { hist, setUndoLimit } from '../../scene/history.ts';
import { initAudio, playClick } from '../audio.ts';
import { setStatus } from '../status.ts';
import { $ } from '../dom.ts';

let lightSel: HTMLSelectElement;

/**
 * Extra file openers (the full build adds .brdb worlds). Each returns true when it took the file;
 * it reports its own errors.
 */
export const openers: ((f: File) => Promise<boolean>)[] = [];
let openersReady: Promise<unknown> = Promise.resolve();
/** Files opened before the full UI has loaded wait for its openers. */
export function waitForOpeners(p: Promise<unknown>): void { openersReady = p.catch(() => undefined); }

export async function openFile(f: File): Promise<void> {
  await openersReady;
  for (const o of openers) if (await o(f)) return;
  if (/\.(bp|json)$/i.test(f.name)) {
    try { addBpPreset(JSON.parse(await f.text()), f.name); } catch (err) { setStatus(`Couldn't read ${f.name}: ${(err as Error).message}`); console.error(err); }
    return;
  }
  try { loadSave(await f.arrayBuffer(), f.name); initAudio(); playClick(); }
  catch (err) { setStatus(`Couldn't open ${f.name}: ${(err as Error).message}`); console.error(err); }
}

export function setPreset(k: string): void { S.lighting = k; if (lightSel) lightSel.value = k; }

export function addBpPreset(json: unknown, name = 'Pasted environment'): void {
  const p = lightFromBp(json), label = name.replace(/\.(bp|json)$/i, '') + ' (.bp)';
  useLighting('bp:' + label, { name: label, ...p });
  setStatus(`Lighting: ${label}`);
}

/** Adds (or replaces) a lighting preset, lists it in the picker and selects it. */
export function useLighting(k: string, p: LightPreset): void {
  LIGHTING[k] = p;
  const opt = [...lightSel.options].find((o) => o.value === k);
  if (opt) opt.text = p.name; else lightSel.add(new Option(p.name, k));
  lightSel.value = S.lighting = k;
}

export function initFilePanel(): void {
  const pickEl = $<HTMLInputElement>('pick');
  $('open').addEventListener('click', () => pickEl.click());
  for (const t of ['pointerdown', 'dblclick']) $('file').addEventListener(t, (e) => e.stopPropagation());   // not a drag
  pickEl.addEventListener('change', () => { if (pickEl.files?.[0]) void openFile(pickEl.files[0]); pickEl.value = ''; });
  addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
  addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drop'); });
  addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('drop');
    const files = [...(e.dataTransfer?.files || [])];
    const f = files.find((f) => /\.(brz|brdb|bp)$/i.test(f.name)) || files[0];
    if (f) void openFile(f);
  });

  $('savebrz').addEventListener('click', () => { void saveBrzClick(); });

  // lighting preset picker (fills from LIGHTING, so new presets just appear)
  lightSel = $<HTMLSelectElement>('light');
  for (const [k, p] of Object.entries(LIGHTING)) lightSel.add(new Option(p.name, k, false, k === S.lighting));
  lightSel.addEventListener('change', () => { S.lighting = lightSel.value; });
  for (const t of ['pointerdown', 'dblclick']) $('lightbox').addEventListener(t, (e) => e.stopPropagation());

  // undo steps
  const inp = $<HTMLInputElement>('undolim');
  inp.value = String(hist.limit);
  for (const t of ['pointerdown', 'dblclick']) $('undobox').addEventListener(t, (e) => e.stopPropagation());
  inp.addEventListener('change', () => { setUndoLimit(parseInt(inp.value, 10)); inp.value = String(hist.limit); });

  // Ctrl+V / Cmd+V: paste a .brz copied in the file manager (browsers only expose real files on the
  // clipboard, never a path's contents), an environment preset as JSON text, or a brick (editor).
  document.addEventListener('paste', (e) => {
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    if (S.hooks.paste(e)) return;
    const files = [...(e.clipboardData?.files || [])];
    const f = files.find((f) => /\.brz$/i.test(f.name)) || files[0];
    if (f) { e.preventDefault(); void openFile(f); return; }
    const raw = (e.clipboardData?.getData('text/plain') || '').trim();
    if (raw.startsWith('{')) {
      try { addBpPreset(JSON.parse(raw)); e.preventDefault(); return; } catch (err) { setStatus(`Pasted text isn't an environment preset: ${(err as Error).message}`); return; }
    }
    const text = raw.replace(/^["']|["']$/g, '');
    if (/\.brz$/i.test(text)) setStatus("Can't open file paths from the clipboard — copy the .brz file itself (e.g. in Explorer) and paste again");
  });
}

/** "Save .brz": the scene rebuilt into the save it was opened from, as a raw (uncompressed) .brz. */
async function saveBrzClick(): Promise<void> {
  try {
    await ensureLoadedFiles();                 // a lazily read world: the template needs every file
    const r = sceneBrz();
    if (!r) { setStatus('Open a save first: Save .brz writes your edits back into the save you opened'); return; }
    const name = savedName(loadedName, '.brz');
    download(r.bytes, name);
    setStatus(`Saved ${name} (${S.scene.count} brick${S.scene.count === 1 ? '' : 's'})` + (r.warnings.length ? ' · ' + r.warnings.join(' · ') : ''));
  } catch (err) { setStatus(`Couldn't save: ${(err as Error).message}`); console.error(err); }
}
