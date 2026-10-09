// Phase 0 placeholder: points at the legacy viewer and proves the format code is bundled by
// reading a dropped .brz (nothing leaves the browser). Phase 1 replaces this with the real app.
import { readBrzArchive } from '../format/brz.ts';
import { extractBricks } from '../format/world.ts';
import { FEATURES, IS_LITE } from './features.ts';

export function mountPlaceholder(root: HTMLElement, legacyHref: string): void {
  const on = Object.entries(FEATURES).filter(([, v]) => v).map(([k]) => k).join(', ');
  root.innerHTML = `
    <main class="ph">
      <h1>Brick viewer <small>${IS_LITE ? 'lite' : 'full'} build, work in progress</small></h1>
      <p>The new viewer is being built. Until it's ready, use the
        <a id="legacy" href="${legacyHref}">current viewer</a>.</p>
      <p class="drop" id="drop">Drop a <code>.brz</code> here to check it reads (stays in your browser).</p>
      <pre id="out" aria-live="polite"></pre>
      <p class="small">Features in this build: ${on}.</p>
      <p class="small">Not affiliated with or endorsed by Brickadia.</p>
    </main>`;
  const out = root.querySelector<HTMLPreElement>('#out')!;
  const drop = root.querySelector<HTMLElement>('#drop')!;
  addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  addEventListener('dragleave', () => drop.classList.remove('over'));
  addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    try {
      const a = readBrzArchive(await f.arrayBuffer(), { verify: true });
      let bricks = '-';
      try { bricks = String(extractBricks(a.files).bricks.length); } catch (err) { bricks = `n/a (${(err as Error).message})`; }
      out.textContent = `${f.name}: ${a.files.size} files, hashes OK, ${bricks} bricks in grid 1`;
    } catch (err) {
      out.textContent = `${f.name}: ${(err as Error).message}`;
    }
  });
}
