import { describe, expect, it } from 'vitest';
import {
  GLASS_TINT, GLOW_BLOOM, GLOW_LADDER, MATERIALS_GLSL, TRANSLUCENT_OPACITY, fresnel, glassColor, glassTint,
  glassTransmission, glowColor, glowLevel, lerp3, translucentColor, translucentOpacity, type Rgb,
} from '../../src/render/materials.ts';

const close = (a: number, b: number, eps = 1e-3): void => { expect(Math.abs(a - b)).toBeLessThan(eps); };

describe('fitted material constants', () => {
  it('glass tint strength reproduces the fit at 0 / 5 / 10', () => {
    close(glassTint(0), 0.911); close(glassTint(5), 0.557); close(glassTint(10), 0.156);
    close(glassTint(2.5), (0.911 + 0.557) / 2);
    close(glassTint(-3), 0.911); close(glassTint(42), 0.156);
  });
  it('glass: a black tile seen head-on transmits 1 - t; a white one is clear', () => {
    for (const [i, t] of [[0, 0.911], [5, 0.557], [10, 0.156]] as const) {
      close(glassTransmission([0, 0, 0], i, 1)[0], 1 - t);
      close(glassTransmission([1, 1, 1], i, 1)[2], 1);
    }
  });
  it('glass: transmission falls with the 1/cos^0.579 path term', () => {
    close(glassTransmission([0, 0, 0], 10, 0.5)[0], (1 - 0.156) ** (1 / 0.5 ** 0.579));
    expect(glassTransmission([0, 0, 0], 5, 0.4)[0]).toBeLessThan(glassTransmission([0, 0, 0], 5, 0.9)[0]);
  });
  it('glass: Schlick Fresnel with F0 0.04 adds the sky reflection', () => {
    close(fresnel(1), 0.04, 1e-9); close(fresnel(0), 1, 1e-9);
    const sky: Rgb = [0.401, 0.484, 1.223];
    const c = glassColor([1, 1, 1], 10, 1, [0, 0, 0], sky);
    close(c[2], 0.04 * 1.223, 1e-9);
    const over = glassColor([1, 1, 1], 0, 1, [0.2, 0.2, 0.2], [0, 0, 0]);
    close(over[0], 0.2 * 0.96, 1e-9);
  });
  it('translucent opacity reproduces the fit and is linear in intensity', () => {
    close(translucentOpacity(0), 0.897); close(translucentOpacity(5), 0.495); close(translucentOpacity(10), 0.096);
    close(lerp3(TRANSLUCENT_OPACITY, 7.5), (0.495 + 0.096) / 2);
  });
  it('translucent: alpha blend of lit plastic over the background', () => {
    const K: Rgb = [5, 3, 2], floor: Rgb = [0.1, 0.1, 0.1], bg: Rgb = [0.2, 0.2, 0.2];
    const c = translucentColor([1, 0, 0], 10, bg, K, floor);
    close(c[0], 0.2 * (1 - 0.096) + 0.096 * (5 + 0.1 * 0.939), 1e-6);
    close(c[1], 0.2 * (1 - 0.096) + 0.096 * 0.1 * 0.939, 1e-6);
  });
  it('glow ladder: 1, 13.77, 47.2 at 0 / 5 / 10, log-linear between', () => {
    close(glowLevel(0), 1, 1e-9); close(glowLevel(5), 13.77, 1e-9); close(glowLevel(10), 47.2, 1e-9);
    close(glowLevel(2.5), Math.sqrt(13.77), 1e-9);
    for (let i = 1; i <= 10; i++) expect(glowLevel(i)).toBeGreaterThan(glowLevel(i - 1));
  });
  it('glow is unlit emission proportional to albedo; black never glows', () => {
    const w = glowColor([1, 1, 1], 0), g = glowColor([0.25, 0.25, 0.25], 0);
    close(w[0], 3.1, 1e-9); close(g[0] / w[0], 0.25, 1e-9);
    expect(glowColor([0, 0, 0], 10)).toEqual([0, 0, 0]);
  });
  it('bloom kernel: three normalised Gaussians, small total weight', () => {
    const total = GLOW_BLOOM.reduce((s, b) => s + b.weight, 0);
    close(total, 0.01483, 1e-4);
    expect(GLOW_BLOOM.map((b) => b.sigma)).toEqual([0.00751, 0.0373, 0.0952]);
  });
  it('GLSL chunk carries the same numbers', () => {
    expect(MATERIALS_GLSL).toContain(`vec3(${GLASS_TINT.join(', ')})`);
    expect(MATERIALS_GLSL).toContain(`vec3(${TRANSLUCENT_OPACITY.join(', ')})`);
    expect(MATERIALS_GLSL).toContain('vec3(1.0, 13.77, 47.2)');
    expect(GLOW_LADDER[0]).toBe(1);
    expect(MATERIALS_GLSL).toMatch(/GLASS_PATH_EXP = 0\.579;/);
  });
});

