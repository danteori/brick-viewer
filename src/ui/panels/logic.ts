// The live logic (backlog C-13): the evaluator runs from the render loop for as long as a save has
// components, rebuilt after every component or wire edit (logic/live.ts). The Logic row in the Esc menu
// has Pause, Step (one tick), the tick rate and Interact (I). While Interact is on, a click on a switch
// flips it and a click on a button presses it; a click on any other brick selects as usual. The live
// state is not saved: the save keeps the switch values it was opened with. A text display with a wired
// Text input shows its value in a plain label over the brick's top face (first slice; the game draws it
// on the face).

import { $ } from '../dom.ts';
import { S } from '../../app/state.ts';
import { hiddenPickable } from '../../app/hidden.ts';
import { BRZ_UNIT } from '../../core/units.ts';
import { camSignature, toView } from '../../render/camera.ts';
import { cursorRay } from '../../editor/ghost.ts';
import { isTyping } from '../../editor/input.ts';
import { pickRay } from '../../scene/spatial.ts';
import { brickKey } from '../../scene/components.ts';
import { componentsOf, type SceneComponents } from '../../scene/compmodel.ts';
import { LiveLogic, TPS_PRESETS } from '../../logic/live.ts';
import type { LogicNode } from '../../logic/graph.ts';
import { initAudio, playClick } from '../audio.ts';
import { placeholder } from '../placeholder.ts';
import { setStatus } from '../status.ts';

export const live = new LiveLogic();
export const interact = { on: false };

const MAX_LABELS = 200, MAX_FRAME_MS = 250;
const T = {
  group: placeholder('Logic'),
  pause: placeholder('Pause'),
  resume: placeholder('Resume'),
  step: placeholder('Step'),
  rate: placeholder('Ticks per second'),
  interact: placeholder('Interact (I)'),
  pauseTitle: placeholder('Pause or resume the wire logic'),
  stepTitle: placeholder('Run one logic tick'),
  rateTitle: placeholder('Logic ticks per second (the game runs 60)'),
  interactTitle: placeholder('Interact: click a switch to flip it, click a button to press it. Other clicks select as usual (I)'),
  on: placeholder('Interact on: click a switch or a button'),
  off: placeholder('Interact off'),
  flipped: placeholder('Switch flipped'),
  pressed: placeholder('Button pressed'),
};

let pauseBtn: HTMLButtonElement, interactBtn: HTMLButtonElement, tpsSel: HTMLSelectElement, layer: HTMLElement, canvas: HTMLElement;
let lastT = 0, shownKey = '';

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

export function setInteract(on: boolean): void {
  interact.on = on;
  interactBtn.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('interacting', on);
  setStatus(on ? T.on : T.off);
}

export function initLogicPanel(): void {
  canvas = $('c');
  const box = document.createElement('div');
  box.id = 'logicbox'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', T.group);
  box.append(T.group);
  pauseBtn = button('logicpause', T.pause, T.pauseTitle);
  pauseBtn.setAttribute('aria-pressed', 'false');
  const step = button('logicstep', T.step, T.stepTitle);
  tpsSel = document.createElement('select');
  tpsSel.id = 'logictps'; tpsSel.title = T.rateTitle; tpsSel.setAttribute('aria-label', T.rate);
  for (const n of TPS_PRESETS) tpsSel.append(new Option(String(n), String(n)));
  tpsSel.value = String(live.clock.tps);
  interactBtn = button('logicinteract', T.interact, T.interactTitle);
  interactBtn.setAttribute('aria-pressed', 'false');
  box.append(pauseBtn, step, tpsSel, interactBtn);
  $('viewbox').after(box);
  for (const t of ['pointerdown', 'dblclick']) box.addEventListener(t, (e) => e.stopPropagation());

  layer = document.createElement('div');
  layer.id = 'logictext';
  $('ov').after(layer);

  pauseBtn.addEventListener('click', () => { setPaused(!live.clock.paused); initAudio(); playClick(); });
  step.addEventListener('click', () => { live.step(); shownKey = ''; initAudio(); playClick(); });
  tpsSel.addEventListener('change', () => setTps(+tpsSel.value));
  interactBtn.addEventListener('click', () => { setInteract(!interact.on); initAudio(); playClick(); });
  addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.key === 'i' || e.key === 'I') { e.preventDefault(); setInteract(!interact.on); initAudio(); playClick(); }
  });
  addEventListener('pointerdown', onPointerDown, true);
  S.hooks.loaded.push(() => { shownKey = ''; });
}

function nodeAtRow(m: SceneComponents, row: number): LogicNode | null {
  const ref = m.refOfRow(row);
  if (!ref || !live.graph) return null;
  for (const inst of m.store.onBrick(ref)) {
    const n = live.graph.find(ref, inst.type);
    if (n && (n.kind === 'switch' || n.kind === 'button')) return n;
  }
  return null;
}

function onPointerDown(e: PointerEvent): void {
  if (!interact.on || e.button !== 0 || e.target !== canvas) return;
  const m = componentsOf(S.scene), r = cursorRay(e.clientX, e.clientY);
  if (!m || !r) return;
  live.sync(m);
  const hit = pickRay(r.vx, r.vy), node = hit ? nodeAtRow(m, hit.k) : null;
  if (!node || !live.interact(node)) return;
  e.stopImmediatePropagation(); e.preventDefault();
  initAudio(); playClick();
  setStatus(node.kind === 'switch' ? T.flipped : T.pressed);
  shownKey = '';
}

/** Call each frame, after the render: syncs the logic with the scene, runs the due ticks and draws the display texts. */
export function tickLogic(t: number, sx: number, sy: number): void {
  const m = componentsOf(S.scene);
  live.sync(m);
  const dt = lastT ? Math.min(t - lastT, MAX_FRAME_MS) : 0;
  lastT = t;
  if (live.advance(dt)) shownKey = '';
  drawTexts(m, sx, sy);
}

function drawTexts(m: SceneComponents | null, sx: number, sy: number): void {
  const shown = m ? live.shownTexts().slice(0, MAX_LABELS) : [];
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const key = shown.length ? [camSignature(), cw, ch, S.scene.rev, S.hidden.size, ...shown.map((s) => s.text)].join('|') : '';
  if (key === shownKey) return;
  shownKey = key;
  if (!shown.length) { layer.replaceChildren(); return; }
  const { cam } = S, bx = new Array<number>(6), els: HTMLElement[] = [];
  for (const { node, text } of shown) {
    const row = m!.rowOfRef(node.brick);
    if (row < 0 || !S.scene.alive(row) || S.hidden.has(row) || !hiddenPickable(row)) continue;
    S.scene.box(row, bx);
    const v = toView((bx[0]! + bx[3]!) / 2 * BRZ_UNIT, (bx[1]! + bx[4]!) / 2 * BRZ_UNIT, bx[5]! * BRZ_UNIT);
    const x = ((v[0] - cam.x) * sx + 1) * cw / 2, y = (1 - (v[1] - cam.y) * sy) * ch / 2;
    if (x < -100 || y < -40 || x > cw + 100 || y > ch + 40) continue;
    const el = document.createElement('div');
    el.className = 'logictext'; el.textContent = text; el.dataset.brick = brickKey(node.brick);
    el.style.left = `${x.toFixed(1)}px`; el.style.top = `${y.toFixed(1)}px`;
    els.push(el);
  }
  layer.replaceChildren(...els);
}
