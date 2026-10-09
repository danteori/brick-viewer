// Sounds. The release click is synthesized (a short band-passed noise tick plus a soft low thump).
// The resize ticks need sound clips, which this repository doesn't ship, so they are silent;
// playResize stays as the hook for them.

const CLICK_GAIN = 0.5;
let ac: AudioContext | null = null, clickBuf: AudioBuffer | null = null;

/** needs a user gesture; called from pointer / key input */
export function initAudio(): void {
  if (ac) { if (ac.state === 'suspended') void ac.resume(); return; }
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  try {
    ac = new AC();
    // 40 ms click: decaying noise burst + 140 Hz thump
    const n = Math.round(ac.sampleRate * 0.04);
    clickBuf = ac.createBuffer(1, n, ac.sampleRate);
    const d = clickBuf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ac.sampleRate;
      d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 260) * 0.8 + Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t * 90) * 0.6;
    }
  } catch { ac = null; }
}

/** a resize step (silent: no clips bundled) */
export function playResize(): void { /* no resize clips in this build */ }

export function playClick(): void {
  if (!ac || ac.state !== 'running' || !clickBuf) return;
  const src = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = clickBuf; bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
  g.gain.value = CLICK_GAIN;
  src.connect(bp); bp.connect(g); g.connect(ac.destination); src.start();
}
