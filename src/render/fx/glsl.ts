// GLSL shared by the graphics effects: the sky dome (sky pass and water reflections), the virtual
// perspective ray, and the brick shader's FX block (compiled only into the FX program variant,
// render/gl.ts, so the plain program is byte-for-byte what it was).

/** The fullscreen-triangle vertex shader (as render/bloom.ts). */
export const FULL_VS = `#version 300 es
out vec2 vUv;
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p*2.0 - 1.0, 0.0, 1.0); }`;

/**
 * The view is orthographic, but the sky, the fog and the water's Fresnel read better through a
 * virtual perspective camera with the game's field of view, looking the same way. uCamF / R / U:
 * its forward, right and up (GL axes); uTan: tan of the half field of view across x and y.
 */
export const RAY_GLSL = `
uniform vec3 uCamF, uCamR, uCamU; uniform vec2 uTan;
vec3 viewRay(vec2 ndc){ return normalize(uCamF + ndc.x*uTan.x*uCamR + ndc.y*uTan.y*uCamU); }`;

/**
 * Sky dome radiance along direction d (GL axes, y up): a zenith-to-horizon gradient seen through
 * the height fog (optical depth uSkyP.x / d.y, so the horizon is the fog colour), the sun or moon
 * disc with a halo, stars at night. Below the horizon the fog colour (an endless fog fills the void).
 * uSkyP: x = fog optical depth straight up, y = cos(disc radius), w = 1 for Space (no fog, no dome).
 */
export const SKY_GLSL = `
uniform vec3 uSkyZenith, uSkyFog, uSunDir, uSunDisc, uStars; uniform vec4 uSkyP;
float skyHash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x + p.y + p.z)); }
vec3 skyRadiance(vec3 d){
  bool space = uSkyP.w > 0.5;
  float T = space ? 1.0 : (d.y > 0.0 ? exp(-uSkyP.x / max(d.y, 1e-3)) : 0.0);
  vec3 base = space ? vec3(0.0) : uSkyZenith * (1.0 + 0.6*pow(1.0 - max(d.y, 0.0), 3.0));
  float c = dot(d, uSunDir), r = max(1.0 - uSkyP.y, 1e-6);
  vec3 sun = uSunDisc * (smoothstep(uSkyP.y - 0.3*r, uSkyP.y + 0.05*r, c) + 0.004*pow(max(c, 0.0), 180.0));
  vec3 g = d*700.0, id = floor(g);
  float h = skyHash(id), star = step(0.9965, h) * (1.0 - smoothstep(0.15, 0.45, length(fract(g) - 0.5)));
  vec3 stars = uStars * star * (0.4 + 0.6*fract(h*91.7)) * (space || d.y > 0.0 ? 1.0 : 0.0);
  return mix(uSkyFog, base + sun + stars, T);
}`;

/**
 * The brick shader's FX block (#ifdef FX): sun shadows (PCF over a depth map with hardware
 * compare), SSAO (the half-res AO texture, ambient terms only), underwater extinction and water
 * fog, and the height fog toward the virtual eye. vW is the fragment's position (GL axes, relative
 * to the render origin, viewer units).
 *   uShadowP: x on, y texel (shadow uv), z normal offset (viewer units), w PCF taps
 *   uAOP:     x on, yz 1 / drawing-buffer size, w strength
 *   uFogP:    x density at the eye's height (per viewer unit), y falloff (per viewer unit), z on
 *   uWaterP:  x surface height (GL y), y on, z water fog (per viewer unit)
 */
export const BRICK_FX_GLSL = `
uniform highp sampler2DShadow uShadowMap; uniform mat4 uShadowMat; uniform vec4 uShadowP; uniform vec3 uShadowL;
uniform sampler2D uAO; uniform vec4 uAOP;
uniform vec3 uFogEye; uniform vec4 uFogP; uniform vec3 uFogColor;
uniform vec4 uWaterP; uniform vec3 uWaterExt, uWaterIn, uWaterFogColor;
uniform vec3 uViewDir;
const vec2 PCF[12] = vec2[12](vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
  vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
  vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));
float fxShadow(vec3 nW){
  if (uShadowP.x < 0.5) return 1.0;
  vec3 p = vW + (nW + uShadowL) * uShadowP.z;
  vec4 s = uShadowMat * vec4(p, 1.0);
  if (s.x <= 0.0 || s.y <= 0.0 || s.x >= 1.0 || s.y >= 1.0 || s.z >= 1.0) return 1.0;
  int n = int(uShadowP.w + 0.5);
  if (n <= 1) return texture(uShadowMap, s.xyz);
  float acc = 0.0, rad = 1.6 * uShadowP.y;
  for (int i = 0; i < 12; i++) { if (i >= n) break; acc += texture(uShadowMap, vec3(s.xy + PCF[i]*rad, s.z)); }
  return acc / float(n);
}
float fxAO(){ return uAOP.x < 0.5 ? 1.0 : mix(1.0, texture(uAO, gl_FragCoord.xy * uAOP.yz).r, uAOP.w); }
vec3 fxAtmos(vec3 c){
  if (uWaterP.y > 0.5 && vW.y < uWaterP.x) {
    float L = min((uWaterP.x - vW.y) / max(abs(uViewDir.y), 0.03), 1e6);
    vec3 T = exp(-uWaterExt * L);
    c = c*T + uWaterIn*(1.0 - T);
    c = mix(c, uWaterFogColor, 1.0 - exp(-uWaterP.z * L));
  }
  if (uFogP.z > 0.5) {
    vec3 d = vW - uFogEye;
    float fz = max(uFogP.y * d.y, -80.0);
    float k = abs(fz) > 1e-4 ? (1.0 - exp(-fz)) / fz : 1.0;
    c = mix(uFogColor, c, exp(-uFogP.x * length(d) * k));
  }
  return c;
}`;
