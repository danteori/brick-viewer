import { describe, expect, it } from 'vitest';
import { LiveLogic, type LogicSource } from '../../src/logic/live.ts';
import type { BrickRef } from '../../src/scene/components.ts';

const C = { X: 0, Y: 0, Z: 0 };
const ref = (brick: number): BrickRef => ({ grid: 1, chunk: C, brick });
type Link = [from: number, fromPort: string, to: number, toPort: string];

function source(specs: [number, string, Record<string, unknown>?][], links: Link[], version = 1): LogicSource {
  const types = new Map(specs.map(([b, t]) => [b, t]));
  const end = (b: number, port: string) => ({ ...ref(b), component: types.get(b)!, port });
  return {
    version,
    store: { instances: specs.map(([b, type, data]) => ({ brickRef: ref(b), type, data: data ?? null })) },
    wires: { chips: new Map(), wires: () => links.map(([a, ap, b, bp]) => ({ source: end(a, ap), target: end(b, bp) })) },
  } as unknown as LogicSource;
}

const SW = 'BCT_Switch', TEXT = 'BCT_TextDisplay';
const wired = (version = 1, on = false): LogicSource => source([[0, SW, { bEnabled: on }], [1, TEXT, { Text: 'x' }]], [[0, 'bEnabled', 1, 'Text']], version);

describe('LiveLogic', () => {
  it('has nothing to run without a source', () => {
    const l = new LiveLogic();
    expect(l.sync(null)).toBe(false);
    expect(l.advance(1000)).toBe(0);
    expect(l.shownTexts()).toEqual([]);
  });

  it('builds once per version and runs ticks from the clock', () => {
    const l = new LiveLogic(), s = wired();
    expect(l.sync(s)).toBe(true);
    expect(l.sync(s)).toBe(false);
    expect(l.advance(1000 / 60 * 3 + 1)).toBe(3);
    expect(l.ev!.ticks).toBe(3);
  });

  it('pauses, steps and slows down', () => {
    const l = new LiveLogic();
    l.sync(wired());
    l.clock.pause();
    expect(l.advance(1000)).toBe(0);
    l.step();
    expect(l.ev!.ticks).toBe(1);
    l.clock.resume();
    l.clock.setTps(10);
    expect(l.advance(250)).toBe(2);
  });

  it('shows the wired display text and not an unwired one', () => {
    const l = new LiveLogic();
    l.sync(source([[0, SW, { bEnabled: true }], [1, TEXT, { Text: 'a' }], [2, TEXT, { Text: 'b' }]], [[0, 'bEnabled', 1, 'Text']]));
    l.step();
    const shown = l.shownTexts();
    expect(shown.map((s) => s.text)).toEqual(['1']);
    expect(shown[0]!.node.brick.brick).toBe(1);
  });

  it('flips a switch on the next tick and presses a button', () => {
    const l = new LiveLogic();
    l.sync(wired());
    l.step();
    const sw = l.graph!.ofKind('switch')[0]!;
    expect(l.interact(sw)).toBe(true);
    expect(l.shownTexts()[0]!.text).toBe('0');
    l.step();
    expect(l.shownTexts()[0]!.text).toBe('1');
    expect(l.interact(l.graph!.ofKind('display')[0]!)).toBe(false);
  });

  it('keeps a flipped switch through a rebuild, but not when its saved value changed', () => {
    const l = new LiveLogic(), s = wired(1);
    const saved = s.store.instances[0]!.data as Record<string, unknown>;
    l.sync(s);
    l.step();
    l.interact(l.graph!.ofKind('switch')[0]!);
    l.step();
    s.version = 2;
    l.sync(s);
    l.step();
    expect(l.shownTexts()[0]!.text).toBe('1');
    saved.bEnabled = true;
    s.version = 3;
    l.sync(s);
    l.step();
    expect(l.shownTexts()[0]!.text).toBe('1');
    saved.bEnabled = false;
    s.version = 4;
    l.sync(s);
    l.step();
    expect(l.shownTexts()[0]!.text).toBe('0');
  });

  it('starts fresh for another scene', () => {
    const l = new LiveLogic();
    l.sync(wired(1));
    l.interact(l.graph!.ofKind('switch')[0]!);
    l.step();
    l.sync(wired(1));
    l.step();
    expect(l.shownTexts()[0]!.text).toBe('0');
  });
});
