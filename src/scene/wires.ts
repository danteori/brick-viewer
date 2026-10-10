// The wire graph of a save (backlog C-03, the data side).
//
// A wire runs from a (brick, component, port) source to a (brick, component, port) target. Saves
// store each wire in the TARGET's chunk (`Grids/<g>/Wires/<x>_<y>_<z>.mps`): a "local" wire when
// the source is in the same grid and chunk, else a "remote" one that also names the source's grid
// and chunk. Component type and port are indices into GlobalData's ComponentTypeNames and
// ComponentWirePortNames (FORMAT 1.8).
//
// Rules the model enforces (FORMAT 1.8):
//   - no fan-in: one wire per target port (the game rejects the whole save otherwise);
//   - a wire may LEAVE a microchip only from a MicrochipOutput's `RER_Output` (the way the game's
//     own chip I/O works); that check can be relaxed to a warning (`chipBoundary: 'warn'`).
//     ENTERING a chip one level down is allowed straight into a gate inside it (the game writes
//     such wires, and the user confirmed they're fine), as well as into a MicrochipInput's
//     `RER_Input`. Only a chip I/O brick's other ports stay off limits from outside;
//   - both ends must be components the bricks really carry.
// Saving keeps the bookkeeping in step: the target grid's ChunkIndex NumWires, and Owners
// WireCounts, which count each wire against the owner of its TARGET brick (true in every save
// we checked).
// Ports per component type come from the save itself (the wires it holds), optionally merged
// with a catalogue built from the user's other saves (componentCatalogue.ts). Nothing is built in.

import type { FileMap } from '../format/brz.ts';
import { decodeMps, encodeMps, type MpsObject, type Schema, type SchemaType } from '../format/schema.ts';
import {
  brickKey, chunkName, chunkPath, defaultValue, parseChunkPath, saveContext, WORLD,
  ComponentStore, type BrickRef, type ChunkKey, type LoadOptions, type SaveContext,
} from './components.ts';

/** One end of a wire. */
export interface WireEnd extends BrickRef {
  /** Component type name on that brick. */
  component: string;
  /** Port name. */
  port: string;
}

export interface Wire {
  /** Stable while the graph lives. */
  readonly id: number;
  readonly source: WireEnd;
  readonly target: WireEnd;
  /** The PendingPropagationFlags bit the save had for this wire. */
  pending: boolean;
}

export type WireIssueCode = 'fan-in' | 'missing-component' | 'chip-boundary' | 'unknown-port' | 'port-direction' | 'missing-chunk';

export interface WireIssue {
  code: WireIssueCode;
  /** Errors make the save invalid (addWire refuses them); warnings are worth showing. */
  severity: 'error' | 'warning';
  message: string;
  wire?: Wire;
}

export class WireError extends Error {
  constructor(readonly issues: WireIssue[]) {
    super(issues.map((i) => i.message).join('; '));
  }
}

/** Ports a component type is known to have. */
export interface PortSet { inputs: string[]; outputs: string[] }
/** Looks up known ports of a component type (e.g. from a catalogue); undefined = no knowledge. */
export type PortLookup = (componentType: string) => PortSet | undefined;

export interface ChipGrid {
  /** The chip's inner grid (entity persistent index). */
  grid: number;
  /** Grid the chip brick sits on, when the save links it (CL15729 MicrochipBrick* fields). */
  parent: number | null;
  chipBrick: BrickRef | null;
}

export interface WireOptions extends LoadOptions {
  /** Components of the same save; loaded from `files` when not given. */
  components?: ComponentStore;
  /** Extra port knowledge (a catalogue built from other saves). */
  ports?: PortLookup;
  /** Chip-boundary rule: 'strict' (default) makes a crossing that skips the chip I/O an error, 'warn' a warning. */
  chipBoundary?: 'strict' | 'warn';
}

/** Microchip I/O: the component type names end like this, and these are their boundary ports. */
const CHIP_INPUT = /MicrochipInput$/, CHIP_OUTPUT = /MicrochipOutput$/;
export const CHIP_IN_PORT = 'RER_Input', CHIP_OUT_PORT = 'RER_Output';

interface WireChunk {
  path: string;
  grid: number;
  chunk: ChunkKey;
  schema: Schema;
  /** Decoded root as loaded (null for a chunk this graph created). */
  root: MpsObject | null;
  local: Wire[];
  remote: Wire[];
  dirty: boolean;
}

