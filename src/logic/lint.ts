import { brickKey } from '../scene/components.ts';
import { loadWires, type Wire, type WireEnd } from '../scene/wires.ts';
import type { FileMap } from '../format/brz.ts';
import { PASS_IN, PASS_OUT } from './graph.ts';
import { gateFor } from './gates.ts';

export type LintCode = 'fan-in' | 'cycle' | 'unknown-port' | 'port-direction' | 'type-mismatch';

export interface LintIssue {
  code: LintCode;
  /** Errors block the save; warnings only show. */
  severity: 'error' | 'warning';
  message: string;
}

export interface LintResult { errors: string[]; warnings: string[] }

const PASS = /(_Rerouter|MicrochipInput|MicrochipOutput)$/;
const EXEC_PORT = /^Exec/;

const endName = (e: WireEnd): string => `${e.component}.${e.port} on ${brickKey(e)}`;
const nodeKey = (e: WireEnd): string => `${brickKey(e)}/${e.component}`;

interface KnownPorts { inputs: readonly string[]; outputs: readonly string[] }

/** The ports the evaluator knows for a component type, or null when it knows none. */
function knownPorts(type: string): KnownPorts | null {
  const g = gateFor(type);
  if (g) return { inputs: [...g.inputs, ...(g.execIn ?? [])], outputs: [...g.outputs, ...(g.execOut ?? [])] };
  if (PASS.test(type)) return { inputs: [PASS_IN], outputs: [PASS_OUT] };
  return null;
}

function fanIn(wires: readonly Wire[]): LintIssue[] {
  const into = new Map<string, Wire[]>();
  for (const w of wires) {
    const k = `${nodeKey(w.target)}.${w.target.port}`;
    const l = into.get(k);
    if (l) l.push(w);
    else into.set(k, [w]);
  }
  return [...into.values()].filter((l) => l.length > 1).map((l) => ({
    code: 'fan-in', severity: 'error',
    message: `[TEXT: fan-in] ${endName(l[0]!.target)} has ${l.length} wires`,
  }));
}

function portIssues(wires: readonly Wire[]): LintIssue[] {
  const out: LintIssue[] = [];
  const seen = new Set<string>();
  const check = (e: WireEnd, want: 'inputs' | 'outputs'): void => {
    const known = knownPorts(e.component);
    const key = `${e.component}.${e.port}.${want}`;
    if (!known || seen.has(key)) return;
    seen.add(key);
    if (known[want].includes(e.port)) return;
    const other = want === 'inputs' ? 'outputs' : 'inputs';
    if (known[other].includes(e.port)) {
      out.push({ code: 'port-direction', severity: 'warning', message: `[TEXT: port direction] ${e.component}.${e.port} is an ${other === 'inputs' ? 'input' : 'output'}, not an ${want === 'inputs' ? 'input' : 'output'}` });
    } else {
      out.push({ code: 'unknown-port', severity: 'warning', message: `[TEXT: unknown port] ${e.component} has no port ${e.port}` });
    }
  };
  for (const w of wires) {
    check(w.source, 'outputs');
    check(w.target, 'inputs');
  }
  return out;
}

function typeIssues(wires: readonly Wire[]): LintIssue[] {
  const out: LintIssue[] = [];
  const seen = new Set<string>();
  for (const w of wires) {
    const [s, t] = [w.source, w.target];
    if (PASS.test(s.component) || PASS.test(t.component)) continue;
    if (!EXEC_PORT.test(s.port) || EXEC_PORT.test(t.port)) continue;
    const key = `${s.component}.${s.port}>${t.component}.${t.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: 'type-mismatch', severity: 'warning', message: `[TEXT: type mismatch] ${s.component}.${s.port} (exec) is wired to ${t.component}.${t.port} (data)` });
  }
  return out;
}

/** Groups of bricks that feed themselves (strongly connected sets, Tarjan), as lists of node keys. */
export function loops(wires: readonly Wire[]): string[][] {
  const next = new Map<string, string[]>();
  const selfLoop = new Set<string>();
  for (const w of wires) {
    const [a, b] = [nodeKey(w.source), nodeKey(w.target)];
    if (a === b) selfLoop.add(a);
    const l = next.get(a);
    if (l) l.push(b);
    else next.set(a, [b]);
    if (!next.has(b)) next.set(b, []);
  }
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(), stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;
  for (const root of next.keys()) {
    if (index.has(root)) continue;
    const work: { node: string; at: number }[] = [{ node: root, at: 0 }];
    while (work.length) {
      const frame = work[work.length - 1]!;
      const { node } = frame;
      if (frame.at === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
      }
      const edges = next.get(node)!;
      if (frame.at < edges.length) {
        const to = edges[frame.at++]!;
        if (!index.has(to)) work.push({ node: to, at: 0 });
        else if (onStack.has(to)) low.set(node, Math.min(low.get(node)!, index.get(to)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(node)!));
      if (low.get(node) !== index.get(node)) continue;
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        group.push(member);
      } while (member !== node);
      if (group.length > 1 || selfLoop.has(group[0]!)) found.push(group);
    }
  }
  return found;
}

function cycleIssues(wires: readonly Wire[]): LintIssue[] {
  return loops(wires).map((g) => ({
    code: 'cycle', severity: 'warning',
    message: `[TEXT: loop] ${g.length} component${g.length === 1 ? '' : 's'} feed themselves, e.g. ${g[0]}`,
  }));
}

/** Checks wires before a save: fan-in is an error (the game rejects the save); the rest are warnings. */
export function lintWires(wires: readonly Wire[]): LintIssue[] {
  return [...fanIn(wires), ...portIssues(wires), ...typeIssues(wires), ...cycleIssues(wires)];
}

/** lintWires for the wires of a save's files, as messages. A save with no wire chunks is fine. */
export function lintFiles(files: FileMap): LintResult {
  const result: LintResult = { errors: [], warnings: [] };
  if (![...files.keys()].some((p) => /\/Wires\/[^/]+\.mps$/.test(p))) return result;
  for (const i of lintWires(loadWires(files).wires())) (i.severity === 'error' ? result.errors : result.warnings).push(i.message);
  return result;
}
