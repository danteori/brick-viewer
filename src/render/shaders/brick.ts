// The brick shader (GLSL ES 3.00): every body, the grid, the washes and the ghosts. Ported from
// the legacy viewer's WebGL1 shader with core instancing; the shading maths is unchanged. Today's
// forward pipeline: the tone map runs in this shader (TONEMAP_IN_SHADER in ARCHITECTURE.md 3.3).

import { SHADE } from '../../core/units.ts';
import { TONEMAP_GLSL } from './tonemap.ts';
import { MATERIALS_GLSL } from '../materials.ts';
import { CUT_GLSL } from '../cutaway.ts';

/** a GLSL float literal */
export const glf = (v: number): string => { const s = String(+v); return /[.e]/.test(s) ? s : s + '.0'; };

export const BRICK_VS = `#version 300 es
in vec3 aPos; in vec3 aNrm;
in float aSlope;
// Shape meshes only (BrickShapes.PART codes and cap coords); 0 elsewhere.
in float aPart; in vec4 aCap;
out float vPart; out vec4 vCap;
// Per-brick data, in GL axes (x = X, y = Z up, z = Y). In the instanced draws these are per-instance
// arrays; for single draws (focused brick, glow, ghost, grid) the arrays are off and they're
// constants set with vertexAttrib.
in vec3 iCenter; in vec3 iScale;
in vec3 iColor;
// studs (0/1), stud underside (0/1), stud axis, smooth tile top (0/1). The stud axis is the side the
// studs face, in GL axes: +1 / -1 = up / down (GL y), +2 / -2 = +X / -X (GL x), +3 / -3 = +Y / -Y (GL z).
in vec4 iFlags;
uniform mat4 uMVP;
uniform vec3 uShift;
uniform float uStudFade;
uniform float uBevelMax;
uniform float uBevelFit;
out vec3 vN; out vec3 vW; out vec3 vL; out float vSlope;
out vec3 vHalf; out vec3 vBase; out vec4 vFlags; out vec3 vBevel;
out vec2 vBevelK;
// Bevel band width for a face L viewer units long along an axis:
// W(L) = 0.43 / (0.957 + 0.86 / L) Brickadia units, which is uBevelMax at L = 20 units.
float bevelW(float L){ return uBevelMax / (0.957 + 0.86 / max(L / 0.02, 0.5)); }
void main(){
  vN = aNrm; vSlope = aSlope;
  vPart = aPart; vCap = aCap;
  vec3 p = aPos * iScale + (iCenter - uShift);
  vW = p;
  vL = aPos * iScale;
  vHalf = iScale * 0.5;
  vec3 fixedW = vec3(min(uBevelMax, 0.4*min(vHalf.x, min(vHalf.y, vHalf.z))));
  vBevel = mix(fixedW, vec3(bevelW(iScale.x), bevelW(iScale.y), bevelW(iScale.z)), uBevelFit);
  vBevelK = vec2(uBevelMax, uBevelFit);
  vBase = iColor;
  vFlags = vec4(iFlags.x*uStudFade, iFlags.y*uStudFade, iFlags.z, iFlags.w);
  gl_Position = uMVP * vec4(p, 1.0);
}`;

