// Dev-only page (sound-demo.html, served by `npm run dev`, not part of either build):
// one button per UI sound, plus the master volume and mute.

import { armAudioOnGesture, getVolume, initAudio, isMuted, playSound, setMuted, setVolume, type SoundName } from '../ui/audio.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const SOUNDS: [SoundName, string][] = [
  ['resize', 'Resize tick'], ['place', 'Place click'], ['delete', 'Delete pop'],
  ['paste', 'Paste whoosh'], ['error', 'Error buzz'], ['select', 'Select tick'],
];

armAudioOnGesture();
const step = $<HTMLInputElement>('step'), stepv = $('stepv');
step.oninput = () => { stepv.textContent = step.value; initAudio(); playSound('resize', +step.value); };

const grid = $('sounds');
for (const [name, label] of SOUNDS) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label;
  b.onclick = () => { initAudio(); playSound(name, +step.value); };
  grid.appendChild(b);
}

$('sweep').onclick = () => {
  initAudio();
  for (let s = 1; s <= 24; s++) setTimeout(() => playSound('resize', s), (s - 1) * 60);
};

const vol = $<HTMLInputElement>('vol'), volv = $('volv'), mute = $<HTMLInputElement>('mute');
const show = (): void => { vol.value = String(getVolume()); volv.textContent = `${Math.round(getVolume() * 100)}%`; mute.checked = isMuted(); };
vol.oninput = () => { setVolume(+vol.value); show(); };
mute.onchange = () => { setMuted(mute.checked); show(); };
show();
