// Ramps (PB_DefaultRamp, upright / upside down): a brick-like crest 1 stud deep at the high end, a
// lip 1 micro tall at the low end, and a slope between. The profile depends on the real size (the
// crest and lip don't scale), so each size gets its own little mesh, built in the unit box like the
// cube. Layout: pos3, normal3 (the world normal), slope flag; not indexed: 16 triangles.

export const RAMP_VERTS = 48;

/**
 * size: world [X,Y,Z] lengths; run: world axis of the slope (0 = X, 1 = Y); lip: +1 / -1, which way
 * along it the low (lip) end is; up: +1 upright, -1 upside down (flipped vertically).
 */
export function rampMesh(size: readonly number[], run: number, lip: number, up: number): Float32Array {
  const R = size[run], H = size[2];
  const c = Math.min(0.2, R), m = Math.min(0.04, H);   // crest depth 1 stud, lip 1 micro
  const P = (u: number, v: number, s: number): number[] => {
    const p = [0, 0, 0];
    p[run === 0 ? 0 : 2] = lip > 0 ? 0.5 - u / R : -0.5 + u / R;
    p[1] = up * (v / H - 0.5);
    p[run === 0 ? 2 : 0] = s * 0.5;
    return p;
  };
  const N = (nu: number, nv: number): number[] => {
    const n = [0, 0, 0];
    n[run === 0 ? 0 : 2] = -lip * nu; n[1] = up * nv;
    return n;
  };
  const sl = Math.hypot(H - m, R - c) || 1;
  const out: number[] = [];
  const quad = (a: number[], b: number[], cc: number[], d: number[], n: number[], f = 0): void => {
    for (const p of [a, b, cc, a, cc, d]) out.push(...p, ...n, f);
  };
  for (const s of [-1, 1]) {                            // sides: the profile pentagon, as a fan
    const n = [0, 0, 0]; n[run === 0 ? 2 : 0] = s;
    const pts = [P(0, 0, s), P(R, 0, s), P(R, H, s), P(R - c, H, s), P(0, m, s)];
    for (let k = 1; k < 4; k++) for (const p of [pts[0], pts[k], pts[k + 1]]) out.push(...p, ...n, 0);
  }
  quad(P(0, 0, -1), P(R, 0, -1), P(R, 0, 1), P(0, 0, 1), N(0, -1));          // bottom
  quad(P(R, 0, -1), P(R, H, -1), P(R, H, 1), P(R, 0, 1), N(1, 0));           // crest back
  quad(P(R, H, -1), P(R - c, H, -1), P(R - c, H, 1), P(R, H, 1), N(0, 1));       // crest top (studs)
  quad(P(R - c, H, -1), P(0, m, -1), P(0, m, 1), P(R - c, H, 1), N(-(H - m) / sl, (R - c) / sl), 1);   // slope
  quad(P(0, m, -1), P(0, 0, -1), P(0, 0, 1), P(0, m, 1), N(-1, 0));          // lip face
  return new Float32Array(out);
}
