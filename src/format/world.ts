// Bricks <-> save files, for one brick grid (default Grid 1). Ported from tools/brzwriter.js.
//
// How the viewer saves edits:
//   const files = readBrz(buf);                              // keep the loaded Map(path -> bytes)
//   const { bricks } = extractBricks(files);                 // plain list (or build your own)
//   ...edit bricks...
//   const out = rebuildFromLoaded(files, bricks);            // new Map with the grid's chunks rewritten
//   const brz = writeBrz(out.files);                         // method 0 (uncompressed); out.warnings lists drops
//
// Every file the rebuild doesn't touch is copied verbatim, so unknown save content (entities,
// other grids, future files) passes through unchanged.

import type { FileMap } from './brz.ts';
import { decodeMps, encodeMps, parseSchema, type MpsObject, type Schema } from './schema.ts';

/** One brick as plain data. Positions are integer world units; sizes are local half-extents. */
export interface PlainBrick {
  asset: string;
  /** Local half-extents; null for fixed-asset (B_*) bricks. */
  size: [number, number, number] | null;
  pos: [number, number, number];
  /** dir << 2 | rot */
  orient: number;
  /** R, G, B bytes as stored, then material intensity 0..10. */
  color: [number, number, number, number];
  material: string;
  owner?: number;
  originalOwner?: number;
  /** e.g. {CollisionFlags_Player: 0}; missing keys (or no flags) mean 1, as the game writes. */
  flags?: Record<string, number>;
}

interface XYZ { X: number; Y: number; Z: number }
interface Colour { R: number; G: number; B: number; A: number }

export interface GlobalData extends MpsObject {
  BasicBrickAssetNames: string[];
  ProceduralBrickAssetNames: string[];
  MaterialAssetNames: string[];
}

export interface ChunkIndex extends MpsObject {
  Chunk3DIndices: XYZ[];
  ChunkOffsets: XYZ[];
  ChunkSizes: number[];
  NumBricks: number[];
  NumComponents: number[];
  NumWires: number[];
}

export interface BrickChunk extends MpsObject {
  ProceduralBrickStartingIndex: number;
  BrickSizeCounters: { AssetIndex: number; NumSizes: number }[];
  BrickSizes: XYZ[];
  BrickTypeIndices: number[];
  OwnerIndices: number[];
  /** Missing in older saves (e.g. CL12560 and 2025-09 prefabs): the owner then stands in. */
  OriginalOwnerIndices?: number[];
  RelativePositions: XYZ[];
  Orientations: number[];
  MaterialIndices: number[];
  ColorsAndAlphas: Colour[];
  bColorsAreLinear?: boolean;
}

export interface WorldOptions {
  /** Brick grid folder name; default "1". */
  grid?: string;
  chunkSize?: number;
}

const W = 'World/0/';
const AX = ['X', 'Y', 'Z'] as const;

export interface WorldContext {
  GP: string;
  globalSchema: Schema;
  idxSchema: Schema;
  chunkSchema: Schema;
  global: GlobalData;
  ci: ChunkIndex | null;
  /** Chunk fields of type BRSavedBitFlags (collision flags and so on). */
  flagFields: string[];
}

function rootFields(s: Schema): string[] {
  return s.S.get(s.root)!.map(([f]) => f);
}

function loadCtx(files: FileMap, opts: WorldOptions): WorldContext {
  const get = (p: string): Uint8Array => {
    const f = files.get(p);
    if (!f) throw new Error('missing ' + p);
    return f;
  };
  const grid = opts.grid ?? '1', GP = `${W}Bricks/Grids/${grid}/`;
  const globalSchema = parseSchema(get(W + 'GlobalData.schema'));
  const idxSchema = parseSchema(get(W + 'Bricks/ChunkIndexShared.schema'));
  const chunkSchema = parseSchema(get(W + 'Bricks/ChunksShared.schema'));
  const global = decodeMps<GlobalData>(get(W + 'GlobalData.mps'), globalSchema);
  const ciBytes = files.get(GP + 'ChunkIndex.mps');
  const ci = ciBytes ? decodeMps<ChunkIndex>(ciBytes, idxSchema) : null;
  const flagFields = brickFlagFields(chunkSchema);
  return { GP, globalSchema, idxSchema, chunkSchema, global, ci, flagFields };
}

const chunkPath = (GP: string, k: XYZ): string => `${GP}Chunks/${k.X}_${k.Y}_${k.Z}.mps`;

/**
 * Loaded save -> plain bricks of one grid, in chunk-index order then file order. `linear[i]` says
 * whether brick i's chunk stores linear colour bytes (bColorsAreLinear true, or missing as in saves
 * from before CL14860); otherwise the bytes are sRGB-encoded.
 */
