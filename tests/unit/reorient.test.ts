import { describe, expect, it } from 'vitest';
import { viewOf } from '../../src/core/math.ts';
import type { Vec3 } from '../../src/core/orient.ts';
import {
  AXIS_DIRS, DRAG_DEAD_ZONE_PX, axisIndex, cameraBasisFromView, dragToWorldDir, reorientTo,
  rotateBy, rotateCW, worldUp, worldX, worldY, type CameraBasis,
} from '../../src/editor/reorient.ts';

const ALL = Array.from({ length: 24 }, (_, o) => o);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const neg = (v: Vec3): Vec3 => [0 - v[0], 0 - v[1], 0 - v[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
const clean = (v: Vec3): Vec3 => v.map((c) => (Math.abs(c) < 1e-6 ? 0 : Math.round(c) + 0)) as Vec3;
/** 2D z of the cross product; < 0 means a -> b turns clockwise on a y-up screen. */
const turn = (a: [number, number], b: [number, number]): number => a[0] * b[1] - a[1] * b[0];
const project = (v: Vec3, b: CameraBasis): [number, number] => [dot(v, b.right), dot(v, b.up)];

/** A unit axis perpendicular to n (used as "screen up" for a camera looking along -n). */
const perp = (n: Vec3): Vec3 => (n[2] !== 0 ? [1, 0, 0] : [0, 0, 1]);

describe('rotateCW', () => {
  it('is rot+1 within the same dir, wrapping, for all 24 orientations', () => {
    for (const o of ALL) {
      const r = rotateCW(o);
      expect(r >> 2).toBe(o >> 2);
      expect(r & 3).toBe(((o & 3) + 1) % 4);
      expect(worldUp(r)).toEqual(worldUp(o));          // turns about the up axis
    }
    for (const o of ALL) expect(rotateCW(rotateCW(rotateCW(rotateCW(o))))).toBe(o);
  });

  it('takes world +X to up x (+X) (component cross product) for all 24', () => {
    for (const o of ALL) expect(worldX(rotateCW(o))).toEqual(clean(cross(worldUp(o), worldX(o))));
  });

  it('looks clockwise from the stud side in the game (left-handed) world, all 24', () => {
    // Unreal top view: screen-up +X, screen-right +Y, looking -Z. In a left-handed world a camera
    // looking along f with screen-up u has screen-right = u x f (components); that reproduces it.
    expect(clean(cross([1, 0, 0], [0, 0, -1]))).toEqual([0, 1, 0]);
    for (const o of ALL) {
      const n = worldUp(o), u = perp(n), basis = { right: cross(u, neg(n)), up: u };
      const a = project(worldX(o), basis), b = project(worldX(rotateCW(o)), basis);
      expect(turn(a, b), `o=${o}`).toBeLessThan(0);
    }
  });

  it('looks clockwise from the stud side through the viewer camera, all 24', () => {
    const views: Float32Array[] = [];
    for (const yaw of [0, 90, 180, 270, -45]) for (const pitch of [0, 90, -90, 35.264]) views.push(viewOf(yaw * Math.PI / 180, pitch * Math.PI / 180));
    for (const o of ALL) {
      const n = worldUp(o);
      // a view whose toward-viewer vector (the view z row in world components) is the stud axis
      const m = views.find((v) => dot([v[2]!, v[10]!, v[6]!], n) > 0.999);
      expect(m, `view for o=${o}`).toBeDefined();
      const basis = cameraBasisFromView(m!);
      const a = project(worldX(o), basis), b = project(worldX(rotateCW(o)), basis);
      expect(turn(a, b), `o=${o}`).toBeLessThan(-0.99);
    }
  });

  it('rotateBy matches repeated rotateCW, both ways', () => {
    for (const o of ALL) {
      expect(rotateBy(o, 1)).toBe(rotateCW(o));
      expect(rotateBy(o, 3)).toBe(rotateCW(rotateCW(rotateCW(o))));
      expect(rotateBy(rotateCW(o), -1)).toBe(o);
      expect(rotateBy(o, -6)).toBe(rotateBy(o, 2));
    }
  });
});

describe('reorientTo', () => {
  it('puts local +Z on the target for every orientation and target', () => {
    for (const o of ALL) for (const d of AXIS_DIRS) {
      const r = reorientTo(o, d);
      expect(worldUp(r)).toEqual(d);
      expect(r >> 2).toBe(axisIndex(d));
    }
  });

  it('keeps the orientation when the target is the current up', () => {
    for (const o of ALL) expect(reorientTo(o, worldUp(o))).toBe(o);
  });

  it('keeps local +X when it stays possible, else local +Y', () => {
    for (const o of ALL) for (const d of AXIS_DIRS) {
      const r = reorientTo(o, d);
      if (dot(worldX(o), d) === 0) expect(worldX(r), `o=${o} d=${d}`).toEqual(worldX(o));
      else expect(worldY(r), `o=${o} d=${d}`).toEqual(worldY(o));
    }
  });

  it('equals tipping the brick 90 deg over the shared edge for every perpendicular target', () => {
    for (const o of ALL) for (const d of AXIS_DIRS) {
      const up = worldUp(o);
      if (dot(up, d) !== 0) continue;
      const k = cross(up, d);                           // Rodrigues, 90 deg about k: R v = k x v + k (k . v)
      const R = (v: Vec3): Vec3 => clean(add(cross(k, v), scale(k, dot(k, v))));
      expect(R(up)).toEqual(d);
      const r = reorientTo(o, d);
      expect(worldX(r), `o=${o} d=${d}`).toEqual(R(worldX(o)));
      expect(worldY(r), `o=${o} d=${d}`).toEqual(R(worldY(o)));
    }
  });

  it('flips about local +X for the opposite direction', () => {
    for (const o of ALL) {
      const r = reorientTo(o, neg(worldUp(o)));
      expect(worldX(r)).toEqual(worldX(o));
      expect(worldY(r)).toEqual(neg(worldY(o)));
    }
  });

  it('rejects non-axis directions', () => {
    expect(() => reorientTo(16, [1, 1, 0])).toThrow();
    expect(() => reorientTo(16, [0, 0, 0])).toThrow();
  });
});

describe('dragToWorldDir', () => {
  const top: CameraBasis = { right: [0, 1, 0], up: [1, 0, 0] };   // the game's top view
  const iso = cameraBasisFromView(viewOf(-45 * Math.PI / 180, 35.264 * Math.PI / 180));

  it('has a dead zone', () => {
    expect(dragToWorldDir([0, 0], top)).toBeNull();
    expect(dragToWorldDir([DRAG_DEAD_ZONE_PX, 0], top)).toBeNull();
    expect(dragToWorldDir([DRAG_DEAD_ZONE_PX * 0.6, -DRAG_DEAD_ZONE_PX * 0.6], top)).toBeNull();
    expect(dragToWorldDir([DRAG_DEAD_ZONE_PX + 1, 0], top)).toEqual([0, 1, 0]);
    expect(dragToWorldDir([5, 0], top, 2)).toEqual([0, 1, 0]);
  });

  it('maps drags to on-screen axes with y-down pixels (top view)', () => {
    expect(dragToWorldDir([40, 0], top)).toEqual([0, 1, 0]);
    expect(dragToWorldDir([-40, 0], top)).toEqual([0, -1, 0]);
    expect(dragToWorldDir([0, -40], top)).toEqual([1, 0, 0]);
    expect(dragToWorldDir([0, 40], top)).toEqual([-1, 0, 0]);
    expect(dragToWorldDir([40, -10], top)).toEqual([0, 1, 0]);
  });

  it('never picks an axis pointing at the camera', () => {
    for (let a = 0; a < 360; a += 5) {
      const r = dragToWorldDir([40 * Math.cos(a * Math.PI / 180), 40 * Math.sin(a * Math.PI / 180)], top)!;
      expect(r[2]).toBe(0);
    }
  });

  it('breaks an exact diagonal tie by AXIS_DIRS order', () => {
    expect(dragToWorldDir([30, -30], top)).toEqual([1, 0, 0]);   // +X vs +Y: +X first
    expect(dragToWorldDir([-30, 30], top)).toEqual([-1, 0, 0]);  // -X vs -Y
  });

  it('dragging along each projected axis picks it, in the isometric view', () => {
    expect(dragToWorldDir([0, -40], iso)).toEqual([0, 0, 1]);
    for (const d of AXIS_DIRS) {
      const [sx, sy] = project(d as Vec3, iso), L = Math.hypot(sx, sy);
      expect(dragToWorldDir([40 * sx / L, -40 * sy / L], iso)).toEqual(d);
    }
  });

  it('every result is a world axis, for every drag angle and orientation-agnostic view', () => {
    for (let a = 0; a < 360; a += 7) {
      const r = dragToWorldDir([50 * Math.cos(a), 50 * Math.sin(a)], iso);
      expect(r && axisIndex(r)).toBeGreaterThanOrEqual(0);
    }
  });

  it('composes with reorientTo for all 24 (drag up in iso sets studs up)', () => {
    for (const o of ALL) expect(worldUp(reorientTo(o, dragToWorldDir([0, -40], iso)!))).toEqual([0, 0, 1]);
  });
});
