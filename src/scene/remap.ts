// Components and wires keep pointing at their bricks when a save is written (follow-up of C-02 /
// C-03, done with E-02). They name a brick by its index in its 2048-unit save chunk:
//   - component chunks (Grids/<g>/Components/x_y_z.mps): every root array named *BrickIndices
//     (ComponentBrickIndices, JointBrickIndices, MicrochipBrickIndices), indices into the same chunk;
//   - wire chunks (Grids/<g>/Wires/x_y_z.mps, stored with the TARGET): BrickIndexInChunk of each
//     end; a remote source names its own grid and chunk.
// Adding, deleting or moving bricks renumbers a chunk's bricks, so the writer maps every such
// index of grid 1 from the save as opened (load order) to the bricks being written (by their load
// order, `seq`). A brick that carries components may move within its chunk; the editor refuses to
// delete it or move it into another chunk (see editor/selectops.ts), so every index still has a
// brick in the same chunk. Anything else is reported, never guessed.

import type { FileMap } from '../format/brz.ts';
import { decodeMps, encodeMps, type MpsObject } from '../format/schema.ts';
import { extractBricks } from '../format/world.ts';
import { chunkName, parseChunkPath, saveContext, type ChunkKey } from './components.ts';
import type { SeqBrick } from './load.ts';

const SAVE_CHUNK = 2048;
export const saveChunkOf = (p: readonly number[]): string => p.map((v) => Math.floor(Math.round(v) / SAVE_CHUNK)).join('_');

/** Load order of a save's grid-1 bricks: chunk -> seq of each index in it. */
export function loadOrderIndex(template: FileMap): Map<string, number[]> {
  const m = new Map<string, number[]>();
  extractBricks(template).bricks.forEach((b, seq) => {
    const k = saveChunkOf(b.pos);
    let l = m.get(k);
    if (!l) m.set(k, (l = []));
    l.push(seq);
  });
  return m;
}

/** Where each loaded brick (by seq) ends up in `ordered` (the write order): its chunk and index. */
function writtenIndex(ordered: readonly SeqBrick[]): Map<number, { chunk: string; index: number }> {
  const counts = new Map<string, number>(), out = new Map<number, { chunk: string; index: number }>();
  for (const b of ordered) {
    const k = saveChunkOf(b.pos), n = counts.get(k) ?? 0;
    counts.set(k, n + 1);
    if (b.seq !== undefined) out.set(b.seq, { chunk: k, index: n });
  }
  return out;
}

/** Seqs of grid-1 bricks that carry components (or joints / microchips) in a save. */
export function componentSeqs(template: FileMap): Set<number> {
  const order = loadOrderIndex(template), out = new Set<number>();
  let ctx: ReturnType<typeof saveContext> | null = null;
  for (const [path, bytes] of template) {
    const at = parseChunkPath(path);
    if (!at || at.grid !== 1 || at.kind !== 'Components') continue;
    ctx ??= saveContext(template);
    const root = decodeMps(bytes, ctx.schemaFor(path)), seqs = order.get(chunkName(at.chunk)) ?? [];
    for (const [f, v] of Object.entries(root)) {
      if (!/BrickIndices$/.test(f) || !Array.isArray(v)) continue;
      for (const i of v as number[]) { const s = seqs[i]; if (s !== undefined) out.add(s); }
    }
  }
  return out;
}

export interface RemapResult { files: FileMap; rewritten: string[]; problems: string[] }

/**
 * Rewrites the grid-1 brick indices of `files` (a rebuilt save) so its components and wires name
 * the same bricks as in `template` (the save as opened). `ordered`: the bricks in the order they
 * were written, loaded ones with their seq.
 */
export function remapBrickRefs(template: FileMap, files: FileMap, ordered: readonly SeqBrick[]): RemapResult {
  const out: FileMap = new Map(files), rewritten: string[] = [], problems = new Set<string>();
  const paths = [...files.keys()].filter((p) => { const at = parseChunkPath(p); return at && (at.kind === 'Components' || at.kind === 'Wires'); });
  if (!paths.length) return { files: out, rewritten, problems: [] };
  const order = loadOrderIndex(template), now = writtenIndex(ordered);
  /** new index of brick `i` of grid-1 chunk `chunk`, or i (with a problem noted) when it has none */
  const map = (chunk: string, i: number, where: string): number => {
    const seq = order.get(chunk)?.[i];
    if (seq === undefined) { problems.add(`${where} names brick ${i} of chunk ${chunk}, which the save doesn't have`); return i; }
    const w = now.get(seq);
    if (!w) { problems.add(`${where} names a brick that was deleted`); return i; }
    if (w.chunk !== chunk) { problems.add(`${where} names a brick that moved to chunk ${w.chunk}`); return i; }
    return w.index;
  };
  const ctx = saveContext(files);
  for (const path of paths) {
    const at = parseChunkPath(path)!, schema = ctx.schemaFor(path), root = decodeMps(files.get(path)!, schema), k = chunkName(at.chunk);
    let changed = false;
    const fix = (rec: MpsObject, chunk: string): void => {
      const i = rec.BrickIndexInChunk as number, j = map(chunk, i, path);
      if (j !== i) { rec.BrickIndexInChunk = j; changed = true; }
    };
    if (at.kind === 'Components') {
      if (at.grid !== 1) continue;
      for (const [f, v] of Object.entries(root)) {
        if (!/BrickIndices$/.test(f) || !Array.isArray(v)) continue;
        const a = v as number[];
        for (let n = 0; n < a.length; n++) { const j = map(k, a[n]!, path); if (j !== a[n]) { a[n] = j; changed = true; } }
      }
    } else {
      if (at.grid === 1) {
        for (const f of ['LocalWireSources', 'LocalWireTargets', 'RemoteWireTargets']) for (const r of (root[f] as MpsObject[] | undefined) ?? []) fix(r, k);
      }
      for (const r of (root.RemoteWireSources as MpsObject[] | undefined) ?? []) {
        const g = (r.GridPersistentIndex as number | undefined) ?? at.grid;
        if (g === 1) fix(r, chunkName((r.ChunkIndex as ChunkKey | undefined) ?? at.chunk));
      }
    }
    if (changed) { out.set(path, encodeMps(root, schema)); rewritten.push(path); }
  }
  return { files: out, rewritten, problems: [...problems] };
}