export function extractBricks(files: FileMap, opts: WorldOptions = {}): { bricks: PlainBrick[]; ctx: WorldContext; linear: boolean[] } {
  const c = loadCtx(files, opts), bricks: PlainBrick[] = [], g = c.global, linear: boolean[] = [];
  if (!c.ci) return { bricks, ctx: c, linear };
  const ci = c.ci;
  ci.Chunk3DIndices.forEach((k, j) => {
    const f = files.get(chunkPath(c.GP, k));
    if (!f) return;
    const ch = decodeMps<BrickChunk>(f, c.chunkSchema), size = ci.ChunkSizes[j]!, off = ci.ChunkOffsets[j]!;
    const centre = AX.map((a) => k[a] * size + size / 2 + off[a]);
    const before = bricks.length;
    for (const b of decodeBrickChunk(ch, c.chunkSchema, g, centre)) bricks.push(b);
    for (let n = before; n < bricks.length; n++) linear.push(ch.bColorsAreLinear !== false);
  });
  return { bricks, ctx: c, linear };
}

/** Chunk fields of type BRSavedBitFlags (collision flags and so on), in schema order. */
export function brickFlagFields(chunkSchema: Schema): string[] {
  return chunkSchema.S.get(chunkSchema.root)!.filter(([, t]) => t === 'BRSavedBitFlags').map(([f]) => f);
}

/**
 * One decoded brick chunk -> plain bricks, positions = chunk centre + relative position.
 * `g` must be the GlobalData the chunk was written with, `chunkSchema` the schema it was decoded with.
 */
export function decodeBrickChunk(ch: BrickChunk, chunkSchema: Schema, g: GlobalData, centre: readonly number[]): PlainBrick[] {
  const flagFields = brickFlagFields(chunkSchema), out: PlainBrick[] = [];
  const proc: { asset: string; size: XYZ }[] = [];
  let si = 0;
  for (const sc of ch.BrickSizeCounters) {
    for (let n = 0; n < sc.NumSizes; n++) proc.push({ asset: g.ProceduralBrickAssetNames[sc.AssetIndex]!, size: ch.BrickSizes[si++]! });
  }
  const flagBits = flagFields.map((ff) => (ch[ff] as { Flags: number[] }).Flags);
  ch.BrickTypeIndices.forEach((t, i) => {
    const p = t >= ch.ProceduralBrickStartingIndex ? proc[t - ch.ProceduralBrickStartingIndex] : undefined;
    const rp = ch.RelativePositions[i]!, col = ch.ColorsAndAlphas[i]!;
    const b: PlainBrick = {
      asset: p ? p.asset : g.BasicBrickAssetNames[t]!,
      size: p ? [p.size.X, p.size.Y, p.size.Z] : null,
      pos: [rp.X + centre[0]!, rp.Y + centre[1]!, rp.Z + centre[2]!],
      orient: ch.Orientations[i]!,
      color: [col.R, col.G, col.B, col.A],
      material: g.MaterialAssetNames[ch.MaterialIndices[i]!]!,
      owner: ch.OwnerIndices[i]!,
      originalOwner: ch.OriginalOwnerIndices?.[i] ?? ch.OwnerIndices[i]!,
    };
    const fl: Record<string, number> = {};
    let any = false;
    flagFields.forEach((ff, n) => {
      const bit = (flagBits[n]![i >> 3]! >> (i & 7)) & 1;
      fl[ff] = bit;
      if (!bit) any = true;
    });
    if (any) b.flags = fl;
    out.push(b);
  });
  return out;
}

/** Chunk fields the writer knows how to build. */
const KNOWN = new Set(['ProceduralBrickStartingIndex', 'BrickSizeCounters', 'BrickSizes', 'BrickTypeIndices', 'OwnerIndices', 'OriginalOwnerIndices',
  'RelativePositions', 'Orientations', 'MaterialIndices', 'ColorsAndAlphas', 'bColorsAreLinear']);

export interface BuiltChunk {
  key: string;
  k: XYZ;
  value: BrickChunk;
  n: number;
}

export interface BuildOptions {
  chunkSize?: number;
  flagFields?: string[];
  linear?: boolean;
}

/**
 * Plain bricks -> chunk values for one grid. Mutates `global`'s name lists (appends unseen assets
 * and materials). Chunks are 2048 units by default, positions relative to the chunk centre.
 */
