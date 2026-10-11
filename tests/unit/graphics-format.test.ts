import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultGraphicsPreset, getGfx, GraphicsPresetError, parseGraphicsPreset, qualityLevelOf, serialiseGraphicsPreset, setGfx, withQualityLevel,
} from '../../src/format/graphics.ts';
import { wantFromPreset } from '../../src/render/fx/state.ts';
import { REFS } from './refs.ts';

const SAMPLE = [
  '{', '\t"formatVersion": "1",', '\t"presetVersion": "1",', '\t"type": "Options/Graphics",', '\t"data":', '\t{',
  '\t\t"shadowQuality": 2,', '\t\t"hDRBrightnessMultiplier": 1.0499999523162842,', '\t\t"antiAliasingMode": "DLSS",',
  '\t\t"resolutionScaleValueEx": 58,', '\t\t"vSyncEnabled": true,', '\t\t"someFutureKey": "kept"', '\t}', '}',
].join('\r\n');

describe('graphics presets (.bp Options/Graphics)', () => {
  it('round-trips byte for byte, unknown keys and spelling kept', () => {
    const p = parseGraphicsPreset(SAMPLE);
    expect(serialiseGraphicsPreset(p)).toBe(SAMPLE);
    expect(getGfx(p, 'ShadowQuality')).toBe(2);           // either spelling
    expect(getGfx(p, 'someFutureKey')).toBe('kept');
  });
  it('edits in place under the file\'s spelling, appends new keys', () => {
    const p = setGfx(setGfx(parseGraphicsPreset(SAMPLE), 'ShadowQuality', 3), 'FieldOfView', 80);
    const t = serialiseGraphicsPreset(p);
    expect(t).toContain('"shadowQuality": 3');
    expect(t).not.toContain('"ShadowQuality"');
    expect(t).toContain('"FieldOfView": 80');
  });
  it('LF files stay LF', () => {
    const lf = SAMPLE.replace(/\r\n/g, '\n');
    expect(serialiseGraphicsPreset(parseGraphicsPreset(lf))).toBe(lf);
  });
  it('rejects other preset types', () => {
    expect(() => parseGraphicsPreset('{"type":"Environment","data":{}}')).toThrow(GraphicsPresetError);
    expect(() => parseGraphicsPreset('nope')).toThrow(GraphicsPresetError);
  });
  it('quality levels set every group', () => {
    const p = withQualityLevel(defaultGraphicsPreset(), 1);
    expect(qualityLevelOf(p)).toBe(1);
    expect(qualityLevelOf(setGfx(p, 'ShadowQuality', 3))).toBeNull();
  });
  it('maps onto the effects', () => {
    const w = wantFromPreset(parseGraphicsPreset(SAMPLE), true, true);
    expect(w.shadows).toBe(2);
    expect(w.renderScale).toBe(1);                         // DLSS: upscaled, so the viewer renders native
    const low = wantFromPreset(withQualityLevel(defaultGraphicsPreset(), 0), true, false);
    expect([low.shadows, low.ssao, low.waves, low.bloom]).toEqual([0, 0, 0, false]);
    const scaled = wantFromPreset(setGfx(setGfx(defaultGraphicsPreset(), 'AntiAliasingMode', 'TAA'), 'ResolutionScaleValueEx', 50), true, false);
    expect(scaled.renderScale).toBe(0.5);
  });
  const dir = join(REFS, 'presets', 'graphics');
  it.skipIf(!existsSync(dir))('every reference preset round-trips byte for byte', () => {
    const files = readdirSync(dir).filter((n) => n.endsWith('.bp'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(serialiseGraphicsPreset(parseGraphicsPreset(text)), f).toBe(text);
    }
  });
});
