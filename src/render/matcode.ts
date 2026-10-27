// Which special material a brick is drawn with (render/matpass.ts).

import type { Brick } from '../scene/brick.ts';

export const MAT_GLASS = 1, MAT_TRANSLUCENT = 2, MAT_GLOW = 3, MAT_METALLIC = 4, MAT_HOLOGRAM = 5;
/** Not a game material: a hidden (Visible off) brick's ghost, whatever its material (scene/hidden.ts). */
export const MAT_HIDDEN = 6;
export const MAT_CIRCUIT = 7;
/** How many codes there are (plastic included): the length of the per-material count arrays. */
export const MAT_CODES = 8;
const CODES: Record<string, number> = {
  BMC_Glass: MAT_GLASS, BMC_TranslucentPlastic: MAT_TRANSLUCENT, BMC_Glow: MAT_GLOW, BMC_Metallic: MAT_METALLIC, BMC_Hologram: MAT_HOLOGRAM,
  BMC_Circuit: MAT_CIRCUIT,
};

/** 0 = plastic (the normal path), else one of the MAT_* codes. */
export const matCode = (b: Pick<Brick, 'material'>): number => (b.material ? CODES[b.material] ?? 0 : 0);
