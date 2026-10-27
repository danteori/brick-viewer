// The hidden-brick ghost (backlog E-21), measured from the user's game screenshots: the brick's own
// lit colour, see-through and a little whitened, lighter diagonal stripes that scroll slowly, and a
// thin bright edge. The stripes run in the face's plane in world units (their period grows on screen
// as the brick comes nearer), down from upper left to lower right on a side face, and move down-left.

export const HIDDEN_LOOK = {
  /** opacity of the face */
  alpha: 0.6,
  /** how far the colour is mixed toward white */
  whiten: 0.15,
  /** how much more the light stripes are mixed toward white */
  stripe: 0.12,
  /** stripe period along each face axis, units (light and dark half each) */
  period: 12,
  /** scroll speed, periods per second */
  speed: 0.5,
  /** edge outline grey (display) and opacity */
  edge: 0.75, edgeAlpha: 0.9,
  /** edge outline width, device pixels */
  edgePx: 2,
};

/** The stripe phase at face coordinates (u right, v up; units) and time t (seconds): light stripe when fract < 0.25 or > 0.75. */
export const hiddenPhase = (u: number, v: number, t: number): number => (u + v) / HIDDEN_LOOK.period + HIDDEN_LOOK.speed * t;

/** 1 on a light stripe, 0 on a dark one (the shader's pattern without its anti-aliasing). */
export function hiddenStripe(u: number, v: number, t: number): number {
  const p = hiddenPhase(u, v, t), f = p - Math.floor(p);
  return Math.abs(f - 0.5) > 0.25 ? 1 : 0;
}

const L = HIDDEN_LOOK, glf = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** GLSL: the ghost's colour and opacity from the lit display colour, world position (units), face normal (world) and time. */
export const HIDDEN_GLSL = `
const float HID_ALPHA = ${glf(L.alpha)}, HID_WHITEN = ${glf(L.whiten)}, HID_STRIPE = ${glf(L.stripe)};
const float HID_PERIOD = ${glf(L.period)}, HID_SPEED = ${glf(L.speed)};
const float HID_EDGE = ${glf(L.edge)}, HID_EDGE_ALPHA = ${glf(L.edgeAlpha)}, HID_EDGE_PX = ${glf(L.edgePx)};
vec4 hiddenGhost(vec3 base, vec3 pW, vec3 nW, float edgeDist, float t){
  vec3 r = abs(nW.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), nW));
  vec3 up = cross(nW, r);
  float s = (dot(pW, r) + dot(pW, up)) / HID_PERIOD + HID_SPEED * t;
  float fw = max(fwidth(s), 1e-4);
  float light = smoothstep(0.25 - fw, 0.25 + fw, abs(fract(s) - 0.5));
  vec3 c = mix(base, vec3(1.0), HID_WHITEN + HID_STRIPE * light);
  float px = edgeDist / max(fwidth(edgeDist), 1e-6);
  float edge = 1.0 - smoothstep(HID_EDGE_PX - 0.5, HID_EDGE_PX + 0.5, px);
  return vec4(mix(c, vec3(HID_EDGE), edge), mix(HID_ALPHA, HID_EDGE_ALPHA, edge));
}`;
