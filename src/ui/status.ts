// The status line under "Open save".

let el: HTMLElement | null = null;

export function initStatus(e: HTMLElement): void { el = e; }
export function setStatus(s: string): void { if (el) el.textContent = s; }
export function appendStatus(s: string): void { if (el) el.textContent += s; }
export function statusText(): string { return el?.textContent ?? ''; }
