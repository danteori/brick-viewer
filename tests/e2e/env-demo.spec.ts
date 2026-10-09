import { expect, test } from '@playwright/test';

test('environment panel demo: sections, live lighting, Space kind', async ({ page }) => {
  await page.goto('/env-demo.html');
  const panel = page.getByRole('region', { name: 'Environment settings' });
  for (const s of ['Sky', 'Sun & Moon', 'Clouds & Weather', 'Fog', 'Water', 'Ground Plate', 'Ambience']) {
    await expect(panel.locator('summary', { hasText: s })).toBeVisible();
  }
  const sun = page.locator('#light tr').first();
  const before = await sun.textContent();
  await panel.getByRole('spinbutton', { name: 'Time of day' }).fill('20');
  await panel.getByRole('spinbutton', { name: 'Time of day' }).press('Enter');
  await expect(sun).not.toHaveText(before ?? '');
  await expect(page.locator('#light')).toContainText('(moon)');
  await page.getByLabel('Space').check();
  await expect(panel.locator('summary', { hasText: 'Universe' })).toBeVisible();
  await expect(panel.locator('summary', { hasText: 'Ground Plate' })).toHaveCount(0);
  await expect(page.locator('#gp-info')).toContainText('none');
  await panel.getByRole('button', { name: 'Reset to default' }).click();
  await expect(panel.getByRole('status')).toContainText('Reset');
});
