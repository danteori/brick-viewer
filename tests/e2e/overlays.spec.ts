// Regression: the UI overlays (hover / grab wash, the resize ghost, their outlines) are translucent
// washes over the right face. On ANGLE's D3D11 backend, flat varyings in the brick shader once made
// the outline line draws come out as filled triangles: an opaque white ghost and a white wedge over
// the front face. On Windows this file runs on D3D11 (the GPU backend users have), elsewhere on the
// default backend.

import { expect, test, type Page } from '@playwright/test';

if (process.platform === 'win32') test.use({ launchOptions: { args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] } });

type P2 = [number, number];
interface Api { settle(): Promise<number>; project(x: number, y: number, z: number): P2; focusBox(): { lo: number[]; hi: number[] } }
type W = { __brickTest: Api };

const frames = (page: Page, n = 4): Promise<void> => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
const onFocus = (page: Page, f: [number, number, number]): Promise<P2> => page.evaluate((f) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.focusBox();
  return t.project(...(f.map((v, i) => lo[i]! + (hi[i]! - lo[i]!) * v) as [number, number, number]));
}, f);
/** canvas pixel (CSS px; deviceScaleFactor 1) from a screenshot */
async function pixel(page: Page, at: P2): Promise<number[]> {
  const png = await page.screenshot({ clip: { x: Math.round(at[0]), y: Math.round(at[1]), width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
    return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, png.toString('base64'));
}

test('hover wash and resize ghost stay translucent, on their own face', async ({ page }) => {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.evaluate(() => (window as unknown as W).__brickTest.settle());
  await frames(page);
  const front = await onFocus(page, [0.5, 0, 0.75]), top = await onFocus(page, [0.5, 0.5, 1]);
  // hover the top face: the grab wash brightens it a little; the front face stays brick red
  await page.mouse.move(top[0], top[1]); await frames(page);
  const f = await pixel(page, front);
  expect(Math.min(...f), `front pixel ${f.join(',')}`).toBeLessThan(195);
  // drag the top face up two plates: the ghost slab above is a faint wash, not opaque white
  await page.mouse.down();
  await page.mouse.move(top[0], top[1] - 60, { steps: 8 }); await frames(page);
  const slab = await onFocus(page, [0.5, 0.5, 1.4]);
  const c = await pixel(page, slab);
  expect(Math.min(...c), `ghost pixel ${c.join(',')}`).toBeLessThan(200);
  await page.mouse.up();
});