const endKey = (e: WireEnd): string => `${brickKey(e)}/${e.component}/${e.port}`;
const sameChunk = (a: BrickRef, b: BrickRef): boolean => a.grid === b.grid && a.chunk.X === b.chunk.X && a.chunk.Y === b.chunk.Y && a.chunk.Z === b.chunk.Z;
const chunkId = (grid: number, k: ChunkKey): string => `${grid}/${chunkName(k)}`;

function addTo(m: Map<string, Wire[]>, k: string, w: Wire): void {
  const l = m.get(k);
  if (l) l.push(w);
  else m.set(k, [w]);
}
function dropFrom(m: Map<string, Wire[]>, k: string, w: Wire): void {
  const l = m.get(k);
  if (!l) return;
  const i = l.indexOf(w);
  if (i >= 0) l.splice(i, 1);
  if (!l.length) m.delete(k);
}

export class WireGraph {
  readonly components: ComponentStore;
  readonly chips = new Map<number, ChipGrid>();
  private readonly chunks = new Map<string, WireChunk>();
  private readonly all = new Map<number, Wire>();
  private readonly into = new Map<string, Wire[]>();   // by target endKey
  private readonly inBrick = new Map<string, Wire[]>();
  private readonly outBrick = new Map<string, Wire[]>();
  private readonly observed = new Map<string, { inputs: Set<string>; outputs: Set<string> }>();
  private readonly lookup: PortLookup | undefined;
  private readonly boundarySeverity: 'error' | 'warning';
  /** Wires as loaded, and the loaded ones removed since (for the owner counts). */
  private readonly loaded = new Set<Wire>();
  private readonly removed: Wire[] = [];
  private nextId = 1;
  private globalDirty = false;

  constructor(readonly ctx: SaveContext, opts: WireOptions = {}) {
    this.components = opts.components ?? new ComponentStore(ctx);
    this.lookup = opts.ports;
    this.boundarySeverity = opts.chipBoundary === 'warn' ? 'warning' : 'error';
    this.loadChips();
    const types = ctx.global.ComponentTypeNames ?? [], ports = ctx.global.ComponentWirePortNames ?? [];
    const end = (rec: MpsObject, grid: number, chunk: ChunkKey): WireEnd => ({
      grid, chunk, brick: rec.BrickIndexInChunk as number,
      component: types[rec.ComponentTypeIndex as number] ?? `#${String(rec.ComponentTypeIndex)}`,
      port: ports[rec.PortIndex as number] ?? `#${String(rec.PortIndex)}`,
    });
    for (const [path, bytes] of ctx.files) {
      const at = parseChunkPath(path);
      if (!at || at.kind !== 'Wires') continue;
      const schema = ctx.schemaFor(path), root = decodeMps(bytes, schema);
      const ch: WireChunk = { path, grid: at.grid, chunk: at.chunk, schema, root, local: [], remote: [], dirty: false };
      this.chunks.set(chunkId(at.grid, at.chunk), ch);
      const ls = (root.LocalWireSources as MpsObject[] | undefined) ?? [], lt = (root.LocalWireTargets as MpsObject[] | undefined) ?? [];
      const rs = (root.RemoteWireSources as MpsObject[] | undefined) ?? [], rt = (root.RemoteWireTargets as MpsObject[] | undefined) ?? [];
      const bits = ((root.PendingPropagationFlags as { Flags?: number[] } | undefined)?.Flags) ?? [];
      const bit = (i: number): boolean => !!((bits[i >> 3] ?? 0) >> (i & 7) & 1);
      ls.forEach((s, i) => ch.local.push(this.insert(end(s, at.grid, at.chunk), end(lt[i]!, at.grid, at.chunk), bit(i))));
      rs.forEach((s, i) => {
        const src = end(s, (s.GridPersistentIndex as number | undefined) ?? at.grid, (s.ChunkIndex as ChunkKey | undefined) ?? at.chunk);
        ch.remote.push(this.insert(src, end(rt[i]!, at.grid, at.chunk), bit(ls.length + i)));
      });
    }
    for (const w of this.all.values()) this.loaded.add(w);
  }

