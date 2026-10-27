import { describe, expect, it } from 'vitest';
import { resizeIso, snapYaw, type Angles } from '../../src/render/iso.ts';
import { ELEV, YAW0 } from '../../src/app/state.ts';
import { viewOf } from '../../src/core/math.ts';

const DEG = Math.PI / 180, Q = Math.PI / 2;
const close = (a: number, b: number): void => expect(a).toBeCloseTo(b, 9);

/** The near face of axis i, by the rule of updateNear in render/camera.ts: +1 high face, -1 low face. */
function nearSign(a: Angles, i: number): number {
  const m = viewOf(a.yaw, a.pitch);
  return (i === 0 ? m[2]! : i === 1 ? m[10]! : m[6]!) >= 0 ? 1 : -1;
}

/** On-screen length of a world axis at these angles (view-plane units per world unit). */
function screenLength(a: Angles, i: number): number {
  const m = viewOf(a.yaw, a.pitch);
  return i === 0 ? Math.hypot(m[0]!, m[1]!) : i === 1 ? Math.hypot(m[8]!, m[9]!) : Math.hypot(m[4]!, m[5]!);
}

describe('resize iso angle', () => {
  it('glides to the nearest corner above the horizon', () => {
    const t = resizeIso({ yaw: YAW0 + 50 * DEG, pitch: 60 * DEG });
    close(t.yaw, YAW0 + Q); close(t.pitch, ELEV);
    const u = resizeIso({ yaw: YAW0 - 20 * DEG, pitch: 10 * DEG });
    close(u.yaw, YAW0); close(u.pitch, ELEV);
  });

  it('glides to the nearest corner below the horizon when the camera is below it', () => {
    const t = resizeIso({ yaw: YAW0 + 10 * DEG, pitch: -15 * DEG });
    close(t.yaw, YAW0); close(t.pitch, -ELEV);
    const z = resizeIso({ yaw: YAW0 + 80 * DEG, pitch: -70 * DEG });
    close(z.yaw, YAW0 + Q); close(z.pitch, -ELEV);
  });

  it('keeps the height axis near face: the top from above, the bottom from below', () => {
    expect(nearSign(resizeIso({ yaw: YAW0, pitch: 5 * DEG }), 2)).toBe(1);
    expect(nearSign(resizeIso({ yaw: YAW0, pitch: -5 * DEG }), 2)).toBe(-1);
  });

  for (const pitch of [70 * DEG, 30 * DEG, 2 * DEG, -2 * DEG, -30 * DEG, -70 * DEG]) {
    for (const axis of [0, 1, 2]) {
      it(`keeps axis ${axis} on its near face and readable at pitch ${Math.round(pitch / DEG)}`, () => {
        for (let d = -180; d < 180; d += 3) {
          const from = { yaw: YAW0 + d * DEG + 0.5 * DEG, pitch }, t = resizeIso(from);
          expect(nearSign(t, axis)).toBe(nearSign(from, axis));
          close(t.pitch, pitch < 0 ? -ELEV : ELEV);
          close(snapYaw(t.yaw), t.yaw);
          expect(Math.abs(t.yaw - from.yaw)).toBeLessThanOrEqual(Q / 2 + 1e-9);
          expect(screenLength(t, axis)).toBeGreaterThan(0.8);
        }
      });
    }
  }

  it('stays within an eighth turn of the current yaw after many turns', () => {
    const t = resizeIso({ yaw: YAW0 + 4 * Math.PI + 10 * DEG, pitch: ELEV });
    close(t.yaw, YAW0 + 4 * Math.PI);
  });
});
