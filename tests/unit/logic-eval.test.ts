import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBrz } from '../../src/format/brz.ts';
import { Clock, MAX_CATCH_UP_TICKS } from '../../src/logic/clock.ts';
import { Evaluator } from '../../src/logic/evaluator.ts';
import { buildLogicGraph, type LogicGraph, type LogicNode } from '../../src/logic/graph.ts';
import { loadComponents, type BrickRef, type ComponentStore } from '../../src/scene/components.ts';
import { loadWires, type WireGraph } from '../../src/scene/wires.ts';
import { REFS } from './refs.ts';

const CHIP_DIR = join(REFS, 'microchip');
const CHIP_SAVE = existsSync(CHIP_DIR) ? readdirSync(CHIP_DIR).filter((n) => n.endsWith('.brz')).sort().map((n) => join(CHIP_DIR, n))[0] : undefined;

describe.skipIf(!CHIP_SAVE)('evaluator on the microchip reference save', () => {
  let graph: LogicGraph, sw: LogicNode, text: LogicNode;
  beforeAll(() => {
    const files = readBrz(readFileSync(CHIP_SAVE!));
    graph = buildLogicGraph(loadComponents(files), loadWires(files));
    [sw] = graph.ofKind('switch') as [LogicNode];
    [text] = graph.ofKind('display') as [LogicNode];
  });

  it('reads the chip and every wired component', () => {
    expect(graph.chips.size).toBe(1);
    expect(graph.unsupported()).toEqual([]);
    expect(graph.looped.size).toBe(0);
  });

  it('shows 3 with the switch on and 0 with it off', () => {
    const ev = new Evaluator(graph);
    expect(ev.switchOn(sw)).toBe(true);
    ev.tick();
    expect(ev.displayText(text)).toBe('3');
    ev.toggle(sw);
    expect(ev.displayText(text)).toBe('3');
    ev.tick();
    expect(ev.displayText(text)).toBe('0');
    ev.setSwitch(sw, true);
    ev.tick();
    expect(ev.displayText(text)).toBe('3');
  });
});

const C = { X: 0, Y: 0, Z: 0 };
const ref = (brick: number, grid = 1): BrickRef => ({ grid, chunk: C, brick });
type Spec = [brick: number, type: string, data?: Record<string, unknown>];
type Link = [from: number, fromPort: string, to: number, toPort: string];

function graphOf(specs: Spec[], links: Link[]) {
  const types = new Map(specs.map(([b, t]) => [b, t]));
  const components = { instances: specs.map(([b, type, data]) => ({ brickRef: ref(b), type, data: data ?? null })) };
  const end = (b: number, port: string) => ({ ...ref(b), component: types.get(b)!, port });
  const wires = { chips: new Map(), wires: () => links.map(([a, ap, b, bp]) => ({ source: end(a, ap), target: end(b, bp) })) };
  return buildLogicGraph(components as unknown as ComponentStore, wires as unknown as WireGraph);
}

const X = 'BrickComponentType_Expr_', node = (g: ReturnType<typeof graphOf>, b: number, t: string): LogicNode => g.find(ref(b), t)!;

describe('evaluator (synthetic networks)', () => {
  it('settles a chain in one tick, whatever the component order', () => {
    const g = graphOf(
      [[3, `${X}MathMultiply`, { InputB: { type: 'i64', value: 10 } }], [2, 'Component_Internal_Rerouter'], [1, `${X}MathAdd`, { InputA: { type: 'i64', value: 2 }, InputB: { type: 'i64', value: 3 } }], [4, 'BrickComponentType_TextDisplay']],
      [[2, 'RER_Output', 3, 'InputA'], [1, 'Output', 2, 'RER_Input'], [3, 'Output', 4, 'Text']],
    );
    const ev = new Evaluator(g);
    ev.tick();
    expect(ev.displayText(node(g, 4, 'BrickComponentType_TextDisplay'))).toBe('50');
  });

  it('a loop with no delay reads the previous tick', () => {
    const g = graphOf([[1, `${X}MathAdd`, { InputB: { type: 'i64', value: 1 } }]], [[1, 'Output', 1, 'InputA']]);
    const ev = new Evaluator(g), add = node(g, 1, `${X}MathAdd`);
    for (let i = 0; i < 5; i++) ev.tick();
    expect(ev.output(add, 'Output')).toEqual({ k: 'int', v: 5n });
  });

  it('a press holds the button for one tick and counts it', () => {
    const g = graphOf([[1, 'Component_Button']], []);
    const ev = new Evaluator(g), b = node(g, 1, 'Component_Button');
    ev.press(b);
    ev.tick();
    expect(ev.output(b, 'bHeld')).toEqual({ k: 'bool', v: true });
    expect(ev.output(b, 'PressCount')).toEqual({ k: 'int', v: 1n });
    ev.tick();
    expect(ev.output(b, 'bHeld')).toEqual({ k: 'bool', v: false });
    ev.setHeld(b, true);
    ev.tick();
    ev.tick();
    expect(ev.output(b, 'bHeld')).toEqual({ k: 'bool', v: true });
    expect(() => ev.toggle(b)).toThrow();
  });

  it('a branch sends the pulse to ExecOutA or ExecOutB', () => {
    const g = graphOf(
      [[1, 'Component_Internal_AnimatedSwitch', { bEnabled: false }], [2, 'BrickComponentType_Exec_Branch'], [3, 'Component_Internal_Rerouter']],
      [[1, 'bEnabled', 2, 'bCond'], [2, 'ExecOutA', 3, 'RER_Input']],
    );
    const ev = new Evaluator(g), sw = node(g, 1, 'Component_Internal_AnimatedSwitch'), br = node(g, 2, 'BrickComponentType_Exec_Branch');
    ev.pulse(br, 'Exec');
    ev.tick();
    expect([ev.lastPulse(br, 'ExecOutA'), ev.lastPulse(br, 'ExecOutB')]).toEqual([null, 1]);
    ev.toggle(sw);
    ev.pulse(br, 'Exec');
    ev.tick();
    expect(ev.lastPulse(br, 'ExecOutA')).toBe(2);
    expect(ev.lastPulse(node(g, 3, 'Component_Internal_Rerouter'), 'RER_Output')).toBe(2);
  });
});

describe('clock', () => {
  it('runs ticks at the set rate, pauses and steps', () => {
    let n = 0;
    const clock = new Clock(() => n++);
    expect(clock.advance(1000)).toBe(MAX_CATCH_UP_TICKS);
    n = 0;
    for (let i = 0; i < 60; i++) clock.advance(1000 / 60);
    expect(n).toBeGreaterThanOrEqual(59);
    expect(n).toBeLessThanOrEqual(60);
    clock.setTps(20);
    n = 0;
    expect(clock.advance(100)).toBe(2);
    clock.pause();
    expect(clock.advance(500)).toBe(0);
    clock.step();
    expect(n).toBe(3);
    clock.resume();
    expect(clock.advance(50)).toBe(1);
    expect(() => clock.setTps(0)).toThrow();
  });
});
