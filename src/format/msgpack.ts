// MessagePack: the subset the save format uses, read and written with the same encoding
// choices as tools/brzwrite.py (smallest int form, every float as f32), so a decode followed by
// an encode gives the original bytes. Kept in-house for that byte-identity (ARCHITECTURE.md 5).

/** A decoded MessagePack value. Maps decode to a MsgMap: ordered [key, value] pairs. */
export type MsgValue = null | boolean | number | string | Uint8Array | MsgValue[] | MsgMap;

/** A decoded MessagePack map: its [key, value] pairs in file order (an Array, so it iterates as pairs). */
export class MsgMap extends Array<[MsgValue, MsgValue]> {}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
export const utf8 = (s: string): Uint8Array => textEncoder.encode(s);
export const fromUtf8 = (b: Uint8Array): string => textDecoder.decode(b);

/** Streaming MessagePack reader over a byte view (no copies: bins are subarrays). */
export class MsgReader {
  readonly u: Uint8Array;
  p = 0;
  private readonly dv: DataView;

  constructor(u8: Uint8Array) {
    this.u = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  byte(): number {
    if (this.p >= this.u.length) throw new Error(`MessagePack: unexpected end at ${this.p}`);
    return this.u[this.p++]!;
  }

  private take(n: number): Uint8Array {
    if (this.p + n > this.u.length) throw new Error(`MessagePack: ${n} bytes past the end at ${this.p}`);
    const s = this.u.subarray(this.p, this.p + n);
    this.p += n;
    return s;
  }

  private be(fn: 'getUint8' | 'getUint16' | 'getUint32' | 'getInt8' | 'getInt16' | 'getInt32' | 'getFloat32' | 'getFloat64', n: number): number {
    const v = this.dv[fn](this.p, false);
    this.p += n;
    return v;
  }

  private be64(signed: boolean): number {
    const v = signed ? this.dv.getBigInt64(this.p, false) : this.dv.getBigUint64(this.p, false);
    this.p += 8;
    return Number(v);
  }

  private arr(n: number): MsgValue[] {
    const a: MsgValue[] = [];
    for (let i = 0; i < n; i++) a.push(this.next());
    return a;
  }

  private map(n: number): MsgMap {
    const m = new MsgMap();
    for (let i = 0; i < n; i++) m.push([this.next(), this.next()]);
    return m;
  }

  /** One MessagePack value; arrays and maps are fully decoded. */
  next(): MsgValue {
    const b = this.byte();
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 256;
    if (b >= 0xa0 && b <= 0xbf) return fromUtf8(this.take(b & 31));
    if (b >= 0x90 && b <= 0x9f) return this.arr(b & 15);
    if (b >= 0x80 && b <= 0x8f) return this.map(b & 15);
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return this.take(this.byte());
      case 0xc5: return this.take(this.be('getUint16', 2));
      case 0xc6: return this.take(this.be('getUint32', 4));
      case 0xca: return this.be('getFloat32', 4);
      case 0xcb: return this.be('getFloat64', 8);
      case 0xcc: return this.byte();
      case 0xcd: return this.be('getUint16', 2);
      case 0xce: return this.be('getUint32', 4);
      case 0xcf: return this.be64(false);
      case 0xd0: return this.be('getInt8', 1);
      case 0xd1: return this.be('getInt16', 2);
      case 0xd2: return this.be('getInt32', 4);
      case 0xd3: return this.be64(true);
      case 0xd9: return fromUtf8(this.take(this.byte()));
      case 0xda: return fromUtf8(this.take(this.be('getUint16', 2)));
      case 0xdb: return fromUtf8(this.take(this.be('getUint32', 4)));
      case 0xdc: return this.arr(this.be('getUint16', 2));
      case 0xdd: return this.arr(this.be('getUint32', 4));
      case 0xde: return this.map(this.be('getUint16', 2));
      case 0xdf: return this.map(this.be('getUint32', 4));
    }
    throw new Error(`MessagePack byte 0x${b.toString(16)} at ${this.p - 1} not supported`);
  }

  /** Header of a MessagePack map: its number of pairs. */
  mapLen(): number {
    const b = this.byte();
    if (b >= 0x80 && b <= 0x8f) return b & 15;
    if (b === 0xde) return this.be('getUint16', 2);
    if (b === 0xdf) return this.be('getUint32', 4);
    throw new Error(`expected a map at ${this.p - 1}`);
  }

  /** Peeks whether the next value is nil (without consuming anything else). */
  peekNil(): boolean {
    return this.u[this.p] === 0xc0;
  }

  /** Header of a MessagePack array: its length. */
  arrayLen(): number {
    const b = this.byte();
    if (b >= 0x90 && b <= 0x9f) return b & 15;
    if (b === 0xdc) return this.be('getUint16', 2);
    if (b === 0xdd) return this.be('getUint32', 4);
    throw new Error(`expected an array at ${this.p - 1}`);
  }
}

