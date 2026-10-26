import { $ } from './dom.ts';
import { initAudio, playClick } from './audio.ts';

interface Entry { isOpen: () => boolean; close: () => void }

const own = new Map<string, HTMLElement>();
const panels: Entry[] = [];
const order: string[] = [];
const listeners: ((id: string, open: boolean) => void)[] = [];

/** Wires a window in the page markup: its close button, and no scene input from inside it. */
export function initWindow(id: string): HTMLElement {
  const el = $(id);
  own.set(id, el);
  for (const t of ['pointerdown', 'dblclick', 'wheel', 'contextmenu']) el.addEventListener(t, (e) => e.stopPropagation());
  el.querySelector('.winclose')?.addEventListener('click', () => { closeWindow(id); initAudio(); playClick(); });
  return el;
}

/** A floating panel Esc closes, like a window. */
export function registerPanel(isOpen: () => boolean, close: () => void): void { panels.push({ isOpen, close }); }

export function onWindowChange(f: (id: string, open: boolean) => void): void { listeners.push(f); }

export const isOpen = (id: string): boolean => !!own.get(id) && !own.get(id)!.hidden;

export function openWindow(id: string): void {
  const el = own.get(id);
  if (!el || !el.hidden) return;
  el.hidden = false;
  order.push(id);
  for (const f of listeners) f(id, true);
}

export function closeWindow(id: string): void {
  const el = own.get(id);
  if (!el || el.hidden) return;
  el.hidden = true;
  order.splice(order.indexOf(id), 1);
  if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  for (const f of listeners) f(id, false);
}

export function toggleWindow(id: string): void { if (isOpen(id)) closeWindow(id); else openWindow(id); }

export const anyOpen = (): boolean => order.length > 0 || panels.some((p) => p.isOpen());

/** Closes the newest window, else an open floating panel. False when nothing was open. */
export function closeTop(): boolean {
  const id = order[order.length - 1];
  if (id) { closeWindow(id); return true; }
  const p = panels.find((q) => q.isOpen());
  if (p) { p.close(); return true; }
  return false;
}

/** The open windows, oldest first (test hook). */
export const openWindows = (): string[] => order.slice();