  private loadChips(): void {
    const g = this.ctx.global, names = g.EntityTypeNames ?? [];
    for (const [path, bytes] of this.ctx.files) {
      if (!/^World\/0\/Entities\/Chunks\/[^/]+\.mps$/.test(path)) continue;
      const root = decodeMps(bytes, this.ctx.schemaFor(path));
      const counters = (root.TypeCounters as { TypeIndex: number; NumEntities: number }[] | undefined) ?? [];
      const ids = (root.PersistentIndices as number[] | undefined) ?? [];
      let i = 0;
      for (const c of counters) {
        for (let n = 0; n < c.NumEntities; n++, i++) {
          if (/Microchip/.test(names[c.TypeIndex] ?? '')) this.chips.set(ids[i]!, { grid: ids[i]!, parent: null, chipBrick: null });
        }
      }
    }
    for (const ch of this.components.chunks) {
      const bricks = ch.file.root.MicrochipBrickIndices as number[] | undefined, grids = ch.file.root.MicrochipBrickGridReferences as number[] | undefined;
      if (!bricks || !grids) continue;
      grids.forEach((inner, j) => this.chips.set(inner, { grid: inner, parent: ch.grid, chipBrick: { grid: ch.grid, chunk: ch.chunk, brick: bricks[j]! } }));
    }
  }

  private insert(source: WireEnd, target: WireEnd, pending: boolean): Wire {
    const w: Wire = { id: this.nextId++, source, target, pending };
    this.all.set(w.id, w);
    addTo(this.into, endKey(target), w);
    addTo(this.inBrick, brickKey(target), w);
    addTo(this.outBrick, brickKey(source), w);
    for (const [e, dir] of [[source, 'outputs'], [target, 'inputs']] as const) {
      let p = this.observed.get(e.component);
      if (!p) this.observed.set(e.component, (p = { inputs: new Set(), outputs: new Set() }));
      p[dir].add(e.port);
    }
    return w;
  }

  // ------------------------------------------------------------------ queries

  wires(): Wire[] {
    return [...this.all.values()];
  }

  get size(): number {
    return this.all.size;
  }

  wire(id: number): Wire | undefined {
    return this.all.get(id);
  }

  /** Wires into and out of a brick. */
  wiresOf(ref: BrickRef): { incoming: Wire[]; outgoing: Wire[] } {
    const k = brickKey(ref);
    return { incoming: [...(this.inBrick.get(k) ?? [])], outgoing: [...(this.outBrick.get(k) ?? [])] };
  }

  /** Wires into one port (0 or 1 in a valid save). */
  wiresInto(end: WireEnd): Wire[] {
    return [...(this.into.get(endKey(end)) ?? [])];
  }

  /** Bricks that feed this one, nearest first (breadth-first over incoming wires). */
  upstream(ref: BrickRef, maxDepth = Infinity): { brick: BrickRef; depth: number }[] {
    return this.walk(ref, maxDepth, (k) => this.inBrick.get(k) ?? [], (w) => w.source);
  }

  /** Bricks this one feeds, nearest first. */
  downstream(ref: BrickRef, maxDepth = Infinity): { brick: BrickRef; depth: number }[] {
    return this.walk(ref, maxDepth, (k) => this.outBrick.get(k) ?? [], (w) => w.target);
  }

  private walk(ref: BrickRef, maxDepth: number, next: (k: string) => Wire[], far: (w: Wire) => WireEnd): { brick: BrickRef; depth: number }[] {
    const seen = new Set([brickKey(ref)]), out: { brick: BrickRef; depth: number }[] = [];
    let frontier = [ref];
    for (let depth = 1; frontier.length && depth <= maxDepth; depth++) {
      const nf: BrickRef[] = [];
      for (const b of frontier) {
        for (const w of next(brickKey(b))) {
          const e = far(w), k = brickKey(e);
          if (seen.has(k)) continue;
          seen.add(k);
          const brick = { grid: e.grid, chunk: e.chunk, brick: e.brick };
          out.push({ brick, depth });
          nf.push(brick);
        }
      }
      frontier = nf;
    }
    return out;
  }

  /** Ports known for a component type: seen on this save's wires, plus the lookup's. */
  ports(componentType: string): PortSet {
    const o = this.observed.get(componentType), l = this.lookup?.(componentType);
    const inputs = new Set([...(o?.inputs ?? []), ...(l?.inputs ?? [])]), outputs = new Set([...(o?.outputs ?? []), ...(l?.outputs ?? [])]);
    return { inputs: [...inputs], outputs: [...outputs] };
  }

  /** Port names the save's GlobalData lists. */
  portNames(): string[] {
    return [...(this.ctx.global.ComponentWirePortNames ?? [])];
  }

