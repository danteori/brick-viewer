// The fast load path: save chunks straight into a SceneStore, with no PlainBrick (or decoded
// position / colour object) per brick. Same rows, same order and same name tables as going
// through extractBricks + putPlain (tests/unit/fastload.test.ts checks every column on the
// reference saves); multi-million-brick prefabs load several times faster and with far less garbage.

import type { FileMap } from '../format/brz.ts';
import { forEachRawBrickChunk, type PlainBrick, type RawBrickChunk, type WorldContext } from '../format/world.ts';
import { packedField, type PackedStructs } from '../format/schema.ts';
import { ASSETS, F_ALIVE, F_HAS_FLAGS, F_LINEAR, FLAG_NAMES, GRIDS, Kind, MATERIALS, SAME_OWNER, SceneStore } from './store.ts';
import { kindOf, roundHalfOf, supportedAsset } from './view.ts';
import type { LoadOrder } from './compmodel.ts';

type Col = (i: number) => number;

/** Field f of a packed struct array, whether it came back as bytes or as objects. */
function column(a: PackedStructs | Record<string, number>[] | undefined, f: string): Col {
  if (!a) return () => 0;
  if (Array.isArray(a)) return (i) => a[i]![f]!;
  if (!a.raw) return () => 0;
  return packedField(a, f) ?? (() => 0);
}
const lengthOf = (a: PackedStructs | unknown[] | undefined): number => (!a ? 0 : Array.isArray(a) ? a.length : a.n);

export interface FastLoad { store: SceneStore; skipped: number; skippedTypes: Record<string, number>; unsupported: (PlainBrick & { seq: number })[]; sideways: number; order: LoadOrder }

/** Save chunk size (units), for the LoadOrder (scene/compmodel.ts loadOrderOf). */
const SAVE_CHUNK = 2048;

