// Graphics effects (backlog L-03 / L-06): the switches and quality levels the renderer reads, as
// set by the graphics settings (src/ui/panels/graphics.ts maps the game's Options/Graphics preset
// onto them) and stepped down by the adaptive governor on heavy scenes.
//
// Everything is off until the app turns it on (fx.want.on), and the ?test mode keeps it off unless
// a test asks (the test hook's setGraphics), so the existing goldens render exactly as before.

import { getGfx, type GraphicsPreset } from '../../format/graphics.ts';
import type { Environment } from '../../format/environment.ts';

export interface FxWant {
  /** master switch: sky, fog, water and the world-fixed sun (and shadows / SSAO by their level) */
  on: boolean;
  /** 0 off, 1..3 map size 1024 / 2048 / 4096 with 4 / 8 / 12 PCF taps */
  shadows: number;
  /** 0 off, 1..3 sample count 6 / 10 / 14 */
  ssao: number;
  /** water surface waves: 0 flat, 1..3 octaves */
  waves: number;
  /** the glow halo (existing bloom pass) */
  bloom: boolean;
  /** horizontal field of view (degrees) of the virtual perspective camera the sky, fog and water reflections use */
  fov: number;
  /** step effects down on heavy scenes to keep the frame rate */
  adaptive: boolean;
  /** drawing-buffer scale (1 = native) */
  renderScale: number;
  /** frames per second cap, 0 = none; and while the window is in the background */
  fpsLimit: number;
  fpsLimitUnfocused: number;
}

export const FX_DEFAULT: Readonly<FxWant> = Object.freeze({
  on: false, shadows: 2, ssao: 3, waves: 3, bloom: true, fov: 65, adaptive: true, renderScale: 1, fpsLimit: 0, fpsLimitUnfocused: 0,
});

/** Upscalers reconstruct full resolution, so the viewer (no upscaler) renders native for them. */
const UPSCALERS = /^(dlss|fsr|xess|tsr)/i;

/** The game's preset -> our switches ("close, not 1:1"; the mapping is logged in UX_ASSUMPTIONS.md). */
export function wantFromPreset(p: GraphicsPreset, on: boolean, adaptive: boolean): FxWant {
  const num = (k: string, d: number): number => { const v = getGfx(p, k); return typeof v === 'number' && Number.isFinite(v) ? v : d; };
  const lvl = (k: string, d: number): number => Math.max(0, Math.min(3, Math.round(num(k, d))));
  const aa = String(getGfx(p, 'AntiAliasingMode') ?? '');
  const scale = UPSCALERS.test(aa) ? 100 : num('ResolutionScaleValueEx', 100);
  const fov = num('FieldOfView', 65);
  return {
    on, adaptive,
    shadows: lvl('ShadowQuality', 2),
    ssao: lvl('PostProcessingQuality', 3),
    bloom: lvl('PostProcessingQuality', 3) > 0,
    waves: lvl('VisualEffectQuality', 3),
    fov: Math.max(20, Math.min(130, fov)),
    renderScale: Math.max(0.25, Math.min(1, scale / 100)),
    fpsLimit: Math.max(0, num('FrameRateLimit', 0)),
    fpsLimitUnfocused: Math.max(0, num('FrameRateLimitUnfocused', 0)),
  };
}

export const fx = {
  want: { ...FX_DEFAULT } as FxWant,
  /** adaptive step-down level: 0 = as wanted, up to ADAPT_MAX */
  drop: 0,
  /** smoothed frame time (ms) */
  ms: 16,
  /** the full build's effect passes are installed (main.full.ts): shadows and SSAO */
  supported: false,
  /** the applied environment (app/environment.ts), for the sun, sky, fog and water; null = none */
  env: null as Environment | null,
};

export const ADAPT_MAX = 4;

/** What this frame renders, after the adaptive step-down. */
export interface FxEff { on: boolean; shadows: number; ssao: number; waves: number }
export function fxEffective(): FxEff {
  const w = fx.want, d = fx.drop;
  if (!w.on) return { on: false, shadows: 0, ssao: 0, waves: 0 };
  const full = fx.supported;
  return {
    on: true,
    shadows: !full || d >= 4 ? 0 : d >= 3 ? Math.min(w.shadows, 1) : d >= 1 ? Math.min(w.shadows, 2) : w.shadows,
    ssao: !full || d >= 2 ? 0 : d >= 1 ? Math.min(w.ssao, 1) : w.ssao,
    waves: d >= 3 ? Math.min(w.waves, 1) : w.waves,
  };
}

let slowFor = 0, fastFor = 0, last = 0, upWait = 4000, upAt = -1e9, stalls = 0;
const STALL_MS = 250, STALLS_IN_A_ROW = 3;
/**
 * The adaptive governor, once a frame: frame time above ~45 ms for 1.5 s steps one level down
 * (SSAO first, then shadow resolution, then shadows), below ~22 ms for 4 s steps one back up. A
 * step up that has to be taken back within 10 s doubles the wait before the next one (up to a
 * minute), so a scene on the edge doesn't flicker between levels.
 */
export function adaptTick(now: number, testMode: boolean, capMs = 0): void {
  const dt = last ? now - last : 16;
  last = now;
  if (dt > STALL_MS && ++stalls < STALLS_IN_A_ROW) return;
  if (dt <= STALL_MS) stalls = 0;
  fx.ms += (Math.min(dt, 1000) - fx.ms) * 0.1;
  if (!fx.want.on || !fx.want.adaptive || testMode) { fx.drop = 0; slowFor = fastFor = 0; return; }
  // a frame-rate cap sets the pace itself: only time beyond it counts as slow
  const slow = Math.max(45, capMs * 1.35), fast = Math.max(22, capMs * 1.1);
  if (fx.ms > slow) { slowFor += dt; fastFor = 0; } else if (fx.ms < fast) { fastFor += dt; slowFor = 0; } else { slowFor = fastFor = 0; }
  if (slowFor > 1500 && fx.drop < ADAPT_MAX) {
    fx.drop++; slowFor = 0; fx.ms = 30;
    upWait = now - upAt < 10000 ? Math.min(60000, upWait * 2) : 4000;
  }
  if (fastFor > upWait && fx.drop > 0) { fx.drop--; fastFor = 0; upAt = now; }
}
