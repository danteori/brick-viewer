import { describe, expect, it } from 'vitest';
import { GATES } from '../../src/logic/gates.ts';
import { NONE, bool, color, display, float, int, quat, rot, str, vec, type Value } from '../../src/logic/values.ts';
import semantics from './wirescript-gate-semantics.json';

interface Operand { variant: string; value: string }
interface Case { inputs: (Operand | 'unwired')[]; output: Operand }

const SELECT = 'BrickComponentType_Expr_Select';
const BRANCH = 'BrickComponentType_Exec_Branch';
/** The probe read the parse gates' output with no thousands separators. */
const PLAIN_INT = /String_Parse(Int|Number)$/;
const COMPOSITE: Record<string, Value['k']> = { rotator: 'rot', quat: 'quat', color: 'color' };

function num(s: string): number {
  const [a, op, b] = s.split(/([/+])/);
  if (!op) return Number(a);
  return op === '/' ? Number(a) / Number(b) : Number(a) + Number(b);
}

function args(s: string): number[] {
  return s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')).split(',').map(num);
}

function operand(o: Operand | 'unwired'): Value {
  if (o === 'unwired') return NONE;
  const { variant, value } = o;
  switch (variant) {
    case 'int': return int(BigInt(value));
    case 'float': return float(num(value));
    case 'str': return str(value);
    case 'bool': return bool(value === 'true');
    case 'vector': { const [x, y, z] = args(value); return vec(x!, y!, z!); }
    case 'rotator': { const [p, y, r] = args(value); return rot(p!, y!, r!); }
    case 'quat': { const [x, y, z, w] = args(value); return quat(x!, y!, z!, w!); }
    case 'color': { const [r, g, b, a] = args(value); return color(r!, g!, b!, a); }
    case 'undefined': return NONE;
    default: throw new Error(`operand ${variant}`);
  }
}

function reader(ports: Map<string, Value>) {
  return (port: string): Value => ports.get(port) ?? NONE;
}

function runCase(type: string, c: Case): Value | string {
  const gate = GATES.get(type)!;
  const ports = new Map<string, Value>();
  if (type === SELECT) {
    ports.set('bSelectB', operand(c.inputs[0]!));
    ports.set('InputA', int(222));
    ports.set('InputB', int(111));
  } else {
    c.inputs.forEach((o, i) => ports.set(gate.inputs[i]!, operand(o)));
  }
  if (type === BRANCH) return gate.exec!(reader(ports), 'Exec')[0] === 'ExecOutA' ? 'A' : 'B';
  return gate.eval!(reader(ports))[gate.outputs[0]!]!;
}

const gates = Object.entries((semantics as unknown as { gates: Record<string, { cases: Case[] }> }).gates);

describe('gate probes (wirescript gate_semantics.json)', () => {
  it('has a gate for every probed component type', () => {
    expect(gates.map(([t]) => t).filter((t) => !GATES.has(t))).toEqual([]);
  });

  for (const [type, { cases }] of gates) {
    const probed = cases.filter((c) => c.inputs.every((o) => o === 'unwired' || o.variant !== 'tmpl'));
    if (!probed.length) continue;
    it(type.replace(/^BrickComponentType_(Expr_)?/, ''), () => {
      for (const c of probed) {
        const label = `${c.inputs.map((o) => (o === 'unwired' ? o : `${o.variant}:${o.value}`)).join(' | ')} => ${c.output.value}`;
        const got = runCase(type, c);
        if (typeof got === 'string') {
          expect(got, label).toBe(c.output.value);
        } else if (COMPOSITE[c.output.variant]) {
          expect(got.k, label).toBe(COMPOSITE[c.output.variant]);
        } else {
          const want = c.output.variant === 'bool' ? (c.output.value === 'true' ? '1' : '0') : c.output.value;
          const text = PLAIN_INT.test(type) ? display(got).replace(/,/g, '') : display(got);
          expect(text, label).toBe(want);
        }
      }
    });
  }
});

describe('value render (probe render table)', () => {
  const render = (semantics as unknown as { render: Record<string, string> }).render;
  const special: Record<string, Value> = { 'str:empty': str(''), 'str:a_b': str('a b') };
  for (const [key, want] of Object.entries(render)) {
    if (key === 'str:multibyte') continue;
    it(key, () => {
      const i = key.indexOf(':');
      const v = special[key] ?? operand({ variant: key.slice(0, i), value: key.slice(i + 1) });
      expect(display(v)).toBe(want);
    });
  }

  it('exact 3-decimal ties round to even, and vectors keep the sign of -0', () => {
    expect(display(vec(0.5625, -0, 0.0005))).toBe('X=0.562 Y=-0.000 Z=0.001');
    expect(display(float(-0.3125))).toBe('-0.312');
    expect(display(float(0.0015))).toBe('0.002');
  });
});
