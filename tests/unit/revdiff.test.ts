// W-05 revision diff: file, brick, component and wire counts between two states of a world.
import { beforeAll, describe, expect, it } from 'vitest';
import { appendRevision, BrdbWorld, writeNewWorld } from '../../src/format/brdb.ts';
import { LazyBrdbWorld } from '../../src/format/brdblazy.ts';
import type { FileMap } from '../../src/format/brz.ts';
import { bytesSource } from '../../src/format/sqlitelazy.ts';
import type { SqlBackend } from '../../src/format/sql.ts';
import { diffSummary, matchBricks, revisionDiff } from '../../src/format/revdiff.ts';
import type { PlainBrick } from '../../src/format/world.ts';
import { plainBox } from '../../src/ui/overlay/revmarks.ts';
import { nodeSql } from './brdb-helpers.ts';
import { enc, INDEX, OLD_CHUNKS, oldWorld, W } from './brdb-synth.ts';

let sql: SqlBackend;
beforeAll(async () => { sql = await nodeSql(); });

const pb = (asset: string, pos: [number, number, number], color: [number, number, number, number] = [1, 2, 3, 5], size: [number, number, number] | null = [5, 5, 6]): PlainBrick =>
  ({ asset, size, pos, orient: 16, color, material: 'BMC_Plastic', owner: 0, originalOwner: 0 });

describe('matchBricks', () => {
  it('pairs bricks by asset, size, position and orientation; paint differences are changes', () => {
    const a = [pb('PB_DefaultBrick', [0, 0, 6]), pb('PB_DefaultBrick', [10, 0, 6]), pb('PB_DefaultBrick', [20, 0, 6])];
    const b = [pb('PB_DefaultBrick', [0, 0, 6]), pb('PB_DefaultBrick', [10, 0, 6], [9, 9, 9, 5]), pb('PB_DefaultBrick', [30, 0, 6])];
    const seen: string[] = [];
    expect(matchBricks(a, b, (k, x) => seen.push(`${k}@${x.pos[0]}`))).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(seen.sort()).toEqual(['added@30', 'changed@10', 'removed@20']);
  });
  it('handles duplicates (two identical bricks at one place) and empty sides', () => {
    const x = pb('PB_DefaultBrick', [0, 0, 6]);
    expect(matchBricks([x, x], [x])).toEqual({ added: 0, removed: 1, changed: 0 });
    expect(matchBricks([], [x, x])).toEqual({ added: 2, removed: 0, changed: 0 });
    expect(matchBricks([x], [x])).toEqual({ added: 0, removed: 0, changed: 0 });
  });
});

/** oldWorld plus a chunk index; `bricks` = [asset index, rel pos X, colour B] per brick (procedural = index 1). */
function world(bricks: [number, number, number][], comps = 0): FileMap {
  const f = oldWorld();
  f.set(W + 'Bricks/ChunkIndexShared.schema', INDEX);
  f.set(W + 'Bricks/Grids/1/ChunkIndex.mps', enc(INDEX, { Chunk3DIndices: [{ X: 0, Y: 0, Z: 0 }], ChunkOffsets: [{ X: 0, Y: 0, Z: 0 }], ChunkSizes: [2048], NumBricks: [bricks.length], NumComponents: [comps], NumWires: [0] }));
  const proc = bricks.filter((b) => b[0] === 1).length;
  f.set(W + 'Bricks/Grids/1/Chunks/0_0_0.mps', enc(OLD_CHUNKS, {
    ProceduralBrickStartingIndex: 1, BrickSizeCounters: proc ? [{ AssetIndex: 0, NumSizes: 1 }] : [], BrickSizes: proc ? [{ X: 5, Y: 5, Z: 6 }] : [],
    BrickTypeIndices: bricks.map((b) => b[0]), OwnerIndices: bricks.map(() => 0), RelativePositions: bricks.map((b) => ({ X: b[1], Y: 0, Z: 6 })),
    Orientations: bricks.map(() => 16), CollisionFlags_Player: { Flags: [255] }, CollisionFlags_Tool: { Flags: [255] }, VisibilityFlags: { Flags: [255] },
    MaterialIndices: bricks.map(() => 0), ColorsAndAlphas: bricks.map((b) => ({ R: 0, G: 0, B: b[2], A: 5 })),
  }));
  return f;
}

