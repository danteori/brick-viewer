// Brick Properties > Components (backlog C-02): the focused brick's components, one editor per
// field built from the save's own schema (scene/components.ts FieldDescriptor): numbers (integer
// types keep their range), bools, enums, strings, colours, vectors / rotators, asset references,
// map entries, variants (switch the alternative, then edit its value), nested structs and arrays.
// Every committed edit is validated by the store and is one undo step; a bad value is flagged and
// not applied. "Add" puts a component of a type this save knows on the brick (with the values most
// of that type's instances have), "Remove" takes one off along with its wires (one undo step each).

import { S } from '../../app/state.ts';
import { ComponentEditError, defaultValue, type ComponentInstance, type FieldDescriptor } from '../../scene/components.ts';
import { componentsOf, onComponentsChange, shortType, type SceneComponents } from '../../scene/compmodel.ts';
import { initAudio, playClick, playError } from '../audio.ts';
import { setStatus } from '../status.ts';
import { $ } from '../dom.ts';
import { isTyping } from '../../editor/input.ts';

type Path = (string | number)[];
type Op = 'set' | 'variant' | 'mapSet' | 'mapDelete';

let toggle: HTMLButtonElement, body: HTMLElement, count: HTMLElement, props: HTMLElement;
let shownKey = '';
/** list cap per array / map (big ones stay readable) */
const CAP = 24;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
};

/** "bEnabled" -> "Enabled", "MaxDistance" -> "Max distance" */
export function fieldLabel(n: string): string {
  const s = n.replace(/^b(?=[A-Z])/, '').replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/ ([A-Z])(?=[a-z])/g, (_m, c: string) => ' ' + c.toLowerCase());
}

export function initComponentsPanel(): void {
  props = $('props'); toggle = $<HTMLButtonElement>('comptoggle'); body = $('compbody'); count = $('compcount');
  toggle.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
    props.classList.toggle('wide', !!open);
    shownKey = '';
    if (open) render();
  });
  // keys typed into the editors are theirs (no tool hotkeys, no canvas drags)
  for (const t of ['pointerdown', 'dblclick', 'wheel']) body.addEventListener(t, (e) => e.stopPropagation());
  onComponentsChange(() => { shownKey = ''; if (!body.hidden) render(); });
}

/** Per frame: redraws when the focus, the scene or the components changed (not while a field is being typed in). */
export function tickComponents(): void {
  const m = componentsOf(S.scene), n = m ? m.componentsOf(S.sel).length : 0;
  const c = n ? String(n) : '';
  if (count.textContent !== c) count.textContent = c;
  if (body.hidden) return;
  const key = keyNow(m);
  if (key === shownKey) return;
  // another brick or scene: redraw now; only the data changed (an undo): not while a field is being typed in
  const sameBrick = key.slice(0, key.lastIndexOf('|')) === shownKey.slice(0, shownKey.lastIndexOf('|'));
  if (sameBrick && isTyping(document.activeElement) && body.contains(document.activeElement)) return;
  render();
}

const sceneIds = new WeakMap<object, number>();
let nextScene = 1;
function keyNow(m: SceneComponents | null): string {
  let sid = sceneIds.get(S.scene);
  if (!sid) sceneIds.set(S.scene, (sid = nextScene++));
  return `${sid}|${S.sel}|${m?.version ?? -1}`;
}

function message(text: string, bad = false): void {
  const el = body.querySelector<HTMLElement>('.cmsg');
  if (el) { el.textContent = text; el.classList.toggle('bad', bad); }
  if (bad) { setStatus(text); initAudio(); playError(); }
}

