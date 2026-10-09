// localStorage keys and safe accessors (storage can be blocked or throw; the app works without it).

export const UNDO_KEY = 'brickViewer.undoSteps';
export const PASTE_KEY = 'brickViewer.pasteMode';

export function loadString(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function loadNumber(key: string): number {
  const v = loadString(key);
  return v === null ? NaN : parseInt(v, 10);
}

export function saveString(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}
