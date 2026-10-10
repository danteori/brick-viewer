// The fast load path (scene/fastload.ts) gives exactly the store the PlainBrick path gives:
// every column of every row, the report and the unsupported bricks, on every reference save.
import { describe, expect, it } from 'vitest';
import { readBrz } from '../../src/format/brz.ts';
import { storeFromFiles, storeFromFilesPlain } from '../../src/scene/load.ts';
import { hasRefs, readRef, referenceSaves } from './refs.ts';
import { synthSave } from './synthsave.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// opt-in, like bigworlds.test.ts: a folder of big .brz files (nothing about them is stored)
const DIR = process.env.BRICK_BIG_WORLDS;
const big = DIR && existsSync(DIR) ? readdirSync(DIR).filter((n) => n.endsWith('.brz')).sort() : [];

const COLS = ['px', 'py', 'pz', 'hx', 'hy', 'hz', 'orient', 'asset', 'shape', 'color', 'material', 'owner', 'origOwner', 'collision', 'flags', 'faceMask', 'grid', 'srcOrder', 'order'] as const;

function same(bytes: Uint8Array): void {
  const files = readBrz(bytes);
  const a = storeFromFilesPlain(files), b = storeFromFiles(files);
  expect(b.store.n).toBe(a.store.n);
  expect(b.store.count).toBe(a.store.count);
  for (const c of COLS) expect(Array.from(b.store[c].subarray(0, b.store.n)), c).toEqual(Array.from(a.store[c].subarray(0, a.store.n)));
  expect(b.store.flagFields).toEqual(a.store.flagFields);
  expect(b.report).toEqual(a.report);
  expect(b.unsupported).toEqual(a.unsupported);
  expect(b.order.chunks).toEqual(a.order.chunks);
  expect(Array.from(b.order.seqChunk)).toEqual(Array.from(a.order.seqChunk));
  expect(Array.from(b.order.seqIndex)).toEqual(Array.from(a.order.seqIndex));
}

describe('fast load path', () => {
  it('matches on a synthetic save with special materials', () => {
    same(synthSave([
      { asset: 'PB_DefaultBrick', size: [20, 20, 12], pos: [0, 0, 12], color: [255, 240, 200], material: 'BMC_Glow', intensity: 10 },
      { asset: 'PB_DefaultTile', size: [10, 10, 2], pos: [400, 0, 2], color: [120, 180, 255], material: 'BMC_Glass', intensity: 0 },
      { asset: 'PB_DefaultBrick', size: [40, 40, 6], pos: [400, 30, -6], color: [230, 230, 230] },
    ]));
  });
  it.skipIf(!hasRefs).each(referenceSaves())('matches on %s', (rel) => { same(readRef(rel)); });
  it.skipIf(!big.length).each(big)('matches on big save %s', (n) => { same(new Uint8Array(readFileSync(join(DIR!, n)))); }, 600_000);
});
