// What changed between two states of a .brdb world (backlog W-05): files, bricks, components and
// wires. Pure data, no DOM.
//
//   files       every path added, removed or changed, by content id / size + BLAKE3 hash (no blob read)
//   totals      bricks, components and wires per state, summed from every grid's ChunkIndex
//   bricks      decoded only for the brick chunk files that differ (both sides), matched brick by brick:
//                 same asset, size, grid position and orientation byte = the same brick; then
//                 equal paint / owner / flags = unchanged, else "changed"; the rest are added or removed.
//               A moved brick therefore counts as one removed plus one added.
//   marks       the added / removed / changed bricks of the main grid (Grids/1), for highlighting
//
// Lazy worlds (brdblazy.ts) load only the chunk indexes and the differing brick chunks (with the
// schema and GlobalData each was written with); over `budgetBytes` of chunk data the brick match is
// skipped (bricks.counted false) unless `force`.

import type { BrdbFileRow, BrdbFileTable, BrdbTree, TreeDiff } from './brdb.ts';
import { LazyBrdbTree, runLoaded } from './brdblazy.ts';
import { decodeWritten, writtenGlobalData, type SaveView } from './saveview.ts';
import { decodeBrickChunk, type BrickChunk, type GlobalData, type PlainBrick } from './world.ts';

const GRID_FILE = /^World\/0\/Bricks\/Grids\/([^/]+)\/(Chunks|Components|Wires)\/([^/]+)\.mps$/;
const INDEX_RE = /^World\/0\/Bricks\/Grids\/([^/]+)\/ChunkIndex\.mps$/;

export interface Totals { bricks: number; components: number; wires: number }

export interface BrickDiff {
  added: number;
  removed: number;
  changed: number;
  /** false when the brick match was skipped (over the byte budget); the counts are then 0 */
  counted: boolean;
  /** uncompressed bytes of the brick chunks the match reads (both sides) */
  bytes: number;
}

/** A brick of the diff, in grid-local units (= world units for the main grid). */
export interface MarkBrick extends PlainBrick { grid: string }

export interface RevisionDiff {
  files: TreeDiff;
  /** null for an empty "before" (the first revision) */
  before: Totals | null;
  after: Totals;
  /** brick / component / wire chunk files that differ (added, removed or changed) */
  chunks: { bricks: number; components: number; wires: number };
  bricks: BrickDiff;
  /** main-grid bricks per kind (capped at markCap each; `truncated` says a list was cut) */
  marks: { added: MarkBrick[]; removed: MarkBrick[]; changed: MarkBrick[]; truncated: boolean };
}

export interface RevisionDiffOptions {
  /** brick chunk bytes (both sides, uncompressed) above which the brick match is skipped; default 64 MB */
  budgetBytes?: number;
  /** run the brick match whatever its size */
  force?: boolean;
  /** most marks kept per kind; default 20,000 */
  markCap?: number;
  /** decides file rows the hashes can't (default: changed) */
  undecided?: (x: BrdbFileRow, y: BrdbFileRow) => boolean;
}

interface XYZ { X: number; Y: number; Z: number }

/** Every grid's ChunkIndex: totals and chunk name -> centre. */
function indexes(view: SaveView): { totals: Totals; centres: Map<string, Map<string, number[]>> } {
  const totals: Totals = { bricks: 0, components: 0, wires: 0 }, centres = new Map<string, Map<string, number[]>>();
  for (const p of view.paths()) {
    const m = INDEX_RE.exec(p);
    if (!m) continue;
    const g = m[1]!, ci = decodeWritten(view, p).root as Record<string, unknown>, dflt = g === '1' ? 0 : 1024;
    const idx = (ci.Chunk3DIndices as XYZ[] | undefined) ?? [], offs = ci.ChunkOffsets as XYZ[] | undefined, sizes = ci.ChunkSizes as number[] | undefined;
    const sum = (k: string): number => ((ci[k] as number[] | undefined) ?? []).reduce((a, b) => a + (b ?? 0), 0);
    totals.bricks += sum('NumBricks'); totals.components += sum('NumComponents'); totals.wires += sum('NumWires');
    const c = new Map<string, number[]>();
    idx.forEach((k, j) => {
      const o = offs?.[j] ?? { X: dflt, Y: dflt, Z: dflt }, s = sizes?.[j] ?? 2048;
      c.set(`${k.X}_${k.Y}_${k.Z}`, [k.X * s + s / 2 + o.X, k.Y * s + s / 2 + o.Y, k.Z * s + s / 2 + o.Z]);
    });
    centres.set(g, c);
  }
  return { totals, centres };
}