  /** The chip grid a grid is (or null), i.e. its microchip context. */
  chipContext(grid: number): number | null {
    return this.chips.has(grid) ? grid : null;
  }

  // ------------------------------------------------------------------ validation

  /** Issues adding this wire would cause (an empty list means it's fine). */
  check(source: WireEnd, target: WireEnd): WireIssue[] {
    const issues: WireIssue[] = [];
    for (const [e, role] of [[source, 'source'], [target, 'target']] as const) {
      if (!this.components.onBrick(e).some((c) => c.type === e.component)) {
        issues.push({ code: 'missing-component', severity: 'error', message: `${role} brick ${brickKey(e)} has no ${e.component} component` });
      }
    }
    if (this.wiresInto(target).length) issues.push({ code: 'fan-in', severity: 'error', message: `${target.component}.${target.port} on ${brickKey(target)} already has a wire (no fan-in)` });
    issues.push(...this.boundaryIssues(source, target), ...this.portIssues(source, target));
    return issues;
  }

  private parentContext(chip: number): number | null {
    const p = this.chips.get(chip)?.parent;
    return p == null ? null : this.chipContext(p);
  }

  private boundaryIssues(s: WireEnd, t: WireEnd): WireIssue[] {
    const cs = this.chipContext(s.grid), ct = this.chipContext(t.grid);
    if (cs === ct) return [];
    const intoChip = CHIP_INPUT.test(t.component) && t.port === CHIP_IN_PORT;
    const outOfChip = CHIP_OUTPUT.test(s.component) && s.port === CHIP_OUT_PORT;
    // Straight from outside into a gate inside the chip is fine; into a chip I/O brick only via RER_Input.
    const entersOk = intoChip || !(CHIP_INPUT.test(t.component) || CHIP_OUTPUT.test(t.component));
    const bad = (why: string): WireIssue[] => [{ code: 'chip-boundary', severity: this.boundarySeverity, message: `wire ${brickKey(s)} -> ${brickKey(t)} ${why}` }];
    // Down one level into a chip, up one level out of a chip, or chip -> sibling chip.
    if (ct !== null && this.parentContext(ct) === cs) return entersOk ? [] : bad(`enters chip grid ${ct} on a chip I/O port other than a MicrochipInput's ${CHIP_IN_PORT}`);
    if (cs !== null && this.parentContext(cs) === ct) return outOfChip ? [] : bad(`leaves chip grid ${cs} without coming from a MicrochipOutput's ${CHIP_OUT_PORT}`);
    if (cs !== null && ct !== null && this.parentContext(cs) === this.parentContext(ct)) {
      return entersOk && outOfChip ? [] : bad(`joins two chips without leaving through a MicrochipOutput's ${CHIP_OUT_PORT}`);
    }
    return bad('crosses more than one microchip boundary');
  }

  private portIssues(s: WireEnd, t: WireEnd): WireIssue[] {
    const out: WireIssue[] = [];
    for (const [e, want, other] of [[s, 'outputs', 'inputs'], [t, 'inputs', 'outputs']] as const) {
      const p = this.ports(e.component);
      if (!p.inputs.length && !p.outputs.length) continue;   // nothing known about this type
      if (p[want].includes(e.port)) continue;
      if (p[other].includes(e.port)) out.push({ code: 'port-direction', severity: 'warning', message: `${e.component}.${e.port} is known only as an ${other === 'inputs' ? 'input' : 'output'}` });
      else out.push({ code: 'unknown-port', severity: 'warning', message: `${e.component} has no known port ${e.port}` });
    }
    return out;
  }

  /** Every issue in the graph as it stands (fan-in, chip boundaries, missing components, ports). */
  validate(): WireIssue[] {
    const issues: WireIssue[] = [];
    for (const [, ws] of this.into) {
      if (ws.length > 1) for (const w of ws.slice(1)) issues.push({ code: 'fan-in', severity: 'error', message: `${endKey(w.target)} has ${ws.length} wires`, wire: w });
    }
    for (const w of this.all.values()) {
      for (const [e, role] of [[w.source, 'source'], [w.target, 'target']] as const) {
        if (!this.components.onBrick(e).some((c) => c.type === e.component)) issues.push({ code: 'missing-component', severity: 'error', message: `${role} ${brickKey(e)} has no ${e.component}`, wire: w });
      }
      for (const i of this.boundaryIssues(w.source, w.target)) issues.push({ ...i, wire: w });
    }
    return issues;
  }

  // ------------------------------------------------------------------ edits

