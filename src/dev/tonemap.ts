// CPU copy of the viewer's tonemapper (Unreal's stock filmic path: expand gamut, blue correction,
// glow / red modifier, FilmToneMap, sRGB OETF), for dev pages that show swatches without WebGL.
// The renderer has its own GLSL version; this one is dev-only and not part of either build.

type V3 = [number, number, number];
type M3 = [V3, V3, V3];
const mul = (v: V3, m: M3): V3 => [0, 1, 2].map((i) => m[i]![0] * v[0] + m[i]![1] * v[1] + m[i]![2] * v[2]) as V3;
const mix3 = (a: V3, b: V3, t: number): V3 => a.map((x, i) => x + (b[i]! - x) * t) as V3;
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const AP1_Y: V3 = [0.2722287, 0.6740818, 0.0536895];
const sRGB_2_AP1: M3 = [[0.6131915, 0.3395121, 0.0473663], [0.0702069, 0.9163358, 0.01345], [0.0206189, 0.1095673, 0.8696067]];
const AP1_2_sRGB: M3 = [[1.7050515, -0.6217907, -0.0832584], [-0.1302571, 1.1408029, -0.0105485], [-0.0240033, -0.1289688, 1.1529717]];
const AP1_2_AP0: M3 = [[0.6954522, 0.1406787, 0.1638691], [0.0447946, 0.8596711, 0.0955343], [-0.0055259, 0.0040252, 1.0015007]];
const AP0_2_AP1: M3 = [[1.4514393, -0.2365107, -0.2149286], [-0.0765538, 1.1762297, -0.0996759], [0.0083161, -0.0060324, 0.9977163]];
const EXPAND: M3 = [[1.3704127, -0.3292913, -0.0636828], [-0.0834342, 1.097091, -0.0108616], [-0.0257933, -0.0986256, 1.2036943]];
const BLUE: M3 = [[0.9386394, 0, 0.0613606], [0, 0.8307941, 0.1692059], [0, 0, 1]];
const BLUEINV: M3 = [[1.0653749, 0, -0.065371], [0, 1.2036635, -0.2036677], [0, 0, 1]];
const SLOPE = 0.88, BLACK = 0, WHITE = 0.04, TOE_SCALE = 0.45, SH_SCALE = 0.78;
const TOE_M = -0.3902772, STRAIGHT_M = 0.9016409, SHOULDER_M = -0.6061863;

function filmCurve(x: number): number {
  const L = Math.log10(Math.max(x, 1e-10));
  const st = SLOPE * (L + STRAIGHT_M);
  const toe = L < TOE_M ? -BLACK + (2 * TOE_SCALE) / (1 + Math.exp((-2 * SLOPE / TOE_SCALE) * (L - TOE_M))) : st;
  const sh = L > SHOULDER_M ? 1 + WHITE - (2 * SH_SCALE) / (1 + Math.exp((2 * SLOPE / SH_SCALE) * (L - SHOULDER_M))) : st;
  let t = Math.min(1, Math.max(0, (L - TOE_M) / (SHOULDER_M - TOE_M)));
  t = 1 - t;
  t = (3 - 2 * t) * t * t;
  return toe + (sh - toe) * t;
}
const oetf = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

/** Scene-linear sRGB-primaries colour -> display sRGB (0..1). */
export function ueFilmic(rgb: V3): V3 {
  let c = mul(rgb, sRGB_2_AP1);
  const lum = dot(c, AP1_Y);
  if (lum > 1e-10) {
    const ch = c.map((x) => x / lum - 1) as V3;
    const amt = (1 - Math.pow(2, -4 * dot(ch, ch))) * (1 - Math.pow(2, -4 * lum * lum));
    c = mix3(c, mul(c, EXPAND), amt);
  }
  c = mix3(c, mul(c, BLUE), 0.6);
  let a0 = mul(c, AP1_2_AP0);
  const mn = Math.min(...a0), mx = Math.max(...a0);
  const s = (Math.max(mx, 1e-10) - Math.max(mn, 1e-10)) / Math.max(mx, 1e-2);
  const chroma = Math.sqrt(Math.max(0, a0[2] * (a0[2] - a0[1]) + a0[1] * (a0[1] - a0[0]) + a0[0] * (a0[0] - a0[2])));
  const yc = (a0[0] + a0[1] + a0[2] + 1.75 * chroma) / 3;
  const x = (s - 0.4) / 0.2, tt = Math.max(1 - Math.abs(0.5 * x), 0), shp = 0.5 * (1 + Math.sign(x) * (1 - tt * tt));
  const gain = 0.05 * shp, glow = yc <= 0.0533333 ? gain : yc >= 0.16 ? 0 : gain * (0.08 / yc - 0.5);
  a0 = a0.map((v) => v * (1 + glow)) as V3;
  let hue = a0[0] === a0[1] && a0[1] === a0[2] ? 0 : (Math.atan2(Math.sqrt(3) * (a0[1] - a0[2]), 2 * a0[0] - a0[1] - a0[2]) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  if (hue > 180) hue -= 360;
  const ss = Math.min(1, Math.max(0, 1 - Math.abs((2 * hue) / 135)));
  let hw = ss * ss * (3 - 2 * ss);
  hw *= hw;
  a0[0] += hw * s * (0.03 - a0[0]) * 0.18;
  let w = mul(a0, AP0_2_AP1).map((v) => Math.max(v, 0)) as V3;
  w = mix3([dot(w, AP1_Y), dot(w, AP1_Y), dot(w, AP1_Y)], w, 0.96);
  let t3 = w.map(filmCurve) as V3;
  const y3 = dot(t3, AP1_Y);
  t3 = mix3([y3, y3, y3], t3, 0.93).map((v) => Math.max(v, 0)) as V3;
  t3 = mix3(t3, mul(t3, BLUEINV), 0.6);
  return mul(t3, AP1_2_sRGB).map((v) => oetf(Math.min(1, Math.max(0, v)))) as V3;
}