/** Centre of chunk `name` of grid `g`: from the index, else the defaults (2048-unit chunks, offset 0 / 1024). */
function centreOf(centres: Map<string, Map<string, number[]>>, g: string, name: string): number[] {
  const hit = centres.get(g)?.get(name);
  if (hit) return hit;
  const k = name.split('_').map(Number), d = g === '1' ? 0 : 1024;
  return k.map((v) => v * 2048 + 1024 + d);
}

function chunkBricks(view: SaveView, path: string, centre: readonly number[]): PlainBrick[] {
  if (!view.has(path)) return [];
  const f = decodeWritten(view, path), g = writtenGlobalData<GlobalData>(view, path);
  if (!g) throw new Error('no GlobalData for ' + path);
  return decodeBrickChunk(f.root as BrickChunk, f.schema, g, centre);
}

const keyOf = (b: PlainBrick): string => `${b.asset}|${b.size ? b.size.join(',') : '-'}|${b.pos.join(',')}|${b.orient}`;
const valueOf = (b: PlainBrick): string =>
  `${b.color.join(',')}|${b.material}|${b.owner ?? 0}|${b.originalOwner ?? b.owner ?? 0}|${b.flags ? Object.entries(b.flags).sort().map(([k, v]) => k + v).join() : ''}`;

/** Matches two brick lists of one chunk (see the header). Calls `mark` for each brick that differs. */
export function matchBricks(before: readonly PlainBrick[], after: readonly PlainBrick[], mark?: (kind: 'added' | 'removed' | 'changed', b: PlainBrick) => void): { added: number; removed: number; changed: number } {
  const old = new Map<string, { v: string; b: PlainBrick }[]>();
  for (const b of before) {
    const k = keyOf(b);
    let l = old.get(k);
    if (!l) old.set(k, (l = []));
    l.push({ v: valueOf(b), b });
  }
  const rest: PlainBrick[] = [];
  for (const b of after) {
    const l = old.get(keyOf(b)), v = valueOf(b), i = l ? l.findIndex((e) => e.v === v) : -1;
    if (i >= 0) l!.splice(i, 1); else rest.push(b);
  }
  let added = 0, changed = 0, removed = 0;
  for (const b of rest) {
    const l = old.get(keyOf(b));
    if (l?.length) { l.shift(); changed++; mark?.('changed', b); } else { added++; mark?.('added', b); }
  }
  for (const l of old.values()) for (const e of l) { removed++; mark?.('removed', e.b); }
  return { added, removed, changed };
}

const sizeIn = (t: BrdbTree, p: string): number => {
  if (!t.has(p)) return 0;
  if (t instanceof LazyBrdbTree) return t.sizeOf(p) ?? 0;
  return t.get(p)?.length ?? 0;
};

/** Runs a synchronous reader over a tree, loading what a lazy one is missing. */
async function over<T>(t: BrdbTree, fn: (v: SaveView) => T): Promise<T> {
  return t instanceof LazyBrdbTree ? runLoaded(t, fn) : fn(t);
}

/**
 * What changed from tree `a` (null = nothing, as before a first revision) to tree `b`, both of
 * `world`. A lazy world's loaded blobs stay loaded; the caller unloads them (unloadBlobs).
 */
