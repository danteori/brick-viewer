// Lazy .brz reader: parses the header and index only, then decompresses a blob when a file is
// asked for (OPTIMIZATION B.1d). Blob offsets are the running sum of the stored sizes, so any
// file can be reached without touching the others. Nothing is cached: callers that need a file
// twice keep the bytes themselves. Layout as in brz.ts.

import { fromUtf8 } from './msgpack.ts';
import { zstdDecompress } from './zstd.ts';

/**
 * A read-only file tree that hands out one file at a time. A plain FileMap (path -> bytes)
 * fits through fileMapSource; a .brz fits through openBrzLazy.
 */
export interface FileSource {
  /** Every path, in the container's file order. */
  paths(): Iterable<string>;
  has(path: string): boolean;
  /** Uncompressed bytes, or undefined when the path isn't there. May decompress on every call. */
  get(path: string): Uint8Array | undefined;
  /** Uncompressed size without decompressing, when the container knows it. */
  sizeOf(path: string): number | undefined;
  /** Bytes the file takes in the container (compressed size), when known. */
  storedSizeOf(path: string): number | undefined;
}

export interface LazyBrzOptions {
  unzstd?: (bytes: Uint8Array) => Uint8Array;
}

interface Entry { blob: number }

export interface LazyBrz extends FileSource {
  readonly version: number;
  /** Number of distinct blobs (gallery worlds share blobs between identical files). */
  readonly blobCount: number;
  /** Blob number of a file; files with the same blob have identical bytes. */
  blobOf(path: string): number | undefined;
  /** BLAKE3 of the uncompressed blob (stored in the index). */
  hashOf(path: string): Uint8Array | undefined;
}

const HEADER = 45;

/** Opens a .brz without decompressing any blob. Only the index is decoded. */
export function openBrzLazy(buf: ArrayBuffer | Uint8Array, opts: LazyBrzOptions = {}): LazyBrz {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < HEADER || u8[0] !== 0x42 || u8[1] !== 0x52 || u8[2] !== 0x5a) throw new Error('not a .brz save (no BRZ header)');
  const unzstd = opts.unzstd ?? zstdDecompress;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = u8[3]!, indexMethod = u8[4]!, idxStored = dv.getUint32(9, true);
  const rawIdx = u8.subarray(HEADER, HEADER + idxStored);
  const idx = indexMethod === 0 ? rawIdx : indexMethod === 1 ? unzstd(rawIdx) : null;
  if (!idx) throw new Error('unknown index compression ' + indexMethod);
  const iv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
  let o = 0;
  const i32 = (): number => { const v = iv.getInt32(o, true); o += 4; return v; };
  const ints = (n: number): Int32Array => { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i32(); return a; };
  const strs = (n: number): string[] => {
    const lens: number[] = [];
    for (let i = 0; i < n; i++) { lens.push(iv.getUint16(o, true)); o += 2; }
    return lens.map((L) => { const s = fromUtf8(idx.subarray(o, o + L)); o += L; return s; });
  };
  const nFold = i32(), nFile = i32(), nBlob = i32();
  const fPar = ints(nFold), fNames = strs(nFold);
  const fileFolder = ints(nFile), fileBlob = ints(nFile), fileNames = strs(nFile);
  const method = idx.subarray(o, o + nBlob); o += nBlob;
  const size = ints(nBlob), stored = ints(nBlob);
  const hashAt = o;
  // blob byte ranges in the archive
  const start = new Float64Array(nBlob + 1);
  start[0] = HEADER + idxStored;
  for (let b = 0; b < nBlob; b++) start[b + 1] = start[b]! + (method[b] ? stored[b]! : size[b]!);
  if (start[nBlob]! > u8.length) throw new Error('.brz is truncated');

  const folderPath: string[] = new Array(nFold);
  const pathOf = (f: number): string => {
    if (f < 0) return '';
    if (folderPath[f] === undefined) { const up = pathOf(fPar[f]!); folderPath[f] = up ? up + '/' + fNames[f] : fNames[f]!; }
    return folderPath[f]!;
  };
  const entries = new Map<string, Entry>();
  for (let i = 0; i < nFile; i++) {
    const dir = pathOf(fileFolder[i]!);
    entries.set(dir ? dir + '/' + fileNames[i] : fileNames[i]!, { blob: fileBlob[i]! });
  }
  const blobBytes = (b: number): Uint8Array => {
    const body = u8.subarray(start[b]!, start[b + 1]!);
    const m = method[b]!;
    if (m === 0) return body;
    if (m === 1) return unzstd(body);
    throw new Error('unknown compression ' + m);
  };
  return {
    version,
    blobCount: nBlob,
    paths: () => entries.keys(),
    has: (p) => entries.has(p),
    get: (p) => { const e = entries.get(p); return e ? blobBytes(e.blob) : undefined; },
    sizeOf: (p) => { const e = entries.get(p); return e ? size[e.blob] : undefined; },
    storedSizeOf: (p) => { const e = entries.get(p); return e ? (method[e.blob] ? stored[e.blob] : size[e.blob]) : undefined; },
    blobOf: (p) => entries.get(p)?.blob,
    hashOf: (p) => { const e = entries.get(p); return e ? idx.slice(hashAt + e.blob * 32, hashAt + e.blob * 32 + 32) : undefined; },
  };
}

/** A FileSource over an already decoded file map (readBrz's output). */
export function fileMapSource(files: ReadonlyMap<string, Uint8Array>): FileSource {
  return {
    paths: () => files.keys(),
    has: (p) => files.has(p),
    get: (p) => files.get(p),
    sizeOf: (p) => files.get(p)?.length,
    storedSizeOf: (p) => files.get(p)?.length,
  };
}
