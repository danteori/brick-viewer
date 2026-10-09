// Golden capture: renders reference screenshots of the 3D view with Playwright on SwiftShader.
//
//   npm run golden:capture                         legacy viewer -> tests/golden/ (the goldens)
//   npm run golden:capture -- --target full        new app (dist/)          -> tests/golden/full/
//   npm run golden:capture -- --target lite        new app (dist-lite/)     -> tests/golden/lite/
//   npm run golden:capture -- ships                only saves whose path contains "ships"
//
// Every target is driven through the same page API, window.__brickTest:
//   - the new app has it built in (load it with ?test);
//   - for the frozen legacy/save-viewer.html this script builds it from the page's top-level
//     bindings (loadSave, orbit, zoomMul, lighting, cam, isoSettling). The legacy file is untouched.
// Before each screenshot the UI panels, labels and HUD are hidden and the editor ghost and hover
// highlights are off, so the goldens compare the 3D render only.
//
// The PNGs are renders of PRIVATE saves: tests/golden/ (subfolders included) is git-ignored and the
// images stay on this machine. Saves come from BRICK_REFS (default ../references); without it the
// script exits cleanly. Compare with scripts/golden-compare.mjs.

import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const REFS = resolve(ROOT, process.env.BRICK_REFS ?? '../references');
const VIEWPORT = { width: 1280, height: 800 };
const args = process.argv.slice(2);
const ti = args.indexOf('--target');
const TARGET = ti >= 0 ? args[ti + 1] : 'legacy';
const filter = args.filter((a, i) => !a.startsWith('--') && i !== ti + 1)[0] ?? '';
if (!['legacy', 'full', 'lite'].includes(TARGET)) { console.error(`unknown target ${TARGET}`); process.exit(2); }
const OUT = TARGET === 'legacy' ? join(ROOT, 'tests/golden') : join(ROOT, `tests/golden/${TARGET}`);

if (!existsSync(join(REFS, 'saves'))) {
  console.log(`no reference saves at ${REFS}; nothing to capture`);
  process.exit(0);
}

// Which saves to shoot: golden.config.json (git-ignored, so private save names stay out of the
// repo) as {"saves": ["saves/a.brz" | {"save": "saves/b.brz", "views": ["iso0", "below"]}, ...],
// "presetSave": "saves/a.brz"}, paths relative to BRICK_REFS. Without it: every top-level
// saves/*.brz, presets on the first.
const CONFIG = join(ROOT, 'golden.config.json');
const config = existsSync(CONFIG)
  ? JSON.parse(readFileSync(CONFIG, 'utf8'))
  : { saves: readdirSync(join(REFS, 'saves')).filter((n) => n.endsWith('.brz')).sort().map((n) => `saves/${n}`) };
const ENTRIES = config.saves.map((s) => (typeof s === 'string' ? { save: s } : s)).filter((s) => s.save.includes(filter));
const PRESETS = ['white', 'default', 'afternoon', 'overcast', 'night'];
const PALETTE = config.presetSave ?? ENTRIES[0]?.save;

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

