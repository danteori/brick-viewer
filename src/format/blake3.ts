// BLAKE3, 32-byte default hash only (no keyed / derive-key modes, no XOF). The save container
// stores one per blob and one for the index. Ported from tools/brzwriter.js.

const IV = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const PERM = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1, CHUNK_END = 2, PARENT = 4, ROOT = 8;

const v = new Uint32Array(16), mw = new Uint32Array(16), tmp = new Uint32Array(16);

function g(a: number, b: number, c: number, d: number, x: number, y: number): void {
  v[a] = v[a]! + v[b]! + x; v[d] = v[d]! ^ v[a]!; v[d] = (v[d]! >>> 16) | (v[d]! << 16);
  v[c] = v[c]! + v[d]!;     v[b] = v[b]! ^ v[c]!; v[b] = (v[b]! >>> 12) | (v[b]! << 20);
  v[a] = v[a]! + v[b]! + y; v[d] = v[d]! ^ v[a]!; v[d] = (v[d]! >>> 8) | (v[d]! << 24);
  v[c] = v[c]! + v[d]!;     v[b] = v[b]! ^ v[c]!; v[b] = (v[b]! >>> 7) | (v[b]! << 25);
}

/** The compression function; returns the new 8-word chaining value. */
function compress(cv: Uint32Array, m: Uint32Array, counter: number, len: number, flags: number): Uint32Array {
  v.set(cv);
  v.set(IV.subarray(0, 4), 8);
  v[12] = counter >>> 0;
  v[13] = Math.floor(counter / 4294967296);
  v[14] = len;
  v[15] = flags;
  mw.set(m);
  for (let r = 0; r < 7; r++) {
    g(0, 4, 8, 12, mw[0]!, mw[1]!); g(1, 5, 9, 13, mw[2]!, mw[3]!); g(2, 6, 10, 14, mw[4]!, mw[5]!); g(3, 7, 11, 15, mw[6]!, mw[7]!);
    g(0, 5, 10, 15, mw[8]!, mw[9]!); g(1, 6, 11, 12, mw[10]!, mw[11]!); g(2, 7, 8, 13, mw[12]!, mw[13]!); g(3, 4, 9, 14, mw[14]!, mw[15]!);
    for (let i = 0; i < 16; i++) tmp[i] = mw[PERM[i]!]!;
    mw.set(tmp);
  }
  const out = new Uint32Array(8);
  for (let i = 0; i < 8; i++) out[i] = v[i]! ^ v[i + 8]!;
  return out;
}

/** BLAKE3 hash (32 bytes) of `bytes`. */
export function blake3(bytes: Uint8Array): Uint8Array {
  const n = bytes.length, nChunks = Math.max(1, Math.ceil(n / 1024));
  const blk = new Uint8Array(64), w = new Uint32Array(16);
  const words = (): Uint32Array => {
    for (let i = 0; i < 16; i++) w[i] = blk[4 * i]! | (blk[4 * i + 1]! << 8) | (blk[4 * i + 2]! << 16) | (blk[4 * i + 3]! << 24);
    return w;
  };
  // one 1024-byte chunk, in 64-byte blocks
  const chunk = (c: number, root: boolean): Uint32Array => {
    const lo = c * 1024, len = Math.min(1024, n - lo), nb = Math.max(1, Math.ceil(len / 64));
    let cv: Uint32Array = IV;
    for (let b = 0; b < nb; b++) {
      const s = lo + b * 64, bl = Math.min(64, n - s);
      blk.fill(0);
      if (bl > 0) blk.set(bytes.subarray(s, s + bl));
      const last = b === nb - 1;
      cv = compress(cv, words(), c, Math.max(bl, 0), (b === 0 ? CHUNK_START : 0) | (last ? CHUNK_END : 0) | (last && root ? ROOT : 0));
    }
    return cv;
  };
  // the left subtree takes the largest power of two below cnt
  const tree = (lo: number, cnt: number, root: boolean): Uint32Array => {
    if (cnt === 1) return chunk(lo, root);
    let k = 1;
    while (k * 2 < cnt) k *= 2;
    const m = new Uint32Array(16);
    m.set(tree(lo, k, false));
    m.set(tree(lo + k, cnt - k, false), 8);
    return compress(IV, m, 0, 64, PARENT | (root ? ROOT : 0));
  };
  const h = tree(0, nChunks, true), out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) out[4 * i + j] = h[i]! >>> (8 * j);
  return out;
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
