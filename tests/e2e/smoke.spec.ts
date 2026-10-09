import { expect, test } from '@playwright/test';

test('full placeholder links to the legacy viewer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Brick viewer/ })).toContainText('full build');
  await expect(page.locator('#legacy')).toHaveAttribute('href', 'legacy/save-viewer.html');
  await expect(page.getByText('Not affiliated with or endorsed by Brickadia')).toBeVisible();
});

test('lite placeholder', async ({ page }) => {
  await page.goto('/lite.html');
  await expect(page.getByRole('heading', { name: /Brick viewer/ })).toContainText('lite build');
});

test('legacy viewer loads with bundled zstd', async ({ page }) => {
  await page.goto('/legacy/save-viewer.html');
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { fzstd?: unknown }).fzstd)).toBe('object');
});
