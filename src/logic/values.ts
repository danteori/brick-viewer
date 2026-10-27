/** A vector: X, Y, Z. */
export type Vec3 = readonly [number, number, number];
/** A quaternion: X, Y, Z, W. */
export type Quat = readonly [number, number, number, number];
/** A rotator in degrees: Pitch, Yaw, Roll. */
export type Rot = readonly [number, number, number];
/** A linear colour: R, G, B, A. */
export type Color = readonly [number, number, number, number];

/** A value on a wire. `none` is an empty port: it reads as 0, false and "". */
export type Value =
  | { k: 'none' }
  | { k: 'bool'; v: boolean }
  | { k: 'int'; v: bigint }
  | { k: 'float'; v: number }
  | { k: 'str'; v: string }
  | { k: 'vec'; v: Vec3 }
  | { k: 'rot'; v: Rot }
  | { k: 'quat'; v: Quat }
  | { k: 'color'; v: Color };

export type ValueKind = Value['k'];

export const NONE: Value = { k: 'none' };
export const bool = (v: boolean): Value => ({ k: 'bool', v });
export const int = (v: bigint | number): Value => ({ k: 'int', v: typeof v === 'bigint' ? BigInt.asIntN(64, v) : toBig(v) });
export const float = (v: number): Value => ({ k: 'float', v: finite(v) });
export const str = (v: string): Value => ({ k: 'str', v });
export const vec = (x: number, y: number, z: number): Value => ({ k: 'vec', v: [finite(x), finite(y), finite(z)] });
export const rot = (pitch: number, yaw: number, roll: number): Value => ({ k: 'rot', v: [finite(pitch), finite(yaw), finite(roll)] });
export const quat = (x: number, y: number, z: number, w: number): Value => ({ k: 'quat', v: [finite(x), finite(y), finite(z), finite(w)] });
export const color = (r: number, g: number, b: number, a = 1): Value => ({ k: 'color', v: [finite(r), finite(g), finite(b), finite(a)] });

/** The game turns NaN and infinity into 0 (gate probes: NaN == NaN, inf < 1). */
export function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

function toBig(x: number): bigint {
  return BigInt.asIntN(64, BigInt(Math.trunc(finite(x))));
}

type Composite = Extract<Value, { k: 'vec' | 'rot' | 'quat' | 'color' }>;
const isCompositeValue = (v: Value): v is Composite => v.k === 'vec' || v.k === 'rot' || v.k === 'quat' || v.k === 'color';
export const isComposite = (v: Value): boolean => isCompositeValue(v);
/** Int-like values do integer arithmetic: int, bool and an empty port. */
export const isIntLike = (v: Value): boolean => v.k === 'int' || v.k === 'bool' || v.k === 'none';

/** The number in a string, or null. */
export function parseNumber(s: string): number | null {
  const t = s.trim();
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : null;
}

/** The integer in a string, or null. */
export function parseInt64(s: string): bigint | null {
  const t = s.trim();
  return /^[+-]?\d+$/.test(t) ? BigInt.asIntN(64, BigInt(t)) : null;
}

/** A scalar as a float. A string that is not a number reads as 0. */
export function toFloat(v: Value): number {
  switch (v.k) {
    case 'bool': return v.v ? 1 : 0;
    case 'int': return Number(v.v);
    case 'float': return v.v;
    case 'str': return finite(parseNumber(v.v) ?? 0);
    default: return 0;
  }
}

/** A scalar as a 64-bit int. Floats truncate. */
export function toInt(v: Value): bigint {
  switch (v.k) {
    case 'bool': return v.v ? 1n : 0n;
    case 'int': return v.v;
    case 'float': return toBig(v.v);
    case 'str': return parseInt64(v.v) ?? toBig(parseNumber(v.v) ?? 0);
    default: return 0n;
  }
}

/** Truthiness, as the Select and Branch gates use it (gate probes). */
export function truthy(v: Value): boolean {
  switch (v.k) {
    case 'bool': return v.v;
    case 'int': return v.v !== 0n;
    case 'float': return v.v !== 0;
    case 'str': return !['', '0', 'false'].includes(v.v.toLowerCase());
    case 'none': return false;
    default: return v.v.some((c) => c !== 0);
  }
}

/** The 3 components of a vector, or a scalar copied 3 times. */
export function toVec(v: Value): Vec3 {
  if (v.k === 'vec') return v.v;
  const s = toFloat(v);
  return [s, s, s];
}

const DEG = Math.PI / 180;

/** A rotator as a quaternion (Unreal's FRotator::Quaternion). */
export function rotToQuat([pitch, yaw, roll]: Rot): Quat {
  const [sp, cp] = [Math.sin(pitch * DEG / 2), Math.cos(pitch * DEG / 2)];
  const [sy, cy] = [Math.sin(yaw * DEG / 2), Math.cos(yaw * DEG / 2)];
  const [sr, cr] = [Math.sin(roll * DEG / 2), Math.cos(roll * DEG / 2)];
  return [cr * sp * sy - sr * cp * cy, -cr * sp * cy - sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy];
}

/** A quaternion as a rotator (Unreal's FQuat::Rotator). */
export function quatToRot([x, y, z, w]: Quat): Rot {
  const singularity = z * x - w * y;
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) / DEG;
  if (singularity < -0.4999995) return [-90, yaw, normAxis(-yaw - 2 * Math.atan2(x, w) / DEG)];
  if (singularity > 0.4999995) return [90, yaw, normAxis(yaw - 2 * Math.atan2(x, w) / DEG)];
  return [Math.asin(2 * singularity) / DEG, yaw, Math.atan2(-2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) / DEG];
}