  /**
   * Adds a wire after check(); throws WireError when there are errors (warnings are allowed).
   * `force` skips the check (an undo putting back a wire the save already had).
   */
  addWire(source: WireEnd, target: WireEnd, opts: { force?: boolean; pending?: boolean } = {}): Wire {
    const errors = opts.force ? [] : this.check(source, target).filter((i) => i.severity === 'error');
    if (errors.length) throw new WireError(errors);
    const s = { ...source, chunk: { ...source.chunk } }, t = { ...target, chunk: { ...target.chunk } };
    const ch = this.chunkFor(t);
    const w = this.insert(s, t, !!opts.pending);
    (sameChunk(s, t) ? ch.local : ch.remote).push(w);
    ch.dirty = true;
    for (const p of [s.port, t.port]) this.portIndex(p);
    return w;
  }

  removeWire(id: number): boolean {
    const w = this.all.get(id);
    if (!w) return false;
    this.all.delete(id);
    if (this.loaded.has(w)) this.removed.push(w);
    dropFrom(this.into, endKey(w.target), w);
    dropFrom(this.inBrick, brickKey(w.target), w);
    dropFrom(this.outBrick, brickKey(w.source), w);
    const ch = this.chunks.get(chunkId(w.target.grid, w.target.chunk))!;
    for (const l of [ch.local, ch.remote]) {
      const i = l.indexOf(w);
      if (i >= 0) l.splice(i, 1);
    }
    ch.dirty = true;
    return true;
  }

  private chunkFor(t: BrickRef): WireChunk {
    const id = chunkId(t.grid, t.chunk);
    let ch = this.chunks.get(id);
    if (!ch) {
      const path = chunkPath(t.grid, 'Wires', t.chunk);
      ch = { path, grid: t.grid, chunk: t.chunk, schema: this.ctx.schemaFor(path), root: null, local: [], remote: [], dirty: true };
      this.chunks.set(id, ch);
    }
    return ch;
  }

  private portIndex(name: string): number {
    const g = this.ctx.global;
    const m = /^#(\d+)$/.exec(name);
    if (m) return +m[1]!;
    const list = (g.ComponentWirePortNames ??= []);
    let i = list.indexOf(name);
    if (i < 0) {
      i = list.push(name) - 1;
      this.globalDirty = true;
    }
    return i;
  }

  private typeIndex(name: string): number {
    const m = /^#(\d+)$/.exec(name);
    if (m) return +m[1]!;
    const i = (this.ctx.global.ComponentTypeNames ?? []).indexOf(name);
    if (i < 0) throw new Error(`component type ${name} is not in GlobalData`);
    return i;
  }

  /** True when a wire was added or removed. */
  get dirty(): boolean {
    return this.globalDirty || [...this.chunks.values()].some((c) => c.dirty);
  }

  private elementStruct(schema: Schema, field: string): string | null {
    const t = schema.S.get(schema.root)?.find(([f]) => f === field)?.[1];
    return t && typeof t !== 'string' && (t.kind === 'array' || t.kind === 'packed') && typeof t.of === 'string' ? t.of : null;
  }

  private record(schema: Schema, field: string, e: WireEnd, remote: boolean): MpsObject {
    const st = this.elementStruct(schema, field);
    const known: MpsObject = { BrickIndexInChunk: e.brick, ComponentTypeIndex: this.typeIndex(e.component), PortIndex: this.portIndex(e.port) };
    if (remote) Object.assign(known, { GridPersistentIndex: e.grid, ChunkIndex: { X: e.chunk.X, Y: e.chunk.Y, Z: e.chunk.Z } });
    if (!st) return known;
    const out: MpsObject = {};
    for (const [f, ft] of schema.S.get(st) ?? []) out[f] = f in known ? known[f] : defaultValue(schema, ft as SchemaType);
    return out;
  }

