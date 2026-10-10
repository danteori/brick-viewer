// Transparent bricks are one-sided, as in the game: from above, a glass or translucent smooth tile
// shows nothing of its own underside (sockets, rim) through its plain top. Synthetic save, no private data.

import { expect, test, type Page } from '@playwright/test';
import { synthSave } from '../unit/synthsave.ts';

test.describe.configure({ timeout: 120_000 });

interface Api { hideUi(): void; loadSave(b64: string, name: string): { bricks: number }; settle(): Promise<number>; brickBox(k: number): { lo: number[]; hi: number[] }; project(x: number, y: number, z: number): [number, number] }
type W = { __brickTest: Api };

// a big smooth tile of each material on a smooth white floor, the tile held well above the floor so its own underside isn't flush with the floor (test-only save)
const save = (material: string): string => Buffer.from(synthSave([
  { asset: 'PB_DefaultSmoothTile', size: [40, 40, 12], pos: [0, 0, 80], color: [120, 180, 255], material, intensity: 5 },
  { asset: 'PB_DefaultSmoothTile', size: [300, 300, 6], pos: [0, 0, 6], color: [240, 240, 240] },
])).toString('base64');

/** max - min brightness over a patch at the middle of the tile's top face (the smaller brick; load order isn't save order) */
async function topSpread(page: Page, b64: string): Promise<number> {
  const c = await page.evaluate(async (b64) => {
    const t = (window as unknown as W).__brickTest;
    t.hideUi(); t.loadSave(b64, 'oneside.brz'); await t.settle();
    const boxes = [0, 1].map((k) => t.brickBox(k));
    const { lo, hi } = boxes[0]!.hi[0]! - boxes[0]!.lo[0]! < boxes[1]!.hi[0]! - boxes[1]!.lo[0]! ? boxes[0]! : boxes[1]!;
    return t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2]);
  }, b64);
  const shot = (await page.screenshot()).toString('base64');
  return page.evaluate(async ([b64, x, y]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d')!; g.drawImage(img, 0, 0);
    const d = g.getImageData(Math.round(x) - 20, Math.round(y) - 10, 40, 20).data;
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < d.length; i += 4) { const v = d[i]! + d[i + 1]! + d[i + 2]!; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return hi - lo;
  }, [shot, c[0], c[1]] as const);
}

for (const m of ['BMC_Glass', 'BMC_TranslucentPlastic']) {
  test(`${m}: no underside texture shows through the top`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/?test');
    await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
    expect(await topSpread(page, save(m))).toBeLessThan(12);   // a flat, even patch: no sockets behind it
    expect(errors).toEqual([]);
  });
}
