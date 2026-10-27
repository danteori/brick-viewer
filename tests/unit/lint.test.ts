import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBrz } from '../../src/format/brz.ts';
import { lintFiles, lintWires, loops } from '../../src/logic/lint.ts';
import type { Wire, WireEnd } from '../../src/scene/wires.ts';
import { loadWires } from '../../src/scene/wires.ts';
import { hasRefs, readRef, referenceSaves, REFS } from './refs.ts';
import { synthSave } from './synth-save.ts';

const GATE = 'BrickComponentType_Expr_MathAdd', BRANCH = 'BrickComponentType_Exec_Branch', RER = 'Component_Internal_Rerouter';
const end = (brick: number, component: string, port: string): WireEnd => ({ grid: 1, chunk: { X: 0, Y: 0, Z: 0 }, brick, component, port });
let id = 0;
const wire = (source: WireEnd, target: WireEnd): Wire => ({ id: id++, source, target, pending: false });
const codes = (w: Wire[]): string[] => lintWires(w).map((i) => i.code);

describe('wire lint', () => {
  it('accepts a plain chain of known ports', () => {
    expect(lintWires([wire(end(0, GATE, 'Output'), end(1, GATE, 'InputA')), wire(end(1, GATE, 'Output'), end(2, RER, 'RER_Input'))])).toEqual([]);
  });

  it('makes fan-in an error', () => {
    const r = lintWires([wire(end(0, GATE, 'Output'), end(2, GATE, 'InputA')), wire(end(1, GATE, 'Output'), end(2, GATE, 'InputA'))]);
    expect(r.map((i) => [i.code, i.severity])).toEqual([['fan-in', 'error']]);
  });

  it('allows one source to feed many inputs', () => {
    expect(codes([wire(end(0, GATE, 'Output'), end(1, GATE, 'InputA')), wire(end(0, GATE, 'Output'), end(2, GATE, 'InputA'))])).toEqual([]);
  });

  it('warns about an unknown port and a port with the wrong direction', () => {
    expect(codes([wire(end(0, GATE, 'Output'), end(1, GATE, 'Nope'))])).toEqual(['unknown-port']);
    expect(codes([wire(end(0, GATE, 'InputA'), end(1, GATE, 'InputB'))])).toEqual(['port-direction']);
    expect(lintWires([wire(end(0, GATE, 'Nope'), end(1, GATE, 'InputB'))])[0]!.severity).toBe('warning');
  });

  it('does not judge component types it does not know', () => {
    expect(codes([wire(end(0, 'Component_Light', 'Anything'), end(1, 'Component_Other', 'Else'))])).toEqual([]);
  });

  it('warns when an exec output feeds a data input, but accepts data into exec', () => {
    expect(codes([wire(end(0, BRANCH, 'ExecOutA'), end(1, GATE, 'InputA'))])).toEqual(['type-mismatch']);
    expect(codes([wire(end(0, 'Component_Touch', 'bTouching'), end(1, BRANCH, 'Exec'))])).toEqual([]);
    expect(codes([wire(end(0, BRANCH, 'ExecOutA'), end(1, RER, 'RER_Input'))])).toEqual([]);
  });

  it('warns about a loop, never errors', () => {
    const ring = [wire(end(0, GATE, 'Output'), end(1, GATE, 'InputA')), wire(end(1, GATE, 'Output'), end(0, GATE, 'InputA'))];
    expect(lintWires(ring).map((i) => [i.code, i.severity])).toEqual([['cycle', 'warning']]);
    expect(loops(ring)[0]).toHaveLength(2);
    expect(loops([wire(end(0, GATE, 'Output'), end(0, GATE, 'InputA'))])).toHaveLength(1);
    expect(loops([wire(end(0, GATE, 'Output'), end(1, GATE, 'InputA'))])).toEqual([]);
  });

  it('finds each loop once in a longer graph', () => {
    const w = [0, 1, 2, 3].map((n) => wire(end(n, GATE, 'Output'), end((n + 1) % 4, GATE, 'InputA')));
    w.push(wire(end(3, GATE, 'Output'), end(9, GATE, 'InputA')));
    expect(loops(w)).toHaveLength(1);
  });
});

describe('wire lint on saves', () => {
  it('passes the synthetic save', () => {
    expect(lintFiles(synthSave())).toEqual({ errors: [], warnings: [] });
  });

  it('blocks a save whose input has two wires', () => {
    const files = synthSave(), g = loadWires(files);
    const w = g.wires()[0]!;
    const other = g.wires().find((x) => x.source.brick !== w.source.brick || x.source.grid !== w.source.grid)!;
    g.addWire(other.source, w.target, { force: true });
    const r = lintFiles(g.encode());
    expect(r.errors).toHaveLength(1);
  });

  it('has nothing to say about a save with no wires', () => {
    expect(lintFiles(new Map())).toEqual({ errors: [], warnings: [] });
  });

  const chipDir = join(REFS, 'microchip');
  const chips = hasRefs && existsSync(chipDir) ? readdirSync(chipDir).filter(f => f.endsWith('.brz')).map(f => `microchip/${f}`) : [];
  const refs = hasRefs ? [...referenceSaves(), ...chips] : [];
  it.skipIf(!hasRefs)('flags nothing in the reference saves', () => {
    for (const rel of refs) expect(lintFiles(readBrz(readRef(rel))), rel).toEqual({ errors: [], warnings: [] });
  });
});
