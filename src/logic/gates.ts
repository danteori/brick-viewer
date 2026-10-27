import {
  bool, color, compareValues, display, float, int, isComposite, isIntLike, quat, quatToRot, rot,
  str, toColor, toFloat, toInt, toQuat, toStr, toVec, truthy, parseInt64, parseNumber, valuesEqual, vec,
  type Quat, type Value, type Vec3,
} from './values.ts';

/** Reads a gate input by port name. An unwired port with no stored value reads as none. */
export type PortReader = (port: string) => Value;

/**
 * A logic gate kind. Port names and the order of `inputs` follow wirescript's gate inventory and
 * gate probes (cake (Meshiest), wirescript, CC0). That inventory is a game dump: treat it as a hint.
 */
export interface GateDef {
  /** Input data ports, in the order the gate probes give operands. */
  inputs: readonly string[];
  /** Output data ports. */
  outputs: readonly string[];
  /** Pure gates: the outputs from the inputs, in the same tick. */
  eval?: (p: PortReader) => Record<string, Value>;
  /** Exec input ports. */
  execIn?: readonly string[];
  /** Exec output ports. */
  execOut?: readonly string[];
  /** Exec gates: runs on a pulse and returns the exec outputs to pulse. */
  exec?: (p: PortReader, port: string) => string[];
}

const EXPR = 'BrickComponentType_Expr_';
const OUT = 'Output', BOUT = 'bOutput';
const AB = ['InputA', 'InputB'] as const;
const B_AB = ['bInputA', 'bInputB'] as const;

const one = (out: string, f: (p: PortReader) => Value) => (p: PortReader): Record<string, Value> => ({ [out]: f(p) });

function unary(f: (x: number) => number): GateDef {
  return { inputs: ['Input'], outputs: [OUT], eval: one(OUT, (p) => float(f(toFloat(p('Input'))))) };
}

function binaryFloat(inputs: readonly [string, string], f: (a: number, b: number) => number): GateDef {
  return { inputs, outputs: [OUT], eval: one(OUT, (p) => float(f(toFloat(p(inputs[0])), toFloat(p(inputs[1]))))) };
}

function bitwise(f: (a: bigint, b: bigint) => bigint): GateDef {
  return { inputs: AB, outputs: [OUT], eval: one(OUT, (p) => int(f(toInt(p('InputA')), toInt(p('InputB'))))) };
}

function compare(test: (order: number, eq: boolean) => boolean): GateDef {
  return { inputs: AB, outputs: [BOUT], eval: one(BOUT, (p) => {
    const [a, b] = [p('InputA'), p('InputB')];
    return bool(test(compareValues(a, b), valuesEqual(a, b)));
  }) };
}

function logical(f: (a: boolean, b: boolean) => boolean): GateDef {
  return { inputs: B_AB, outputs: [BOUT], eval: one(BOUT, (p) => bool(f(truthy(p('bInputA')), truthy(p('bInputB'))))) };
}

/** Arithmetic on two values, as the Math gates do it (gate probes). */
function arithmetic(intOp: (a: bigint, b: bigint) => bigint, floatOp: (a: number, b: number) => number) {
  return (a: Value, b: Value): Value => {
    if (a.k === 'str' || b.k === 'str') return int(0);
    if (a.k === 'vec' || b.k === 'vec') {
      const [x, y] = [toVec(a), toVec(b)];
      return vec(floatOp(x[0], y[0]), floatOp(x[1], y[1]), floatOp(x[2], y[2]));
    }
    if (isComposite(a) || isComposite(b)) return int(0);
    if (isIntLike(a) && isIntLike(b)) return int(intOp(toInt(a), toInt(b)));
    return float(floatOp(toFloat(a), toFloat(b)));
  };
}

const orZero = (f: (a: number, b: number) => number) => (a: number, b: number): number => (b === 0 ? 0 : f(a, b));
const orZeroBig = (f: (a: bigint, b: bigint) => bigint) => (a: bigint, b: bigint): bigint => (b === 0n ? 0n : f(a, b));

function math(intOp: (a: bigint, b: bigint) => bigint, floatOp: (a: number, b: number) => number): GateDef {
  const f = arithmetic(intOp, floatOp);
  return { inputs: AB, outputs: [OUT], eval: one(OUT, (p) => f(p('InputA'), p('InputB'))) };
}

const caseSensitive = (p: PortReader): boolean => {
  const v = p('bCaseSensitive');
  return v.k === 'none' ? true : truthy(v);
};
const fold = (s: string, cs: boolean): string => (cs ? s : s.toLowerCase());

