// BrickRecord: one brick row of a SceneStore as REC_BYTES bytes, the unit of the undo history
// (ARCHITECTURE.md section 4). Positions are absolute integer units, so a record means the same
// whatever the camera did since; names are indices into the shared tables (store.ts), so a record
// also means the same in any store.
//
// Layout (little-endian):
//   0  px, py, pz        int32 x3
//  12  hx, hy, hz        uint16 x3
//  18  orient            uint8
//  19  flags             uint8   (F_LINEAR | F_HAS_FLAGS; alive is implied)
//  20  asset             uint16
//  22  material          uint8
//  23  faceMask          uint8
//  24  color             uint32  (R | G << 8 | B << 16 | A << 24)
//  28  owner, origOwner  uint16 x2
//  32  collision         uint16
//  34  grid              uint16
//  36  srcOrder          int32
//  40  order             float64
// 48 bytes. (ARCHITECTURE.md planned 32; the grid, the save order and the list order made it 48.)

import { F_ALIVE, F_HAS_FLAGS, F_LINEAR, type SceneStore } from './store.ts';

export const REC_BYTES = 48;

/** Row `id` of `s` into `out` at byte offset `at`. */
export function writeRecord(s: SceneStore, id: number, out: DataView, at = 0): void {
  out.setInt32(at, s.px[id]!, true); out.setInt32(at + 4, s.py[id]!, true); out.setInt32(at + 8, s.pz[id]!, true);
  out.setUint16(at + 12, s.hx[id]!, true); out.setUint16(at + 14, s.hy[id]!, true); out.setUint16(at + 16, s.hz[id]!, true);
  out.setUint8(at + 18, s.orient[id]!); out.setUint8(at + 19, s.flags[id]! & (F_LINEAR | F_HAS_FLAGS));
  out.setUint16(at + 20, s.asset[id]!, true); out.setUint8(at + 22, s.material[id]!); out.setUint8(at + 23, s.faceMask[id]!);
  out.setUint32(at + 24, s.color[id]!, true);
  out.setUint16(at + 28, s.owner[id]!, true); out.setUint16(at + 30, s.origOwner[id]!, true);
  out.setUint16(at + 32, s.collision[id]!, true); out.setUint16(at + 34, s.grid[id]!, true);
  out.setInt32(at + 36, s.srcOrder[id]!, true); out.setFloat64(at + 40, s.order[id]!, true);
}

/** A record at `at` into row `id` (made live), then the row is marked changed. `shape` derives the kind. */
export function readRecord(s: SceneStore, id: number, src: DataView, at: number, shape: (asset: number, orient: number) => number): void {
  s.revive(id);
  s.px[id] = src.getInt32(at, true); s.py[id] = src.getInt32(at + 4, true); s.pz[id] = src.getInt32(at + 8, true);
  s.hx[id] = src.getUint16(at + 12, true); s.hy[id] = src.getUint16(at + 14, true); s.hz[id] = src.getUint16(at + 16, true);
  s.orient[id] = src.getUint8(at + 18); s.flags[id] = F_ALIVE | (src.getUint8(at + 19) & (F_LINEAR | F_HAS_FLAGS));
  s.asset[id] = src.getUint16(at + 20, true); s.material[id] = src.getUint8(at + 22); s.faceMask[id] = src.getUint8(at + 23);
  s.color[id] = src.getUint32(at + 24, true);
  s.owner[id] = src.getUint16(at + 28, true); s.origOwner[id] = src.getUint16(at + 30, true);
  s.collision[id] = src.getUint16(at + 32, true); s.grid[id] = src.getUint16(at + 34, true);
  s.srcOrder[id] = src.getInt32(at + 36, true); s.order[id] = src.getFloat64(at + 40, true);
  if (s.order[id]! >= s.nextOrder) s.nextOrder = s.order[id]! + 1;
  s.shape[id] = shape(s.asset[id]!, s.orient[id]!);
  s.touch(id);
}

/** Records of several rows, packed (n * REC_BYTES bytes). */
export function packRecords(s: SceneStore, ids: readonly number[]): Uint8Array {
  const out = new Uint8Array(ids.length * REC_BYTES), dv = new DataView(out.buffer);
  ids.forEach((id, j) => writeRecord(s, id, dv, j * REC_BYTES));
  return out;
}

/** True when row `id` holds exactly record j of `recs`. */
export function sameRecord(s: SceneStore, id: number, recs: Uint8Array, j: number): boolean {
  if (!s.alive(id)) return false;
  const tmp = new Uint8Array(REC_BYTES);
  writeRecord(s, id, new DataView(tmp.buffer));
  for (let k = 0; k < REC_BYTES; k++) if (tmp[k] !== recs[j * REC_BYTES + k]) return false;
  return true;
}
