// The Sound row in the left column: a mute toggle and a master volume slider for the editor's
// synthesised sounds (src/ui/audio.ts keeps both in localStorage).

import { $ } from '../dom.ts';
import { getVolume, initAudio, isMuted, playSelect, setMuted, setVolume } from '../audio.ts';

export function initSoundPanel(): void {
  const btn = $<HTMLButtonElement>('mute'), vol = $<HTMLInputElement>('vol'), box = $('soundbox');
  const sync = (): void => {
    const m = isMuted();
    btn.setAttribute('aria-pressed', String(m)); btn.textContent = m ? 'Muted' : 'On';
    btn.title = m ? 'Unmute the editor sounds' : 'Mute the editor sounds';
    vol.value = String(Math.round(getVolume() * 100));
  };
  btn.addEventListener('click', () => { setMuted(!isMuted()); sync(); initAudio(); playSelect(); });
  vol.addEventListener('input', () => { setVolume(+vol.value / 100); if (isMuted()) setMuted(false); sync(); });
  vol.addEventListener('change', () => { initAudio(); playSelect(); });   // a preview tick at the new level
  for (const t of ['pointerdown', 'dblclick']) box.addEventListener(t, (e) => e.stopPropagation());
  sync();
}
