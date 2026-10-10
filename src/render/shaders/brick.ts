// The brick shader (GLSL ES 3.00): every body, the grid, the washes and the ghosts. Ported from
// the legacy viewer's WebGL1 shader; the shading maths is unchanged. Today's forward pipeline: the
// tone map runs in this shader (TONEMAP_IN_SHADER in ARCHITECTURE.md 3.3).
//
// Orientation in the shader (ARCHITECTURE.md 3.1): meshes are built in the brick's LOCAL frame (the
// stud side up) and the vertex shader turns them with the orientation byte's matrix, D[dir] * Rz(rot)
// as in core/orient.ts. Shading runs in local space: the light and eye directions are turned into
// the brick's frame once per vertex, so studs, undersides and bevels are one code path for all 24
// orientations. Only the ramp slope's bump noise is evaluated in world axes, as it always was.

import { SHADE } from '../../core/units.ts';
import { TONEMAP_GLSL } from './tonemap.ts';
import { MATERIALS_GLSL } from '../materials.ts';
import { CUT_GLSL } from '../cutaway.ts';

/** a GLSL float literal */
export const glf = (v: number): string => { const s = String(+v); return /[.e]/.test(s) ? s : s + '.0'; };

/** The orientation byte -> rotation (GL axes), shared by both stages: D[dir] * Rz(rot) as core/orient.ts. */
const ORIENT_GLSL = `
const vec3 OX[6] = vec3[6](vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0));
const vec3 OY[6] = vec3[6](vec3(0.0, -1.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0));
const vec3 OZ[6] = vec3[6](vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0), vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0));
// OX / OY / OZ[dir]: where local X, Y, Z point (save axes). The result's columns are where GL local
// x (= local X), y (= local Z, the stud side) and z (= local Y) point, in GL axes (x = X, y = Z, z = Y).
mat3 orientGL(uint o){
  int d = int((o >> 2u) % 6u), r = int(o & 3u);
  vec3 cx = OX[d], cy = OY[d];
  vec3 x = r == 0 ? cx : r == 1 ? cy : r == 2 ? -cx : -cy;
  vec3 y = r == 0 ? cy : r == 1 ? -cx : r == 2 ? -cy : cx;
  return mat3(x.xzy, OZ[d].xzy, y.xzy);
}`;