/** Rebuilds the section, keeping the focused editor focused. */
function render(): void {
  const m = componentsOf(S.scene);
  shownKey = keyNow(m);
  const active = document.activeElement as HTMLElement | null, keep = active && body.contains(active) ? active.dataset.k : undefined;
  body.replaceChildren();
  const msg = h('div', { class: 'cmsg', role: 'status', 'aria-live': 'polite' });
  if (!m) { body.append(h('p', { class: 'cnote' }, 'Open a save to see its components.')); return; }
  // a new brick has no place in the save until it gets a component (C-04): Add gives it one
  const ref = m.refOfRow(S.sel), types = m.addableOn(S.sel);
  if (!ref && !S.scene.alive(S.sel)) { body.append(h('p', { class: 'cnote' }, 'Focus a brick to see its components.')); return; }
  const list = ref ? m.store.onBrick(ref) : [];
  if (!list.length) body.append(h('p', { class: 'cnote' }, 'No components on this brick.'));
  for (const c of list) body.append(componentBlock(m, c));
  // add a component of a type this save knows
  const row = h('div', { class: 'cadd' });
  const sel = h('select', { 'aria-label': 'Component type to add', 'data-k': 'add-type' });
  for (const t of types) sel.append(new Option(shortType(t), t));
  const add = h('button', { type: 'button', class: 'cbtn', 'data-k': 'add', title: 'Add a component of this type, with the values most of its kind in this save have' }, 'Add');
  if (!types.length) { sel.append(new Option('(no other types in this save)', '')); sel.disabled = true; add.disabled = true; }
  add.addEventListener('click', () => {
    if (!sel.value) return;
    try { m.addComponent(S.sel, sel.value); setStatus(`Added ${shortType(sel.value)}`); initAudio(); playClick(); } catch (e) { message(errText(e), true); }
  });
  row.append(sel, add);
  body.append(row, msg);
  if (keep) body.querySelector<HTMLElement>(`[data-k="${CSS.escape(keep)}"]`)?.focus();
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function componentBlock(m: SceneComponents, c: ComponentInstance): HTMLElement {
  const box = h('section', { class: 'comp', 'aria-label': shortType(c.type) });
  const head = h('div', { class: 'chead' });
  const { incoming, outgoing } = m.wires.wiresOf(c.brickRef);
  const ins = incoming.filter((w) => w.target.component === c.type).length, outs = outgoing.filter((w) => w.source.component === c.type).length;
  const title = h('span', { class: 'ctitle', title: c.type + (c.struct ? ` (${c.struct})` : '') }, shortType(c.type));
  const wires = h('span', { class: 'cwires', title: 'Wires into / out of this component' }, ins || outs ? `${ins} in · ${outs} out` : '');
  const rm = h('button', { type: 'button', class: 'cbtn crm', 'data-k': `rm|${c.type}`, title: 'Remove this component (and its wires)', 'aria-label': `Remove ${shortType(c.type)}` }, 'Remove');
  rm.addEventListener('click', () => {
    try { m.removeComponent(c); setStatus(`Removed ${shortType(c.type)}${ins + outs ? ` and ${ins + outs} wire${ins + outs === 1 ? '' : 's'}` : ''} · Ctrl+Z undoes`); initAudio(); playClick(); } catch (e) { message(errText(e), true); }
  });
  head.append(title, wires, rm);
  box.append(head);
  const fields = m.store.describe(c);
  if (!fields.length) box.append(h('p', { class: 'cnote' }, 'No settings.'));
  for (const d of fields) box.append(fieldRow(m, c, d, [d.name], c.data?.[d.name]));
  return box;
}

/** One labelled editor row. */
function fieldRow(m: SceneComponents, c: ComponentInstance, d: FieldDescriptor, path: Path, value: unknown): HTMLElement {
  const nested = d.kind === 'struct' || d.kind === 'map' || d.kind === 'array' || d.kind === 'variant';
  const row = h('div', { class: nested ? 'cfield cnest' : 'cfield' });
  const label = h('span', { class: 'cl', title: `${d.name}: ${d.type}` }, fieldLabel(String(path[path.length - 1])));
  row.append(label, editor(m, c, d, path, value));
  return row;
}

/** Commits an edit; a refused value is flagged on `el` and reported. */
function commit(m: SceneComponents, c: ComponentInstance, path: Path, value: unknown, el: HTMLElement | null, op: Op = 'set'): void {
  try {
    m.edit(c, path, value, op);
    el?.removeAttribute('aria-invalid');
    setStatus(`${shortType(c.type)}: ${path.map(String).join('.')} set · Ctrl+Z undoes`);
  } catch (e) {
    if (!(e instanceof ComponentEditError)) throw e;
    if (el) el.setAttribute('aria-invalid', 'true');
    message(e.message, true);
  }
}

const key = (c: ComponentInstance, path: Path, part = ''): string => `${c.type}|${path.map(String).join('.')}${part ? '|' + part : ''}`;

function numberInput(m: SceneComponents, c: ComponentInstance, d: FieldDescriptor, path: Path, value: unknown, label = ''): HTMLInputElement {
  const n = d.number!, inp = h('input', { type: 'number', class: 'cnum', 'data-k': key(c, path), 'aria-label': label || fieldLabel(String(path[path.length - 1])) });
  inp.step = n.integer ? '1' : 'any';
  if (n.integer && Number.isSafeInteger(n.min) && Number.isSafeInteger(n.max) && n.max <= 4294967295) { inp.min = String(n.min); inp.max = String(n.max); }
  inp.value = typeof value === 'number' ? String(+value.toPrecision(n.float32 ? 7 : 15)) : String(value ?? '');
  inp.title = `${d.type}${inp.min ? ` (${inp.min} to ${inp.max})` : ''}`;
  inp.addEventListener('change', () => {
    const t = inp.value.trim();
    if (t === '' || Number.isNaN(Number(t))) { inp.setAttribute('aria-invalid', 'true'); message(`${fieldLabel(String(path[path.length - 1]))}: enter a number`, true); return; }
    let v: number | bigint = Number(t);
    if (n.integer && /^-?\d+$/.test(t) && !Number.isSafeInteger(v) && typeof value === 'bigint') v = BigInt(t);
    commit(m, c, path, v, inp);
  });
  return inp;
}

const hex2 = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
const toSrgb = (l: number): number => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
const toLinear = (s: number): number => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));

