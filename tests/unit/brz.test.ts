import { describe, expect, it } from 'vitest';
import { blake3 } from '../../src/format/blake3.ts';
import { readBrzArchive, writeBrz } from '../../src/format/brz.ts';
import { utf8 } from '../../src/format/msgpack.ts';

describe('brz container', () => {
  const files = new Map([
    ['Meta/Info.json', utf8('{"a":1}')],
    ['World/0/GlobalData.mps', Uint8Array.from({ length: 3000 }, (_, i) => i * 7)],
    ['World/0/Bricks/Grids/1/Chunks/0_0_0.mps', new Uint8Array(0)],
    ['Top.bin', Uint8Array.of(1, 2, 3)],
  ]);

  it('writes method 0 and reads it back with hashes verified', () => {
    const brz = writeBrz(files);
    expect(String.fromCharCode(...brz.subarray(0, 3))).toBe('BRZ');
    const a = readBrzArchive(brz, { verify: true });
    expect(a.indexMethod).toBe(0);
    expect([...a.files.keys()]).toEqual([...files.keys()]);
    for (const [p, b] of files) expect(a.files.get(p)).toEqual(b);
    a.blobs.forEach((info, i) => {
      expect(info.method).toBe(0);
      expect(info.hash).toEqual(blake3([...files.values()][i]!));
    });
  });

  it('is stable: write(read(write(x))) == write(x)', () => {
    const once = writeBrz(files);
    expect(writeBrz(readBrzArchive(once).files)).toEqual(once);
  });

  it('uses a compressor only when it helps, and always for the index', () => {
    // a reversible stand-in for zstd: marker byte + payload when "compressing" pays off
    const store = new Map<string, Uint8Array>();
    const fake = (b: Uint8Array): Uint8Array => {
      if (b.length < 100) return new Uint8Array(b.length + 5);
      const key = Uint8Array.of(store.size);
      store.set(String(store.size), b);
      return key;
    };
    const brz = writeBrz(files, { zstd: fake });
    expect(brz[4]).toBe(1);
    const a = readBrzArchive(brz, { unzstd: (k) => store.get(String(k[0]))!, verify: true });
    expect(a.blobs.map((b) => b.method)).toEqual([0, 1, 0, 0]);
    expect(a.files.get('World/0/GlobalData.mps')).toEqual(files.get('World/0/GlobalData.mps'));
  });

  it('rejects other files and bad hashes', () => {
    expect(() => readBrzArchive(utf8('PK\u0003\u0004' + ' '.repeat(60)))).toThrow(/BRZ/);
    const brz = writeBrz(files);
    const last = brz.length - 1;
    brz[last] = brz[last]! ^ 0xff;
    expect(() => readBrzArchive(brz, { verify: true })).toThrow(/hash/);
  });
});
