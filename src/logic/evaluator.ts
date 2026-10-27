import { PASS_IN, PASS_OUT, type LogicGraph, type LogicNode } from './graph.ts';
import { NONE, bool, display, fromWireValue, int, toInt, truthy, type Value } from './values.ts';

/** Exec pulses one tick may run before the evaluator stops the chain (a guard against loops). */
export const MAX_PULSES_PER_TICK = 10_000;

interface SwitchState { on: boolean }
interface ButtonState { held: boolean; count: bigint; releaseNext: boolean }

type Action =
  | { kind: 'switch'; node: LogicNode; on: boolean | 'toggle' }
  | { kind: 'hold'; node: LogicNode; held: boolean }
  | { kind: 'press'; node: LogicNode }
  | { kind: 'pulse'; node: LogicNode; port: string };

/**
 * Runs a logic network one tick at a time. A tick applies the queued player actions, settles every
 * pure gate in order (zero-tick, as in wirescript's exec-context.md), then runs the exec pulses.
 * The evaluator has no timer: a Clock (clock.ts) or a test calls tick().
 */
export class Evaluator {
  /** Ticks run so far. */
  ticks = 0;
  private readonly outputs = new Map<string, Value>();
  private readonly switches = new Map<LogicNode, SwitchState>();
  private readonly buttons = new Map<LogicNode, ButtonState>();
  private readonly pulsed = new Map<string, number>();
  private queue: Action[] = [];
  /** True when the last tick hit MAX_PULSES_PER_TICK. */
  overflow = false;

  constructor(readonly graph: LogicGraph) {
    for (const n of graph.ofKind('switch')) this.switches.set(n, { on: truthy(this.stored(n, 'bEnabled')) });
    for (const n of graph.ofKind('button')) {
      this.buttons.set(n, { held: false, count: toInt(this.stored(n, 'PressCount')), releaseNext: false });
    }
  }

  /** Flips a switch on the next tick. */
  toggle(node: LogicNode): void {
    this.queue.push({ kind: 'switch', node: this.expect(node, 'switch'), on: 'toggle' });
  }

  /** Sets a switch on or off on the next tick. */
  setSwitch(node: LogicNode, on: boolean): void {
    this.queue.push({ kind: 'switch', node: this.expect(node, 'switch'), on });
  }

  /** Presses a button for one tick: bHeld is true for that tick, and PressCount goes up by 1. */
  press(node: LogicNode): void {
    this.queue.push({ kind: 'press', node: this.expect(node, 'button') });
  }

  /** Holds or releases a button from the next tick. */
  setHeld(node: LogicNode, held: boolean): void {
    this.queue.push({ kind: 'hold', node: this.expect(node, 'button'), held });
  }

  /** Sends an exec pulse into a node's input port on the next tick. */
  pulse(node: LogicNode, port: string): void {
    this.queue.push({ kind: 'pulse', node, port });
  }

  /** Runs one tick. */
  tick(): void {
    this.ticks++;
    const pulses = this.applyActions();
    for (const n of this.graph.order) this.settle(n);
    this.runPulses(pulses);
  }

  /** The value on an output port (none before the first tick). */
  output(node: LogicNode, port: string): Value {
    return this.outputs.get(`${node.id}.${port}`) ?? NONE;
  }

  /** The value an input port reads: its wire's source, else the value stored in the save. */
  input(node: LogicNode, port: string): Value {
    const s = this.graph.source(node, port);
    if (s) return this.output(s.node, s.port);
    if (node.kind === 'pass' && port === PASS_IN && node.data && 'CallableDefault' in node.data) return fromWireValue(node.data.CallableDefault);
    return this.stored(node, port);
  }

  /** The tick an exec output port last fired, or null. */
  lastPulse(node: LogicNode, port: string): number | null {
    return this.pulsed.get(`${node.id}.${port}`) ?? null;
  }

  /** The text a text display shows: its wired Text input as the game renders it, else its stored text. */
  displayText(node: LogicNode): string {
    const s = this.graph.source(node, 'Text');
    return s ? display(this.output(s.node, s.port)) : String(node.data?.Text ?? '');
  }

  /** Whether a switch is on. */
  switchOn(node: LogicNode): boolean {
    return this.switches.get(node)?.on ?? false;
  }

  private stored(node: LogicNode, port: string): Value {
    return node.data && port in node.data ? fromWireValue(node.data[port]) : NONE;
  }

  private expect(node: LogicNode, kind: LogicNode['kind']): LogicNode {
    if (node.kind !== kind) throw new Error(`${node.type} is not a ${kind}`);
    return node;
  }

  private applyActions(): { node: LogicNode; port: string }[] {
    for (const b of this.buttons.values()) {
      if (b.releaseNext) Object.assign(b, { held: false, releaseNext: false });
    }
    const pulses: { node: LogicNode; port: string }[] = [];
    for (const a of this.queue) {
      if (a.kind === 'switch') {
        const s = this.switches.get(a.node)!;
        s.on = a.on === 'toggle' ? !s.on : a.on;
      } else if (a.kind === 'hold') {
        Object.assign(this.buttons.get(a.node)!, { held: a.held, releaseNext: false });
      } else if (a.kind === 'press') {
        const b = this.buttons.get(a.node)!;
        Object.assign(b, { held: true, count: b.count + 1n, releaseNext: true });
      } else {
        pulses.push({ node: a.node, port: a.port });
      }
    }
    this.queue = [];
    return pulses;
  }

  private set(node: LogicNode, port: string, v: Value): void {
    this.outputs.set(`${node.id}.${port}`, v);
  }

  private settle(n: LogicNode): void {
    switch (n.kind) {
      case 'gate': {
        if (!n.gate?.eval) return;
        const out = n.gate.eval((port) => this.input(n, port));
        for (const [port, v] of Object.entries(out)) this.set(n, port, v);
        return;
      }
      case 'pass':
        this.set(n, PASS_OUT, this.input(n, PASS_IN));
        return;
      case 'switch':
        this.set(n, 'bEnabled', bool(this.switches.get(n)!.on));
        return;
      case 'button': {
        const b = this.buttons.get(n)!;
        this.set(n, 'bHeld', bool(b.held));
        this.set(n, 'PressCount', int(b.count));
        return;
      }
      default:
    }
  }

  private runPulses(start: { node: LogicNode; port: string }[]): void {
    const queue = [...start];
    this.overflow = false;
    for (let i = 0; i < queue.length; i++) {
      if (i >= MAX_PULSES_PER_TICK) {
        this.overflow = true;
        return;
      }
      const { node, port } = queue[i]!;
      for (const out of this.fire(node, port)) {
        this.pulsed.set(`${node.id}.${out}`, this.ticks);
        queue.push(...this.graph.targetsOf(node, out));
      }
    }
  }

  private fire(node: LogicNode, port: string): string[] {
    if (node.kind === 'pass') return port === PASS_IN ? [PASS_OUT] : [];
    if (node.gate?.exec && node.gate.execIn?.includes(port)) return node.gate.exec((p) => this.input(node, p), port);
    return [];
  }
}
