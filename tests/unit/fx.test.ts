import { describe, expect, it } from 'vitest';
import { atmosphere, skyFogDepth, sunDirection, waterLook } from '../../src/render/fx/atmos.ts';
import { fitShadow, lightBasis, mul4 } from '../../src/render/fx/shadows.ts';
import { invert4 } from '../../src/render/fx/frame.ts';
import { viewOf } from '../../src/core/math.ts';
import { defaultEnvironment, DEFAULT_SKY, DEFAULT_WATER, setEnvValue } from '../../src/format/environment.ts';
import { environmentToLighting } from '../../src/env/lighting.ts';
import { adaptTick, fx, fxEffective } from '../../src/render/fx/state.ts';

const close = (a: number, b: number, e = 1e-6): void => { expect(Math.abs(a - b)).toBeLessThan(e); };

describe('sun direction', () => {
  it('rises at 6h, stands overhead at noon, sets at 18h on the other side', () => {
    const r = sunDirection(6.0001, 0), n = sunDirection(12, 0), s = sunDirection(17.9999, 0);
    close(r.dir[1], 0, 1e-3); close(n.dir[1], 1); close(s.dir[1], 0, 1e-3);
    close(r.dir[0], -s.dir[0], 1e-3);
    expect(n.night).toBe(false);
  });
  it('is the moon at 45 degrees at night', () => {
    const m = sunDirection(0, 300);
    expect(m.night).toBe(true);
    close(m.dir[1], Math.SQRT1_2);
  });
});

describe('atmosphere', () => {
  it('keeps the calibrated top-face light with a world-fixed sun', () => {
    const env = defaultEnvironment('Plate'), L = environmentToLighting(env);
    const a = atmosphere(L, 'env', env);
    for (let i = 0; i < 3; i++) close(a.sun[i]! * a.sunDir[1], L.sun[i]! * 0.81, 1e-4);
  });
  it('fog density follows the UE convention (per 1000 units) and clear weather', () => {
    const a = atmosphere({ sun: [1, 1, 1], sky: [1, 1, 1], floor: [0, 0, 0], exposure: 1 }, 'default', null);
    const clear = DEFAULT_SKY.clearFogDensity / 1000, cloudy = DEFAULT_SKY.cloudyFogDensity / 1000;
    expect(a.fogDensity).toBeGreaterThan(clear);
    expect(a.fogDensity).toBeLessThan(clear + (cloudy - clear) * DEFAULT_SKY.cloudCoverage);   // below the cloud window's middle
    expect(skyFogDepth(a, 0, 1)).toBeGreaterThan(skyFogDepth(a, 1000, 1));
    expect(a.water).toBeNull();
  });
  it('water only above 0, with extinction from absorption + scattering', () => {
    const L = environmentToLighting(defaultEnvironment('Plate'));
    expect(waterLook(DEFAULT_WATER, L, DEFAULT_SKY)).toBeNull();
    const w = waterLook({ ...DEFAULT_WATER, waterHeight: 100 }, L, DEFAULT_SKY)!;
    close(w.extinction[0], DEFAULT_WATER.waterAbsorption.x + DEFAULT_WATER.waterScattering.x, 1e-9);
    const env = setEnvValue(defaultEnvironment('Plate'), 'water', 'waterHeight', 100);
    expect(atmosphere(L, 'env', env).water?.height).toBe(100);
  });
});

describe('shadow fit', () => {
  const L = sunDirection(9.6, 300).dir;
  const scene = [-5, 0, -5, 5, 4, 5];
  it('builds an orthonormal light basis', () => {
    const [x, y, z] = lightBasis(L);
    close(x[0] * y[0] + x[1] * y[1] + x[2] * y[2], 0); close(x[0] * z[0] + x[1] * z[1] + x[2] * z[2], 0);
  });
  it('keeps texels fixed in the world while the camera orbits (snapped centre, stepped size)', () => {
    const fits = [-0.785, -0.7, -0.6].map((yaw) => fitShadow(L, viewOf(yaw, 0.6), { x0: -20, x1: 20, y0: -12, y1: 12, depth: 60 }, scene, 0, 2048)!);
    for (const f of fits) {
      const cx = (f.cull.x0 + f.cull.x1) / 2 / f.texel, cy = (f.cull.y0 + f.cull.y1) / 2 / f.texel;
      close(cx, Math.round(cx), 1e-6); close(cy, Math.round(cy), 1e-6);
      expect(Math.log2(f.texel * 2048) * 2 % 1).toBeCloseTo(0, 6);       // side is a power of sqrt 2
    }
  });
  it('maps every scene corner into the map, depth inside [0, 1]', () => {
    const f = fitShadow(L, viewOf(-0.785, 0.6), { x0: -20, x1: 20, y0: -12, y1: 12, depth: 60 }, scene, 0, 2048)!;
    for (let c = 0; c < 8; c++) {
      const p = [c & 1 ? 5 : -5, c & 2 ? 4 : 0, c & 4 ? 5 : -5, 1];
      const t = mul4(f.tex, [p[0]!, p[1]!, p[2]!, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      for (const v of [t[0]!, t[1]!, t[2]!]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    }
  });
  it('is null for an empty scene', () => {
    expect(fitShadow(L, viewOf(0, 0.6), { x0: -1, x1: 1, y0: -1, y1: 1, depth: 60 }, [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], 0, 1024)).toBeNull();
  });
});

describe('helpers and governor', () => {
  it('inverts a 4x4', () => {
    const m = mul4(viewOf(0.3, 0.5), [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, -0.1, 0, 1, 2, 0, 1]);
    const i = invert4(m)!, id = mul4(m, i);
    for (let k = 0; k < 16; k++) close(id[k]!, k % 5 === 0 ? 1 : 0, 1e-5);
  });
  it('steps effects down when slow and back up when fast', () => {
    fx.want = { ...fx.want, on: true, adaptive: true, shadows: 3, ssao: 3 }; fx.supported = true; fx.drop = 0;
    let t = 1000;
    for (let i = 0; i < 80; i++) adaptTick((t += 60), false);       // ~16 fps
    expect(fx.drop).toBeGreaterThan(0);
    expect(fxEffective().ssao).toBeLessThan(3);
    for (let i = 0; i < 2000 && fx.drop > 0; i++) adaptTick((t += 10), false);
    expect(fx.drop).toBe(0);
    fx.want = { ...fx.want, on: false }; adaptTick((t += 10), false);
  });
});
