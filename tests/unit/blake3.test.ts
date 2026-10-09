import { describe, expect, it } from 'vitest';
import { blake3, toHex } from '../../src/format/blake3.ts';
import vectors from './blake3-vectors.json';

const input = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i % 251);

describe('blake3', () => {
  it('hashes the empty input to the published value', () => {
    expect(toHex(blake3(new Uint8Array(0)))).toBe('af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
  });
  for (const { len, hash } of vectors.cases) {
    it(`matches the reference for ${len} bytes`, () => {
      expect(toHex(blake3(input(len)))).toBe(hash);
    });
  }
  it('does not depend on the view offset', () => {
    const big = input(5000), view = big.subarray(7, 4100);
    expect(toHex(blake3(view))).toBe(toHex(blake3(view.slice())));
  });
});
