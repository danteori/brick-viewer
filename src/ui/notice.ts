import { S } from '../app/state.ts';
import { forgetUnknownShapes, onUnknownShape } from '../render/meshes/registry.ts';

const NOTICE_TEXT = '[PLACEHOLDER: unknown shapes notice]';
const CLOSE_LABEL = '[PLACEHOLDER: close]';

let box: HTMLElement | null = null;
let list: HTMLElement | null = null;

function ensureBox(): HTMLElement {
  if (box) return box;
  box = document.createElement('div');
  box.id = 'notice'; box.setAttribute('role', 'alert');
  const text = document.createElement('p'); text.textContent = NOTICE_TEXT;
  list = document.createElement('p'); list.className = 'names';
  const close = document.createElement('button');
  close.textContent = '×'; close.title = CLOSE_LABEL; close.setAttribute('aria-label', CLOSE_LABEL);
  close.addEventListener('click', hideNotice);
  box.append(close, text, list);
  document.body.append(box);
  return box;
}

function hideNotice(): void { box?.remove(); box = null; list = null; }

function addName(asset: string): void {
  ensureBox();
  list!.textContent = list!.textContent ? `${list!.textContent}, ${asset}` : asset;
}

export function initNotice(): void {
  onUnknownShape(addName);
  S.hooks.beforeLoad.push(() => { hideNotice(); forgetUnknownShapes(); });
}
