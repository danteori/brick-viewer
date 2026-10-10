// The wire view (backlog C-03): a toggle (View > Wires, or W) that draws every wire of the opened
// save as a curve between port dots on its bricks, coloured by the kind of value it carries where
// that's known (the target's field of the port's name). It doubles as a Connector: click an output
// port, then an input port, to add a wire (checked with the game's rules: no fan-in, chip
// boundaries; wires straight into a gate inside a chip are fine). Click a wire and press Delete to
// remove it. Each is one undo step.
//
// Port dots: a brick's ports are spread over its top face, inputs on a row toward -Y and outputs
// toward +Y (our own placement: the game draws ports on the gate meshes, which we don't have).
// Hovering a dot names the port. A wire whose other end isn't in the scene (another grid, a brick
// type the viewer can't draw) is drawn as a short stub. Nothing is drawn while the view is off, so
// renders and goldens don't change.

import { S } from '../../app/state.ts';
import { BRZ_UNIT } from '../../core/units.ts';
import { camSignature, toView } from '../../render/camera.ts';
import { brickKey, type BrickRef } from '../../scene/components.ts';
import { componentsOf, onComponentsChange, shortType, type PortInfo, type PortKind, type SceneComponents } from '../../scene/compmodel.ts';
import type { Wire, WireEnd } from '../../scene/wires.ts';
import { isTyping } from '../../editor/input.ts';
import { initAudio, playClick, playError, playSelect } from '../audio.ts';
import { setStatus } from '../status.ts';

/** Wire colour per value kind. */
export const KIND_COLOUR: Record<PortKind, string> = {
  bool: '#ff6b6b', number: '#4dabf7', vector: '#ffd43b', colour: '#f783ac', string: '#69db7c', exec: '#f8f9fa', other: '#adb5bd',
};
const MAX_BRICKS = 600, MAX_WIRES = 3000, STUB = 34;

interface PortDot { row: number; ref: BrickRef; comp: string; port: PortInfo; x: number; y: number }

export const wireView = {
  on: false,
  /** the output port a new wire starts from */
  from: null as PortDot | null,
  /** the selected wire, by its ends (wire objects are re-created by undo) */
  selected: null as { s: WireEnd; t: WireEnd } | null,
  /** refused wire attempts so far and the last reason (tests read them) */
  refused: { n: 0, reason: '' },
  drawn: { wires: 0, ports: 0 },
};

let svg: SVGSVGElement, label: HTMLElement, btn: HTMLButtonElement, canvas: HTMLCanvasElement;
let shownKey = '', dots: PortDot[] = [], wires: Wire[] = [];

const endOf = (d: PortDot): WireEnd => ({ ...d.ref, chunk: { ...d.ref.chunk }, component: d.comp, port: d.port.name });
const endKey = (e: WireEnd): string => `${brickKey(e)}/${e.component}/${e.port}`;
const portName = (comp: string, port: string): string => `${shortType(comp)}.${port}`;

export function initWires(c: HTMLCanvasElement): void {
  canvas = c;
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'wires';
  svg.setAttribute('aria-label', 'Wires');
  document.getElementById('ov')!.after(svg);
  label = document.createElement('div');
  label.id = 'wirelabel'; label.hidden = true;
  document.body.append(label);
  btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'wiresbtn'; btn.setAttribute('aria-pressed', 'false');
  btn.title = 'Wires (W): draw the save\'s wires between port dots; click an output dot, then an input dot, to connect them; click a wire and press Delete to remove it';
  btn.textContent = 'Wires (W)';
  document.getElementById('xray')!.after(btn);
  btn.addEventListener('click', () => { setWireView(!wireView.on); initAudio(); playClick(); });
  addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === 'w' || e.key === 'W') && !e.repeat) { e.preventDefault(); setWireView(!wireView.on); return; }
    if (!wireView.on) return;
    if (e.key === 'Escape' && (wireView.from || wireView.selected)) {
      e.preventDefault(); e.stopImmediatePropagation();
      wireView.from = null; wireView.selected = null; shownKey = '';
      setStatus('Wire view: nothing picked');
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && wireView.selected) {
      e.preventDefault(); e.stopImmediatePropagation();
      deleteSelectedWire();
    }
  }, true);
  for (const t of ['pointerdown', 'dblclick', 'wheel'] as const) svg.addEventListener(t, (e) => { if ((e.target as Element) !== svg) e.stopPropagation(); });
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointerover', (e) => showLabel(e.target as Element));
  svg.addEventListener('pointerout', () => { label.hidden = true; });
  onComponentsChange(() => { shownKey = ''; });
  S.hooks.loaded.push(() => { wireView.from = null; wireView.selected = null; shownKey = ''; });
}

