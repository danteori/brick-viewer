import { expect, test } from '@playwright/test';

for (const [name, url] of [['full', '/'], ['lite', '/lite.html']]) {
  test(`${name} app starts with the startup brick`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await expect(page.locator('canvas#c')).toBeVisible();
    await expect(page.locator('#name')).toHaveText('2x2');
    await expect(page.locator('#pname')).toHaveText('2x2');
    await expect(page.locator('#chexout')).toHaveText('#fa4040');
    await expect(page.locator('#light option')).toHaveCount(5);
    await expect(page.locator('.bitem')).not.toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('typed size updates the name', async ({ page }) => {
  await page.goto('/');
  await page.locator('#menu .mrow input').first().click();
  await page.keyboard.type('4');
  await page.keyboard.press('Enter');
  await expect(page.locator('#name')).toHaveText('4x2');
  await page.keyboard.press('Control+z');
  await expect(page.locator('#name')).toHaveText('2x2');
});

test('legacy viewer loads with bundled zstd', async ({ page }) => {
  await page.goto('/legacy/save-viewer.html');
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { fzstd?: unknown }).fzstd)).toBe('object');
});
