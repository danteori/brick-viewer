// Components and wires of the opened save, alongside its bricks (backlog C-02 / C-03, the scene side).
//
// Loading a save builds a ComponentStore and a WireGraph (scene/components.ts, scene/wires.ts) for
// its scene store. They name bricks the way the save does: grid, 2048-unit save chunk and index in
// that chunk, all in LOAD order. A scene row knows its load order (srcOrder = SaveExtras.seq), so
//   row -> seq -> (chunk, index) -> components / wires
// and back. Saving writes the edited component and wire chunks into the template first, then the
// brick writer re-indexes them to where their bricks were written (scene/remap.ts). With no edits
// the template is used as is, so the round trip stays byte-identical.
//
// Every edit is one undo step (a DataTx). Undo steps name components by (brick, type) and wires by
// their two ends, never by object, so they still apply after other steps re-created them.

import { S, type DataTx } from '../app/state.ts';
import type { FileMap } from '../format/brz.ts';
import type { MpsObject } from '../format/schema.ts';
import {
  brickKey, chunkName, cloneValue, ComponentEditError, ComponentStore, parseChunkPath, saveContext,
  type BrickRef, type ChunkKey, type ComponentInstance, type FieldDescriptor,
} from './components.ts';
import { WireError, WireGraph, type Wire, type WireEnd, type WireIssue } from './wires.ts';
import { histEnd, histPush } from './history.ts';
import type { SceneStore } from './store.ts';

const SAVE_CHUNK = 2048;

/** Where each loaded brick (by seq) sits in its save chunk. */
export interface LoadOrder {
  /** chunk keys ("x_y_z"), indexed by seqChunk */
  chunks: string[];
  /** per seq: index into chunks */
  seqChunk: Int32Array;
  /** per seq: index in its chunk */
  seqIndex: Int32Array;
}

/** Builds the LoadOrder of a save's grid-1 bricks from their save positions, in load order. */
export function loadOrderOf(positions: readonly (readonly number[])[]): LoadOrder {
  const n = positions.length, seqChunk = new Int32Array(n), seqIndex = new Int32Array(n), chunks: string[] = [];
  const at = new Map<string, number>(), counts: number[] = [];
  positions.forEach((p, i) => {
    const k = p.map((v) => Math.floor(Math.round(v) / SAVE_CHUNK)).join('_');
    let c = at.get(k);
    if (c === undefined) { at.set(k, (c = chunks.push(k) - 1)); counts.push(0); }
    seqChunk[i] = c; seqIndex[i] = counts[c]!++;
  });
  return { chunks, seqChunk, seqIndex };
}

const keyOf = (k: ChunkKey): string => chunkName(k);
const parseKey = (k: string): ChunkKey => { const [X, Y, Z] = k.split('_').map(Number); return { X: X!, Y: Y!, Z: Z! }; };

/** Kind of value a port carries, for the wire colour (from the field of that name, where there is one). */
export type PortKind = 'bool' | 'number' | 'vector' | 'colour' | 'string' | 'exec' | 'other';

export interface PortInfo {
  name: string;
  dir: 'in' | 'out';
  /** false: a guess (a data field of that name; no wire in this save uses the port) */
  known: boolean;
  kind: PortKind;
}

const PORTABLE = new Set(['number', 'bool', 'variant', 'vector', 'rotator', 'colour', 'string', 'enum']);

function variantKind(t: string): PortKind {
  if (/^(f32|f64|i64|i32|u8|u16|u32|i8|i16|u64)$/.test(t)) return 'number';
  if (t === 'bool') return 'bool';
  if (/^(Vector|Rotator|Quat)/.test(t)) return 'vector';
  if (/Color$/.test(t)) return 'colour';
  if (t === 'str') return 'string';
  if (/Exec/.test(t)) return 'exec';
  return 'other';
}

