// Which special material a brick is drawn with (render/matpass.ts). Metallic and hologram are not
// calibrated yet and stay plastic.

import type { Brick } from '../scene/brick.ts';

export const MAT_GLASS = 1, MAT_TRANSLUCENT = 2, MAT_GLOW = 3;
const CODES: Record<string, number> = { BMC_Glass: MAT_GLASS, BMC_TranslucentPlastic: MAT_TRANSLUCENT, BMC_Glow: MAT_GLOW };

/** 0 = plastic (the normal path), else MAT_GLASS / MAT_TRANSLUCENT / MAT_GLOW. */
export const matCode = (b: Pick<Brick, 'material'>): number => (b.material ? CODES[b.material] ?? 0 : 0);
