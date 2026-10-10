// Saving the scene: viewer bricks back to save bricks, rebuilt into the save they were opened from
// (src/format/world.ts rebuildFromLoaded rewrites grid 1's chunks, ChunkIndex, GlobalData name
// lists and owner counts; every other file is copied as is). Only works with a template: a scene
// that wasn't opened from a save has no GlobalData / schemas / owners to write into.
//
// A viewer brick keeps a world box, a type and its shape fields; the save brick needs an asset name,
// an orientation byte, local half-extents and a centre. The orientation is the first byte whose
// derived fields (up / sideways stud axis, ramp run and lip, crest run, closed end) match the brick,
// so a loaded brick that wasn't edited gets an orientation that draws identically (box bricks are
// symmetric, so any matching rotation is the same brick).

import { S } from '../app/state.ts';
import { BrickShapes } from '../render/meshes/shapes.js';
import { BRZ_UNIT } from '../core/units.ts';
import { extractBricks, rebuildFromLoaded, type PlainBrick } from '../format/world.ts';
import { writeBrz, type FileMap } from '../format/brz.ts';
import { decodeMps, encodeMps, parseSchema, schemaPathFor } from '../format/schema.ts';
import { srgbToLinearByte } from '../format/palette.ts';
import { linearToSrgbByte } from '../format/stale.ts';
import { localHalf, rampDir, sideCode, topStyle, type Brick } from './brick.ts';
import { loadedFiles, loadedUnsupported, type SeqBrick } from './load.ts';
import { isFixedAsset, plainOf } from './view.ts';
import { remapBrickRefs } from './remap.ts';
import type { SceneStore } from './store.ts';

/** The save asset of a viewer brick. */
export function assetOf(b: Brick): string {
  if (b.shape === 'special' || b.shape === 'micro') return b.asset!;
  if (b.shape === 'round') return b.round!;
  if (b.shape === 'ramp') return 'PB_DefaultRamp';
  if (b.shape === 'crest') return 'PB_DefaultRampCrest';
  if (b.shape === 'crestEnd') return 'PB_DefaultRampCrestEnd';
  if (b.micro) return 'PB_DefaultMicroBrick';
  const top = topStyle(b);
  return top === 'smooth' ? 'PB_DefaultSmoothTile' : top === 'plain' ? 'PB_DefaultTile' : 'PB_DefaultBrick';
}

/** The orientation byte (dir << 2 | rot) of a viewer brick. */
export function orientOf(b: Brick): number {
  if (b.shape === 'special' || b.shape === 'micro') return b.o ?? 16;
  if (b.shape === 'round' && b.o != null) return b.o;
  const up = b.up ?? 1;
  for (let o = 0; o < 24; o++) {
    const dir = o >> 2, u = dir === 4 ? 1 : dir === 5 ? -1 : 0;
    if (u !== up) continue;
    if (!u && sideCode(o) !== (b.side || 1)) continue;
    if (b.shape === 'ramp') { const r = rampDir(o); if (r.run !== b.run || r.lip !== b.lip) continue; }
    if (b.shape === 'crest' && BrickShapes.crestDir(o).run !== b.run) continue;
    if (b.shape === 'crestEnd') { const c = BrickShapes.crestEndDir(o); if (c.run !== b.run || c.closed !== b.closed) continue; }
    return o;
  }
  return up < 0 ? 20 : 16;
}

const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * A viewer brick (absolute faces, or faces offset by -origin) -> a save brick. `linear`: the
 * target chunks store linear colour bytes.
 */
export function plainBrick(b: Brick, origin: readonly number[], linear: boolean): SeqBrick {
  const o = orientOf(b), asset = assetOf(b);
  const size = [0, 1, 2].map((i) => b.hi[i] - b.lo[i]);
  const half = localHalf(o, size).map(Math.round) as [number, number, number];
  const pos = [0, 1, 2].map((i) => Math.round(((b.lo[i] + b.hi[i]) / 2 + origin[i]!) / BRZ_UNIT)) as [number, number, number];
  const rgb = b.color.slice(0, 3).map(byte).map((v) => (linear ? srgbToLinearByte(v) : v));
  const out: SeqBrick = {
    asset, size: b.shape === 'round' || isFixedAsset(asset) ? null : half, pos, orient: o,
    color: [rgb[0]!, rgb[1]!, rgb[2]!, b.intensity ?? 5],
    material: b.material ?? 'BMC_Plastic',
  };
  if (b.save?.owner !== undefined) out.owner = b.save.owner;
  if (b.save?.originalOwner !== undefined) out.originalOwner = b.save.originalOwner;
  if (b.save?.flags) out.flags = b.save.flags;
  if (b.save?.seq !== undefined) out.seq = b.save.seq;
  return out;
}

/**
 * Save order: the bricks that came from the save in their load order (seq), then new bricks in scene
 * order. Unedited, every chunk gets its bricks back at the same indices, which components and wires
 * refer to.
 */
export function saveOrder(bricks: readonly SeqBrick[]): PlainBrick[] {
  return saveOrderSeq(bricks).map(({ seq: _s, ...pb }) => pb);
}

/** saveOrder, keeping seq. */
export const saveOrderSeq = (bricks: readonly SeqBrick[]): SeqBrick[] =>
  [...bricks.filter((b) => b.seq !== undefined).sort((a, b) => a.seq! - b.seq!), ...bricks.filter((b) => b.seq === undefined)];

const CHUNK = 2048;
const chunkOf = (p: readonly number[]): string => p.map((v) => Math.floor(Math.round(v) / CHUNK)).join('_');

/**
 * Chunks of grid 1 that hold components or wires whose bricks no longer sit at the same indices
 * (a brick in it was added, removed or moved to another chunk): their components and wires may now
 * name other bricks. `before`: the save's bricks in load order; `after`: the bricks being written (any order).
 */