function stringTest(needle: string, f: (s: string, n: string) => boolean): GateDef {
  return { inputs: ['Input', needle, 'bCaseSensitive'], outputs: [OUT], eval: one(OUT, (p) => {
    const cs = caseSensitive(p), n = fold(toStr(p(needle)), cs);
    return bool(n !== '' && f(fold(toStr(p('Input')), cs), n));
  }) };
}

const asciiCase = (s: string, upper: boolean): string => s.replace(upper ? /[a-z]+/g : /[A-Z]+/g, (m) => (upper ? m.toUpperCase() : m.toLowerCase()));

function stringMap(f: (s: string) => Value): GateDef {
  return { inputs: ['Input'], outputs: [OUT], eval: one(OUT, (p) => f(toStr(p('Input')))) };
}

function substring(s: string, start: number, length: number): string {
  const from = start < 0 ? Math.max(0, s.length + start) : start;
  return length < 0 ? s.slice(from) : s.slice(from, from + length);
}

function find(s: string, search: string, start: number, cs: boolean): number {
  if (!search) return -1;
  return fold(s, cs).indexOf(fold(search, cs), Math.max(0, start));
}

function replace(s: string, search: string, by: string, start: number, max: number, cs: boolean): string {
  if (!search) return s;
  let out = s.slice(0, Math.max(0, start)), at = Math.max(0, start), done = 0;
  for (;;) {
    const i = max > 0 && done >= max ? -1 : find(s, search, at, cs);
    if (i < 0) return out + s.slice(at);
    out += s.slice(at, i) + by;
    at = i + search.length;
    done++;
  }
}

const FORMAT_SLOTS = ['InputA', 'InputB', 'InputC', 'InputD', 'InputE', 'InputF', 'InputG'];

/** String_FormatText: {A}..{G} and {0}..{6} name the inputs (wirescript builtins.md). */
function formatText(p: PortReader): Value {
  return str(toStr(p('FormatString')).replace(/\{([A-Ga-g0-6])\}/g, (_m, k: string) => {
    const i = /\d/.test(k) ? Number(k) : k.toUpperCase().charCodeAt(0) - 65;
    return display(p(FORMAT_SLOTS[i]!));
  }));
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vecOf = (v: Vec3): Value => vec(v[0], v[1], v[2]);
const quatOf = (q: Quat): Value => quat(q[0], q[1], q[2], q[3]);
const qdot = (a: Quat, b: Quat): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

function normalize(v: Vec3): Vec3 {
  const m = Math.hypot(...v);
  return m === 0 ? [0, 0, 0] : [v[0] / m, v[1] / m, v[2] / m];
}

function normalizeQuat(q: Quat): Quat {
  const m = Math.hypot(...q);
  return m === 0 ? [0, 0, 0, 1] : [q[0] / m, q[1] / m, q[2] / m, q[3] / m];
}

/** Rotates a vector by a quaternion (v' = q v q*). */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]], t = cross(u, v).map((c) => 2 * c) as unknown as Vec3;
  const ut = cross(u, t);
  return [v[0] + q[3] * t[0] + ut[0], v[1] + q[3] * t[1] + ut[1], v[2] + q[3] * t[2] + ut[2]];
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = qdot(a, b);
  const bb: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  if (d > 0.9999) return normalizeQuat(a.map((c, i) => c + (bb[i]! - c) * t) as unknown as Quat);
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((c, i) => wa * c + wb * bb[i]!) as unknown as Quat;
}

