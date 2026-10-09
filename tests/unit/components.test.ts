import { describe, expect, it } from 'vitest';
import { bytesEqual, readBrz } from '../../src/format/brz.ts';
import { ComponentEditError, loadComponents, type ComponentInstance, type FieldDescriptor } from '../../src/scene/components.ts';
import { CatalogueBuilder } from '../../src/scene/componentCatalogue.ts';
import { hasRefs, readRef, referenceSaves } from './refs.ts';
import { synthSave } from './synth-save.ts';

const lightOf = (files = synthSave()): { store: ReturnType<typeof loadComponents>; c: ComponentInstance } => {
  const store = loadComponents(files);
  return { store, c: store.onBrick({ grid: 1, chunk: { X: 0, Y: 0, Z: 0 }, brick: 1 })[0]! };
};
/** Path to the first plain number / bool / string field, looking into structs. */
function firstLeaf(d: FieldDescriptor[], at: string[] = []): [string[], FieldDescriptor] | null {
  for (const f of d) {
    if (f.kind === 'number' || f.kind === 'bool' || f.kind === 'string') return [[...at, f.name], f];
    if (f.fields) { const r = firstLeaf(f.fields, [...at, f.name]); if (r) return r; }
  }
  return null;
}
const kinds = (d: FieldDescriptor[]): Record<string, string> => Object.fromEntries(d.map((f) => [f.name, f.kind]));

describe('component model (synthetic save)', () => {
  it('reads every component with its brick, type and typed data', () => {
    const store = loadComponents(synthSave());
    expect(store.instances.length).toBe(7);
    expect(store.types().map((t) => t.type).sort()).toEqual(['Test_AndGate', 'Test_Chip', 'Test_Light', 'Test_MicrochipInput', 'Test_MicrochipOutput', 'Test_Switch']);
    const chip = store.onBrick({ grid: 1, chunk: { X: 0, Y: 0, Z: 0 }, brick: 2 })[0]!;
    expect(chip.type).toBe('Test_Chip');
    expect(chip.struct).toBe(null);
    const { c } = lightOf();
    expect(c.type).toBe('Test_Light');
    expect(c.data!.Color).toEqual({ B: 255, G: 128, R: 0, A: 255 });
    expect(c.data!.Steps).toEqual([1, 2, 200]);
  });

  it('describes fields by schema type', () => {
    const { store, c } = lightOf();
    const d = store.describe(c);
    expect(kinds(d)).toEqual({ Brightness: 'number', Radius: 'number', Color: 'colour', Rotation: 'rotator', Mode: 'enum', Label: 'string', Value: 'variant', Tags: 'map', Steps: 'array' });
    expect(d[0]!.number).toMatchObject({ integer: false, float32: true });
    expect(d.find((f) => f.name === 'Mode')!.options!.map((o) => o.value)).toEqual([0, 1, 5]);
    expect(d.find((f) => f.name === 'Color')!.colour).toEqual({ channels: ['B', 'G', 'R', 'A'], float: false });
    expect(d.find((f) => f.name === 'Value')!.alternatives!.map((a) => a.kind)).toEqual(['number', 'number', 'bool', 'vector']);
    expect(d.find((f) => f.name === 'Steps')!.element!.number).toMatchObject({ integer: true, min: 0, max: 255 });
    const sw = store.onBrick({ grid: 1, chunk: { X: 0, Y: 0, Z: 0 }, brick: 0 })[0]!;
    expect(store.describe(sw)[1]!.options).toEqual([{ label: '(none)', value: -1 }, { label: 'Sound/Click', value: 0 }]);
  });

  it('re-encodes byte-identically with no edits (copy and forced)', () => {
    const files = synthSave(), store = loadComponents(files);
    for (const out of [store.encode(), store.encode({ force: true })]) {
      for (const [p, b] of files) expect(bytesEqual(out.get(p)!, b), p).toBe(true);
    }
    expect(store.dirty).toBe(false);
  });

  it('validates edits against the schema', () => {
    const { store, c } = lightOf();
    const bad: [(string | number)[], unknown][] = [
      [['Mode'], 2], [['Color', 'R'], 256], [['Color', 'R'], 1.5], [['Steps', 0], -1], [['Label'], 3], [['Brightness'], NaN],
      [['Brightness'], 'x'], [['Value'], { variant: 9, value: 0 }], [['Value'], { variant: 2, value: 1 }], [['Nope'], 1], [['Tags'], { a: 1 }],
      [['Rotation'], { Pitch: 0, Yaw: 0 }],
    ];
    for (const [path, v] of bad) expect(() => store.setField(c, path, v), path.join('.')).toThrow(ComponentEditError);
    expect(store.dirty).toBe(false);
  });

  it('edits then re-reads: scalars, structs, variants, maps, arrays', () => {
    const { store, c } = lightOf();
    store.setField(c, ['Brightness'], 12.3);
    store.setField(c, ['Radius'], 0.1);
    store.setField(c, ['Color'], { B: 1, G: 2, R: 3, A: 4 });
    store.setField(c, ['Rotation', 'Yaw'], -45.5);
    store.setField(c, ['Mode'], 5);
    store.setField(c, ['Label'], 'héllo');
    store.setField(c, ['Steps', 2], 255);
    store.setVariant(c, ['Value'], 3);
    store.setField(c, ['Value', 'value', 'Z'], 2.5);
    store.setMapEntry(c, ['Tags'], 'b', -7);
    store.deleteMapEntry(c, ['Tags'], 'a');
    expect(store.dirty).toBe(true);
    const files = store.encode(), again = lightOf(files).c;
    expect(again.data).toEqual({
      Brightness: Math.fround(12.3), Radius: 0.1, Color: { B: 1, G: 2, R: 3, A: 4 }, Rotation: { Pitch: 0, Yaw: -45.5, Roll: 0 }, Mode: 5, Label: 'héllo',
      Value: { variant: 3, type: 'Vector', value: { X: 0, Y: 0, Z: 2.5 } }, Tags: new Map([['b', -7]]), Steps: [1, 2, 255],
    });
    // the other chunks are untouched
    const orig = synthSave();
    for (const p of ['World/0/Bricks/Grids/1/Components/1_0_0.mps', 'World/0/Bricks/Grids/2/Components/-1_-1_-1.mps']) expect(bytesEqual(files.get(p)!, orig.get(p)!)).toBe(true);
  });

  it('refuses edits on data-less components', () => {
    const store = loadComponents(synthSave());
    const chip = store.onBrick({ grid: 1, chunk: { X: 0, Y: 0, Z: 0 }, brick: 2 })[0]!;
    expect(() => store.setField(chip, ['X'], 1)).toThrow(ComponentEditError);
    expect(store.describe(chip)).toEqual([]);
  });

  it('builds a catalogue of fields, values and ports from saves', () => {
    const b = new CatalogueBuilder();
    b.add(synthSave());
    b.add(synthSave());
    const cat = b.result();
    expect(cat.saves).toBe(2);
    const light = cat.types.Test_Light!;
    expect(light.instances).toBe(4);
    expect(light.fields.find((f) => f.name === 'Brightness')).toMatchObject({ types: { f32: 4 }, kind: 'number', values: [{ value: '20', count: 4 }] });
    expect(light.inputs).toEqual({ bEnabled: 2 + 2 });
    expect(cat.types.Test_MicrochipInput!.inputs).toEqual({ RER_Input: 2 });
    expect(cat.types.Test_MicrochipInput!.outputs).toEqual({ RER_Output: 2 });
  });
});