function kindOfField(d: FieldDescriptor | undefined, value: unknown): PortKind {
  if (!d) return 'other';
  switch (d.kind) {
    case 'number': case 'enum': return 'number';
    case 'bool': return 'bool';
    case 'vector': case 'rotator': return 'vector';
    case 'colour': return 'colour';
    case 'string': return 'string';
    case 'variant': {
      const v = value as { variant?: number } | undefined, alt = d.alternatives?.[v?.variant ?? -1];
      return alt ? variantKind(alt.type) : 'other';
    }
    default: return 'other';
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();
/** Called after every component / wire edit, undo and redo (the panels and the wire view redraw). */
export function onComponentsChange(f: Listener): () => void { listeners.add(f); return () => listeners.delete(f); }

export class SceneComponents {
  /** Bumped on every change: views compare it to redraw. */
  version = 0;
  private byChunk: Map<string, number[]> | null = null;
  private seqRow: Int32Array | null = null;
  private seqRowRev = -1;
  private seqCache: { v: number; seqs: Set<number> } | null = null;

  constructor(readonly scene: SceneStore, readonly store: ComponentStore, readonly wires: WireGraph, readonly order: LoadOrder) {}

  get dirty(): boolean { return this.store.dirty || this.wires.dirty; }
  get empty(): boolean { return !this.store.instances.length && !this.wires.size; }

  // ------------------------------------------------------------------ bricks <-> rows

  /** The save brick (grid 1) of a load-order position. */
  refOfSeq(seq: number): BrickRef | null {
    if (seq < 0 || seq >= this.order.seqChunk.length) return null;
    return { grid: 1, chunk: parseKey(this.order.chunks[this.order.seqChunk[seq]!]!), brick: this.order.seqIndex[seq]! };
  }

  /** Load-order position of a grid-1 save brick, or -1. */
  seqOfRef(ref: BrickRef): number {
    if (ref.grid !== 1) return -1;
    if (!this.byChunk) {
      const m = new Map<string, number[]>(), { seqChunk, chunks } = this.order;
      for (let s = 0; s < seqChunk.length; s++) {
        const k = chunks[seqChunk[s]!]!;
        let l = m.get(k);
        if (!l) m.set(k, (l = []));
        l.push(s);
      }
      this.byChunk = m;
    }
    return this.byChunk.get(keyOf(ref.chunk))?.[ref.brick] ?? -1;
  }

  /** The save brick a scene row was loaded as (null for a new brick). */
  refOfRow(id: number): BrickRef | null {
    if (!this.scene.alive(id)) return null;
    const seq = this.scene.srcOrder[id]!;
    return seq >= 0 ? this.refOfSeq(seq) : null;
  }

  /** The scene row showing a save brick, or -1 (not in the scene: another grid, an unsupported type, deleted). */
  rowOfRef(ref: BrickRef): number {
    const seq = this.seqOfRef(ref);
    if (seq < 0) return -1;
    const s = this.scene;
    let row = this.seqRow?.[seq] ?? -1;
    const stale = !this.seqRow || (row >= 0 ? !s.alive(row) || s.srcOrder[row] !== seq : this.seqRowRev !== s.rev);
    if (stale) {
      this.seqRow = new Int32Array(this.order.seqChunk.length).fill(-1);
      this.seqRowRev = s.rev;
      for (const id of s.ids()) { const q = s.srcOrder[id]!; if (q >= 0 && q < this.seqRow.length) this.seqRow[q] = id; }
      row = this.seqRow[seq]!;
    }
    return row;
  }

  /** Components on a scene row. */
  componentsOf(id: number): ComponentInstance[] {
    const r = this.refOfRow(id);
    return r ? this.store.onBrick(r) : [];
  }

  /** Load-order positions of bricks that carry components, joints or microchips, or a wire end (they can't be deleted or leave their chunk). */
  componentSeqs(): Set<number> {
    if (this.seqCache?.v === this.version) return this.seqCache.seqs;
    const seqs = new Set<number>(), add = (r: BrickRef): void => { const s = this.seqOfRef(r); if (s >= 0) seqs.add(s); };
    for (const ch of this.store.chunks) {
      if (ch.grid !== 1) continue;
      for (const [f, v] of Object.entries(ch.file.root)) {
        if (!/BrickIndices$/.test(f) || !Array.isArray(v)) continue;
        for (const i of v as number[]) add({ grid: 1, chunk: ch.chunk, brick: i });
      }
    }
    for (const w of this.wires.wires()) { add(w.source); add(w.target); }
    this.seqCache = { v: this.version, seqs };
    return seqs;
  }

  // ------------------------------------------------------------------ ports

  /** Ports of a component: those this save's wires use (known), plus input guesses from its data fields. */
  portsOf(c: ComponentInstance): PortInfo[] {
    const p = this.wires.ports(c.type), d = this.store.describe(c), byName = new Map(d.map((f) => [f.name, f]));
    const kind = (n: string): PortKind => kindOfField(byName.get(n), c.data?.[n]);
    const out: PortInfo[] = [
      ...p.inputs.map((name) => ({ name, dir: 'in' as const, known: true, kind: kind(name) })),
      ...p.outputs.map((name) => ({ name, dir: 'out' as const, known: true, kind: kind(name) })),
    ];
    for (const f of d) if (PORTABLE.has(f.kind) && !p.inputs.includes(f.name) && !p.outputs.includes(f.name)) out.push({ name: f.name, dir: 'in', known: false, kind: kind(f.name) });
    return out;
  }

  /** The kind of value a wire carries, from the target's field of the port's name (else the source's). */
  wireKind(w: Wire): PortKind {
    for (const e of [w.target, w.source]) {
      const c = this.store.onBrick(e).find((x) => x.type === e.component);
      if (!c) continue;
      const k = kindOfField(this.store.describe(c).find((f) => f.name === e.port), c.data?.[e.port]);
      if (k !== 'other') return k;
    }
    return 'other';
  }

  // ------------------------------------------------------------------ edits (each one undo step)

  private instance(ref: BrickRef, type: string): ComponentInstance {
    const c = this.store.onBrick(ref).find((x) => x.type === type);
    if (!c) throw new ComponentEditError(`brick ${brickKey(ref)} has no ${type}`);
    return c;
  }

  private changed(): void {
    this.version++;
    for (const f of listeners) f();
  }

  private push(label: string, ref: BrickRef, undo: () => void, redo: () => void, bytes = 256): void {
    histEnd();
    const t: DataTx = { kind: 'data', label, focus: this.rowOfRef(ref), undo: () => { undo(); this.changed(); }, redo: () => { redo(); this.changed(); }, bytes };
    histPush(t);
    this.changed();
  }

  /**
   * Sets a field (path as in ComponentStore.setField) as one undo step. `op`: 'set' (default),
   * 'variant' (value = alternative index), 'mapSet' ([key, value]) or 'mapDelete' (value = key).
   * Throws ComponentEditError when the value doesn't fit.
   */
  edit(c: ComponentInstance, path: readonly (string | number)[], value: unknown, op: 'set' | 'variant' | 'mapSet' | 'mapDelete' = 'set'): void {
    const ref = { ...c.brickRef, chunk: { ...c.brickRef.chunk } }, type = c.type, p = path.slice();
    const before = cloneValue(this.store.getField(c, p));
    const apply = (inst: ComponentInstance): void => {
      if (op === 'set') this.store.setField(inst, p, value);
      else if (op === 'variant') this.store.setVariant(inst, p, value as number);
      else if (op === 'mapSet') { const [k, v] = value as [unknown, unknown]; this.store.setMapEntry(inst, p, k, v); }
      else if (!this.store.deleteMapEntry(inst, p, value)) throw new ComponentEditError(`no entry ${String(value)}`);
    };
    apply(c);
    const after = cloneValue(this.store.getField(c, p));
    const put = (v: unknown): void => { const inst = this.instance(ref, type); this.store.setField(inst, p, cloneValue(v)); };
    this.push(`edit ${shortType(type)} ${p.join('.') || 'data'}`, ref, () => put(before), () => put(after));
  }

  /** Adds a component of `type` (with defaults) to scene row `id`, as one undo step. */
  addComponent(id: number, type: string): ComponentInstance {
    const ref = this.refOfRow(id);
    if (!ref) throw new ComponentEditError('only bricks loaded from the save can carry components here (a new brick has no place in the save yet)');
    const c = this.store.addInstance(ref, type), data = cloneValue(c.data);
    this.push(`add ${shortType(type)}`, ref, () => { this.store.removeInstance(this.instance(ref, type)); }, () => { this.store.addInstance(ref, type, cloneValue(data)); });
    return c;
  }

  /** Removes a component and the wires on its ports, as one undo step. */
  removeComponent(c: ComponentInstance): void {
    const ref = { ...c.brickRef, chunk: { ...c.brickRef.chunk } }, type = c.type;
    const { incoming, outgoing } = this.wires.wiresOf(ref);
    const gone = [...incoming.filter((w) => w.target.component === type), ...outgoing.filter((w) => w.source.component === type)];
    const ends = gone.map((w) => ({ s: copyEnd(w.source), t: copyEnd(w.target), pending: w.pending }));
    const data = cloneValue(c.data);
    const doRemove = (): void => {
      for (const e of ends) { const w = this.findWire(e.s, e.t); if (w) this.wires.removeWire(w.id); }
      this.store.removeInstance(this.instance(ref, type));
    };
    doRemove();
    this.push(`remove ${shortType(type)}`, ref, () => {
      this.store.addInstance(ref, type, cloneValue(data));
      for (const e of ends) this.wires.addWire(e.s, e.t, { force: true, pending: e.pending });
    }, doRemove);
  }

  /** The wire between two ends, if there is one. */
  findWire(s: WireEnd, t: WireEnd): Wire | undefined {
    return this.wires.wiresInto(t).find((w) => sameEnd(w.source, s));
  }

  /** Issues adding this wire would have (errors refuse it). */
  checkWire(s: WireEnd, t: WireEnd): WireIssue[] {
    return this.wires.check(s, t);
  }

  /** Adds a wire (validated: fan-in and the chip rules refuse it with a WireError), as one undo step. */
  addWire(s: WireEnd, t: WireEnd): Wire {
    const w = this.wires.addWire(s, t), se = copyEnd(s), te = copyEnd(t);
    this.push('add wire', te, () => { const x = this.findWire(se, te); if (x) this.wires.removeWire(x.id); }, () => { this.wires.addWire(se, te, { force: true }); });
    return w;
  }

  /** Removes a wire, as one undo step. */
  removeWire(w: Wire): void {
    const se = copyEnd(w.source), te = copyEnd(w.target), pending = w.pending;
    this.wires.removeWire(w.id);
    this.push('delete wire', te, () => { this.wires.addWire(se, te, { force: true, pending }); }, () => { const x = this.findWire(se, te); if (x) this.wires.removeWire(x.id); });
  }

  // ------------------------------------------------------------------ saving

  /**
   * A template save with the edited component and wire chunks written in (and their counts in
   * ChunkIndex and Owners), or `template` itself when nothing was edited.
   */
  applyTo(template: FileMap): FileMap {
    if (!this.dirty) return template;
    const out: FileMap = new Map(template);
    this.store.encode({ into: out, counts: true });
    this.wires.encode({ into: out });
    return out;
  }
}

const copyEnd = (e: WireEnd): WireEnd => ({ grid: e.grid, chunk: { X: e.chunk.X, Y: e.chunk.Y, Z: e.chunk.Z }, brick: e.brick, component: e.component, port: e.port });
const sameEnd = (a: WireEnd, b: WireEnd): boolean => brickKey(a) === brickKey(b) && a.component === b.component && a.port === b.port;

/** "BrickComponentType_WireGraph_Expr_MathAdd" -> "MathAdd", "Component_PointLight" -> "PointLight". */
export function shortType(t: string): string {
  return t.replace(/^(BrickComponentType_|Component_)/, '').replace(/^(WireGraph(Pseudo)?_(Expr|Exec)?_?|Internal_)/, '');
}

export { WireError, ComponentEditError };

// ------------------------------------------------------------------ per scene store

const models = new WeakMap<SceneStore, SceneComponents | null>();

/** True when a save has any component or wire chunk (cheap: file names only). */
export function hasComponentFiles(files: FileMap): boolean {
  for (const p of files.keys()) { const at = parseChunkPath(p); if (at && (at.kind === 'Components' || at.kind === 'Wires')) return true; }
  return false;
}

/**
 * Builds the components and wires of a loaded save for its scene store. Returns an error message
 * when the save's component data can't be read (the scene still loads; components stay read-only
 * as part of the template).
 */
export function attachComponents(scene: SceneStore, files: FileMap, order: LoadOrder): string | null {
  try {
    if (!files.has('World/0/GlobalData.mps')) { models.set(scene, null); return null; }
    const ctx = saveContext(files), store = new ComponentStore(ctx), wires = new WireGraph(ctx, { components: store });
    models.set(scene, new SceneComponents(scene, store, wires, order));
    return null;
  } catch (e) {
    models.set(scene, null);
    return e instanceof Error ? e.message : String(e);
  }
}

/** The components and wires of a scene store (null: not loaded from a save, or unreadable). */
export const componentsOf = (scene: SceneStore = S.scene): SceneComponents | null => models.get(scene) ?? null;

export type { MpsObject };
