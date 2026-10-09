import { describe, expect, it } from 'vitest';
import {
  applyChange, applyPaint, DEFAULT_COLOUR, DEFAULT_INTENSITY, DEFAULT_MATERIAL, materialLabel, normalisePaint, PAINT_KEY,
  PaintModel, pickFrom, planPaint, selectByColour, srgbFloatTarget, type PaintFields, type PaintTarget,
} from '../../src/editor/paint.ts';

function mapTarget(init: Record<string, PaintFields>): PaintTarget<string> & { m: Map<string, PaintFields>; writes: number } {
  const m = new Map(Object.entries(init));
  const t = { m, writes: 0, get: (id: string) => m.get(id), set: (id: string, f: PaintFields) => { t.writes++; m.set(id, f); } };
  return t;
}
const red: PaintFields = { colour: [250, 64, 64], material: 'BMC_Plastic', intensity: 5 };
const blue: PaintFields = { colour: [10, 20, 200], material: 'BMC_Glow', intensity: 10 };

function memStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data, length: 0, clear: () => data.clear(), key: () => null,
    getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); },
  };
}

describe('normalisePaint', () => {
  it('fills defaults, clamps bytes and intensity', () => {
    expect(normalisePaint(undefined)).toEqual({ colour: DEFAULT_COLOUR, material: DEFAULT_MATERIAL, intensity: DEFAULT_INTENSITY });
    expect(normalisePaint({ colour: [300, -4, 12.6], material: '', intensity: 99 })).toEqual({ colour: [255, 0, 13], material: 'BMC_Plastic', intensity: 10 });
  });
  it('labels materials', () => {
    expect(materialLabel('BMC_TranslucentPlastic')).toBe('Translucent Plastic');
    expect(materialLabel(undefined)).toBe('Plastic');
  });
});

describe('applyPaint', () => {
  it('paints, skipping missing, duplicate and already-matching bricks, and undoes / redoes', () => {
    const t = mapTarget({ a: red, b: blue, c: { ...blue } });
    const ch = applyPaint(t, ['a', 'b', 'b', 'zz', 'c'], blue);
    expect(ch.ids).toEqual(['a']);
    expect(ch.before).toEqual([red]);
    expect(ch.after).toEqual([blue]);
    expect(t.m.get('a')).toEqual(blue);
    applyChange(t, ch, 'before');
    expect(t.m.get('a')).toEqual(red);
    applyChange(t, ch, 'after');
    expect(t.m.get('a')).toEqual(blue);
  });
  it('honours the mask', () => {
    const t = mapTarget({ a: red });
    applyPaint(t, ['a'], blue, { material: false, intensity: false });
    expect(t.m.get('a')).toEqual({ colour: blue.colour, material: 'BMC_Plastic', intensity: 5 });
  });
  it('planPaint does not write; an empty change writes nothing', () => {
    const t = mapTarget({ a: red });
    expect(planPaint(t, ['a'], blue).ids).toEqual(['a']);
    expect(t.writes).toBe(0);
    expect(applyPaint(t, ['a'], red).ids).toEqual([]);
    expect(t.writes).toBe(0);
  });
  it('change sets are snapshots, not live references', () => {
    const t = mapTarget({ a: red });
    const ch = applyPaint(t, ['a'], blue);
    t.m.get('a')!.colour[0] = 1;
    expect(ch.after[0]!.colour[0]).toBe(10);
  });
});

describe('eyedropper and select-by-colour', () => {
  it("pickFrom copies a brick's paint", () => {
    const p = pickFrom(blue);
    expect(p).toEqual(blue);
    expect(p.colour).not.toBe(blue.colour);
  });
  it('selects by exact colour, tolerance, material and intensity', () => {
    const e: [number, PaintFields][] = [[0, red], [1, blue], [2, { ...red, colour: [252, 62, 64] }], [3, { ...red, material: 'BMC_Metallic' }]];
    expect(selectByColour(e, [250, 64, 64])).toEqual([0, 3]);
    expect(selectByColour(e, [250, 64, 64], { tolerance: 2 })).toEqual([0, 2, 3]);
    expect(selectByColour(e, [250, 64, 64], { material: 'BMC_Plastic' })).toEqual([0]);
    expect(selectByColour(e, [10, 20, 200], { intensity: 5 })).toEqual([]);
  });
});

describe('PaintModel', () => {
  it('remembers the current paint in storage', () => {
    const s = memStorage();
    const m = new PaintModel(s);
    expect(m.paint).toEqual(normalisePaint(undefined));
    m.set({ colour: [1, 2, 3], material: 'BMC_Glass', intensity: 7 });
    expect(JSON.parse(s.data.get(PAINT_KEY)!)).toEqual({ colour: [1, 2, 3], material: 'BMC_Glass', intensity: 7 });
    expect(new PaintModel(s).paint).toEqual({ colour: [1, 2, 3], material: 'BMC_Glass', intensity: 7 });
  });
  it('survives broken or throwing storage', () => {
    const s = memStorage();
    s.data.set(PAINT_KEY, '{nope');
    expect(new PaintModel(s).paint).toEqual(normalisePaint(undefined));
    const bad = { getItem: (): string => { throw new Error('blocked'); }, setItem: (): void => { throw new Error('blocked'); } };
    const m = new PaintModel(bad);
    m.setIntensity(3);
    expect(m.intensity).toBe(3);
    expect(new PaintModel(null).material).toBe('BMC_Plastic');
  });
  it('notifies subscribers once per real change', () => {
    const m = new PaintModel(null), seen: number[] = [];
    const off = m.subscribe((p) => seen.push(p.intensity));
    m.setIntensity(2); m.setIntensity(2); m.setIntensity(12);
    off(); m.setIntensity(4);
    expect(seen).toEqual([2, 10]);
  });
  it('pickFrom adopts a brick (masked) and applyPaint uses the current paint', () => {
    const m = new PaintModel(null);
    m.pickFrom(blue, { material: false });
    expect(m.paint).toEqual({ ...blue, material: 'BMC_Plastic' });
    const t = mapTarget({ a: red });
    expect(m.applyPaint(t, ['a']).after).toEqual([{ ...blue, material: 'BMC_Plastic' }]);
  });
});

describe('srgbFloatTarget (Phase 1 brick list)', () => {
  it('reads floats as bytes, writes bytes back as floats, and reports the change', () => {
    const list: { color: number[]; material?: string; intensity?: number }[] = [
      { color: [250 / 255, 64 / 255, 64 / 255], material: 'BMC_Plastic' }, { color: [0, 0, 1] },
    ];
    const changed: number[] = [];
    const t = srgbFloatTarget(list, (i) => changed.push(i));
    expect(t.get(0)).toEqual(red);
    expect(t.get(1)).toEqual({ colour: [0, 0, 255], material: 'BMC_Plastic', intensity: 5 });
    expect(t.get(5)).toBeUndefined();
    const ch = applyPaint(t, [0, 1], blue);
    expect(ch.ids).toEqual([0, 1]);
    expect(changed).toEqual([0, 1]);
    expect(list[1]).toEqual({ color: [10 / 255, 20 / 255, 200 / 255], material: 'BMC_Glow', intensity: 10 });
    expect(selectByColour(t.entries(), blue.colour)).toEqual([0, 1]);
    applyChange(t, ch, 'before');
    expect(t.get(0)).toEqual(red);
  });
});
