// The Bricks catalogue: data-driven. size = world [X, Y, Z] in viewer units; brick = the brick-data
// fields; icon = an iconSvg spec. Default sizes: 2x2 for stud bricks and ramps, a 5x5x2 microbrick,
// ramp crests 2x1; the export-measured shapes at a common size from the in-game survey, placed upright.

import { BRZ_UNIT, MICRO, PLATE, STEP } from '../core/units.ts';
import { BrickShapes } from '../render/meshes/shapes.js';
import type { Brick } from '../scene/brick.ts';
import { shapeLabel } from '../ui/names.ts';

export type IconSpec = [string, number?, (number | boolean | string)?];
export interface CatalogueEntry { group: string; label: string; icon: IconSpec; size: number[]; brick: Partial<Brick> }

const U = BRZ_UNIT;
/** Rounds / cones are fixed meshes: footprint n studs, height h units */
const ROUNDS: [string, string, number, number, string][] = [
  ['B_1x1F_Round', '1x1f Round', 1, 4, 'round'], ['B_1x1_Round', '1x1 Round', 1, 12, 'round'], ['B_1x1_Cone', '1x1 Cone', 1, 12, 'cone'],
  ['B_2x2F_Round', '2x2f Round', 2, 4, 'round'], ['B_2x2_Round', '2x2 Round', 2, 12, 'round'], ['B_2x2_Cone', '2x2 Cone', 2, 24, 'cone'],
  ['B_4x4_Round', '4x4 Round', 4, 12, 'round'],
];
/** [group, asset, local half-extents in Brickadia units, icon] */
const SPECIALS: [string, string, number[], IconSpec][] = [
  ['Ramps', 'PB_DefaultRampInverted', [10, 10, 6], ['ramp', 1, 'inv']],
  ['Ramps', 'PB_DefaultRampCorner', [10, 10, 6], ['crestEnd']],
  ['Ramps', 'PB_DefaultRampCornerInverted', [10, 10, 6], ['crestEnd', 1, 'inv']],
  ['Ramps', 'PB_DefaultRampInnerCorner', [10, 10, 6], ['crestEnd']],
  ['Ramps', 'PB_DefaultRampInnerCornerInverted', [10, 10, 6], ['crestEnd', 1, 'inv']],
  ['Ramps', 'PB_DefaultRampCrestCorner', [10, 10, 6], ['crest']],
  ['Wedges and arches', 'PB_DefaultWedge', [10, 5, 6], ['ramp']],
  ['Wedges and arches', 'PB_DefaultSideWedge', [10, 10, 2], ['sidewedge', .35]],
  ['Wedges and arches', 'PB_DefaultSideWedgeTile', [10, 10, 2], ['sidewedge', .35]],
  ['Wedges and arches', 'PB_DefaultArch', [5, 20, 6], ['arch']],
  ['Wedges and arches', 'PB_DefaultArchInverted', [5, 15, 6], ['arch', 1, 'inv']],
  ['Special', 'PB_DefaultStudded', [10, 10, 10], ['box', 1, true]],
  ['Special', 'PB_RoundedCap', [10, 5, 4], ['round', .6, 1]],
  ['Special', 'BP_RoundPlate', [10, 10, 2], ['round', .3, 2]],
  ['Special', 'BP_SquarePlate', [10, 10, 2], ['box', .3]],
  ['Special', 'BP_SpikePlate', [10, 10, 2], ['box', .3]],
  ['Special', 'BP_LatticeThin', [20, 20, 1], ['box', .15]],
  ['Special', 'PB_PicketFence', [20, 5, 12], ['box', 1]],
  ['Special', 'PB_Spike', [5, 5, 12], ['cone', 1, 1]],
  ['Special', 'PB_Baguette', [20, 5, 3], ['round', .4, 1]],
  ['Special', 'PB_AerodynamicSurface', [10, 20, 1], ['box', .15]],
  ['Special', 'PB_AerodynamicSurfaceVertical', [10, 5, 10], ['box', 1]],
  ['Micro', 'PB_DefaultMicroWedge', [5, 5, 5], ['sidewedge', .5]],
  ['Micro', 'PB_DefaultMicroRamp', [5, 5, 5], ['ramp', .5]],
  ['Micro', 'PB_DefaultMicroWedgeCorner', [5, 5, 5], ['crestEnd', .5]],
  ['Micro', 'PB_DefaultMicroWedgeInnerCorner', [5, 5, 5], ['crestEnd', .5]],
  ['Micro', 'PB_DefaultMicroWedgeOuterCorner', [5, 5, 5], ['crestEnd', .5]],
  ['Micro', 'PB_DefaultMicroWedgeTriangleCorner', [5, 5, 5], ['sidewedge', .5]],
  ['Micro', 'PB_DefaultMicroWedgeHalfInnerCorner', [5, 5, 5], ['sidewedge', .5]],
  ['Micro', 'PB_DefaultMicroWedgeHalfInnerCornerInverted', [5, 5, 5], ['sidewedge', .5]],
  ['Micro', 'PB_DefaultMicroWedgeHalfOuterCorner', [5, 5, 5], ['sidewedge', .5]],
  ['Micro', 'PB_DefaultMicroRoundHalf', [5, 5, 5], ['round', .5, 1]],
  ['Micro', 'PB_DefaultMicroRoundCorner', [5, 5, 5], ['round', .5, 1]],
  ['Micro', 'PB_DefaultPole', [2, 2, 10], ['round', 1, .5]],
];

