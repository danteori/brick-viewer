// Viewer units and Brickadia proportions (ported from the legacy viewer).
//
// Viewer units: 1 stud = 0.2. Brickadia units: a stud is 10 wide, a plate 4 tall, a brick 3 plates
// (12), a micro 2. X/Y step in studs, Z in plates; each axis's step is also its minimum size.
// Phase 1 keeps the legacy data model (box faces in viewer units); integer units arrive in Phase 2.

export const STEP = 0.2;
/** Largest size along an axis, viewer units. */
export const MAX = 12;
/** px of drag along a clear axis direction = one step (also the guide's arm length). */
export const THRESH = 34;
/** Angle tolerance when picking an axis from the drag direction. */
export const TOL = 20 * Math.PI / 180;
export const PLATE = STEP * 4 / 10;
/** Microbrick mode: every axis steps in micros (a stud is 5, a plate 2). */
export const MICRO = STEP / 5;
/** Brickadia units -> viewer units (a stud is 10 units). */
export const BRZ_UNIT = STEP / 10;
/**
 * Bevels: a hard 45 degree chamfer band on face edges, 0.43 units on a 20-unit face, narrowing on
 * short faces: W(L) = 0.43 / (0.957 + 0.86/L). BEVEL_FIT = false goes back to one fixed width.
 */
export const BEVEL = STEP * 0.043;
export const BEVEL_FIT = true;

export interface StepSet { steps: [number, number, number]; start: [number, number, number] }
/** 1x1, one brick (3 plates) tall */
export const BRICK: StepSet = { steps: [STEP, STEP, PLATE], start: [STEP / 2, STEP / 2, 3 * PLATE / 2] };
/** 1x1x1 micro */
export const MICROB: StepSet = { steps: [MICRO, MICRO, MICRO], start: [MICRO / 2, MICRO / 2, MICRO / 2] };

/** The default palette's bright red (#FA4040), like the logo brick. */
export const DEFAULT_COLOR: [number, number, number] = [250 / 255, 64 / 255, 64 / 255];
/** Startup brick: a 2x2, one brick tall (half-extents). */
export const INITIAL: [number, number, number] = [STEP, STEP, 3 * PLATE / 2];

export const ACCENT = '#e8590c';

/**
 * Shading constants, put into the fragment shader as it is compiled. One named constant each, so
 * any that looks worse than in-game can be switched back here.
 */
export const SHADE = {
  /** stud flat top, fraction of the cell */
  TOP: 0.5,
  /** stud side slope: 1.0 = 45 degrees */
  SLOPE: 1.0,
  /** stud crease rounding, studs */
  ROUND: 0.01,
  /** the edge bevel tilt fades in over the outer 15% of its band: a hard 45 degree chamfer */
  BEVEL_EDGE: 0.85,
  /** ramp-family slope bumps per stud */
  BUMPS: 28,
  /** slope bump strength */
  BUMP_STRENGTH: 0.25,
  /** underside rim incl. its chamfers */
  RIM: 0.30,
  /** underside rib width */
  SKEL: 0.20,
  /** socket ring outer size / wall */
  SOCKET: 0.60, SOCKET_T: 0.10,
  /** socket wall chamfers */
  SOCKET_CH: 0.02,
  /**
   * Specular anti-aliasing (U-10): a pixel whose screen-space normal variance |fwidth(n)|^2 exceeds
   * SPEC_AA_T has its glint divided by 1 + SPEC_AA_K x the excess, so a stud crease thinner than a
   * pixel can't flash white on one pixel; such a pixel's glint is also capped at SPEC_AA_CAP (linear).
   * Full strength while a stud is under SPEC_AA_PX_LO px on screen, fading out by SPEC_AA_PX_HI px
   * (close-ups are untouched).
   */
  SPEC_AA_T: 0.04, SPEC_AA_K: 25, SPEC_AA_CAP: 0.06, SPEC_AA_PX_LO: 10, SPEC_AA_PX_HI: 18,
};

/** Round to 3 decimals (the legacy viewer's frame-safe rounding). */
export const r3 = (v: number): number => +v.toFixed(3);