describe('metallic (export batch 2 captures)', () => {
  it('intensity 0 is a pure sky-tinted mirror; the lit-plastic share grows to 0.44 at 10', async () => {
    const m = await import('../../src/render/materials.ts');
    close(m.metalRough(0), 0, 1e-12); close(m.metalRough(10), 0.44, 1e-12);
    close(m.metalRough(5), 0.44 * 0.5 ** 2.6, 1e-12);
    for (let i = 1; i <= 10; i++) expect(m.metalRough(i)).toBeGreaterThan(m.metalRough(i - 1));
    const sky: Rgb = [0.4, 0.5, 1.2], K: Rgb = [5, 3, 3];
    const up = m.metalColor([1, 0, 0], 0, 1, sky, K);
    close(up[0], 2.35 * 0.4, 1e-9); close(up[1], 0, 1e-12);
    const down = m.metalColor([1, 1, 1], 0, -1, sky, K);
    close(down[2], 2.35 * 0.35 * 1.2, 1e-9);
    const rough = m.metalColor([1, 1, 1], 10, 1, sky, K);
    close(rough[0], 2.35 * 0.4 + 0.44 * 5, 1e-9);
  });
  it('the sky weight is a smooth step around the horizon', async () => {
    const m = await import('../../src/render/materials.ts');
    close(m.metalSkyWeight(-1), 0, 1e-12); close(m.metalSkyWeight(0), 0.5, 1e-12); close(m.metalSkyWeight(1), 1, 1e-12);
  });
});

describe('hologram (animated, two scrolling stripe layers)', () => {
  it('opacity and brightness rise with intensity', async () => {
    const m = await import('../../src/render/materials.ts');
    close(m.holoOpacity(0), 0.15); close(m.holoOpacity(5), 0.36); close(m.holoOpacity(10), 0.48);
    close(m.holoLevel(0), 0.066); close(m.holoLevel(10), 0.611);
    for (let i = 1; i <= 10; i++) { expect(m.holoOpacity(i)).toBeGreaterThan(m.holoOpacity(i - 1)); expect(m.holoLevel(i)).toBeGreaterThan(m.holoLevel(i - 1)); }
  });
  it('the pattern takes only the levels 1, 2 and 3, with the measured duty', async () => {
    const m = await import('../../src/render/materials.ts');
    const n = [0, 0, 0, 0];
    for (let z = 0; z < 20000; z += 0.5) n[m.holoPattern(z, 0)]! += 1;
    expect(n[0]).toBe(0);
    const tot = n[1]! + n[2]! + n[3]!;
    // each layer is on about a third / a quarter of the time (measured 0.33 and 0.27)
    close(n[1]! / tot, (1 - 0.33) * (1 - 0.27), 0.04);
    close(n[3]! / tot, 0.33 * 0.27, 0.03);
    close(m.HOLO_PATTERN_MEAN, 1 + 0.33 + 0.27, 1e-9);
  });
  it('layer 1 scrolls up at 4.5 units/s and layer 2 down at 9.3 units/s', async () => {
    const m = await import('../../src/render/materials.ts');
    const [L1, L2] = m.HOLO_LAYERS;
    for (const z of [0, 3.3, 17, 101.5]) {
      expect(m.holoStripe(z - L1!.speed * 2, L1!.cell, L1!.duty, L1!.seed)).toBe(m.holoStripe(z - 9, L1!.cell, L1!.duty, L1!.seed));
      expect(m.holoStripe(z - L2!.speed * 1, L2!.cell, L2!.duty, L2!.seed)).toBe(m.holoStripe(z + 9.3, L2!.cell, L2!.duty, L2!.seed));
    }
    expect(L1!.speed).toBeGreaterThan(0); expect(L2!.speed).toBeLessThan(0);
  });
  it('colour: background seen through, plus albedo-tinted emission', async () => {
    const m = await import('../../src/render/materials.ts');
    const c = m.holoColor([1, 0, 0], 10, 5, 0, [0.2, 0.2, 0.2]);
    const p = m.holoPattern(5, 0);
    close(c[0], 0.2 * 0.52 + 3.1 * 0.611 * p, 1e-9);
    close(c[1], 0.2 * 0.52, 1e-9);
    expect(m.holoColor([0, 0, 0], 10, 5, 0, [0, 0, 0])).toEqual([0, 0, 0]);
  });
  it('GLSL chunk carries the metallic and hologram numbers', async () => {
    const m = await import('../../src/render/materials.ts');
    expect(m.MATERIALS_GLSL).toContain('vec3 metalColor(');
    expect(m.MATERIALS_GLSL).toContain('float holoPattern(float z, float t)');
    expect(m.MATERIALS_GLSL).toContain(`vec3(${m.HOLO_OPACITY.join(', ')})`);
    expect(m.MATERIALS_GLSL).toContain('(-9.3)*t');
  });
});
