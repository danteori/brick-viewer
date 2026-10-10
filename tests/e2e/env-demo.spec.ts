import { expect, test } from '@playwright/test';

test('environment panel demo: sections, live lighting, Space kind', async ({ page }) => {
  await page.goto('/env-demo.html');
  const panel = page.getByRole('region', { name: 'Environment settings' });
  // the game's sections, in the game's order
  const titles = await panel.locator('summary').allTextContents();
  expect(titles).toEqual(['Sky', 'Sky - Night', 'Weather', 'Fog', 'Ground', 'Water', 'Ambience', 'Advanced']);
  const sun = page.locator('#light tr').first();
  const before = await sun.textContent();
  const tod = panel.getByRole('slider', { name: 'Time of Day' });
  await expect(tod).toHaveAttribute('aria-valuetext', /hr/);
  await tod.dblclick();
  await panel.getByRole('spinbutton', { name: 'Time of Day value' }).fill('20');
  await panel.getByRole('spinbutton', { name: 'Time of Day value' }).press('Enter');
  await expect(tod).toHaveAttribute('aria-valuenow', '20');
  await expect(sun).not.toHaveText(before ?? '');
  await expect(page.locator('#light')).toContainText('(moon)');
  await expect(panel.getByRole('button', { name: 'Reset Time of Day' })).toBeVisible();   // the changed row's reset arrow
  // percentages show and type as the game does
  await panel.locator('summary', { hasText: 'Weather' }).click();
  const cov = panel.getByRole('slider', { name: 'Cloud Coverage' });
  await cov.dblclick();
  await panel.getByRole('spinbutton', { name: 'Cloud Coverage value' }).fill('30');
  await panel.getByRole('spinbutton', { name: 'Cloud Coverage value' }).press('Enter');
  await expect(cov).toHaveAttribute('aria-valuetext', '30%');
  await expect(panel.getByRole('switch', { name: 'Close Lightning' })).toHaveAttribute('aria-checked', /true|false/);
  // Ambience Volume is disabled while Ambience is None
  await panel.locator('summary', { hasText: 'Ambience' }).click();
  await expect(panel.locator('.envp-row[data-key=ambienceVolume]')).toHaveClass(/envp-dis/);
  await page.getByLabel('Space').check();
  await expect(panel.locator('summary', { hasText: 'Universe' })).toBeVisible();
  await expect(panel.locator('summary', { hasText: 'Ground' })).toHaveCount(0);
  await expect(page.locator('#gp-info')).toContainText('none');
  await panel.getByRole('button', { name: 'PRESETS' }).click();
  await panel.getByRole('menuitem', { name: 'Reset to default' }).click();
  await expect(panel.getByRole('status')).toContainText('Reset');
});
