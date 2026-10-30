import { describe, expect, it } from 'vitest';
import { ALIGN_MODES, alignSteps, distanceAlong, floatPose, lockedPose, nextMode, planePoint, snapTo } from '../../src/editor/align.ts';

const U = 0.02;

describe('alignSteps', () => {
  it('Plate is the old step: a stud across, a plate up', () => {
    expect(alignSteps('plate', false)).toEqual([0.2, 0.2, 0.08]);
  });
  it('Half, Fifth and Tenth cut the stud step', () => {
    expect(alignSteps('half', false)[0]).toBeCloseTo(5 * U);
    expect(alignSteps('fifth', false)[0]).toBeCloseTo(2 * U);
    expect(alignSteps('tenth', false)[0]).toBeCloseTo(1 * U);
  });
  it('Brick steps a whole brick up', () => {
    expect(alignSteps('brick', false)[2]).toBeCloseTo(0.24);
  });
  it('a micro ghost never steps coarser than a micro', () => {
    expect(alignSteps('plate', true)).toEqual([0.04, 0.04, 0.04]);
    expect(alignSteps('brick', true)).toEqual([0.04, 0.04, 0.04]);
    expect(alignSteps('tenth', true)[0]).toBeCloseTo(0.02);
  });
});

describe('nextMode', () => {
  it('cycles through all five and wraps', () => {
    let m = ALIGN_MODES[0]!;
    const seen = [m];
    for (let i = 0; i < 5; i++) { m = nextMode(m); seen.push(m); }
    expect(seen).toEqual(['plate', 'half', 'fifth', 'tenth', 'brick', 'plate']);
  });
});

describe('snapTo', () => {
  it('rounds to the nearest step from the reference', () => {
    expect(snapTo(0.37, 0.1, 0.1)).toBeCloseTo(0.4);
    expect(snapTo(0.12, 0, 0.2)).toBeCloseTo(0.2);
  });
});

describe('plane lock', () => {
  const S = [0, 0, 10], D = [0, 0, -1];
  it('finds where a ray meets a plane', () => {
    expect(planePoint(S, D, 2, 4)).toEqual([0, 0, 4]);
    expect(planePoint(S, [1, 0, 0], 2, 4)).toBeNull();
    expect(planePoint(S, D, 2, 20)).toBeNull();
  });
  it('keeps the locked axis fixed while the cursor moves in the plane', () => {
    const lock = { axis: 2, value: 0.16 };
    const size: [number, number, number] = [0.2, 0.2, 0.08], steps: [number, number, number] = [0.2, 0.2, 0.08];
    const a = lockedPose(lock, [0.31, 0.5, 10], D, size, steps, [0, 0, 0])!;
    const b = lockedPose(lock, [1.9, -0.7, 10], D, size, steps, [0, 0, 0])!;
    expect(a[2]).toBe(0.16);
    expect(b[2]).toBe(0.16);
    expect(a[0]).toBeCloseTo(0.2);
    expect(b[0]).toBeCloseTo(1.8);
  });
  it('locks a wall plane along X', () => {
    const lock = { axis: 0, value: 1 };
    const p = lockedPose(lock, [10, 0.5, 0.3], [-1, 0, 0], [0.2, 0.2, 0.08], [0.2, 0.2, 0.08], [0, 0, 0])!;
    expect(p[0]).toBe(1);
    expect(p[1]).toBeCloseTo(0.4);
  });
});

describe('float placement', () => {
  it('puts the centre at the distance along the ray, snapped', () => {
    const p = floatPose([0, 0, 10], [0, 0, -1], 6, [0.2, 0.2, 0.08], [0.2, 0.2, 0.08]);
    expect(p[2]).toBeCloseTo(4);
  });
  it('measures the distance back from a centre', () => {
    expect(distanceAlong([0, 0, 10], [0, 0, -1], [0, 0, 4])).toBe(6);
  });
});