export function setWireView(on: boolean): void {
  wireView.on = on; wireView.from = null; wireView.selected = null; shownKey = '';
  btn.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('wiring', on);
  if (!on) { svg.replaceChildren(); label.hidden = true; setStatus('Wires hidden'); return; }
  const m = componentsOf(S.scene);
  setStatus(!m || m.empty ? 'Wires: this scene has no components or wires' : `Wires: ${m.wires.size} wire${m.wires.size === 1 ? '' : 's'} · click an output dot, then an input dot, to connect · click a wire, then Delete, to remove`);
}

function deleteSelectedWire(): void {
  const m = componentsOf(S.scene), sel = wireView.selected;
  if (!m || !sel) return;
  const w = m.findWire(sel.s, sel.t);
  wireView.selected = null; shownKey = '';
  if (!w) return;
  m.removeWire(w);
  setStatus(`Deleted wire ${portName(w.source.component, w.source.port)} → ${portName(w.target.component, w.target.port)} · Ctrl+Z undoes`);
  initAudio(); playClick();
}

function refuse(why: string): void {
  wireView.refused.n++; wireView.refused.reason = why;
  setStatus(`Can't connect: ${why}`); initAudio(); playError();
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const el = e.target as Element, m = componentsOf(S.scene);
  if (!m) return;
  const pi = el.getAttribute('data-i'), wi = el.getAttribute('data-w');
  if (pi !== null) {
    e.preventDefault();
    const d = dots[+pi];
    if (!d) return;
    if (d.port.dir === 'out') {
      wireView.selected = null;
      wireView.from = wireView.from && wireView.from.row === d.row && wireView.from.comp === d.comp && wireView.from.port.name === d.port.name ? null : d;
      shownKey = '';
      setStatus(wireView.from ? `From ${portName(d.comp, d.port.name)}: click an input dot to connect (Esc cancels)` : 'Wire start cancelled');
      initAudio(); playSelect();
      return;
    }
    const from = wireView.from;
    if (!from) { setStatus(`${portName(d.comp, d.port.name)} is an input: start a wire at an output dot`); return; }
    const s = endOf(from), t = endOf(d), issues = m.checkWire(s, t), errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) { refuse(errors.map((i) => i.message).join('; ')); return; }
    m.addWire(s, t);
    wireView.from = null; shownKey = '';
    const warn = issues.filter((i) => i.severity === 'warning');
    setStatus(`Wired ${portName(s.component, s.port)} → ${portName(t.component, t.port)}${warn.length ? ` (note: ${warn[0]!.message})` : ''} · Ctrl+Z undoes`);
    initAudio(); playClick();
    return;
  }
  if (wi !== null) {
    e.preventDefault();
    const w = wires[+wi];
    if (!w) return;
    wireView.from = null;
    wireView.selected = { s: { ...w.source }, t: { ...w.target } };
    shownKey = '';
    setStatus(`Wire ${portName(w.source.component, w.source.port)} → ${portName(w.target.component, w.target.port)} selected · Delete removes it`);
    initAudio(); playSelect();
  }
}

function showLabel(el: Element): void {
  const pi = el.getAttribute('data-i'), wi = el.getAttribute('data-w');
  let text: string, x: number, y: number;
  if (pi !== null) {
    const d = dots[+pi];
    if (!d) return;
    text = `${portName(d.comp, d.port.name)} (${d.port.dir === 'in' ? 'input' : 'output'})${d.port.known ? '' : ' · guessed from its data, no wire in this save uses it'}`;
    x = d.x; y = d.y;
  } else if (wi !== null) {
    const w = wires[+wi];
    if (!w) return;
    text = `${portName(w.source.component, w.source.port)} → ${portName(w.target.component, w.target.port)}`;
    const r = canvas.getBoundingClientRect(), b = (el as SVGGraphicsElement).getBBox?.();
    x = b ? b.x + b.width / 2 : r.width / 2; y = b ? b.y : r.height / 2;
  } else return;
  label.textContent = text;
  label.style.left = `${x}px`; label.style.top = `${y - 10}px`;
  label.hidden = false;
}

