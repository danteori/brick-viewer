import { describe, expect, it } from 'vitest';
import { roomHides, sliceHides, type Room } from '../../src/render/xraymodes.ts';
import { findRoom } from '../../src/scene/room.ts';
import { PLATE, STEP } from '../../src/core/units.ts';

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] => [x0 * STEP, y0 * STEP, z0 * PLATE, x1 * STEP, y1 * STEP, z1 * PLATE];

describe('height slice', () => {
  it('hides a brick whose centre is above the level, from over', () => {
    expect(sliceHides(1, 1, [0, 0, 1.2], [1, 1, 1.4])).toBe(true);
    expect(sliceHides(1, 1, [0, 0, 0.5], [1, 1, 0.7])).toBe(false);
    expect(sliceHides(1, 1, [0, 0, 0.8], [1, 1, 1.2])).toBe(false);
  });
  it('mirrors from underneath', () => {
    expect(sliceHides(1, -1, [0, 0, 0.5], [1, 1, 0.7])).toBe(true);
    expect(sliceHides(1, -1, [0, 0, 1.2], [1, 1, 1.4])).toBe(false);
  });
});

describe('room fill rule', () => {
  const room: Room = { lo: [0, 0, 0], hi: [10, 10, 3], t: [1, 1, 1, 1] };
  const e = [1, 0, 0.5];
  it('hides the roof over the room and the bricks above it', () => {
    expect(roomHides(room, e, [2, 2, 3], [4, 4, 3.5])).toBe(true);
    expect(roomHides(room, e, [2, 2, 6], [4, 4, 6.5])).toBe(true);
    expect(roomHides(room, e, [20, 2, 3], [22, 4, 3.5])).toBe(false);
  });
  it('hides the wall on the camera side only', () => {
    expect(roomHides(room, e, [10, 2, 0], [11, 6, 3])).toBe(true);
    expect(roomHides(room, e, [-1, 2, 0], [0, 6, 3])).toBe(false);
    expect(roomHides(room, [-1, 0, 0.5], [-1, 2, 0], [0, 6, 3])).toBe(true);
    expect(roomHides(room, e, [2, 10, 0], [6, 11, 3])).toBe(false);
    expect(roomHides(room, [0, 1, 0.5], [2, 10, 0], [6, 11, 3])).toBe(true);
  });
  it('keeps the floor, furniture inside the room and walls beyond the wall band', () => {
    expect(roomHides(room, e, [0, 0, -0.3], [11, 10, 0])).toBe(false);
    expect(roomHides(room, e, [8, 4, 0], [10, 6, 1])).toBe(false);
    expect(roomHides(room, e, [12.5, 2, 0], [13, 6, 3])).toBe(false);
  });
});

describe('room finder', () => {
  const house = (door: boolean): number[][] => {
    const parts = [box(0, 0, 0, 24, 24, 1), box(0, 0, 1, 24, 1, 21), box(0, 23, 1, 24, 24, 21), box(0, 1, 1, 1, 23, 21), box(23, 1, 1, 24, 23, 21), box(0, 0, 21, 24, 24, 22)];
    if (door) {
      parts.splice(4, 1, box(23, 1, 1, 24, 8, 21), box(23, 12, 1, 24, 23, 21), box(23, 8, 17, 24, 12, 21));
    }
    return parts;
  };
  const flat = (parts: number[][]): number[] => parts.flat();
  const focus = box(10, 10, 1, 12, 12, 4);

  it('finds the free box between floor, walls and roof, and the wall thickness', () => {
    const r = findRoom(flat([...house(false), focus]), focus.slice(0, 3), focus.slice(3));
    expect(r).not.toBeNull();
    expect(r!.lo[0]).toBeCloseTo(1 * STEP); expect(r!.hi[0]).toBeCloseTo(23 * STEP);
    expect(r!.lo[1]).toBeCloseTo(1 * STEP); expect(r!.hi[1]).toBeCloseTo(23 * STEP);
    expect(r!.lo[2]).toBeCloseTo(1 * PLATE); expect(r!.hi[2]).toBeCloseTo(21 * PLATE);
    expect(r!.t[0]).toBeCloseTo(STEP);
  });
  it('closes a door narrower than the closing radius', () => {
    const r = findRoom(flat([...house(true), focus]), focus.slice(0, 3), focus.slice(3));
    expect(r).not.toBeNull();
    expect(r!.hi[0]).toBeCloseTo(23 * STEP);
  });
  it('finds nothing outdoors', () => {
    const f = box(2, 2, 1, 4, 4, 4);
    expect(findRoom(flat([box(0, 0, 0, 200, 200, 1), f]), f.slice(0, 3), f.slice(3))).toBeNull();
  });
});