function specialEntry([group, asset, half, icon]: (typeof SPECIALS)[number]): CatalogueEntry {
  const m = BrickShapes.isMicro(asset);
  return { group, label: shapeLabel(asset), icon, size: half.map((v) => 2 * v * U), brick: { shape: m ? 'micro' : 'special', asset, o: 16, ...(m ? { micro: true } : {}) } };
}

export const CATALOGUE: CatalogueEntry[] = [
  { group: 'Basic', label: 'Brick',       icon: ['box', 1, true],   size: [2 * STEP, 2 * STEP, 3 * PLATE], brick: {} },
  { group: 'Basic', label: 'Plate',       icon: ['box', .35, true], size: [2 * STEP, 2 * STEP, PLATE],   brick: {} },
  { group: 'Basic', label: 'Tile',        icon: ['box', .35],       size: [2 * STEP, 2 * STEP, PLATE],   brick: { top: 'plain' } },
  { group: 'Basic', label: 'Smooth Tile', icon: ['box', .35],       size: [2 * STEP, 2 * STEP, PLATE],   brick: { top: 'smooth', tile: true } },
  { group: 'Basic', label: 'Microbrick',  icon: ['box', .5],        size: [5 * MICRO, 5 * MICRO, 2 * MICRO], brick: { micro: true } },
  { group: 'Ramps', label: 'Ramp',        icon: ['ramp'],           size: [2 * STEP, 2 * STEP, 3 * PLATE], brick: { shape: 'ramp', run: 0, lip: 1 } },
  { group: 'Ramps', label: 'Ramp Crest',  icon: ['crest'],          size: [2 * STEP, STEP, 3 * PLATE],   brick: { shape: 'crest', run: 0 } },
  { group: 'Ramps', label: 'Ramp Crest End', icon: ['crestEnd'],    size: [2 * STEP, STEP, 3 * PLATE],   brick: { shape: 'crestEnd', run: 0, closed: -1 } },
  ...SPECIALS.filter((s) => s[0] === 'Ramps').map(specialEntry),
  ...ROUNDS.map(([asset, label, n, h, kind]): CatalogueEntry => ({ group: 'Rounds', label, icon: [kind, h / 12, n], size: [n * STEP, n * STEP, h * U], brick: { shape: 'round', round: asset } })),
  ...SPECIALS.filter((s) => s[0] !== 'Ramps').map(specialEntry),
];

