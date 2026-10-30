import { describe, expect, it } from 'vitest';
import { fileMapView } from '../../src/format/saveview.ts';
import { readEntities } from '../../src/format/entities.ts';
import { BALL_RADIUS, WHEEL_HALF_WIDTH, WHEEL_RADIUS, entityProxies, proxyMeshes, sphereMesh, wheelMesh } from '../../src/scene/entityproxies.ts';
import { baseMapGround, standInPlate } from '../../src/env/basemap.ts';
import { defaultEnvironment } from '../../src/format/environment.ts';
import { BALL_LOCATION, WHEEL_LOCATION, WHEEL_ROTATION, gridWorld } from './gridworld.ts';

const proxies = () => entityProxies(readEntities(fileMapView(gridWorld({ proxies: true }))).entities);
const bounds = (data: Float32Array): { lo: number[]; hi: number[] } => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.length; i += 6) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, data[i + k]!); hi[k] = Math.max(hi[k]!, data[i + k]!); }
  return { lo, hi };
};

describe('entity proxies', () => {
  it('lists balls and wheels, not brick grids', () => {
    const list = proxies();
    expect(list.map((p) => [p.id, p.kind, p.scale])).toEqual([[3, 'wheel', 1.5], [4, 'sphere', 2]]);
    expect(list[0]!.centre).toEqual(WHEEL_LOCATION);
    expect(list[1]!.centre).toEqual(BALL_LOCATION);
  });

  it('takes colour slots 0 and 1 from the entity', () => {
    const [wheel, ball] = proxies();
    expect(wheel!.colours[0].map((v) => Math.round(v * 255))).toEqual([20, 20, 20]);
    expect(wheel!.colours[1].map((v) => Math.round(v * 255))).toEqual([200, 40, 40]);
    expect(ball!.colours[0].map((v) => Math.round(v * 255))).toEqual([40, 160, 220]);
  });

  it('reads the colour bytes as linear when the chunk has no flag', () => {
    const [wheel] = entityProxies([{ ...readEntities(fileMapView(gridWorld({ proxies: true }))).entities[1]!, colorsAreLinear: null, colors: [[128, 128, 128, 255], [0, 0, 0, 255]] }]);
    expect(wheel!.colours[0][0]).toBeCloseTo(0.735, 2);
  });

  it('sizes a sphere from Scale', () => {
    const [, ball] = proxies();
    const { body, hub } = proxyMeshes(ball!, 1);
    const { lo, hi } = bounds(body.data);
    expect(hub).toBeNull();
    for (let k = 0; k < 3; k++) { expect(hi[k]).toBeCloseTo(BALL_RADIUS * 2, 0); expect(lo[k]).toBeCloseTo(-hi[k]!, 3); }
  });

  it('puts the wheel axle along the entity Z axis, turned by its rotation', () => {
    const [wheel] = proxies();
    const { lo, hi } = bounds(proxyMeshes(wheel!, 1).body.data);
    const r = WHEEL_RADIUS * 1.5, h = WHEEL_HALF_WIDTH * 1.5;
    // a quarter turn about X sends local Z to world -Y, which is GL Z: the axle runs along GL Z
    expect(WHEEL_ROTATION[0]).toBeCloseTo(Math.SQRT1_2);
    expect(hi[2]).toBeCloseTo(h, 3);
    expect(lo[2]).toBeCloseTo(-h, 3);
    expect(hi[0]).toBeCloseTo(r, 3);
    expect(hi[1]).toBeCloseTo(r, 0);
  });

  it('winds every triangle outward in GL axes', () => {
    for (const m of [sphereMesh(10, [0.3, 0.2, 0.1, 0.9], 1), wheelMesh(12, 5, [0.1, 0.7, 0.2, 0.68], 1)]) {
      const d = m.data;
      for (let t = 0; t < m.count; t += 3) {
        const v = (i: number, k: number): number => d[(t + i) * 6 + k]!;
        const e1 = [0, 1, 2].map((k) => v(1, k) - v(0, k)), e2 = [0, 1, 2].map((k) => v(2, k) - v(0, k));
        const c = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        const n = [0, 1, 2].map((k) => v(0, 3 + k) + v(1, 3 + k) + v(2, 3 + k));
        expect(c[0]! * n[0]! + c[1]! * n[1]! + c[2]! * n[2]!).toBeGreaterThan(0);
      }
    }
  });
});

describe('base map ground (W-12)', () => {
  it('Space has no plate even when the environment has one', () => {
    expect(baseMapGround('Space', defaultEnvironment('Plate'))).toBeNull();
    expect(baseMapGround('Space', null)).toBeNull();
  });
  it('Plate uses the environment plate, else the default plate', () => {
    const own = defaultEnvironment('Plate');
    own.groups.groundPlate!.bUseStudTexture = false;
    expect(baseMapGround('Plate', own)!.studTexture).toBe(false);
    expect(baseMapGround('Plate', null)).not.toBeNull();
  });
  it('Studio and Peaks get the neutral stand-in', () => {
    expect(baseMapGround('Studio', null)).toEqual(standInPlate());
    expect(baseMapGround('Peaks', defaultEnvironment('Plate'))).toEqual(standInPlate());
  });
  it('no kind keeps the environment plate or none', () => {
    expect(baseMapGround(null, null)).toBeNull();
    expect(baseMapGround(null, defaultEnvironment('Plate'))).not.toBeNull();
  });
});