function threeRevisions(): Uint8Array {
  const v1 = world([[0, 0, 10], [1, 20, 10]]);
  const w1 = BrdbWorld.open(sql, writeNewWorld(sql, v1, { when: 1000 }));
  // revision 3: the procedural brick repainted, one more procedural brick, a component count bump
  const v2 = world([[0, 0, 10], [1, 20, 99], [1, 40, 10]], 1);
  v2.set('Meta/Extra.json', new Uint8Array([1, 2, 3]));
  const b2 = appendRevision(w1, v2, { when: 2000 }).bytes;
  const w2 = BrdbWorld.open(sql, b2);
  // revision 4: the fixed brick removed
  const v3 = world([[1, 20, 99], [1, 40, 10]], 1);
  v3.set('Meta/Extra.json', new Uint8Array([1, 2, 3]));
  const b3 = appendRevision(w2, v3, { when: 3000 }).bytes;
  w1.close(); w2.close();
  return b3;
}

describe('revisionDiff', () => {
  it('counts files, bricks, components between revisions (sql.js world)', async () => {
    const w = BrdbWorld.open(sql, threeRevisions());
    expect(w.revisions.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    const d = await revisionDiff(w, w.tree(2), w.tree(3));
    expect(d.files.added).toEqual(['Meta/Extra.json']);
    expect(d.files.changed.sort()).toEqual([W + 'Bricks/Grids/1/ChunkIndex.mps', W + 'Bricks/Grids/1/Chunks/0_0_0.mps']);
    expect(d.bricks).toMatchObject({ added: 1, removed: 0, changed: 1, counted: true });
    expect(d.before).toEqual({ bricks: 2, components: 0, wires: 0 });
    expect(d.after).toEqual({ bricks: 3, components: 1, wires: 0 });
    expect(d.chunks).toEqual({ bricks: 1, components: 0, wires: 0 });
    expect(d.marks.added.map((b) => b.pos)).toEqual([[1024 + 40, 1024, 1024 + 6]]);
    expect(d.marks.changed[0]!.color).toEqual([0, 0, 99, 5]);
    const d2 = await revisionDiff(w, w.tree(3), w.tree(4));
    expect(d2.bricks).toMatchObject({ added: 0, removed: 1, changed: 0 });
    expect(d2.marks.removed[0]!.asset).toBe('B_1x1');
    expect(diffSummary(d2)).toBe('+0 −1 ~0 bricks · components 1 → 1 · wires 0 → 0 · 2 files');
    // the first revision against nothing: every brick is added
    const d0 = await revisionDiff(w, null, w.tree(1));
    expect(d0.before).toBeNull();
    expect(d0.bricks.added).toBe(2);
    expect(d0.files.added.length).toBe(w.tree(1).paths().length);
    // identical trees
    expect(diffSummary(await revisionDiff(w, w.tree(4), w.tree()))).toBe('no changes');
    w.close();
  });

  it('gives the same counts on a lazily read world, loading only what it needs', async () => {
    const bytes = threeRevisions(), w = await LazyBrdbWorld.open(bytesSource(bytes)), e = BrdbWorld.open(sql, bytes);
    const d = await revisionDiff(w, w.tree(2), w.tree(4)), x = await revisionDiff(e, e.tree(2), e.tree(4));
    expect(d.files).toEqual(x.files);
    expect(d.bricks).toEqual(x.bricks);
    expect(d.bricks).toMatchObject({ added: 1, removed: 1, changed: 1 });
    expect(d.after).toEqual(x.after);
    // only the chunk indexes (and their schemas / GlobalData) stay loaded; the brick chunks were unloaded
    expect(w.stats.loadedBlobs).toBeLessThan(10);
    w.clearCache(); e.close();
  });

  it('skips the brick match over the byte budget unless forced', async () => {
    const w = BrdbWorld.open(sql, threeRevisions());
    const d = await revisionDiff(w, w.tree(2), w.tree(3), { budgetBytes: 1 });
    expect(d.bricks.counted).toBe(false);
    expect(d.bricks.bytes).toBeGreaterThan(1);
    expect(diffSummary(d)).toMatch(/^bricks 2 → 3 \(not matched\)/);
    expect((await revisionDiff(w, w.tree(2), w.tree(3), { budgetBytes: 1, force: true })).bricks.counted).toBe(true);
    // marks are capped
    const c = await revisionDiff(w, null, w.tree(1), { markCap: 1 });
    expect(c.marks.added.length).toBe(1);
    expect(c.marks.truncated).toBe(true);
    w.close();
  });

  it('boxes marks in save units (fixed bricks by their shape, procedural by size)', () => {
    expect(plainBox(pb('PB_DefaultBrick', [0, 0, 6]))).toEqual([-5, -5, 0, 5, 5, 12]);
    const fixed = plainBox(pb('B_1x1_Round', [0, 0, 6], undefined, null));
    expect(fixed[3]! - fixed[0]!).toBeGreaterThan(0);
  });
});
