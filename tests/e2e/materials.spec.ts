// L-02 / U-15: glass, translucent plastic, glow, metallic and hologram draw without errors in both builds, and the full build
// adds a bloom halo around a bright glow brick (lite skips bloom). Synthetic save, no private data.

import { expect, test, type Page } from '@playwright/test';
import { synthSave } from '../unit/synthsave.ts';

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