const compSaves = referenceSaves().filter((rel) => [...readBrz(readRef(rel)).keys()].some((p) => /\/Components\//.test(p)));

describe.skipIf(!hasRefs || !compSaves.length)('component model (reference saves)', () => {
  describe.each(compSaves)('%s', (rel) => {
    it('re-encodes every component chunk byte-identically', () => {
      const files = readBrz(readRef(rel)), store = loadComponents(files);
      expect(store.instances.length).toBeGreaterThan(0);
      const out = store.encode({ force: true });
      for (const ch of store.chunks) expect(bytesEqual(out.get(ch.path)!, files.get(ch.path)!), ch.path).toBe(true);
      for (const c of store.instances) expect(c.brickRef.brick, c.id).toBeGreaterThanOrEqual(0);
    });

    it('edit -> encode -> re-read changes only the edited field', () => {
      const files = readBrz(readRef(rel)), store = loadComponents(files);
      const edits: [string, string, unknown][] = [];
      for (const c of store.instances) {
        const leaf = firstLeaf(store.describe(c));
        if (!leaf) continue;
        const [path, f] = leaf, old = store.getField(c, path);
        const v = f.kind === 'bool' ? !old : f.kind === 'string' ? `${String(old)}!` : f.number!.integer ? (old === f.number!.max ? (old as number) - 1 : (old as number) + 1) : (old as number) + 0.5;
        store.setField(c, path, v);
        edits.push([c.id, path[0]!, c.data![path[0]!]]);
      }
      expect(edits.length).toBeGreaterThan(0);
      const before = loadComponents(files), after = loadComponents(store.encode());
      for (const c of after.instances) {
        const was = before.get(c.id)!, e = edits.find(([id]) => id === c.id);
        expect(c.type).toBe(was.type);
        if (!e) { expect(c.data).toEqual(was.data); continue; }
        expect(c.data![e[1]]).toEqual(e[2]);
        expect({ ...c.data, [e[1]]: null }).toEqual({ ...was.data, [e[1]]: null });
      }
    });
  });
});
