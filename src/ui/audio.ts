// UI sounds (backlog L-05), all synthesised with the Web Audio API: no sample files, nothing
// taken from the game. Every sound is a short, quiet envelope into one master gain, so mute and
// volume act on everything at once.
//
//   playResize(step)  resize tick, pitched by the size step (higher = bigger)
//   playClick()       place / release click (the legacy viewer's own synthesised click)
//   playDelete()      delete pop: a quick downward sine blip
//   playPaste()       paste whoosh: band-passed noise sweeping up
//   playError()       error buzz: two detuned low square waves, low-passed
//   playSelect()      select tick: a tiny high triangle blip
//
// The AudioContext is only created inside initAudio(), which callers run from pointer / key
// handlers (browsers block audio until a user gesture). armAudioOnGesture() does that once on
// the first pointerdown / keydown. Before that every play* call is a silent no-op.
// Mute and volume persist in localStorage (via app/settings.ts, which wraps it in try/catch).

import { loadString, saveString } from '../app/settings.ts';

export const MUTE_KEY = 'brickViewer.soundMuted';
export const VOLUME_KEY = 'brickViewer.soundVolume';
/** Default master volume (0..1). The individual sounds are already quiet (peaks 0.1-0.5). */
export const DEFAULT_VOLUME = 0.7;
/** Resize ticks closer together than this are dropped (a fast drag would otherwise buzz). */
export const RESIZE_MIN_GAP_MS = 20;
/** Error buzzes closer together than this are dropped (a blocked resize drag refuses every step). */
export const ERROR_MIN_GAP_MS = 250;

export type SoundName = 'resize' | 'place' | 'delete' | 'paste' | 'error' | 'select';

let ac: AudioContext | null = null, master: GainNode | null = null;
let clickBuf: AudioBuffer | null = null, noiseBuf: AudioBuffer | null = null;
let lastResize = -Infinity, lastError = -Infinity;
let muted = loadString(MUTE_KEY) === '1';
let volume = parseVolume(loadString(VOLUME_KEY));

function parseVolume(v: string | null): number {
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_VOLUME;
}

const masterLevel = (): number => (muted ? 0 : volume);

// --- settings -------------------------------------------------------------------------------

export const isMuted = (): boolean => muted;
export const getVolume = (): number => volume;

export function setMuted(m: boolean): void {
  muted = m; saveString(MUTE_KEY, m ? '1' : '0'); applyMaster();
}

/** @returns the new muted state */
export function toggleMute(): boolean { setMuted(!muted); return muted; }

/** Master volume 0..1 (clamped). */
export function setVolume(v: number): void {
  volume = parseVolume(String(v)); saveString(VOLUME_KEY, String(volume)); applyMaster();
}

function applyMaster(): void {
  if (!ac || !master) return;
  master.gain.setTargetAtTime(masterLevel(), ac.currentTime, 0.01);   // no zipper noise
}

// --- context --------------------------------------------------------------------------------

/** Needs a user gesture; call it from pointer / key input. Safe to call repeatedly. */
export function initAudio(): void {
  if (ac) { if (ac.state === 'suspended') void ac.resume(); return; }
  const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const AC = w.AudioContext || w.webkitAudioContext;
  if (!AC) return;
  try {
    ac = new AC();
    master = ac.createGain(); master.gain.value = masterLevel(); master.connect(ac.destination);
    const sr = ac.sampleRate;
    // 40 ms click (from the legacy viewer): decaying noise burst + 140 Hz thump
    const n = Math.round(sr * 0.04);
    clickBuf = ac.createBuffer(1, n, sr);
    const d = clickBuf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 260) * 0.8 + Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t * 90) * 0.6;
    }
    // 0.5 s of white noise, shared by the whoosh
    const m = Math.round(sr * 0.5);
    noiseBuf = ac.createBuffer(1, m, sr);
    const e = noiseBuf.getChannelData(0);
    for (let i = 0; i < m; i++) e[i] = Math.random() * 2 - 1;
  } catch { ac = null; master = null; }
}

/** Calls initAudio() on the first pointerdown or keydown anywhere (once). */
export function armAudioOnGesture(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = globalThis as unknown as EventTarget): void {
  const go = (): void => {
    initAudio();
    target.removeEventListener('pointerdown', go, true); target.removeEventListener('keydown', go, true);
  };
  target.addEventListener('pointerdown', go, true); target.addEventListener('keydown', go, true);
}

/** True once the context exists and is running (i.e. after a gesture). */
export const audioReady = (): boolean => !!ac && ac.state === 'running';