function normAxis(a: number): number {
  const r = ((a % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/** A rotation value as a quaternion; other values give the identity. */
export function toQuat(v: Value): Quat {
  if (v.k === 'quat') return v.v;
  if (v.k === 'rot') return rotToQuat(v.v);
  return [0, 0, 0, 1];
}

/** A colour value; other values give opaque black. */
export function toColor(v: Value): Color {
  return v.k === 'color' ? v.v : [0, 0, 0, 1];
}

/** Text as String_Concatenate makes it: bools are "true"/"false" (gate probes). */
export function toStr(v: Value): string {
  switch (v.k) {
    case 'none': return '';
    case 'bool': return v.v ? 'true' : 'false';
    case 'int': return v.v.toString();
    case 'float': return String(v.v);
    case 'str': return v.v;
    case 'vec': return displayVec(v.v);
    default: return '';
  }
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** |x| to 3 decimals as printf %.3f does it: an exact tie rounds to the even digit (gate probes). */
function abs3(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e21) return `${BigInt(a)}.000`;
  const exact = a.toFixed(30), cut = exact.indexOf('.') + 4;
  if (!/^50*$/.test(exact.slice(cut))) return a.toFixed(3);
  const down = exact.slice(0, cut);
  return Number(down.at(-1)) % 2 === 0 ? down : (Number(down) + 0.001).toFixed(3);
}

/** A float as the game shows it: at most 3 decimals, thousands separators, no "-0". */
export function displayFloat(x: number): string {
  const [whole, frac] = abs3(finite(x)).split('.') as [string, string];
  const trimmed = frac.replace(/0+$/, '');
  if (whole === '0' && !trimmed) return '0';
  return `${x < 0 ? '-' : ''}${groupThousands(whole)}${trimmed ? `.${trimmed}` : ''}`;
}

/** A vector component as the game shows it: printf %.3f, so "-0.000" keeps its sign. */
export function fixed3(x: number): string {
  return `${x < 0 || Object.is(x, -0) ? '-' : ''}${abs3(x)}`;
}

function displayVec([x, y, z]: Vec3): string {
  return `X=${fixed3(x)} Y=${fixed3(y)} Z=${fixed3(z)}`;
}

/** Text as a text display and String_FormatText show a value (the probe's render table). */
export function display(v: Value): string {
  switch (v.k) {
    case 'none': return '';
    case 'bool': return v.v ? '1' : '0';
    case 'int': return `${v.v < 0n ? '-' : ''}${groupThousands((v.v < 0n ? -v.v : v.v).toString())}`;
    case 'float': return displayFloat(v.v);
    case 'str': return v.v;
    case 'vec': return displayVec(v.v);
    default: return '';
  }
}

function parts(v: Value): readonly number[] {
  return isCompositeValue(v) ? v.v : [];
}

/** Value equality as CompareEqual sees it (gate probes). */
export function valuesEqual(a: Value, b: Value): boolean {
  if (isComposite(a) || isComposite(b)) {
    const [x, y] = [parts(a), parts(b)];
    return a.k === b.k && x.every((c, i) => c === y[i]);
  }
  if (a.k === 'str' && b.k === 'str') return a.v === b.v;
  if (a.k === 'str' || b.k === 'str') {
    const [s, other] = a.k === 'str' ? [a.v, b] : [(b as { v: string }).v, a];
    return other.k !== 'none' && s === toStr(other);
  }
  if (isIntLike(a) && isIntLike(b)) return toInt(a) === toInt(b);
  return toFloat(a) === toFloat(b);
}

/** Order of two scalars: strings read as numbers, so "a" equals "b" (gate probes). */
export function compareValues(a: Value, b: Value): number {
  if (isComposite(a) || isComposite(b)) return NaN;
  if (isIntLike(a) && isIntLike(b)) {
    const [x, y] = [toInt(a), toInt(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return Math.sign(toFloat(a) - toFloat(b));
}

/** A value from a save's WireValue variant ({variant, type, value}). Unknown kinds read as none. */
export function fromWireValue(x: unknown): Value {
  if (!x || typeof x !== 'object' || !('type' in x)) return fromPlain(x);
  const { type, value } = x as { type: string; value: unknown };
  const o = (value ?? {}) as Record<string, number>;
  switch (type.toLowerCase()) {
    case 'bool': return bool(Boolean(value));
    case 'i64': case 'i32': return int(typeof value === 'bigint' ? value : Number(value));
    case 'f64': case 'f32': return float(Number(value));
    case 'str': return str(String(value ?? ''));
    case 'vector': return vec(o.X ?? 0, o.Y ?? 0, o.Z ?? 0);
    case 'rotator': return rot(o.Pitch ?? 0, o.Yaw ?? 0, o.Roll ?? 0);
    case 'quat': return quat(o.X ?? 0, o.Y ?? 0, o.Z ?? 0, o.W ?? 1);
    case 'linearcolor': return color(o.R ?? 0, o.G ?? 0, o.B ?? 0, o.A ?? 1);
    default: return NONE;
  }
}

/** A value from a plain struct field. A whole number reads as int, any other number as float. */
export function fromPlain(x: unknown): Value {
  switch (typeof x) {
    case 'boolean': return bool(x);
    case 'bigint': return int(x);
    case 'number': return Number.isInteger(x) ? int(x) : float(x);
    case 'string': return str(x);
    default: return NONE;
  }
}
