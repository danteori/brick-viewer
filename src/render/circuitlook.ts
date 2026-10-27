
export const CIRCUIT_LOOK = {
  base: [40, 42, 70], lattice: [118, 98, 106], trace: [58, 64, 112],
  cell: 8, traceCell: 5, latticeWidth: 0.35, traceWidth: 0.3, radius: 4,
  alpha: 0.92,
};

const L = CIRCUIT_LOOK, glf = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const lin = (c: number[]): string => `vec3(${c.map((v) => glf(+Math.pow(v / 255, 2.2).toFixed(5))).join(', ')})`;

export const CIRCUIT_GLSL = `
const vec3 CIR_BASE = ${lin(L.base)}, CIR_LATTICE = ${lin(L.lattice)}, CIR_TRACE = ${lin(L.trace)};
const float CIR_CELL = ${glf(L.cell)}, CIR_TCELL = ${glf(L.traceCell)}, CIR_LW = ${glf(L.latticeWidth)}, CIR_TW = ${glf(L.traceWidth)}, CIR_R = ${glf(L.radius)}, CIR_ALPHA = ${glf(L.alpha)};
float cirHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cirLine(float d, float w){ float fw = max(fwidth(d), 1e-4); return 1.0 - smoothstep(w - fw, w + fw, abs(d)); }
float cirBox(vec2 p, vec2 h){ vec2 d = abs(p) - h; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float cirEdge(vec2 q, vec2 hb){ return cirBox(q, hb - vec2(CIR_R)) - CIR_R; }
vec3 circuitColour(vec2 q, vec2 hb){
  vec3 c = CIR_BASE;
  vec2 cell = floor(q / CIR_TCELL), f = q / CIR_TCELL - cell;
  float r = cirHash(cell), r2 = cirHash(cell + 17.0), lane = 0.25 + 0.5 * r2;
  float onX = step(0.5, r), span = step(0.15, f.x) * step(f.x, 0.95 - 0.5 * r2);
  float t = onX > 0.5 ? cirLine((f.y - lane) * CIR_TCELL, CIR_TW) * span : cirLine((f.x - lane) * CIR_TCELL, CIR_TW) * step(0.15, f.y) * step(f.y, 0.95 - 0.5 * r2);
  float dotAt = r > 0.35 ? 1.0 - smoothstep(0.55, 0.8, length((f - (onX > 0.5 ? vec2(0.95 - 0.5 * r2, lane) : vec2(lane, 0.95 - 0.5 * r2))) * CIR_TCELL)) : 0.0;
  c = mix(c, CIR_TRACE, clamp(t * step(0.2, r) + dotAt, 0.0, 1.0));
  vec2 g = q - CIR_CELL * floor(q / CIR_CELL + 0.5);
  c = mix(c, CIR_LATTICE, max(cirLine(g.x, CIR_LW), cirLine(g.y, CIR_LW)));
  vec2 gp = q - (hb - vec2(CIR_R + 6.0));
  float glyph = max(1.0 - smoothstep(0.0, 0.5, abs(cirBox(gp, vec2(3.5))) - 0.2), 1.0 - smoothstep(0.0, 0.5, cirBox(gp, vec2(1.6))));
  return mix(c, CIR_LATTICE, glyph * 0.8);
}`;
