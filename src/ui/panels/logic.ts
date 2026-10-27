import { $ } from '../dom.ts';
import { S } from '../../app/state.ts';
import { hiddenPickable } from '../../app/hidden.ts';
import { rightDragged } from '../../app/explore.ts';
import { BRZ_UNIT } from '../../core/units.ts';
import { camSignature, toView } from '../../render/camera.ts';
import { cursorRay, ed } from '../../editor/ghost.ts';
import { isTyping } from '../../editor/input.ts';
import { pickRay } from '../../scene/spatial.ts';
import { brickKey } from '../../scene/components.ts';
import { componentsOf, type SceneComponents } from '../../scene/compmodel.ts';
import { LiveLogic, TPS_PRESETS } from '../../logic/live.ts';
import type { LogicNode } from '../../logic/graph.ts';
import { interactableOf, type Interactable } from '../../logic/interact.ts';
import { initAudio, playClick } from '../audio.ts';
import { placeholder } from '../placeholder.ts';

export const live = new LiveLogic();

const MAX_LABELS = 200, MAX_FRAME_MS = 250;
const T = {
  group: placeholder('Logic'),
  pause: placeholder('Pause'),
  resume: placeholder('Resume'),
  step: placeholder('Step'),
  rate: placeholder('Ticks per second'),
  pauseTitle: placeholder('Pause or resume the wire logic'),
  stepTitle: placeholder('Run one logic tick'),
  rateTitle: placeholder('Logic ticks per second (the game runs 60)'),
  interact: 'Interact',
  interactTitle: placeholder('Interact with the selected brick (E on a hovered brick)'),
};

interface Target { row: number; node: LogicNode | null; item: Interactable }

let pauseBtn: HTMLButtonElement, tpsSel: HTMLSelectElement, bar: HTMLElement, layer: HTMLElement, canvas: HTMLElement;
let prompt: HTMLElement, promptText: HTMLElement, interactBtn: HTMLButtonElement;
let lastT = 0, shownKey = '', promptKey = '', btnKey = '';
let heldByKey: LogicNode | null = null;
let promptShown: string | null = null;

export const shownPrompt = (): string | null => promptShown;

function button(id: string, text: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.id = id; b.title = title; b.textContent = text;
  return b;
}

export function setPaused(on: boolean): void {
  if (on) live.clock.pause(); else live.clock.resume();
  pauseBtn.textContent = on ? T.resume : T.pause;
  pauseBtn.setAttribute('aria-pressed', String(on));
}

export function setTps(tps: number): void {
  live.clock.setTps(tps);
  tpsSel.value = String(tps);
}

const KEY_ICON = '<span class="keyicon" aria-hidden="true">E</span>';

export function initLogicPanel(): void {
  canvas = $('c');
  bar = document.createElement('div');
  bar.id = 'logicbar'; bar.hidden = true; bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', T.group);
  bar.append(T.group);
  pauseBtn = button('logicpause', T.pause, T.pauseTitle);
  pauseBtn.setAttribute('aria-pressed', 'false');
  const step = button('logicstep', T.step, T.stepTitle);
  tpsSel = document.createElement('select');
  tpsSel.id = 'logictps'; tpsSel.title = T.rateTitle; tpsSel.setAttribute('aria-label', T.rate);
  for (const n of TPS_PRESETS) tpsSel.append(new Option(String(n), String(n)));
  tpsSel.value = String(live.clock.tps);
  bar.append(pauseBtn, step, tpsSel);
  $('ov').after(bar);
  for (const t of ['pointerdown', 'dblclick', 'wheel']) bar.addEventListener(t, (e) => e.stopPropagation());

  layer = document.createElement('div');
  layer.id = 'logictext';
  bar.after(layer);

  prompt = document.createElement('div');
  prompt.id = 'interactprompt'; prompt.hidden = true;
  prompt.innerHTML = KEY_ICON;
  promptText = document.createElement('span');
  promptText.className = 'prompttext';
  prompt.append(promptText);
  layer.after(prompt);

  interactBtn = button('interactbtn', T.interact, T.interactTitle);
  interactBtn.hidden = true;
  $('comptoggle').before(interactBtn);

  pauseBtn.addEventListener('click', () => { setPaused(!live.clock.paused); initAudio(); playClick(); });
  step.addEventListener('click', () => { live.step(); shownKey = ''; initAudio(); playClick(); });
  tpsSel.addEventListener('change', () => setTps(+tpsSel.value));
  interactBtn.addEventListener('click', onInteractButton);
  addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat || (e.key !== 'e' && e.key !== 'E')) return;
    const t = hoveredTarget();
    if (!t) return;
    e.preventDefault();
    if (t.node?.kind === 'button') { live.ev?.setHeld(t.node, true); heldByKey = t.node; initAudio(); playClick(); }
    else activate(t);
  });
  addEventListener('keyup', (e) => { if (e.key === 'e' || e.key === 'E') releaseKey(); });
  addEventListener('blur', releaseKey);
  addEventListener('pointerup', onPointerUp);
  S.hooks.loaded.push(() => { shownKey = ''; promptKey = ''; btnKey = ''; releaseKey(); });
}

function releaseKey(): void {
  if (heldByKey) live.ev?.setHeld(heldByKey, false);
  heldByKey = null;
}

