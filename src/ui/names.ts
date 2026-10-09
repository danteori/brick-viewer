// Brick names and size labels (placeholders: the game's own names aren't checked everywhere).
//
// Bricks: LxW, then the height in bricks + plates ("2x2", "1x6f", "2x2x0+2f", "2x2 Cube").
// Smooth tiles add " Smooth Tile", plain tiles " Tile"; microbricks are "10x10x4 Microbrick";
// ramps "2x1 Ramp"; the export-measured shapes "2x1 Wedge", "Micro Wedge 4x6x8".

import { S } from '../app/state.ts';
import { BRZ_UNIT, MICRO, PLATE, STEP } from '../core/units.ts';
import { BrickShapes } from '../render/meshes/shapes.js';
import { sizeRule, topStyle, type Brick } from '../scene/brick.ts';

/** what one grid step along axis i is: 'plate' (bricks + plates labels), 'stud', 'micro' or 'unit' */
export const stepKind = (i: number): string => {
  const s = S.STEPS[i];
  return Math.abs(s - PLATE) < 1e-6 && !S.micro ? 'plate' : Math.abs(s - STEP) < 1e-6 ? 'stud'
    : Math.abs(s - MICRO) < 1e-6 ? 'micro' : 'unit';
};

/** Brickadia-style height label: whole bricks, then leftover plates as "f": 3 -> "1", 5 -> "1+2f", 2 -> "2f". */
export function fmtUnits(i: number, n: number): string {
  if (stepKind(i) !== 'plate') return `${n}`;
  const b = Math.floor(n / 3), r = n % 3;
  return r === 0 ? `${b}` : b === 0 ? `${r}f` : `${b}+${r}f`;
}

/** typed size -> units; a plate axis accepts "2" (bricks), "2f" (plates), "1+2f" or "1+2" */
export function parseUnits(i: number, s: string): number {
  if (stepKind(i) !== 'plate') return parseInt(s, 10);
  const m = /^(?:(\d+)\+)?(\d+)(f?)$/i.exec(s.trim());
  if (!m) return NaN;
  const a = +(m[1] || 0), b = +m[2];
  return m[3] || m[1] ? a * 3 + b : b * 3;
}

export const ROUND_NAMES: Record<string, string> = {
  B_1x1F_Round: '1x1f Round', B_1x1_Round: '1x1 Round', B_1x1_Cone: '1x1 Cone', B_2x2F_Round: '2x2f Round',
  B_2x2_Round: '2x2 Round', B_2x2_Cone: '2x2 Cone', B_4x4_Round: '4x4 Round',
};

/** Height is left off when it's 1 micro. */
const microName = (L: number, W: number, H: number): string => (H === 1 ? `${L}x${W} Microbrick` : `${L}x${W}x${H} Microbrick`);

export function brickName(L: number, W: number, p: number, cube = true): string {
  if (cube && L === W && 2 * p === 5 * L) return `${L}x${W} Cube`;
  const base = `${L}x${W}`;
  if (p === 3) return base;
  if (p === 1) return base + 'f';
  const b = Math.floor(p / 3), r = p % 3;
  return r ? `${base}x${b}+${r}f` : `${base}x${b}`;
}

/** full local sizes in Brickadia units from world grid-step counts n (sizeRule steps) */
export function localSizes(b: Brick, n: number[]): number[] {
  const st = sizeRule(b).steps, w = n.map((k, i) => Math.round(k * st[i] / BRZ_UNIT * 1000) / 1000);
  if (b.o != null && (b.shape === 'special' || b.shape === 'micro')) {
    const M = BrickShapes.brickOrient(b.o);
    return [0, 1, 2].map((j) => w[[0, 1, 2].find((i) => M[i][j])!]);
  }
  if (!b.up && b.side) return Math.abs(b.side) === 2 ? [w[1], w[2], w[0]] : [w[0], w[2], w[1]];   // sideways box: local Z = the stud axis
  return w;
}

