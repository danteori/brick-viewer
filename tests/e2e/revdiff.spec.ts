// W-05: the revision diff row under the Revision dropdown (counts vs the previous or any revision,
// Highlight outlines), in both builds. A synthetic three-revision world made here with sql.js.

import { expect, test, type Page } from '@playwright/test';
import { appendRevision, BrdbWorld, writeNewWorld } from '../../src/format/brdb.ts';
import { readBrz } from '../../src/format/brz.ts';
import { nodeSql } from '../unit/brdb-helpers.ts';
import { synthSave } from '../unit/synthsave.ts';

test.describe.configure({ timeout: 90_000 });

let world: Buffer;
test.beforeAll(async () => {
  const sql = await nodeSql();
  const one = readBrz(synthSave([{ asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [5, 5, 6], color: [200, 30, 30] }]));
  const two = readBrz(synthSave([
    { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [5, 5, 6], color: [30, 30, 200] },
    { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [45, 5, 6], color: [30, 200, 30] },
  ]));
  const w = BrdbWorld.open(sql, writeNewWorld(sql, one, { when: 1_800_000_000 }));
  try { world = Buffer.from(appendRevision(w, two, { when: 1_800_000_100 }).bytes); } finally { w.close(); }
});

const status = (page: Page) => page.locator('#status');

for (const [label, path] of [['full', '/?test'], ['lite', '/lite.html?test']] as const) {
  test(`${label}: revision diff counts and highlight`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(path);
    await page.waitForFunction(() => !!(window as unknown as { __brickTest?: unknown }).__brickTest);
    await page.locator('#pick').setInputFiles({ name: 'synthetic.brdb', mimeType: 'application/octet-stream', buffer: world });
    await expect(status(page)).toContainText('synthetic.brdb: 2 bricks', { timeout: 30_000 });
    const out = page.locator('#revdiff');
    await expect(page.locator('#revdiffbox')).toBeVisible();
    // Live = #3, against #2: one brick added, one repainted
    await expect(out).toContainText('Live vs #2: +1 −0 ~1 bricks', { timeout: 30_000 });
    await expect(out).toContainText('components 0 → 0');
    await page.locator('#revhl').check();
    await expect(status(page)).toContainText('Highlighting 2 changed bricks');
    // #2 against #1: the new world's two first revisions hold the same files
    await page.locator('#rev').selectOption('2');
    await expect(out).toContainText('#2 vs #1: no changes', { timeout: 30_000 });
    // #2 against #3 (chosen): the reverse
    await page.locator('#revcmp').selectOption('3');
    await expect(out).toContainText('#2 vs #3: +0 −1 ~1 bricks');
    // the first revision against nothing
    await page.locator('#revcmp').selectOption('prev');
    await page.locator('#rev').selectOption('1');
    await expect(out).toContainText('#1 vs nothing (first revision): +1 −0 ~0 bricks', { timeout: 30_000 });
    await page.locator('#revcmp').selectOption('none');
    await expect(out).toHaveText('');
    expect(errors).toEqual([]);
  });
}