export async function revisionDiff(world: BrdbFileTable, a: BrdbTree | null, b: BrdbTree, opts: RevisionDiffOptions = {}): Promise<RevisionDiff> {
  const files = world.diffTrees(a, b, opts.undecided);
  const chunks = { bricks: 0, components: 0, wires: 0 }, brickPaths: { path: string; grid: string; name: string }[] = [];
  for (const p of [...files.added, ...files.removed, ...files.changed]) {
    const m = GRID_FILE.exec(p);
    if (!m) continue;
    if (m[2] === 'Chunks') { chunks.bricks++; brickPaths.push({ path: p, grid: m[1]!, name: m[3]! }); }
    else if (m[2] === 'Components') chunks.components++;
    else chunks.wires++;
  }
  // chunk indexes of both sides (small), with the schemas they were written with
  const indexPaths = (t: BrdbTree): string[] => t.paths().filter((p) => INDEX_RE.test(p));
  if (b instanceof LazyBrdbTree) await b.loadWritten(indexPaths(b));
  if (a instanceof LazyBrdbTree) await a.loadWritten(indexPaths(a));
  const ib = await over(b, indexes), ia = a ? await over(a, indexes) : null;

  const bytes = brickPaths.reduce((n, c) => n + sizeIn(b, c.path) + (a ? sizeIn(a, c.path) : 0), 0);
  const bricks: BrickDiff = { added: 0, removed: 0, changed: 0, counted: false, bytes };
  const cap = opts.markCap ?? 20_000, marks: RevisionDiff['marks'] = { added: [], removed: [], changed: [], truncated: false };
  if (opts.force || bytes <= (opts.budgetBytes ?? 64 << 20)) {
    bricks.counted = true;
    for (const c of brickPaths) {
      const inB = b.has(c.path), inA = !!a?.has(c.path);
      if (inB && b instanceof LazyBrdbTree) await b.loadWritten([c.path]);
      if (inA && a instanceof LazyBrdbTree) await a.loadWritten([c.path]);
      const after = inB ? await over(b, (v) => chunkBricks(v, c.path, centreOf(ib.centres, c.grid, c.name))) : [];
      const before = inA && ia ? await over(a!, (v) => chunkBricks(v, c.path, centreOf(ia.centres, c.grid, c.name))) : [];
      const mark = c.grid === '1' ? (kind: 'added' | 'removed' | 'changed', x: PlainBrick): void => {
        const l = marks[kind];
        if (l.length < cap) l.push({ ...x, grid: c.grid }); else marks.truncated = true;
      } : undefined;
      const r = matchBricks(before, after, mark);
      bricks.added += r.added; bricks.removed += r.removed; bricks.changed += r.changed;
      // a lazy world keeps only what it needs right now
      if (b instanceof LazyBrdbTree) b.unload([c.path]);
      if (a instanceof LazyBrdbTree) a.unload([c.path]);
    }
  }
  return { files, before: ia?.totals ?? null, after: ib.totals, chunks, bricks, marks };
}

/** One line for the status / panel: "+12 −3 ~4 bricks · components 10 → 12 · wires 4 → 4 · 7 files". */
export function diffSummary(d: RevisionDiff): string {
  const nf = d.files.added.length + d.files.removed.length + d.files.changed.length;
  if (!nf) return 'no changes';
  const n = (v: number): string => v.toLocaleString('en-US');
  const arrow = (k: keyof Totals): string => (d.before ? `${n(d.before[k])} → ${n(d.after[k])}` : n(d.after[k]));
  const parts = [
    d.bricks.counted ? `+${n(d.bricks.added)} −${n(d.bricks.removed)} ~${n(d.bricks.changed)} bricks` : `bricks ${arrow('bricks')} (not matched)`,
    `components ${arrow('components')}`,
    `wires ${arrow('wires')}`,
    `${n(nf)} file${nf === 1 ? '' : 's'}`,
  ];
  return parts.join(' · ');
}
