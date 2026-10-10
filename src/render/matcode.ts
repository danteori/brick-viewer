// Which special material a brick is drawn with (render/matpass.ts).

import type { Brick } from '../scene/brick.ts';

export const MAT_GLASS = 1, MAT_TRANSLUCENT = 2, MAT_GLOW = 3, MAT_METALLIC = 4, MAT_HOLOGRAM = 5;
const CODES: Record<string, number> = {
  BMC_Glass: MAT_GLASS, BMC_TranslucentPlastic: MAT_TRANSLUCENT, BMC_Glow: MAT_GLOW, BMC_Metallic: MAT_METALLIC, BMC_Hologram: MAT_HOLOGRAM,
};

/** 0 = plastic (the normal path), else one of the MAT_* codes. */
export const matCode = (b: Pick<Brick, 'material'>): number => (b.material ? CODES[b.material] ?? 0 : 0);
