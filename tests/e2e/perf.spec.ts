// U-02 render optimisations keep the picture: hidden-face culling changes no pixel at full detail,
// and the far LOD switches on when zoomed far out and draws fewer instances. Synthetic save, no private data.
// Drives the dev server's own modules (same instances the app uses) to flip the switches.

import { expect, test, type Page } from '@playwright/test';
import { synthSave, type SynthBrick } from '../unit/synthsave.ts';

test.describe.configure({ timeout: 120_000 });

interface Api { hideUi(): void; loadSave(b64: string, name: string): { bricks: number }; settle(): Promise<number>; renderStats(): { draws: number; instances: number } }
type W = { __brickTest: Api };

// a 12 x 12 x 6 block of 2x2 bricks (lots of covered faces), a glass and a glow brick on top
const bricks: SynthBrick[] = [];
for (let z = 0; z < 6; z++) for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++)
  bricks.push({ asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [x * 20, y * 20, 6 + z * 12], color: [60 + x * 15, 90 + y * 10, 120 + z * 20] });
bricks.push({ asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [0, 0, 78], color: [120, 180, 255], material: 'BMC_Glass', intensity: 0 });
bricks.push({ asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [40, 0, 78], color: [255, 240, 200], material: 'BMC_Glow', intensity: 10 });
const save = Buffer.from(synthSave(bricks)).toString('base64');

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.evaluate(async (b64) => {
    const t = (window as unknown as W).__brickTest;
    t.hideUi(); t.loadSave(b64, 'perf.brz'); await t.settle();
  }, save);
  return errors;
}

const shot = async (page: Page): Promise<Buffer> => page.locator('canvas#c').screenshot();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = any;
/** A dev-server module by path (the instance the app runs), inside page.evaluate. */
declare function devImport(p: string): Promise<Mod>;

test('hidden-face culling changes no pixel at full detail', async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => { (window as unknown as { devImport: typeof devImport }).devImport = (p: string) => import(/* @vite-ignore */ p) as Promise<Mod>; });
  const hidden = await page.evaluate(() => devImport('/src/render/facecull.ts').then((m: Mod) => m.faceCull.hiddenFaces as number));
  expect(hidden).toBeGreaterThan(1000);
  const on = await shot(page);
  await page.evaluate(async () => {
    const fc = await devImport('/src/render/facecull.ts'), sync = await devImport('/src/scene/sync.ts');
    fc.faceCull.on = false; sync.resyncAll();
    await (window as unknown as W).__brickTest.settle();
  });
  const off = await shot(page);
  expect(on.equals(off)).toBe(true);
  expect(errors).toEqual([]);
});

test('far LOD switches on when zoomed far out', async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => { (window as unknown as { devImport: typeof devImport }).devImport = (p: string) => import(/* @vite-ignore */ p) as Promise<Mod>; });
  const far = async (lod: boolean): Promise<{ draws: number; instances: number }> => page.evaluate(async (on) => {
    const t = (window as unknown as W).__brickTest, L = await devImport('/src/render/lod.ts'), st = await devImport('/src/app/state.ts');
    L.lodSettings.on = on;
    st.S.zoomMul = 3000; await t.settle();
    return t.renderStats();
  }, lod);
  const full = await far(false), coarse = await far(true);
  expect(coarse.instances).toBeLessThan(full.instances);
  expect(errors).toEqual([]);
});
