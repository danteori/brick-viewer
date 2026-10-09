// Parity with the private workspace's tools/brzwriter.js (the code this port came from), when
// it's next to this repo (BRICK_TOOLS, default ../tools). Skipped otherwise.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { blake3 } from '../../src/format/blake3.ts';
import { readBrz, writeBrz, type FileMap } from '../../src/format/brz.ts';
import { decodeMps, encodeMps, parseSchema, type Schema } from '../../src/format/schema.ts';
import { extractBricks, rebuildFromLoaded } from '../../src/format/world.ts';
import { hasRefs, readRef, referenceSaves } from './refs.ts';

const TOOLS = resolve(import.meta.dirname, '../..', process.env.BRICK_TOOLS ?? '../tools');
const src = resolve(TOOLS, 'brzwriter.js');
const have = existsSync(src);

interface Legacy {
  blake3(b: Uint8Array): Uint8Array;
  encodeMps(v: unknown, s: Schema): Uint8Array;
  writeBrz(f: FileMap): Uint8Array;
  extractBricks(f: FileMap, o: object): { bricks: unknown[] };
  rebuildFromLoaded(f: FileMap, b: unknown[], o: object): { files: FileMap; warnings: string[] };
}

function loadLegacy(): Legacy {
  const window: { BrzWriter?: Legacy } = {};
  runInNewContext(readFileSync(src, 'utf8'), { window, TextEncoder, Uint8Array, Uint32Array, DataView, Map, Set, BigInt, Math, Object, Array, Number, RegExp, Error, TypeError });
  return window.BrzWriter!;
}

describe.skipIf(!have)('parity with tools/brzwriter.js', () => {
  const L = have ? loadLegacy() : (null as unknown as Legacy);
  const opts = { decodeMps, parseSchema };

  it('blake3 agrees on assorted lengths', () => {
    for (const n of [0, 1, 64, 1024, 1025, 4097, 33000]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 31) & 0xff);
      expect([...blake3(b)]).toEqual([...L.blake3(b)]);
    }
  });

  describe.skipIf(!hasRefs).each(hasRefs ? referenceSaves() : [])('%s', (rel) => {
    const files = readBrz(readRef(rel));
    it('writeBrz and rebuildFromLoaded give the same bytes', () => {
      expect([...writeBrz(files)]).toEqual([...L.writeBrz(files)]);
      if (!files.has('World/0/Bricks/ChunksShared.schema')) return;
      const ours = extractBricks(files).bricks;
      // brzwriter.js reads OriginalOwnerIndices unconditionally, which older saves lack; the port
      // falls back to the owner. Those saves can't be compared, so check the cause and stop.
      const chunkFields = parseSchema(files.get('World/0/Bricks/ChunksShared.schema')!);
      if (!chunkFields.S.get(chunkFields.root)!.some(([f]) => f === 'OriginalOwnerIndices')) {
        expect(() => L.extractBricks(files, opts)).toThrow();
        return;
      }
      expect(JSON.parse(JSON.stringify(L.extractBricks(files, opts).bricks))).toEqual(JSON.parse(JSON.stringify(ours)));
      const a = rebuildFromLoaded(files, ours), b = L.rebuildFromLoaded(files, ours, opts);
      expect(a.warnings).toEqual(b.warnings);
      expect([...writeBrz(a.files)]).toEqual([...L.writeBrz(b.files)]);
    });
  });

  it('encodeMps agrees on a GlobalData sample', () => {
    if (!hasRefs) return;
    const first = referenceSaves()[0]!;
    const files = readBrz(readRef(first));
    const s = parseSchema(files.get('World/0/GlobalData.schema')!);
    const v = decodeMps(files.get('World/0/GlobalData.mps')!, s);
    expect([...encodeMps(v, s)]).toEqual([...L.encodeMps(v, s)]);
  });
});
