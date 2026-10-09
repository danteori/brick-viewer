// Golden capture: drives the frozen legacy viewer (legacy/save-viewer.html) through its
// top-level bindings (loadSave, orbit, zoomMul, lighting, cam, isoSettling) and screenshots
// each view into tests/golden/. Those PNGs are renders of PRIVATE saves: tests/golden/ is
// git-ignored and the goldens stay on this machine.
//
//   npm run golden:capture                 all shots
//   npm run golden:capture -- ships        only saves whose path contains "ships"
//
// Saves come from BRICK_REFS (default ../references). Without it the script exits cleanly.
// Rendering uses Chromium with SwiftShader (software GL), so results don't depend on the GPU.

import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const REFS = resolve(ROOT, process.env.BRICK_REFS ?? '../references');
const OUT = join(ROOT, 'tests/golden');
const LEGACY = join(ROOT, 'legacy/save-viewer.html');
const VIEWPORT = { width: 1280, height: 800 };
const filter = process.argv[2] ?? '';

if (!existsSync(join(REFS, 'saves'))) {
  console.log(`no reference saves at ${REFS}; nothing to capture`);
  process.exit(0);
}

// Which saves to shoot: golden.config.json (git-ignored, so private save names stay out of the
// repo) as {"saves": ["saves/a.brz", ...], "presetSave": "saves/a.brz"}, paths relative to
// BRICK_REFS. Without it: every top-level saves/*.brz, presets on the first.
const CONFIG = join(ROOT, 'golden.config.json');
const config = existsSync(CONFIG)
  ? JSON.parse(readFileSync(CONFIG, 'utf8'))
  : { saves: readdirSync(join(REFS, 'saves')).filter((n) => n.endsWith('.brz')).sort().map((n) => `saves/${n}`) };
const SAVES = config.saves.filter((s) => s.includes(filter));
const PRESETS = ['white', 'default', 'afternoon', 'overcast', 'night'];
const PALETTE = config.presetSave ?? config.saves[0];

// Views relative to the framing loadSave picks. yaw k = iso corner k (YAW0 + k * 90 deg).
const VIEWS = [
  { name: 'iso0', k: 0 },
  { name: 'iso1', k: 1 },
  { name: 'iso2', k: 2 },
  { name: 'iso3', k: 3 },
  { name: 'below', k: 0, pitchDeg: -45 },
  { name: 'close', k: 0, zoom: 0.5 },
  { name: 'far', k: 0, zoom: 3 },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(pathToFileURL(LEGACY).href);
await page.waitForFunction(() => typeof loadSave === 'function' && typeof isoSettling === 'function');
const renderer = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl');
  if (!gl) return 'no WebGL';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});
console.log(`renderer: ${renderer}`);

// While the camera settles, draw calls are skipped (the camera maths doesn't depend on them), so
// the few hundred frames an exact settle takes are cheap under SwiftShader. The legacy file is
// untouched: this only patches the page's WebGL entry points.
await page.evaluate(() => {
  const patch = (proto, names) => {
    for (const n of names) {
      const orig = proto[n];
      if (typeof orig !== 'function') continue;
      proto[n] = function (...a) { if (!window.__skipDraws) return orig.apply(this, a); };
    }
  };
  patch(WebGLRenderingContext.prototype, ['drawArrays', 'drawElements', 'clear']);
  const ext = document.createElement('canvas').getContext('webgl')?.getExtension('ANGLE_instanced_arrays');
  if (ext) patch(Object.getPrototypeOf(ext), ['drawArraysInstancedANGLE', 'drawElementsInstancedANGLE']);
});

/**
 * Waits until the iso ease and the camera glide have stopped: cam unchanged (to 1e-12) for
 * 6 frames. Sub-pixel camera drift shows in the fine grid lines, so near enough isn't. Then
 * renders a few real frames. Returns frames waited (-1 = timed out).
 */
const settle = () => page.evaluate(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  window.__skipDraws = true;
  // the glide can end in a 1-ulp two-frame cycle, so a repeat of either of the last two states counts
  let prev = '', prev2 = '', same = 0, frames = -1;
  for (let i = 0; i < 4000; i++) {
    await raf();
    // 1e-12 absolute: a glide toward 0 only creeps through denormals, and this is far below a pixel
    const s = [cam.x, cam.y, cam.half, orbit.yaw, orbit.pitch].map((v) => Math.round(v * 1e12)).join();
    if (!isoSettling() && (s === prev || s === prev2)) { if (++same >= 6) { frames = i; break; } } else same = 0;
    prev2 = prev;
    prev = s;
  }
  window.__skipDraws = false;
  for (let i = 0; i < 3; i++) await raf();
  return frames;
});

const setView = (v, baseZoom) => page.evaluate(({ k, pitchDeg, zoom, baseZoom }) => {
  orbit.yaw = orbit.yawT = YAW0 + k * Math.PI / 2;
  orbit.pitch = orbit.pitchT = pitchDeg === undefined ? ELEV : pitchDeg * Math.PI / 180;
  viewT = viewOf(orbit.yawT, orbit.pitchT);
  updateDirs();
  zoomMul = baseZoom * (zoom ?? 1);
}, { k: v.k, pitchDeg: v.pitchDeg, zoom: v.zoom, baseZoom });

const setPreset = (p) => page.evaluate((p) => { lighting = p; lightSel.value = p; }, p);

const shots = [];
async function shoot(file, meta) {
  const frames = await settle();
  await page.screenshot({ path: join(OUT, file), animations: 'disabled', caret: 'hide' });
  shots.push({ file, ...meta, settleFrames: frames });
  console.log(`${file}${frames < 0 ? '  (did not settle)' : ''}`);
}

// the startup scene (one red 2x2), before any save is loaded
if (!filter) {
  await setPreset('default');
  await setView(VIEWS[0], 1);
  await shoot('startup__iso0.png', { save: null, view: 'iso0', preset: 'default' });
}

for (const rel of SAVES) {
  const path = join(REFS, rel);
  if (!existsSync(path)) { console.log(`skip (missing): ${rel}`); continue; }
  const stem = basename(rel, '.brz');
  const b64 = readFileSync(path).toString('base64');
  const status = await page.evaluate(({ b64, name }) => {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    loadSave(u.buffer, name);
    return { status: document.getElementById('status')?.textContent ?? '', bricks: bricks.length, zoom: zoomMul };
  }, { b64, name: basename(rel) });
  console.log(`loaded ${rel}: ${status.status}`);
  await setPreset('default');
  for (const v of VIEWS) {
    await setView(v, status.zoom);
    await shoot(`${stem}__${v.name}.png`, { save: rel, view: v, preset: 'default', bricks: status.bricks });
  }
  if (rel === PALETTE) {
    for (const p of PRESETS) {
      await setPreset(p);
      await setView(VIEWS[0], status.zoom);
      await shoot(`${stem}__preset-${p}.png`, { save: rel, view: VIEWS[0], preset: p, bricks: status.bricks });
    }
    await setPreset('default');
  }
}

const manifest = {
  note: 'Renders of private saves. Local only: never commit this folder.',
  captured: new Date().toISOString(),
  legacy: 'legacy/save-viewer.html',
  chromium: browser.version(),
  renderer,
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  errors,
  shots,
};
writeFileSync(join(OUT, filter ? `manifest.${filter}.json` : 'manifest.json'), JSON.stringify(manifest, null, 2));
await browser.close();
console.log(`${shots.length} shots, ${errors.length} page errors -> ${OUT}`);
if (errors.length) console.log(errors.join('\n'));
