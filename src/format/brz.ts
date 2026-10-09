// .brz container (verified layout):
//   header (45 B): "BRZ", u8 version, u8 index method, u32 index size, u32 index stored size,
//                  32 B BLAKE3 of the uncompressed index
//   index: u32 folders, files, blobs; i32 folderParent[]; u16 folderNameLen[]; names;
//          i32 fileFolder[]; i32 fileBlob[]; u16 fileNameLen[]; names;
//          u8 method[] (0 raw, 1 zstd); i32 size[]; i32 storedSize[]; 32 B BLAKE3[] (uncompressed)
//   blobs, back to back
// Ported from save-viewer.html readBrz and tools/brzwriter.js writeBrz.

import { blake3 } from './blake3.ts';
import { ByteBuf, fromUtf8, utf8 } from './msgpack.ts';
import { zstdDecompress } from './zstd.ts';

/** path -> uncompressed bytes, in the archive's file order. */
export type FileMap = Map<string, Uint8Array>;

export interface BlobInfo {
  method: number;
  size: number;
  stored: number;
  hash: Uint8Array;
}

export interface BrzArchive {
  version: number;
  indexMethod: number;
  indexSize: number;
  indexHash: Uint8Array;
  /** Uncompressed index bytes. */
  index: Uint8Array;
  blobs: BlobInfo[];
  /** Blob number per file, in file order. */
  fileBlob: number[];
  files: FileMap;
}

export interface ReadOptions {
  /** zstd decoder; defaults to fzstd. */
  unzstd?: (bytes: Uint8Array) => Uint8Array;
  /** Check the index and blob BLAKE3 hashes (throws on a mismatch). */
  verify?: boolean;
}

const HEADER = 45;

