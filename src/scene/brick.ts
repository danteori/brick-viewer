// The editor's brick record and the rules derived from it: top style, shader flags, size grids,
// ramp directions.
//
// A brick is {lo, hi} box faces [X, Y, Z] in absolute viewer units plus its type fields. The scene
// itself is the SoA SceneStore (scene/store.ts); a Brick is what the editor, the panels and the
// clipboard read from a row and write back (scene/view.ts brickView / writeBrick).

import { BrickShapes } from '../render/meshes/shapes.js';
import { BRICK, BRZ_UNIT, MICROB, PLATE, STEP } from '../core/units.ts';

export type V3 = [number, number, number];
export type TopStyle = 'studs' | 'plain' | 'smooth';
export type ShapeKind = 'ramp' | 'crest' | 'crestEnd' | 'round' | 'special' | 'micro';

export interface Brick {
  lo: V3;
  hi: V3;
  micro: boolean;
  /** display sRGB 0..1 */
  color: number[];
  /** +1 studs up, -1 upside down, 0 sideways */
  up: number;
  /** legacy smooth-tile flag; top wins when set */
  tile?: boolean;
  top?: TopStyle;
  material?: string;
  shape?: ShapeKind;
  /** ramps / crests: world axis of the run (0 = X, 1 = Y) */
  run?: number;
  /** ramps: which way along the run the lip is */
  lip?: number;
  /** crest ends: which way along the width the closed end is */
  closed?: number;
  /** rounds: the B_* asset */
  round?: string;
  /** special / micro shapes: the procedural asset */
  asset?: string;
  /** orientation byte (special / micro shapes, sideways rounds) */
  o?: number;
  /** sideways bricks: the stud axis code (+-2 world X, +-3 world Y) */
  side?: number;
  /** material intensity, the save's A byte (0-10; 5 = the game's default) */
  intensity?: number;
  /** save fields the viewer doesn't use, kept so "Save .brz" writes them back */
  save?: SaveExtras;
  /** the save grid this brick is in (unset = the main static grid, '1'); only same-grid bricks collide */
  grid?: string;
}

/**
 * Owner and flag fields of a loaded brick, passed through to the writer, and its place in the save
 * as loaded: `seq` is its index in load order (chunk by chunk, as in the chunk files). Saving writes
 * loaded bricks back in that order, so components and wires, which name bricks by their index in a
 * chunk, still point at the same bricks. A copy (paste) has no seq: it's a new brick.
 */
export interface SaveExtras { owner?: number; originalOwner?: number; flags?: Record<string, number>; seq?: number }

/**
 * A stud brick has a 3-way top style: studs, plain (PB_DefaultTile: flat top with the edge bevel)
 * or smooth (no top texture and no top bevel). b.tile stays as "smooth tile" for older readers.
 */
export const topStyle = (b: Brick): TopStyle => b.top || (b.tile ? 'smooth' : 'studs');

/**
 * The stud axis (the shader's iFlags.z) is the way the brick's local +Z points: +1 / -1 upright /
 * upside down, and for sideways bricks b.side = +-2 (world +-X) or +-3 (world +-Y).
 */
export const studAxis = (b: Brick): number => (b.up ? b.up : (b.side || 1));

/** [studs, stud underside, stud axis, smooth top] for the shader. */
export function brickFlags(b: Brick): [number, number, number, number] {
  const s = b.micro ? 0 : 1, top = topStyle(b);
  return [top !== 'studs' ? 0 : s, s, studAxis(b), top === 'smooth' && !b.micro ? 1 : 0];
}

/** The stud-axis code of an orientation byte's local +Z: world Z -> +-1, X -> +-2, Y -> +-3. */
export function sideCode(o: number): number {
  const M = BrickShapes.brickOrient(o), z = [M[0][2], M[1][2], M[2][2]], a = z.findIndex((c) => c);
  return z[a] * [2, 3, 1][a];
}

/** The orientation byte after a quarter turn about world Z, (x, y) -> (-y, x) (the editor's R). */
export function turnOrient(o: number): number {
  const M = BrickShapes.brickOrient(o), T = [M[1].map((c) => -c), M[0].slice(), M[2].slice()];
  for (let k = 0; k < 24; k++) {
    const N = BrickShapes.brickOrient(k);
    if (N.every((r, i) => r.every((c, j) => c === T[i][j]))) return k;
  }
  return o;
}