/** Grid 1's bricks -> a new store (drawable ones), plus the ones the viewer can't draw. */
export function fastStore(files: FileMap): FastLoad {
  const skippedTypes: Record<string, number> = {}, unsupported: (PlainBrick & { seq: number })[] = [];
  let skipped = 0, sideways = 0, seq = 0;
  // size the store from the chunk index's counts when it has them
  let store = new SceneStore();
  const supported = new Map<string, boolean>();
  const isSupported = (asset: string, proc: boolean): boolean => {
    const k = (proc ? 'P' : 'B') + asset;
    let v = supported.get(k);
    if (v === undefined) { v = supportedAsset(asset, proc); supported.set(k, v); }
    return v;
  };
  const gridId = GRIDS.id('1');
  // the LoadOrder, as loadOrderOf builds it from every brick's position (supported or not)
  const oChunks: string[] = [], oAt = new Map<string, number>(), oCounts: number[] = [], seqChunk: number[] = [], seqIndex: number[] = [];
  let lastK = '', lastC = -1, lx = NaN, ly = NaN, lz = NaN;
  const orderOf = (x: number, y: number, z: number): void => {
    const kx = Math.floor(Math.round(x) / SAVE_CHUNK), ky = Math.floor(Math.round(y) / SAVE_CHUNK), kz = Math.floor(Math.round(z) / SAVE_CHUNK);
    if (kx !== lx || ky !== ly || kz !== lz) {
      lx = kx; ly = ky; lz = kz; lastK = `${kx}_${ky}_${kz}`;
      let c = oAt.get(lastK);
      if (c === undefined) { oAt.set(lastK, (c = oChunks.push(lastK) - 1)); oCounts.push(0); }
      lastC = c;
    }
    seqChunk.push(lastC); seqIndex.push(oCounts[lastC]!++);
  };
  let flagIds: number[] = [];
  let ctx!: WorldContext;
  forEachRawBrickChunk(files, (ch: RawBrickChunk, centre, linear) => {
    const g = ctx.global;
    // procedural types: asset name and size per type index above ProceduralBrickStartingIndex
    const procAsset: string[] = [], procSize: [number, number, number][] = [];
    const sizeX = column(ch.BrickSizes as PackedStructs, 'X'), sizeY = column(ch.BrickSizes as PackedStructs, 'Y'), sizeZ = column(ch.BrickSizes as PackedStructs, 'Z');
    const cAsset = column(ch.BrickSizeCounters as PackedStructs, 'AssetIndex'), cNum = column(ch.BrickSizeCounters as PackedStructs, 'NumSizes');
    let si = 0;
    for (let c = 0, nc = lengthOf(ch.BrickSizeCounters as PackedStructs); c < nc; c++) {
      const name = g.ProceduralBrickAssetNames[cAsset(c)]!;
      for (let n = cNum(c); n > 0; n--, si++) { procAsset.push(name); procSize.push([sizeX(si), sizeY(si), sizeZ(si)]); }
    }
    const rx = column(ch.RelativePositions as PackedStructs, 'X'), ry = column(ch.RelativePositions as PackedStructs, 'Y'), rz = column(ch.RelativePositions as PackedStructs, 'Z');
    const cr = column(ch.ColorsAndAlphas as PackedStructs, 'R'), cg = column(ch.ColorsAndAlphas as PackedStructs, 'G'), cb = column(ch.ColorsAndAlphas as PackedStructs, 'B'), ca = column(ch.ColorsAndAlphas as PackedStructs, 'A');
    const flagBits = ctx.flagFields.map((ff) => (ch[ff] as { Flags: number[] }).Flags);
    const types = ch.BrickTypeIndices, start = ch.ProceduralBrickStartingIndex;
    const owners = ch.OwnerIndices, orig = ch.OriginalOwnerIndices, orients = ch.Orientations, mats = ch.MaterialIndices;
    // table ids are registered on first use, in brick order, as putPlain does
    const assetIds = new Map<number, number>(), matIds = new Map<number, number>();
    const cx = centre[0]!, cy = centre[1]!, cz = centre[2]!, n = types.length;
    for (let i = 0; i < n; i++, seq++) {
      const t = types[i]!, proc = t >= start, asset = proc ? procAsset[t - start]! : g.BasicBrickAssetNames[t]!;
      orderOf(rx(i) + cx, ry(i) + cy, rz(i) + cz);
      if (!isSupported(asset, proc)) {
        const k = asset || 'unknown';
        skipped++; skippedTypes[k] = (skippedTypes[k] || 0) + 1;
        const fl: Record<string, number> = {};
        let any = false;
        ctx.flagFields.forEach((ff, f) => { const bit = (flagBits[f]![i >> 3]! >> (i & 7)) & 1; fl[ff] = bit; if (!bit) any = true; });
        const sz = proc ? procSize[t - start]! : null;
        const pb: PlainBrick & { seq: number } = {
          asset, size: sz ? [sz[0], sz[1], sz[2]] : null, pos: [rx(i) + cx, ry(i) + cy, rz(i) + cz], orient: orients[i]!,
          color: [cr(i), cg(i), cb(i), ca(i)], material: g.MaterialAssetNames[mats[i]!]!, owner: owners[i]!, originalOwner: orig?.[i] ?? owners[i]!, seq,
        };
        if (any) pb.flags = fl;
        unsupported.push(pb);
        continue;
      }
      let a = assetIds.get(t);
      if (a === undefined) { a = ASSETS.id(asset); assetIds.set(t, a); }
      const id = store.alloc(), o = orients[i]!, kind = kindOf(a, o);
      const h = proc ? procSize[t - start]! : kind === Kind.Round ? roundHalfOf(asset) : null;
      store.px[id] = rx(i) + cx; store.py[id] = ry(i) + cy; store.pz[id] = rz(i) + cz;
      store.hx[id] = h ? h[0] : 0; store.hy[id] = h ? h[1] : 0; store.hz[id] = h ? h[2] : 0;
      store.orient[id] = o; store.asset[id] = a; store.shape[id] = kind;
      store.color[id] = ((cr(i) & 255) | ((cg(i) & 255) << 8) | ((cb(i) & 255) << 16) | ((ca(i) & 255) << 24)) >>> 0;
      const mi = mats[i]!;
      let m = matIds.get(mi);
      if (m === undefined) { m = MATERIALS.id(g.MaterialAssetNames[mi] ?? 'BMC_Plastic'); matIds.set(mi, m); }
      store.material[id] = m;
      const ow = owners[i], oo = orig?.[i] ?? ow;
      store.owner[id] = ow ?? 0;
      store.origOwner[id] = oo === undefined || oo === (ow ?? 0) ? SAME_OWNER : oo;
      let f = F_ALIVE | (linear ? F_LINEAR : 0), bits = 0;
      for (let ff = 0; ff < flagBits.length; ff++) {
        if ((flagBits[ff]![i >> 3]! >> (i & 7)) & 1) continue;
        f |= F_HAS_FLAGS;
        const fid = flagIds[ff]!;
        if (fid < 16) bits |= 1 << fid;
      }
      store.flags[id] = f; store.collision[id] = bits;
      store.grid[id] = gridId;
      store.srcOrder[id] = seq;
      if ((o >> 2) % 6 < 4) sideways++;
    }
  }, {}, (c) => {
    // before the first chunk: size the store and register the flag fields in schema order
    ctx = c;
    const total = c.ci?.NumBricks?.reduce((s, v) => s + v, 0) ?? 0;
    store = new SceneStore(Math.max(64, total));
    store.flagFields = c.flagFields.map((f) => FLAG_NAMES.id(f));
    flagIds = store.flagFields;
  });
  store.drain();
  return { store, skipped, skippedTypes, unsupported, sideways, order: { chunks: oChunks, seqChunk: Int32Array.from(seqChunk), seqIndex: Int32Array.from(seqIndex) } };
}
