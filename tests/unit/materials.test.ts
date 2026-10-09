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