/** Local half-extents (Brickadia units) of a brick at orientation o whose world size is size (viewer units). */
export function localHalf(o: number, size: readonly number[]): V3 {
  const M = BrickShapes.brickOrient(o), w = size.map((v) => v / 2 / BRZ_UNIT);
  return [0, 1, 2].map((j) => Math.round((Math.abs(M[0][j]) * w[0] + Math.abs(M[1][j]) * w[1] + Math.abs(M[2][j]) * w[2]) * 1000) / 1000) as V3;
}

/**
 * Ramp slope direction for an upright / upside-down orientation byte. Local X is the run, the lip
 * (low end) is at local +X. Direction 4 rot 0/1/2/3 puts the lip at +X / +Y / -X / -Y; direction 5
 * is drawn as a vertical mirror, so even rotations also flip the lip along X.
 */
export function rampDir(o: number): { run: number; lip: number } {
  const dir = o >> 2, rot = o & 3;
  return { run: rot & 1, lip: (rot < 2 ? 1 : -1) * (dir === 5 && !(rot & 1) ? -1 : 1) };
}

// --- Size grids. Each brick type resizes on its own grid, per axis in the brick's LOCAL frame (full
// sizes in Brickadia units: step, minimum, fixed axes). sizeRule(b) turns it into world axes with
// the orientation byte. Plain stud bricks step in studs, with plates along the stud axis; microbricks
// and the micro family in micros; B_* rounds are fixed.
interface LocalRule { step: number[]; min: number[]; fix: number[] }
export interface SizeRule { steps: V3; min: V3; fix: [boolean, boolean, boolean] }

export const SIZE_RULES: Record<string, LocalRule> = (() => {
  const R = (step: number[], min: number[], fix?: number[]): LocalRule => ({ step, min, fix: fix || [0, 0, 0] });
  const wedge = R([10, 10, 4], [10, 10, 4]), corner = R([10, 10, 4], [20, 20, 4]), arch = R([10, 10, 2], [10, 30, 8]);
  const t: Record<string, LocalRule> = {
    PB_DefaultWedge: wedge, PB_DefaultSideWedge: wedge, PB_DefaultSideWedgeTile: wedge,
    PB_DefaultStudded: R([10, 10, 10], [10, 10, 10]),
    PB_DefaultArch: arch, PB_DefaultArchInverted: arch,
    PB_DefaultRamp: R([10, 10, 4], [20, 10, 4]), PB_DefaultRampInverted: R([10, 10, 4], [20, 10, 4]),
    PB_DefaultRampCorner: corner, PB_DefaultRampCornerInverted: corner,
    PB_DefaultRampInnerCorner: corner, PB_DefaultRampInnerCornerInverted: corner,
    PB_DefaultRampCrestCorner: wedge, PB_DefaultRampCrest: wedge, PB_DefaultRampCrestEnd: wedge,
    PB_RoundedCap: wedge,
    BP_RoundPlate: R([2, 2, 4], [20, 20, 4], [0, 0, 1]), BP_SquarePlate: R([2, 2, 4], [20, 20, 4], [0, 0, 1]),
    BP_SpikePlate: R([10, 10, 4], [10, 10, 4], [0, 0, 1]),
    BP_LatticeThin: R([10, 10, 2], [10, 10, 2], [0, 0, 1]),
    PB_PicketFence: R([10, 10, 24], [20, 10, 24], [0, 1, 1]),
    PB_Spike: R([10, 10, 4], [10, 10, 12]),
    PB_Baguette: R([10, 10, 6], [20, 10, 6], [0, 1, 1]),
    PB_AerodynamicSurface: R([10, 10, 2], [10, 10, 2], [0, 0, 1]),
    PB_AerodynamicSurfaceVertical: R([10, 10, 4], [10, 10, 8]),
    // the stretched fixed designs (sizes seen in saves; the in-game steps are a guess, UX_ASSUMPTIONS C-01)
    PB_Frog: R([2, 2, 2], [2, 2, 2]),
    BP_ZoneProjector: R([2, 2, 4], [10, 10, 4], [0, 0, 1]),
    PB_SliderJoint: R([2, 10, 2], [10, 10, 2], [0, 1, 1]), PB_RigidSliderJoint: R([2, 10, 2], [10, 10, 2], [0, 1, 1]),
    PB_MotorSliderJoint: R([2, 10, 2], [10, 10, 2], [0, 1, 1]), PB_ServoSliderJoint: R([2, 10, 2], [10, 10, 2], [0, 1, 1]),
  };
  for (const a of Object.keys(BrickShapes.MICRO_TYPES)) t[a] = R([2, 2, 2], [2, 2, 2]);
  return t;
})();

