import { describe, expect, it } from 'vitest';
import { viewOf } from '../../src/core/math.ts';
import {
  basisOf, boomLength, castCamera, NEAR, perspMatrix, PLAYER_EXTENT, projectPseudo, rayDirection, slideMove, tanHalf, type Box,
} from '../../src/render/persp.ts';

const wall: Box = [[2, -5, -5], [3, 5, 5]];

describe('camera boom', () => {
  it('stops in front of a blocking box, by the camera pad', () => {
    const len = boomLength([0, 0, 0], [1, 0, 0], 10, 0.1, [wall]);
    expect(len).toBeCloseTo(1.9, 9);
  });
  it('keeps the wanted length when nothing blocks', () => {
    expect(boomLength([0, 0, 0], [-1, 0, 0], 10, 0.1, [wall])).toBe(10);
  });
  it('passes through the brick that holds the root', () => {
    const own: Box = [[-1, -1, -1], [1, 1, 1]];
    expect(boomLength([0, 0, 0], [1, 0, 0], 10, 0.1, [own, wall])).toBeCloseTo(1.9, 9);
  });
  it('never ends inside any box, on a diagonal ray', () => {
    const d = [Math.SQRT1_2, Math.SQRT1_2, 0];
    const len = castCamera([0, 0, 0], d, 50, 0.1, [wall]);
    const p = d.map((v) => v * len);
    expect(p[0]).toBeLessThan(2 - 0.1 + 1e-9);
  });
  it('misses a box beside the ray', () => {
    const side: Box = [[2, 1, -5], [3, 5, 5]];
    expect(castCamera([0, 0, 0], [1, 0, 0], 10, 0.1, [side])).toBe(10);
  });
});

describe('player slide', () => {
  it('stops flush against a wall and keeps the free axis', () => {
    const p = slideMove([0, 0, 0], [3, 0.5, 0], PLAYER_EXTENT, [wall]);
    expect(p[0]).toBeLessThan(2 - PLAYER_EXTENT.hi[0]!);
    expect(p[0]).toBeGreaterThan(2 - PLAYER_EXTENT.hi[0]! - 1e-3);
    expect(p[1]).toBeCloseTo(0.5, 9);
  });
});

describe('perspective projection and picking ray', () => {
  const view = viewOf(0.7, 0.4), t = tanHalf(60), half = 3;
  it('projects the point straight ahead to the screen centre', () => {
    const { f } = basisOf(view);
    const v = projectPseudo(view, [f[0] * 5, f[1] * 5, f[2] * 5], half, t);
    expect(v[0]).toBeCloseTo(0, 5);
    expect(v[1]).toBeCloseTo(0, 5);
  });
  it('the ray through a projected point points at that point', () => {
    const p: [number, number, number] = [3, -2, 1.5];
    const v = projectPseudo(view, p, half, t), d = rayDirection(view, v[0], v[1], half, t);
    const L = Math.hypot(...p);
    for (let i = 0; i < 3; i++) expect(d[i]! * L).toBeCloseTo(p[i]!, 4);
  });
  it('matches the perspective matrix', () => {
    const p: [number, number, number] = [3, -2, 1.5], fx = 1.6, fy = 1;
    const v = projectPseudo(view, p, half, t), P = perspMatrix(fx, fy, t, NEAR, 100);
    const gl = [p[0], p[2], p[1]];
    const e = [0, 1, 2, 3].map((r) => view[r]! * gl[0]! + view[4 + r]! * gl[1]! + view[8 + r]! * gl[2]!);
    const clip = [P[0]! * e[0]!, P[5]! * e[1]!, 0, -e[2]!];
    expect(clip[0]! / clip[3]!).toBeCloseTo(v[0] / (half * fx), 5);
    expect(clip[1]! / clip[3]!).toBeCloseTo(v[1] / (half * fy), 5);
  });
  it('sends points behind the eye far off screen', () => {
    const { f } = basisOf(view);
    const v = projectPseudo(view, [-f[0], -f[1], -f[2]], half, t);
    expect(Math.abs(v[0]) + Math.abs(v[1])).toBeGreaterThan(1e5);
  });
});
