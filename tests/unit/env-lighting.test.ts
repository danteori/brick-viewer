import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultEnvironment, parseEnvironment, setEnvValue } from '../../src/format/environment.ts';
import { environmentToLighting, FIT, sunElevationFactor, topFaceK, type Rgb } from '../../src/env/lighting.ts';
import { cellHash, cellMix, environmentGroundPlate } from '../../src/env/ground-plate.ts';
import { REFS } from './refs.ts';

// The calibration's free per-environment fits (sun, sky at screen centre, exposure 1). The structured
// formula must reproduce their top-face light K = 0.81 sun + sky within the fit's stated errors.
// The stated errors are headline numbers, so the per-channel limits below carry about one point of slack.
const FITTED: Record<string, { sun: Rgb; sky: Rgb; floor: Rgb; maxErr: number; rmsErr: number }> = {
  DEFAULT:   { sun: [5.771, 3.276, 2.062], sky: [0.401, 0.484, 1.223], floor: [0.110, 0.076, 0.072], maxErr: 0.065, rmsErr: 0.055 }, // stated +5 %
  AFTERNOON: { sun: [6.728, 3.782, 2.408], sky: [0.000, 0.043, 0.253], floor: [0.120, 0.077, 0.054], maxErr: 0.05, rmsErr: 0.045 },  // stated -4 %
  OVERCAST:  { sun: [0.000, 0.000, 0.000], sky: [1.793, 1.812, 2.488], floor: [0.063, 0.059, 0.080], maxErr: 0.065, rmsErr: 0.06 },  // stated <= 6 %
  NIGHT:     { sun: [0.078, 0.073, 0.192], sky: [0.044, 0.035, 0.041], floor: [0.002, 0.000, 0.002], maxErr: 0.15, rmsErr: 0.105 },  // stated 9.7 % rms, G 13 %
};

const envDir = join(REFS, 'environments');
const refFile = (label: string): string | undefined =>
  existsSync(envDir) ? readdirSync(envDir).find((n) => n.toUpperCase().startsWith(label) && n.toLowerCase().endsWith('.bp')) : undefined;

describe.each(Object.keys(FITTED))('calibration: %s', (label) => {
  const file = refFile(label);
  it.skipIf(!file)('matches the fitted top-face light', () => {
    const env = parseEnvironment(readFileSync(join(envDir, file!), 'utf8'));
    const l = environmentToLighting(env, { vignette: true });
    expect(l.exposure).toBe(1);
    expect(l.calibrated).toBe(true);
    const ref = FITTED[label]!;
    const K = topFaceK(l), Kref = ref.sun.map((v, i) => FIT.topNdotL * v + ref.sky[i]!);
    const rel = K.map((v, i) => (v - Kref[i]!) / Kref[i]!);
    const rms = Math.sqrt(rel.reduce((s, e) => s + e * e, 0) / 3);
    expect(Math.max(...rel.map(Math.abs)), `K ${K.map((v) => v.toFixed(3))} vs ${Kref.map((v) => v.toFixed(3))}`).toBeLessThanOrEqual(ref.maxErr);
    expect(rms).toBeLessThanOrEqual(ref.rmsErr);
    expect(l.night).toBe(label === 'NIGHT');
    // The floor is 2-3 % of K; check it to within half a percent of K.
    l.floor.forEach((v, i) => expect(Math.abs(v - ref.floor[i]!)).toBeLessThanOrEqual(0.005 * Kref[i]! + 0.002));
  });
});

describe('lighting model', () => {
  it('exposure 0.93 without a vignette', () => {
    expect(environmentToLighting(defaultEnvironment()).exposure).toBe(0.93);
  });
  it('time of day: dark at night, brightest at noon', () => {
    expect(sunElevationFactor(3)).toBe(0);
    expect(sunElevationFactor(12)).toBeCloseTo(1);
    let env = defaultEnvironment();
    const at = (t: number): number => { env = setEnvValue(env, 'sky', 'timeOfDay', t); return topFaceK(environmentToLighting(env))[0]; };
    expect(at(12)).toBeGreaterThan(at(9));
    expect(at(9)).toBeGreaterThan(at(23));
    expect(environmentToLighting(env).night).toBe(true);
  });
  it('heavy cloud removes the direct sun', () => {
    const env = setEnvValue(defaultEnvironment(), 'sky', 'cloudCoverage', 0.9);
    expect(environmentToLighting(env).sun).toEqual([0, 0, 0]);
  });
  it('Space worlds use the universe light, flagged uncalibrated', () => {
    const l = environmentToLighting(defaultEnvironment('Space'));
    expect(l.calibrated).toBe(false);
    expect(l.sun[0]).toBeGreaterThan(0);
  });
});

describe('ground plate', () => {
  it('maps the group, and Space worlds have none', () => {
    const g = environmentGroundPlate(defaultEnvironment())!;
    expect(g.visible).toBe(true);
    expect(g.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(g.cellStuds).toBeGreaterThanOrEqual(1);
    expect(environmentGroundPlate(defaultEnvironment('Space'))).toBeNull();
  });
  it('linear colour -> sRGB bytes', () => {
    let env = setEnvValue(defaultEnvironment(), 'groundPlate', 'groundColor', { r: 0.2158605, g: 1, b: 0, a: 1 });
    env = setEnvValue(env, 'groundPlate', 'isVisible', false);
    const g = environmentGroundPlate(env)!;
    expect(g.srgbBytes).toEqual([128, 255, 0]);
    expect(g.hex).toBe('#80ff00');
    expect(g.visible).toBe(false);
  });
  it('variance mixes toward the accent per cell, stably', () => {
    let env = setEnvValue(defaultEnvironment(), 'groundPlate', 'variance', 1);
    env = setEnvValue(env, 'groundPlate', 'varianceBrickSize', 4);
    env = setEnvValue(env, 'groundPlate', 'groundAccentColor', { r: 1, g: 1, b: 1, a: 1 });
    const g = environmentGroundPlate(env)!;
    expect(cellMix(g, 0, 0)).toEqual(cellMix(g, 3.9, 3.9));
    const hs = Array.from({ length: 200 }, (_, i) => cellHash(i, -i));
    expect(Math.min(...hs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...hs)).toBeLessThan(1);
    expect(new Set(hs.map((h) => h.toFixed(3))).size).toBeGreaterThan(150);
    const flat = environmentGroundPlate(defaultEnvironment())!;
    expect(cellMix(flat, 5, 7)).toEqual(flat.color);
  });
});