export function buildChunks(bricks: readonly PlainBrick[], global: GlobalData, opts: BuildOptions = {}): BuiltChunk[] {
  const size = opts.chunkSize ?? 2048, flagFields = opts.flagFields ?? [];
  const chunks = new Map<string, { k: XYZ; list: [PlainBrick, number[]][] }>();
  const idxOf = (list: string[], name: string): number => {
    let i = list.indexOf(name);
    if (i < 0) { i = list.length; list.push(name); }
    return i;
  };
  const isBasic = (a: string): boolean => global.BasicBrickAssetNames.includes(a) || (!global.ProceduralBrickAssetNames.includes(a) && /^B_/.test(a));
  for (const b of bricks) {
    const p = b.pos.map(Math.round), k = { X: Math.floor(p[0]! / size), Y: Math.floor(p[1]! / size), Z: Math.floor(p[2]! / size) };
    const key = `${k.X}_${k.Y}_${k.Z}`;
    if (!chunks.has(key)) chunks.set(key, { k, list: [] });
    chunks.get(key)!.list.push([b, p]);
  }
  for (const b of bricks) if (isBasic(b.asset)) idxOf(global.BasicBrickAssetNames, b.asset);   // register first: the start index is global
  const out: BuiltChunk[] = [];
  for (const [key, { k, list }] of chunks) {
    // procedural types: assets in first-use order, each asset's sizes in first-use order
    const assets = new Map<string, Map<string, [number, number, number]>>();
    let hasBasic = false;
    for (const [b] of list) {
      if (isBasic(b.asset)) { hasBasic = true; continue; }
      if (!b.size) throw new Error(`procedural brick ${b.asset} has no size`);
      if (!assets.has(b.asset)) assets.set(b.asset, new Map());
      const sz = assets.get(b.asset)!, sk = b.size.join(',');
      if (!sz.has(sk)) sz.set(sk, b.size);
    }
    // Fixed (B_*) bricks use their BasicBrickAssetNames index; procedural ones start after all of them.
    // Every sample chunk has start = #basic names when it holds a fixed brick, else 0.
    const start = hasBasic ? global.BasicBrickAssetNames.length : 0;
    const counters: BrickChunk['BrickSizeCounters'] = [], sizes: XYZ[] = [], typeOf = new Map<string, number>();
    for (const [a, sz] of assets) {
      counters.push({ AssetIndex: idxOf(global.ProceduralBrickAssetNames, a), NumSizes: sz.size });
      for (const [sk, s] of sz) {
        typeOf.set(a + '|' + sk, start + sizes.length);
        sizes.push({ X: s[0], Y: s[1], Z: s[2] });
      }
    }
    const centre = AX.map((a) => k[a] * size + size / 2), n = list.length;
    const ch: BrickChunk = {
      ProceduralBrickStartingIndex: start,
      BrickSizeCounters: counters,
      BrickSizes: sizes,
      BrickTypeIndices: list.map(([b]) => (isBasic(b.asset) ? global.BasicBrickAssetNames.indexOf(b.asset) : typeOf.get(b.asset + '|' + b.size!.join(','))!)),
      OwnerIndices: list.map(([b]) => b.owner ?? 0),
      OriginalOwnerIndices: list.map(([b]) => b.originalOwner ?? b.owner ?? 0),
      RelativePositions: list.map(([, p]) => ({ X: p[0]! - centre[0]!, Y: p[1]! - centre[1]!, Z: p[2]! - centre[2]! })),
      Orientations: list.map(([b]) => b.orient ?? 16),
      MaterialIndices: list.map(([b]) => idxOf(global.MaterialAssetNames, b.material ?? 'BMC_Plastic')),
      ColorsAndAlphas: list.map(([b]) => ({ R: b.color[0], G: b.color[1], B: b.color[2], A: b.color[3] ?? 5 })),
      bColorsAreLinear: !!opts.linear,
    };
    for (const f of flagFields) {                // bit i of byte i >> 3, LSB first, padding bits 0
      const bits = new Uint8Array((n + 7) >> 3);
      list.forEach(([b], i) => { if (b.flags?.[f] ?? 1) bits[i >> 3]! |= 1 << (i & 7); });
      ch[f] = { Flags: [...bits] };
    }
    out.push({ key, k, value: ch, n });
  }
  return out;
}

/**
 * Loaded files + edited plain bricks -> {files: new Map, warnings}. Rewrites one grid's chunk files
 * and ChunkIndex, GlobalData name lists and Owners.BrickCounts; everything else is copied verbatim.
 */
