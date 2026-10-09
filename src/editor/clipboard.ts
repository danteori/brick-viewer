// Ctrl+C copies the focused brick; Ctrl+V either opens a .brz copied in the file manager (Upload)
// or places the copied brick through the ghost (Paste brick). The mode is remembered; the first
// upload switches it to Paste brick once (only while the user hasn't picked one).

import { S } from '../app/state.ts';
import { r3 } from '../core/units.ts';
import type { Brick, V3 } from '../scene/brick.ts';
import { snapBrick } from '../scene/history.ts';
import { itemName, startPlacing } from './ghost.ts';
import { loadString, PASTE_KEY, saveString } from '../app/settings.ts';
import { appendStatus, setStatus, statusText } from '../ui/status.ts';
import { initAudio, playClick } from '../ui/audio.ts';

export const clip = { items: null as Brick[] | null, mode: 'upload' as 'upload' | 'brick', chosen: false };
let pasteBtns: HTMLButtonElement[] = [];

export function initClipboard(buttons: HTMLButtonElement[]): void {
  const v = loadString(PASTE_KEY);
  if (v === 'upload' || v === 'brick') { clip.mode = v; clip.chosen = true; }
  pasteBtns = buttons;
  for (const b of pasteBtns) {
    b.setAttribute('aria-pressed', String(b.dataset.paste === clip.mode));
    b.addEventListener('click', () => {
      setPasteMode(b.dataset.paste as 'upload' | 'brick'); initAudio(); playClick();
      setStatus(clip.mode === 'brick' ? 'Ctrl+V pastes the brick copied with Ctrl+C' : 'Ctrl+V opens a .brz copied in the file manager');
    });
  }
  if (clip.mode === 'brick' && /paste \(Ctrl\+V\)/.test(statusText())) setStatus('drop a .brz here, or use Open');
  S.hooks.loaded.push(() => {
    if (!clip.chosen) { setPasteMode('brick'); appendStatus(' · Ctrl+V now pastes bricks (switch under Open save)'); }
  });
  S.hooks.paste = (e) => {
    if (clip.mode !== 'brick') return false;
    if (clip.items) { e.preventDefault(); startPaste(); return true; }   // keydown normally gets there first
    setStatus('Nothing copied yet: focus a brick and press Ctrl+C');   // a copied .brz file still opens
    return false;
  };
}

export function setPasteMode(m: 'upload' | 'brick'): void {
  clip.mode = m; clip.chosen = true;
  pasteBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.paste === m)));
  saveString(PASTE_KEY, m);
}

export function copyFocused(): void {
  if (!S.bricks[S.sel]) { setStatus('Nothing to copy'); return; }
  const s = snapBrick(S.sel), o = s.lo.slice();
  s.lo = s.lo.map((v, i) => r3(v - o[i])) as V3; s.hi = s.hi.map((v, i) => r3(v - o[i])) as V3;
  clip.items = [s];
  setStatus(`Copied ${itemName(s)}` + (clip.mode === 'brick' ? ' · Ctrl+V to paste' : ' · Ctrl+V uploads: switch it to Paste brick under Open save'));
}

/** Paste the clipboard through the ghost: bricks that would overlap a brick of their grid are dropped. */
export const startPaste = (): void => {
  if (clip.items) startPlacing(clip.items, clip.items.length === 1 ? 'paste brick' : 'paste bricks', 'click', null, { drop: true });
};