export const BRICK_VS = `#version 300 es
in vec3 aPos; in vec3 aNrm;
in float aSlope;
// Shape meshes only (BrickShapes.PART codes and cap coords); 0 elsewhere.
in float aPart; in vec4 aCap;
out float vPart; out vec4 vCap;
// The 24-byte instance record (render/instances.ts), save axes (X, Y, Z up), integer units:
//   iPos   centre relative to the draw's chunk (int16), w low 15 bits of the template slot (uPull)
//   iHalf  local half-extents (uint16); w packed: bits 0-4 orientation byte, 5-6 top style
//          (0 studs, 1 plain, 2 smooth), 7 micro (no studs, no underside), 8 linear colour bytes
//   iColor R, G, B as stored, A = material intensity (unorm8)
//   iMisc  face mask, material, template slot bits 15-22 (uPull), flags (bit 0 = selected)
// The instanced draws read them per instance; single draws (focused brick, glow, ghost, grid,
// washes) set them as constants and give the box's local GL size in uBox (w = 1).
in ivec4 iPos; in uvec4 iHalf;
in vec4 iColor;
in uvec4 iMisc;
uniform mat4 uMVP;
// the draw's origin relative to the render origin (GL axes, viewer units; computed in doubles)
uniform vec3 uChunkOffset;
// w > 0.5: a single draw of local GL size xyz, centred at uChunkOffset (iPos / iHalf.xyz unused)
uniform vec4 uBox;
uniform float uStudFade;
uniform float uBevelMax;
uniform float uBevelFit;
out vec3 vN; out vec3 vW; out vec3 vL; out float vSlope;
out vec3 vHalf; out vec3 vBase; out vec4 vFlags; out vec3 vBevel;
out vec2 vBevelK;
// the light and eye directions in the brick's frame; its orientation byte; x = linear colour, y = selected
// No flat varyings: ANGLE on D3D11 emulates flat shading with a geometry shader that broke line
// draws (the overlay outlines rendered as filled triangles). These are constant over a brick anyway.
out float vOrient; out vec2 vMisc;
// the material intensity (iColor.a holds the stored 0-10 byte; used when uIntensity < 0: instanced)
out float vIntensity;
out vec3 vLightL; out vec3 vEyeL;
uniform vec3 uEye; uniform vec3 uLight;
// units per viewer unit (50), a uniform so the scale is a true, correctly rounded division
uniform float uUnitDiv;
// 1: draw hidden faces too (render/facecull.ts; the cutaway)
uniform float uShowHidden;
// 1: a template-family draw (render/meshes/registry.ts): the vertex comes from the table uVtx, at
// the instance's mesh slot (iPos.w + iMisc.z << 15, in units of 8 vertices) + gl_VertexID, 3 texels
// of 1024 vertices a row: pos3 nrm3, slope part, cap4. The mesh attributes are unused then.
uniform float uPull;
uniform highp sampler2D uVtx;
${ORIENT_GLSL}
// Bevel band width for a face L viewer units long along an axis:
// W(L) = 0.43 / (0.957 + 0.86 / L) Brickadia units, which is uBevelMax at L = 20 units.
float bevelW(float L){ return uBevelMax / (0.957 + 0.86 / max(L / 0.02, 0.5)); }
// The vertex maths, from one mesh vertex. main() calls it with the mesh attributes, exactly as it
// always ran, or (uPull) with the vertex fetched from the template table: two copies of the same
// code, so the plain path compiles as before.
void vertex(vec3 mPos, vec3 mNrm, float mSlope, float mPart, vec4 mCap){
  vN = mNrm; vSlope = mSlope;
  vPart = mPart; vCap = mCap;
  bool single = uBox.w > 0.5;
  uint w = iHalf.w;
  mat3 R = orientGL(w & 31u);
  vec3 size, lp, p;
  if (single) {
    size = uBox.xyz; lp = mPos * size;
    p = R * lp + uChunkOffset;
  } else {
    // in whole units first: a box corner is centre +- half exactly, so bricks that share a face
    // share its vertices bit for bit (no hairline cracks), then one scale into viewer units
    vec3 hu = vec3(iHalf.xzy) * 2.0;
    size = hu / uUnitDiv; lp = mPos * size;
    p = (R * (mPos * hu) + vec3(iPos.xzy)) / uUnitDiv + uChunkOffset;
  }
  vW = p;
  vL = lp;
  vHalf = size * 0.5;
  vec3 fixedW = vec3(min(uBevelMax, 0.4*min(vHalf.x, min(vHalf.y, vHalf.z))));
  vBevel = mix(fixedW, vec3(bevelW(size.x), bevelW(size.y), bevelW(size.z)), uBevelFit);
  vBevelK = vec2(uBevelMax, uBevelFit);
  vBase = iColor.rgb;
  uint top = (w >> 5u) & 3u;
  float s = (w & 128u) != 0u ? 0.0 : 1.0;
  vFlags = vec4((top == 0u ? s : 0.0)*uStudFade, s*uStudFade, 1.0, top == 2u ? s : 0.0);
  vMisc = vec2((w & 256u) != 0u ? 1.0 : 0.0, (iMisc.w & 1u) != 0u ? 1.0 : 0.0);
  vOrient = float(w & 31u);
  vIntensity = iColor.a * 255.0;
  mat3 Rt = transpose(R);   // turned once per vertex, not per fragment (slow on software GL)
  vLightL = Rt * uLight; vEyeL = Rt * uEye;
  gl_Position = uMVP * vec4(p, 1.0);
  // hidden faces (render/facecull.ts; cube meshes only): bits +X -X +Y -Y +Z -Z in save axes.
  // Every vertex of a hidden face lands on one point outside the clip volume, so it draws nothing.
  // Full detail and the X-ray cutaway set uShowHidden = 1 and draw them (render/lod.ts hidesCovered).
  uint hid = single || uShowHidden > 0.5 ? 0u : iMisc.x;
  if (hid != 0u) {
    vec3 nw = R * mNrm;
    uint bit = abs(nw.x) > 0.5 ? (nw.x > 0.0 ? 1u : 2u) : abs(nw.z) > 0.5 ? (nw.z > 0.0 ? 4u : 8u) : (nw.y > 0.0 ? 16u : 32u);
    if ((hid & bit) != 0u) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  }
}
void main(){
  if (uPull > 0.5) {
    int v = ((iPos.w & 32767) | (int(iMisc.z) << 15)) * 8 + gl_VertexID;
    ivec2 t = ivec2((v & 1023) * 3, v >> 10);
    vec4 a = texelFetch(uVtx, t, 0), b = texelFetch(uVtx, t + ivec2(1, 0), 0);
    vertex(a.xyz, vec3(a.w, b.xy), b.z, b.w, texelFetch(uVtx, t + ivec2(2, 0), 0));
  } else vertex(aPos, aNrm, aSlope, aPart, aCap);
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
// the light / eye in the brick's frame (turned by the vertex shader), its orientation, x = linear colour, y = selected
in float vOrient; in vec2 vMisc;
in vec3 vLightL; in vec3 vEyeL;
${ORIENT_GLSL}
// the selection highlight (E-01), mixed over the tone-mapped colour
const vec3 SEL_TINT = vec3(1.0, 0.62, 0.28); const float SEL_MIX = 0.42;
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
in float vIntensity;
// specular anti-aliasing (U-10): strength by stud size on screen, variance threshold, fade, cap
uniform float uSpecAA;
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
    // in world axes: the slope texture keeps the layout of the world-frame meshes it was tuned on
    mat3 vR = orientGL(uint(vOrient + 0.5));
    vec3 nW = vR * nG, lW = vR * vL;
    vec3 an = abs(nW);
    vec3 w = an.z <= an.x && an.z <= an.y ? vec3(0.0, 0.0, 1.0) : an.x <= an.y ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 t = normalize(cross(nW, w));
    w = normalize(cross(t, nW));
    vec2 p = vec2(dot(lW, w)*0.8, dot(lW, t)) * (BUMPS/PITCH);
    const float E = 0.15;
    float gw = bumpHeight(p + vec2(E, 0.0)) - bumpHeight(p - vec2(E, 0.0));
    float gt = bumpHeight(p + vec2(0.0, E)) - bumpHeight(p - vec2(0.0, E));
    n = transpose(vR) * normalize(nW - uBump*(gw*w + gt*t)/(2.0*E));
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
  vec3 L = normalize(vLightL);
  float d = max(dot(n, L), 0.0);
  float bent = smoothstep(0.0, 0.02, 1.0 - dot(n, nG));
  // Specular anti-aliasing (U-10): where the stud creases or the hard bevel chamfers bend the normal
  // faster than a pixel, one pixel can land on a normal that glints white. Fade the glint by the excess
  // screen-space normal variance |fwidth(n)|^2 over SPEC_AA_T (it only ever dims, never widens, so
  // nothing new lights up), scaled by uSpecAA (1 when studs are small on screen, 0 from
  // SHADE.SPEC_AA_PX_HI px a stud up: close-ups keep the exact original shading).
  vec3 dn = fwidth(n);
  float nv = max(dot(dn, dn) - SPEC_AA_T, 0.0) * uSpecAA, sk = 1.0 / (1.0 + SPEC_AA_K * nv);
  float spec = pow(max(dot(n, normalize(L + vEyeL)), 0.0), 28.0) * 0.32 * bent * sk;
  if (nv > 0.0) spec = min(spec, SPEC_AA_CAP);     // an aliased pixel's glint can't approach white on dark plastic
  vec3 albedo = vMisc.x > 0.5 ? vBase : toLinear(vBase);
  vec3 lit = (albedo * (uSky + uSun*d) + uFloor + spec) * shade;
  if (uMat > 0.5) {
    float inten = uIntensity < 0.0 ? vIntensity : uIntensity;
    // Blended in display space over the tone-mapped scene (the forward pipeline has no linear
    // buffer): glass multiplies what is behind by its transmission (approximately display-encoded)
    // and adds the Fresnel sky reflection; translucent plastic alpha-blends its lit surface.
    if (uMat < 1.5) {
      float c = abs(dot(nG, normalize(vEyeL)));
      float t = matLerp3(GLASS_TINT, inten);
      vec3 T = pow(1.0 - t + t*albedo, vec3(1.0/pow(max(c, 0.05), GLASS_PATH_EXP)));
      float F = matFresnel(c);
      fragColor = uMatPass < 0.5 ? vec4(pow((1.0 - F)*T, vec3(1.0/2.2)), 1.0) : vec4(ueFilmic(uExposure * F * uSky), 1.0);
    } else if (uMat < 2.5) {
      vec3 surf = (albedo * (uSky + uSun*d) + uFloor*TRANSLUCENT_FLOOR_SCALE) * shade;
      fragColor = vec4(ueFilmic(uExposure * surf), translucentOpacity(inten));
    } else {
      vec3 e = uExposure * glowColor(albedo, inten);
      fragColor = uMatPass > 1.5 ? vec4(e, 1.0) : vec4(mix(ueFilmic(e), SEL_TINT, vMisc.y * SEL_MIX), 1.0);
    }
    return;
  }
  fragColor = vec4(mix(ueFilmic(uExposure * lit), SEL_TINT, vMisc.y * SEL_MIX), 1.0);
}`;
