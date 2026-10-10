// Colour palette presets (`Presets/ColorPalettes/*.bp`, JSON). DOM-free.
//
//   {formatVersion:"1", presetVersion:"1", type:"ColorPalette",
//    data:{groups:[{colors:[{b,g,r,a}], name}], description}}
//
// Palette values are LINEAR 0-255 ints. The game converts a palette colour to sRGB bytes when you
// paint with it: srgb = round(255 * oetf(linear / 255)). A palette therefore keeps its linear bytes
// as read (so it writes back unchanged) and converts for display and painting.
//
// The writer reproduces the game's own layout (tabs, CRLF, `"data":` with the brace on the next
// line, keys b,g,r,a then name / description, no trailing newline), so a game-written file round-trips
// byte for byte. Files from other tools (key order r,g,b,a) parse the same; JSON key order doesn't matter.

import { DEFAULT_PALETTE_DESCRIPTION, DEFAULT_PALETTE_GROUPS } from './default-palette.ts';

export type Rgb8 = [number, number, number];

export interface PaletteColour {
  /** LINEAR 0-255 bytes, as stored in the file. */
  r: number;
  g: number;
  b: number;
  /** Stored alpha byte (255 in every palette seen). */
  a: number;
}

export interface PaletteGroup {
  name: string;
  colors: PaletteColour[];
}

export interface Palette {
  description: string;
  groups: PaletteGroup[];
}

// --- Linear <-> sRGB, on 0-255 bytes -----------------------------------------------------------

/** sRGB OETF on 0..1. */
export function srgbOetf(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** sRGB EOTF (inverse of the OETF) on 0..1. */
export function srgbEotf(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const clampByte = (v: number): number => Math.max(0, Math.min(255, v));

/** Linear byte -> sRGB byte, the game's conversion: round(255 * oetf(v / 255)). */
export function linearToSrgbByte(v: number): number {
  return Math.round(255 * srgbOetf(clampByte(v) / 255));
}

/** sRGB byte -> linear byte: round(255 * eotf(v / 255)). Lossy in the darks (sRGB is finer there). */
export function srgbToLinearByte(v: number): number {
  return Math.round(255 * srgbEotf(clampByte(v) / 255));
}

/** A palette colour as the sRGB bytes the game paints with. */
export const paletteColourToSrgb = (c: PaletteColour): Rgb8 =>
  [linearToSrgbByte(c.r), linearToSrgbByte(c.g), linearToSrgbByte(c.b)];

/** sRGB bytes -> a palette colour (linear bytes, a = 255). */
export const srgbToPaletteColour = ([r, g, b]: readonly number[]): PaletteColour =>
  ({ r: srgbToLinearByte(r!), g: srgbToLinearByte(g!), b: srgbToLinearByte(b!), a: 255 });

// --- Parse ---------------------------------------------------------------------------------------

export class PaletteError extends Error {
  override name = 'PaletteError';
}

const asByte = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new PaletteError(`${what} is not a number`);
  return clampByte(Math.round(v));
};

/** Parses a ColorPalette .bp (text, bytes or already-parsed JSON). Throws PaletteError if it isn't one. */
export function parsePalette(input: string | Uint8Array | unknown): Palette {
  let json: unknown = input;
  if (input instanceof Uint8Array) input = new TextDecoder().decode(input);
  if (typeof input === 'string') {
    try { json = JSON.parse((input.charCodeAt(0) === 0xfeff ? input.slice(1) : input)); } catch (e) { throw new PaletteError(`not JSON: ${(e as Error).message}`); }
  }
  const root = json as { type?: unknown; data?: { groups?: unknown; description?: unknown } } | null;
  if (!root || typeof root !== 'object') throw new PaletteError('not a preset object');
  if (root.type !== undefined && root.type !== 'ColorPalette') throw new PaletteError(`preset type is ${String(root.type)}, not ColorPalette`);
  const groups = root.data?.groups;
  if (!Array.isArray(groups)) throw new PaletteError('no data.groups array');
  return {
    description: typeof root.data?.description === 'string' ? root.data.description : '',
    groups: groups.map((g, gi) => {
      const grp = g as { name?: unknown; colors?: unknown };
      if (!Array.isArray(grp?.colors)) throw new PaletteError(`group ${gi} has no colors array`);
      return {
        name: typeof grp.name === 'string' ? grp.name : `Group ${gi + 1}`,
        colors: grp.colors.map((c, ci) => {
          const col = c as Record<string, unknown>;
          const at = `group ${gi} colour ${ci}`;
          return { r: asByte(col?.r, `${at} r`), g: asByte(col?.g, `${at} g`), b: asByte(col?.b, `${at} b`), a: col?.a === undefined ? 255 : asByte(col.a, `${at} a`) };
        }),
      };
    }),
  };
}

// --- Serialise -----------------------------------------------------------------------------------

/** Writes the palette in the game's own .bp layout (see the header). */
export function serialisePalette(p: Palette): string {
  const NL = '\r\n', T = (n: number): string => '\t'.repeat(n), s = (v: string): string => JSON.stringify(v);
  const colour = (c: PaletteColour): string =>
    `${T(5)}{${NL}${T(6)}"b": ${c.b},${NL}${T(6)}"g": ${c.g},${NL}${T(6)}"r": ${c.r},${NL}${T(6)}"a": ${c.a}${NL}${T(5)}}`;
  const list = (items: string[], close: string): string => (items.length ? NL + items.join(',' + NL) + NL + close : '');
  const group = (g: PaletteGroup): string =>
    `${T(3)}{${NL}${T(4)}"colors": [${list(g.colors.map(colour), T(4))}],${NL}${T(4)}"name": ${s(g.name)}${NL}${T(3)}}`;
  return [
    '{',
    `${T(1)}"formatVersion": "1",`,
    `${T(1)}"presetVersion": "1",`,
    `${T(1)}"type": "ColorPalette",`,
    `${T(1)}"data":`,
    `${T(1)}{`,
    `${T(2)}"groups": [${list(p.groups.map(group), T(2))}],`,
    `${T(2)}"description": ${s(p.description)}`,
    `${T(1)}}`,
    '}',
  ].join(NL);
}

// --- Default -------------------------------------------------------------------------------------

/** The game's default palette (2021), a fresh copy (callers may change it). */
export function defaultPalette(): Palette {
  return {
    description: DEFAULT_PALETTE_DESCRIPTION,
    groups: DEFAULT_PALETTE_GROUPS.map(([name, hex]) => ({
      name,
      colors: (hex.match(/.{6}/g) ?? []).map((c) => ({ r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4), 16), a: 255 })),
    })),
  };
}

/** Every colour of a palette in order, as display sRGB bytes. */
export const paletteSrgb = (p: Palette): Rgb8[] => p.groups.flatMap((g) => g.colors.map(paletteColourToSrgb));