export function shiftedComponentChunks(template: FileMap, before: readonly PlainBrick[], after: readonly SeqBrick[]): string[] {
  const has = new Set<string>();
  for (const p of template.keys()) {
    const m = p.match(/^World\/0\/Bricks\/Grids\/1\/(?:Components|Wires)\/(-?\d+_-?\d+_-?\d+)\.mps$/);
    if (m) has.add(m[1]!);
  }
  if (!has.size) return [];
  const list = (bs: readonly { pos: readonly number[] }[], seq: (i: number) => number | undefined): Map<string, (number | undefined)[]> => {
    const m = new Map<string, (number | undefined)[]>();
    bs.forEach((b, i) => { const k = chunkOf(b.pos); if (has.has(k)) { if (!m.has(k)) m.set(k, []); m.get(k)!.push(seq(i)); } });
    return m;
  };
  const ordered = saveOrderSeq(after), was = list(before, (i) => i), now = list(ordered, (i) => ordered[i]!.seq);
  return [...has].filter((k) => (was.get(k) ?? []).join() !== (now.get(k) ?? []).join()).sort();
}

/**
 * Every row of a store as a save brick, in list order, colour bytes converted for the target
 * chunks (`linear`: they store linear bytes); a row's own bytes are kept when they already match.
 */
export function scenePlain(s: SceneStore, linear: boolean): SeqBrick[] {
  return s.ordered().map((id) => {
    const { linear: lin, ...pb } = plainOf(s, id);
    if (lin !== linear) {
      const f = linear ? srgbToLinearByte : linearToSrgbByte;
      pb.color = [f(pb.color[0]), f(pb.color[1]), f(pb.color[2]), pb.color[3]];
    }
    return pb;
  });
}

export interface SavedScene { files: FileMap; warnings: string[] }

/**
 * The scene written into a template save's file tree (default: the save it was opened from), or
 * null when there's no template.
 */
export function sceneFiles(template: FileMap | null = loadedFiles): SavedScene | null {
  if (!template) return null;
  const { linear } = extractBricks(template);
  const lin = linear.length ? linear[0]! : false;
  const scene = scenePlain(S.scene, lin).concat(loadedUnsupported);
  return writeScene(template, scene);
}

/**
 * Save bricks (with their load order, seq) written into a template: grid 1 rebuilt, then the
 * components' and wires' brick indices moved along with their bricks (scene/remap.ts).
 */
export function writeScene(template: FileMap, scene: readonly SeqBrick[]): SavedScene {
  const ordered = saveOrderSeq(scene), out = rebuildFromLoaded(template, ordered.map(({ seq: _s, ...pb }) => pb));
  const r = remapBrickRefs(template, out.files, ordered);
  out.files = r.files;
  out.warnings = out.warnings.filter((w) => !/components \/ wires: they index bricks/.test(w));
  if (r.problems.length) out.warnings.push(`components / wires: ${r.problems.length} reference${r.problems.length === 1 ? '' : 's'} could not follow their bricks (${r.problems[0]})`);
  return out;
}

/**
 * A template for saving a PART of the scene: the save's files without grid 1's components and wires
 * (copies never take those along), with their counts in grid 1's ChunkIndex and in Owners zeroed.
 */
function partTemplate(template: FileMap): FileMap {
  const out: FileMap = new Map(), G1 = 'World/0/Bricks/Grids/1/';
  for (const [p, b] of template) if (!(p.startsWith(G1) && /\/(Components|Wires)\//.test(p))) out.set(p, b);
  const zero = (path: string, fields: string[]): void => {
    const bytes = out.get(path), sp = schemaPathFor(path, out), sb = sp ? out.get(sp) : undefined;
    if (!bytes || !sb) return;
    const schema = parseSchema(sb), v = decodeMps<Record<string, unknown>>(bytes, schema);
    for (const f of fields) { const a = v[f]; if (Array.isArray(a)) a.fill(0); }
    out.set(path, encodeMps(v, schema));
  };
  zero(G1 + 'ChunkIndex.mps', ['NumComponents', 'NumWires']);
  zero('World/0/Owners.mps', ['ComponentCounts', 'WireCounts']);
  return out;
}

/**
 * Rows `ids` of the scene written into a template save (default: the one opened) as a save of
 * their own (a prefab of the selection), or null without a template. The bricks are new bricks:
 * components and wires stay behind, everything else of the template (other grids, entities) is kept.
 */
export function partFiles(ids: readonly number[], template: FileMap | null = loadedFiles): SavedScene | null {
  if (!template) return null;
  const { linear } = extractBricks(template), lin = linear.length ? linear[0]! : false, want = new Set(ids);
  const ord = S.scene.ordered(), bricks = scenePlain(S.scene, lin).filter((_, j) => want.has(ord[j]!));
  return rebuildPart(template, bricks);
}

function rebuildPart(template: FileMap, bricks: SeqBrick[]): SavedScene {
  const out = rebuildFromLoaded(partTemplate(template), bricks.map(({ seq: _s, ...pb }) => pb));
  out.warnings = out.warnings.filter((w) => !/components \/ wires: they index bricks/.test(w));
  return out;
}

/** The scene as .brz bytes (raw blobs, method 0), or null without a template. */
export function sceneBrz(): { bytes: Uint8Array; warnings: string[] } | null {
  const s = sceneFiles();
  return s && { bytes: writeBrz(s.files), warnings: s.warnings };
}

/** Hands bytes to the browser as a download. */
export function download(bytes: Uint8Array, name: string, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "castle.brz" -> "castle (edited).brz" */
export const savedName = (name: string, ext: string): string => (name.replace(/\.(brz|brdb)$/i, '') || 'save') + ' (edited)' + ext;
