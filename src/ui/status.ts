// The status line under "Open save".

let el: HTMLElement | null = null;

export function initStatus(e: HTMLElement): void { el = e; }
export function setStatus(s: string): void { if (el) el.textContent = s; }
export function appendStatus(s: string): void { if (el) el.textContent += s; }
export function statusText(): string { return el?.textContent ?? ''; }

let bar: HTMLProgressElement | null = null;
/** A progress bar under the status line: 0-1, or null to hide it (indeterminate while the total is unknown: pass NaN). */
export function setProgress(f: number | null): void {
  if (!el) return;
  if (f === null) { bar?.remove(); bar = null; return; }
  if (!bar) { bar = document.createElement('progress'); bar.id = 'loadbar'; bar.max = 1; el.after(bar); }
  if (Number.isFinite(f)) bar.value = f; else bar.removeAttribute('value');
}