// ------------------------------------------------------------------------------------- drawing

/** Port dots of a brick in world space (absolute viewer units): inputs toward -Y, outputs toward +Y, on its top face. */
export function portLayout(lo: readonly number[], hi: readonly number[], nIn: number, nOut: number): { inputs: number[][]; outputs: number[][] } {
  const row = (n: number, fy: number): number[][] => Array.from({ length: n }, (_, i) => [lo[0]! + (hi[0]! - lo[0]!) * (i + 1) / (n + 1), lo[1]! + (hi[1]! - lo[1]!) * fy, hi[2]!]);
  return { inputs: row(nIn, nOut ? 0.3 : 0.5), outputs: row(nOut, nIn ? 0.7 : 0.5) };
}

/** Per frame, after rendering: redraws the wires when the camera, the bricks or the wires changed. */
export function drawWires(sx: number, sy: number): void {
  if (!wireView.on) return;
  const m = componentsOf(S.scene), cw = canvas.clientWidth, ch = canvas.clientHeight;
  const sel = wireView.selected, f = wireView.from;
  const key = [sceneId(), camSignature(), cw, ch, S.scene.rev, S.hidden.size, m?.version ?? -1, sel ? endKey(sel.s) + endKey(sel.t) : '', f ? `${f.row}/${f.comp}/${f.port.name}` : ''].join('|');
  if (key === shownKey) return;
  shownKey = key;
  if (!m) { svg.replaceChildren(); dots = []; wires = []; return; }
  const { cam } = S;
  const P = (p: readonly number[]): [number, number] => { const v = toView(p[0]!, p[1]!, p[2]!); return [((v[0] - cam.x) * sx + 1) * cw / 2, (1 - (v[1] - cam.y) * sy) * ch / 2]; };
  const onScreen = (x: number, y: number, pad = 40): boolean => x > -pad && y > -pad && x < cw + pad && y < ch + pad;
  // bricks with components: their port dots
  const layout = new Map<string, Map<string, PortDot>>();   // brick key -> "comp/port" -> dot
  dots = [];
  const bx = new Array<number>(6), scene = S.scene;
  const rowsWithComps = componentRows(m);
  let bricks = 0;
  for (const [row, ref] of rowsWithComps) {
    if (S.hidden.has(row) || !scene.alive(row)) continue;
    scene.box(row, bx);
    const lo = [bx[0]! * BRZ_UNIT, bx[1]! * BRZ_UNIT, bx[2]! * BRZ_UNIT], hi = [bx[3]! * BRZ_UNIT, bx[4]! * BRZ_UNIT, bx[5]! * BRZ_UNIT];
    const c = P([(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, hi[2]!]);
    if (!onScreen(c[0], c[1], 200)) continue;
    if (++bricks > MAX_BRICKS) break;
    const ins: { comp: string; port: PortInfo }[] = [], outs: { comp: string; port: PortInfo }[] = [];
    for (const inst of m.store.onBrick(ref)) for (const p of m.portsOf(inst)) (p.dir === 'in' ? ins : outs).push({ comp: inst.type, port: p });
    const lay = portLayout(lo, hi, ins.length, outs.length), map = new Map<string, PortDot>();
    const put = (list: typeof ins, pos: number[][]): void => list.forEach((q, i) => {
      const [x, y] = P(pos[i]!), d: PortDot = { row, ref, comp: q.comp, port: q.port, x, y };
      map.set(`${q.comp}/${q.port.name}/${q.port.dir}`, d); dots.push(d);
    });
    put(ins, lay.inputs); put(outs, lay.outputs);
    layout.set(brickKey(ref), map);
  }
  // wires: a curve between the two dots, or a stub from the one end that's drawn
  const parts: string[] = [];
  wires = [];
  const selKey = sel ? endKey(sel.s) + '>' + endKey(sel.t) : '';
  for (const w of m.wires.wires()) {
    if (wires.length >= MAX_WIRES) break;
    const a = layout.get(brickKey(w.source))?.get(`${w.source.component}/${w.source.port}/out`);
    const b = layout.get(brickKey(w.target))?.get(`${w.target.component}/${w.target.port}/in`);
    if (!a && !b) continue;
    if (m.orphan(w.source) || m.orphan(w.target)) continue;   // an end on a new brick that is gone (its paste undone)
    const col = KIND_COLOUR[m.wireKind(w)], i = wires.push(w) - 1, on = selKey === endKey(w.source) + '>' + endKey(w.target);
    let d: string;
    if (a && b) {
      const lift = Math.min(80, 20 + Math.hypot(b.x - a.x, b.y - a.y) * 0.25);
      d = `M${f1(a.x)} ${f1(a.y)} C${f1(a.x)} ${f1(a.y - lift)} ${f1(b.x)} ${f1(b.y - lift)} ${f1(b.x)} ${f1(b.y)}`;
    } else {
      const e = (a ?? b)!;
      d = `M${f1(e.x)} ${f1(e.y)} l0 ${-STUB}`;
    }
    const stub = !(a && b), name = `${portName(w.source.component, w.source.port)} to ${portName(w.target.component, w.target.port)}`;
    parts.push(`<path class="whit" data-w="${i}" d="${d}"><title>${esc(name)}${stub ? ' (other end not in the scene)' : ''}</title></path>`,
      `<path class="wire${on ? ' sel' : ''}${stub ? ' stub' : ''}" d="${d}" stroke="${col}"/>`);
    if (stub) { const e = (a ?? b)!; parts.push(`<circle class="wend" cx="${f1(e.x)}" cy="${f1(e.y - STUB)}" r="3" fill="${col}"/>`); }
  }
  // dots on top
  dots.forEach((d, i) => {
    const pick = f && f.row === d.row && f.comp === d.comp && f.port.name === d.port.name;
    parts.push(`<circle class="port ${d.port.dir}${d.port.known ? '' : ' guess'}${pick ? ' from' : ''}" data-i="${i}" data-row="${d.row}" data-comp="${esc(d.comp)}" data-port="${esc(d.port.name)}" data-dir="${d.port.dir}" cx="${f1(d.x)}" cy="${f1(d.y)}" r="5" fill="${KIND_COLOUR[d.port.kind]}"/>`);
  });
  svg.innerHTML = parts.join('');
  wireView.drawn = { wires: wires.length, ports: dots.length };
}

const f1 = (v: number): string => v.toFixed(1);
const sceneIds = new WeakMap<object, number>();
let nextScene = 1;
/** A number per scene store (undoing a load brings another store back). */
function sceneId(): number {
  let id = sceneIds.get(S.scene);
  if (!id) sceneIds.set(S.scene, (id = nextScene++));
  return id;
}
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** Scene rows that carry components (cached per model version and scene revision). */
let rowCache: { m: SceneComponents; v: number; rev: number; rows: [number, BrickRef][] } | null = null;
function componentRows(m: SceneComponents): [number, BrickRef][] {
  if (rowCache && rowCache.m === m && rowCache.v === m.version && rowCache.rev === S.scene.rev) return rowCache.rows;
  const seen = new Set<string>(), rows: [number, BrickRef][] = [];
  for (const c of m.store.instances) {
    const k = brickKey(c.brickRef);
    if (seen.has(k)) continue;
    seen.add(k);
    const row = m.rowOfRef(c.brickRef);
    if (row >= 0) rows.push([row, c.brickRef]);
  }
  // nearest to the focused brick first, so the cap keeps the bricks around it
  const s = S.scene;
  if (rows.length > MAX_BRICKS && s.alive(S.sel)) {
    const fx = s.px[S.sel]!, fy = s.py[S.sel]!, fz = s.pz[S.sel]!;
    const dist = (r: number): number => (s.px[r]! - fx) ** 2 + (s.py[r]! - fy) ** 2 + (s.pz[r]! - fz) ** 2;
    rows.sort((a, b) => dist(a[0]) - dist(b[0]));
  }
  rowCache = { m, v: m.version, rev: S.scene.rev, rows };
  return rows;
}
