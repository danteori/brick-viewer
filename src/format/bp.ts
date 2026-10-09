// Environment preset (.bp JSON) -> lighting {sun, sky, floor, exposure}, with the structured formula
// from the joint calibration fit. Only the sky group's time, sun, sky, clouds and moon are used;
// sunAngle is ignored. Colours are read as linear (UE FLinearColor). DOM-free.
// Untested parts: the time-of-day curve, the cloud window, sunScale, elevation.

export interface BpLight { sun: number[]; sky: number[]; floor: number[]; exposure: number }

interface BpColour { r?: number; g?: number; b?: number }
type BpGroup = Record<string, unknown>;

export function lightFromBp(json: unknown): BpLight {
  const groups = ((json as { data?: { groups?: Record<string, BpGroup> } })?.data?.groups) || {};
  const g = groups[Object.keys(groups).find((k) => k.toLowerCase() === 'sky')!];   // 'sky' or 'Sky'
  if (!g) throw new Error('not an environment preset (no data.groups.sky)');
  const col = (c: unknown): number[] => { const x = c as BpColour | undefined; return [x?.r ?? 0, x?.g ?? 0, x?.b ?? 0]; };
  const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);
  const sstep = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const tod = num(g.timeOfDay, 12), cc = num(g.cloudCoverage, 0), sunScale = num(g.sunScale, 1);
  const fe = Math.max(0, Math.sin(Math.PI * (tod - 6) / 12));
  const sunC = col(g.sunlightColor), skyC = col(g.skyColor), T = [1, 0.701, 0.470];
  const Sc = 7.567, Q = 0.324, K = 0.974;
  let direct: number[], diffuse: number[], floor: number[];
  if (fe > 0) {
    const Dcl = 1 - sstep(0.20, 0.55, cc);
    direct = sunC.map((v, i) => Sc * sunScale * fe * v * T[i] * Dcl);
    diffuse = sunC.map((v, i) => Q * Sc * sunScale * fe * cc * v + K * num(g.skyIntensity, 1) * skyC[i]);
    floor = direct.map((v, i) => 0.0220 * v + 0.0326 * diffuse[i]);
  } else {
    direct = col(g.moonlightColor).map((v) => 0.1174 * num(g.moonlightIntensity, 0) * v);
    diffuse = [0.0403, 0.0403, 0.0403];
    floor = direct.map((v, i) => 0.0093 * (v + diffuse[i]));
  }
  return { sun: direct.map((v) => v / 0.81), sky: diffuse, floor, exposure: 0.93 };
}
