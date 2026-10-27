import type { MpsObject } from '../format/schema.ts';
import { brickKey, type BrickRef, type ComponentInstance, type ComponentStore } from '../scene/components.ts';
import type { ChipGrid, WireEnd, WireGraph } from '../scene/wires.ts';
import { gateFor, type GateDef } from './gates.ts';

/**
 * How the evaluator treats a component: a gate, a pass-through (rerouter, chip input or output),
 * an input the player uses (switch, button), a text display, or a kind it does not know.
 */
export type NodeKind = 'gate' | 'pass' | 'switch' | 'button' | 'display' | 'other';

export interface LogicNode {
  /** `<grid>/<chunk>/<brick>/<component type>`. */
  id: string;
  type: string;
  brick: BrickRef;
  kind: NodeKind;
  gate: GateDef | null;
  /** The component's stored data; unwired inputs read their value from it. */
  data: MpsObject | null;
  /** The chip grid the node is in, or null for a node outside chips. */
  chip: number | null;
}

/** One end of a connection: a node and a port. */
export interface PortRef { node: LogicNode; port: string }

const PASS = /(_Rerouter|MicrochipInput|MicrochipOutput)$/;
const SWITCH = /(Switch)$/;
const BUTTON = /(Button)$/;
const DISPLAY = /TextDisplay$/;

export const PASS_IN = 'RER_Input', PASS_OUT = 'RER_Output';

function kindOf(type: string, gate: GateDef | undefined): NodeKind {
  if (gate) return 'gate';
  if (PASS.test(type)) return 'pass';
  if (SWITCH.test(type)) return 'switch';
  if (BUTTON.test(type)) return 'button';
  if (DISPLAY.test(type)) return 'display';
  return 'other';
}

export const nodeId = (brick: BrickRef, type: string): string => `${brickKey(brick)}/${type}`;
const portKey = (id: string, port: string): string => `${id}.${port}`;

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

/** The logic network of a save: components as nodes, wires as connections, in evaluation order. */
export class LogicGraph {
  readonly nodes = new Map<string, LogicNode>();
  /** Chip grids, from the wire graph. */
  readonly chips: ReadonlyMap<number, ChipGrid>;
  private readonly sources = new Map<string, PortRef>();
  private readonly targets = new Map<string, PortRef[]>();
  /** Nodes in the order that settles the network in one pass; nodes in a loop come last. */
  readonly order: LogicNode[];
  /** Nodes that are in a loop with no tick delay. They read the previous tick's values. */
  readonly looped: ReadonlySet<LogicNode>;

  constructor(components: ComponentStore, wires: WireGraph) {
    this.chips = wires.chips;
    for (const c of components.instances) this.addNode(c.brickRef, c.type, c);
    for (const w of wires.wires()) {
      const [s, t] = [this.endNode(w.source), this.endNode(w.target)];
      this.sources.set(portKey(t.id, w.target.port), { node: s, port: w.source.port });
      pushTo(this.targets, portKey(s.id, w.source.port), { node: t, port: w.target.port });
    }
    [this.order, this.looped] = this.sortNodes();
  }

  /** The output that drives an input port, if a wire does. */
  source(node: LogicNode, port: string): PortRef | undefined {
    return this.sources.get(portKey(node.id, port));
  }

  /** The input ports an output port drives. */
  targetsOf(node: LogicNode, port: string): readonly PortRef[] {
    return this.targets.get(portKey(node.id, port)) ?? [];
  }

  /** Nodes of one kind. */
  ofKind(kind: NodeKind): LogicNode[] {
    return [...this.nodes.values()].filter((n) => n.kind === kind);
  }

  /** The node of a component on a brick. */
  find(brick: BrickRef, type: string): LogicNode | undefined {
    return this.nodes.get(nodeId(brick, type));
  }

  /** Component types with wires that the evaluator does not know. */
  unsupported(): string[] {
    const wired = new Set([...this.sources.values()].map((s) => s.node));
    for (const l of this.targets.values()) for (const t of l) wired.add(t.node);
    return [...new Set([...wired].filter((n) => n.kind === 'other').map((n) => n.type))].sort();
  }

  private addNode(brick: BrickRef, type: string, c: ComponentInstance | null): LogicNode {
    const gate = gateFor(type);
    const node: LogicNode = {
      id: nodeId(brick, type), type, brick, kind: kindOf(type, gate), gate: gate ?? null, data: c?.data ?? null,
      chip: this.chips.has(brick.grid) ? brick.grid : null,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  private endNode(e: WireEnd): LogicNode {
    const brick: BrickRef = { grid: e.grid, chunk: e.chunk, brick: e.brick };
    return this.nodes.get(nodeId(brick, e.component)) ?? this.addNode(brick, e.component, null);
  }

  private sortNodes(): [LogicNode[], Set<LogicNode>] {
    const nodes = [...this.nodes.values()];
    const waiting = new Map<LogicNode, number>(nodes.map((n) => [n, 0]));
    const users = new Map<LogicNode, LogicNode[]>();
    for (const [k, s] of this.sources) {
      const target = this.nodes.get(k.slice(0, k.lastIndexOf('.')))!;
      if (s.node === target) continue;
      waiting.set(target, waiting.get(target)! + 1);
      pushTo(users, s.node, target);
    }
    const order = nodes.filter((n) => waiting.get(n) === 0);
    for (let i = 0; i < order.length; i++) {
      for (const u of users.get(order[i]!) ?? []) {
        const left = waiting.get(u)! - 1;
        waiting.set(u, left);
        if (left === 0) order.push(u);
      }
    }
    const placed = new Set(order);
    const looped = new Set(nodes.filter((n) => !placed.has(n)));
    return [[...order, ...looped], looped];
  }
}

/** Builds the logic network of a save from its components and wires. */
export function buildLogicGraph(components: ComponentStore, wires: WireGraph): LogicGraph {
  return new LogicGraph(components, wires);
}
