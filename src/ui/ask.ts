// A small in-page confirmation (no window.confirm): a message with an OK and a Cancel button, near
// the top of the page. Esc or Cancel answers false, Enter or OK true. One at a time: asking again
// cancels the open one.

let open: { el: HTMLElement; done: (v: boolean) => void } | null = null;

export function askInPage(message: string, ok = 'OK', cancel = 'Cancel'): Promise<boolean> {
  open?.done(false);
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.id = 'ask'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-label', message);
    const p = document.createElement('p'); p.textContent = message;
    const yes = document.createElement('button'), no = document.createElement('button');
    yes.type = no.type = 'button'; yes.textContent = ok; no.textContent = cancel; yes.className = 'ok';
    const row = document.createElement('div'); row.append(yes, no);
    el.append(p, row);
    for (const t of ['pointerdown', 'dblclick', 'wheel']) el.addEventListener(t, (e) => e.stopPropagation());
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); done(true); }
    };
    const done = (v: boolean): void => {
      if (open?.el !== el) return;
      open = null; el.remove(); removeEventListener('keydown', key, true);
      resolve(v);
    };
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    addEventListener('keydown', key, true);
    document.body.append(el);
    open = { el, done };
    yes.focus();
  });
}
