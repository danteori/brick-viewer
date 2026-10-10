// The scene side of components and wires (C-02 / C-03 UI): the model built at load, rows <-> save
// bricks, edits as undo steps, and saving the edits through the brick writer (re-indexed with the
// bricks). The no-edit round trip stays byte-identical.
import { describe, expect, it } from 'vitest';
import { bytesEqual, type FileMap } from '../../src/format/brz.ts';
import { decodeMps } from '../../src/format/schema.ts';
import { storeFromFiles } from '../../src/scene/load.ts';
import { attachComponents, componentsOf, type SceneComponents } from '../../src/scene/compmodel.ts';
import { scenePlain, writeModel, writeScene } from '../../src/scene/save.ts';
import { putPlain, plainOf } from '../../src/scene/view.ts';
import { loadComponents, saveContext } from '../../src/scene/components.ts';
import { loadWires } from '../../src/scene/wires.ts';
import { hist } from '../../src/scene/history.ts';
import type { SceneStore } from '../../src/scene/store.ts';
import { save } from './comp-fixture.ts';
import { hasRefs, readRef, referenceSaves } from './refs.ts';
import { readBrz } from '../../src/format/brz.ts';
import { extractBricks } from '../../src/format/world.ts';

const W = 'World/0/';

function open(files: FileMap): { scene: SceneStore; m: SceneComponents; unsupported: ReturnType<typeof storeFromFiles>['unsupported'] } {
  const { store, order, unsupported } = storeFromFiles(files);
  expect(attachComponents(store, files, order)).toBeNull();
  return { scene: store, m: componentsOf(store)!, unsupported };
}

/** What Save .brz writes for a scene: edited components / wires into the template, then the bricks. */
function saveScene(files: FileMap, scene: SceneStore, m: SceneComponents, unsupported: ReturnType<typeof storeFromFiles>['unsupported']): FileMap {
  return writeScene(m.applyTo(files), scenePlain(scene, false).concat(unsupported)).files;
}

const rowOf = (m: SceneComponents, chunk: string, brick: number): number => {
  const [X, Y, Z] = chunk.split('_').map(Number);
  return m.rowOfRef({ grid: 1, chunk: { X: X!, Y: Y!, Z: Z! }, brick });
};
const undo = (): void => { const t = hist.undo.pop()!; expect(t.kind).toBe('data'); if (t.kind === 'data') t.undo(); hist.redo.push(t); };
const redo = (): void => { const t = hist.redo.pop()!; if (t.kind === 'data') t.redo(); hist.undo.push(t); };
const wireList = (f: FileMap): string[] => loadWires(f).wires().map((w) => `${w.source.grid}/${w.source.brick}.${w.source.port}->${w.target.grid}/${w.target.brick}.${w.target.port}`).sort();
const ci = (f: FileMap, grid = 1): Record<string, number[]> => decodeMps<Record<string, number[]>>(f.get(`${W}Bricks/Grids/${grid}/ChunkIndex.mps`)!, saveContext(f).schemaFor(`${W}Bricks/Grids/${grid}/ChunkIndex.mps`));
const owners = (f: FileMap): Record<string, number[]> => decodeMps<Record<string, number[]>>(f.get(`${W}Owners.mps`)!, saveContext(f).schemaFor(`${W}Owners.mps`));