export function rebuildFromLoaded(files: FileMap, bricks: readonly PlainBrick[], opts: WorldOptions = {}): { files: FileMap; warnings: string[] } {
  const c = loadCtx(files, opts), warnings: string[] = [], g = c.global;
  const extra = rootFields(c.chunkSchema).filter((f) => !KNOWN.has(f) && !c.flagFields.includes(f));
  if (extra.length) throw new Error('unknown chunk fields (writer needs updating): ' + extra.join(', '));
  // old per-owner counts in this grid, to adjust Owners.BrickCounts
  const old = extractBricks(files, opts).bricks, delta = new Map<number, number>();
  for (const b of old) delta.set(b.owner ?? 0, (delta.get(b.owner ?? 0) ?? 0) - 1);
  for (const b of bricks) delta.set(b.owner ?? 0, (delta.get(b.owner ?? 0) ?? 0) + 1);
  let lin = false;
  for (const k of c.ci?.Chunk3DIndices ?? []) {
    const f = files.get(chunkPath(c.GP, k));
    if (f) { lin = !!decodeMps<BrickChunk>(f, c.chunkSchema).bColorsAreLinear; break; }
  }
  const chunks = buildChunks(bricks, g, { flagFields: c.flagFields, linear: lin, ...(opts.chunkSize !== undefined && { chunkSize: opts.chunkSize }) });
  // chunk index: keep per-chunk component / wire counts of chunks that already existed
  const oldIdx = new Map((c.ci?.Chunk3DIndices ?? []).map((k, j) => [`${k.X}_${k.Y}_${k.Z}`, j]));
  const idx: ChunkIndex = { Chunk3DIndices: [], ChunkOffsets: [], ChunkSizes: [], NumBricks: [], NumComponents: [], NumWires: [] };
  const idxFields = rootFields(c.idxSchema).filter((f) => !(f in idx));
  if (idxFields.length) throw new Error('unknown chunk index fields: ' + idxFields.join(', '));
  for (const ch of chunks) {
    const j = oldIdx.get(ch.key);
    idx.Chunk3DIndices.push(ch.k);
    idx.ChunkOffsets.push({ X: 0, Y: 0, Z: 0 });
    idx.ChunkSizes.push(opts.chunkSize ?? 2048);
    idx.NumBricks.push(ch.n);
    idx.NumComponents.push(j !== undefined ? c.ci!.NumComponents[j]! : 0);
    idx.NumWires.push(j !== undefined ? c.ci!.NumWires[j]! : 0);
    if (j !== undefined) {
      const o = c.ci!.ChunkOffsets[j]!;
      if (o.X | o.Y | o.Z) warnings.push(`chunk ${ch.key} had a non-zero offset (dropped)`);
    }
  }
  const compNow = idx.NumComponents.concat(idx.NumWires).some((x) => x);
  if (compNow || [...files.keys()].some((p) => p.startsWith(c.GP) && /\/(Components|Wires)\//.test(p))) {
    warnings.push('this grid has components / wires: they index bricks by position in the chunk and were kept as is');
  }
  // new file map: replace in place, drop vanished chunks, append new ones
  const fresh = new Map(chunks.map((ch) => [chunkPath(c.GP, ch.k), encodeMps(ch.value, c.chunkSchema)]));
  const outFiles: FileMap = new Map();
  const chunkRe = new RegExp('^' + c.GP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'Chunks/[^/]+\\.mps$');
  for (const [p, b] of files) {
    if (chunkRe.test(p)) {
      const f = fresh.get(p);
      if (f) { outFiles.set(p, f); fresh.delete(p); }
      continue;
    }
    if (p === c.GP + 'ChunkIndex.mps') { outFiles.set(p, encodeMps(idx, c.idxSchema)); continue; }
    if (p === W + 'GlobalData.mps') { outFiles.set(p, encodeMps(g, c.globalSchema)); continue; }
    const ownersSchema = files.get(W + 'Owners.schema');
    if (p === W + 'Owners.mps' && ownersSchema) {
      const os = parseSchema(ownersSchema), ow = decodeMps(b, os);
      const counts = ow.BrickCounts;
      if (Array.isArray(counts)) {
        for (const [i, d] of delta) {
          if (i >= counts.length) { warnings.push(`brick owner ${i} not in Owners`); continue; }
          counts[i] = (counts[i] as number) + d;
        }
      }
      outFiles.set(p, encodeMps(ow, os));
      continue;
    }
    outFiles.set(p, b);
  }
  if (!outFiles.has(c.GP + 'ChunkIndex.mps')) outFiles.set(c.GP + 'ChunkIndex.mps', encodeMps(idx, c.idxSchema));
  for (const [p, b] of fresh) outFiles.set(p, b);
  return { files: outFiles, warnings };
}
