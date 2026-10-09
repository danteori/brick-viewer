import { describe, expect, it } from 'vitest';
import { bytesEqual, readBrz } from '../../src/format/brz.ts';
import { decodeMps, parseSchema } from '../../src/format/schema.ts';
import { brickKey, type BrickRef } from '../../src/scene/components.ts';
import { loadWires, WireError, type WireEnd } from '../../src/scene/wires.ts';
import { hasRefs, readRef, referenceSaves } from './refs.ts';
import { synthSave } from './synth-save.ts';

const c0 = { X: 0, Y: 0, Z: 0 }, c1 = { X: 1, Y: 0, Z: 0 }, cc = { X: -1, Y: -1, Z: -1 };
const SWITCH: BrickRef = { grid: 1, chunk: c0, brick: 0 }, LIGHT: BrickRef = { grid: 1, chunk: c0, brick: 1 }, LIGHT2: BrickRef = { grid: 1, chunk: c1, brick: 0 };
const CHIP_IN: BrickRef = { grid: 2, chunk: cc, brick: 0 }, GATE: BrickRef = { grid: 2, chunk: cc, brick: 1 }, CHIP_OUT: BrickRef = { grid: 2, chunk: cc, brick: 2 };
const e = (b: BrickRef, component: string, port: string): WireEnd => ({ ...b, component, port });
const keys = (l: { brick: BrickRef; depth: number }[]): [string, number][] => l.map((x) => [brickKey(x.brick), x.depth]);
const W = 'World/0/';
const mps = (files: Map<string, Uint8Array>, path: string, schema: string): Record<string, unknown> => decodeMps(files.get(path)!, parseSchema(files.get(schema)!));