  /** A wire chunk's root rebuilt from the model. */
  private buildRoot(ch: WireChunk): MpsObject {
    const s = ch.schema, root: MpsObject = {};
    const n = ch.local.length + ch.remote.length;
    for (const [f, ft] of s.S.get(s.root) ?? []) {
      switch (f) {
        case 'LocalWireSources': root[f] = ch.local.map((w) => this.record(s, f, w.source, false)); break;
        case 'LocalWireTargets': root[f] = ch.local.map((w) => this.record(s, f, w.target, false)); break;
        case 'RemoteWireSources': root[f] = ch.remote.map((w) => this.record(s, f, w.source, true)); break;
        case 'RemoteWireTargets': root[f] = ch.remote.map((w) => this.record(s, f, w.target, false)); break;
        case 'PendingPropagationFlags': {
          if (!ch.dirty && ch.root) { root[f] = ch.root[f]; break; }
          const wires = [...ch.local, ...ch.remote], flags: number[] = [];
          if (wires.some((w) => w.pending)) {
            for (let i = 0; i < Math.ceil(n / 8); i++) flags.push(0);
            wires.forEach((w, i) => { if (w.pending) flags[i >> 3]! |= 1 << (i & 7); });
          }
          root[f] = { Flags: flags };
          break;
        }
        default: root[f] = ch.root && f in ch.root ? ch.root[f] : defaultValue(s, ft);
      }
    }
    return root;
  }

  /**
   * The save's files with edited wire chunks rewritten, the grids' ChunkIndex NumWires updated,
   * and GlobalData's port list extended when a new port name was used. A wire chunk left with no
   * wires is removed. `force` rebuilds every wire chunk from the model (round-trip checks).
   */
  encode(opts: { force?: boolean; into?: FileMap } = {}): FileMap {
    const out: FileMap = opts.into ?? new Map(this.ctx.files);
    const counts = new Map<number, Map<string, number>>();
    for (const ch of this.chunks.values()) {
      if (!ch.dirty && !opts.force) continue;
      const n = ch.local.length + ch.remote.length;
      if (n === 0 && ch.dirty) out.delete(ch.path);
      else out.set(ch.path, encodeMps(this.buildRoot(ch), ch.schema));
      if (ch.dirty) {
        let m = counts.get(ch.grid);
        if (!m) counts.set(ch.grid, (m = new Map()));
        m.set(chunkName(ch.chunk), n);
      }
    }
    for (const [grid, m] of counts) {
      const p = `${WORLD}Bricks/Grids/${grid}/ChunkIndex.mps`, bytes = out.get(p);
      if (!bytes) throw new Error(`grid ${grid} has no ChunkIndex`);
      const schema = this.ctx.schemaFor(p), ci = decodeMps(bytes, schema);
      const keys = (ci.Chunk3DIndices as ChunkKey[]).map(chunkName), nw = ci.NumWires as number[] | undefined;
      if (!nw) continue;
      for (const [k, n] of m) {
        const j = keys.indexOf(k);
        if (j < 0) throw new Error(`grid ${grid} ChunkIndex has no chunk ${k}`);
        nw[j] = n;
      }
      out.set(p, encodeMps(ci, schema));
    }
    if (this.globalDirty) out.set(WORLD + 'GlobalData.mps', encodeMps(this.ctx.global, this.ctx.globalSchema));
    this.updateOwnerCounts(out);
    return out;
  }

  /** Owners.WireCounts: +1 per added wire and -1 per removed one, on the target brick's owner. */
  private updateOwnerCounts(out: FileMap): void {
    const added = [...this.all.values()].filter((w) => !this.loaded.has(w));
    const op = WORLD + 'Owners.mps', bytes = out.get(op);
    if ((!added.length && !this.removed.length) || !bytes) return;
    const schema = this.ctx.schemaFor(op), owners = decodeMps(bytes, schema), counts = owners.WireCounts as number[] | undefined;
    if (!counts) return;
    const chunks = new Map<string, number[]>();
    const ownerOf = (r: BrickRef): number => {
      const p = chunkPath(r.grid, 'Chunks', r.chunk);
      let o = chunks.get(p);
      if (!o) {
        const b = this.ctx.files.get(p);
        o = b ? ((decodeMps(b, this.ctx.schemaFor(p)).OwnerIndices as number[] | undefined) ?? []) : [];
        chunks.set(p, o);
      }
      return o[r.brick] ?? 0;
    };
    for (const w of added) counts[ownerOf(w.target)] = (counts[ownerOf(w.target)] ?? 0) + 1;
    for (const w of this.removed) counts[ownerOf(w.target)] = Math.max(0, (counts[ownerOf(w.target)] ?? 0) - 1);
    out.set(op, encodeMps(owners, schema));
  }
}

/** Reads a save's wire graph (and its components, unless given). */
export function loadWires(files: FileMap, opts: WireOptions = {}): WireGraph {
  const ctx = opts.components?.ctx ?? saveContext(files, opts);
  return new WireGraph(ctx, opts);
}