function targetAtRow(m: SceneComponents, row: number): Target | null {
  const ref = m.refOfRow(row);
  if (!ref) return null;
  const item = interactableOf(m.store.onBrick(ref));
  if (!item || !item.enabled) return null;
  return { row, node: live.graph?.find(ref, item.type) ?? null, item };
}

function hoveredTarget(): Target | null {
  const m = componentsOf(S.scene), k = S.hoverBrick;
  if (!m || k < 0 || !S.scene.alive(k) || S.hidden.has(k) || !hiddenPickable(k)) return null;
  live.sync(m);
  return targetAtRow(m, k);
}

function activate(t: Target): void {
  if (t.node && live.interact(t.node)) shownKey = '';
  initAudio(); playClick();
}

function nothingInHand(): boolean {
  return !S.held && !ed.ghost && !S.hooks.placing() && S.tool !== 'paint';
}

function onPointerUp(e: PointerEvent): void {
  if (e.button !== 2 || e.target !== canvas || rightDragged() || !nothingInHand()) return;
  const m = componentsOf(S.scene), r = cursorRay(e.clientX, e.clientY);
  if (!m || !r) return;
  live.sync(m);
  const hit = pickRay(r.vx, r.vy);
  if (!hit || !S.scene.alive(hit.k) || S.hidden.has(hit.k) || !hiddenPickable(hit.k)) return;
  const t = targetAtRow(m, hit.k);
  if (t) activate(t);
}

function onInteractButton(): void {
  const m = componentsOf(S.scene);
  if (!m) return;
  live.sync(m);
  const t = targetAtRow(m, S.sel);
  if (t) activate(t);
}

/** Call each frame, after the render: syncs the logic with the scene, runs the due ticks and draws the bar, the prompt and the display texts. */
export function tickLogic(t: number, sx: number, sy: number): void {
  const m = componentsOf(S.scene);
  live.sync(m);
  const dt = lastT ? Math.min(t - lastT, MAX_FRAME_MS) : 0;
  lastT = t;
  if (live.advance(dt)) shownKey = '';
  const logic = hasLogic();
  if (bar.hidden === logic) bar.hidden = !logic;
  drawTexts(m, sx, sy);
  drawPrompt(m, sx, sy);
  updateInteractButton(m);
}

function hasLogic(): boolean {
  const g = live.graph;
  return !!g && [...g.nodes.values()].some((n) => n.kind !== 'other');
}

function project(row: number, sx: number, sy: number): [number, number] {
  const bx = new Array<number>(6);
  S.scene.box(row, bx);
  const { cam } = S, cw = canvas.clientWidth, ch = canvas.clientHeight;
  const v = toView((bx[0]! + bx[3]!) / 2 * BRZ_UNIT, (bx[1]! + bx[4]!) / 2 * BRZ_UNIT, bx[5]! * BRZ_UNIT);
  return [((v[0] - cam.x) * sx + 1) * cw / 2, (1 - (v[1] - cam.y) * sy) * ch / 2];
}

function drawPrompt(m: SceneComponents | null, sx: number, sy: number): void {
  const target = m && !S.noOverlay ? hoveredTarget() : null;
  if (!target || !target.item.prompt) {
    if (!prompt.hidden) prompt.hidden = true;
    promptShown = null; promptKey = '';
    return;
  }
  const at = project(target.row, sx, sy), label = target.item.label;
  const key = `${label}|${at[0].toFixed(1)}|${at[1].toFixed(1)}`;
  promptShown = label;
  if (key === promptKey && !prompt.hidden) return;
  promptKey = key;
  if (promptText.textContent !== label) promptText.textContent = label;
  prompt.style.left = `${at[0].toFixed(1)}px`; prompt.style.top = `${at[1].toFixed(1)}px`;
  prompt.hidden = false;
}

function updateInteractButton(m: SceneComponents | null): void {
  const key = `${S.sel}|${m?.version ?? -1}|${S.scene.rev}`;
  if (key === btnKey) return;
  btnKey = key;
  interactBtn.hidden = !(m && S.sel >= 0 && S.scene.alive(S.sel) && targetAtRow(m, S.sel));
}

function drawTexts(m: SceneComponents | null, sx: number, sy: number): void {
  const shown = m ? live.shownTexts().slice(0, MAX_LABELS) : [];
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const key = shown.length ? [camSignature(), cw, ch, S.scene.rev, S.hidden.size, ...shown.map((s) => s.text)].join('|') : '';
  if (key === shownKey) return;
  shownKey = key;
  if (!shown.length) { layer.replaceChildren(); return; }
  const els: HTMLElement[] = [];
  for (const { node, text } of shown) {
    const row = m!.rowOfRef(node.brick);
    if (row < 0 || !S.scene.alive(row) || S.hidden.has(row) || !hiddenPickable(row)) continue;
    const [x, y] = project(row, sx, sy);
    if (x < -100 || y < -40 || x > cw + 100 || y > ch + 40) continue;
    const el = document.createElement('div');
    el.className = 'logictext'; el.textContent = text; el.dataset.brick = brickKey(node.brick);
    el.style.left = `${x.toFixed(1)}px`; el.style.top = `${y.toFixed(1)}px`;
    els.push(el);
  }
  layer.replaceChildren(...els);
}