/** The live context and master bus, or null when silent (no gesture yet, muted, unsupported). */
function bus(): { ac: AudioContext; out: GainNode; t: number } | null {
  if (!ac || !master || ac.state !== 'running' || muted || volume <= 0) return null;
  return { ac, out: master, t: ac.currentTime };
}

/** A gain node with an attack / exponential-decay envelope, connected to out. */
function env(c: AudioContext, out: AudioNode, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}

function tone(c: AudioContext, type: OscillatorType, f0: number, f1: number, t: number, dur: number, dest: AudioNode): void {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  o.connect(dest); o.start(t); o.stop(t + dur + 0.02);
}

// --- sounds ---------------------------------------------------------------------------------

/**
 * Pitch of a resize tick for a size step (the new size in grid units): a quarter-tone up per
 * unit from 300 Hz at size 1, folding back down an octave every 24 units so long drags stay in
 * a comfortable 300-600 Hz band. Exported for tests and the demo.
 */
export function resizePitch(step: number): number {
  const s = Math.max(1, Math.round(Number.isFinite(step) ? step : 1)) - 1;
  return 300 * Math.pow(2, (s % 24) / 24);
}

/** A resize step. step = the new size in units (pitch rises with it); omitted = size 1. */
export function playResize(step = 1): void {
  const b = bus(); if (!b) return;
  const now = performance.now(); if (now - lastResize < RESIZE_MIN_GAP_MS) return; lastResize = now;
  const f = resizePitch(step);
  tone(b.ac, 'triangle', f, f, b.t, 0.05, env(b.ac, b.out, b.t, 0.22, 0.002, 0.045));
  tone(b.ac, 'sine', f * 2, f * 2, b.t, 0.03, env(b.ac, b.out, b.t, 0.06, 0.001, 0.025));   // a little sparkle
}

/** Place / release click: the legacy viewer's synthesised click, band-passed at 1.8 kHz. */
export function playClick(): void {
  const b = bus(); if (!b || !clickBuf) return;
  const src = b.ac.createBufferSource(), bp = b.ac.createBiquadFilter(), g = b.ac.createGain();
  src.buffer = clickBuf; bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
  g.gain.value = 0.5;
  src.connect(bp); bp.connect(g); g.connect(b.out); src.start(b.t);
}
/** Alias: placing a brick uses the click. */
export const playPlace = playClick;

/** Delete pop: a sine dropping 640 -> 170 Hz over 90 ms. */
export function playDelete(): void {
  const b = bus(); if (!b) return;
  tone(b.ac, 'sine', 640, 170, b.t, 0.09, env(b.ac, b.out, b.t, 0.32, 0.003, 0.09));
}

/** Paste whoosh: white noise through a band-pass sweeping 350 Hz -> 2.6 kHz over 200 ms. */
export function playPaste(): void {
  const b = bus(); if (!b || !noiseBuf) return;
  const src = b.ac.createBufferSource(), bp = b.ac.createBiquadFilter();
  src.buffer = noiseBuf; bp.type = 'bandpass'; bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(350, b.t); bp.frequency.exponentialRampToValueAtTime(2600, b.t + 0.2);
  src.connect(bp); bp.connect(env(b.ac, b.out, b.t, 0.28, 0.07, 0.16)); src.start(b.t); src.stop(b.t + 0.26);
}

/** Error buzz: 150 + 157 Hz square waves, low-passed at 900 Hz, two short pulses. */
export function playError(): void {
  const b = bus(); if (!b) return;
  const now = performance.now(); if (now - lastError < ERROR_MIN_GAP_MS) return; lastError = now;   // a blocked drag repeats
  const lp = b.ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.connect(b.out);
  for (const dt of [0, 0.1]) {
    const g = env(b.ac, lp, b.t + dt, 0.09, 0.005, 0.075);
    tone(b.ac, 'square', 150, 150, b.t + dt, 0.08, g);
    tone(b.ac, 'square', 157, 157, b.t + dt, 0.08, g);
  }
}

/** Select tick: a 1.5 kHz triangle blip, 20 ms. */
export function playSelect(): void {
  const b = bus(); if (!b) return;
  tone(b.ac, 'triangle', 1500, 1500, b.t, 0.02, env(b.ac, b.out, b.t, 0.12, 0.001, 0.018));
}

/** Play a sound by name (demo page, settings preview). */
export function playSound(name: SoundName, step?: number): void {
  switch (name) {
    case 'resize': playResize(step); break;
    case 'place': playClick(); break;
    case 'delete': playDelete(); break;
    case 'paste': playPaste(); break;
    case 'error': playError(); break;
    case 'select': playSelect(); break;
  }
}
