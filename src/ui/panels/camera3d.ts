import { $ } from '../dom.ts';
import { S } from '../../app/state.ts';
import { isFree } from '../../app/mode.ts';
import { isTyping } from '../../editor/input.ts';
import { persp } from '../../render/persp.ts';
import { resetRoot, setFly, setFollow, setPerspective } from '../../render/perspcam.ts';
import { initAudio, playClick } from '../audio.ts';
import { placeholder } from '../placeholder.ts';

const TEXT = {
  persp: placeholder('[TEXT: Perspective (V)]'),
  fly: placeholder('[TEXT: Fly (F)]'),
  follow: placeholder('[TEXT: Follow (T)]'),
};
const TITLE = {
  persp: placeholder('[TEXT: Perspective camera title]'),
  fly: placeholder('[TEXT: Fly title]'),
  follow: placeholder('[TEXT: Follow title]'),
};

function button(id: string, text: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.id = id; b.textContent = text; b.title = title; b.setAttribute('aria-pressed', 'false');
  $('viewbox').append(b);
  return b;
}

export function initCamera3d(): void {
  const pb = button('persp', TEXT.persp, TITLE.persp);
  const fb = button('perspfly', TEXT.fly, TITLE.fly);
  const tb = button('perspfollow', TEXT.follow, TITLE.follow);
  const sync = (): void => {
    pb.setAttribute('aria-pressed', String(persp.on));
    fb.setAttribute('aria-pressed', String(persp.fly));
    tb.setAttribute('aria-pressed', String(persp.follow));
    fb.hidden = tb.hidden = !persp.on;
  };
  const act = (f: () => void): void => { if (!isFree()) return; f(); sync(); initAudio(); playClick(); };
  const togglePersp = (): void => act(() => setPerspective(!persp.on));
  const toggleFly = (): void => act(() => setFly(!persp.fly));
  const toggleFollow = (): void => act(() => setFollow(!persp.follow));
  pb.addEventListener('click', togglePersp);
  fb.addEventListener('click', toggleFly);
  tb.addEventListener('click', toggleFollow);
  addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'v') { e.preventDefault(); togglePersp(); }
    else if (persp.on && k === 'f') { e.preventDefault(); toggleFly(); }
    else if (persp.on && k === 't') { e.preventDefault(); toggleFollow(); }
  });
  S.hooks.loaded.push(() => { resetRoot(); sync(); });
  sync();
}
