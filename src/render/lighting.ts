// Lighting presets from the joint fit, through the same pipeline as the game: albedo (sRGB-decoded
// save colour) x (sky + sun x N.L) + floor -> exposure -> Unreal's stock filmic tonemapper. sun / sky
// / floor are RGB, scene-linear. The fit's convention is top-face light K = sun x 0.81 + sky, which is
// this viewer's top-face N.L (the light direction's y). Exposure 0.93 is the fit without the game's
// screen vignette.

import { S, YAW0 } from '../app/state.ts';

export interface LightPreset { name: string; sun: number[]; sky: number[]; floor: number[]; exposure: number }

export const LIGHTING: Record<string, LightPreset> = {
  white:     { name: 'Neutral white sky', sun: [4.972, 3.932, 3.865], sky: [1.100, 1.135, 1.279], floor: [0.176, 0.126, 0.128], exposure: 0.93 },
  default:   { name: 'Default sky',       sun: [5.771, 3.276, 2.062], sky: [0.401, 0.484, 1.223], floor: [0.110, 0.076, 0.072], exposure: 0.93 },
  afternoon: { name: 'Afternoon',         sun: [6.728, 3.782, 2.408], sky: [0.000, 0.043, 0.253], floor: [0.120, 0.077, 0.054], exposure: 0.93 },
  overcast:  { name: 'Overcast',          sun: [0.000, 0.000, 0.000], sky: [1.793, 1.812, 2.488], floor: [0.063, 0.059, 0.080], exposure: 0.93 },
  night:     { name: 'Night',             sun: [0.078, 0.073, 0.192], sky: [0.044, 0.035, 0.041], floor: [0.002, 0.000, 0.002], exposure: 0.93 },
};

/**
 * The light direction (GL axes). It turns with the camera's yaw, so every corner is lit like the
 * default iso view; from below, the underside is lit instead.
 */
export function lightDir(): [number, number, number] {
  const a = S.orbit.yaw - YAW0, c = Math.cos(a), s = Math.sin(a), L = [0.35, 0.9, 0.55];
  const up = S.orbit.pitch >= 0 ? 1 : -1;
  return [c * L[0] - s * L[2], up * L[1], s * L[0] + c * L[2]];   // Ry(-a) L: undo the view's extra yaw
}