function editor(m: SceneComponents, c: ComponentInstance, d: FieldDescriptor, path: Path, value: unknown): HTMLElement {
  const name = fieldLabel(String(path[path.length - 1]));
  switch (d.kind) {
    case 'number': return numberInput(m, c, d, path, value);
    case 'bool': {
      const inp = h('input', { type: 'checkbox', 'data-k': key(c, path), 'aria-label': name });
      inp.checked = !!value;
      inp.addEventListener('change', () => commit(m, c, path, inp.checked, inp));
      return inp;
    }
    case 'enum': case 'asset': {
      const sel = h('select', { 'data-k': key(c, path), 'aria-label': name, title: d.type });
      const opts = d.options ?? [];
      for (const o of opts) sel.append(new Option(o.label.replace(/^[A-Za-z0-9_]+::/, ''), String(o.value)));
      if (!opts.some((o) => o.value === value)) sel.append(new Option(`(${String(value)})`, String(value)));
      sel.value = String(value);
      sel.addEventListener('change', () => commit(m, c, path, Number(sel.value), sel));
      return sel;
    }
    case 'string': {
      const inp = h('input', { type: 'text', class: 'ctext', 'data-k': key(c, path), 'aria-label': name, spellcheck: 'false', autocomplete: 'off' });
      inp.value = String(value ?? '');
      inp.addEventListener('change', () => commit(m, c, path, inp.value, inp));
      return inp;
    }
    case 'colour': {
      const v = (value ?? {}) as Record<string, number>, float = !!d.colour?.float;
      const wrap = h('span', { class: 'ccolour' });
      const pick = h('input', { type: 'color', 'data-k': key(c, path), 'aria-label': `${name} colour` });
      const ch = (k: string): number => (float ? Math.round(toSrgb(Math.max(0, Math.min(1, v[k] ?? 0))) * 255) : v[k] ?? 0);
      pick.value = `#${hex2(ch('R'))}${hex2(ch('G'))}${hex2(ch('B'))}`;
      pick.title = d.colour!.channels.map((k) => `${k} ${+(v[k] ?? 0).toPrecision(4)}`).join(' · ') + (float ? ' (linear)' : '');
      pick.addEventListener('change', () => {
        const x = pick.value, out: Record<string, number> = { ...v };
        [['R', 1], ['G', 3], ['B', 5]].forEach(([k, i]) => {
          const b = parseInt(x.slice(i as number, (i as number) + 2), 16);
          out[k as string] = float ? toLinear(b / 255) : b;
        });
        commit(m, c, path, out, pick);
      });
      wrap.append(pick);
      const a = d.fields?.find((f) => f.name === 'A');
      if (a?.number) wrap.append(numberInput(m, c, a, [...path, 'A'], v.A, `${name} alpha`));
      return wrap;
    }
    case 'vector': case 'rotator': case 'struct': {
      const wrap = h('span', { class: d.kind === 'struct' ? 'cstruct' : 'cvec' });
      for (const f of d.fields ?? []) {
        const sub = (value as Record<string, unknown> | null)?.[f.name];
        if (d.kind !== 'struct' && f.number) {
          const lab = h('label', { class: 'cvl' }, f.name.charAt(0));
          lab.title = f.name;
          lab.append(numberInput(m, c, f, [...path, f.name], sub, `${name} ${f.name}`));
          wrap.append(lab);
        } else wrap.append(fieldRow(m, c, f, [...path, f.name], sub));
      }
      return wrap;
    }
    case 'variant': {
      const v = value as { variant: number; value: unknown }, wrap = h('span', { class: 'cstruct' });
      const sel = h('select', { 'data-k': key(c, path, 'variant'), 'aria-label': `${name} type`, title: 'Value type (switching resets the value)' });
      (d.alternatives ?? []).forEach((a, i) => sel.append(new Option(a.type, String(i))));
      sel.value = String(v?.variant ?? 0);
      sel.addEventListener('change', () => commit(m, c, path, Number(sel.value), sel, 'variant'));
      wrap.append(sel);
      const alt = d.alternatives?.[v?.variant ?? -1];
      if (alt && (alt.kind !== 'struct' || alt.fields?.length)) wrap.append(editor(m, c, alt, [...path, 'value'], v.value));
      return wrap;
    }
    case 'map': {
      const mp = value instanceof Map ? value : new Map(), wrap = h('span', { class: 'cstruct' });
      let n = 0;
      for (const [k, val] of mp) {
        if (n++ >= CAP) { wrap.append(h('span', { class: 'cnote' }, `+${mp.size - CAP} more`)); break; }
        const row = h('div', { class: 'cfield' });
        const kl = h('span', { class: 'cl', title: `key (${d.key?.type ?? ''})` }, String(k));
        const del = h('button', { type: 'button', class: 'cbtn cx', 'data-k': key(c, path, 'del|' + String(k)), 'aria-label': `Delete entry ${String(k)}`, title: 'Delete this entry' }, '×');
        del.addEventListener('click', () => commit(m, c, path, k, null, 'mapDelete'));
        row.append(kl, editor(m, c, d.value!, [...path, k as string | number], val), del);
        wrap.append(row);
      }
      const addRow = h('div', { class: 'cadd' });
      const kin = h('input', { type: 'text', class: 'ctext', 'data-k': key(c, path, 'newkey'), 'aria-label': `${name}: new entry key`, placeholder: 'new key' });
      const add = h('button', { type: 'button', class: 'cbtn', 'data-k': key(c, path, 'addentry') }, 'Add entry');
      add.addEventListener('click', () => {
        const t = kin.value.trim();
        if (!t) { message('Type a key for the new entry', true); return; }
        const kk = d.key?.kind === 'number' ? Number(t) : t;
        commit(m, c, path, [kk, defaultOf(c, d)], kin, 'mapSet');
      });
      addRow.append(kin, add);
      wrap.append(addRow);
      return wrap;
    }
    case 'array': {
      const a = Array.isArray(value) ? value : [], wrap = h('span', { class: d.element && (d.element.kind === 'number') && a.length <= 4 ? 'cvec' : 'cstruct' });
      a.slice(0, CAP).forEach((e, i) => {
        if (d.element?.kind === 'number' && a.length <= 4) wrap.append(numberInput(m, c, d.element, [...path, i], e, `${name} ${i}`));
        else wrap.append(fieldRow(m, c, { ...d.element!, name: String(i) }, [...path, i], e));
      });
      if (a.length > CAP) wrap.append(h('span', { class: 'cnote' }, `+${a.length - CAP} more`));
      if (!a.length) wrap.append(h('span', { class: 'cnote' }, '(empty)'));
      return wrap;
    }
    default: {
      const t = h('code', { class: 'craw', title: `${d.type} (not editable here)` });
      t.textContent = JSON.stringify(value, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x instanceof Map ? [...x] : x)) ?? '';
      return t;
    }
  }
}

/** A zero value for a new map entry. */
const defaultOf = (c: ComponentInstance, d: FieldDescriptor): unknown => (d.value ? defaultValue(c.chunk.schema, d.value.schemaType) : 0);