function quatBetween(from: Vec3, to: Vec3): Quat {
  const [a, b] = [normalize(from), normalize(to)];
  const w = 1 + dot(a, b);
  if (w < 1e-8) {
    const axis = normalize(Math.abs(a[0]) > Math.abs(a[2]) ? [-a[1], a[0], 0] : [0, -a[2], a[1]]);
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(a, b);
  return normalizeQuat([c[0], c[1], c[2], w]);
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const byte = (c: number): number => Math.min(255, Math.max(0, Math.floor(c * 255 + 0.5)));

function hexColor(s: string): Value {
  const h = s.trim().replace(/^#/, '');
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return color(0, 0, 0, 1);
  const n = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255;
  return color(srgbToLinear(n(0)), srgbToLinear(n(2)), srgbToLinear(n(4)), h.length === 8 ? n(6) : 1);
}

function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

function popcount(x: bigint): bigint {
  let n = 0n;
  for (let u = BigInt.asUintN(64, x); u; u >>= 1n) n += u & 1n;
  return n;
}

const shift = (b: bigint): bigint => b & 63n;

const PURE: Record<string, GateDef> = {
  CompareEqual: compare((_o, eq) => eq),
  CompareNotEqual: compare((_o, eq) => !eq),
  CompareLess: compare((o) => o < 0),
  CompareLessOrEqual: compare((o) => o <= 0),
  CompareGreater: compare((o) => o > 0),
  CompareGreaterOrEqual: compare((o) => o >= 0),
  LogicalAND: logical((a, b) => a && b),
  LogicalOR: logical((a, b) => a || b),
  LogicalXOR: logical((a, b) => a !== b),
  LogicalNOT: { inputs: ['bInput'], outputs: [BOUT], eval: one(BOUT, (p) => bool(!truthy(p('bInput')))) },
  Select: { inputs: ['bSelectB', 'InputA', 'InputB'], outputs: [OUT], eval: one(OUT, (p) => p(truthy(p('bSelectB')) ? 'InputB' : 'InputA')) },

  MathAdd: math((a, b) => a + b, (a, b) => a + b),
  MathSubtract: math((a, b) => a - b, (a, b) => a - b),
  MathMultiply: math((a, b) => a * b, (a, b) => a * b),
  MathDivide: math(orZeroBig((a, b) => a / b), orZero((a, b) => a / b)),
  MathModulo: math(orZeroBig((a, b) => a % b), orZero((a, b) => a % b)),

  String_Concatenate: { inputs: ['InputA', 'InputB', 'Separator'], outputs: [OUT], eval: one(OUT, (p) => str(toStr(p('InputA')) + toStr(p('Separator')) + toStr(p('InputB')))) },
  String_FormatText: { inputs: ['FormatString', ...FORMAT_SLOTS], outputs: [OUT], eval: one(OUT, formatText) },
  String_Length: stringMap((s) => int(s.length)),
  String_ToLower: stringMap((s) => str(asciiCase(s, false))),
  String_ToUpper: stringMap((s) => str(asciiCase(s, true))),
  String_Trim: stringMap((s) => str(s.trim())),
  String_Contains: stringTest('Search', (s, n) => s.includes(n)),
  String_StartsWith: stringTest('Prefix', (s, n) => s.startsWith(n)),
  String_EndsWith: stringTest('Suffix', (s, n) => s.endsWith(n)),
  String_Substring: { inputs: ['Input', 'Start', 'Length'], outputs: [OUT], eval: one(OUT, (p) => {
    const len = p('Length');
    return str(substring(toStr(p('Input')), Number(toInt(p('Start'))), len.k === 'none' ? -1 : Number(toInt(len))));
  }) },
  String_Find: { inputs: ['Input', 'Search', 'Start', 'bCaseSensitive'], outputs: [OUT], eval: one(OUT, (p) =>
    int(find(toStr(p('Input')), toStr(p('Search')), Number(toInt(p('Start'))), caseSensitive(p)))) },
  String_Replace: { inputs: ['Input', 'Search', 'Replacement', 'Start', 'MaxReplacements', 'bCaseSensitive'], outputs: [OUT], eval: one(OUT, (p) =>
    str(replace(toStr(p('Input')), toStr(p('Search')), toStr(p('Replacement')), Number(toInt(p('Start'))), Number(toInt(p('MaxReplacements'))), caseSensitive(p)))) },
  String_ParseInt: { inputs: ['Input'], outputs: ['Value', 'bSuccess'], eval: (p) => {
    const n = parseInt64(toStr(p('Input')));
    return { Value: int(n ?? 0n), bSuccess: bool(n !== null) };
  } },
  String_ParseNumber: { inputs: ['Input'], outputs: ['Value', 'bSuccess'], eval: (p) => {
    const n = parseNumber(toStr(p('Input')));
    return { Value: float(n ?? 0), bSuccess: bool(n !== null) };
  } },

  MakeVector: { inputs: ['X', 'Y', 'Z'], outputs: [OUT], eval: one(OUT, (p) => vec(toFloat(p('X')), toFloat(p('Y')), toFloat(p('Z')))) },
  MakeRotation: { inputs: ['Pitch', 'Yaw', 'Roll'], outputs: [OUT], eval: one(OUT, (p) => rot(toFloat(p('Pitch')), toFloat(p('Yaw')), toFloat(p('Roll')))) },
  MakeQuaternion: { inputs: ['X', 'Y', 'Z', 'W'], outputs: [OUT], eval: one(OUT, (p) => quat(toFloat(p('X')), toFloat(p('Y')), toFloat(p('Z')), toFloat(p('W')))) },
  MakeColor: { inputs: ['R', 'G', 'B', 'A'], outputs: [OUT], eval: one(OUT, (p) => color(toFloat(p('R')), toFloat(p('G')), toFloat(p('B')), p('A').k === 'none' ? 1 : toFloat(p('A')))) },
  MakeColorSRGB: { inputs: ['R', 'G', 'B', 'A'], outputs: [OUT], eval: one(OUT, (p) => {
    const c = (port: string): number => Number(toInt(p(port))) / 255;
    return color(srgbToLinear(c('R')), srgbToLinear(c('G')), srgbToLinear(c('B')), p('A').k === 'none' ? 1 : c('A'));
  }) },
  MakeColorHex: { inputs: ['Hex'], outputs: [OUT], eval: one(OUT, (p) => hexColor(toStr(p('Hex')))) },
  ColorToHex: { inputs: ['Input'], outputs: ['Hex'], eval: one('Hex', (p) => {
    const c = toColor(p('Input'));
    return str(c.slice(0, 3).map((x) => byte(linearToSrgb(x)).toString(16).padStart(2, '0')).join('').toUpperCase());
  }) },
  ColorBlend: { inputs: ['ColorA', 'ColorB', 'Alpha'], outputs: [OUT], eval: one(OUT, (p) => {
    const [a, b, t] = [toColor(p('ColorA')), toColor(p('ColorB')), toFloat(p('Alpha'))];
    const l = (i: number): number => a[i]! + (b[i]! - a[i]!) * t;
    return color(l(0), l(1), l(2), l(3));
  }) },

  VecScale: { inputs: ['Input', 'Scalar'], outputs: [OUT], eval: one(OUT, (p) => {
    const [v, s] = [toVec(p('Input')), toFloat(p('Scalar'))];
    return vec(v[0] * s, v[1] * s, v[2] * s);
  }) },
  VecDotProduct: binaryVec((a, b) => float(dot(a, b))),
  VecCrossProduct: binaryVec((a, b) => vecOf(cross(a, b))),
  VecDistanceSquared: binaryVec((a, b) => float(dot(sub(a, b), sub(a, b)))),
  VecDistance: binaryVec((a, b) => float(Math.hypot(...sub(a, b)))),
  VecMagnitudeSquared: unaryVec((v) => float(dot(v, v))),
  VecMagnitude: unaryVec((v) => float(Math.hypot(...v))),
  VecNormalize: unaryVec((v) => vecOf(normalize(v))),

  RotateVector: { inputs: ['Vector', 'Rotation'], outputs: [OUT], eval: one(OUT, (p) => vecOf(rotateVec(toQuat(p('Rotation')), toVec(p('Vector'))))) },
  RotationToDirection: { inputs: ['Rotation'], outputs: [OUT], eval: one(OUT, (p) => vecOf(rotateVec(toQuat(p('Rotation')), [1, 0, 0]))) },
  DirectionToRotation: { inputs: ['Direction'], outputs: [OUT], eval: one(OUT, (p) => {
    const [x, y, z] = toVec(p('Direction'));
    return rot(Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI, Math.atan2(y, x) * 180 / Math.PI, 0);
  }) },
  InvertRotation: { inputs: ['Input'], outputs: [OUT], eval: one(OUT, (p) => {
    const v = p('Input'), q = normalizeQuat(toQuat(v)), inv: Quat = [-q[0], -q[1], -q[2], q[3]];
    if (v.k !== 'rot') return quatOf(inv);
    const r = quatToRot(inv);
    return rot(r[0], r[1], r[2]);
  }) },
  QuatDotProduct: { inputs: AB, outputs: [OUT], eval: one(OUT, (p) => float(qdot(toQuat(p('InputA')), toQuat(p('InputB'))))) },
  QuatAngleBetween: { inputs: AB, outputs: [OUT], eval: one(OUT, (p) => {
    const d = Math.min(1, Math.abs(qdot(normalizeQuat(toQuat(p('InputA'))), normalizeQuat(toQuat(p('InputB'))))));
    return float(2 * Math.acos(d) * 180 / Math.PI);
  }) },
  QuatSlerp: { inputs: ['InputA', 'InputB', 'Alpha'], outputs: [OUT], eval: one(OUT, (p) =>
    quatOf(slerp(normalizeQuat(toQuat(p('InputA'))), normalizeQuat(toQuat(p('InputB'))), toFloat(p('Alpha'))))) },
  QuatFromAxisAngle: { inputs: ['Axis', 'Angle'], outputs: [OUT], eval: one(OUT, (p) => {
    const [a, h] = [normalize(toVec(p('Axis'))), toFloat(p('Angle')) / 2];
    return quat(a[0] * Math.sin(h), a[1] * Math.sin(h), a[2] * Math.sin(h), Math.cos(h));
  }) },
  QuatBetween: { inputs: ['From', 'To'], outputs: [OUT], eval: one(OUT, (p) => quatOf(quatBetween(toVec(p('From')), toVec(p('To'))))) },

  MathSin: unary(Math.sin),
  MathCos: unary(Math.cos),
  MathTan: unary(Math.tan),
  MathAsin: unary(Math.asin),
  MathAcos: unary(Math.acos),
  MathAtan: unary(Math.atan),
  MathSinh: unary(Math.sinh),
  MathCosh: unary(Math.cosh),
  MathTanh: unary(Math.tanh),
  MathAsinh: unary(Math.asinh),
  MathAcosh: unary(Math.acosh),
  MathAtanh: unary(Math.atanh),
  MathExp: unary(Math.exp),
  MathLn: unary(Math.log),
  MathSqrt: unary(Math.sqrt),
  MathAbs: unary(Math.abs),
  MathSign: unary((x) => Math.sign(x) + 0),
  MathNegate: unary((x) => -x),
  MathDegreesToRadians: unary((x) => x * Math.PI / 180),
  MathRadiansToDegrees: unary((x) => x * 180 / Math.PI),
  Round: unary(roundHalfAway),
  Floor: unary(Math.floor),
  Ceil: unary(Math.ceil),
  MathAtan2: binaryFloat(['Y', 'X'], Math.atan2),
  MathPow: binaryFloat(['Input', 'Exponent'], (a, b) => a ** b),
  MathMin: binaryFloat(AB, Math.min),
  MathMax: binaryFloat(AB, Math.max),
  MathLogBase: binaryFloat(['Input', 'Base'], (a, b) => Math.log(a) / Math.log(b)),
  MathModuloFloored: binaryFloat(AB, orZero((a, b) => a - b * Math.floor(a / b))),
  MathClamp: { inputs: ['Input', 'Min', 'Max'], outputs: [OUT], eval: one(OUT, (p) =>
    float(Math.min(Math.max(toFloat(p('Input')), toFloat(p('Min'))), toFloat(p('Max'))))) },

  BitwiseAND: bitwise((a, b) => a & b),
  BitwiseOR: bitwise((a, b) => a | b),
  BitwiseXOR: bitwise((a, b) => a ^ b),
  BitwiseNAND: bitwise((a, b) => ~(a & b)),
  BitwiseNOR: bitwise((a, b) => ~(a | b)),
  BitwiseShiftLeft: bitwise((a, b) => a << shift(b)),
  BitwiseShiftRight: bitwise((a, b) => a >> shift(b)),
  BitwiseNOT: { inputs: ['Input'], outputs: [OUT], eval: one(OUT, (p) => int(~toInt(p('Input')))) },
  BitwiseBitCount: { inputs: ['Input'], outputs: [OUT], eval: one(OUT, (p) => int(popcount(toInt(p('Input'))))) },
};

function binaryVec(f: (a: Vec3, b: Vec3) => Value): GateDef {
  return { inputs: AB, outputs: [OUT], eval: one(OUT, (p) => f(toVec(p('InputA')), toVec(p('InputB')))) };
}

function unaryVec(f: (v: Vec3) => Value): GateDef {
  return { inputs: ['Input'], outputs: [OUT], eval: one(OUT, (p) => f(toVec(p('Input')))) };
}

const BRANCH: GateDef = {
  inputs: ['bCond'],
  outputs: [],
  execIn: ['Exec'],
  execOut: ['ExecOutA', 'ExecOutB'],
  exec: (p) => [truthy(p('bCond')) ? 'ExecOutA' : 'ExecOutB'],
};

/** Gate kinds by component type name. */
export const GATES: ReadonlyMap<string, GateDef> = new Map<string, GateDef>([
  ...Object.entries(PURE).map(([k, g]) => [EXPR + k, g] as [string, GateDef]),
  ['BrickComponentType_Exec_Branch', BRANCH],
]);

/** The gate kind of a component type, if the evaluator knows it. */
export function gateFor(componentType: string): GateDef | undefined {
  return GATES.get(componentType);
}