/** Reads a .brz into its index details and files. Raw blobs are views into the input. */
export function readBrzArchive(buf: ArrayBuffer | Uint8Array, opts: ReadOptions = {}): BrzArchive {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < HEADER || String.fromCharCode(u8[0]!, u8[1]!, u8[2]!) !== 'BRZ') throw new Error('not a .brz save (no BRZ header)');
  const unzstd = opts.unzstd ?? zstdDecompress;
  const unz = (bytes: Uint8Array, method: number): Uint8Array => {
    if (method === 0) return bytes;
    if (method === 1) return unzstd(bytes);
    throw new Error('unknown compression ' + method);
  };
  const version = u8[3]!, indexMethod = u8[4]!;
  const indexSize = dv.getUint32(5, true), idxStored = dv.getUint32(9, true);
  const indexHash = u8.slice(13, HEADER);
  const idx = unz(u8.subarray(HEADER, HEADER + idxStored), indexMethod);
  const iv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
  let o = 0;
  const ints = (n: number): number[] => {
    const a: number[] = [];
    for (let i = 0; i < n; i++) { a.push(iv.getInt32(o, true)); o += 4; }
    return a;
  };
  const shorts = (n: number): number[] => {
    const a: number[] = [];
    for (let i = 0; i < n; i++) { a.push(iv.getUint16(o, true)); o += 2; }
    return a;
  };
  const strs = (lens: number[]): string[] => lens.map((L) => { const s = fromUtf8(idx.subarray(o, o + L)); o += L; return s; });
  const [nFold = 0, nFile = 0, nBlob = 0] = ints(3);
  const fPar = ints(nFold), fNames = strs(shorts(nFold));
  const fileFolder = ints(nFile), fileBlob = ints(nFile), fileNames = strs(shorts(nFile));
  const method = Array.from(idx.subarray(o, o + nBlob)); o += nBlob;
  const size = ints(nBlob), stored = ints(nBlob);
  const hashes: Uint8Array[] = [];
  for (let b = 0; b < nBlob; b++) { hashes.push(idx.slice(o, o + 32)); o += 32; }
  if (opts.verify && !bytesEqual(blake3(idx), indexHash)) throw new Error('index hash mismatch');
  let p = HEADER + idxStored;
  const blobs: Uint8Array[] = [], info: BlobInfo[] = [];
  for (let b = 0; b < nBlob; b++) {
    const m = method[b]!, n = m ? stored[b]! : size[b]!;
    const data = unz(u8.subarray(p, p + n), m);
    p += n;
    if (opts.verify && !bytesEqual(blake3(data), hashes[b]!)) throw new Error(`blob ${b} hash mismatch`);
    blobs.push(data);
    info.push({ method: m, size: size[b]!, stored: stored[b]!, hash: hashes[b]! });
  }
  const folderPath = (f: number): string => {
    const parts: string[] = [];
    while (f >= 0) { parts.unshift(fNames[f]!); f = fPar[f]!; }
    return parts.join('/');
  };
  const files: FileMap = new Map();
  for (let i = 0; i < nFile; i++) files.set((folderPath(fileFolder[i]!) + '/' + fileNames[i]).replace(/^\//, ''), blobs[fileBlob[i]!]!);
  return { version, indexMethod, indexSize, indexHash, index: idx, blobs: info, fileBlob, files };
}

/** Reads a .brz into path -> bytes (the viewer's readBrz). */
export function readBrz(buf: ArrayBuffer | Uint8Array, opts: ReadOptions = {}): FileMap {
  return readBrzArchive(buf, opts).files;
}

export interface WriteOptions {
  version?: number;
  /** Optional zstd encoder. With it, the index is always compressed and blobs only when smaller (as brzwrite.py). */
  zstd?: (bytes: Uint8Array) => Uint8Array;
}

/** Files (insertion order kept, one blob per file, as brzwrite.py) -> .brz bytes. Method 0 by default. */
export function writeBrz(files: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>, opts: WriteOptions = {}): Uint8Array {
  const version = opts.version ?? 0, z = opts.zstd;
  const folders: string[] = [], fKey = new Map<string, number>(), fPar: number[] = [];
  const entries: [folder: number, name: string, content: Uint8Array][] = [];
  const folderId = (parts: string[]): number => {
    let parent = -1;
    for (let d = 0; d < parts.length; d++) {
      const key = parts.slice(0, d + 1).join('/');
      if (!fKey.has(key)) { fKey.set(key, folders.length); folders.push(parts[d]!); fPar.push(parent); }
      parent = fKey.get(key)!;
    }
    return parent;
  };
  const list: ReadonlyMap<string, Uint8Array> = files instanceof Map ? files : new Map(Object.entries(files));
  for (const [p, content] of list) {
    const parts = p.split('/'), name = parts.pop()!;
    entries.push([folderId(parts), name, content]);
  }
  const meth: number[] = [], sizes: number[] = [], stored: number[] = [], bodies: Uint8Array[] = [];
  for (const [, , c] of entries) {
    const zc = z ? z(c) : null;
    if (zc && zc.length < c.length) { meth.push(1); stored.push(zc.length); bodies.push(zc); }
    else { meth.push(0); stored.push(c.length); bodies.push(c); }
    sizes.push(c.length);
  }
  const ix = new ByteBuf();
  const i32 = (a: number[]): void => a.forEach((x) => ix.num('setInt32', 4, x, true));
  const names = (l: string[]): void => {
    const b = l.map(utf8);
    b.forEach((s) => ix.num('setUint16', 2, s.length, true));
    b.forEach((s) => ix.bytes(s));
  };
  i32([folders.length, entries.length, entries.length]);
  i32(fPar);
  names(folders);
  i32(entries.map((e) => e[0]));
  i32(entries.map((_, i) => i));
  names(entries.map((e) => e[1]));
  ix.bytes(Uint8Array.from(meth));
  i32(sizes);
  i32(stored);
  for (const [, , c] of entries) ix.bytes(blake3(c));
  const idx = ix.done(), idxStored = z ? z(idx) : idx;
  const out = new ByteBuf();
  out.bytes(utf8('BRZ'));
  out.byte(version);
  out.byte(z ? 1 : 0);
  out.num('setUint32', 4, idx.length, true);
  out.num('setUint32', 4, idxStored.length, true);
  out.bytes(blake3(idx));
  out.bytes(idxStored);
  bodies.forEach((b) => out.bytes(b));
  return out.done();
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
