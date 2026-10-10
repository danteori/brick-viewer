import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
const dir = resolve(process.argv[2]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = createServer((req, res) => { const p = decodeURIComponent(new URL(req.url, 'http://x').pathname); const f = join(dir, p.endsWith('/') ? p + 'index.html' : p); if (!existsSync(f)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' }); res.end(readFileSync(f)); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?test`);
await page.waitForFunction(() => !!window.__brickTest);
console.log('ready ms', Date.now() - t0, await page.evaluate(() => window.__brickTest.renderer()));
const r = await page.evaluate(async () => {
  const gl = document.getElementById('c').getContext('webgl2'), px = new Uint8Array(4), out = [];
  for (let i = 0; i < 12; i++) { const t = performance.now(); await new Promise((r) => requestAnimationFrame(r)); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); out.push(performance.now() - t); }
  return out.map((v) => v.toFixed(0)).join(' ');
});
console.log('frames ms', r);
await b.close(); server.close();
