import type { ComponentStore } from '../scene/components.ts';
import type { WireGraph } from '../scene/wires.ts';
import { Clock } from './clock.ts';
import { Evaluator } from './evaluator.ts';
import { buildLogicGraph, type LogicGraph, type LogicNode } from './graph.ts';
import { truthy } from './values.ts';

/** What the live logic reads from a scene: its components, its wires and a number that changes on every edit. */
export interface LogicSource { store: ComponentStore; wires: WireGraph; version: number }

/** The TPS choices of the control, fastest first. */
export const TPS_PRESETS: readonly number[] = [60, 30, 20, 10, 1];

/** A text display with a wired Text input, and what it shows. */
export interface ShownText { node: LogicNode; text: string }

/**
 * The logic of the open scene, always running: a graph and an evaluator that rebuild when the
 * components or wires change, and a clock that the render loop advances. A rebuild starts from the
 * saved values, but a switch the player flipped keeps its state if its saved value did not change.
 */
export class LiveLogic {
  graph: LogicGraph | null = null;
  ev: Evaluator | null = null;
  readonly clock = new Clock(() => this.ev?.tick());
  private source: LogicSource | null = null;
  private version = -1;
  private saved = new Map<string, boolean>();

  /** Builds again if the source or its version changed. Returns true after a rebuild. */
  sync(source: LogicSource | null): boolean {
    if (source === this.source && (source?.version ?? -1) === this.version) return false;
    const same = source !== null && source === this.source;
    const live = this.liveSwitches();
    this.source = source;
    this.version = source?.version ?? -1;
    this.graph = source && source.store.instances.length ? buildLogicGraph(source.store, source.wires) : null;
    this.ev = this.graph ? new Evaluator(this.graph) : null;
    const before = this.saved;
    this.saved = new Map();
    for (const n of this.graph?.ofKind('switch') ?? []) {
      const now = truthy(this.ev!.input(n, 'bEnabled'));
      this.saved.set(n.id, now);
      const kept = live.get(n.id);
      if (same && kept !== undefined && before.get(n.id) === now && kept !== now) this.ev!.setSwitch(n, kept);
    }
    return true;
  }

  /** The player flips a switch or presses a button. Returns false for any other node. */
  interact(node: LogicNode): boolean {
    if (!this.ev) return false;
    if (node.kind === 'switch') this.ev.toggle(node);
    else if (node.kind === 'button') this.ev.press(node);
    else return false;
    return true;
  }

  /** Runs the ticks that are due after `ms`. Returns how many ran. */
  advance(ms: number): number {
    return this.ev ? this.clock.advance(ms) : 0;
  }

  /** Runs one tick now. */
  step(): void {
    this.clock.step();
  }

  /** The text displays that have a wired Text input, with the text each one shows. */
  shownTexts(): ShownText[] {
    const { ev, graph } = this;
    if (!ev || !graph) return [];
    return graph.ofKind('display').filter((n) => graph.source(n, 'Text')).map((node) => ({ node, text: ev.displayText(node) }));
  }

  private liveSwitches(): Map<string, boolean> {
    const live = new Map<string, boolean>();
    for (const n of this.graph?.ofKind('switch') ?? []) live.set(n.id, this.ev!.switchOn(n));
    return live;
  }
}
