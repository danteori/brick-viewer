// W-10: the outliner lists the main grid and the moving grids with brick counts and badges, a row
// click selects and frames the grid, and the frozen flag and settings of a moving grid are edited
// in one undo step each and saved. Uses a synthetic world (tests/unit/gridworld.ts), no private data.

import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { writeNewWorldFile } from '../../src/format/brdb.ts';
import { readBrz } from '../../src/format/brz.ts';
import { readEntities } from '../../src/format/entities.ts';
import { fileMapView } from '../../src/format/saveview.ts';
import { gridWorld } from '../unit/gridworld.ts';
import { inMenu, openWin } from './windows.ts';

interface Api { settle(): Promise<number>; selection(): number[] }
type W = { __brickTest: Api };

test.describe.configure({ timeout: 300_000 });

const world = Buffer.from(writeNewWorldFile(gridWorld()));
const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
async function settle(page: Page): Promise<void> { await page.evaluate(() => (window as unknown as W).__brickTest.settle()); await frames(page); }
const selection = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as W).__brickTest.selection().length);

for (const [label, path] of [['full', '/?test'], ['lite', '/lite.html?test']] as const) {
  test(`${label}: the outliner lists the grids, frames a row and edits the settings of a moving grid`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(path);
    await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
    await page.locator('#pick').setInputFiles({ name: 'grids.brdb', mimeType: 'application/octet-stream', buffer: world });
    await expect(page.locator('#status')).toContainText('1 moving grid', { timeout: 30_000 });
    await settle(page);

    await openWin(page, 'escmenu');
    await page.locator('#outlinebtn').click();
    await expect(page.locator('#outlinewin')).toBeVisible();
    const rows = page.locator('#outlinelist .orow');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('3');
    await expect(rows.nth(1)).toContainText('2');
    await expect(rows.nth(1).locator('[data-badge="frozen"]')).toHaveCount(1);
    await expect(rows.nth(0).locator('.obadge')).toHaveCount(0);

    await rows.nth(1).click();
    await settle(page);
    expect(await selection(page)).toBe(2);
    await expect(page.locator('#outlineedit')).toBeVisible();
    await expect(page.locator('#outlineedit [data-set="MassScale"]')).toHaveValue('2');

    await page.locator('#outlineedit [data-set="MassScale"]').fill('3.5');
    await page.locator('#outlineedit [data-set="MassScale"]').press('Enter');
    await page.locator('#outlineedit [data-set="locked"]').uncheck();
    await settle(page);
    await expect(rows.nth(1).locator('[data-badge="frozen"]')).toHaveCount(0);

    await page.locator('#outlinewin').getByRole('button', { name: 'Close' }).click();
    const dl = page.waitForEvent('download');
    await inMenu(page, () => page.locator('#savebrz').click());
    const saved = readEntities(fileMapView(readBrz(new Uint8Array(readFileSync((await (await dl).path())!))))).byIndex.get(2)!;
    expect(saved.physicsLocked).toBe(false);
    expect(saved.data).toMatchObject({ MassScale: 3.5, BouyancyScale: 0.5, CollisionQuality: 1, EntityTag: 'door' });

    await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await settle(page);
    await openWin(page, 'escmenu');
    await page.locator('#outlinebtn').click();
    await expect(page.locator('#outlineedit [data-set="MassScale"]')).toHaveValue('2');
    await expect(page.locator('#outlineedit [data-set="locked"]')).toBeChecked();
    expect(errors).toEqual([]);
  });
}
