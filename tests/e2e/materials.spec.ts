// L-02 / U-15: glass, translucent plastic, glow, metallic and hologram draw without errors in both builds, and the full build
// adds a bloom halo around a bright glow brick (lite skips bloom). Synthetic save, no private data.

import { expect, test, type Page } from '@playwright/test';
import { synthSave, type SynthBrick } from '../unit/synthsave.ts';

test.describe.configure({ timeout: 90_000 });

interface Api { hideUi(): void; loadSave(b64: string, name: string): { bricks: number }; settle(): Promise<number>; brickBox(k: number): { lo: number[]; hi: number[] }; project(x: number, y: number, z: number): [number, number] }
type W = { __brickTest: Api };

const save = Buffer.from(synthSave([
  { asset: 'PB_DefaultBrick', size: [20, 20, 12], pos: [0, 0, 12], color: [255, 240, 200], material: 'BMC_Glow', intensity: 10 },
  { asset: 'PB_DefaultBrick', size: [20, 20, 12], pos: [400, 0, 12], color: [120, 180, 255], material: 'BMC_Glass', intensity: 0 },
  { asset: 'PB_DefaultBrick', size: [20, 20, 12], pos: [400, 60, 12], color: [255, 80, 80], material: 'BMC_TranslucentPlastic', intensity: 5 },
  { asset: 'PB_DefaultBrick', size: [20, 20, 12], pos: [460, 0, 12], color: [220, 40, 40], material: 'BMC_Metallic', intensity: 10 },
  { asset: 'PB_DefaultBrick', size: [20, 20, 12], pos: [460, 60, 12], color: [220, 0, 13], material: 'BMC_Hologram', intensity: 6 },
  { asset: 'PB_DefaultBrick', size: [40, 40, 6], pos: [400, 30, -6], color: [230, 230, 230] },
])).toString('base64');

/** brightness of the background just right of the glow brick (brick 0), from a screenshot */
async function halo(page: Page): Promise<{ near: number; errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  const at = await page.evaluate(async (b64) => {
    const t = (window as unknown as W).__brickTest;
    t.hideUi(); t.loadSave(b64, 'materials.brz'); await t.settle();
    const { lo, hi } = t.brickBox(0);
    let mx = -1e9, my = 0, n = 0;
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) { const p = t.project(x, y, z); mx = Math.max(mx, p[0]); my += p[1]; n++; }
    return [Math.round(mx + 8), Math.round(my / n)];
  }, save);
  const shot = (await page.screenshot()).toString('base64');
  const near = await page.evaluate(async ([b64, x, y]) => {   // decode the screenshot in the page
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
    const d = g.getImageData(x, y, 1, 1).data;
    return d[0]! + d[1]! + d[2]!;
  }, [shot, at[0]!, at[1]!] as const);
  return { near, errors };
}

test('glass, translucent, glow, metallic and hologram render in both builds; only full blooms', async ({ page }) => {
  await page.goto('/lite.html?test');
  const lite = await halo(page);
  await page.goto('/?test');
  const full = await halo(page);
  expect(lite.errors).toEqual([]);
  expect(full.errors).toEqual([]);
  expect(full.near).toBeGreaterThan(lite.near + 6);   // the halo lifts the background next to the glow brick
});

// over EXACT_SPECIAL (render/matpass.ts) the special bricks come from the instance buffers: 144 metallic and 144 hologram 1x1 bricks
// (red) on a white floor, in both builds; the middle of each grid must show red, without errors
const grid = (material: string, x0: number): SynthBrick[] => Array.from({ length: 144 }, (_, k) => (
  { asset: 'PB_DefaultBrick', size: [5, 5, 12], pos: [x0 + (k % 12) * 10, Math.floor(k / 12) * 10, 12], color: [220, 20, 20], material, intensity: 6 }));
const big = Buffer.from(synthSave([
  ...grid('BMC_Metallic', 0), ...grid('BMC_Hologram', 200),
  { asset: 'PB_DefaultBrick', size: [200, 80, 6], pos: [150, 55, -6], color: [230, 230, 230] },
])).toString('base64');

test('metallic and hologram draw instanced in big builds', async ({ page }) => {
  for (const url of ['/lite.html?test', '/?test']) {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
    const at = await page.evaluate(async (b64) => {
      const t = (window as unknown as W).__brickTest;
      const n = t.loadSave(b64, 'materials-big.brz').bricks;
      t.hideUi(); await t.settle();
      // the two grids' middle bricks (load order isn't save order): split the 1x1 bricks by x, take the one nearest each half's mean
      const c = Array.from({ length: n }, (_, k) => t.brickBox(k)).filter((b) => b.hi[0]! - b.lo[0]! < 20)
        .map((b) => [(b.lo[0]! + b.hi[0]!) / 2, (b.lo[1]! + b.hi[1]!) / 2, b.hi[2]!] as const).sort((a, b) => a[0] - b[0]);
      return [c.slice(0, c.length / 2), c.slice(c.length / 2)].map((h) => {
        const m = [0, 1].map((i) => h.reduce((s, p) => s + p[i]!, 0) / h.length);
        const p = h.reduce((a, b) => (Math.hypot(b[0] - m[0]!, b[1] - m[1]!) < Math.hypot(a[0] - m[0]!, a[1] - m[1]!) ? b : a));
        return t.project(p[0], p[1], p[2]);
      });
    }, big);
    const shot = (await page.screenshot()).toString('base64');
    const px = await page.evaluate(async ([b64, pts]) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
      return pts.map(([x, y]) => Array.from(g.getImageData(Math.round(x!), Math.round(y!), 1, 1).data));
    }, [shot, at] as const);
    for (const p of px) expect(p[0]! - p[1]!, `${url} ${JSON.stringify(px)}`).toBeGreaterThan(40);
    expect(errors).toEqual([]);
  }
});
