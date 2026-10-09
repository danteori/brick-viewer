// Frame-time benchmark of the built app (ARCHITECTURE.md section 7): opens a save or world through
// the Open button of dist/ (or dist-lite/), lets the camera settle, then orbits a full turn and
// records the time between animation frames, with vsync and the frame-rate limit off so a frame's
// interval is its real cost.
//
//   node scripts/bench.mjs [--target full|lite] [--frames 240] [--swiftshader] [--runs 3] FILE...
//
// By default Chromium uses the machine's GPU (ANGLE on D3D11 on Windows); --swiftshader uses the
// software rasteriser the goldens use. Prints one line per file and run; nothing is stored.

import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const flag = (name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const TARGET = opt('--target', 'full'), FRAMES = Number(opt('--frames', 240)), RUNS = Number(opt('--runs', 3));
const SWIFT = flag('--swiftshader');
const files = args.map((f) => resolve(f));
if (!files.length) { console.error('usage: node scripts/bench.mjs [--target full|lite] [--frames N] [--runs N] [--swiftshader] FILE...'); process.exit(2); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const dir = join(ROOT, TARGET === 'full' ? 'dist' : 'dist-lite'), entry = TARGET === 'full' ? 'index.html' : 'brick-viewer.html';
if (!existsSync(join(dir, entry))) { console.error(`missing ${dir}/${entry}; run npm run build first`); process.exit(1); }
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = join(dir, p.endsWith('/') ? p + 'index.html' : p);
  if (!f.startsWith(dir) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/${entry}?test`;

const gpuArgs = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
const swiftArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: [...(SWIFT ? swiftArgs : gpuArgs), '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

for (const file of files) {
  for (let run = 0; run < RUNS; run++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => !!window.__brickTest);
    await page.evaluate(() => window.__brickTest.hideUi());
    const renderer = await page.evaluate(() => window.__brickTest.renderer());
    const before = await page.evaluate(() => document.getElementById('status')?.textContent ?? '');
    const t0 = Date.now();
    await page.setInputFiles('#pick', file);
    await page.waitForFunction((b) => { const s = document.getElementById('status')?.textContent ?? ''; return s !== b && /brick|Couldn't/.test(s) && !/^Loading|^Opening|Reading/.test(s); }, before, { timeout: 600_000, polling: 100 });
    const loadMs = Date.now() - t0;
    const info = await page.evaluate(() => ({ status: document.getElementById('status')?.textContent ?? '', zoom: window.__brickTest.snapshot().zoom }));
    await page.evaluate(() => window.__brickTest.settle());
    const res = await page.evaluate(async ({ n, zoom }) => {
      const t = window.__brickTest, raf = () => new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < 20; i++) await raf();                    // warm up
      const dts = [];
      let last = await raf();
      for (let i = 0; i < n; i++) {
        t.setView({ k: 4 * i / n, baseZoom: zoom });
        const now = await raf();
        dts.push(now - last); last = now;
      }
      return dts;
    }, { n: FRAMES, zoom: info.zoom });
    const mean = res.reduce((a, b) => a + b, 0) / res.length;
    const rs = await page.evaluate(() => window.__brickTest.renderStats?.() ?? null);
    console.log([basename(file), TARGET, SWIFT ? 'swiftshader' : 'gpu', `run ${run + 1}`, `load ${loadMs} ms`,
      `frame median ${q(res, 0.5).toFixed(2)} ms`, `p95 ${q(res, 0.95).toFixed(2)} ms`, `mean ${mean.toFixed(2)} ms`,
      rs ? `draws ${rs.draws} in ${rs.chunks} of ${rs.total} chunks` : '', info.status.slice(0, 120), errors.length ? `${errors.length} page errors: ${errors[0]}` : ''].join(' | '));
    if (run === 0) console.log(`  renderer: ${renderer}`);
    await ctx.close();
  }
}
await browser.close();
server.close();
