import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal fake Web Audio graph: records every node created and every one connected to the
// destination chain, so the tests can check gating, mute and that each sound makes nodes.
type Rec = { kind: string; started: number };
let created: Rec[] = [];
let contexts = 0;

const param = (): Record<string, unknown> => {
  const p: Record<string, unknown> = { value: 0 };
  for (const k of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime']) {
    p[k] = (v: number) => { p.value = v; return p; };
  }
  return p;
};
function node(kind: string): Record<string, unknown> {
  const r: Rec = { kind, started: 0 };
  created.push(r);
  return {
    gain: param(), frequency: param(), Q: param(), type: '', buffer: null,
    connect: () => undefined, start: () => { r.started++; }, stop: () => undefined,
  };
}
class FakeAC {
  state = 'running'; sampleRate = 8000; currentTime = 0; destination = {};
  constructor() { contexts++; }
  resume(): Promise<void> { this.state = 'running'; return Promise.resolve(); }
  createGain(): unknown { return node('gain'); }
  createOscillator(): unknown { return node('osc'); }
  createBufferSource(): unknown { return node('src'); }
  createBiquadFilter(): unknown { return node('filter'); }
  createBuffer(_c: number, n: number): unknown { const d = new Float32Array(n); return { getChannelData: () => d }; }
}

let store: Map<string, string>;
type Audio = typeof import('../../src/ui/audio.ts');
async function load(): Promise<Audio> { vi.resetModules(); return import('../../src/ui/audio.ts'); }
const started = (): number => created.reduce((s, r) => s + r.started, 0);

beforeEach(() => {
  created = []; contexts = 0; store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('audio', () => {
  it('does nothing before a user gesture (no context is created)', async () => {
    vi.stubGlobal('AudioContext', FakeAC);
    const a = await load();
    a.playClick(); a.playResize(3); a.playDelete(); a.playPaste(); a.playError(); a.playSelect();
    expect(contexts).toBe(0);
    expect(created.length).toBe(0);
    expect(a.audioReady()).toBe(false);
  });

  it('arms on the first gesture, once', async () => {
    vi.stubGlobal('AudioContext', FakeAC);
    const a = await load();
    const handlers = new Map<string, () => void>();
    const target = {
      addEventListener: (t: string, f: () => void) => { handlers.set(t, f); },
      removeEventListener: (t: string) => { handlers.delete(t); },
    };
    a.armAudioOnGesture(target as unknown as EventTarget);
    expect(contexts).toBe(0);
    handlers.get('pointerdown')!();
    expect(contexts).toBe(1);
    expect(handlers.size).toBe(0);
    expect(a.audioReady()).toBe(true);
  });

  it('every sound starts at least one source after initAudio', async () => {
    vi.stubGlobal('AudioContext', FakeAC);
    const a = await load();
    a.initAudio();
    for (const s of ['resize', 'place', 'delete', 'paste', 'error', 'select'] as const) {
      const before = started();
      a.playSound(s, 4);
      expect(started(), s).toBeGreaterThan(before);
    }
  });

  it('mute silences everything and persists', async () => {
    vi.stubGlobal('AudioContext', FakeAC);
    let a = await load();
    a.initAudio();
    expect(a.isMuted()).toBe(false);
    expect(a.toggleMute()).toBe(true);
    const before = started();
    a.playClick(); a.playError(); a.playPaste();
    expect(started()).toBe(before);
    expect(store.get(a.MUTE_KEY)).toBe('1');
    a = await load();
    expect(a.isMuted()).toBe(true);
  });

  it('volume is clamped and persists; bad stored values fall back to the default', async () => {
    let a = await load();
    expect(a.getVolume()).toBe(a.DEFAULT_VOLUME);
    a.setVolume(2); expect(a.getVolume()).toBe(1);
    a.setVolume(-1); expect(a.getVolume()).toBe(0);
    a.setVolume(0.25);
    a = await load();
    expect(a.getVolume()).toBe(0.25);
    store.set(a.VOLUME_KEY, 'nope');
    a = await load();
    expect(a.getVolume()).toBe(a.DEFAULT_VOLUME);
  });

  it('survives storage that throws and a missing AudioContext', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    const a = await load();
    expect(a.isMuted()).toBe(false);
    a.setMuted(true); a.setVolume(0.5);
    a.initAudio(); a.playClick();
    expect(contexts).toBe(0);
  });

  it('resize pitch rises with size and stays in a 300-600 Hz band', async () => {
    const a = await load();
    expect(a.resizePitch(1)).toBe(300);
    expect(a.resizePitch(2)).toBeGreaterThan(a.resizePitch(1));
    expect(a.resizePitch(13)).toBeCloseTo(300 * Math.SQRT2, 6);
    for (let s = -5; s < 200; s++) {
      expect(a.resizePitch(s)).toBeGreaterThanOrEqual(300);
      expect(a.resizePitch(s)).toBeLessThan(600);
    }
    expect(a.resizePitch(NaN)).toBe(300);
  });

  it('drops resize ticks closer together than the minimum gap', async () => {
    vi.stubGlobal('AudioContext', FakeAC);
    const a = await load();
    a.initAudio();
    const before = started();
    a.playResize(2); const one = started();
    a.playResize(3);
    expect(one).toBeGreaterThan(before);
    expect(started()).toBe(one);
  });
});
