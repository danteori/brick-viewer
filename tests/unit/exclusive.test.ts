import { describe, expect, it } from 'vitest';
import { exclusive } from '../../src/core/exclusive.ts';

describe('exclusive', () => {
  it('refuses a second job until the first one resolves', async () => {
    const started: number[] = [];
    let finish = (): void => {};
    const run = exclusive(async (n: number) => { started.push(n); await new Promise<void>((r) => { finish = r; }); });
    expect(run(1)).toBe(true);
    expect(run(2)).toBe(false);
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(run(3)).toBe(true);
    expect(started).toEqual([1, 3]);
  });

  it('is free again after a job fails', async () => {
    const run = exclusive(async () => { throw new Error('no'); });
    expect(run()).toBe(true);
    await new Promise((r) => setTimeout(r));
    expect(run()).toBe(true);
  });
});
