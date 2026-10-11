// Graphics effects (L-03) and the Graphics panel (L-06). ?test starts with the effects off; the
// test hook turns them on. Startup brick only, no private data.

import { expect, test, type Page } from '@playwright/test';

interface GState { shadow: boolean; shadowTexel: number; ao: number; water: boolean; on: boolean }
interface Api {
  settle(): Promise<number>;
  setGraphics(a: { on: boolean; level?: number; env?: 'none' | 'default' | 'water' }): void;
  graphicsState(): GState;
}
type W = { __brickTest: Api };

test.describe.configure({ timeout: 180_000 });

const frames = (page: Page, n = 4): Promise<void> => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);
const gstate = (page: Page): Promise<GState> => page.evaluate(() => (window as unknown as W).__brickTest.graphicsState());
// a patch of background (right of the left column, below the properties panel)
const centre = async (page: Page): Promise<string> => (await page.screenshot({ clip: { x: 980, y: 540, width: 12, height: 12 } })).toString('base64');

test('effects are off in ?test, then shadows, SSAO and water run without GL errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || /GL_INVALID|WebGL:/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.evaluate(() => (window as unknown as W).__brickTest.settle());
  await frames(page);
  expect((await gstate(page)).on).toBe(false);
  const before = await centre(page);

  await page.evaluate(() => (window as unknown as W).__brickTest.setGraphics({ on: true, env: 'water' }));
  await frames(page, 6);
  const s = await gstate(page);
  expect(s.on).toBe(true);
  expect(s.shadow).toBe(true);
  expect(s.shadowTexel).toBeGreaterThan(0);
  expect(s.ao).toBeGreaterThan(0);
  expect(s.water).toBe(true);
  expect(await centre(page)).not.toEqual(before);                      // the background is no longer flat

  await page.evaluate(() => (window as unknown as W).__brickTest.setGraphics({ on: true, level: 0, env: 'none' }));
  await frames(page, 4);
  const low = await gstate(page);
  expect([low.shadow, low.ao, low.water]).toEqual([false, 0, false]);   // Low: no shadows / SSAO; no environment: no water

  await page.evaluate(() => (window as unknown as W).__brickTest.setGraphics({ on: false, env: 'none' }));
  await frames(page, 4);
  expect(await centre(page)).toEqual(before);                          // off again: the original frame
  expect(errors).toEqual([]);
});

test('the Graphics panel loads a game preset and marks what is not implemented', async ({ page }) => {
  await page.goto('/?test');
  await page.waitForSelector('#gfxbtn');
  await page.locator('#gfxbtn').click();
  const panel = page.locator('#gfxpanel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.envp-ni').first()).toHaveText('Not Implemented');
  const bp = ['{', '\t"formatVersion": "1",', '\t"presetVersion": "1",', '\t"type": "Options/Graphics",', '\t"data":', '\t{',
    '\t\t"shadowQuality": 0,', '\t\t"postProcessingQuality": 1,', '\t\t"oldKey": true', '\t}', '}'].join('\r\n');
  await panel.locator('input[type=file]').setInputFiles({ name: 'test.bp', mimeType: 'application/json', buffer: Buffer.from(bp) });
  await expect(panel.locator('.envp-status')).toContainText('Loaded test.bp');
  await expect(panel.getByLabel('Shadows', { exact: true })).toHaveValue('0');
  await expect(panel.getByText('Other (from the file)')).toBeVisible();
  // saving writes the file back with its own spelling, the edit and the unknown key
  await panel.getByLabel('Shadows', { exact: true }).selectOption('3');
  await panel.getByRole('button', { name: /PRESETS/ }).click();
  const dl = page.waitForEvent('download');
  await panel.getByRole('menuitem', { name: 'Save .bp' }).click();
  const text = await (await dl).createReadStream().then(async (st) => { let s = ''; for await (const c of st) s += String(c); return s; });
  expect(text).toContain('"shadowQuality": 3');
  expect(text).toContain('"oldKey": true');
  // the Environment panel marks its unrendered rows too
  await page.locator('#envbtn').click();
  await expect(page.locator('#gfxpanel')).toBeHidden();
  await expect(page.locator('#envpanel [data-key="rain"] .envp-ni')).toHaveCount(1);
  await expect(page.locator('#envpanel [data-key="wind"] .envp-ni')).toHaveCount(0);
});