// The new app is served over http (module scripts don't load from file://).
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
async function serve(dir) {
  const server = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = join(dir, p.endsWith('/') ? p + 'index.html' : p);
    if (!f.startsWith(dir) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

let pageUrl, server = null;
if (TARGET === 'legacy') pageUrl = pathToFileURL(join(ROOT, 'legacy/save-viewer.html')).href;
else {
  const dir = join(ROOT, TARGET === 'full' ? 'dist' : 'dist-lite');
  const entry = TARGET === 'full' ? 'index.html' : 'brick-viewer.html';
  if (!existsSync(join(dir, entry))) { console.error(`missing ${dir}/${entry}; run npm run build first`); process.exit(1); }
  const s = await serve(dir);
  server = s.server;
  pageUrl = `${s.url}/${entry}?test`;
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(pageUrl);
if (TARGET === 'legacy') {
  await page.waitForFunction(() => typeof loadSave === 'function' && typeof isoSettling === 'function');
  await installLegacyAdapter(page);
}
await page.waitForFunction(() => !!window.__brickTest?.ready);
const renderer = await page.evaluate(() => window.__brickTest.renderer());
console.log(`target: ${TARGET}, renderer: ${renderer}`);
await page.evaluate(() => window.__brickTest.hideUi());

const shots = [];
async function shoot(file, meta) {
  const frames = await page.evaluate(() => window.__brickTest.settle());
  await page.screenshot({ path: join(OUT, file), animations: 'disabled', caret: 'hide' });
  shots.push({ file, ...meta, settleFrames: frames });
  console.log(`${file}${frames < 0 ? '  (did not settle)' : ''}`);
}
const setView = (v, baseZoom) => page.evaluate((a) => window.__brickTest.setView(a), { k: v.k, pitchDeg: v.pitchDeg, zoom: v.zoom, baseZoom });
const setPreset = (p) => page.evaluate((p) => window.__brickTest.setPreset(p), p);

// the startup scene (one red 2x2), before any save is loaded
if (!filter) {
  await setPreset('default');
  await setView(VIEWS[0], 1);
  await shoot('startup__iso0.png', { save: null, view: 'iso0', preset: 'default' });
}

for (const entry of ENTRIES) {
  const rel = entry.save, path = join(REFS, rel);
  if (!existsSync(path)) { console.log(`skip (missing): ${rel}`); continue; }
  const stem = basename(rel, '.brz');
  const b64 = readFileSync(path).toString('base64');
  const status = await page.evaluate(({ b64, name }) => window.__brickTest.loadSave(b64, name), { b64, name: basename(rel) });
  console.log(`loaded ${rel}: ${status.status}`);
  await setPreset('default');
  for (const v of VIEWS.filter((v) => !entry.views || entry.views.includes(v.name))) {
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
  target: TARGET,
  chromium: browser.version(),
  renderer,
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  errors,
  shots,
};
writeFileSync(join(OUT, filter ? `manifest.${filter}.json` : 'manifest.json'), JSON.stringify(manifest, null, 2));
await browser.close();
server?.close();
console.log(`${shots.length} shots, ${errors.length} page errors -> ${OUT}`);
if (errors.length) console.log(errors.join('\n'));

/**
 * Builds window.__brickTest for the frozen legacy viewer from its top-level bindings. Draw calls
 * are skipped while the camera settles (the camera maths doesn't depend on them), so the few
 * hundred frames an exact settle takes are cheap under SwiftShader.
 */
async function installLegacyAdapter(page) {
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
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    window.__brickTest = {
      ready: true,
      renderer() {
        const gl = document.createElement('canvas').getContext('webgl');
        if (!gl) return 'no WebGL';
        const e = gl.getExtension('WEBGL_debug_renderer_info');
        return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      },
      // UI panels, labels and HUD hidden; no editor ghost, no hover highlight
      hideUi() {
        const st = document.createElement('style');
        st.textContent = 'body > :not(canvas) { visibility: hidden !important; } body.drop::after { display: none !important; }';
        document.head.append(st);
        window.editorDraw = () => {};
        mouse = null;
      },
      loadSave(b64, name) {
        const bin = atob(b64), u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        loadSave(u.buffer, name);
        return { status: document.getElementById('status')?.textContent ?? '', bricks: bricks.length, zoom: zoomMul };
      },
      setView({ k, pitchDeg, zoom, baseZoom }) {
        orbit.yaw = orbit.yawT = YAW0 + k * Math.PI / 2;
        orbit.pitch = orbit.pitchT = pitchDeg === undefined ? ELEV : pitchDeg * Math.PI / 180;
        viewT = viewOf(orbit.yawT, orbit.pitchT);
        updateDirs();
        zoomMul = baseZoom * (zoom ?? 1);
      },
      setPreset(p) { lighting = p; lightSel.value = p; },
      /**
       * Waits until the iso ease and the camera glide have stopped: cam unchanged (to 1e-12) for
       * 6 frames. Sub-pixel camera drift shows in the fine grid lines, so near enough isn't. Then
       * renders a few real frames. Returns frames waited (-1 = timed out).
       */
      async settle() {
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
      },
    };
  });
}