describe('scene components model', () => {
  it('maps scene rows to save bricks and back (unsupported bricks have no row)', () => {
    const { scene, m } = open(save());
    expect(scene.count).toBe(3);
    const sw = rowOf(m, '0_0_0', 0), chip = rowOf(m, '0_0_0', 2), lamp = rowOf(m, '1_0_0', 0);
    expect([sw, chip, lamp].every((r) => r >= 0)).toBe(true);
    expect(rowOf(m, '0_0_0', 1)).toBe(-1);              // the skipped light
    expect(m.componentsOf(sw).map((c) => c.type)).toEqual(['Test_Switch']);
    expect(m.componentsOf(lamp).map((c) => c.type)).toEqual(['Test_Light']);
    expect(m.refOfRow(lamp)).toEqual({ grid: 1, chunk: { X: 1, Y: 0, Z: 0 }, brick: 0 });
    expect([...m.componentSeqs()].sort()).toEqual([0, 1, 2, 3]);
  });

  it('with no edits, saving uses the template as is and the component / wire files are byte-identical', () => {
    const f = save(), { scene, m, unsupported } = open(f);
    expect(m.applyTo(f)).toBe(f);
    const out = saveScene(f, scene, m, unsupported);
    for (const [p, b] of f) if (/\/(Components|Wires)\//.test(p)) expect(bytesEqual(out.get(p)!, b), p).toBe(true);
  });

  it('a field edit is one undo step and survives save and reload', () => {
    const f = save(), { scene, m, unsupported } = open(f), lamp = m.componentsOf(rowOf(m, '1_0_0', 0))[0]!;
    const n = hist.undo.length;
    m.edit(lamp, ['Brightness'], 42.5);
    m.edit(lamp, ['Color', 'R'], 200);
    m.edit(lamp, ['Value'], 1, 'variant');             // i64 -> i64 (same alternative: value reset)
    m.edit(lamp, ['Value'], 3, 'variant');             // -> Vector
    m.edit(lamp, ['Value', 'value', 'Y'], 2);
    m.edit(lamp, ['Tags'], ['b', 5], 'mapSet');
    expect(hist.undo.length - n).toBe(6);
    expect(() => m.edit(lamp, ['Color', 'R'], 300)).toThrow(/u8/);
    expect(() => m.edit(lamp, ['Mode'], 3)).toThrow(/not a value/);
    expect(hist.undo.length - n).toBe(6);              // refused edits leave no step
    const out = saveScene(f, scene, m, unsupported), back = loadComponents(out).instances.find((c) => c.type === 'Test_Light' && c.brickRef.chunk.X === 1)!;
    expect(back.data!.Brightness).toBe(42.5);
    expect((back.data!.Color as Record<string, number>).R).toBe(200);
    expect(back.data!.Value).toMatchObject({ variant: 3, value: { X: 0, Y: 2, Z: 0 } });
    expect([...(back.data!.Tags as Map<string, number>)]).toEqual([['a', 1], ['b', 5]]);
    // undo all six, then the save is byte-identical in content again
    for (let i = 0; i < 6; i++) undo();
    expect(lamp.data!.Brightness).toBe(20);
    expect(lamp.data!.Value).toMatchObject({ variant: 1, value: 7 });
    expect([...(lamp.data!.Tags as Map<string, number>)]).toEqual([['a', 1]]);
    const again = saveScene(f, scene, m, unsupported);
    expect(bytesEqual(again.get(`${W}Bricks/Grids/1/Components/1_0_0.mps`)!, f.get(`${W}Bricks/Grids/1/Components/1_0_0.mps`)!)).toBe(true);
    redo();
    expect(lamp.data!.Brightness).toBe(42.5);
  });

  it('adds and removes a component (with defaults, counts kept up to date, undoable)', () => {
    const f = save(), { scene, m, unsupported } = open(f), lampRow = rowOf(m, '1_0_0', 0);
    const ref = m.refOfRow(lampRow)!;
    expect(m.store.addable(ref)).not.toContain('Test_Light');     // one of each type per brick
    const sw = m.addComponent(lampRow, 'Test_Switch');
    expect(sw.data).toEqual({ bEnabled: true, Sound: 0 });        // the save's own switch's values
    expect(() => m.addComponent(lampRow, 'Test_Switch')).toThrow(/already/);
    let out = saveScene(f, scene, m, unsupported);
    const comps = loadComponents(out).instances.filter((c) => c.brickRef.grid === 1 && c.brickRef.chunk.X === 1);
    expect(comps.map((c) => c.type).sort()).toEqual(['Test_Light', 'Test_Switch']);
    expect(ci(out).NumComponents).toEqual([3, 2]);
    expect(owners(out).ComponentCounts).toEqual([7, 1]);
    // remove the light: it takes its wire (chip output -> light.bEnabled) with it
    expect(m.wires.size).toBe(5);
    m.removeComponent(m.componentsOf(lampRow).find((c) => c.type === 'Test_Light')!);
    expect(m.wires.size).toBe(4);
    out = saveScene(f, scene, m, unsupported);
    expect(loadComponents(out).instances.filter((c) => c.brickRef.chunk.X === 1 && c.brickRef.grid === 1).map((c) => c.type)).toEqual(['Test_Switch']);
    expect(wireList(out).some((w) => w.endsWith('->1/0.bEnabled'))).toBe(false);
    undo();                                                        // light and wire back
    expect(m.componentsOf(lampRow).map((c) => c.type).sort()).toEqual(['Test_Light', 'Test_Switch']);
    expect(m.wires.size).toBe(5);
    undo();                                                        // switch gone again
    expect(m.componentsOf(lampRow).map((c) => c.type)).toEqual(['Test_Light']);
    out = saveScene(f, scene, m, unsupported);
    expect(ci(out).NumComponents).toEqual([3, 1]);
    expect(owners(out).ComponentCounts).toEqual([6, 1]);
    expect(wireList(out)).toEqual(wireList(f));
  });

  it('adding a wire is validated (fan-in refused), one undo step, and saved', () => {
    const f = save(), { scene, m, unsupported } = open(f);
    const swRef = m.refOfRow(rowOf(m, '0_0_0', 0))!, lampRef = m.refOfRow(rowOf(m, '1_0_0', 0))!;
    const s = { ...swRef, component: 'Test_Switch', port: 'bOn' }, t = { ...lampRef, component: 'Test_Light', port: 'bEnabled' };
    expect(m.checkWire(s, t).map((i) => i.code)).toContain('fan-in');
    expect(() => m.addWire(s, t)).toThrow(/fan-in/);
    const old = m.wires.wiresInto(t)[0]!;
    m.removeWire(old);
    const w = m.addWire(s, t);
    expect(w.target.port).toBe('bEnabled');
    let out = saveScene(f, scene, m, unsupported);
    expect(wireList(out)).toContain('1/0.bOn->1/0.bEnabled');
    expect(wireList(out)).not.toContain('2/2.RER_Output->1/0.bEnabled');
    expect(ci(out).NumWires).toEqual([1, 1]);
    undo(); undo();
    out = saveScene(f, scene, m, unsupported);
    expect(wireList(out)).toEqual(wireList(f));
  });

  it('a moved or recoloured component brick keeps its edited components after the save re-indexes', () => {
    const f = save(), { scene, m, unsupported } = open(f), sw = rowOf(m, '0_0_0', 0);
    m.edit(m.componentsOf(sw)[0]!, ['bEnabled'], false);
    scene.px[sw] = scene.px[sw]! + 300; scene.touch(sw);          // still in chunk 0_0_0, now after the others in it
    const out = saveScene(f, scene, m, unsupported);
    const back = loadComponents(out).instances.find((c) => c.type === 'Test_Switch')!;
    expect(back.data!.bEnabled).toBe(false);
    expect(back.brickRef.brick).toBe(0);                            // still the first brick of its chunk (load order is kept)
    const re = open(out);
    expect(re.m.componentsOf(rowOf(re.m, '0_0_0', 0)).map((c) => c.type)).toEqual(['Test_Switch']);
  });
});

describe.skipIf(!hasRefs)('reference component saves', () => {
  const withComps = referenceSaves().filter((rel) => {
    try { return [...readBrz(readRef(rel)).keys()].some((p) => /\/Components\//.test(p)); } catch { return false; }
  }).slice(0, 40);
  it.each(withComps.slice(0, 12))('%s: a pasted copy of a component brick saves with its components (C-04)', (rel) => {
    const f = readBrz(readRef(rel)), { store, order, unsupported } = storeFromFiles(f);
    if (attachComponents(store, f, order)) return;
    const m = componentsOf(store)!, src = m.store.instances.find((c) => c.brickRef.grid === 1 && m.rowOfRef(c.brickRef) >= 0);
    if (!src) return;
    const row = m.rowOfRef(src.brickRef), { seq: _s, linear, ...pb } = plainOf(store, row), id = store.alloc();
    putPlain(store, id, { ...pb, pos: [pb.pos[0] + 40, pb.pos[1], pb.pos[2]] }, linear);
    const types = m.carriedOf(row).map((c) => c.type).sort();
    expect(m.attachCarried(id, m.carriedOf(row))).toEqual([]);
    const lin = extractBricks(f).linear[0] ?? false, saved = writeModel(f, scenePlain(store, lin).concat(unsupported), m);
    expect(saved.warnings.filter((w) => /components \/ wires/.test(w))).toEqual([]);
    const { store: s2, order: o2 } = storeFromFiles(saved.files);
    expect(attachComponents(s2, saved.files, o2)).toBeNull();
    const m2 = componentsOf(s2)!, n = (mm: typeof m): number => mm.store.instances.filter((c) => c.brickRef.grid === 1).length;
    expect(n(m2)).toBe(n(m) );
    const twin = [...s2.ids()].find((r) => s2.px[r] === pb.pos[0] + 40 && s2.py[r] === pb.pos[1] && s2.pz[r] === pb.pos[2] && m2.componentsOf(r).length);
    expect(twin, 'the copy is in the reopened save with components').toBeDefined();
    expect(m2.componentsOf(twin!).map((c) => c.type).sort()).toEqual(types);
  });

  it.each(withComps)('%s: unedited save keeps component / wire files byte-identical and the model reads them', (rel) => {
    const f = readBrz(readRef(rel)), { store, order, unsupported } = storeFromFiles(f);
    const err = attachComponents(store, f, order);
    // the save as Save .brz writes it with no edits: component and wire files untouched
    const lin = extractBricks(f).linear[0] ?? false, m0 = componentsOf(store);
    const out = writeScene(m0 ? m0.applyTo(f) : f, scenePlain(store, lin).concat(unsupported)).files;
    for (const [p, b] of f) if (/\/(Components|Wires)\//.test(p)) expect(bytesEqual(out.get(p)!, b), p).toBe(true);
    if (err) { console.log(rel, 'model unreadable:', err); return; }
    const m = m0!;
    expect(m.applyTo(f)).toBe(f);
    // every component on a brick the scene shows maps to its row and back
    for (const c of m.store.instances.slice(0, 200)) {
      if (c.brickRef.grid !== 1) continue;
      const row = m.rowOfRef(c.brickRef);
      if (row >= 0) expect(m.refOfRow(row)).toEqual(c.brickRef);
    }
    // NumComponents in ChunkIndex is the chunk's instance count (what saving writes after an add / remove)
    for (const ch of m.store.chunks) {
      if (ch.grid !== 1) continue;
      const idx = ci(f), j = idx.Chunk3DIndices!.findIndex((k) => { const kk = k as unknown as { X: number; Y: number; Z: number }; return kk.X === ch.chunk.X && kk.Y === ch.chunk.Y && kk.Z === ch.chunk.Z; });
      if (j >= 0 && idx.NumComponents) expect(idx.NumComponents[j]).toBe(ch.file.data.length);
    }
  });
});
