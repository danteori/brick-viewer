// A fresh load (no save opened) logs no console errors or page errors, in Edit and Explore modes
// (the dimension overlay used to draw NaN coordinates before the camera was ready).
import { expect, test } from '@playwright/test';

for (const url of ['/', '/?test', '/?test&mode=explore']) {
  test(`fresh load of ${url} logs no console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url);
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
  });
}
