// Colour helpers (h in degrees, s / v 0..1; colours are display sRGB 0..1 like brick colours).

export type RGB = [number, number, number];

export function hsv2rgb(h: number, s: number, v: number): RGB {
  const f = (n: number): number => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}

export interface HSV { h: number; s: number; v: number }

/**
 * Greys have no hue and black no saturation either: keep the previous ones so the wheel marker
 * doesn't jump back to red / the centre when a colour passes through them.
 */
export function rgb2hsv([r, g, b]: readonly number[], prev: HSV): HSV {
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = prev.h;
  if (d > 1e-6) h = 60 * (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return { h, s: mx > 1e-6 ? d / mx : prev.s, v: mx };
}

export const hexOf = (c: readonly number[]): string =>
  '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('');

export function parseHex(s: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
}

/** Linear byte -> display sRGB 0..1 (the sRGB OETF), for saves that store linear colour bytes. */
export function linearByteToSrgb(v: number): number {
  const c = v / 255;
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
