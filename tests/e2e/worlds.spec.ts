// S-08: .brdb worlds open through the lazy page reader (File.slice, no wasm) in both builds, with
// revision switching; Save .brz from a world loads the rest of the tree first; "Save as new world"
// (pure-TS writer, both builds) downloads a .brdb that sql.js and the lazy reader both read back. Uses a synthetic
// two-revision world made here with sql.js in Node, so it needs no private data.

import { expect, test, type Page } from '@playwright/test';
import { appendRevision, BrdbWorld, writeNewWorld } from '../../src/format/brdb.ts';
import { readFileSync } from 'node:fs';
import { LazyBrdbWorld } from '../../src/format/brdblazy.ts';
import { readBrz } from '../../src/format/brz.ts';
import { bytesSource } from '../../src/format/sqlitelazy.ts';
import { nodeSql } from '../unit/brdb-helpers.ts';
import { synthSave } from '../unit/synthsave.ts';

test.describe.configure({ timeout: 90_000 });

let world: Buffer;
test.beforeAll(async () => {
  const sql = await nodeSql();
  const one = readBrz(synthSave([{ asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [5, 5, 6], color: [200, 30, 30] }]));
  const two = readBrz(synthSave([
    { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [5, 5, 6], color: [200, 30, 30] },
    { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [45, 5, 6], color: [30, 200, 30] },
  ]));
  const w = BrdbWorld.open(sql, writeNewWorld(sql, one, { when: 1_800_000_000 }));
  try { world = Buffer.from(appendRevision(w, two, { when: 1_800_000_100 }).bytes); } finally { w.close(); }
});

const status = (page: Page) => page.locator('#status');
const bricks = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __brickTest: { snapshot(): { bricks: unknown[] } } }).__brickTest.snapshot().bricks.length);

for (const [label, path] of [['full', '/?test'], ['lite', '/lite.html?test']] as const) {
  test(`${label}: opens a .brdb lazily and switches revisions`, async ({ page }) => {
    const errors: string[] = [], wasm: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('request', (r) => { if (/sql-wasm|\.wasm/.test(r.url())) wasm.push(r.url()); });
    await page.goto(path);
    await page.waitForFunction(() => !!(window as unknown as { __brickTest?: unknown }).__brickTest);
    await page.locator('#pick').setInputFiles({ name: 'synthetic.brdb', mimeType: 'application/octet-stream', buffer: world });
    await expect(status(page)).toContainText('synthetic.brdb: 2 bricks', { timeout: 30_000 });
    await expect(page.locator('#revbox')).toBeVisible();
    await expect(page.locator('#rev option')).toHaveCount(4);          // live + 3 revisions (the new world's own first one)
    await page.locator('#rev').selectOption({ index: 2 });               // the one-brick revision
    await expect(status(page)).toContainText('@ revision');
    expect(await bricks(page)).toBe(1);
    await page.locator('#rev').selectOption({ index: 0 });
    await expect(status(page)).toContainText('synthetic.brdb: 2 bricks');
    const dl = page.waitForEvent('download');
    await page.locator('#savebrz').click();
    expect((await dl).suggestedFilename()).toBe('synthetic (edited).brz');
    await expect(status(page)).toContainText('Saved');
    await expect(page.locator('#savebrdb')).toHaveText('Save as new world (.brdb)');
    const dw = page.waitForEvent('download');
    await page.locator('#savebrdb').click();
    const saved = await dw;
    expect(saved.suggestedFilename()).toBe('synthetic (edited).brdb');
    const bytes = new Uint8Array(readFileSync((await saved.path())!));
    const sql = await nodeSql(), back = BrdbWorld.open(sql, bytes, { verify: true });
    try {
      expect(back.revisions.map((r) => r.description)).toEqual(['Initial Revision', 'Manual Save']);
      const db = sql.open(bytes);
      expect(db.query('PRAGMA integrity_check')).toEqual([['ok']]);
      db.close();
    } finally { back.close(); }
    const lazy = await LazyBrdbWorld.open(bytesSource(bytes));
    expect(lazy.schemaMatches).toBe(true);
    expect(lazy.tree().paths().length).toBeGreaterThan(0);
    expect(wasm).toEqual([]);                                            // no sql.js: the lazy reader did it all
    expect(errors).toEqual([]);
  });
}