describe('wire graph (synthetic save)', () => {
  it('reads local and remote wires with names and grids', () => {
    const g = loadWires(synthSave());
    expect(g.size).toBe(5);
    expect(g.chips.get(2)).toEqual({ grid: 2, parent: 1, chipBrick: { grid: 1, chunk: c0, brick: 2 } });
    const into = g.wiresOf(LIGHT2).incoming;
    expect(into.length).toBe(1);
    expect(into[0]!.source).toEqual(e(CHIP_OUT, 'Test_MicrochipOutput', 'RER_Output'));
    expect(into[0]!.target).toEqual(e(LIGHT2, 'Test_Light', 'bEnabled'));
    expect(g.wiresOf(SWITCH).outgoing.map((w) => brickKey(w.target)).sort()).toEqual([brickKey(LIGHT), brickKey(CHIP_IN)].sort());
    expect(g.ports('Test_AndGate')).toEqual({ inputs: ['InputA'], outputs: ['Output'] });
  });

  it('answers upstream / downstream queries', () => {
    const g = loadWires(synthSave());
    expect(keys(g.upstream(LIGHT2))).toEqual([[brickKey(CHIP_OUT), 1], [brickKey(GATE), 2], [brickKey(CHIP_IN), 3], [brickKey(SWITCH), 4]]);
    expect(keys(g.upstream(LIGHT2, 2))).toEqual([[brickKey(CHIP_OUT), 1], [brickKey(GATE), 2]]);
    expect(keys(g.downstream(SWITCH)).map(([, d]) => d)).toEqual([1, 1, 2, 3, 4]);
    expect(g.upstream(SWITCH)).toEqual([]);
  });

  it('a save with no edits encodes byte-identically (copy and forced rebuild)', () => {
    const files = synthSave(), g = loadWires(files);
    expect(g.validate()).toEqual([]);
    for (const out of [g.encode(), g.encode({ force: true })]) {
      expect([...out.keys()]).toEqual([...files.keys()]);
      for (const [p, b] of files) expect(bytesEqual(out.get(p)!, b), p).toBe(true);
    }
  });

  it('rejects fan-in', () => {
    const g = loadWires(synthSave());
    const t = () => g.addWire(e(GATE, 'Test_AndGate', 'Output'), e(LIGHT2, 'Test_Light', 'bEnabled'));
    expect(t).toThrow(WireError);
    try { t(); } catch (err) { expect((err as WireError).issues.map((i) => i.code)).toContain('fan-in'); }
    expect(g.size).toBe(5);
  });

  it('rejects ends without that component', () => {
    const g = loadWires(synthSave());
    expect(g.check(e(SWITCH, 'Test_Light', 'bOn'), e(LIGHT, 'Test_Light', 'Mode')).map((i) => i.code)).toContain('missing-component');
    expect(g.check(e({ grid: 1, chunk: c0, brick: 9 }, 'Test_Switch', 'bOn'), e(LIGHT, 'Test_Light', 'Mode')).map((i) => i.code)).toContain('missing-component');
  });

  it('only crosses a chip boundary through the chip I/O bricks', () => {
    const g = loadWires(synthSave());
    // straight into a gate inside the chip
    const chipOnly = (l: { code: string }[]) => l.filter((i) => i.code === 'chip-boundary');
    expect(chipOnly(g.check(e(SWITCH, 'Test_Switch', 'bOn'), e(GATE, 'Test_AndGate', 'InputB')))).toMatchObject([{ code: 'chip-boundary', severity: 'error' }]);
    // straight out of a gate inside the chip
    expect(g.check(e(GATE, 'Test_AndGate', 'Output'), e(LIGHT, 'Test_Light', 'Radius')).map((i) => i.code)).toContain('chip-boundary');
    // into the input brick, but on its inner port
    expect(g.check(e(SWITCH, 'Test_Switch', 'bOn'), e(CHIP_IN, 'Test_MicrochipInput', 'RER_Output')).map((i) => i.code)).toContain('chip-boundary');
    // out through the output brick: fine
    expect(g.check(e(CHIP_OUT, 'Test_MicrochipOutput', 'RER_Output'), e(LIGHT, 'Test_Light', 'Radius')).filter((i) => i.severity === 'error')).toEqual([]);
    // relaxed mode: a warning, and the wire can be added
    const relaxed = loadWires(synthSave(), { chipBoundary: 'warn' });
    expect(chipOnly(relaxed.check(e(SWITCH, 'Test_Switch', 'bOn'), e(GATE, 'Test_AndGate', 'InputB')))).toMatchObject([{ code: 'chip-boundary', severity: 'warning' }]);
    relaxed.addWire(e(SWITCH, 'Test_Switch', 'bOn'), e(GATE, 'Test_AndGate', 'InputB'));
    expect(relaxed.validate().map((i) => i.severity)).toEqual(['warning']);
  });

  it('warns about ports the save has never used on that type', () => {
    const g = loadWires(synthSave());
    expect(g.check(e(SWITCH, 'Test_Switch', 'bOn'), e(LIGHT, 'Test_Light', 'Brightness'))).toMatchObject([{ code: 'unknown-port', severity: 'warning' }]);
    expect(g.check(e(LIGHT, 'Test_Light', 'bEnabled'), e(LIGHT2, 'Test_Light', 'Radius')).map((i) => i.code)).toContain('port-direction');
    const withCat = loadWires(synthSave(), { ports: (t) => (t === 'Test_Light' ? { inputs: ['Brightness'], outputs: [] } : undefined) });
    expect(withCat.check(e(SWITCH, 'Test_Switch', 'bOn'), e(LIGHT, 'Test_Light', 'Brightness'))).toEqual([]);
  });

  it('adds a wire into the target chunk and keeps the bookkeeping right', () => {
    const g = loadWires(synthSave());
    const w = g.addWire(e(SWITCH, 'Test_Switch', 'bOn'), e(LIGHT2, 'Test_Light', 'Brightness'));
    expect(g.wiresInto(w.target)).toEqual([w]);
    const out = g.encode();
    // stored as a remote wire in the target's chunk (1_0_0), with the source's grid and chunk
    const ch = mps(out, `${W}Bricks/Grids/1/Wires/1_0_0.mps`, `${W}Bricks/WiresShared.schema`);
    expect(ch.RemoteWireSources).toEqual([
      { GridPersistentIndex: 2, ChunkIndex: cc, BrickIndexInChunk: 2, ComponentTypeIndex: 5, PortIndex: 3 },
      { GridPersistentIndex: 1, ChunkIndex: c0, BrickIndexInChunk: 0, ComponentTypeIndex: 0, PortIndex: 0 },
    ]);
    expect((ch.RemoteWireTargets as unknown[])[1]).toEqual({ BrickIndexInChunk: 0, ComponentTypeIndex: 1, PortIndex: 7 });
    // the new port name was appended to GlobalData, NumWires and the target owner's WireCounts went up
    expect((mps(out, `${W}GlobalData.mps`, `${W}GlobalData.schema`).ComponentWirePortNames as string[])[7]).toBe('Brightness');
    expect(mps(out, `${W}Bricks/Grids/1/ChunkIndex.mps`, `${W}Bricks/ChunkIndexShared.schema`).NumWires).toEqual([1, 2]);
    expect(mps(out, `${W}Owners.mps`, `${W}Owners.schema`).WireCounts).toEqual([5, 1]);
    // and it reads back
    const back = loadWires(out);
    expect(back.size).toBe(6);
    expect(back.wiresInto(e(LIGHT2, 'Test_Light', 'Brightness'))[0]!.source).toEqual(e(SWITCH, 'Test_Switch', 'bOn'));
    expect(back.validate()).toEqual([]);
  });

  it('adds a local wire when source and target share a chunk', () => {
    const g = loadWires(synthSave());
    g.addWire(e(SWITCH, 'Test_Switch', 'bOn'), e(LIGHT, 'Test_Light', 'Radius'));
    const ch = mps(g.encode(), `${W}Bricks/Grids/1/Wires/0_0_0.mps`, `${W}Bricks/WiresShared.schema`);
    expect((ch.LocalWireSources as unknown[]).length).toBe(2);
    expect(ch.RemoteWireSources).toEqual([]);
  });

  it('removes wires, drops empty wire chunks and updates the counts', () => {
    const files = synthSave(), g = loadWires(files);
    const [w] = g.wiresOf(LIGHT).incoming;
    expect(g.removeWire(w!.id)).toBe(true);
    expect(g.removeWire(w!.id)).toBe(false);
    const out = g.encode();
    expect(out.has(`${W}Bricks/Grids/1/Wires/0_0_0.mps`)).toBe(false);
    expect(mps(out, `${W}Bricks/Grids/1/ChunkIndex.mps`, `${W}Bricks/ChunkIndexShared.schema`).NumWires).toEqual([0, 1]);
    expect(mps(out, `${W}Owners.mps`, `${W}Owners.schema`).WireCounts).toEqual([4, 0]);
    const back = loadWires(out);
    expect(back.size).toBe(4);
    expect(back.wiresOf(LIGHT).incoming).toEqual([]);
    // re-adding it gives the original bytes back
    back.addWire(w!.source, w!.target);
    const again = back.encode();
    for (const [p, b] of files) expect(bytesEqual(again.get(p)!, b), p).toBe(true);
  });
});

