// Smoke tests for the integrated features: the Environment panel drives the lighting and the ground
// plate, paint (undoable), Save .brz, the Map, and opening a .brdb world with its revisions (that
// last one needs a private world from BRICK_REFS and is skipped without it).

import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REFS, referenceSaves, referenceWorlds } from '../unit/refs.ts';
import { synthSave } from '../unit/synthsave.ts';

// WebGL on the CI's software renderer (SwiftShader) is slow: room for a few hundred frames
test.describe.configure({ timeout: 90_000 });

const status = (page: Page) => page.locator('#status');

/** A small synthetic .brz (no private data) as a file payload. */
const synthFile = () => ({
  name: 'synthetic.brz', mimeType: 'application/octet-stream',
  buffer: Buffer.from(synthSave([
    { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [5, 5, 6], color: [200, 30, 30] },
    { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [45, 5, 6], color: [30, 200, 30] },
    { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [5000, 5, 6], color: [30, 30, 200] },
  ])),
});

test('environment panel lights the scene and shows the ground plate', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await expect(page.locator('#light option')).toHaveCount(5);
  await page.locator('#envbtn').click();
  await expect(page.locator('#envpanel .envp')).toBeVisible();
  const tod = page.locator('#envpanel input[type=number]').first();
  await tod.fill('18');
  await tod.press('Enter');
  await expect(page.locator('#light')).toHaveValue('env');
  await expect(page.locator('#light option')).toHaveCount(6);
  // another preset turns the environment off again
  await page.locator('#light').selectOption('night');
  await expect(page.locator('#light')).toHaveValue('night');
  expect(errors).toEqual([]);
});

test('paint the focused brick (nothing selected), then undo', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#chexout')).toHaveText('#fa4040');
  await page.locator('#painttoggle').click();
  const swatch = page.locator('.bvp-sw').nth(3);
  await expect(swatch).toBeVisible();
  await swatch.click();
  const hex = (await page.locator('.bvp-hex').textContent())!.toLowerCase();
  await page.getByRole('button', { name: 'Paint selection' }).click();
  await expect(page.locator('#chexout')).toHaveText(hex);
  await expect(status(page)).toContainText('Painted');
  await page.locator('canvas#c').hover({ position: { x: 640, y: 700 } });
  await page.keyboard.press('Control+z');
  await expect(page.locator('#chexout')).toHaveText('#fa4040');
});

test('save .brz downloads the scene and it opens again', async ({ page }) => {
  await page.goto('/');
  await page.locator('#savebrz').click();
  await expect(status(page)).toContainText('Open a save first');
  await page.locator('#pick').setInputFiles(synthFile());
  await expect(status(page)).toContainText('synthetic.brz: 3 bricks');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#savebrz').click()]);
  expect(dl.suggestedFilename()).toBe('synthetic (edited).brz');
  const bytes = readFileSync((await dl.path())!);
  expect(bytes.subarray(0, 3).toString('latin1')).toBe('BRZ');
  await page.locator('#pick').setInputFiles({ name: 'again.brz', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(status(page)).toContainText('again.brz: 3 bricks');
});

test('map shows the opened save and a click focuses a brick', async ({ page }) => {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as { __brickTest?: unknown }).__brickTest);
  await page.locator('#pick').setInputFiles(synthFile());
  await expect(status(page)).toContainText('3 bricks');
  await page.locator('#mapbtn').click();
  await expect(page.locator('#mappanel .mapnote')).toContainText('bricks in', { timeout: 20_000 });
  const sel = () => page.evaluate(() => (window as unknown as { __brickTest: { snapshot(): { sel: number } } }).__brickTest.snapshot().sel);
  expect(await sel()).toBe(0);
  // the far brick sits at one end of the fitted map: click near each end, one of them focuses brick 2
  const box = (await page.locator('#mapcanvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.93, box.y + box.height / 2);
  await expect.poll(sel).toBe(2);
});

test('opens a .brdb world with its revisions', async ({ page }) => {
  const worlds = referenceWorlds();
  test.skip(!worlds.length, 'no reference worlds (BRICK_REFS)');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.locator('#pick').setInputFiles(join(REFS, worlds[0]!));
  await expect(status(page)).not.toContainText('Opening', { timeout: 60_000 });
  await expect(status(page)).toContainText('moving grid(s) shown');
  await expect(status(page)).not.toContainText("Couldn't");
  await expect(page.locator('#revbox')).toBeVisible();
  const n = await page.locator('#rev option').count();
  expect(n).toBeGreaterThan(1);
  await page.locator('#rev').selectOption({ index: n - 1 });
  await expect(status(page)).toContainText('@ revision');
  // a plain .brz afterwards hides the revision list again
  const brz = referenceSaves()[0];
  if (brz) {
    await page.locator('#pick').setInputFiles(join(REFS, brz));
    await expect(page.locator('#revbox')).toBeHidden();
  }
  expect(errors).toEqual([]);
});

test('the Sound row mutes and sets the volume, and both persist', async ({ page }) => {
  await page.goto('/');
  const mute = page.locator('#mute'), vol = page.locator('#vol');
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
  await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await vol.fill('30');
  await expect(mute).toHaveAttribute('aria-pressed', 'false');      // moving the slider unmutes
  await mute.click();
  await page.reload();
  await expect(page.locator('#mute')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#vol')).toHaveValue('30');
});
