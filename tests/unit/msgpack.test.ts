import { describe, expect, it } from 'vitest';
import { ByteBuf, MsgReader, arrayHeader, pack, type Packable } from '../../src/format/msgpack.ts';

const enc = (x: Packable, f = false): Uint8Array => { const o = new ByteBuf(); pack(o, x, f); return o.done(); };
const dec = (b: Uint8Array): unknown => new MsgReader(b).next();

describe('msgpack', () => {
  it('uses the smallest integer form', () => {
    const cases: [number, number[]][] = [
      [0, [0x00]], [127, [0x7f]], [128, [0xcc, 0x80]], [255, [0xcc, 0xff]], [256, [0xcd, 0x01, 0x00]],
      [65536, [0xce, 0, 1, 0, 0]], [-1, [0xff]], [-32, [0xe0]], [-33, [0xd0, 0xdf]], [-129, [0xd1, 0xff, 0x7f]],
      [-32769, [0xd2, 0xff, 0xff, 0x7f, 0xff]],
    ];
    for (const [x, bytes] of cases) {
      expect([...enc(x)], String(x)).toEqual(bytes);
      expect(dec(enc(x))).toBe(x);
    }
  });
  it('round-trips 64-bit integers within the safe range', () => {
    for (const x of [2 ** 32, 2 ** 40 + 3, -(2 ** 31) - 1, -(2 ** 40)]) expect(dec(enc(x))).toBe(x);
  });
  it('packs floats as f32', () => {
    expect([...enc(1.5)]).toEqual([0xca, 0x3f, 0xc0, 0, 0]);
    expect([...enc(2, true)]).toEqual([0xca, 0x40, 0, 0, 0]);
    expect(dec(enc(0.25))).toBe(0.25);
  });
  it('round-trips strings, bins, nil and booleans', () => {
    for (const s of ['', 'a', 'x'.repeat(31), 'y'.repeat(32), 'z'.repeat(300), 'héllo \u{1f9f1}']) expect(dec(enc(s))).toBe(s);
    for (const n of [0, 5, 255, 256, 70000]) {
      const b = Uint8Array.from({ length: n }, (_, i) => i & 0xff);
      expect(dec(enc(b))).toEqual(b);
    }
    expect(dec(enc(null))).toBe(null);
    expect(dec(enc(true))).toBe(true);
    expect(dec(enc(false))).toBe(false);
  });
  it('reads array headers', () => {
    for (const n of [0, 15, 16, 65535, 65536]) {
      const o = new ByteBuf();
      arrayHeader(o, n);
      expect(new MsgReader(o.done()).arrayLen()).toBe(n);
    }
  });
  it('decodes maps as ordered pairs', () => {
    expect(dec(Uint8Array.from([0x82, 0xa1, 0x62, 0x01, 0xa1, 0x61, 0x02]))).toEqual([['b', 1], ['a', 2]]);
  });
});

describe('msgpack 64-bit', () => {
  it('keeps 64-bit integers beyond 2^53 exact (as bigints)', () => {
    for (const x of [-(2n ** 63n), -(2n ** 53n) - 7n, 2n ** 53n + 1n, 2n ** 64n - 1n]) {
      const b = enc(x);
      expect(b[0]).toBe(x < 0n ? 0xd3 : 0xcf);
      expect(dec(b)).toBe(x);
    }
    expect(dec(enc(2n ** 40n))).toBe(2 ** 40);   // exact ones still read back as numbers
  });
});
