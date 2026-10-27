export type XrayMode = 'tube' | 'slice' | 'room' | 'ghost';

export const XRAY_MODES: readonly XrayMode[] = ['tube', 'slice', 'room', 'ghost'];

/** Shader mode numbers, in the order of XRAY_MODES. */
export const modeIndex = (m: XrayMode): number => XRAY_MODES.indexOf(m);

/** The room around the focus: its free box [lo, hi] and the wall thickness beyond each side. */
export interface Room {
  lo: readonly number[];
  hi: readonly number[];
  /** wall thickness beyond +X, -X, +Y, -Y (viewer units) */
  t: readonly [number, number, number, number];
}

/** A brick must pass a face by more than this to count as past it. */
export const MODE_EPS = 1e-3;
/** The view counts as looking along X (or Y) when e has at least this much of it. */
export const WALL_SIDE_MIN = 0.2;

/** Height slice: a brick whose centre is beyond the level (above it from over, below it from under) is hidden. */
export function sliceHides(level: number, side: number, lo: ArrayLike<number>, hi: ArrayLike<number>): boolean {
  return side * ((lo[2]! + hi[2]!) / 2 - level) > MODE_EPS;
}

/**
 * Room fill: a brick is hidden when it is the roof (above the room, over its footprint grown by the
 * wall thickness) or a wall on the camera's side (a brick that reaches into the wall band beyond
 * the room face the camera looks through, from the room's floor up). e = view direction toward the camera.
 */
export function roomHides(r: Room, e: ArrayLike<number>, lo: ArrayLike<number>, hi: ArrayLike<number>): boolean {
  const over = (a: number, c: number, d: number): boolean => hi[a]! > c + MODE_EPS && lo[a]! < d - MODE_EPS;
  const gx0 = r.lo[0]! - r.t[1], gx1 = r.hi[0]! + r.t[0], gy0 = r.lo[1]! - r.t[3], gy1 = r.hi[1]! + r.t[2];
  if (!over(0, gx0, gx1) || !over(1, gy0, gy1)) return false;
  if (lo[2]! >= r.hi[2]! - MODE_EPS) return true;
  if (lo[2]! < r.lo[2]! - MODE_EPS) return false;
  if (e[0]! >= WALL_SIDE_MIN && hi[0]! > r.hi[0]! + MODE_EPS) return true;
  if (e[0]! <= -WALL_SIDE_MIN && lo[0]! < r.lo[0]! - MODE_EPS) return true;
  if (e[1]! >= WALL_SIDE_MIN && hi[1]! > r.hi[1]! + MODE_EPS) return true;
  if (e[1]! <= -WALL_SIDE_MIN && lo[1]! < r.lo[1]! - MODE_EPS) return true;
  return false;
}

/** GLSL for slice and room (GL axes: x = X, y = Z up, z = Y; positions relative to the render origin). */
export const MODES_GLSL = `
uniform vec3 uRoomLo, uRoomHi;
uniform vec4 uRoomT;
bool sliceHides(vec3 c, vec3 h){ return uCutK.w * (c.y - uCutK.z) > ${MODE_EPS}; }
bool roomHides(vec3 c, vec3 h){
  vec3 lo = c - h, hi = c + h;
  float gx0 = uRoomLo.x - uRoomT.y, gx1 = uRoomHi.x + uRoomT.x, gy0 = uRoomLo.z - uRoomT.w, gy1 = uRoomHi.z + uRoomT.z;
  if (!(hi.x > gx0 + ${MODE_EPS} && lo.x < gx1 - ${MODE_EPS} && hi.z > gy0 + ${MODE_EPS} && lo.z < gy1 - ${MODE_EPS})) return false;
  if (lo.y >= uRoomHi.y - ${MODE_EPS}) return true;
  if (lo.y < uRoomLo.y - ${MODE_EPS}) return false;
  if (uEye.x >= ${WALL_SIDE_MIN} && hi.x > uRoomHi.x + ${MODE_EPS}) return true;
  if (uEye.x <= -${WALL_SIDE_MIN} && lo.x < uRoomLo.x - ${MODE_EPS}) return true;
  if (uEye.z >= ${WALL_SIDE_MIN} && hi.z > uRoomHi.z + ${MODE_EPS}) return true;
  if (uEye.z <= -${WALL_SIDE_MIN} && lo.z < uRoomLo.z - ${MODE_EPS}) return true;
  return false;
}
`;