export const BRICK_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; in vec3 vL; uniform float uEdge;
in vec3 vBase;
uniform vec4 uLine; uniform vec3 uFadeC; uniform float uFadeR;
in vec3 vHalf; in vec3 vBevel;
// vFlags: x = stud strength (0 = none), y = underside texture strength (0 = none: microbricks),
// z = the stud axis (see iFlags), w = 1 smooth tile (the stud face has no texture and no bevel)
in vec4 vFlags;
out vec4 fragColor;
const float PITCH = 0.2, TOP = ${glf(SHADE.TOP)}, SLOPE = ${glf(SHADE.SLOPE)};
const float ROUND = ${glf(SHADE.ROUND)};
const float BEVEL_EDGE = ${glf(SHADE.BEVEL_EDGE)};
uniform vec3 uEye;
uniform vec3 uLight;
in float vSlope;
uniform float uBump;
const float BUMPS = ${glf(SHADE.BUMPS)};
const float RIM = ${glf(SHADE.RIM)};
const float SKEL = ${glf(SHADE.SKEL)};
const float SOCKET = ${glf(SHADE.SOCKET)}, SOCKET_T = ${glf(SHADE.SOCKET_T)};
// how much light reaches each recessed part (multiplies all lighting, in linear, before the tone curve)
const float VOID = 0.18, SKEL_SHADE = 0.62, SOCKET_HOLE = 0.1;
const float VIGNETTE = 0.25;
const float RECESS_SHADE = VOID;
// sun (x N.L), sky (ambient) and the floor (added, not x albedo)
uniform vec3 uSun, uSky, uFloor;
uniform float uExposure;
// Special materials (src/render/materials.ts, wired in render/matpass.ts): 0 plastic (the path above
// everything else uses), 1 glass, 2 translucent plastic, 3 glow. uMatPass: glass 0 = the multiply
// pass, 1 = the reflection add pass; 2 = linear emission for the bloom buffer.
uniform float uMat, uIntensity, uMatPass;
// specular anti-aliasing (U-10): normal-variance threshold and glint fade strength
uniform float uStudFade;
const float SPEC_AA_T = ${glf(SHADE.SPEC_AA_T)}, SPEC_AA_K = ${glf(SHADE.SPEC_AA_K)}, SPEC_AA_CAP = ${glf(SHADE.SPEC_AA_CAP)};
${CUT_GLSL}${TONEMAP_GLSL}
${MATERIALS_GLSL}
float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0); return mix(b, a, h) - k*h*(1.0-h); }
// Stud surface height (in stud widths) at cell coord c (-0.5..0.5): flat top, sloped sides, a
// valley at the cell border, with every crease slightly rounded.
float studHeight(vec2 c){
  vec2 e = 0.5 - abs(c);
  e = sqrt(e*e + ROUND*ROUND*0.25);
  float m = smin(e.x, e.y, ROUND);
  return -SLOPE * -smin(-(0.5 - TOP*0.5 - m), 0.0, ROUND);
}
// Ramp slope texture: cellular (Worley) pebbles plus a little value noise.
float hash2(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p), u = f*f*(3.0 - 2.0*f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
float worley(vec2 p){
  vec2 i = floor(p), f = fract(p); float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y)), o = vec2(hash2(i + g), hash2(i + g + 31.7));
    d = min(d, length(g + o*0.8 + 0.1 - f));
  }
  return d;
}
float bumpHeight(vec2 p){ float w = worley(p); return (1.0 - w*w)*0.75 + vnoise(p*0.6)*0.25; }
// vPart is a BrickShapes.PART code: 0 plain (the box logic), 1 round top cap, 2 round bottom,
// 3 curved side, 4 ramp slope, 5 plain top, 6 the round's ledge ring, 7 FACET, 8 STUDS, 9 INLET,
// 10 RECESS. vCap on rounds = (u, v, R, n); on the other shape meshes the face's own rectangle
// (u0, v0, u1, v1) in unit-box coords, or zeros for a slanted face.
in float vPart; in vec4 vCap;
in vec2 vBevelK;
const float ROUND_RIM = 0.06;
const float SOCKET_CH = ${glf(SHADE.SOCKET_CH)};
float bevelWf(float L){ return vBevelK.x / (0.957 + 0.86 / max(L / 0.02, 0.5)); }
void faceFrame(vec3 nG, out vec3 eA, out vec3 eU, out vec3 eV){
  vec3 a = abs(nG);
  if (a.x >= a.y && a.x >= a.z) { eA = vec3(1.0, 0.0, 0.0); eU = vec3(0.0, 1.0, 0.0); eV = vec3(0.0, 0.0, 1.0); }
  else if (a.y >= a.z) { eA = vec3(0.0, 1.0, 0.0); eU = vec3(1.0, 0.0, 0.0); eV = vec3(0.0, 0.0, 1.0); }
  else { eA = vec3(0.0, 0.0, 1.0); eU = vec3(1.0, 0.0, 0.0); eV = vec3(0.0, 1.0, 0.0); }
}
vec3 axisDir(float code){
  float a = abs(code), s = code < 0.0 ? -1.0 : 1.0;
  return s * (a < 1.5 ? vec3(0.0, 1.0, 0.0) : a < 2.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0));
}
vec3 studNormal(vec2 c, float s, vec3 eA, float sA, vec3 eU, vec3 eV){
  const float E = 0.002;
  float gx = (studHeight(c + vec2(E, 0.0)) - studHeight(c - vec2(E, 0.0))) / (2.0*E);
  float gz = (studHeight(c + vec2(0.0, E)) - studHeight(c - vec2(0.0, E))) / (2.0*E);
  return normalize(eA*sA - (eU*gx + eV*gz)*s);
}
float sockets(vec2 q, vec2 sz, float rim, out vec2 tilt){
  const float AA = 0.012;
  vec2 g = abs(q - floor(q + 0.5));
  vec2 interior = step(0.5, q) * step(0.5, sz - q);
  float skel = max((1.0 - smoothstep(SKEL*0.5 - AA, SKEL*0.5 + AA, g.x)) * interior.x,
                   (1.0 - smoothstep(SKEL*0.5 - AA, SKEL*0.5 + AA, g.y)) * interior.y);
  float m = max(g.x, g.y), has = interior.x * interior.y * step(1.5, min(sz.x, sz.y));
  float ringOut = 1.0 - smoothstep(SOCKET*0.5 - AA, SOCKET*0.5 + AA, m);
  float ringIn  = 1.0 - smoothstep(SOCKET*0.5 - SOCKET_T - AA, SOCKET*0.5 - SOCKET_T + AA, m);
  float socket = (ringOut - ringIn) * has, socketHole = ringIn * has;
  vec2 cc = fract(q) - 0.5;
  float voidLight = VOID * (1.0 - VIGNETTE * dot(cc, cc) * 2.0);
  float s = mix(voidLight, SKEL_SHADE, skel);
  s = mix(s, 1.0, socket); s = mix(s, SOCKET_HOLE, socketHole);
  s = mix(s, 1.0, rim);
  vec2 d2 = q - floor(q + 0.5);
  vec2 outward = abs(d2.x) > abs(d2.y) ? vec2(sign(d2.x), 0.0) : vec2(0.0, sign(d2.y));
  float sOut = smoothstep(SOCKET*0.5 - SOCKET_CH - AA, SOCKET*0.5 - SOCKET_CH + AA, m) * ringOut * has * (1.0 - rim);
  float sIn = (1.0 - smoothstep(SOCKET*0.5 - SOCKET_T + SOCKET_CH - AA, SOCKET*0.5 - SOCKET_T + SOCKET_CH + AA, m)) * socket * (1.0 - rim);
  tilt = outward * sOut - outward * sIn;
  return s;
}
float underside(vec2 q, vec2 sz, out vec2 tilt){
  const float AA = 0.012;
  float e = min(min(q.x, sz.x - q.x), min(q.y, sz.y - q.y));
  float rim = 1.0 - smoothstep(RIM - AA, RIM + AA, e);
  float bw = vBevelK.x / PITCH;
  float rimBevel = smoothstep(RIM - bw - AA, RIM - bw + AA, e) * rim;
  vec2 st;
  float s = sockets(q, sz, rim, st);
  vec2 toIn = vec2(0.0);
  if (e == q.x) toIn = vec2(1.0, 0.0); else if (e == sz.x - q.x) toIn = vec2(-1.0, 0.0);
  else if (e == q.y) toIn = vec2(0.0, 1.0); else toIn = vec2(0.0, -1.0);
  tilt = toIn * rimBevel + st;
  return s;
}
float roundUnderside(vec2 q, vec2 sz, float eCirc, vec2 inward, out vec2 tilt){
  const float AA = 0.012;
  float rim = 1.0 - smoothstep(ROUND_RIM - AA, ROUND_RIM + AA, eCirc);
  float bw = vBevelK.x / PITCH;
  float rimBevel = smoothstep(ROUND_RIM - bw - AA, ROUND_RIM - bw + AA, eCirc) * rim;
  vec2 st;
  float s = sockets(q, sz, rim, st);
  tilt = inward * rimBevel + st;
  return s;
}
void main(){
  if (uEdge > 0.5) {
#ifdef CUT
    if (uCutEdge > 0.5 && cutAway(vW)) discard;   // the hover wash on a brick the cutaway cuts into
#endif
    float a = uLine.a;
    if (uFadeR > 0.0) a *= 1.0 - smoothstep(uFadeR*0.35, uFadeR, length(vW.xz - uFadeC.xz));
    fragColor = vec4(uLine.rgb, a); return;
  }
#ifdef CUT
  if (cutAway(vW)) discard;          // X-ray cutaway (render/cutaway.ts): only in the CUT variant
#endif
  vec3 nG = normalize(vN);
  vec3 n = nG;
  bool slope = vSlope > 0.5;
  if (slope && uBump > 0.0) {
    vec3 an = abs(nG);
    vec3 w = an.z <= an.x && an.z <= an.y ? vec3(0.0, 0.0, 1.0) : an.x <= an.y ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 t = normalize(cross(nG, w));
    w = normalize(cross(t, nG));
    vec2 p = vec2(dot(vL, w)*0.8, dot(vL, t)) * (BUMPS/PITCH);
    const float E = 0.15;
    float gw = bumpHeight(p + vec2(E, 0.0)) - bumpHeight(p - vec2(E, 0.0));
    float gt = bumpHeight(p + vec2(0.0, E)) - bumpHeight(p - vec2(0.0, E));
    n = normalize(n - uBump*(gw*w + gt*t)/(2.0*E));
  }
  float uStuds = vFlags.x, uUnder = vFlags.y, uSmooth = vFlags.w;
  vec3 sd = axisDir(vFlags.z);
  float part = floor(vPart + 0.5);
  bool plain = part == 0.0;
  bool roundTop = part == 1.0, roundBot = part == 2.0, roundSide = part == 3.0, ledge = part == 6.0;
  bool facet = part == 7.0 || part == 5.0, studsPart = part == 8.0, inlet = part == 9.0, recess = part == 10.0;
  vec3 eA, eU, eV;
  faceFrame(nG, eA, eU, eV);
  float sA = dot(nG, eA) < 0.0 ? -1.0 : 1.0;
  bool aligned = abs(dot(nG, eA)) > 0.999;
  vec2 q = vec2(dot(vL, eU), dot(vL, eV));
  vec2 hb = vec2(dot(vHalf, eU), dot(vHalf, eV));
  bool hasRect = !(roundTop || roundBot || ledge) && aligned && vCap.z > vCap.x;
  vec4 rect = hasRect ? vCap * vec4(2.0*hb, 2.0*hb) : vec4(-hb, hb);
  float face = dot(nG, sd);
  bool studTop = !slope && uStuds > 0.0 && ((plain && face > 0.5) || (studsPart && aligned));
  if (studTop) {
    n = studNormal(fract((q - rect.xy) / PITCH) - 0.5, uStuds, eA, sA, eU, eV);
  }
  if (roundTop && uStuds > 0.0) {
    studTop = true;
    n = studNormal(fract(q / PITCH + vCap.w*0.5) - 0.5, uStuds, eA, sA, eU, eV);
  }
  float shade = 1.0;
  if ((roundBot && uUnder > 0.0) || ledge) {
    vec2 qc = q / PITCH;
    float r = length(qc);
    if (roundBot) {
      vec2 tilt;
      float s = roundUnderside(qc + vCap.w*0.5, vec2(vCap.w), vCap.z - r, -qc / max(r, 1e-4), tilt);
      shade = mix(1.0, s, uUnder);
      n = normalize(n + (eU*tilt.x + eV*tilt.y) * uUnder);
    }
    float k = 1.0 - smoothstep(vBevelK.x*0.75, vBevelK.x, (vCap.z - r)*PITCH);
    n = normalize(n + k * (eU*qc.x + eV*qc.y) / max(r, 1e-4));
  }
  bool under = !slope && uUnder > 0.0 && ((plain && face < -0.5) || (inlet && aligned));
  if (under) {
    vec2 tilt;
    float s = underside((q - rect.xy) / PITCH, (rect.zw - rect.xy) / PITCH, tilt);
    shade = mix(1.0, s, uUnder);
    n = normalize(n + (eU*tilt.x + eV*tilt.y) * uUnder);
  }
  if (recess) shade = RECESS_SHADE;
  bool smoothTop = plain && uSmooth > 0.5 && face > 0.5;
  if (!studTop && !smoothTop && !slope && (plain || roundSide || facet || inlet)) {
    if (hasRect) {
      vec2 len = rect.zw - rect.xy;
      vec2 bw = mix(vec2(min(vBevelK.x, 0.2*min(len.x, len.y))), vec2(bevelWf(len.x), bevelWf(len.y)), vBevelK.y);
      vec2 k0 = 1.0 - smoothstep(bw*BEVEL_EDGE, bw, q - rect.xy);
      vec2 k1 = 1.0 - smoothstep(bw*BEVEL_EDGE, bw, rect.zw - q);
      n = normalize(n + eU*(k1.x - k0.x) + eV*(k1.y - k0.y));
    } else {
      vec3 dist = vHalf - abs(vL);
      vec3 own = step(0.5, abs(nG));
      // a curved face (cap w = -(axis + 1)): bevel only at the ends of the axis it runs straight
      // along, never across the curve (U-09; the game's UV strip runs around the curve)
      if (vCap.w < -0.5) { float ax = -vCap.w - 1.0; own = vec3(1.0) - vec3(step(abs(ax), 0.5), step(abs(ax - 1.0), 0.5), step(abs(ax - 2.0), 0.5)); }
      vec3 k = (1.0 - smoothstep(vBevel*BEVEL_EDGE, vBevel, dist)) * (1.0 - own);
      n = normalize(n + k * sign(vL));
    }
  }
  vec3 L = normalize(uLight);
  float d = max(dot(n, L), 0.0);
  float bent = smoothstep(0.0, 0.02, 1.0 - dot(n, nG));
  // Specular anti-aliasing (U-10): where the shading normal changes faster than a pixel (the stud
  // creases, hard bevel chamfers at a distance) one pixel can land on a normal that glints white.
  // Fade the glint by the excess screen-space normal variance |fwidth(n)|^2 over SPEC_AA_T (it only
  // ever dims, never widens, so nothing new lights up), and the stud glint with the stud distance
  // fade. Pixels whose normal varies less than that keep the exact original highlight.
  vec3 dn = fwidth(n);
  float nv = max(dot(dn, dn) - SPEC_AA_T, 0.0), sk = 1.0 / (1.0 + SPEC_AA_K * nv);
  if (studTop) sk *= uStudFade;
  float spec = pow(max(dot(n, normalize(L + uEye)), 0.0), 28.0) * 0.32 * bent * sk;
  if (nv > 0.0) spec = min(spec, SPEC_AA_CAP);     // an aliased pixel's glint can't approach white on dark plastic
  vec3 lit = (toLinear(vBase) * (uSky + uSun*d) + uFloor + spec) * shade;
  if (uMat > 0.5) {
    // Blended in display space over the tone-mapped scene (the forward pipeline has no linear
    // buffer): glass multiplies what is behind by its transmission (approximately display-encoded)
    // and adds the Fresnel sky reflection; translucent plastic alpha-blends its lit surface.
    vec3 albedo = toLinear(vBase);
    if (uMat < 1.5) {
      float c = abs(dot(nG, normalize(uEye)));
      float t = matLerp3(GLASS_TINT, uIntensity);
      vec3 T = pow(1.0 - t + t*albedo, vec3(1.0/pow(max(c, 0.05), GLASS_PATH_EXP)));
      float F = matFresnel(c);
      fragColor = uMatPass < 0.5 ? vec4(pow((1.0 - F)*T, vec3(1.0/2.2)), 1.0) : vec4(ueFilmic(uExposure * F * uSky), 1.0);
    } else if (uMat < 2.5) {
      vec3 surf = (albedo * (uSky + uSun*d) + uFloor*TRANSLUCENT_FLOOR_SCALE) * shade;
      fragColor = vec4(ueFilmic(uExposure * surf), translucentOpacity(uIntensity));
    } else {
      vec3 e = uExposure * glowColor(albedo, uIntensity);
      fragColor = uMatPass > 1.5 ? vec4(e, 1.0) : vec4(ueFilmic(e), 1.0);
    }
    return;
  }
  fragColor = vec4(ueFilmic(uExposure * lit), 1.0);
}`;