const wireSaves = referenceSaves().filter((rel) => [...readBrz(readRef(rel)).keys()].some((p) => /\/Wires\//.test(p)));

describe.skipIf(!hasRefs || !wireSaves.length)('wire graph (reference saves)', () => {
  describe.each(wireSaves)('%s', (rel) => {
    it('reads, validates and rebuilds every wire chunk byte-identically', () => {
      const files = readBrz(readRef(rel)), g = loadWires(files);
      expect(g.size).toBeGreaterThan(0);
      expect(g.validate().filter((i) => i.severity === 'error')).toEqual([]);
      const out = g.encode({ force: true });
      for (const [p, b] of files) expect(bytesEqual(out.get(p)!, b), p).toBe(true);
      // every wire end is a component its brick carries
      for (const w of g.wires()) for (const end of [w.source, w.target]) expect(g.components.onBrick(end).some((c) => c.type === end.component)).toBe(true);
    });

    it('remove the last wire of a chunk -> encode -> re-read -> re-add gives the original bytes', () => {
      const files = readBrz(readRef(rel)), g = loadWires(files);
      const w = g.wires().at(-1)!;
      g.removeWire(w.id);
      const fewer = loadWires(g.encode());
      expect(fewer.size).toBe(g.size);
      expect(fewer.wiresInto(w.target)).toEqual([]);
      // a fan-in attempt on a port that is still wired is refused
      const other = fewer.wires()[0];
      if (other) expect(() => fewer.addWire(w.source, other.target)).toThrow(WireError);
      fewer.addWire(w.source, w.target);
      const back = fewer.encode();
      for (const [p, b] of files) expect(bytesEqual(back.get(p)!, b), p).toBe(true);
    });
  });
});