/** Tiny isometric glyphs (22 x 20) for the catalogue; x, y in 0..1 (footprint), z in 0..1 (a brick's height) */
export function iconSvg([kind, h = 1, extra]: IconSpec): string {
  const P = (x: number, y: number, z: number): string => `${(11 + (x - y) * 8).toFixed(1)},${(12 + (x + y) * 4 - z * 9).toFixed(1)}`;
  const poly = (pts: number[][], a: number): string => `<polygon points="${pts.map((p) => P(p[0], p[1], p[2])).join(' ')}" fill="currentColor" fill-opacity="${a}"/>`;
  const m = .15;                              // ramp lip height
  let s: string;
  if (kind === 'box') {
    s = poly([[1, 0, 0], [1, 1, 0], [1, 1, h], [1, 0, h]], .3) + poly([[0, 1, 0], [1, 1, 0], [1, 1, h], [0, 1, h]], .18) + poly([[0, 0, h], [1, 0, h], [1, 1, h], [0, 1, h]], .55);
    if (extra === true) s += `<ellipse cx="11" cy="${(15 - 9 * h).toFixed(1)}" rx="3.2" ry="1.6" fill="currentColor" fill-opacity=".9"/>`;   // studs
  } else if (kind === 'ramp') {
    s = poly([[1, 0, 0], [1, 1, 0], [1, 1, m], [1, 0, m]], .3) + poly([[0, 1, 0], [1, 1, 0], [1, 1, m], [0, 1, 1]], .18) + poly([[0, 0, 1], [1, 0, m], [1, 1, m], [0, 1, 1]], .55);
  } else if (kind === 'crest') {
    s = poly([[0, 0, m], [.5, 0, 1], [.5, 1, 1], [0, 1, m]], .4) + poly([[.5, 0, 1], [1, 0, m], [1, 1, m], [.5, 1, 1]], .55) +
        poly([[1, 0, 0], [1, 1, 0], [1, 1, m], [1, 0, m]], .3) + poly([[0, 1, 0], [1, 1, 0], [1, 1, m], [.5, 1, 1], [0, 1, m]], .18);
  } else if (kind === 'crestEnd') {
    s = poly([[0, 0, m], [.5, .5, 1], [.5, 1, 1], [0, 1, m]], .4) + poly([[1, 0, m], [.5, .5, 1], [.5, 1, 1], [1, 1, m]], .55) +
        poly([[1, 0, 0], [1, 1, 0], [1, 1, m], [1, 0, m]], .3) + poly([[0, 1, 0], [1, 1, 0], [1, 1, m], [.5, 1, 1], [0, 1, m]], .18);
  } else if (kind === 'sidewedge') {          // a triangular prism standing on its right-angle corner
    s = poly([[1, 0, 0], [0, 1, 0], [0, 1, h], [1, 0, h]], .3) + poly([[0, 0, h], [1, 0, h], [0, 1, h]], .55);
  } else if (kind === 'arch') {               // a bridge: two legs and a span
    s = poly([[1, 0, 0], [1, .3, 0], [1, .3, .6], [1, .7, .6], [1, .7, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], .3) + poly([[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], .55);
  } else {                                    // round / cone; extra = footprint in studs
    const ex = typeof extra === 'number' ? extra : 1;
    const r = 4 + 4 * Math.sqrt(Math.min(1, (ex || 1) / 4)), yb = 16, yt = 16 - 9 * Math.min(1, h), rt = kind === 'cone' ? r * .45 : r;
    s = `<path d="M${11 - r},${yb} A${r},${r / 2} 0 0 0 ${11 + r},${yb} L${11 + rt},${yt} L${11 - rt},${yt} Z" fill="currentColor" fill-opacity=".3"/>` +
        `<ellipse cx="11" cy="${yt}" rx="${rt}" ry="${rt / 2}" fill="currentColor" fill-opacity=".6"/>`;
  }
  if (extra === 'inv') s = `<g transform="translate(0 21) scale(1 -1)">${s}</g>`;   // the inverted types: upside down
  return `<svg viewBox="0 0 22 20" aria-hidden="true" stroke="currentColor" stroke-opacity=".75" stroke-width=".8" stroke-linejoin="round">${s}</svg>`;
}
