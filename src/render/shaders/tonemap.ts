// Unreal's stock filmic tonemapper, verbatim from the legacy viewer (the calibrated pipeline):
// sRGB -> AP1, expand gamut 1.0, blue correction 0.6, glow and red modifier, pre-desaturate .96,
// FilmToneMap (slope .88, toe .55, shoulder .26, black clip 0, white clip .04), post-desaturate .93,
// undo blue correction, AP1 -> sRGB, sRGB OETF. Matrices are written as rows; v * M gives M.v.

export const TONEMAP_GLSL = `
vec3 toLinear(vec3 c){ return mix(c/12.92, pow((c + 0.055)/1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSRGB(vec3 c){ return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
const vec3 AP1_Y = vec3(0.2722287, 0.6740818, 0.0536895);
const mat3 sRGB_2_AP1 = mat3(vec3(0.6131915, 0.3395121, 0.0473663), vec3(0.0702069, 0.9163358, 0.0134500), vec3(0.0206189, 0.1095673, 0.8696067));
const mat3 AP1_2_sRGB = mat3(vec3(1.7050515, -0.6217907, -0.0832584), vec3(-0.1302571, 1.1408029, -0.0105485), vec3(-0.0240033, -0.1289688, 1.1529717));
const mat3 AP1_2_AP0 = mat3(vec3(0.6954522, 0.1406787, 0.1638691), vec3(0.0447946, 0.8596711, 0.0955343), vec3(-0.0055259, 0.0040252, 1.0015007));
const mat3 AP0_2_AP1 = mat3(vec3(1.4514393, -0.2365107, -0.2149286), vec3(-0.0765538, 1.1762297, -0.0996759), vec3(0.0083161, -0.0060324, 0.9977163));
const mat3 EXPAND = mat3(vec3(1.3704127, -0.3292913, -0.0636828), vec3(-0.0834342, 1.0970910, -0.0108616), vec3(-0.0257933, -0.0986256, 1.2036943));
const mat3 BLUE_AP1 = mat3(vec3(0.9386394, 0.0, 0.0613606), vec3(0.0, 0.8307941, 0.1692059), vec3(0.0, 0.0, 1.0));
const mat3 BLUEINV_AP1 = mat3(vec3(1.0653749, 0.0, -0.0653710), vec3(0.0, 1.2036635, -0.2036677), vec3(0.0, 0.0, 1.0));
const float FT_SLOPE = 0.88, FT_BLACK = 0.0, FT_WHITE = 0.04, FT_TOE_SCALE = 0.45, FT_SH_SCALE = 0.78;
const float FT_TOE_M = -0.3902772, FT_STRAIGHT_M = 0.9016409, FT_SHOULDER_M = -0.6061863;
float filmCurve(float x){
  float L = log(max(x, 1e-10))*0.4342945;
  float st = FT_SLOPE*(L + FT_STRAIGHT_M);
  float toe = (L < FT_TOE_M) ? -FT_BLACK + 2.0*FT_TOE_SCALE/(1.0 + exp(-2.0*FT_SLOPE/FT_TOE_SCALE*(L - FT_TOE_M))) : st;
  float sh = (L > FT_SHOULDER_M) ? 1.0 + FT_WHITE - 2.0*FT_SH_SCALE/(1.0 + exp(2.0*FT_SLOPE/FT_SH_SCALE*(L - FT_SHOULDER_M))) : st;
  float t = clamp((L - FT_TOE_M)/(FT_SHOULDER_M - FT_TOE_M), 0.0, 1.0);
  t = FT_SHOULDER_M < FT_TOE_M ? 1.0 - t : t;
  t = (3.0 - 2.0*t)*t*t;
  return mix(toe, sh, t);
}
float sat3(vec3 c){ float mn = min(c.r, min(c.g, c.b)), mx = max(c.r, max(c.g, c.b)); return (max(mx, 1e-10) - max(mn, 1e-10))/max(mx, 1e-2); }
vec3 ueFilmic(vec3 rgb){
  vec3 c = rgb * sRGB_2_AP1;
  float lum = dot(c, AP1_Y);
  if (lum > 1e-10) {
    vec3 ch = c/lum - 1.0;
    float amt = (1.0 - exp2(-4.0*dot(ch, ch))) * (1.0 - exp2(-4.0*lum*lum));
    c = mix(c, c*EXPAND, amt);
  }
  c = mix(c, c*BLUE_AP1, 0.6);
  vec3 a0 = c * AP1_2_AP0;
  float s = sat3(a0);
  float chroma = sqrt(max(0.0, a0.b*(a0.b - a0.g) + a0.g*(a0.g - a0.r) + a0.r*(a0.r - a0.b)));
  float yc = (a0.r + a0.g + a0.b + 1.75*chroma)/3.0;
  float x = (s - 0.4)/0.2, tt = max(1.0 - abs(0.5*x), 0.0);
  float shp = 0.5*(1.0 + sign(x)*(1.0 - tt*tt));
  float gain = 0.05*shp;
  float glow = (yc <= 0.0533333) ? gain : (yc >= 0.16 ? 0.0 : gain*(0.08/yc - 0.5));
  a0 *= 1.0 + glow;
  float hue = (a0.r == a0.g && a0.g == a0.b) ? 0.0 : degrees(atan(sqrt(3.0)*(a0.g - a0.b), 2.0*a0.r - a0.g - a0.b));
  if (hue < 0.0) hue += 360.0;
  if (hue > 180.0) hue -= 360.0;
  float hw = smoothstep(0.0, 1.0, 1.0 - abs(2.0*hue/135.0));
  hw *= hw;
  a0.r += hw * s * (0.03 - a0.r) * 0.18;
  vec3 w = max(a0 * AP0_2_AP1, 0.0);
  w = mix(vec3(dot(w, AP1_Y)), w, 0.96);
  vec3 t3 = vec3(filmCurve(w.r), filmCurve(w.g), filmCurve(w.b));
  t3 = max(mix(vec3(dot(t3, AP1_Y)), t3, 0.93), 0.0);
  t3 = mix(t3, t3*BLUEINV_AP1, 0.6);
  return toSRGB(clamp(t3 * AP1_2_sRGB, 0.0, 1.0));
}
`;