const NO_FIX: [boolean, boolean, boolean] = [false, false, false];

export function sizeRule(b: Brick | null | undefined): SizeRule {
  if (!b) return { steps: BRICK.steps.slice() as V3, min: [1, 1, 1], fix: NO_FIX };
  if (fixedSize(b)) return { steps: [STEP, STEP, PLATE], min: [1, 1, 1], fix: [true, true, true] };
  if (b.shape === 'special' || b.shape === 'micro') {
    const R = SIZE_RULES[b.asset!] || (b.shape === 'micro' ? SIZE_RULES.PB_DefaultMicroWedge : SIZE_RULES.PB_DefaultWedge);
    const M = BrickShapes.brickOrient(b.o ?? 16), r = { steps: [] as number[], min: [] as number[], fix: [] as boolean[] };
    for (let i = 0; i < 3; i++) {
      const j = [0, 1, 2].find((j) => M[i][j])!;
      r.steps[i] = +(R.step[j] * BRZ_UNIT).toFixed(4); r.min[i] = Math.max(1, Math.round(R.min[j] / R.step[j])); r.fix[i] = !!R.fix[j];
    }
    return r as unknown as SizeRule;
  }
  if (b.micro) return { steps: MICROB.steps.slice() as V3, min: [1, 1, 1], fix: NO_FIX };
  const steps: V3 = [STEP, STEP, STEP], min: V3 = [1, 1, 1];
  steps[b.up ? 2 : Math.abs(b.side || 1) === 2 ? 0 : 1] = PLATE;      // plates along the stud axis
  if (b.shape === 'ramp') min[b.run!] = 2;              // a ramp's run is at least 2 studs (crest + slope)
  return { steps, min, fix: NO_FIX };
}

/** rounds / cones are fixed meshes: no resize handles, no typed sizes, no type switch */
export const fixedSize = (b: Brick | null | undefined): boolean => b?.shape === 'round' || (b?.shape === 'special' && !!b.asset && isFixedAsset(b.asset));

/** Logic-gate assets: B_1x1_Gate_*, B_1x1_EntityGate_*, and the older B_1x1_AND_Gate style names. */
const GATE_ASSET = /^B_1x1_(?:Entity)?Gate_\w+$|^B_1x1_[A-Z]+_Gate$/;
/**
 * A fixed-mesh B_* brick (decor, food, chess, gadgets, joints, logic gates; not the rounds): no size
 * in the save, its box comes from the generator (shapes.js FIXED_SHAPES, hand-built approximations).
 * A gate the generator doesn't list (older or newer gate names) gets the common 1x1f gate plate,
 * added to FIXED_SHAPES under its own name the first time it's asked for.
 */
export function isFixedAsset(asset: string): boolean {
  const F = BrickShapes.FIXED_SHAPES;
  if (Object.prototype.hasOwnProperty.call(F, asset)) return true;
  if (!GATE_ASSET.test(asset)) return false;
  F[asset] = F.B_1x1_Gate_Expr_LogicalAND!;
  return true;
}
/** the export-measured shapes keep their type: no Brick / Tile / Microbrick switch */
export const lockedType = (b: Brick | null | undefined): boolean => fixedSize(b) || b?.shape === 'special' || b?.shape === 'micro';

/** A ramp, crest or round is its own type; picking a mode turns it into that plain kind. */
export const brickType = (b: Brick): string =>
  b.shape ? b.shape : b.micro ? 'micro' : ({ smooth: 'tile', plain: 'plain' } as Record<string, string>)[topStyle(b)] || 'brick';

/** Deep copy of a brick's data. */
export const cloneBrick = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
