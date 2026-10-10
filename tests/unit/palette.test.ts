import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  linearToSrgbByte, paletteColourToSrgb, paletteSrgb, PaletteError, parsePalette, defaultPalette,
  serialisePalette, srgbEotf, srgbOetf, srgbToLinearByte, type Palette,
} from '../../src/format/palette.ts';
import { readBrz } from '../../src/format/brz.ts';
import { extractBricks } from '../../src/format/world.ts';
import { hasRefs, readRef, referenceSaves, REFS } from './refs.ts';

const NL = '\r\n';
const BOM = String.fromCharCode(0xfeff);
const sample: Palette = {
  description: 'Two lines\r\nand a "quote"',
  groups: [
    { name: 'A', colors: [{ r: 255, g: 0, b: 1, a: 255 }, { r: 10, g: 20, b: 30, a: 255 }] },
    { name: 'Empty', colors: [] },
  ],
};

describe('linear <-> sRGB bytes', () => {
  it('matches the formula round(255 * oetf(v / 255)) for every byte', () => {
    for (let v = 0; v <= 255; v++) {
      const c = v / 255, ref = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      expect(linearToSrgbByte(v)).toBe(Math.round(255 * ref));
    }
  });
  it('known values', () => {
    expect([0, 1, 2, 6, 17, 57, 128, 184, 254, 255].map(linearToSrgbByte)).toEqual([0, 13, 22, 42, 73, 130, 188, 221, 255, 255]);
    expect([0, 13, 128, 188, 255].map(srgbToLinearByte)).toEqual([0, 1, 55, 128, 255]);
  });
  it('is monotonic, and the OETF / EOTF invert each other', () => {
    for (let v = 1; v <= 255; v++) {
      expect(linearToSrgbByte(v)).toBeGreaterThanOrEqual(linearToSrgbByte(v - 1));
      expect(srgbToLinearByte(v)).toBeGreaterThanOrEqual(srgbToLinearByte(v - 1));
      expect(srgbEotf(srgbOetf(v / 255))).toBeCloseTo(v / 255, 12);
    }
  });
  it('linear -> sRGB -> linear is exact in the darks only, so palettes keep their linear bytes', () => {
    for (let v = 0; v < 75; v++) expect(srgbToLinearByte(linearToSrgbByte(v))).toBe(v);
    expect(srgbToLinearByte(linearToSrgbByte(75))).not.toBe(75);
  });
  it('clamps out-of-range input', () => {
    expect(linearToSrgbByte(-5)).toBe(0);
    expect(linearToSrgbByte(300)).toBe(255);
  });
});

describe('parse / serialise', () => {
  it('writes the game layout: tabs, CRLF, b,g,r,a order, no trailing newline', () => {
    const s = serialisePalette(sample);
    expect(s.startsWith(`{${NL}\t"formatVersion": "1",${NL}\t"presetVersion": "1",${NL}\t"type": "ColorPalette",${NL}\t"data":${NL}\t{${NL}\t\t"groups": [${NL}`)).toBe(true);
    expect(s).toContain(`\t\t\t\t\t{${NL}\t\t\t\t\t\t"b": 1,${NL}\t\t\t\t\t\t"g": 0,${NL}\t\t\t\t\t\t"r": 255,${NL}\t\t\t\t\t\t"a": 255${NL}\t\t\t\t\t}`);
    expect(s.endsWith(`\t\t],${NL}\t\t"description": "Two lines\\r\\nand a \\"quote\\""${NL}\t}${NL}}`)).toBe(true);
    expect(s).not.toMatch(/[^\r]\n/);
  });
  it('round-trips through its own output', () => {
    const s = serialisePalette(sample);
    expect(parsePalette(s)).toEqual(sample);
    expect(serialisePalette(parsePalette(s))).toBe(s);
  });
  it('reads r,g,b,a key order, bytes, a BOM, and a missing alpha / description', () => {
    const txt = BOM + JSON.stringify({ formatVersion: '1', type: 'ColorPalette', data: { groups: [{ name: 'X', colors: [{ r: 1, g: 2, b: 3 }] }] } });
    const p = parsePalette(new TextEncoder().encode(txt));
    expect(p).toEqual({ description: '', groups: [{ name: 'X', colors: [{ r: 1, g: 2, b: 3, a: 255 }] }] });
  });
  it('rejects non-palettes with PaletteError', () => {
    expect(() => parsePalette('not json')).toThrow(PaletteError);
    expect(() => parsePalette('{"type":"Environment","data":{"groups":{}}}')).toThrow(/ColorPalette/);
    expect(() => parsePalette('{"data":{}}')).toThrow(/groups/);
    expect(() => parsePalette('{"data":{"groups":[{"colors":[{"r":"x","g":0,"b":0}]}]}}')).toThrow(PaletteError);
  });
  it('converts palette colours to the sRGB bytes the game paints', () => {
    expect(paletteColourToSrgb({ r: 255, g: 57, b: 0, a: 255 })).toEqual([255, 130, 0]);
  });
});

describe('default palette', () => {
  const p = defaultPalette();
  it('has 8 groups of 12 and is a valid, serialisable palette', () => {
    expect(p.groups.map((g) => g.colors.length)).toEqual([12, 12, 12, 12, 12, 12, 12, 12]);
    expect(parsePalette(serialisePalette(p))).toEqual(p);
  });
  it('greys run white to black', () => {
    const s = paletteSrgb(p);
    expect(s[0]).toEqual([255, 255, 255]);
    expect(s[11]).toEqual([0, 0, 0]);
  });
  it('is a fresh copy each call', () => {
    defaultPalette().groups[0]!.colors[0]!.r = 1;
    expect(defaultPalette().groups[0]!.colors[0]!.r).toBe(255);
  });
});

// Private reference palettes (BRICK_REFS / ../references/presets/ColorPalettes): skipped on CI.
const palDir = join(REFS, 'presets', 'ColorPalettes');
const palFiles = existsSync(palDir) ? readdirSync(palDir).filter((n) => n.endsWith('.bp')).sort() : [];

describe.skipIf(!palFiles.length)('reference palettes', () => {
  it.each(palFiles)('%s round-trips byte for byte', (name) => {
    const text = new TextDecoder().decode(readRef(`presets/ColorPalettes/${name}`));
    const p = parsePalette(text);
    expect(p.groups.length).toBeGreaterThan(0);
    expect(serialisePalette(p)).toBe(text);
  });

  it('the built-in default equals a reference default palette', () => {
    const def = serialisePalette(defaultPalette());
    expect(palFiles.some((n) => new TextDecoder().decode(readRef(`presets/ColorPalettes/${n}`)) === def)).toBe(true);
  });

  it.skipIf(!hasRefs)('some reference save painted from a palette holds exactly its linear->sRGB colours', () => {
    const pals = palFiles.map((n) => new Set(paletteSrgb(parsePalette(readRef(`presets/ColorPalettes/${n}`))).map((c) => c.join(','))));
    let matched = 0;
    for (const rel of referenceSaves()) {
      let cols: Set<string>;
      try {
        cols = new Set(extractBricks(readBrz(readRef(rel))).bricks.map((b) => b.color.slice(0, 3).join(',')));
      } catch { continue; }
      if (cols.size < 50) continue;
      if (pals.some((ps) => [...cols].every((c) => ps.has(c)))) matched++;
    }
    expect(matched).toBeGreaterThan(0);
  });
});
