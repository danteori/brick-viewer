import { describe, expect, it } from 'vitest';
import { pushAll, minOf, maxOf } from '../../src/core/math';

// Regression: spreading huge arrays into calls (push(...a), Math.min(...a)) threw
// "Maximum call stack size exceeded" when loading builds with hundreds of thousands of bricks.
describe('large-array helpers', () => {
  const N = 2_000_000;
  const big = Array.from({ length: N }, (_, i) => ({ v: (i * 7919) % N }));
  it('pushAll copies millions of items without a stack overflow', () => {
    const dst: { v: number }[] = [];
    pushAll(dst, big);
    expect(dst.length).toBe(N);
  });
  it('minOf / maxOf scan millions of items', () => {
    expect(minOf(big, (b) => b.v)).toBe(0);
    expect(maxOf(big, (b) => b.v)).toBe(N - 1);
    expect(minOf([], (b: { v: number }) => b.v)).toBe(Infinity);
  });
});
