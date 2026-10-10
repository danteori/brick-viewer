// C-04: components on bricks made in the viewer. A copy carries its brick's components; a pasted
// (or any new) brick gets a place in the save when it takes a component, and the writer puts its
// components and wires at the index the brick is written at, with the chunk index and owner counts
// in step. Orphans (a paste undone) are left out. Uses the synthetic component save
// (comp-fixture.ts): chunk 0_0_0 holds a switch (0), a skipped light (1) and a chip (2); chunk
// 1_0_0 a lamp (0).
import { describe, expect, it } from 'vitest';
import { bytesEqual, readBrz, writeBrz, type FileMap } from '../../src/format/brz.ts';
import { decodeMps } from '../../src/format/schema.ts';
import { extractBricks } from '../../src/format/world.ts';
import { storeFromFiles } from '../../src/scene/load.ts';
import { attachComponents, componentsOf, type SceneComponents } from '../../src/scene/compmodel.ts';
import { scenePlain, writeModel } from '../../src/scene/save.ts';
import { loadComponents, saveContext } from '../../src/scene/components.ts';
import { loadWires } from '../../src/scene/wires.ts';
import { putPlain } from '../../src/scene/view.ts';
import { hist } from '../../src/scene/history.ts';
import { writeNewWorldFile } from '../../src/format/brdb.ts';
import { LazyBrdbWorld } from '../../src/format/brdblazy.ts';
import { bytesSource } from '../../src/format/sqlitelazy.ts';
import type { SceneStore } from '../../src/scene/store.ts';
import { save } from './comp-fixture.ts';

const W = 'World/0/', G1 = `${W}Bricks/Grids/1/`;

function open(files: FileMap): { scene: SceneStore; m: SceneComponents; unsupported: ReturnType<typeof storeFromFiles>['unsupported'] } {
  const { store, order, unsupported } = storeFromFiles(files);
  expect(attachComponents(store, files, order)).toBeNull();
  return { scene: store, m: componentsOf(store)!, unsupported };
}
/** Save .brz as the app writes it (sceneFiles), as a file tree read back from the .brz bytes. */
const saveScene = (f: FileMap, o: ReturnType<typeof open>): FileMap =>
  readBrz(writeBrz(writeModel(f, scenePlain(o.scene, false).concat(o.unsupported), o.m).files));
const rowOf = (m: SceneComponents, chunk: string, brick: number): number => {
  const [X, Y, Z] = chunk.split('_').map(Number);
  return m.rowOfRef({ grid: 1, chunk: { X: X!, Y: Y!, Z: Z! }, brick });
};
/** A new brick (as a paste or a catalogue drop makes one) at save position `pos`. */
function addRow(scene: SceneStore, pos: [number, number, number], owner = 0): number {
  const id = scene.alloc();
  putPlain(scene, id, { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos, orient: 16, color: [10, 20, 30, 5], material: 'BMC_Plastic', ...(owner ? { owner } : {}) }, false);
  return id;
}
/** Index of the brick written at save position `pos` in its chunk. */
const indexAt = (f: FileMap, pos: number[]): { chunk: string; index: number } => {
  const bs = extractBricks(f).bricks, counts = new Map<string, number>();
  for (const b of bs) {
    const k = b.pos.map((v) => Math.floor(v / 2048)).join('_'), n = counts.get(k) ?? 0;
    counts.set(k, n + 1);
    if (b.pos.join() === pos.join()) return { chunk: k, index: n };
  }
  throw new Error('not written');
};
const compsAt = (f: FileMap, chunk: string, index: number): string[] =>
  loadComponents(f).instances.filter((c) => c.brickRef.grid === 1 && `${c.brickRef.chunk.X}_${c.brickRef.chunk.Y}_${c.brickRef.chunk.Z}` === chunk && c.brickRef.brick === index).map((c) => c.type).sort();
const ci = (f: FileMap): Record<string, unknown[]> => decodeMps<Record<string, unknown[]>>(f.get(`${G1}ChunkIndex.mps`)!, saveContext(f).schemaFor(`${G1}ChunkIndex.mps`));
const numOf = (f: FileMap, field: 'NumComponents' | 'NumWires', chunk: string): number => {
  const c = ci(f), j = (c.Chunk3DIndices as { X: number; Y: number; Z: number }[]).findIndex((k) => `${k.X}_${k.Y}_${k.Z}` === chunk);
  return (c[field] as number[])[j]!;
};
const owners = (f: FileMap): Record<string, number[]> => decodeMps<Record<string, number[]>>(f.get(`${W}Owners.mps`)!, saveContext(f).schemaFor(`${W}Owners.mps`));
const wireList = (f: FileMap): string[] => loadWires(f).wires().map((w) => `${w.source.grid}/${w.source.chunk.X}_${w.source.chunk.Y}_${w.source.chunk.Z}/${w.source.brick}.${w.source.port}->${w.target.grid}/${w.target.chunk.X}_${w.target.chunk.Y}_${w.target.chunk.Z}/${w.target.brick}.${w.target.port}`).sort();
const undo = (): void => { const t = hist.undo.pop()!; if (t.kind === 'data') t.undo(); hist.redo.push(t); };
const redo = (): void => { const t = hist.redo.pop()!; if (t.kind === 'data') t.redo(); hist.undo.push(t); };