type SetFn = 'setUint8' | 'setInt8' | 'setUint16' | 'setInt16' | 'setUint32' | 'setInt32' | 'setFloat32' | 'setFloat64';

/** Growable byte buffer. */
export class ByteBuf {
  u = new Uint8Array(256);
  dv = new DataView(this.u.buffer);
  n = 0;

  room(k: number): void {
    if (this.n + k <= this.u.length) return;
    const u = new Uint8Array(Math.max(this.u.length * 2, this.n + k));
    u.set(this.u);
    this.u = u;
    this.dv = new DataView(u.buffer);
  }

  byte(b: number): void {
    this.room(1);
    this.u[this.n++] = b & 0xff;
  }

  bytes(b: Uint8Array): void {
    this.room(b.length);
    this.u.set(b, this.n);
    this.n += b.length;
  }

  num(fn: SetFn, k: number, x: number, le: boolean): void {
    this.room(k);
    this.dv[fn](this.n, x, le);
    this.n += k;
  }

  big(signed: boolean, x: bigint, le: boolean): void {
    this.room(8);
    if (signed) this.dv.setBigInt64(this.n, x, le);
    else this.dv.setBigUint64(this.n, x, le);
    this.n += 8;
  }

  done(): Uint8Array {
    return this.u.slice(0, this.n);
  }
}

/** Values the packer accepts for a single (non-container) MessagePack item. */
export type Packable = null | undefined | boolean | number | bigint | string | Uint8Array;

/** Packs one scalar / string / bin. `isFloat` forces f32 (brzwrite.py packs every float as f32). */
export function pack(o: ByteBuf, x: Packable, isFloat = false): void {
  if (x === null || x === undefined) return o.byte(0xc0);
  if (x === true) return o.byte(0xc3);
  if (x === false) return o.byte(0xc2);
  if (typeof x === 'bigint') x = Number(x);
  if (typeof x === 'number') {
    if (isFloat || !Number.isInteger(x)) {
      o.byte(0xca);
      return o.num('setFloat32', 4, x, false);
    }
    if (x >= 0 && x <= 0x7f) return o.byte(x);
    if (x < 0 && x >= -32) return o.byte(x & 0xff);
    if (x >= 0) {
      if (x <= 0xff) { o.byte(0xcc); return o.byte(x); }
      if (x <= 0xffff) { o.byte(0xcd); return o.num('setUint16', 2, x, false); }
      if (x <= 0xffffffff) { o.byte(0xce); return o.num('setUint32', 4, x, false); }
      o.byte(0xcf);
      return o.big(false, BigInt(x), false);
    }
    if (x >= -0x80) { o.byte(0xd0); return o.num('setInt8', 1, x, false); }
    if (x >= -0x8000) { o.byte(0xd1); return o.num('setInt16', 2, x, false); }
    if (x >= -0x80000000) { o.byte(0xd2); return o.num('setInt32', 4, x, false); }
    o.byte(0xd3);
    return o.big(true, BigInt(x), false);
  }
  if (typeof x === 'string') {
    const b = utf8(x), n = b.length;
    if (n < 32) o.byte(0xa0 | n);
    else if (n < 256) { o.byte(0xd9); o.byte(n); }
    else if (n < 65536) { o.byte(0xda); o.num('setUint16', 2, n, false); }
    else { o.byte(0xdb); o.num('setUint32', 4, n, false); }
    return o.bytes(b);
  }
  if (x instanceof Uint8Array) {
    const n = x.length;
    if (n < 256) { o.byte(0xc4); o.byte(n); }
    else if (n < 65536) { o.byte(0xc5); o.num('setUint16', 2, n, false); }
    else { o.byte(0xc6); o.num('setUint32', 4, n, false); }
    return o.bytes(x);
  }
  throw new TypeError('cannot pack ' + Object.prototype.toString.call(x));
}

/** f64 (0xcb). */
export function packFloat64(o: ByteBuf, x: number): void {
  o.byte(0xcb);
  o.num('setFloat64', 8, x, false);
}

/** MessagePack map header. */
export function mapHeader(o: ByteBuf, n: number): void {
  if (n < 16) o.byte(0x80 | n);
  else if (n < 65536) { o.byte(0xde); o.num('setUint16', 2, n, false); }
  else { o.byte(0xdf); o.num('setUint32', 4, n, false); }
}

/** MessagePack array header. */
export function arrayHeader(o: ByteBuf, n: number): void {
  if (n < 16) o.byte(0x90 | n);
  else if (n < 65536) { o.byte(0xdc); o.num('setUint16', 2, n, false); }
  else { o.byte(0xdd); o.num('setUint32', 4, n, false); }
}
