import { describe, expect, it } from 'vitest';
import { axisName, brickOrient, localSize, upOf, worldHalf, type Vec3 } from '../../src/core/orient.ts';

// [local +X, local +Y, local +Z] in world axes per orientation byte, read off the in-game
// orientation test shots (copied from tools/orient.js).
const T: Record<number, [string, string, string]> = {
  0: ['+Z', '-Y', '+X'], 1: ['-Y', '-Z', '+X'], 2: ['-Z', '+Y', '+X'], 3: ['+Y', '+Z', '+X'],
  4: ['+Z', '+Y', '-X'], 5: ['+Y', '-Z', '-X'], 6: ['-Z', '-Y', '-X'], 7: ['-Y', '+Z', '-X'],
  8: ['+Z', '+X', '+Y'], 9: ['+X', '-Z', '+Y'], 10: ['-Z', '-X', '+Y'], 11: ['-X', '+Z', '+Y'],
  12: ['+Z', '-X', '-Y'], 13: ['-X', '-Z', '-Y'], 14: ['-Z', '+X', '-Y'], 15: ['+X', '+Z', '-Y'],
  16: ['+X', '+Y', '+Z'], 17: ['+Y', '-X', '+Z'], 18: ['-X', '-Y', '+Z'], 19: ['-Y', '+X', '+Z'],
  20: ['-X', '+Y', '-Z'], 21: ['+Y', '+X', '-Z'], 22: ['+X', '-Y', '-Z'], 23: ['-Y', '-X', '-Z'],
};

// The legacy viewer's orient(), verbatim from save-viewer.html (the pixel reference).
function legacyOrient(o: number, s: number[]): { half: number[]; up: number } {
  const dir = o >> 2, rot = o & 3, odd = rot & 1;
  if (dir >= 4) return { half: odd ? [s[1]!, s[0]!, s[2]!] : [s[0]!, s[1]!, s[2]!], up: dir === 4 ? 1 : -1 };
  if (dir <= 1) return { half: odd ? [s[2]!, s[0]!, s[1]!] : [s[2]!, s[1]!, s[0]!], up: 0 };
  return { half: odd ? [s[0]!, s[2]!, s[1]!] : [s[1]!, s[2]!, s[0]!], up: 0 };
}

// tools/brzwriter.js localSize, verbatim (inverse of legacy orient()).
function legacyLocalSize(half: number[], o: number): number[] {
  const dir = o >> 2, odd = o & 1, [x, y, z] = half as [number, number, number];
  if (dir >= 4) return odd ? [y, x, z] : [x, y, z];
  if (dir <= 1) return odd ? [y, z, x] : [z, y, x];
  return odd ? [z, x, y] : [x, z, y];
}

const det = (M: number[][]): number =>
  M[0]![0]! * (M[1]![1]! * M[2]![2]! - M[1]![2]! * M[2]![1]!) -
  M[0]![1]! * (M[1]![0]! * M[2]![2]! - M[1]![2]! * M[2]![0]!) +
  M[0]![2]! * (M[1]![0]! * M[2]![1]! - M[1]![1]! * M[2]![0]!);

const ORIENTS = Array.from({ length: 24 }, (_, o) => o);
const SIZE: Vec3 = [3, 5, 7];   // distinct, so any permutation mistake shows

describe('orientation table', () => {
  it.each(ORIENTS)('byte %i matches the in-game table with det +1', (o) => {
    const M = brickOrient(o);
    const cols = [0, 1, 2].map((j) => axisName([M[0][j]!, M[1][j]!, M[2][j]!]));
    expect(cols).toEqual(T[o]);
    expect(det(M)).toBe(1);
  });

  it('puts the ramp lip (local +X) where the shots show it', () => {
    const lip = (o: number): string => axisName(brickOrient(o).map((r) => r[0]));
    expect(lip(18)).toBe('-X');   // dir 4 rot 2 (known)
    expect(lip(22)).toBe('+X');   // dir 5 rot 2 (side shot looking +Y)
    expect([16, 17, 18, 19].map(lip)).toEqual(['+X', '+Y', '-X', '-Y']);
  });
});

describe('worldHalf / localSize', () => {
  it.each(ORIENTS)('worldHalf equals legacy orient() for byte %i', (o) => {
    expect(worldHalf(o, SIZE)).toEqual(legacyOrient(o, SIZE).half);
    expect(upOf(o)).toBe(legacyOrient(o, SIZE).up);
  });

  it.each(ORIENTS)('localSize inverts worldHalf for byte %i', (o) => {
    expect(localSize(o, worldHalf(o, SIZE))).toEqual(SIZE);
  });

  // tools/brzwriter.js localSize swaps its odd / even cases for dirs 2 and 3 (studs +Y / -Y), so
  // it is not the inverse of the viewer's orient() there. The port fixes that; this pins the finding.
  it.each(ORIENTS)('brzwriter.js localSize agrees except for dirs 2 and 3 (byte %i)', (o) => {
    const h = worldHalf(o, SIZE), dir = o >> 2;
    if (dir === 2 || dir === 3) expect(legacyLocalSize(h, o)).not.toEqual(SIZE);
    else expect(legacyLocalSize(h, o)).toEqual(SIZE);
  });
});