describe('components on new bricks (C-04)', () => {
  it('a pasted switch carries its components; saved and reopened they are on the new brick', () => {
    const f = save(), o = open(f), { scene, m } = o, sw = rowOf(m, '0_0_0', 0);
    m.edit(m.componentsOf(sw)[0]!, ['bEnabled'], false);                 // the copy takes the data as it is now
    const carried = m.carriedOf(sw);
    expect(carried.map((c) => c.type)).toEqual(['Test_Switch']);
    const id = addRow(scene, [65, 5, 6]);                                 // chunk 0_0_0, after its 3 bricks
    expect(m.attachCarried(id, carried)).toEqual([]);
    expect(m.componentsOf(id).map((c) => c.type)).toEqual(['Test_Switch']);
    expect(m.refOfRow(id)).toEqual({ grid: 1, chunk: { X: 0, Y: 0, Z: 0 }, brick: 3 });
    expect(m.componentsOf(sw)[0]!.data).not.toBe(m.componentsOf(id)[0]!.data);   // a copy, not shared
    const out = saveScene(f, o), at = indexAt(out, [65, 5, 6]);
    expect(at).toEqual({ chunk: '0_0_0', index: 3 });
    expect(compsAt(out, '0_0_0', 3)).toEqual(['Test_Switch']);
    expect(compsAt(out, '0_0_0', 0)).toEqual(['Test_Switch']);            // the original is still there
    expect(numOf(out, 'NumComponents', '0_0_0')).toBe(4);
    expect(owners(out).ComponentCounts).toEqual([7, 1]);
    const re = open(out), row = rowOf(re.m, '0_0_0', 3);
    expect(row).toBeGreaterThanOrEqual(0);
    expect(re.m.componentsOf(row).map((c) => [c.type, c.data!.bEnabled])).toEqual([['Test_Switch', false]]);
    expect(re.m.componentsOf(rowOf(re.m, '0_0_0', 0)).map((c) => c.type)).toEqual(['Test_Switch']);
    expect(wireList(out)).toEqual(wireList(f));                           // wires are not copied, and the old ones still line up
  });

  it('saved as a world (.brdb), a pasted component brick reads back with its components', async () => {
    const f = save(), o = open(f), id = addRow(o.scene, [65, 5, 6]);
    o.m.attachCarried(id, o.m.carriedOf(rowOf(o.m, '0_0_0', 0)));
    const files = writeModel(f, scenePlain(o.scene, false).concat(o.unsupported), o.m).files;
    const world = await LazyBrdbWorld.open(bytesSource(writeNewWorldFile(files, { when: 1 })), { verify: true });
    const back = await world.tree().loadAll(), re = open(back);
    expect(re.m.componentsOf(rowOf(re.m, '0_0_0', 3)).map((c) => c.type)).toEqual(['Test_Switch']);
    expect(numOf(back, 'NumComponents', '0_0_0')).toBe(4);
  });

  it('a new brick in a chunk the save does not have: new component chunk, chunk index entry and owner count', () => {
    const f = save(), o = open(f), { scene, m } = o;
    const id = addRow(scene, [5, 4105, 6], 1);                             // chunk 0_2_0, owner 1
    expect(m.attachCarried(id, m.carriedOf(rowOf(m, '1_0_0', 0)))).toEqual([]);
    const out = saveScene(f, o);
    expect(out.has(`${G1}Components/0_2_0.mps`)).toBe(true);
    expect(compsAt(out, '0_2_0', 0)).toEqual(['Test_Light']);
    expect(numOf(out, 'NumComponents', '0_2_0')).toBe(1);
    expect(numOf(out, 'NumComponents', '0_0_0')).toBe(numOf(f, 'NumComponents', '0_0_0'));
    expect(owners(out).ComponentCounts).toEqual([6, 2]);                  // counted against the new brick's owner
    const re = open(out);
    expect(re.m.componentsOf(rowOf(re.m, '0_2_0', 0)).map((c) => c.type)).toEqual(['Test_Light']);
  });

  it('Add on a new brick gives it a place as part of the undo step', () => {
    const f = save(), o = open(f), { scene, m } = o;
    const id = addRow(scene, [2120, 5, 6]);                               // chunk 1_0_0, after the lamp
    expect(m.refOfRow(id)).toBeNull();
    expect(m.addableOn(id)).toContain('Test_Light');
    m.addComponent(id, 'Test_Light');
    expect(m.refOfRow(id)).toEqual({ grid: 1, chunk: { X: 1, Y: 0, Z: 0 }, brick: 1 });
    undo();
    expect(scene.srcOrder[id]).toBe(-1);                                  // a plain new brick again
    expect(m.componentsOf(id)).toEqual([]);
    redo();
    expect(m.componentsOf(id).map((c) => c.type)).toEqual(['Test_Light']);
    const out = saveScene(f, o);
    expect(compsAt(out, '1_0_0', 1)).toEqual(['Test_Light']);
    expect(compsAt(out, '1_0_0', 0)).toEqual(['Test_Light']);
    expect(numOf(out, 'NumComponents', '1_0_0')).toBe(2);
  });

  it('a wire between a new brick and a loaded one: saved, reopened, counted', () => {
    const f = save(), o = open(f), { scene, m } = o;
    // a copy of the lamp next to the switch's chunk (new chunk 0_1_0), driven by the loaded switch
    const id = addRow(scene, [5, 2105, 6]);
    m.attachCarried(id, m.carriedOf(rowOf(m, '1_0_0', 0)));
    const sw = m.refOfRow(rowOf(m, '0_0_0', 0))!, lamp2 = m.refOfRow(id)!;
    m.addWire({ ...sw, component: 'Test_Switch', port: 'bOn' }, { ...lamp2, component: 'Test_Light', port: 'bEnabled' });
    // and a pasted switch (chunk 0_0_0) drives the loaded lamp, in place of the chip's wire (no fan-in)
    const id2 = addRow(scene, [85, 5, 6]);
    m.attachCarried(id2, m.carriedOf(rowOf(m, '0_0_0', 0)));
    const sw2 = m.refOfRow(id2)!;
    expect(sw2).toEqual({ grid: 1, chunk: { X: 0, Y: 0, Z: 0 }, brick: 3 });
    const lamp = m.refOfRow(rowOf(m, '1_0_0', 0))!;
    m.removeWire(m.wires.wiresInto({ ...lamp, component: 'Test_Light', port: 'bEnabled' })[0]!);
    m.addWire({ ...sw2, component: 'Test_Switch', port: 'bOn' }, { ...lamp, component: 'Test_Light', port: 'bEnabled' });
    const out = saveScene(f, o), a = indexAt(out, [5, 2105, 6]), b = indexAt(out, [85, 5, 6]);
    expect(a).toEqual({ chunk: '0_1_0', index: 0 });
    expect(b).toEqual({ chunk: '0_0_0', index: 3 });
    const wl = wireList(out);
    expect(wl).toContain('1/0_0_0/0.bOn->1/0_1_0/0.bEnabled');            // loaded -> new (stored in the new chunk)
    expect(wl).toContain('1/0_0_0/3.bOn->1/1_0_0/0.bEnabled');            // new -> loaded
    expect(wl).not.toContain('2/-1_-1_-1/2.RER_Output->1/1_0_0/0.bEnabled');
    expect(wl).toHaveLength(wireList(f).length + 1);
    expect(numOf(out, 'NumWires', '0_1_0')).toBe(1);
    expect(numOf(out, 'NumWires', '1_0_0')).toBe(numOf(f, 'NumWires', '1_0_0'));   // one out, one in
    expect(owners(out).WireCounts).toEqual([5, 1]);
    // reopened: the model reads them and the wires validate
    const re = open(out);
    expect(re.m.wires.size).toBe(wl.length);
    expect(re.m.wires.validate().filter((i) => i.severity === 'error' && i.code === 'missing-component')).toEqual([]);
  });

  it('an undone paste orphans its components: the save leaves them (and their wires) out, byte-identical to no edit', () => {
    const f = save(), o = open(f), { scene, m } = o;
    const id = addRow(scene, [65, 5, 6]);
    m.attachCarried(id, m.carriedOf(rowOf(m, '0_0_0', 0)));
    const nw = m.refOfRow(id)!, lamp = m.refOfRow(rowOf(m, '1_0_0', 0))!;
    m.removeWire(m.wires.wiresInto({ ...lamp, component: 'Test_Light', port: 'bEnabled' })[0]!);
    m.addWire({ ...nw, component: 'Test_Switch', port: 'bOn' }, { ...lamp, component: 'Test_Light', port: 'bEnabled' });
    undo(); undo();                                                       // the wire steps
    scene.remove(id);                                                     // the paste undone
    expect(m.orphan(nw)).toBe(true);
    const out = saveScene(f, o), ref = readBrz(writeBrz(writeModel(f, scenePlain(open(f).scene, false).concat(o.unsupported), null).files));
    for (const [p, b] of ref) expect(bytesEqual(out.get(p)!, b), p).toBe(true);
    expect([...out.keys()].sort()).toEqual([...ref.keys()].sort());
  });

  it('an unedited save is byte-identical (writeModel with the model)', () => {
    const f = save(), o = open(f);
    const out = writeModel(f, scenePlain(o.scene, false).concat(o.unsupported), o.m).files;
    for (const [p, b] of f) if (/\/(Components|Wires)\/|ChunkIndex|Owners/.test(p)) expect(bytesEqual(out.get(p)!, b), p).toBe(true);
  });
});