export const SHAPE_NAMES: Record<string, string> = {
  PB_DefaultWedge: 'Wedge', PB_DefaultSideWedge: 'Side Wedge', PB_DefaultSideWedgeTile: 'Side Wedge Tile',
  PB_DefaultArch: 'Arch', PB_DefaultArchInverted: 'Inverted Arch',
  PB_DefaultRamp: 'Ramp', PB_DefaultRampInverted: 'Inverted Ramp', PB_DefaultRampCorner: 'Ramp Corner',
  PB_DefaultRampCornerInverted: 'Inverted Ramp Corner', PB_DefaultRampInnerCorner: 'Ramp Inner Corner',
  PB_DefaultRampInnerCornerInverted: 'Inverted Ramp Inner Corner', PB_DefaultRampCrestCorner: 'Ramp Crest Corner',
  PB_DefaultRampCrest: 'Ramp Crest', PB_DefaultRampCrestEnd: 'Ramp Crest End',
  PB_DefaultStudded: 'Studded Brick', PB_RoundedCap: 'Rounded Cap',
  BP_RoundPlate: 'Round Plate', BP_SquarePlate: 'Square Plate', BP_SpikePlate: 'Spike Plate', BP_LatticeThin: 'Thin Lattice',
  PB_PicketFence: 'Picket Fence', PB_Spike: 'Spike', PB_Baguette: 'Baguette',
  PB_AerodynamicSurface: 'Aerodynamic Surface', PB_AerodynamicSurfaceVertical: 'Vertical Aerodynamic Surface',
  PB_DefaultMicroBrick: 'Microbrick', PB_DefaultMicroWedge: 'Micro Wedge', PB_DefaultMicroRamp: 'Micro Ramp',
  PB_DefaultMicroWedgeCorner: 'Micro Wedge Corner', PB_DefaultMicroWedgeInnerCorner: 'Micro Wedge Inner Corner',
  PB_DefaultMicroWedgeOuterCorner: 'Micro Wedge Outer Corner', PB_DefaultMicroWedgeTriangleCorner: 'Micro Wedge Triangle Corner',
  PB_DefaultMicroWedgeHalfInnerCorner: 'Micro Wedge Half Inner Corner', PB_DefaultMicroWedgeHalfInnerCornerInverted: 'Micro Wedge Half Inner Corner Inverted',
  PB_DefaultMicroWedgeHalfOuterCorner: 'Micro Wedge Half Outer Corner', PB_DefaultMicroRoundHalf: 'Micro Half Round',
  PB_DefaultMicroRoundCorner: 'Micro Quarter Round', PB_DefaultPole: 'Micro Pole',
};
export const shapeLabel = (a: string | undefined): string =>
  SHAPE_NAMES[a!] || String(a).replace(/^(PB|BP|B)_(Default)?/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
const FLAT_TYPES = new Set(['BP_RoundPlate', 'BP_SquarePlate', 'BP_SpikePlate', 'BP_LatticeThin', 'PB_PicketFence', 'PB_Baguette', 'PB_AerodynamicSurface']);

function shapeName(b: Brick, s: number[]): string {
  const num = (v: number): number => +v.toFixed(2), label = shapeLabel(b.asset);
  if (b.shape === 'micro') return `${label} ${num(s[0] / 2)}x${num(s[1] / 2)}x${num(s[2] / 2)}`;
  const L = num(s[0] / 10), W = num(s[1] / 10), p = s[2] / 4;
  if (FLAT_TYPES.has(b.asset!)) return `${L}x${W} ${label}`;
  return `${Number.isInteger(p) ? brickName(L, W, p, false) : `${L}x${W}x${num(s[2])}u`} ${label}`;
}

/** Name for any brick from its world grid-step counts. */
export function displayName(b: Brick, L: number, W: number, H: number): string {
  if (b.shape === 'special' || b.shape === 'micro') return shapeName(b, localSizes(b, [L, W, H]));
  if (b.shape === 'ramp') return (b.run === 1 ? brickName(W, L, H) : brickName(L, W, H)) + ' Ramp';
  if (b.shape === 'crest' || b.shape === 'crestEnd') return (b.run === 1 ? brickName(W, L, H) : brickName(L, W, H)) + (b.shape === 'crest' ? ' Ramp Crest' : ' Ramp Crest End');
  if (b.shape === 'round') return ROUND_NAMES[b.round!] || b.round!;
  if (!b.micro && !b.up && b.side) { const s = localSizes(b, [L, W, H]); L = s[0] / 10; W = s[1] / 10; H = s[2] / 4; }   // sideways: by its own axes
  return b.micro ? microName(L, W, H) : brickName(L, W, H) + (({ smooth: ' Smooth Tile', plain: ' Tile' } as Record<string, string>)[topStyle(b)] || '');
}
